package com.micmonitor.app

import android.content.Intent
import android.os.Build
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM "Ghost Node" Service — receives invisible high-priority data payloads
 * from the backend to wake MicService from Deep Doze.
 *
 * This service is only triggered when the dashboard opens and fires a
 * wakeup pulse via Firebase Cloud Messaging. It consumes zero battery
 * when idle because FCM uses Google Play Services' persistent connection.
 */
class FcmMessageService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "FcmMessageService"
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "New FCM Token generated: ${token.take(20)}...")
        // Save the token to SharedPreferences so MicService can send it to the backend
        getSharedPreferences("micmonitor", MODE_PRIVATE)
            .edit()
            .putString("fcm_token", token)
            .apply()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)

        // We only care about invisible DATA payloads, not notifications.
        if (message.data.isNotEmpty()) {
            val command = message.data["command"]
            Log.i(TAG, "High-priority invisible payload received: $command")

            if (command == "wakeup") {
                // The dashboard wants to connect. Wake the main service instantly.
                val intent = Intent(this, MicService::class.java).apply {
                    action = MicService.ACTION_RECONNECT
                    data = android.net.Uri.parse("timer:fcm_wakeup")
                }

                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(intent)
                    } else {
                        startService(intent)
                    }
                    Log.i(TAG, "Successfully booted MicService from Deep Doze.")
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to start MicService from FCM: ${e.message}")
                }
            }
        }
    }
}
