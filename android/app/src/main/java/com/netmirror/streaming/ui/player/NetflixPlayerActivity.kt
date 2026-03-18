package com.netmirror.streaming.ui.player

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ActivityInfo
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ClipDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.SeekBar
import android.widget.TextView
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Log
import android.util.TypedValue
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MergingMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.source.SingleSampleMediaSource
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.common.Tracks
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import com.netmirror.streaming.data.api.RetrofitClient

/**
 * Netflix-style fullscreen video player with proper skip buttons,
 * resume-from-last-position, and polished UI.
 */
class NetflixPlayerActivity : Activity() {

    companion object {
        private const val EXTRA_URL = "video_url"
        private const val EXTRA_TITLE = "video_title"
        private const val EXTRA_VIDEO_ID = "video_id"
        private const val HIDE_DELAY = 4000L
        private const val RED = "#E50914"
        private const val PREFS = "netmirror_player"

        fun launch(context: Context, videoUrl: String, title: String, videoId: String = "") {
            context.startActivity(
                Intent(context, NetflixPlayerActivity::class.java)
                    .putExtra(EXTRA_URL, videoUrl)
                    .putExtra(EXTRA_TITLE, title)
                    .putExtra(EXTRA_VIDEO_ID, videoId)
            )
        }
    }

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var controlsOverlay: FrameLayout
    private var rewindBtn: SkipButtonView? = null
    private var forwardBtn: SkipButtonView? = null
    private lateinit var seekBar: SeekBar
    private lateinit var curTime: TextView
    private lateinit var totTime: TextView
    private lateinit var playPauseBtn: TextView
    private lateinit var speedLabel: TextView
    private lateinit var prefs: SharedPreferences
    private var qualityLabel: TextView? = null
    private var langLabel: TextView? = null

    private val handler = Handler(Looper.getMainLooper())
    private var controlsShown = true
    private var speed = 1.0f
    private var videoId = ""
    private var videoUrl = ""
    private var audioUrl = ""
    private var hasRestoredPosition = false
    private var currentTitle = ""
    private var currentYtId: String? = null  // For WebView fallback
    private var hasStartedPlaying = false     // Track if ExoPlayer ever played
    private var hasRetriedWithoutAudio = false // Retry video-only on audio codec failure
    private var streamRetryCount = 0           // Retry counter for stream IO/network errors
    private val MAX_STREAM_RETRIES = 3         // Max retries before giving up
    private var trackSelector: DefaultTrackSelector? = null

    // Telegram URL-based seeking (fMP4 streams are non-seekable in ExoPlayer)
    private var telegramBaseOffset: Long = 0L   // Current time offset in ms
    private var telegramTotalDuration: Long = 0L // Total duration saved from first play

    // Available formats for quality/language switching
    private data class VidFmt(val url: String, val height: Int, val label: String)
    private data class AudFmt(val url: String, val language: String, val code: String, val bitrate: Int)
    private val videoFormats = mutableListOf<VidFmt>()
    private val audioFormats = mutableListOf<AudFmt>()
    private var selectedVideoFmt: VidFmt? = null
    private var selectedAudioFmt: AudFmt? = null

    // Subtitle/caption tracks
    private data class CaptionTrack(val url: String, val language: String, val code: String)
    private val captionTracks = mutableListOf<CaptionTrack>()
    private var selectedCaption: CaptionTrack? = null
    private var subtitlesEnabled = true
    private var subtitleLabel: TextView? = null

    private val ticker = object : Runnable {
        override fun run() {
            if (::player.isInitialized) syncSeek()
            handler.postDelayed(this, 500)
        }
    }
    private val autoHide = Runnable { if (::player.isInitialized && player.isPlaying) fadeOut() }

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

        videoUrl = intent.getStringExtra(EXTRA_URL) ?: run { finish(); return }
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        videoId = intent.getStringExtra(EXTRA_VIDEO_ID) ?: videoUrl.hashCode().toString()

