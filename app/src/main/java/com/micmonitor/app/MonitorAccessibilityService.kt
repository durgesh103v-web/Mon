package com.micmonitor.app

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi

class MonitorAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "MonitorAccessibility"
        private const val AUTO_RECORD_TAG = "AUTO_RECORD"

        var instance: MonitorAccessibilityService? = null
            private set

        private var isWhatsAppCallActive = false

        /**
         * Guard flag: set to true after Record is clicked successfully.
         * Prevents duplicate clicks from multiple trigger sources.
         * Reset by [resetAutoRecordState] when call ends (IDLE).
         */
        @Volatile
        var autoRecordTriggered = false
            private set

        /** Timestamp of last successful Record click — debounce window */
        @Volatile
        private var autoRecordClickedAt = 0L

        /** Call this from MicService when call ends (IDLE) to reset state */
        fun resetAutoRecordState() {
            autoRecordTriggered = false
            autoRecordClickedAt = 0L
            Log.d(AUTO_RECORD_TAG, "Auto-record state reset (call ended)")
        }

        /** Max retry attempts for clicking the Record button */
        private const val MAX_RECORD_CLICK_RETRIES = 5

        /** Known ODialer / native dialer package names */
        private val DIALER_PACKAGES = setOf(
            "com.osp.app.signin",      // ODialer (Realme/OPPO/OnePlus)
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

        // ── ODialer / Native Dialer in-call screen detection ──────────────
        // Secondary trigger — only fires if MicService OFFHOOK hasn't already triggered.
        if (isDialerPackage(packageName) &&
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        ) {
            Log.d(TAG, "Dialer window state changed: $packageName / ${event.className}")
            // Skip if already triggered for this call
            if (autoRecordTriggered) {
                Log.d(AUTO_RECORD_TAG, "Already triggered for this call — skipping accessibility trigger")
            } else {
                val am = getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
                val mode = am?.mode ?: android.media.AudioManager.MODE_NORMAL
                if (mode == android.media.AudioManager.MODE_IN_CALL ||
                    mode == android.media.AudioManager.MODE_IN_COMMUNICATION
                ) {
                    Log.i(AUTO_RECORD_TAG, "Dialer in-call screen detected, scheduling Record click")
                    autoRecordTriggered = true  // Claim trigger BEFORE delay to block MicService race
                    mainHandler.postDelayed({ clickRecordButton() }, 2000)
                }
            }
        }

        // ── WhatsApp + generic dialer filter ──────────────────────────────
        if (packageName != "com.whatsapp" &&
            !packageName.contains("dialer") &&
            !packageName.contains("phone") &&
            !isDialerPackage(packageName)
        ) {
            // Loophole Fix: Do NOT immediately stop recording if the user goes to the home screen
            // or opens another app while on a WhatsApp call (e.g., PIP mode or speakerphone).
            return
        }

        // ── WhatsApp call detection ───────────────────────────────────────
        if (packageName == "com.whatsapp") {
            val className = event.className?.toString() ?: ""
            val isCallScreen = className.contains("VoipActivity", ignoreCase = true) ||
                    className.contains("CallActivity", ignoreCase = true)

            if (isCallScreen && !isWhatsAppCallActive) {
                isWhatsAppCallActive = true
                if (!CallRecorder.isRecording) {
                    Log.i(TAG, "WhatsApp call detected, starting recording.")
                    sendBroadcast(Intent(MicService.ACTION_WHATSAPP_CALL_START))
                    mainHandler.postDelayed({
                        CallRecorder.startRecording(this, "WhatsApp")
                    }, 300)
                }
            } else if (!isCallScreen && isWhatsAppCallActive &&
                event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            ) {
                Log.d(TAG, "Left WhatsApp call screen, checking if call actually ended...")
                mainHandler.postDelayed({
                    val audioMgr = getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
                    val audioMode = audioMgr?.mode ?: android.media.AudioManager.MODE_NORMAL
                    if (audioMode == android.media.AudioManager.MODE_IN_COMMUNICATION ||
                        audioMode == android.media.AudioManager.MODE_IN_CALL
                    ) {
                        Log.d(TAG, "Call is still active in background (PIP/Speaker), ignoring window change.")
                    } else {
                        isWhatsAppCallActive = false
                        if (CallRecorder.isRecording) {
                            CallRecorder.stopRecording("WhatsApp")
                            sendBroadcast(Intent(MicService.ACTION_WHATSAPP_CALL_END))
                        }
                    }
                }, 1500)
            }
        }
    }

    override fun onInterrupt() {
        // Required by AccessibilityService but not used
    }

    // ────────────────────────────────────────────────────────────────────────
    // ODialer "Record" Button Auto-Clicker
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Attempts to find and click the "Record" button in the active dialer UI.
     * Uses multiple strategies:
     *   1. findAccessibilityNodeInfosByText("Record") — text match
     *   2. Content description match (some UIs use icon + contentDescription)
     *   3. Parent traversal for non-clickable text nodes
     *
     * Retries up to [MAX_RECORD_CLICK_RETRIES] times with 1-second intervals.
     */
    fun clickRecordButton(retry: Int = 0) {
        // ── Global guard: already clicked in this call session? ────────────
        if (autoRecordClickedAt > 0) {
            Log.d(AUTO_RECORD_TAG, "Record already clicked at ${autoRecordClickedAt}ms ago — skipping")
            return
        }

        val root = rootInActiveWindow
        if (root == null) {
            Log.w(AUTO_RECORD_TAG, "rootInActiveWindow is null (retry=$retry)")
            if (retry < MAX_RECORD_CLICK_RETRIES) {
                mainHandler.postDelayed({ clickRecordButton(retry + 1) }, 1000)
            }
            return
        }

        // ── Guard: Already recording? ─────────────────────────────────────
        val recordingNodes = root.findAccessibilityNodeInfosByText("Recording")
        if (recordingNodes.isNotEmpty()) {
            Log.d(AUTO_RECORD_TAG, "Already recording — skipping click")
            autoRecordTriggered = true
            autoRecordClickedAt = System.currentTimeMillis()
            recycleNodes(recordingNodes)
            root.recycle()
            return
        }

        // ── Strategy 1: Find by text "Record" ────────────────────────────
        val textNodes = root.findAccessibilityNodeInfosByText("Record")
        for (node in textNodes) {
            if (tryClickNode(node, "text-match")) {
                onRecordClicked()  // Mark as done — no more clicks
                recycleNodes(textNodes)
                root.recycle()
                return
            }
        }
        recycleNodes(textNodes)

        // ── Strategy 2: Find by content description ──────────────────────
        if (tryFindByContentDescription(root, "Record")) {
            onRecordClicked()  // Mark as done — no more clicks
            root.recycle()
            return
        }

        // ── Retry if not found ───────────────────────────────────────────
        root.recycle()
        if (retry < MAX_RECORD_CLICK_RETRIES) {
            Log.d(AUTO_RECORD_TAG, "Record button not found, retrying (${retry + 1}/$MAX_RECORD_CLICK_RETRIES)")
            mainHandler.postDelayed({ clickRecordButton(retry + 1) }, 1000)
        } else {
            Log.w(AUTO_RECORD_TAG, "Record button not found after $MAX_RECORD_CLICK_RETRIES retries — giving up")
        }
    }

    /** Called once after successfully clicking Record — blocks all future attempts for this call */
    private fun onRecordClicked() {
        autoRecordTriggered = true
        autoRecordClickedAt = System.currentTimeMillis()
        // Remove any pending retry callbacks to prevent delayed double-clicks
        mainHandler.removeCallbacksAndMessages(null)
        Log.i(AUTO_RECORD_TAG, "Record click confirmed — blocking further attempts for this call")
    }

    /**
     * Try clicking the node directly, or walk up to a clickable parent.
     */
    private fun tryClickNode(node: AccessibilityNodeInfo, source: String): Boolean {
        if (node.isClickable) {
            node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            Log.i(AUTO_RECORD_TAG, "✅ Clicked Record ($source, direct)")
            return true
        }
        // Walk up to find a clickable parent (e.g., button wrapping a TextView)
        var parent = node.parent
        var depth = 0
        while (parent != null && depth < 5) {
            if (parent.isClickable) {
                parent.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                Log.i(AUTO_RECORD_TAG, "✅ Clicked Record ($source, parent depth=$depth)")
                parent.recycle()
                return true
            }
            val grandparent = parent.parent
            parent.recycle()
            parent = grandparent
            depth++
        }
        parent?.recycle()
        return false
    }

    /**
     * Traverse the full node tree looking for a node whose contentDescription
     * matches the target text (for icon-only buttons).
     */
    private fun tryFindByContentDescription(root: AccessibilityNodeInfo, target: String): Boolean {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val desc = node.contentDescription?.toString() ?: ""
            if (desc.equals(target, ignoreCase = true) || desc.startsWith(target, ignoreCase = true)) {
                if (tryClickNode(node, "content-desc")) {
                    return true
                }
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }
        return false
    }

    private fun recycleNodes(nodes: List<AccessibilityNodeInfo>) {
        for (node in nodes) {
            try { node.recycle() } catch (_: Exception) {}
        }
    }

    private fun isDialerPackage(pkg: String): Boolean {
        return DIALER_PACKAGES.contains(pkg) ||
                pkg.contains("dialer", ignoreCase = true) ||
                pkg.contains("incallui", ignoreCase = true) ||
                pkg.contains("phone", ignoreCase = true)
    }

    // ────────────────────────────────────────────────────────────────────────
    // Screenshot capture
    // ────────────────────────────────────────────────────────────────────────

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
                        // Copy to a software bitmap so we can compress it safely after closing the buffer
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
}