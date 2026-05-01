package com.micmonitor.app

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
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
        "/", "/system", "/data", "/proc", "/dev", "/sys",
        "/storage/emulated"
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
    fun deleteFile(path: String): JSONObject {
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

            val deleted = if (file.isDirectory) {
                deleteRecursive(file)
            } else {
                file.delete()
            }

            if (deleted) {
                result.put("status", "ok")
                result.put("path", path)
                Log.i(TAG, "Deleted: $path")
            } else {
                result.put("status", "error")
                result.put("error", "Failed to delete: $path (permission denied or busy)")
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
    fun renameFile(oldPath: String, newPath: String): JSONObject {
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
            val renamed = oldFile.renameTo(newFile)
            if (renamed) {
                result.put("status", "ok")
                result.put("oldPath", oldPath)
                result.put("newPath", newFile.absolutePath)
                Log.i(TAG, "Renamed: $oldPath -> $newPath")
            } else {
                result.put("status", "error")
                result.put("error", "Rename failed (cross-filesystem or permission issue)")
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

    private fun deleteRecursive(file: File): Boolean {
        if (file.isDirectory) {
            file.listFiles()?.forEach { child ->
                if (!deleteRecursive(child)) return false
            }
        }
        return file.delete()
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
            else -> "application/octet-stream"
        }
    }
}