        // ── Route YouTube URLs through resolver, direct streams to player ──
        if (videoUrl.contains("youtube.com") || videoUrl.contains("youtu.be")) {
            resolveYouTubeAndPlay(title)
        } else if (videoUrl.startsWith("ytsearch:")) {
            // Series episodes use ytsearch: prefix — search YouTube and play
            val query = videoUrl.removePrefix("ytsearch:")
            searchYouTubeAndPlay(query, title)
        } else {
            initPlayer(title)
        }
    }

    // ══════════════════  YOUTUBE SEARCH + PLAY  ══════════════════
    /**
     * Search YouTube for the given query via multiple strategies,
     * then resolve and play the first result.
     */
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private fun searchYouTubeAndPlay(query: String, title: String) {
        currentTitle = title

        val loadingRoot = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val loadingText = TextView(this).apply {
            text = "Finding: ${query.take(60)}…"
            textSize = 14f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(48, 0, 48, 0)
            maxLines = 3
        }
        loadingRoot.addView(loadingText, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER })
        setContentView(loadingRoot)

        Thread {
            var foundVideoId: String? = null

            // Strategy 1: Backend search via Piped API (most reliable)
            try {
                handler.post { loadingText.text = "Searching…" }
                val serverUrl = com.netmirror.streaming.data.api.RetrofitClient.BASE_URL
                val encoded = java.net.URLEncoder.encode(query, "UTF-8")
                val conn = java.net.URL("$serverUrl/api/tmdb/yt-search?q=$encoded")
                    .openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 12000
                conn.readTimeout = 12000
                conn.setRequestProperty("User-Agent", "NetMirror/1.0")
                if (conn.responseCode == 200) {
                    val resp = conn.inputStream.bufferedReader().readText()
                    val json = org.json.JSONObject(resp)
                    if (json.optBoolean("success", false)) {
                        foundVideoId = json.optString("videoId", "")
                        if (foundVideoId.isNullOrEmpty()) foundVideoId = null
                    }
                }
                conn.disconnect()
            } catch (_: Exception) {}

            // Strategy 2: Piped API directly from device
            if (foundVideoId == null) {
                val pipedInstances = listOf(
                    "https://pipedapi.kavin.rocks",
                    "https://pipedapi.adminforge.de",
                    "https://pipedapi.in.projectsegfau.lt"
                )
                for (instance in pipedInstances) {
                    if (foundVideoId != null) break
                    try {
                        handler.post { loadingText.text = "Searching (alt)…" }
                        val encoded = java.net.URLEncoder.encode(query, "UTF-8")
                        val conn = java.net.URL("$instance/search?q=$encoded&filter=videos")
                            .openConnection() as java.net.HttpURLConnection
                        conn.connectTimeout = 8000
                        conn.readTimeout = 8000
                        if (conn.responseCode == 200) {
                            val resp = conn.inputStream.bufferedReader().readText()
                            val json = org.json.JSONObject(resp)
                            val items = json.optJSONArray("items")
                            if (items != null && items.length() > 0) {
                                for (i in 0 until items.length()) {
                                    val item = items.getJSONObject(i)
                                    val itemUrl = item.optString("url", "")
                                    if (itemUrl.contains("/watch?v=")) {
                                        foundVideoId = itemUrl.replace("/watch?v=", "")
                                        break
                                    }
                                }
                            }
                        }
                        conn.disconnect()
                    } catch (_: Exception) {}
                }
            }

            // Strategy 3: Scrape YouTube search results page
            if (foundVideoId == null) {
                try {
                    handler.post { loadingText.text = "Searching (web)…" }
                    val encoded = java.net.URLEncoder.encode(query, "UTF-8")
                    val conn = java.net.URL("https://www.youtube.com/results?search_query=$encoded")
                        .openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 10000
                    conn.readTimeout = 10000
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
                    conn.setRequestProperty("Accept-Language", "en-US,en;q=0.9")
                    if (conn.responseCode == 200) {
                        val html = conn.inputStream.bufferedReader().readText()
                        val match = Regex("\"videoId\"\\s*:\\s*\"([A-Za-z0-9_-]{11})\"").find(html)
                        foundVideoId = match?.groupValues?.get(1)
                    }
                    conn.disconnect()
                } catch (_: Exception) {}
            }

            handler.post {
                if (foundVideoId != null && foundVideoId!!.length >= 8) {
                    loadingText.text = "Found! Loading…"
                    videoUrl = "https://www.youtube.com/watch?v=$foundVideoId"
                    currentYtId = foundVideoId
                    resolveYouTubeAndPlay(title)
                } else {
                    // Ultimate fallback: open YouTube search in WebView
                    playYouTubeInWebView(null, title, searchQuery = query)
                }
            }
        }.start()
    }

    // ══════════════════  YOUTUBE RESOLVER  ══════════════════
    private fun extractYouTubeId(url: String): String? {
        val patterns = listOf(
            Regex("(?:youtube\\.com/watch\\?v=|youtu\\.be/)([A-Za-z0-9_-]+)"),
            Regex("youtube\\.com/embed/([A-Za-z0-9_-]+)")
        )
        for (p in patterns) {
            p.find(url)?.groupValues?.get(1)?.let { return it }
        }
        return null
    }

    /**
     * Resolve YouTube video to playable stream URLs using multiple strategies:
     * 1. Piped API (most reliable, actively maintained)
     * 2. Backend Piped proxy
     * 3. Backend ytdl-core resolver
     * 4. InnerTube API (least reliable, client versions expire)
     * 5. Fallback: YouTube mobile site in WebView (guaranteed to work)
     */
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private fun resolveYouTubeAndPlay(title: String) {
        val ytId = extractYouTubeId(videoUrl) ?: run {
            // Can't extract ID — just play in WebView
            playYouTubeInWebView(null, title, searchQuery = videoUrl)
            return
        }
        currentYtId = ytId
        currentTitle = title

        // Show loading UI
        val loadingRoot = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val loadingText = TextView(this).apply {
            text = "Loading video…"
            textSize = 16f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }
        loadingRoot.addView(loadingText, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER })
        setContentView(loadingRoot)

        Thread {
            val vFmts = mutableListOf<VidFmt>()
            val aFmts = mutableListOf<AudFmt>()
            val capTracks = mutableListOf<CaptionTrack>()
            var combinedUrl: String? = null
            var resolved = false

            // ── Strategy 1: Piped API directly (most reliable) ──
            val pipedInstances = listOf(
                "https://pipedapi.kavin.rocks",
                "https://pipedapi.adminforge.de",
                "https://pipedapi.in.projectsegfau.lt",
                "https://pipedapi.leptons.xyz"
            )
            for (instance in pipedInstances) {
                if (resolved) break
                try {
                    handler.post { loadingText.text = "Loading streams…" }
                    val conn = java.net.URL("$instance/streams/$ytId")
                        .openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.setRequestProperty("User-Agent", "NetMirror/1.0")
                    if (conn.responseCode == 200) {
                        val resp = conn.inputStream.bufferedReader().readText()
                        val json = org.json.JSONObject(resp)
                        if (!json.has("error")) {
                            resolved = parsePipedStreams(json, vFmts, aFmts, capTracks)
                            if (!resolved) {
                                // Check for HLS
                                val hls = json.optString("hls", "")
                                if (hls.isNotEmpty()) {
                                    combinedUrl = hls; resolved = true
                                }
                            }
                        }
                    }
                    conn.disconnect()
                } catch (_: Exception) {}
            }

            // ── Strategy 2: Backend Piped proxy ──
            if (!resolved) {
                try {
                    handler.post { loadingText.text = "Trying server…" }
                    val serverUrl = com.netmirror.streaming.data.api.RetrofitClient.BASE_URL
                    val conn = java.net.URL("$serverUrl/api/tmdb/piped-streams/$ytId")
                        .openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 15000
                    conn.readTimeout = 15000
                    conn.setRequestProperty("User-Agent", "NetMirror/1.0")
                    if (conn.responseCode == 200) {
                        val resp = conn.inputStream.bufferedReader().readText()
                        val json = org.json.JSONObject(resp)
                        if (json.optBoolean("success", false)) {
                            resolved = parseServerStreams(json, vFmts, aFmts, capTracks)
                            if (!resolved) {
                                val url = json.optString("url", "")
                                if (url.isNotEmpty()) { combinedUrl = url; resolved = true }
                            }
                        }
                    }
                    conn.disconnect()
                } catch (_: Exception) {}
            }

            // ── Strategy 3: Backend ytdl-core resolver ──
            if (!resolved) {
                try {
                    handler.post { loadingText.text = "Trying resolver…" }
                    val serverUrl = com.netmirror.streaming.data.api.RetrofitClient.BASE_URL
                    val conn = java.net.URL("$serverUrl/api/tmdb/yt-resolve/$ytId")
                        .openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 15000
                    conn.readTimeout = 15000
                    conn.setRequestProperty("User-Agent", "NetMirror/1.0")
                    if (conn.responseCode == 200) {
                        val resp = conn.inputStream.bufferedReader().readText()
                        val json = org.json.JSONObject(resp)
                        if (json.optBoolean("success", false)) {
                            resolved = parseServerStreams(json, vFmts, aFmts, capTracks)
                            if (!resolved) {
                                val url = json.optString("url", "")
                                if (url.isNotEmpty()) { combinedUrl = url; resolved = true }
                            }
                        }
                    }
                    conn.disconnect()
                } catch (_: Exception) {}
            }

            // ── Strategy 4: InnerTube TVHTML5_SIMPLY_EMBEDDED_PLAYER (last resort for direct streams) ──
            if (!resolved) {
                try {
                    handler.post { loadingText.text = "Trying direct…" }
                    val body = """{"videoId":"$ytId","context":{"client":{"clientName":"TVHTML5_SIMPLY_EMBEDDED_PLAYER","clientVersion":"2.0","hl":"en","gl":"US"}},"playbackContext":{"contentPlaybackContext":{"signatureTimestamp":20073}}}"""
                    val conn = java.net.URL("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
                        .openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0)")
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body.toByteArray()); it.flush() }
                    if (conn.responseCode == 200) {
                        val resp = conn.inputStream.bufferedReader().readText()
                        val json = org.json.JSONObject(resp)
                        val status = json.optJSONObject("playabilityStatus")?.optString("status", "") ?: ""
                        if (status == "OK") {
                            val streaming = json.optJSONObject("streamingData")
                            if (streaming != null) {
                                resolved = parseInnerTubeStreams(streaming, vFmts, aFmts)
                                if (!resolved) {
                                    // Try combined formats
                                    val formats = streaming.optJSONArray("formats")
                                    if (formats != null) {
                                        for (i in 0 until formats.length()) {
                                            val f = formats.getJSONObject(i)
                                            val url = f.optString("url", "")
                                            if (url.isNotEmpty()) { combinedUrl = url; resolved = true; break }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    conn.disconnect()
                } catch (_: Exception) {}
            }

            // Sort and deduplicate
            vFmts.sortByDescending { it.height }
            aFmts.sortByDescending { it.bitrate }
            val uniqueAudio = aFmts.distinctBy { it.code }.toMutableList()

            handler.post {
                if (resolved && (vFmts.isNotEmpty() || combinedUrl != null)) {
                    // ── Success: play with ExoPlayer ──
                    videoFormats.clear(); videoFormats.addAll(vFmts)
                    audioFormats.clear(); audioFormats.addAll(uniqueAudio)
                    captionTracks.clear(); captionTracks.addAll(capTracks)

                    selectedCaption = captionTracks.firstOrNull { it.code == "en" }
                        ?: captionTracks.firstOrNull { it.code.startsWith("en") }
                    subtitlesEnabled = selectedCaption != null

                    if (vFmts.isNotEmpty() && uniqueAudio.isNotEmpty()) {
                        val targetH = autoQualityHeight()
                        selectedVideoFmt = vFmts.firstOrNull { it.height <= targetH } ?: vFmts.last()
                        selectedAudioFmt = uniqueAudio.firstOrNull { it.code == "en" } ?: uniqueAudio[0]
                        videoUrl = selectedVideoFmt!!.url
                        audioUrl = selectedAudioFmt!!.url
                        initPlayer(title)
                    } else if (combinedUrl != null) {
                        videoUrl = combinedUrl!!; audioUrl = ""
                        initPlayer(title)
                    }
                } else {
                    // ── All extraction failed — YouTube mobile WebView (guaranteed) ──
                    playYouTubeInWebView(ytId, title)
                }
            }
        }.start()
    }

    /** Parse Piped API /streams response into format lists */
    private fun parsePipedStreams(json: org.json.JSONObject, vFmts: MutableList<VidFmt>, aFmts: MutableList<AudFmt>, capTracks: MutableList<CaptionTrack>): Boolean {
        // Combined video+audio streams
        val videoStreams = json.optJSONArray("videoStreams")
        if (videoStreams != null) {
            for (i in 0 until videoStreams.length()) {
                val s = videoStreams.getJSONObject(i)
                val url = s.optString("url", "")
                val h = s.optInt("height", 0)
                val videoOnly = s.optBoolean("videoOnly", true)
                if (url.isNotEmpty() && h > 0) {
                    if (!videoOnly) {
                        // Combined stream — treat as VidFmt (has audio included)
                        vFmts.add(VidFmt(url, h, s.optString("quality", "${h}p")))
                    } else {
                        vFmts.add(VidFmt(url, h, s.optString("quality", "${h}p")))
                    }
                }
            }
        }
        // Audio streams
        val audioStreams = json.optJSONArray("audioStreams")
        if (audioStreams != null) {
            for (i in 0 until audioStreams.length()) {
                val s = audioStreams.getJSONObject(i)
                val url = s.optString("url", "")
                if (url.isNotEmpty()) {
                    val bitrate = s.optInt("bitrate", 0)
                    val lang = s.optString("audioTrackLocale", "Default")
                    val code = s.optString("audioTrackId", "und").split(".")[0]
                    aFmts.add(AudFmt(url, lang.ifEmpty { "Default" }, code.ifEmpty { "und" }, bitrate))
                }
            }
        }
        // Subtitles
        val subs = json.optJSONArray("subtitles")
        if (subs != null) {
            for (i in 0 until subs.length()) {
                val s = subs.getJSONObject(i)
                val url = s.optString("url", "")
                val code = s.optString("code", "")
                if (url.isNotEmpty()) {
                    capTracks.add(CaptionTrack(url, s.optString("name", code), code))
                }
            }
        }
        return vFmts.isNotEmpty() && aFmts.isNotEmpty()
    }

    /** Parse backend server streams response */
    private fun parseServerStreams(json: org.json.JSONObject, vFmts: MutableList<VidFmt>, aFmts: MutableList<AudFmt>, capTracks: MutableList<CaptionTrack>): Boolean {
        val url = json.optString("url", "")
        val audioUrlStr = json.optString("audioUrl", "")
        val type = json.optString("type", "combined")

        val serverVFmts = json.optJSONArray("videoFormats")
        if (serverVFmts != null) {
            for (i in 0 until serverVFmts.length()) {
                val f = serverVFmts.getJSONObject(i)
                vFmts.add(VidFmt(f.optString("url", ""), f.optInt("height", 0), f.optString("label", "?")))
            }
        }
        val serverAFmts = json.optJSONArray("audioFormats")
        if (serverAFmts != null) {
            for (i in 0 until serverAFmts.length()) {
                val f = serverAFmts.getJSONObject(i)
                aFmts.add(AudFmt(f.optString("url", ""), f.optString("lang", "Default"), f.optString("code", "und"), f.optInt("bitrate", 0)))
            }
        }
        val serverCaps = json.optJSONArray("captions")
        if (serverCaps != null) {
            for (i in 0 until serverCaps.length()) {
                val c = serverCaps.getJSONObject(i)
                capTracks.add(CaptionTrack(c.optString("url", ""), c.optString("lang", ""), c.optString("code", "")))
            }
        }
        if (type == "split" && audioUrlStr.isNotEmpty() && url.isNotEmpty()) {
            if (vFmts.isEmpty()) vFmts.add(VidFmt(url, 720, json.optString("quality", "720p")))
            if (aFmts.isEmpty()) aFmts.add(AudFmt(audioUrlStr, "Default", "und", 128000))
            return true
        }
        return vFmts.isNotEmpty() && aFmts.isNotEmpty()
    }

    /** Parse InnerTube streamingData */
    private fun parseInnerTubeStreams(streaming: org.json.JSONObject, vFmts: MutableList<VidFmt>, aFmts: MutableList<AudFmt>): Boolean {
        val adaptive = streaming.optJSONArray("adaptiveFormats") ?: return false
        for (i in 0 until adaptive.length()) {
            val f = adaptive.getJSONObject(i)
            val url = f.optString("url", "")
            if (url.isEmpty()) continue
            val mime = f.optString("mimeType", "")
            if (mime.startsWith("video/")) {
                val h = f.optInt("height", 0)
                if (h > 0) vFmts.add(VidFmt(url, h, "${h}p"))
            } else if (mime.startsWith("audio/")) {
                val br = f.optInt("averageBitrate", f.optInt("bitrate", 0))
                val track = f.optJSONObject("audioTrack")
                val lang = track?.optString("displayName", "Default") ?: "Default"
                val code = (track?.optString("id", "und") ?: "und").split(".")[0]
                aFmts.add(AudFmt(url, lang, code, br))
            }
        }
        return vFmts.isNotEmpty() && aFmts.isNotEmpty()
    }

    /**
     * Ultimate fallback: play YouTube in a WebView using the MOBILE YouTube site.
     * NOT the embed player (which blocks many videos), but the actual m.youtube.com page.
     * This is guaranteed to work for ALL YouTube videos.
     */
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private fun playYouTubeInWebView(ytId: String?, title: String, searchQuery: String? = null) {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        // Back button overlay
        val backBtn = TextView(this).apply {
            text = "‹"
            textSize = 36f
            setTextColor(Color.WHITE)
            setPadding(dp(16), dp(8), dp(16), dp(8))
            setBackgroundColor(Color.parseColor("#60000000"))
            setOnClickListener { finish() }
        }

        val webView = android.webkit.WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.allowContentAccess = true
            settings.setSupportZoom(false)
            settings.userAgentString = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
            setLayerType(View.LAYER_TYPE_HARDWARE, null)

            webChromeClient = object : android.webkit.WebChromeClient() {
                private var customView: View? = null
                override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                    customView = view
                    if (view != null) {
                        root.addView(view, match())
                        root.bringChildToFront(view)
                        backBtn.visibility = View.GONE
                    }
                }
                override fun onHideCustomView() {
                    customView?.let { root.removeView(it) }
                    customView = null
                    backBtn.visibility = View.VISIBLE
                }
            }

            webViewClient = object : android.webkit.WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: android.webkit.WebView?, request: android.webkit.WebResourceRequest?
                ): Boolean {
                    val url = request?.url?.toString() ?: return false
                    if (url.contains("youtube.com") || url.contains("youtu.be") || url.contains("googlevideo.com") || url.contains("google.com")) return false
                    return true
                }

                override fun onPageFinished(view: android.webkit.WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // Inject CSS to hide YouTube app banners and make player fullwidth
                    view?.evaluateJavascript("""
                        (function() {
                            var style = document.createElement('style');
                            style.textContent = `
                                .mobile-topbar-header, .ytm-promoted-sparkles-web-renderer,
                                .dialog-container, .consent-dialog, .upsell-dialog-button-renderer,
                                ytm-consent-bump-v2-renderer, .ytm-banner-top,
                                .ytm-upsell-view-model, .companion-slot,
                                .yt-mealbar-promo-renderer, ytm-pivot-bar-renderer,
                                #guide-button, .watch-below-the-player,
                                .related-chips-slot-wrapper { display: none !important; }
                                body { background: #000 !important; }
                            `;
                            document.head.appendChild(style);
                        })();
                    """.trimIndent(), null)
                }
            }
        }

        root.addView(webView, match())
        root.addView(backBtn, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.TOP or Gravity.START })

        setContentView(root)

        // Load the appropriate YouTube URL
        val targetUrl = when {
            searchQuery != null -> {
                val encoded = java.net.URLEncoder.encode(searchQuery, "UTF-8")
                "https://m.youtube.com/results?search_query=$encoded"
            }
            ytId != null -> "https://m.youtube.com/watch?v=$ytId"
            else -> "https://m.youtube.com"
        }
        webView.loadUrl(targetUrl)
    }

    private fun autoQualityHeight(): Int {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val nc = cm?.getNetworkCapabilities(cm.activeNetwork)
        return when {
            nc == null -> 360
            nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> 1080
            nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> 720
            else -> 480
        }
    }

    private fun switchStream() {
        if (!::player.isInitialized) return
        val pos = player.currentPosition
        val wasPlaying = player.isPlaying
        val httpDs = DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(30_000)
            .setReadTimeoutMs(60_000)
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent("ExoPlayer/NetMirror")
        val dsFactory = DefaultDataSource.Factory(this, httpDs)
        if (audioUrl.isNotEmpty()) {
            val vs = ProgressiveMediaSource.Factory(dsFactory).createMediaSource(MediaItem.fromUri(videoUrl))
            val as2 = ProgressiveMediaSource.Factory(dsFactory).createMediaSource(MediaItem.fromUri(audioUrl))
            if (subtitlesEnabled && selectedCaption != null) {
                val subConfig = MediaItem.SubtitleConfiguration.Builder(Uri.parse(selectedCaption!!.url))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(selectedCaption!!.code)
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                    .build()
                val subSource = SingleSampleMediaSource.Factory(dsFactory).createMediaSource(subConfig, C.TIME_UNSET)
                player.setMediaSource(MergingMediaSource(vs, as2, subSource))
            } else {
                player.setMediaSource(MergingMediaSource(vs, as2))
            }
        } else {
            if (subtitlesEnabled && selectedCaption != null) {
                val subUrl = buildSubtitleUrl(selectedCaption!!.url)
                val mediaItem = MediaItem.Builder()
                    .setUri(videoUrl)
                    .setSubtitleConfigurations(listOf(
                        MediaItem.SubtitleConfiguration.Builder(Uri.parse(subUrl))
                            .setMimeType(MimeTypes.TEXT_VTT)
                            .setLanguage(selectedCaption!!.code)
                            .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                            .build()
                    ))
                    .build()
                player.setMediaItem(mediaItem)
            } else {
                player.setMediaItem(MediaItem.fromUri(videoUrl))
            }
        }
        player.prepare()
        player.seekTo(pos)
        if (wasPlaying) player.play()
        qualityLabel?.text = "\uD83C\uDFA5 ${selectedVideoFmt?.label ?: "Auto"}"
        langLabel?.text = "\uD83C\uDF10 ${selectedAudioFmt?.language ?: "Default"}"
        subtitleLabel?.text = if (subtitlesEnabled && selectedCaption != null) "CC \u2713" else "CC"
        subtitleLabel?.setTextColor(if (subtitlesEnabled && selectedCaption != null) Color.parseColor(RED) else Color.WHITE)
    }

    // ══════════════════  PLAYER INIT  ══════════════════
    @SuppressLint("ClickableViewAccessibility")
    private fun initPlayer(title: String) {
        // ── Root ──
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            clipChildren = false
            clipToPadding = false
        }

        // ── Player surface ──
        playerView = PlayerView(this).apply { useController = false; setBackgroundColor(Color.BLACK) }
        root.addView(playerView, match())

        // Netflix-style subtitle styling
        playerView.subtitleView?.apply {
            setStyle(CaptionStyleCompat(
                Color.WHITE,
                Color.TRANSPARENT,
                Color.TRANSPARENT,
                CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW,
                Color.BLACK,
                Typeface.create("sans-serif-medium", Typeface.BOLD)
            ))
            setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            setBottomPaddingFraction(0.06f)
            setApplyEmbeddedStyles(false)
            setApplyEmbeddedFontSizes(false)
        }

        // ── Controls overlay ──
        controlsOverlay = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#88000000"))
            clipChildren = false
            clipToPadding = false
        }
        root.addView(controlsOverlay, match())

        // Buffering indicator removed — no loading text shown

        buildTopBar(title)
        buildCenterControls()
        buildBottomBar()

        // Gestures
        val gd = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean { toggle(); return true }
            override fun onDoubleTap(e: MotionEvent): Boolean {
                if (e.x < root.width / 2) {
                    rewindBtn?.animateSkip(); skip(-10000)
                } else {
                    forwardBtn?.animateSkip(); skip(10000)
                }
                return true
            }
        })
        root.setOnTouchListener { _, ev -> gd.onTouchEvent(ev); true }

        setContentView(root)
        immersive()

        // ── Rewrite video URL domain to current active server (failover) ──
        val activeBase = RetrofitClient.BASE_URL.trimEnd('/')
        val apiIdx = videoUrl.indexOf("/api/")
        if (videoUrl.startsWith("http") && apiIdx != -1) {
            val rewritten = "$activeBase${videoUrl.substring(apiIdx)}"
            if (rewritten != videoUrl) {
                Log.d("Player", "Rewrote stream URL domain: $videoUrl → $rewritten")
                videoUrl = rewritten
            }
        }
        // Also rewrite audioUrl if present
        if (audioUrl.isNotEmpty()) {
            val audioApiIdx = audioUrl.indexOf("/api/")
            if (audioUrl.startsWith("http") && audioApiIdx != -1) {
                audioUrl = "$activeBase${audioUrl.substring(audioApiIdx)}"
            }
        }

        // ── ExoPlayer ──
        // Use MediaCodec decoders only (no extension decoders installed)
        // setEnableDecoderFallback allows trying alternative MediaCodec decoders
        val renderersFactory = DefaultRenderersFactory(this)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)
            .setEnableDecoderFallback(true)

        // Custom HTTP data source with tight timeouts for fast loading
        val httpDsFactory = DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(10_000)
            .setReadTimeoutMs(30_000)
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent("ExoPlayer/NetMirror")
            .setTransferListener(DefaultBandwidthMeter.Builder(this).build())
        val dsFactory = DefaultDataSource.Factory(this, httpDsFactory)

        // Use DefaultMediaSourceFactory at builder level — ensures ALL media items
        // (progressive, HLS, etc.) use our custom timeouts automatically
        val mediaSourceFactory = DefaultMediaSourceFactory(dsFactory)

        // Aggressive fast-start buffering — prioritize quick playback over deep buffering
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                5_000,    // minBufferMs — 5s minimum buffer (was 15s)
                30_000,   // maxBufferMs — 30s max buffer (was 120s)
                500,      // bufferForPlaybackMs — start playing after just 0.5s! (was 2.5s)
                1_500     // bufferForPlaybackAfterRebufferMs — 1.5s after rebuffer (was 5s)
            )
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()

        // Track selector — let ExoPlayer pick the best tracks naturally
        trackSelector = DefaultTrackSelector(this).apply {
            parameters = buildUponParameters()
                .setAllowAudioMixedMimeTypeAdaptiveness(true)
                .build()
        }

        player = ExoPlayer.Builder(this, renderersFactory)
            .setMediaSourceFactory(mediaSourceFactory)
            .setLoadControl(loadControl)
            .setTrackSelector(trackSelector!!)
            .build()

        // Set audio attributes for movie/video content — critical for proper audio routing
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
            .build()
        player.setAudioAttributes(audioAttributes, /* handleAudioFocus= */ true)

        playerView.player = player

        // Now set the media item — the builder-level factories handle everything
        if (audioUrl.isNotEmpty()) {
            val videoSource = ProgressiveMediaSource.Factory(dsFactory).createMediaSource(MediaItem.fromUri(videoUrl))
            val audioSource = ProgressiveMediaSource.Factory(dsFactory).createMediaSource(MediaItem.fromUri(audioUrl))
            if (subtitlesEnabled && selectedCaption != null) {
                val subConfig = MediaItem.SubtitleConfiguration.Builder(Uri.parse(selectedCaption!!.url))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(selectedCaption!!.code)
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                    .build()
                val subSource = SingleSampleMediaSource.Factory(dsFactory).createMediaSource(subConfig, C.TIME_UNSET)
                player.setMediaSource(MergingMediaSource(videoSource, audioSource, subSource))
            } else {
                player.setMediaSource(MergingMediaSource(videoSource, audioSource))
            }
        } else {
            // Single stream (Telegram, direct URL, etc.)
            // DefaultMediaSourceFactory set at builder level handles timeouts and format detection
            if (subtitlesEnabled && selectedCaption != null) {
                val mediaItem = MediaItem.Builder()
                    .setUri(videoUrl)
                    .setSubtitleConfigurations(listOf(
                        MediaItem.SubtitleConfiguration.Builder(Uri.parse(selectedCaption!!.url))
                            .setMimeType(MimeTypes.TEXT_VTT)
                            .setLanguage(selectedCaption!!.code)
                            .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                            .build()
                    ))
                    .build()
                player.setMediaItem(mediaItem)
            } else {
                // Single stream (Telegram, direct URL, etc.)
                // DefaultMediaSourceFactory handles format detection from Content-Type header
                player.setMediaItem(MediaItem.fromUri(videoUrl))
            }
        }

        player.prepare()
        player.playWhenReady = true
        hasStartedPlaying = false

        // Auto-fetch embedded subtitles for Telegram streams in the background
        if (captionTracks.isEmpty()) {
            fetchTelegramSubtitles()
        }

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(s: Int) {
                if (s == Player.STATE_READY) {
                    hasStartedPlaying = true
                    // Save total duration on first successful play for Telegram seeking
                    if (telegramTotalDuration == 0L && player.duration > 0 && player.duration != C.TIME_UNSET) {
                        telegramTotalDuration = player.duration + telegramBaseOffset
                    }
                    totTime.text = fmt(effectiveDuration())
                    // Resume from last position
                    if (!hasRestoredPosition) {
                        hasRestoredPosition = true
                        val saved = prefs.getLong("pos_$videoId", 0L)
                        val totalDur = effectiveDuration()
                        if (saved > 1000 && (totalDur == 0L || saved < totalDur - 2000)) {
                            if (isTelegramStream() && !player.isCurrentMediaItemSeekable) {
                                telegramSeekTo(saved)
                            } else {
                                player.seekTo(saved)
                            }
                        }
                    }
                    scheduleHide()
                }
                if (s == Player.STATE_ENDED) { playPauseBtn.text = "▶"; fadeIn() }
            }
            override fun onIsPlayingChanged(p: Boolean) {
                playPauseBtn.text = if (p) "❚❚" else "▶"
                if (p) { hasStartedPlaying = true; scheduleHide() } else fadeIn()
            }
            override fun onPlayerError(error: PlaybackException) {
                Log.e("Player", "ExoPlayer error: code=${error.errorCode} msg=${error.message}", error)

                // On decoder/codec errors, retry with audio track disabled (E-AC3/DDP etc.)
                if (!hasRetriedWithoutAudio && (
                    error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED ||
                    error.errorCode == PlaybackException.ERROR_CODE_DECODING_FAILED ||
                    error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ||
                    error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES
                )) {
                    hasRetriedWithoutAudio = true
                    Log.w("Player", "Decoder error — retrying with audio disabled")
                    android.widget.Toast.makeText(
                        this@NetflixPlayerActivity, "Audio format unsupported, playing video only…",
                        android.widget.Toast.LENGTH_SHORT
                    ).show()
                    val pos = player.currentPosition
                    // Disable all audio renderers
                    trackSelector?.let { ts ->
                        val pb = ts.buildUponParameters()
                        for (i in 0 until player.rendererCount) {
                            if (player.getRendererType(i) == C.TRACK_TYPE_AUDIO) {
                                pb.setRendererDisabled(i, true)
                            }
                        }
                        ts.parameters = pb.build()
                    }
                    player.seekTo(pos)
                    player.prepare()
                    player.play()
                    return
                }

                // ── Retry logic for stream IO / network / server errors ──
                val isRetryableError = error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                    error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ||
                    error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ||
                    error.errorCode == PlaybackException.ERROR_CODE_IO_UNSPECIFIED ||
                    error.errorCode == PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE ||
                    error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED ||
                    error.errorCode == PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND

                // For YouTube-sourced streams, skip retry — URLs expire fast.
                // Fall through to WebView fallback immediately.
                if (isRetryableError && currentYtId != null) {
                    Log.w("Player", "YouTube stream error (code=${error.errorCode}) — skipping retry, falling back to WebView")
                    android.widget.Toast.makeText(
                        this@NetflixPlayerActivity,
                        "Stream expired, switching to web player…",
                        android.widget.Toast.LENGTH_SHORT
                    ).show()
                    releasePlayer()
                    playYouTubeInWebView(currentYtId!!, currentTitle)
                    return
                }

                // For non-YouTube streams (Telegram, Cloudinary), retry with backoff
                if (isRetryableError && streamRetryCount < MAX_STREAM_RETRIES) {
                    streamRetryCount++
                    val delaySec = streamRetryCount * 2  // 2s, 4s, 6s progressive backoff
                    Log.w("Player", "Stream error — retry $streamRetryCount/$MAX_STREAM_RETRIES in ${delaySec}s")
                    android.widget.Toast.makeText(
                        this@NetflixPlayerActivity,
                        "Reconnecting… (attempt $streamRetryCount/$MAX_STREAM_RETRIES)",
                        android.widget.Toast.LENGTH_SHORT
                    ).show()
                    handler.postDelayed({
                        if (!isFinishing) {
                            player.setMediaItem(MediaItem.fromUri(videoUrl))
                            player.prepare()
                            player.playWhenReady = true
                        }
                    }, delaySec * 1000L)
                    return
                }

                // Show the user what went wrong
                val msg = when (error.errorCode) {
                    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
                    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
                        "Network error. Check your connection and try again."
                    PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
                    PlaybackException.ERROR_CODE_DECODING_FAILED ->
                        "This video format is not supported on your device."
                    PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
                        "Server error. The video source may be unavailable."
                    else -> "Playback error (${error.errorCode}): ${error.message ?: "Unknown"}"
                }
                android.widget.Toast.makeText(
                    this@NetflixPlayerActivity, msg, android.widget.Toast.LENGTH_LONG
                ).show()

                // Try opening in external player as last resort before closing
                try {
                    val extIntent = android.content.Intent(android.content.Intent.ACTION_VIEW)
                    extIntent.setDataAndType(Uri.parse(videoUrl), "video/*")
                    if (extIntent.resolveActivity(packageManager) != null) {
                        startActivity(extIntent)
                        finish()
                        return
                    }
                } catch (_: Exception) {}

                // Fall back to YouTube if available, otherwise close after showing message
                val ytFallback = currentYtId
                if (ytFallback != null) {
                    releasePlayer()
                    playYouTubeInWebView(ytFallback, currentTitle)
                } else {
                    releasePlayer()
                    handler.postDelayed({ finish() }, 2500) // Let user read the Toast
                }
            }
        })

        // Timeout: if ExoPlayer doesn't start playing within 15 seconds, fall back to WebView
        if (currentYtId != null) {
            handler.postDelayed({
                if (!hasStartedPlaying && currentYtId != null) {
                    releasePlayer()
                    playYouTubeInWebView(currentYtId!!, currentTitle)
                }
            }, 15000)
        }

        // Timeout safety net for non-YouTube streams (e.g., Telegram)
        // If nothing plays within 20 seconds, retry with fresh connection
        if (currentYtId == null) {
            handler.postDelayed({
                if (!hasStartedPlaying && !isFinishing && streamRetryCount < MAX_STREAM_RETRIES) {
                    streamRetryCount++
                    Log.w("Player", "Telegram/direct stream timeout — retry $streamRetryCount/$MAX_STREAM_RETRIES")
                    android.widget.Toast.makeText(
                        this@NetflixPlayerActivity,
                        "Stream loading slowly, retrying…",
                        android.widget.Toast.LENGTH_SHORT
                    ).show()
                    player.stop()
                    player.setMediaItem(MediaItem.fromUri(videoUrl))
                    player.prepare()
                    player.playWhenReady = true
                }
            }, 20_000)
        }

        handler.post(ticker)
    }

    // ══════════════════  TOP BAR  ══════════════════
    private fun buildTopBar(title: String) {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(14), dp(20), 0)
        }

        // ← Back arrow (proper arrow character)
        val back = TextView(this).apply {
            text = "‹"  // Single left-pointing angle quotation mark - cleaner arrow
            textSize = 36f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setTypeface(Typeface.DEFAULT, Typeface.NORMAL)
            setOnClickListener { finish() }
        }
        bar.addView(back, LinearLayout.LayoutParams(dp(40), dp(44)))

        // Title — bold italic white
        val tv = TextView(this).apply {
            text = title
            textSize = 17f
            setTextColor(Color.WHITE)
            setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD_ITALIC))
            isSingleLine = true
            setPadding(dp(6), 0, 0, 0)
        }
        bar.addView(tv, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        // Dolby Audio badge — shown for Telegram channel videos (DDP/E-AC3 source)
        if (videoUrl.contains("/api/telegram/")) {
            val dolbyBadge = TextView(this).apply {
                text = "ᴅᴏʟʙʏ AUDIO"
                textSize = 10f
                setTextColor(Color.WHITE)
                setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD))
                gravity = Gravity.CENTER
                setPadding(dp(8), dp(4), dp(8), dp(4))
                background = GradientDrawable().apply {
                    setColor(Color.parseColor("#33FFFFFF"))
                    cornerRadius = dp(4).toFloat()
                    setStroke(1, Color.parseColor("#88FFFFFF"))
                }
            }
            bar.addView(dolbyBadge, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.CENTER_VERTICAL })
        }

        controlsOverlay.addView(bar, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, dp(56)).apply { gravity = Gravity.TOP })
    }

    // ══════════════════  CENTER CONTROLS  ══════════════════
    private fun buildCenterControls() {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            clipChildren = false
            clipToPadding = false
        }

        val skipSize = dp(56)
        val playSize = dp(64)

        // ⟲ 10 — Rewind (custom canvas drawn + animated)
        val rewindView = SkipButtonView(this, isForward = false)
        rewindBtn = rewindView
        rewindView.setOnClickListener { rewindView.animateSkip(); skip(-10000); scheduleHide() }
        row.addView(rewindView, LinearLayout.LayoutParams(skipSize, skipSize).apply { marginEnd = dp(40) })

        // ▶ / ❚❚  Play/Pause
        playPauseBtn = TextView(this).apply {
            text = "❚❚"
            textSize = 40f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setOnClickListener {
                if (::player.isInitialized) { if (player.isPlaying) player.pause() else player.play() }
                scheduleHide()
            }
        }
        row.addView(playPauseBtn, LinearLayout.LayoutParams(playSize, playSize))

        // ⟳ 10 — Forward (custom canvas drawn + animated)
        val forwardView = SkipButtonView(this, isForward = true)
        forwardBtn = forwardView
        forwardView.setOnClickListener { forwardView.animateSkip(); skip(10000); scheduleHide() }
        row.addView(forwardView, LinearLayout.LayoutParams(skipSize, skipSize).apply { marginStart = dp(40) })

        controlsOverlay.addView(row, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.CENTER })
    }

    // ══════════════════  BOTTOM BAR  ══════════════════
    @SuppressLint("SetTextI18n")
    private fun buildBottomBar() {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), 0, dp(20), dp(14))
        }

        // Seek bar — Netflix thin red
        seekBar = SeekBar(this).apply {
            max = 1000; progress = 0
            setPadding(0, 0, 0, 0)
            progressDrawable = thinSeekDrawable()
            thumb = redDot()
            splitTrack = false
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, p: Int, user: Boolean) {
                    if (user && ::player.isInitialized) {
                        val totalDur = effectiveDuration()
                        if (totalDur > 0) {
                            val ms = (p.toLong() * totalDur) / 1000
                            curTime.text = fmt(ms)
                            // Seek during drag for seekable streams (Range-supported)
                            if (!isTelegramStream() || player.isCurrentMediaItemSeekable) {
                                player.seekTo(ms)
                            }
                        }
                    }
                }
                override fun onStartTrackingTouch(s: SeekBar) { handler.removeCallbacks(autoHide) }
                override fun onStopTrackingTouch(s: SeekBar) {
                    // URL-based seek only for non-seekable Telegram transcoded streams
                    if (isTelegramStream() && !player.isCurrentMediaItemSeekable) {
                        val totalDur = effectiveDuration()
                        if (totalDur > 0) {
                            val ms = (s.progress.toLong() * totalDur) / 1000
                            telegramSeekTo(ms)
                        }
                    }
                    scheduleHide()
                }
            })
        }
        col.addView(seekBar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(22)))

        // Time row
        val tr = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(2), dp(1), dp(2), 0)
        }
        curTime = TextView(this).apply { text = "0:00"; textSize = 12f; setTextColor(Color.WHITE) }
        totTime = TextView(this).apply { text = "0:00"; textSize = 12f; setTextColor(Color.parseColor("#999999")) }
        tr.addView(curTime)
        tr.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        tr.addView(totTime)
        col.addView(tr)

        // Speed / Quality / Language row
        val ar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, 0)
        }

        // Quality label
        qualityLabel = TextView(this).apply {
            text = "\uD83C\uDFA5 ${selectedVideoFmt?.label ?: "Auto"}"
            textSize = 12f; setTextColor(Color.WHITE)
            setPadding(dp(10), dp(5), dp(10), dp(5))
            setOnClickListener { showQualityPopup(it) }
        }
        ar.addView(qualityLabel)

        // Language label
        langLabel = TextView(this).apply {
            text = "\uD83C\uDF10 ${selectedAudioFmt?.language ?: "Default"}"
            textSize = 12f; setTextColor(Color.WHITE)
            setPadding(dp(10), dp(5), dp(10), dp(5))
            setOnClickListener { showLanguagePopup(it) }
        }
        ar.addView(langLabel)

        // Subtitle CC button
        subtitleLabel = TextView(this).apply {
            text = if (subtitlesEnabled && selectedCaption != null) "CC \u2713" else "CC"
            textSize = 12f
            setTextColor(if (subtitlesEnabled && selectedCaption != null) Color.parseColor(RED) else Color.WHITE)
            setTypeface(Typeface.DEFAULT_BOLD)
            setPadding(dp(10), dp(5), dp(10), dp(5))
            setOnClickListener { showSubtitlePopup(it) }
        }
        ar.addView(subtitleLabel)

        speedLabel = TextView(this).apply {
            text = "⏱  Speed (1x)"; textSize = 12f; setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(5), dp(10), dp(5))
            setOnClickListener { showSpeedPopup(it) }
        }
        ar.addView(speedLabel)
        col.addView(ar)

        controlsOverlay.addView(col, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.BOTTOM })
    }

    // ════════  Thin seek bar drawables  ════════
    private fun thinSeekDrawable(): Drawable {
        val h = dp(3)
        val bg = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE; cornerRadius = dp(2).toFloat()
            setSize(0, h); setColor(Color.parseColor("#4DFFFFFF"))
        }
        val prog = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE; cornerRadius = dp(2).toFloat()
            setSize(0, h); setColor(Color.parseColor(RED))
        }
        val clip = ClipDrawable(prog, Gravity.START, ClipDrawable.HORIZONTAL)
        return LayerDrawable(arrayOf(bg, clip)).apply {
            setId(0, android.R.id.background); setId(1, android.R.id.progress)
        }
    }

    private fun redDot(): Drawable {
        val s = dp(14)
        return GradientDrawable().apply {
            shape = GradientDrawable.OVAL; setSize(s, s); setColor(Color.parseColor(RED))
        }
    }

    // ════════  Speed popup  ════════
    @SuppressLint("SetTextI18n")
    private fun showSpeedPopup(anchor: View) {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#EE1A1A1A")); cornerRadius = dp(12).toFloat()
            }
            setPadding(dp(20), dp(18), dp(20), dp(14))
        }
        val speeds = floatArrayOf(0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f)
        val names = arrayOf("0.5x", "0.75x", "1x (Normal)", "1.25x", "1.5x", "2x")
        val pop = PopupWindow(panel, dp(360), ViewGroup.LayoutParams.WRAP_CONTENT, true).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); isOutsideTouchable = true
        }
        val rg = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL; gravity = Gravity.CENTER }
        speeds.forEachIndexed { i, sp ->
            rg.addView(RadioButton(this).apply {
                text = names[i]; textSize = 12f; setTextColor(Color.WHITE)
                buttonTintList = ColorStateList.valueOf(Color.WHITE)
                isChecked = speed == sp; id = i; gravity = Gravity.CENTER
                setPadding(dp(4), dp(2), dp(4), dp(2))
            })
        }
        rg.setOnCheckedChangeListener { _, cid ->
            if (cid in speeds.indices) {
                speed = speeds[cid]; player.playbackParameters = PlaybackParameters(speed)
                speedLabel.text = if (speed == 1.0f) "⏱  Speed (1x)" else "⏱  Speed (${speed}x)"
                pop.dismiss(); scheduleHide()
            }
        }
        panel.addView(rg)
        panel.addView(TextView(this).apply {
            text = "CANCEL"; textSize = 13f; setTextColor(Color.parseColor("#888888"))
            setPadding(0, dp(12), 0, 0); setOnClickListener { pop.dismiss() }
        })
        pop.showAtLocation(anchor, Gravity.CENTER, 0, 0)
    }

    // ════════  Quality popup  ════════
    @SuppressLint("SetTextI18n")
    private fun showQualityPopup(anchor: View) {
        if (videoFormats.isEmpty()) return
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#EE1A1A1A")); cornerRadius = dp(12).toFloat()
            }
            setPadding(dp(20), dp(18), dp(20), dp(14))
        }
        panel.addView(TextView(this).apply {
            text = "VIDEO QUALITY"; textSize = 11f; setTextColor(Color.parseColor("#999999"))
            setPadding(0, 0, 0, dp(8))
        })
        val pop = PopupWindow(panel, dp(280), ViewGroup.LayoutParams.WRAP_CONTENT, true).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); isOutsideTouchable = true
        }
        for (fmt in videoFormats) {
            val isSelected = fmt.url == selectedVideoFmt?.url
            panel.addView(TextView(this).apply {
                text = "${if (isSelected) "● " else "○ "}${fmt.label}${if (fmt.height >= 1080) " HD" else ""}"
                textSize = 14f
                setTextColor(if (isSelected) Color.parseColor(RED) else Color.WHITE)
                setPadding(dp(4), dp(8), dp(4), dp(8))
                setOnClickListener {
                    selectedVideoFmt = fmt; videoUrl = fmt.url
                    switchStream(); pop.dismiss(); scheduleHide()
                }
            })
        }
        pop.showAtLocation(anchor, Gravity.CENTER, 0, 0)
    }

    // ════════  Language popup  ════════
    @SuppressLint("SetTextI18n")
    private fun showLanguagePopup(anchor: View) {
        if (audioFormats.isEmpty()) return
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#EE1A1A1A")); cornerRadius = dp(12).toFloat()
            }
            setPadding(dp(20), dp(18), dp(20), dp(14))
        }
        panel.addView(TextView(this).apply {
            text = "AUDIO LANGUAGE"; textSize = 11f; setTextColor(Color.parseColor("#999999"))
            setPadding(0, 0, 0, dp(8))
        })
        val pop = PopupWindow(panel, dp(280), ViewGroup.LayoutParams.WRAP_CONTENT, true).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); isOutsideTouchable = true
        }
        for (fmt in audioFormats) {
            val isSelected = fmt.url == selectedAudioFmt?.url
            panel.addView(TextView(this).apply {
                text = "${if (isSelected) "● " else "○ "}${fmt.language}"
                textSize = 14f
                setTextColor(if (isSelected) Color.parseColor(RED) else Color.WHITE)
                setPadding(dp(4), dp(8), dp(4), dp(8))
                setOnClickListener {
                    selectedAudioFmt = fmt; audioUrl = fmt.url
                    switchStream(); pop.dismiss(); scheduleHide()
                }
            })
        }
        pop.showAtLocation(anchor, Gravity.CENTER, 0, 0)
    }

    // ════════  Subtitle popup  ════════
    @SuppressLint("SetTextI18n")
    private fun showSubtitlePopup(anchor: View) {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#EE1A1A1A")); cornerRadius = dp(12).toFloat()
            }
            setPadding(dp(20), dp(18), dp(20), dp(14))
        }
        panel.addView(TextView(this).apply {
            text = "SUBTITLES"; textSize = 11f; setTextColor(Color.parseColor("#999999"))
            setPadding(0, 0, 0, dp(8))
        })
        val pop = PopupWindow(panel, dp(280), ViewGroup.LayoutParams.WRAP_CONTENT, true).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); isOutsideTouchable = true
        }

        // "Off" option
        val isOff = !subtitlesEnabled || selectedCaption == null
        panel.addView(TextView(this).apply {
            text = "${if (isOff) "● " else "○ "}Off"
            textSize = 14f
            setTextColor(if (isOff) Color.parseColor(RED) else Color.WHITE)
            setPadding(dp(4), dp(8), dp(4), dp(8))
            setOnClickListener {
                subtitlesEnabled = false; selectedCaption = null
                switchStream(); pop.dismiss(); scheduleHide()
            }
        })

        // Caption track options
        for (track in captionTracks) {
            val isSelected = subtitlesEnabled && track.url == selectedCaption?.url
            panel.addView(TextView(this).apply {
                text = "${if (isSelected) "● " else "○ "}${track.language}"
                textSize = 14f
                setTextColor(if (isSelected) Color.parseColor(RED) else Color.WHITE)
                setPadding(dp(4), dp(8), dp(4), dp(8))
                setOnClickListener {
                    selectedCaption = track; subtitlesEnabled = true
                    switchStream(); pop.dismiss(); scheduleHide()
                }
            })
        }

        if (captionTracks.isEmpty()) {
            val msg = if (isTelegramStream()) "Loading subtitles…" else "No subtitles available"
            panel.addView(TextView(this).apply {
                text = msg; textSize = 13f; setTextColor(Color.parseColor("#666666"))
                setPadding(dp(4), dp(8), dp(4), dp(8))
            })
        }

        pop.showAtLocation(anchor, Gravity.CENTER, 0, 0)
    }

    // ════════  Helpers  ════════
    private fun isTelegramStream(): Boolean = videoUrl.contains("/api/telegram/")

    /**
     * Build subtitle URL with offset for DDP seek synchronization.
     * For Telegram streams, adds ?offset=telegramBaseOffset so that the server
     * shifts WebVTT timestamps to match the current seek position.
     */
    private fun buildSubtitleUrl(baseSubUrl: String): String {
        if (!isTelegramStream() || telegramBaseOffset <= 0) return baseSubUrl
        val cleanUrl = baseSubUrl.split("?")[0]
        val offsetSec = telegramBaseOffset / 1000
        return "$cleanUrl?offset=$offsetSec"
    }

    /**
     * Fetch embedded subtitles from a Telegram video asynchronously.
     * Polls the backend subtitle endpoint until subtitles are extracted and cached.
     * When available, adds a CaptionTrack and auto-selects English subtitles.
     */
    private fun fetchTelegramSubtitles() {
        if (!isTelegramStream()) return

        // Extract base URL and message ID from the stream URL
        // Format: https://host/api/telegram/stream/12345?t=0
        val baseServerUrl = videoUrl.substringBefore("/api/telegram/")
        val streamPath = videoUrl.substringAfter("/api/telegram/stream/").split("?")[0]
        val messageId = streamPath.toIntOrNull() ?: return

        val subtitleUrl = "$baseServerUrl/api/telegram/subtitles/$messageId"

        Thread {
            var attempts = 0
            while (attempts < 40) { // Poll up to ~10 minutes (40 × 15s)
                try {
                    val conn = java.net.URL(subtitleUrl).openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 10_000
                    conn.readTimeout = 30_000
                    conn.requestMethod = "GET"

                    val code = conn.responseCode
                    conn.disconnect()

                    when {
                        code == 200 -> {
                            // Subtitles available — add CaptionTrack on UI thread
                            runOnUiThread {
                                if (captionTracks.none { it.url == subtitleUrl }) {
                                    captionTracks.add(CaptionTrack(subtitleUrl, "English", "en"))
                                }
                                // Auto-select English subtitles if user hasn't disabled CC
                                if (subtitlesEnabled && selectedCaption == null) {
                                    selectedCaption = captionTracks.first()
                                    switchStream()
                                }
                                subtitleLabel?.text = if (subtitlesEnabled && selectedCaption != null) "CC \u2713" else "CC"
                                subtitleLabel?.setTextColor(
                                    if (subtitlesEnabled && selectedCaption != null) Color.parseColor(RED)
                                    else Color.WHITE
                                )
                            }
                            return@Thread
                        }
                        code == 202 -> {
                            // Still extracting — wait and retry
                            Thread.sleep(15_000)
                            attempts++
                        }
                        else -> {
                            // 404 or error — no subtitles for this video
                            return@Thread
                        }
                    }
                } catch (e: Exception) {
                    Log.w("Player", "Subtitle fetch error: ${e.message}")
                    Thread.sleep(15_000)
                    attempts++
                }
            }
        }.start()
    }

    private fun effectiveDuration(): Long {
        if (telegramTotalDuration > 0) return telegramTotalDuration
        if (!::player.isInitialized) return 0
        val d = player.duration
        return if (d > 0 && d != C.TIME_UNSET) d + telegramBaseOffset else 0
    }

    /**
     * Seek in a Telegram stream by reconstructing the URL with ?t=SECONDS.
     * The server either seeks in the cached temp file (instant) or re-transcodes with -ss.
     */
    private fun telegramSeekTo(positionMs: Long) {
        if (!::player.isInitialized) return
        val targetMs = positionMs.coerceAtLeast(0)
        telegramBaseOffset = targetMs
        val seconds = targetMs / 1000
        val baseUrl = videoUrl.split("?")[0]
        videoUrl = if (seconds > 0) "$baseUrl?t=$seconds" else baseUrl
        player.stop()

        if (subtitlesEnabled && selectedCaption != null) {
            val subUrl = buildSubtitleUrl(selectedCaption!!.url)
            val mediaItem = MediaItem.Builder()
                .setUri(videoUrl)
                .setSubtitleConfigurations(listOf(
                    MediaItem.SubtitleConfiguration.Builder(Uri.parse(subUrl))
                        .setMimeType(MimeTypes.TEXT_VTT)
                        .setLanguage(selectedCaption!!.code)
                        .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                        .build()
                ))
                .build()
            player.setMediaItem(mediaItem)
        } else {
            player.setMediaItem(MediaItem.fromUri(videoUrl))
        }

        player.prepare()
        player.playWhenReady = true
    }

    private fun skip(ms: Long) {
        if (!::player.isInitialized) return
        if (isTelegramStream() && !player.isCurrentMediaItemSeekable) {
            // URL-based seeking for Telegram transcoded streams (fMP4 is non-seekable)
            val currentActual = telegramBaseOffset + player.currentPosition
            val target = (currentActual + ms).coerceAtLeast(0)
            val totalDur = effectiveDuration()
            val clamped = if (totalDur > 0) target.coerceAtMost(totalDur) else target
            telegramSeekTo(clamped)
        } else {
            // Native seeking for Range-supported streams
            val pos = player.currentPosition + ms
            val dur = player.duration
            val target = if (dur > 0) pos.coerceIn(0, dur) else pos.coerceAtLeast(0)
            player.seekTo(target)
        }
        syncSeek()
    }

    private fun syncSeek() {
        if (!::player.isInitialized) return
        val p = player.currentPosition + telegramBaseOffset
        val d = effectiveDuration()
        if (d > 0) {
            seekBar.progress = ((p * 1000) / d).toInt()
            curTime.text = fmt(p)
            totTime.text = fmt(d)
        } else if (p > 0) {
            curTime.text = fmt(p)
        }
    }

    private fun fmt(ms: Long): String {
        val s = (ms / 1000).toInt().coerceAtLeast(0)
        val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, sec) else String.format("%d:%02d", m, sec)
    }

    private fun savePosition() {
        if (::player.isInitialized && (player.duration > 0 || telegramBaseOffset > 0)) {
            val actualPos = player.currentPosition + telegramBaseOffset
            prefs.edit().putLong("pos_$videoId", actualPos).apply()
        }
    }

    private fun fadeIn() {
        controlsOverlay.animate().alpha(1f).setDuration(200).withStartAction { controlsOverlay.visibility = View.VISIBLE }.start()
        controlsShown = true; scheduleHide()
    }
    private fun fadeOut() {
        controlsOverlay.animate().alpha(0f).setDuration(200).withEndAction { controlsOverlay.visibility = View.GONE }.start()
        controlsShown = false
    }
    private fun toggle() { if (controlsShown) fadeOut() else fadeIn() }
    private fun scheduleHide() { handler.removeCallbacks(autoHide); handler.postDelayed(autoHide, HIDE_DELAY) }

    @Suppress("DEPRECATION")
    private fun immersive() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.decorView?.windowInsetsController?.let {
                    it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                    it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            } else {
                window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
            }
        } catch (_: Throwable) {}
    }

    private fun match() = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onPause() { super.onPause(); savePosition(); if (::player.isInitialized) try { player.pause() } catch (_: Exception) {} }
    override fun onResume() { super.onResume(); immersive() }
    override fun onStop() {
        super.onStop()
        savePosition()
        releasePlayer()
    }
    override fun onDestroy() {
        savePosition()
        handler.removeCallbacksAndMessages(null)
        releasePlayer()
        super.onDestroy()
    }

    private fun releasePlayer() {
        try {
            if (::player.isInitialized) {
                player.stop()
                player.clearMediaItems()
                player.release()
            }
        } catch (_: Exception) {}
        try { playerView.player = null } catch (_: Exception) {}
    }

    // ══════════════════════════════════════════════════════
    //  Custom View: Netflix-style circular skip 10s button
    //  Arc + arrowhead rotates on tap; "10" text stays centered.
    //  Scale pulse + rotation animation like real Netflix.
    // ══════════════════════════════════════════════════════
    class SkipButtonView(context: Context, private val isForward: Boolean) : View(context) {
        init {
            // Prevent clipping when scale animation goes beyond view bounds
            clipToOutline = false
        }

        private val circlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 2.5f * resources.displayMetrics.density
        }
        private val arrowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; style = Paint.Style.FILL
        }
        private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            textSize = 14f * resources.displayMetrics.density
        }
        private val ripplePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; style = Paint.Style.FILL
        }

        private val arcRect = RectF()
        private val arrowPath = Path()

        /** Animated rotation angle for the arc + arrowhead (degrees) */
        private var arcRotation = 0f

        /** Animated scale factor for pulse effect */
        private var scaleFactor = 1f

        /** Ripple alpha for tap feedback */
        private var rippleAlpha = 0

        private var rotationAnimator: ValueAnimator? = null
        private var scaleAnimator: ValueAnimator? = null
        private var rippleAnimator: ValueAnimator? = null

        /** Call this to trigger the Netflix-style skip animation */
        fun animateSkip() {
            // Cancel any running animations
            rotationAnimator?.cancel()
            scaleAnimator?.cancel()
            rippleAnimator?.cancel()

            // 1) Rotation: spin the arc 360° in the skip direction
            val targetRotation = if (isForward) 360f else -360f
            rotationAnimator = ValueAnimator.ofFloat(0f, targetRotation).apply {
                duration = 500
                interpolator = OvershootInterpolator(0.6f)
                addUpdateListener { arcRotation = it.animatedValue as Float; invalidate() }
                start()
            }

            // 2) Scale pulse: quick scale-up then back to normal
            scaleAnimator = ValueAnimator.ofFloat(1f, 1.25f, 1f).apply {
                duration = 350
                addUpdateListener { scaleFactor = it.animatedValue as Float; invalidate() }
                start()
            }

            // 3) Ripple: brief white circle flash behind the icon
            rippleAnimator = ValueAnimator.ofInt(60, 0).apply {
                duration = 400
                addUpdateListener { rippleAlpha = it.animatedValue as Int; invalidate() }
                start()
            }
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val cx = width / 2f
            val cy = height / 2f
            val r = (minOf(width, height) / 2f) - circlePaint.strokeWidth
            val dp = resources.displayMetrics.density

            // Draw ripple behind everything
            if (rippleAlpha > 0) {
                ripplePaint.alpha = rippleAlpha
                canvas.drawCircle(cx, cy, r + 4 * dp, ripplePaint)
            }

            // Apply scale around center
            canvas.save()
            canvas.scale(scaleFactor, scaleFactor, cx, cy)

            // Rotate only the arc+arrowhead portion
            canvas.save()
            canvas.rotate(arcRotation, cx, cy)

            arcRect.set(cx - r, cy - r, cx + r, cy + r)

            if (isForward) {
                canvas.drawArc(arcRect, -80f, 320f, false, circlePaint)
                val arrowAngle = Math.toRadians(-80.0)
                val ax = cx + r * Math.cos(arrowAngle).toFloat()
                val ay = cy + r * Math.sin(arrowAngle).toFloat()
                val arrowSize = 7 * dp
                arrowPath.reset()
                arrowPath.moveTo(ax + arrowSize * 0.5f, ay - arrowSize)
                arrowPath.lineTo(ax + arrowSize * 0.7f, ay + arrowSize * 0.3f)
                arrowPath.lineTo(ax - arrowSize * 0.4f, ay)
                arrowPath.close()
                canvas.drawPath(arrowPath, arrowPaint)
            } else {
                canvas.drawArc(arcRect, -100f, -320f, false, circlePaint)
                val arrowAngle = Math.toRadians(-100.0)
                val ax = cx + r * Math.cos(arrowAngle).toFloat()
                val ay = cy + r * Math.sin(arrowAngle).toFloat()
                val arrowSize = 7 * dp
                arrowPath.reset()
                arrowPath.moveTo(ax - arrowSize * 0.5f, ay - arrowSize)
                arrowPath.lineTo(ax - arrowSize * 0.7f, ay + arrowSize * 0.3f)
                arrowPath.lineTo(ax + arrowSize * 0.4f, ay)
                arrowPath.close()
                canvas.drawPath(arrowPath, arrowPaint)
            }

            canvas.restore() // end arc rotation

            // "10" text stays centered, NOT rotated — only scaled
            val textY = cy + textPaint.textSize / 3f
            canvas.drawText("10", cx, textY, textPaint)

            canvas.restore() // end scale
        }

        override fun onDetachedFromWindow() {
            super.onDetachedFromWindow()
            rotationAnimator?.cancel()
            scaleAnimator?.cancel()
            rippleAnimator?.cancel()
        }
    }
}
