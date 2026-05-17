package com.micmonitor.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Rect
import android.util.Log
import kotlin.math.abs

/**
 * Lightweight image enhancement pipeline for still photo capture.
 * Keeps processing predictable while audio streaming stays realtime.
 */
object ImageEnhancer {
    private const val TAG = "ImageEnhancer"

    /** Capture mode based on lighting conditions */
    enum class CaptureMode {
        FAST,   // Good light - minimal processing
        SMART,  // Normal - balanced processing
        NIGHT   // Low light - full enhancement pipeline
    }

    /**
     * Detect optimal capture mode based on image brightness.
     * @param avgLuma Average luminance (0-255)
     * @return Recommended capture mode
     */
    fun detectMode(avgLuma: Float): CaptureMode {
        return when {
            avgLuma < 50f -> CaptureMode.NIGHT   // Very dark
            avgLuma < 90f -> CaptureMode.SMART   // Dim/indoor
            else -> CaptureMode.FAST              // Good light
        }
    }

    /**
     * Get ISO and exposure settings for each mode.
     * @return Pair of (ISO, exposureNs)
     */
    fun getIsoExposure(mode: CaptureMode): Pair<Int, Long> {
        return when (mode) {
            CaptureMode.NIGHT -> Pair(1600, 100_000_000L)  // High ISO + long exposure
            CaptureMode.SMART -> Pair(800, 50_000_000L)    // Balanced
            CaptureMode.FAST -> Pair(200, 10_000_000L)     // Fast + clean
        }
    }

    /**
     * Estimate average luminance of a bitmap (fast sampling).
     */
    fun estimateLuma(bitmap: Bitmap): Float {
        val w = bitmap.width
        val h = bitmap.height
        if (w <= 0 || h <= 0) return 128f

        val stepX = (w / 32).coerceAtLeast(1)
        val stepY = (h / 32).coerceAtLeast(1)
        var sum = 0.0
        var count = 0

        var y = 0
        while (y < h) {
            var x = 0
            while (x < w) {
                val c = bitmap.getPixel(x, y)
                val r = (c shr 16) and 0xFF
                val g = (c shr 8) and 0xFF
                val b = c and 0xFF
                // ITU-R BT.709 luma
                sum += (0.2126 * r + 0.7152 * g + 0.0722 * b)
                count++
                x += stepX
            }
            y += stepY
        }
        return if (count > 0) (sum / count).toFloat() else 128f
    }

    /**
     * Histogram-based auto brightness correction.
     * Analyzes image and applies dynamic gain to achieve target brightness.
     */
    fun adjustBrightness(bitmap: Bitmap, targetLuma: Float = 130f): Bitmap {
        val avgLuma = estimateLuma(bitmap)
        val target = targetLuma.coerceIn(90f, 170f)
        
        // Calculate gain to reach target brightness
        val gain = when {
            avgLuma < 50f -> (target / avgLuma.coerceAtLeast(35f)).coerceAtMost(2.0f)
            avgLuma < 80f -> (target / avgLuma.coerceAtLeast(60f)).coerceAtMost(1.6f)
            avgLuma < 110f -> (target / avgLuma.coerceAtLeast(90f)).coerceAtMost(1.3f)
            avgLuma > 200f -> 0.75f     // Overexposed - reduce
            avgLuma > 180f -> 0.85f     // Bright
            else -> 1.0f                 // OK
        }

        if (abs(gain - 1.0f) < 0.05f) return bitmap  // Skip if minimal adjustment

        val cm = ColorMatrix().apply {
            setScale(gain, gain, gain, 1f)
        }

        val result = Bitmap.createBitmap(bitmap.width, bitmap.height, 
            Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            colorFilter = ColorMatrixColorFilter(cm)
        }
        canvas.drawBitmap(bitmap, 0f, 0f, paint)
        return result
    }

    /**
     * Night mode enhancement with brightness boost and contrast.
     * More aggressive than regular adjustBrightness.
     */
    fun enhanceNight(bitmap: Bitmap): Bitmap {
        val avgLuma = estimateLuma(bitmap)
        
        // Night-specific matrix: boost brightness + slight contrast
        val brightBoost = when {
            avgLuma < 30f -> 35f   // Very dark
            avgLuma < 60f -> 25f   // Dark
            avgLuma < 90f -> 15f   // Dim
            else -> 5f
        }
        
        val contrast = when {
            avgLuma < 50f -> 1.4f   // Boost contrast in dark images
            avgLuma < 80f -> 1.25f
            else -> 1.15f
        }

        val t = (-0.5f * contrast + 0.5f) * 255f + brightBoost
        val matrix = ColorMatrix(floatArrayOf(
            contrast, 0f, 0f, 0f, t,
            0f, contrast, 0f, 0f, t,
            0f, 0f, contrast, 0f, t,
            0f, 0f, 0f, 1f, 0f
        ))

        val result = Bitmap.createBitmap(bitmap.width, bitmap.height,
            Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            colorFilter = ColorMatrixColorFilter(matrix)
        }
        canvas.drawBitmap(bitmap, 0f, 0f, paint)
        return result
    }

