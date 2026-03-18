package com.netmirror.streaming.ui.screens

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.netmirror.streaming.data.VideoDownloadManager
import com.netmirror.streaming.data.api.RetrofitClient
import com.netmirror.streaming.data.model.Video
import com.netmirror.streaming.ui.components.VideoCardHorizontal
import com.netmirror.streaming.ui.player.NetflixPlayerActivity
import com.netmirror.streaming.ui.theme.*
import com.netmirror.streaming.viewmodel.HomeViewModel
import com.netmirror.streaming.viewmodel.VideoPlayerUiState
import com.netmirror.streaming.viewmodel.VideoPlayerViewModel

// -----------------------------------------------------------
//  Video detail screen — reference design
//  Full-bleed poster → branding → title → meta → description
//  → play/add/info buttons → season tabs or more-like-this
// -----------------------------------------------------------

@Composable
fun VideoPlayerScreen(
    videoId: String,
    onBackPress: () -> Unit,
    onVideoClick: (String) -> Unit,
    playerViewModel: VideoPlayerViewModel = viewModel(),
    homeViewModel: HomeViewModel = viewModel()
) {
    val uiState by playerViewModel.uiState.collectAsState()
    var selectedTab by remember { mutableStateOf(0) }
    var descExpanded by remember { mutableStateOf(false) }
    var showDownloadDialog by remember { mutableStateOf(false) }
    var downloadDialogEpisode by remember { mutableStateOf<Video?>(null) }
    val context = LocalContext.current
    val baseUrl = RetrofitClient.BASE_URL

    // My List state
    val myListIds by homeViewModel.myListIds.collectAsState()
    val isInMyList = videoId in myListIds

    // Smooth entrance animation
    var appeared by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { appeared = true }
    val slideOffset by animateFloatAsState(if (appeared) 0f else 300f, tween(400), label = "slide")
    val fadeAlpha by animateFloatAsState(if (appeared) 1f else 0f, tween(400), label = "fade")

    LaunchedEffect(videoId) {
        try { playerViewModel.loadVideo(videoId) } catch (_: Throwable) {}
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DarkBackground)
            .graphicsLayer { translationY = slideOffset; alpha = fadeAlpha }
    ) {
        when (val state = uiState) {
            // -- LOADING --
            is VideoPlayerUiState.Loading -> {
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBackPress) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                    }
                }
                Box(Modifier.fillMaxWidth().height(400.dp).background(DarkCard), contentAlignment = Alignment.Center) {
                    NetMirrorSpinner(size = 32.dp)
                }
            }

            // -- ERROR --
            is VideoPlayerUiState.Error -> {
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBackPress) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                    }
                }
                Box(Modifier.fillMaxWidth().height(400.dp).background(DarkCard), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Failed to load", color = TextSecondary)
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = onBackPress, colors = ButtonDefaults.buttonColors(containerColor = Red)) {
                            Text("Go Back")
                        }
                    }
                }
            }

            // ------------------------------------------
            //  SUCCESS — detail layout matching reference
            // ------------------------------------------
            is VideoPlayerUiState.Success -> {
                val video = state.video
                val related = state.relatedVideos
                val seasons = state.seasons
                val episodes = state.episodes
                val selectedSeason = state.selectedSeason
                val isSeries = video.contentType == "series"

                // Parse clean overview from description (remove TMDB metadata suffix)
                val descParts = video.description.split("\n\n")
                val overview = descParts.firstOrNull()?.trim() ?: ""

                // Parse year from metadata line
                val year = Regex("\\b(19|20)\\d{2}\\b").find(video.description)?.value ?: ""

                // Total episode count
                val totalEpCount = seasons.sumOf { it.episodeCount }

                // First episode for auto-play
                val firstEpisode = if (isSeries && episodes.isNotEmpty()) episodes.first() else null

                // Trailer URL
                val trailerUrl = video.trailerUrl

                // Determine if we show season tabs or content tabs
                val showSeasonTabs = isSeries && seasons.size > 1

                // For season tabs, selectedTab represents season index
                // For content tabs (movie or single-season series), it's the content tab index
                val contentTabTitles = listOf("More Like This", "Trailers & More")

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 80.dp)
                ) {
                    // ===============  HERO IMAGE (full-bleed tall poster)  ===============
                    item(key = "hero") {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .height(420.dp)
                                .background(Color.Black)
                        ) {
                            val thumb = try { video.getThumbnailUrl(baseUrl) } catch (_: Throwable) { "" }
                            if (thumb.isNotEmpty()) {
                                AsyncImage(
                                    model = thumb,
                                    contentDescription = video.title,
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier.fillMaxSize()
                                )
                            }
                            // Gradient overlay — heavy fade at bottom
                            Box(
                                Modifier.fillMaxSize().background(
                                    Brush.verticalGradient(
                                        colors = listOf(
                                            Color.Transparent,
                                            Color.Transparent,
                                            DarkBackground.copy(alpha = 0.7f),
                                            DarkBackground
                                        ),
                                        startY = 200f,
                                        endY = 1100f
                                    )
                                )
                            )
                            // Top left back button
                            IconButton(
                                onClick = onBackPress,
                                modifier = Modifier
                                    .align(Alignment.TopStart)
                                    .padding(8.dp)
                                    .statusBarsPadding()
                            ) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White)
                            }
                        }
                    }

                    // ===============  BRANDING + TITLE + METADATA  ===============
                    item(key = "title_section") {
                        Column(Modifier.padding(horizontal = 16.dp).offset(y = (-20).dp)) {
                            // "N netmirror original" branding badge
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(bottom = 8.dp)
                            ) {
                                // "N" logo badge
                                Box(
                                    Modifier
                                        .size(20.dp)
                                        .clip(RoundedCornerShape(4.dp))
                                        .background(Red),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(
                                        "N",
                                        color = Color.White,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Black
                                    )
                                }
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "netmirror original",
                                    style = MaterialTheme.typography.labelSmall.copy(
                                        fontWeight = FontWeight.Medium,
                                        letterSpacing = 1.5.sp,
                                        fontSize = 11.sp
                                    ),
                                    color = TextSecondary
                                )
                            }

                            // Title — large decorative/serif-style
                            Text(
                                video.title,
                                style = MaterialTheme.typography.headlineLarge.copy(
                                    fontWeight = FontWeight.Black,
                                    fontFamily = FontFamily.Serif,
                                    fontStyle = FontStyle.Italic,
                                    letterSpacing = (-0.5).sp,
                                    lineHeight = 38.sp,
                                    fontSize = 34.sp
                                ),
                                color = Color.White,
                                maxLines = 3,
                                overflow = TextOverflow.Ellipsis
                            )

                            Spacer(Modifier.height(12.dp))

                            // Metadata row: Year | Seasons | Genre pill | ★ Rating
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                if (year.isNotEmpty()) {
                                    Text(
                                        year,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = TextMuted,
                                        fontWeight = FontWeight.Medium
                                    )
                                }

                                // Season count or duration
                                if (isSeries) {
                                    val seasonText = when {
                                        video.totalSeasons > 0 -> "${video.totalSeasons} Season${if (video.totalSeasons > 1) "s" else ""}"
                                        totalEpCount > 0 -> "$totalEpCount Episodes"
                                        else -> ""
                                    }
                                    if (seasonText.isNotEmpty()) {
                                        Text(
                                            seasonText,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = TextMuted,
                                            fontWeight = FontWeight.Medium
                                        )
                                    }
                                } else {
                                    val dur = video.formattedDuration()
                                    if (dur.isNotEmpty() && dur != "0:00") {
                                        Text(dur, style = MaterialTheme.typography.bodySmall, color = TextMuted)
                                    }
                                }

                                // Genre / Category pill
                                if (video.category.isNotEmpty() && video.category != "General") {
                                    Box(
                                        Modifier
                                            .border(
                                                width = 1.dp,
                                                color = TextMuted,
                                                shape = RoundedCornerShape(4.dp)
                                            )
                                            .padding(horizontal = 8.dp, vertical = 2.dp)
                                    ) {
                                        Text(
                                            video.category,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = TextSecondary,
                                            fontWeight = FontWeight.Medium
                                        )
                                    }
                                }

                                // Star rating
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        Icons.Default.Star,
                                        contentDescription = "Rating",
                                        tint = Color(0xFFFFD700),
                                        modifier = Modifier.size(14.dp)
                                    )
                                    Spacer(Modifier.width(3.dp))
                                    // Derive a rating from likes ratio or show a default
                                    val rating = if (video.likes > 0) {
                                        val r = (video.likes.toFloat() / (video.likes + video.dislikes + 1) * 5f)
                                        "%.1f".format(r.coerceIn(3.0f, 5.0f))
                                    } else "4.5"
                                    Text(
                                        rating,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = TextSecondary,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }

                    // ===============  DESCRIPTION  ===============
                    if (overview.isNotEmpty()) {
                        item(key = "desc") {
                            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                                Text(
                                    overview,
                                    style = MaterialTheme.typography.bodyMedium.copy(lineHeight = 22.sp),
                                    color = TextSecondary,
                                    maxLines = if (descExpanded) Int.MAX_VALUE else 4,
                                    overflow = TextOverflow.Ellipsis
                                )
                                if (!descExpanded && overview.length > 120) {
                                    Text(
                                        "...more",
                                        style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                                        color = TextMuted,
                                        modifier = Modifier.clickable { descExpanded = true }.padding(top = 2.dp)
                                    )
                                }
                            }
                        }
                    }

                    // ===============  ACTION BUTTONS: Play + Add + Info  ===============
                    item(key = "action_buttons") {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(16.dp)
                        ) {
                            // Play button (pill shape with icon + text)
                            Button(
                                onClick = {
                                    val playUrl: String
                                    val playTitle: String
                                    val playId: String
                                    if (isSeries && firstEpisode != null) {
                                        val epStream = firstEpisode.getStreamUrl(baseUrl)
                                        // Accept http URLs and ytsearch: queries (resolved by player)
                                        playUrl = if (firstEpisode.filename.startsWith("http")) epStream
                                                  else if (firstEpisode.filename.startsWith("ytsearch:")) firstEpisode.filename
                                                  else ""
                                        playTitle = "S${firstEpisode.seasonNumber.toString().padStart(2,'0')}E${firstEpisode.episodeNumber.toString().padStart(2,'0')} - ${firstEpisode.episodeTitle.ifEmpty { "Episode ${firstEpisode.episodeNumber}" }}"
                                        playId = firstEpisode.id
                                    } else if (isSeries) {
                                        playUrl = ""
                                        playTitle = video.title
                                        playId = video.id
                                    } else {
                                        // Accept http URLs and ytsearch: queries
                                        playUrl = if (video.filename.startsWith("http")) video.filename
                                                  else if (video.filename.startsWith("ytsearch:")) video.filename
                                                  else ""
                                        playTitle = video.title
                                        playId = video.id
                                    }
                                    if (playUrl.isNotEmpty()) {
                                        homeViewModel.addToWatched(playId)
                                        NetflixPlayerActivity.launch(context, playUrl, playTitle, playId)
                                    } else {
                                        Toast.makeText(context, "No video source linked yet", Toast.LENGTH_SHORT).show()
                                    }
                                },
                                modifier = Modifier.height(46.dp),
                                shape = RoundedCornerShape(23.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = Color.White),
                                contentPadding = PaddingValues(horizontal = 20.dp)
                            ) {
                                Icon(Icons.Default.PlayArrow, null, tint = Color.Black, modifier = Modifier.size(26.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    if (isSeries && firstEpisode != null)
                                        "Play S${firstEpisode.seasonNumber} E${firstEpisode.episodeNumber}"
                                    else "Play",
                                    color = Color.Black,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 15.sp
                                )
                            }

                            // Add (+) / Check button — circular outline
                            Box(
                                Modifier
                                    .size(42.dp)
                                    .clip(CircleShape)
                                    .border(1.5.dp, if (isInMyList) Red else TextMuted, CircleShape)
                                    .clickable {
                                        homeViewModel.toggleMyList(video.id)
                                        val msg = if (video.id in homeViewModel.myListIds.value) "Added to My List" else "Removed from My List"
                                        Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    if (isInMyList) Icons.Default.Check else Icons.Default.Add,
                                    "My List",
                                    tint = if (isInMyList) Red else Color.White,
                                    modifier = Modifier.size(24.dp)
                                )
                            }

                            // Download button — circular outline
                            Box(
                                Modifier
                                    .size(42.dp)
                                    .clip(CircleShape)
                                    .border(1.5.dp, TextMuted, CircleShape)
                                    .clickable {
                                        if (isSeries) {
                                            // For series, show download dialog for first episode
                                            if (firstEpisode != null) {
                                                downloadDialogEpisode = firstEpisode
                                                showDownloadDialog = true
                                            } else {
                                                Toast.makeText(context, "No episodes available to download", Toast.LENGTH_SHORT).show()
                                            }
                                        } else {
                                            // For movies, download directly
                                            if (video.filename.startsWith("http")) {
                                                VideoDownloadManager.downloadVideo(video)
                                                Toast.makeText(context, "Download started: ${video.title}", Toast.LENGTH_SHORT).show()
                                            } else {
                                                Toast.makeText(context, "No download source available", Toast.LENGTH_SHORT).show()
                                            }
                                        }
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(Icons.Default.KeyboardArrowDown, "Download", tint = Color.White, modifier = Modifier.size(24.dp))
                            }

                            // Info (i) button — circular outline
                            Box(
                                Modifier
                                    .size(42.dp)
                                    .clip(CircleShape)
                                    .border(1.5.dp, TextMuted, CircleShape)
                                    .clickable { /* info */ },
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(Icons.Default.Info, "Info", tint = Color.White, modifier = Modifier.size(22.dp))
                            }
                        }
                    }

                    // ===============  SEASON TABS or CONTENT TABS  ===============
                    item(key = "tabs") {
                        if (showSeasonTabs) {
                            // --- Horizontal scrollable season tabs ---
                            val scrollState = rememberScrollState()
                            Column {
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .horizontalScroll(scrollState)
                                        .padding(horizontal = 16.dp, vertical = 4.dp),
                                    horizontalArrangement = Arrangement.spacedBy(0.dp)
                                ) {
                                    seasons.forEachIndexed { idx, season ->
                                        val isSelected = idx == selectedTab
                                        Column(
                                            modifier = Modifier
                                                .clickable {
                                                    selectedTab = idx
                                                    playerViewModel.selectSeason(video.id, season.seasonNumber)
                                                }
                                                .padding(end = 24.dp, bottom = 8.dp, top = 4.dp),
                                            horizontalAlignment = Alignment.CenterHorizontally
                                        ) {
                                            Text(
                                                "Season ${season.seasonNumber}",
                                                style = MaterialTheme.typography.bodyMedium.copy(
                                                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                                                    fontSize = 14.sp
                                                ),
                                                color = if (isSelected) Color.White else TextMuted
                                            )
                                            Spacer(Modifier.height(6.dp))
                                            if (isSelected) {
                                                Box(
                                                    Modifier
                                                        .width(32.dp)
                                                        .height(3.dp)
                                                        .background(Red, RoundedCornerShape(2.dp))
                                                )
                                            }
                                        }
                                    }
                                }
                                Box(Modifier.fillMaxWidth().height(0.5.dp).background(BorderColor))
                            }
                        } else {
                            // --- Content tabs: More Like This | Trailers & More ---
                            Column {
                                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                                    contentTabTitles.forEachIndexed { idx, title ->
                                        Column(
                                            modifier = Modifier
                                                .clickable { selectedTab = idx }
                                                .padding(end = 24.dp, bottom = 8.dp, top = 4.dp),
                                            horizontalAlignment = Alignment.CenterHorizontally
                                        ) {
                                            Text(
                                                title,
                                                style = MaterialTheme.typography.bodyMedium.copy(
                                                    fontWeight = if (selectedTab == idx) FontWeight.Bold else FontWeight.Normal,
                                                    fontSize = 14.sp
                                                ),
                                                color = if (selectedTab == idx) Color.White else TextMuted
                                            )
                                            Spacer(Modifier.height(6.dp))
                                            if (selectedTab == idx) {
                                                Box(
                                                    Modifier
                                                        .width(32.dp)
                                                        .height(3.dp)
                                                        .background(Red, RoundedCornerShape(2.dp))
                                                )
                                            }
                                        }
                                    }
                                }
                                Box(Modifier.fillMaxWidth().height(0.5.dp).background(BorderColor))
                            }
                        }
                    }

                    // ===============  TAB CONTENT  ===============
                    if (showSeasonTabs) {
                        // --- SEASON TABS: show episodes for selected season ---

                        // Episode cards
                        items(items = episodes, key = { "ep_${it.id}" }) { episode ->
                            EpisodeCard(
                                episode = episode,
                                baseUrl = baseUrl,
                                onClick = {
                                    // Accept http URLs and ytsearch: queries (resolved by player)
                                    val streamUrl = if (episode.filename.startsWith("http")) episode.filename
                                                    else if (episode.filename.startsWith("ytsearch:")) episode.filename
                                                    else ""
                                    val epTitle = "S${episode.seasonNumber.toString().padStart(2,'0')}E${episode.episodeNumber.toString().padStart(2,'0')} - ${episode.episodeTitle.ifEmpty { "Episode ${episode.episodeNumber}" }}"
                                    if (streamUrl.isNotEmpty()) {
                                        homeViewModel.addToWatched(episode.id)
                                        NetflixPlayerActivity.launch(context, streamUrl, epTitle, episode.id)
                                    } else {
                                        Toast.makeText(context, "Episode not linked to a source yet", Toast.LENGTH_SHORT).show()
                                    }
                                },
                                onDownloadClick = {
                                    downloadDialogEpisode = episode
                                    showDownloadDialog = true
                                }
                            )
                        }

                        if (episodes.isEmpty()) {
                            item(key = "episodes_empty") {
                                Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                                    Text("Episodes coming soon", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    } else {
                        // --- CONTENT TABS: More Like This | Trailers & More ---
                        when (contentTabTitles.getOrNull(selectedTab)) {
                            "More Like This" -> {
                                // For single-season series, also show episodes first
                                if (isSeries && episodes.isNotEmpty()) {
                                    items(items = episodes, key = { "ep_${it.id}" }) { episode ->
                                        EpisodeCard(
                                            episode = episode,
                                            baseUrl = baseUrl,
                                            onClick = {
                                                // Accept http URLs and ytsearch: queries (resolved by player)
                                                val streamUrl = if (episode.filename.startsWith("http")) episode.filename
                                                                else if (episode.filename.startsWith("ytsearch:")) episode.filename
                                                                else ""
                                                val epTitle = "S${episode.seasonNumber.toString().padStart(2,'0')}E${episode.episodeNumber.toString().padStart(2,'0')} - ${episode.episodeTitle.ifEmpty { "Episode ${episode.episodeNumber}" }}"
                                                if (streamUrl.isNotEmpty()) {
                                                    homeViewModel.addToWatched(episode.id)
                                                    NetflixPlayerActivity.launch(context, streamUrl, epTitle, episode.id)
                                                } else {
                                                    Toast.makeText(context, "Episode not linked to a source yet", Toast.LENGTH_SHORT).show()
                                                }
                                            },
                                            onDownloadClick = {
                                                downloadDialogEpisode = episode
                                                showDownloadDialog = true
                                            }
                                        )
                                    }

                                    // Divider before related
                                    if (related.isNotEmpty()) {
                                        item(key = "related_divider") {
                                            Spacer(Modifier.height(8.dp))
                                            Text(
                                                "More Like This",
                                                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                                                color = Color.White,
                                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                                            )
                                        }
                                    }
                                }

                                if (related.isNotEmpty()) {
                                    items(items = related, key = { "mlt_${it.id}" }) { rv ->
                                        VideoCardHorizontal(video = rv, onClick = { onVideoClick(rv.id) })
                                    }
                                } else if (!isSeries || episodes.isEmpty()) {
                                    item(key = "no_related") {
                                        Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                                            Text("No recommendations yet", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
                                        }
                                    }
                                }
                            }

                            "Trailers & More" -> {
                                if (trailerUrl.isNotEmpty()) {
                                    item(key = "trailer_card") {
                                        TrailerCard(
                                            title = video.title,
                                            thumbnailUrl = try { video.getThumbnailUrl(baseUrl) } catch (_: Throwable) { "" },
                                            onClick = {
                                                NetflixPlayerActivity.launch(
                                                    context, trailerUrl,
                                                    "Trailer: ${video.title}", video.id
                                                )
                                            }
                                        )
                                    }
                                } else {
                                    item(key = "no_trailers") {
                                        Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                                            Text("No trailers available", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // ===============  DOWNLOAD DIALOG  ===============
                if (showDownloadDialog && downloadDialogEpisode != null) {
                    val dlEp = downloadDialogEpisode!!
                    AlertDialog(
                        onDismissRequest = { showDownloadDialog = false; downloadDialogEpisode = null },
                        containerColor = DarkCard,
                        title = {
                            Text("Download", color = Color.White, fontWeight = FontWeight.Bold)
                        },
                        text = {
                            Column {
                                // Download this episode
                                TextButton(
                                    onClick = {
                                        val url = if (dlEp.filename.startsWith("http")) dlEp.filename else ""
                                        if (url.isNotEmpty()) {
                                            VideoDownloadManager.downloadVideo(dlEp)
                                            Toast.makeText(context, "Downloading episode ${dlEp.episodeNumber}...", Toast.LENGTH_SHORT).show()
                                        } else {
                                            Toast.makeText(context, "Episode not linked to a source", Toast.LENGTH_SHORT).show()
                                        }
                                        showDownloadDialog = false
                                        downloadDialogEpisode = null
                                    },
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Icon(Icons.Default.KeyboardArrowDown, null, tint = Color.White, modifier = Modifier.size(20.dp))
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        "Download This Episode",
                                        color = Color.White,
                                        fontWeight = FontWeight.Medium
                                    )
                                }

                                // Download whole season
                                if (isSeries && episodes.isNotEmpty()) {
                                    TextButton(
                                        onClick = {
                                            val downloadableEps = episodes.filter { it.filename.startsWith("http") }
                                            if (downloadableEps.isNotEmpty()) {
                                                val seasonNum = downloadableEps.firstOrNull()?.seasonNumber ?: 1
                                                VideoDownloadManager.downloadSeason(downloadableEps, seasonNum)
                                                Toast.makeText(context, "Downloading ${downloadableEps.size} episodes...", Toast.LENGTH_SHORT).show()
                                            } else {
                                                Toast.makeText(context, "No episodes have download sources", Toast.LENGTH_SHORT).show()
                                            }
                                            showDownloadDialog = false
                                            downloadDialogEpisode = null
                                        },
                                        modifier = Modifier.fillMaxWidth()
                                    ) {
                                        Icon(Icons.Default.KeyboardArrowDown, null, tint = Color.White, modifier = Modifier.size(20.dp))
                                        Spacer(Modifier.width(8.dp))
                                        Text(
                                            "Download Entire Season",
                                            color = Color.White,
                                            fontWeight = FontWeight.Medium
                                        )
                                    }
                                }
                            }
                        },
                        confirmButton = {},
                        dismissButton = {
                            TextButton(onClick = { showDownloadDialog = false; downloadDialogEpisode = null }) {
                                Text("Cancel", color = TextMuted)
                            }
                        }
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------
//  Episode Card � Netflix episode row
//  [Thumbnail + play] | [Title + Duration] | [?]
//  [              Description (full width)        ]
// ---------------------------------------------------
@Composable
private fun EpisodeCard(
    episode: Video,
    baseUrl: String,
    onClick: () -> Unit,
    onDownloadClick: () -> Unit = {}
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Episode thumbnail with play overlay
            Box(
                Modifier
                    .width(130.dp)
                    .height(73.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(DarkCard),
                contentAlignment = Alignment.Center
            ) {
                val epThumb = try { episode.getThumbnailUrl(baseUrl) } catch (_: Throwable) { "" }
                if (epThumb.isNotEmpty()) {
                    AsyncImage(
                        model = epThumb,
                        contentDescription = episode.title,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Crop
                    )
                }
                // Play circle overlay
                Box(
                    Modifier.size(36.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Default.PlayArrow, "Play", tint = Color.White, modifier = Modifier.size(22.dp))
                }
            }

            Spacer(Modifier.width(12.dp))

            // Episode info
            Column(Modifier.weight(1f)) {
                Text(
                    "${episode.episodeNumber}. ${episode.episodeTitle.ifEmpty { "Episode ${episode.episodeNumber}" }}",
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = Color.White,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    formatDurationNice(episode.duration),
                    style = MaterialTheme.typography.labelSmall,
                    color = TextMuted
                )
            }

            // Download icon — functional
            Icon(
                Icons.Default.KeyboardArrowDown, "Download",
                tint = TextMuted,
                modifier = Modifier
                    .size(28.dp)
                    .clickable(onClick = onDownloadClick)
            )
        }

        // Episode description � full width below the card row
        val epOverview = episode.description.split("\n\n").firstOrNull()?.trim() ?: ""
        if (epOverview.isNotEmpty()) {
            Text(
                epOverview,
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 4.dp)
            )
        }

        Spacer(Modifier.height(12.dp))
    }
}

// ---------------------------------------------------
//  Trailer Card � large fullwidth card with play overlay
//  Matches Netflix "Trailers & More" tab
// ---------------------------------------------------
@Composable
private fun TrailerCard(
    title: String,
    thumbnailUrl: String,
    onClick: () -> Unit
) {
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        // Large trailer thumbnail
        Box(
            Modifier
                .fillMaxWidth()
                .height(200.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(DarkCard)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            if (thumbnailUrl.isNotEmpty()) {
                AsyncImage(
                    model = thumbnailUrl,
                    contentDescription = "Trailer",
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop
                )
            }
            // Large play circle overlay
            Box(
                Modifier.size(56.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(Icons.Default.PlayArrow, "Play Trailer", tint = Color.White, modifier = Modifier.size(36.dp))
            }
        }

        Spacer(Modifier.height(8.dp))

        Text(
            "Trailer: $title",
            style = MaterialTheme.typography.bodyMedium,
            color = TextSecondary
        )
    }
}

// ---------------------------------------------------
//  Custom loading spinner � avoids Material3's
//  CircularProgressIndicator which crashes on some
//  Compose BOM versions due to keyframes API mismatch
// ---------------------------------------------------
@Composable
private fun NetMirrorSpinner(
    size: Dp = 32.dp,
    color: Color = Red,
    strokeWidth: Dp = 3.dp
) {
    val transition = rememberInfiniteTransition(label = "spinner")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1100, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "spinAngle"
    )
    Canvas(modifier = Modifier.size(size)) {
        drawArc(
            color = color,
            startAngle = angle,
            sweepAngle = 270f,
            useCenter = false,
            style = Stroke(width = strokeWidth.toPx(), cap = StrokeCap.Round)
        )
    }
}

// Format duration as "1h 24m" like Netflix
private fun formatDurationNice(durationSecs: Double): String {
    val total = durationSecs.toInt()
    if (total <= 0) return ""
    val h = total / 3600
    val m = (total % 3600) / 60
    return when {
        h > 0 && m > 0 -> "${h}h ${m}m"
        h > 0 -> "${h}h"
        m > 0 -> "${m}m"
        else -> "${total}s"
    }
}
