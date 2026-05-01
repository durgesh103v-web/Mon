package com.micmonitor.app

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URLConnection
import java.net.URLEncoder

/**
 * Utility object for remote file system CRUD operations.
 * Provides file listing, reading (base64), writing, and deletion
 * with proper error handling and security guards.
 */
object FileManager {

    private const val TAG = "FileManager"

    /** Maximum file size allowed for read/write operations (10 MB) */
    private const val MAX_FILE_SIZE = 10 * 1024 * 1024L

    /** Dangerous root paths that should not be deleted or written to */
    private val PROTECTED_PATHS = setOf(
        "/", "/system", "/data", "/proc", "/dev", "/sys"
    )

    /**
     * List files and directories at the given path.
     * Returns a JSONObject with status and items array.
     */
    fun listFiles(path: String): JSONObject {
        val result = JSONObject()
        try {
            val dir = File(path)
            if (!dir.exists()) {
                result.put("status", "error")
                result.put("error", "Path does not exist: $path")
                return result
            }
            if (!dir.isDirectory) {
                result.put("status", "error")
                result.put("error", "Path is not a directory: $path")
                return result
            }
            if (!dir.canRead()) {
                result.put("status", "error")
                result.put("error", "Cannot read directory: $path")
                return result
            }

            val items = JSONArray()
            val files = dir.listFiles()
            if (files != null) {
                // Sort: directories first, then by name
                val sorted = files.sortedWith(compareByDescending<File> { it.isDirectory }.thenBy { it.name.lowercase() })
                for (file in sorted) {
                    val item = JSONObject()
                    item.put("name", file.name)
                    item.put("path", file.absolutePath)
                    item.put("isDir", file.isDirectory)
                    item.put("size", if (file.isDirectory) 0 else file.length())
                    item.put("lastModified", file.lastModified())
                    item.put("canRead", file.canRead())
                    item.put("canWrite", file.canWrite())
                    if (!file.isDirectory && file.canRead()) {
                        val encodedPath = URLEncoder.encode(file.absolutePath, "UTF-8")
                        item.put("downloadUrl", "/file?path=$encodedPath")
                    }
                    if (file.isDirectory) {
                        item.put("childCount", file.listFiles()?.size ?: 0)
                    }
                    items.put(item)
                }
            }

            result.put("status", "ok")
            result.put("path", dir.absolutePath)
            result.put("parentPath", dir.parentFile?.absolutePath ?: "/")
            result.put("items", items)
            result.put("count", items.length())
            Log.d(TAG, "Listed ${items.length()} items in $path")
        } catch (e: SecurityException) {
            result.put("status", "error")
            result.put("error", "Permission denied: ${e.message}")
            Log.e(TAG, "Security error listing $path: ${e.message}")
        } catch (e: Exception) {
            result.put("status", "error")
            result.put("error", "Failed to list files: ${e.message}")
            Log.e(TAG, "Error listing $path: ${e.message}")
        }
        return result
    }


    /**
     * Delete a file or empty directory.
     */
    fun deleteFile(path: String, context: Context? = null): JSONObject {
        val result = JSONObject()
        try {
            if (isProtectedPath(path)) {
                result.put("status", "error")
                result.put("error", "Cannot delete protected path: $path")
                return result
            }

            val file = File(path)
            if (!file.exists()) {
                result.put("status", "error")
                result.put("error", "File not found: $path")
                return result
            }

            val deleted = deleteFileDirect(file) || (!file.isDirectory && deleteViaMediaStore(context, file.absolutePath))

            if (deleted) {
                result.put("status", "ok")
                result.put("path", path)
                Log.i(TAG, "Deleted: $path")
            } else {
                result.put("status", "error")
                result.put("error", "Failed to delete: $path (${writeAccessHint(file)})")
            }
        } catch (e: Exception) {
            result.put("status", "error")
            result.put("error", "Failed to delete: ${e.message}")
            Log.e(TAG, "Error deleting $path: ${e.message}")
        }
        return result
    }

    /**
     * Create a new directory (including parent dirs).
     */
    fun createDirectory(path: String): JSONObject {
        val result = JSONObject()
        try {
            val dir = File(path)
            if (dir.exists()) {
                result.put("status", "error")
                result.put("error", "Path already exists: $path")
                return result
            }

            val created = dir.mkdirs()
            if (created) {
                result.put("status", "ok")
                result.put("path", dir.absolutePath)
                Log.i(TAG, "Created directory: $path")
            } else {
                result.put("status", "error")
                result.put("error", "Failed to create directory: $path")
            }
        } catch (e: Exception) {
            result.put("status", "error")
            result.put("error", "Failed to create directory: ${e.message}")
        }
        return result
    }