    /**
     * Edge-preserving median denoise (3x3) for high-ISO noise.
     */
    fun denoise(bitmap: Bitmap): Bitmap {
        val width = bitmap.width
        val height = bitmap.height
        if (width < 3 || height < 3) return bitmap

        try {
            val pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

            val output = IntArray(width * height)

        val rs = IntArray(9)
        val gs = IntArray(9)
        val bs = IntArray(9)

        for (y in 1 until height - 1) {
            for (x in 1 until width - 1) {
                var idx = 0
                for (dy in -1..1) {
                    for (dx in -1..1) {
                        val p = pixels[(y + dy) * width + (x + dx)]
                        rs[idx] = (p shr 16) and 0xFF
                        gs[idx] = (p shr 8) and 0xFF
                        bs[idx] = p and 0xFF
                        idx++
                    }
                }

                rs.sort()
                gs.sort()
                bs.sort()
                val r = rs[4]
                val g = gs[4]
                val b = bs[4]

                output[y * width + x] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            }
        }

        // Copy edges unchanged
        for (x in 0 until width) {
            output[x] = pixels[x]                           // Top row
            output[(height - 1) * width + x] = pixels[(height - 1) * width + x]  // Bottom row
        }
        for (y in 0 until height) {
            output[y * width] = pixels[y * width]           // Left column
            output[y * width + width - 1] = pixels[y * width + width - 1]  // Right column
        }

            val result = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            result.setPixels(output, 0, width, 0, 0, width, height)
            return result
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM during denoise, returning original", e)
            return bitmap
        }
    }

    /**
     * Edge sharpening using 3x3 unsharp mask kernel.
     * Makes edges crisp without over-sharpening.
     */
    fun sharpen(bitmap: Bitmap, strength: Float = 1.0f): Bitmap {
        val width = bitmap.width
        val height = bitmap.height
        if (width < 3 || height < 3) return bitmap

        try {
            val pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

            val output = IntArray(width * height)

        // Unsharp mask 9-point kernel (includes diagonals) scaled by strength
        // Sum of coefficients: (8*s + 1) + 8*(-s) = 1.0 (normalized)
        val center = 8 * strength + 1f
        val edge = -strength

        for (y in 1 until height - 1) {
            for (x in 1 until width - 1) {
                var rf = 0f
                var gf = 0f
                var bf = 0f

                val idx = y * width + x
                
                // Center pixel (strength applied via center/edge)
                var p = pixels[idx]
                rf += ((p shr 16) and 0xFF) * center
                gf += ((p shr 8) and 0xFF) * center
                bf += (p and 0xFF) * center

                // 8 neighbors (9-point kernel for higher quality)
                for (dy in -1..1) {
                    for (dx in -1..1) {
                        if (dx == 0 && dy == 0) continue
                        p = pixels[(y + dy) * width + (x + dx)]
                        rf += ((p shr 16) and 0xFF) * edge
                        gf += ((p shr 8) and 0xFF) * edge
                        bf += (p and 0xFF) * edge
                    }
                }

                // Clamp
                val r = rf.toInt().coerceIn(0, 255)
                val g = gf.toInt().coerceIn(0, 255)
                val b = bf.toInt().coerceIn(0, 255)

                val alpha = pixels[idx] and -0x1000000
                output[idx] = alpha or (r shl 16) or (g shl 8) or b
            }
        }

        // Copy edges unchanged
        for (x in 0 until width) {
            output[x] = pixels[x]
            output[(height - 1) * width + x] = pixels[(height - 1) * width + x]
        }
        for (y in 0 until height) {
            output[y * width] = pixels[y * width]
            output[y * width + width - 1] = pixels[y * width + width - 1]
        }

            val result = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            result.setPixels(output, 0, width, 0, 0, width, height)
            return result
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM during sharpen, returning original", e)
            return bitmap
        }
    }

