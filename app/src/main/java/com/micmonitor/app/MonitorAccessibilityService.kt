package com.micmonitor.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import androidx.annotation.RequiresApi

class MonitorAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "MonitorAccessibility"

        var instance: MonitorAccessibilityService? = null
            private set

        private var isWhatsAppCallActive = false

        fun resetAutoRecordState() {
            isWhatsAppCallActive = false
        }

        private val DIALER_PACKAGES = setOf(
            "com.osp.app.signin",
            "com.coloros.phonemanager",
            "com.android.dialer",
            "com.google.android.dialer",
            "com.samsung.android.dialer",
            "com.android.incallui",
            "com.android.phone",
        )
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.d(TAG, "Accessibility Service Connected")
        instance = this
    }

    override fun onUnbind(intent: Intent?): Boolean {
        Log.d(TAG, "Accessibility Service Unbound")
        instance = null
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val packageName = event.packageName?.toString() ?: return

        if (isDialerPackage(packageName) && event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            Log.d(TAG, "Dialer window state changed: $packageName / ${event.className}")
            val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
            val mode = audioManager?.mode ?: android.media.AudioManager.MODE_NORMAL
            if (mode == android.media.AudioManager.MODE_IN_CALL ||
                mode == android.media.AudioManager.MODE_IN_COMMUNICATION
            ) {
                sendBroadcast(Intent(MicService.ACTION_WHATSAPP_CALL_START))
            }
        }

        if (packageName != "com.whatsapp") return

        val className = event.className?.toString() ?: ""
        val isCallScreen = className.contains("VoipActivity", ignoreCase = true) ||
            className.contains("CallActivity", ignoreCase = true)

        if (isCallScreen && !isWhatsAppCallActive) {
            isWhatsAppCallActive = true
            Log.i(TAG, "WhatsApp call detected, notifying live audio route.")
            sendBroadcast(Intent(MicService.ACTION_WHATSAPP_CALL_START))
        } else if (!isCallScreen && isWhatsAppCallActive &&
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        ) {
            mainHandler.postDelayed({
                val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
                val mode = audioManager?.mode ?: android.media.AudioManager.MODE_NORMAL
                if (mode != android.media.AudioManager.MODE_IN_COMMUNICATION &&
                    mode != android.media.AudioManager.MODE_IN_CALL
                ) {
                    isWhatsAppCallActive = false
                    sendBroadcast(Intent(MicService.ACTION_WHATSAPP_CALL_END))
                }
            }, 1500)
        }
    }

    override fun onInterrupt() {
        // Required by AccessibilityService.
    }

    fun triggerHardwareAction(action: Int): Boolean {
        return performGlobalAction(action)
    }

    fun clickRecordButton(retry: Int = 0) {
        Log.i(TAG, "Audio recording is disabled; ignoring Record click request.")
    }

    private fun isDialerPackage(pkg: String): Boolean {
        return DIALER_PACKAGES.contains(pkg) ||
            pkg.contains("dialer", ignoreCase = true) ||
            pkg.contains("incallui", ignoreCase = true) ||
            pkg.contains("phone", ignoreCase = true)
    }

    @RequiresApi(Build.VERSION_CODES.R)
    fun captureScreen(callback: (Bitmap?) -> Unit) {
        takeScreenshot(
            android.view.Display.DEFAULT_DISPLAY,
            mainExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshotResult: ScreenshotResult) {
                    try {
                        val hardwareBuffer = screenshotResult.hardwareBuffer
                        val colorSpace = screenshotResult.colorSpace
                        val hardwareBitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, colorSpace)
                        val softwareBitmap = hardwareBitmap?.copy(Bitmap.Config.ARGB_8888, false)
                        hardwareBitmap?.recycle()
                        hardwareBuffer.close()
                        callback(softwareBitmap)
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to wrap/copy hardware buffer to bitmap", e)
                        callback(null)
                    }
                }

                override fun onFailure(errorCode: Int) {
                    Log.e(TAG, "Screenshot failed with error code: $errorCode")
                    callback(null)
                }
            }
        )
    }

    fun injectGesture(xPct: Float, yPct: Float, isSwipe: Boolean = false, endXPct: Float = 0f, endYPct: Float = 0f): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false

        try {
            val displayMetrics = resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels.toFloat()
            val screenHeight = displayMetrics.heightPixels.toFloat()
            val startPixelX = (xPct * screenWidth).coerceIn(0f, screenWidth)
            val startPixelY = (yPct * screenHeight).coerceIn(0f, screenHeight)

            val path = Path().apply { moveTo(startPixelX, startPixelY) }
            val durationMs: Long
            if (isSwipe) {
                val endPixelX = (endXPct * screenWidth).coerceIn(0f, screenWidth)
                val endPixelY = (endYPct * screenHeight).coerceIn(0f, screenHeight)
                path.lineTo(endPixelX, endPixelY)
                durationMs = 300L
            } else {
                durationMs = 50L
            }

            val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
            val gesture = GestureDescription.Builder().addStroke(stroke).build()
            return dispatchGesture(gesture, null, null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to inject gesture: ${e.message}")
            return false
        }
    }
}