    /**
     * Rename/move a file or directory.
     */
    fun renameFile(oldPath: String, newPath: String, context: Context? = null): JSONObject {
        val result = JSONObject()
        try {
            if (isProtectedPath(oldPath)) {
                result.put("status", "error")
                result.put("error", "Cannot rename protected path")
                return result
            }

            val oldFile = File(oldPath)
            if (!oldFile.exists()) {
                result.put("status", "error")
                result.put("error", "Source not found: $oldPath")
                return result
            }

            val newFile = File(newPath)
            if (newFile.exists()) {
                result.put("status", "error")
                result.put("error", "Destination already exists: $newPath")
                return result
            }

            newFile.parentFile?.mkdirs()
            val renamed = oldFile.renameTo(newFile) || renameByCopyThenDelete(context, oldFile, newFile)
            if (renamed) {
                result.put("status", "ok")
                result.put("oldPath", oldPath)
                result.put("newPath", newFile.absolutePath)
                Log.i(TAG, "Renamed: $oldPath -> $newPath")
            } else {
                result.put("status", "error")
                result.put("error", "Rename failed (${writeAccessHint(oldFile)})")
            }
        } catch (e: Exception) {
            result.put("status", "error")
            result.put("error", "Failed to rename: ${e.message}")
        }
        return result
    }

    // ────────────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────────────

    private fun isProtectedPath(path: String): Boolean {
        val normalized = File(path).absolutePath.trimEnd('/')
        return PROTECTED_PATHS.contains(normalized)
    }

    fun isProtectedPathForRead(path: String): Boolean {
        return isProtectedPath(path)
    }

    private fun deleteRecursive(file: File): Boolean {
        if (file.isDirectory) {
            file.listFiles()?.forEach { child ->
                if (!deleteRecursive(child)) return false
            }
        }
        return file.delete()
    }

    private fun deleteFileDirect(file: File): Boolean {
        return if (file.isDirectory) deleteRecursive(file) else file.delete()
    }

    private fun renameByCopyThenDelete(context: Context?, oldFile: File, newFile: File): Boolean {
        if (oldFile.isDirectory) return false
        return try {
            oldFile.inputStream().use { input ->
                newFile.outputStream().use { output -> input.copyTo(output) }
            }
            val removedOriginal = oldFile.delete() || deleteViaMediaStore(context, oldFile.absolutePath)
            if (!removedOriginal) {
                try { newFile.delete() } catch (_: Exception) {}
                return false
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "Copy+delete rename failed: ${e.message}")
            try { if (newFile.exists()) newFile.delete() } catch (_: Exception) {}
            false
        }
    }

    private fun deleteViaMediaStore(context: Context?, absolutePath: String): Boolean {
        context ?: return false
        return try {
            val uri = findMediaStoreUri(context, absolutePath) ?: return false
            context.contentResolver.delete(uri, null, null) > 0
        } catch (e: Exception) {
            Log.w(TAG, "MediaStore delete failed for $absolutePath: ${e.message}")
            false
        }
    }

    private fun findMediaStoreUri(context: Context, absolutePath: String): Uri? {
        val collection = MediaStore.Files.getContentUri("external")
        val projection = arrayOf(MediaStore.Files.FileColumns._ID)
        val selection = "${MediaStore.Files.FileColumns.DATA}=?"
        context.contentResolver.query(collection, projection, selection, arrayOf(absolutePath), null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val id = cursor.getLong(0)
                return Uri.withAppendedPath(collection, id.toString())
            }
        }
        return null
    }

    private fun writeAccessHint(file: File): String {
        if (!file.exists()) return "file not found"
        if (!file.canWrite()) return "no write permission; grant All files access on Android 11+"
        return "permission denied, file is busy, or Android scoped storage blocked the operation"
    }

    private fun guessMimeType(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            "ogg" -> "audio/ogg"
            "m4a", "aac" -> "audio/aac"
            "mp4" -> "video/mp4"
            "mkv" -> "video/x-matroska"
            "3gp" -> "video/3gpp"
            "txt", "log" -> "text/plain"
            "json" -> "application/json"
            "xml" -> "text/xml"
            "html", "htm" -> "text/html"
            "pdf" -> "application/pdf"
            "apk" -> "application/vnd.android.package-archive"
            "zip" -> "application/zip"
            "doc" -> "application/msword"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            "xls" -> "application/vnd.ms-excel"
            "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            "ppt" -> "application/vnd.ms-powerpoint"
            "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            "csv" -> "text/csv"
            "rtf" -> "application/rtf"
            "flac" -> "audio/flac"
            "amr" -> "audio/amr"
            "opus" -> "audio/opus"
            "webm" -> "video/webm"
            "mov" -> "video/quicktime"
            "avi" -> "video/x-msvideo"
            "heic" -> "image/heic"
            "bmp" -> "image/bmp"
            "svg" -> "image/svg+xml"
            "rar" -> "application/vnd.rar"
            "7z" -> "application/x-7z-compressed"
            "tar" -> "application/x-tar"
            "gz" -> "application/gzip"
            else -> URLConnection.guessContentTypeFromName(name) ?: "application/octet-stream"
        }
    }
}