    /**
     * Enhance face region - brighten and slightly smooth.
     * @param bitmap Source image
     * @param faceRect Face bounds (from Camera2 face detection)
     */
    fun enhanceFace(bitmap: Bitmap, faceRect: Rect): Bitmap {
        // Validate face rect
        val safeRect = Rect(
            faceRect.left.coerceIn(0, bitmap.width - 1),
            faceRect.top.coerceIn(0, bitmap.height - 1),
            faceRect.right.coerceIn(1, bitmap.width),
            faceRect.bottom.coerceIn(1, bitmap.height)
        )
        
        if (safeRect.width() < 10 || safeRect.height() < 10) return bitmap

        try {
            val result = bitmap.copy(Bitmap.Config.ARGB_8888, true) ?: return bitmap
            val canvas = Canvas(result)

            // Face enhancement matrix: slight brightness + warmth
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                colorFilter = ColorMatrixColorFilter(ColorMatrix().apply {
                    set(floatArrayOf(
                        1.15f, 0f, 0f, 0f, 12f,    // R + brightness
                        0f, 1.12f, 0f, 0f, 10f,    // G + brightness
                        0f, 0f, 1.08f, 0f, 8f,     // B slightly less (warmer)
                        0f, 0f, 0f, 1f, 0f
                    ))
                })
            }

            // Extract and enhance face region
            val faceBitmap = Bitmap.createBitmap(
                bitmap,
                safeRect.left,
                safeRect.top,
                safeRect.width(),
                safeRect.height()
            )

            canvas.drawBitmap(faceBitmap, null, safeRect, paint)
            faceBitmap.recycle()
            return result
        } catch (e: Exception) {
            Log.w(TAG, "Face enhancement failed: ${e.message}")
            return bitmap
        }
    }

    /**
     * Merge multiple frames (for night mode noise reduction).
     * Simple averaging reduces random noise while preserving detail.
     */
    fun mergeFrames(frames: List<Bitmap>): Bitmap? {
        if (frames.isEmpty()) return null
        if (frames.size == 1) return frames[0]

        val width = frames[0].width
        val height = frames[0].height
        val count = frames.size

        // Accumulate pixel values
        try {
            val sumR = IntArray(width * height)
            val sumG = IntArray(width * height)
            val sumB = IntArray(width * height)
            val pixels = IntArray(width * height)

            for (frame in frames) {
                if (frame.width != width || frame.height != height) continue
                
                frame.getPixels(pixels, 0, width, 0, 0, width, height)

                for (i in pixels.indices) {
                    val p = pixels[i]
                    sumR[i] += (p shr 16) and 0xFF
                    sumG[i] += (p shr 8) and 0xFF
                    sumB[i] += p and 0xFF
                }
            }

        // Average
        val output = IntArray(width * height)
        for (i in output.indices) {
            val r = sumR[i] / count
            val g = sumG[i] / count
            val b = sumB[i] / count
            output[i] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
        }

            val result = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            result.setPixels(output, 0, width, 0, 0, width, height)
            return result
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM during mergeFrames, returning first frame", e)
            return frames[0]
        }
    }

    /**
     * Apply full enhancement pipeline based on mode.
     * @param bitmap Source image
     * @param mode Capture mode (FAST/SMART/NIGHT)
     * @param faceRect Optional face bounds for face enhancement
     */
    fun enhance(bitmap: Bitmap, mode: CaptureMode, faceRect: Rect? = null): Bitmap {
        var result = bitmap

        fun replaceBitmap(next: Bitmap) {
            if (result !== bitmap && result !== next && !result.isRecycled) {
                result.recycle()
            }
            result = next
        }

        when (mode) {
            CaptureMode.FAST -> {
                // Minimal processing - just slight color correction
                replaceBitmap(applyFastEnhance(bitmap))
            }
            CaptureMode.SMART -> {
                // Balanced: brightness + color only; avoid per-pixel filters during audio streaming.
                replaceBitmap(adjustBrightness(result))
                replaceBitmap(applyColorBoost(result, 1.05f))
            }
            CaptureMode.NIGHT -> {
                // Lightweight night mode: brightness/contrast only for cross-device reliability.
                replaceBitmap(enhanceNight(result))
            }
        }

        // Face enhancement (if detected)
        if (faceRect != null && faceRect.width() > 20 && faceRect.height() > 20) {
            replaceBitmap(enhanceFace(result, faceRect))
        }

        return result
    }

    /**
     * Fast enhancement - minimal processing for good light conditions.
     */
    private fun applyFastEnhance(bitmap: Bitmap): Bitmap {
        val avgLuma = estimateLuma(bitmap)
        
        // Only adjust if clearly wrong
        if (avgLuma < 70f || avgLuma > 190f) {
            return adjustBrightness(bitmap)
        }
        
        // Light saturation boost
        return applyColorBoost(bitmap, 1.05f)
    }

    /**
     * Apply saturation/color boost.
     */
    private fun applyColorBoost(bitmap: Bitmap, saturation: Float): Bitmap {
        val cm = ColorMatrix().apply {
            setSaturation(saturation)
        }
        
        val result = Bitmap.createBitmap(bitmap.width, bitmap.height,
            Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            colorFilter = ColorMatrixColorFilter(cm)
        }
        canvas.drawBitmap(bitmap, 0f, 0f, paint)
        return result
    }

    /**
     * Compress bitmap to JPEG with network-aware quality.
     * @param bitmap Source image
     * @param lowNetwork True if network is weak
     * @param qualityMode "fast" | "normal" | "hd"
     */
    fun compress(bitmap: Bitmap, lowNetwork: Boolean, qualityMode: String = "normal"): ByteArray {
        val quality = when {
            lowNetwork -> when (qualityMode) {
                "hd" -> 65
                else -> 62
            }
            else -> when (qualityMode) {
                "fast" -> 62
                "hd" -> 85
                else -> 76
            }
        }

        val stream = java.io.ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)
        return stream.toByteArray()
    }

    /**
     * Mirror bitmap horizontally (for front camera).
     */
    fun mirrorHorizontally(bitmap: Bitmap): Bitmap {
        val mirrored = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(mirrored)
        canvas.scale(-1f, 1f, bitmap.width / 2f, bitmap.height / 2f)
        canvas.drawBitmap(bitmap, 0f, 0f, null)
        return mirrored
    }

}
