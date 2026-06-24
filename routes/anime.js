/**
 * Anime catalog — proxies the free, no-auth Jikan API (MyAnimeList) and caches
 * heavily so we stay well within Jikan's rate limits (~3 req/s, 60 req/min).
 *
 * Provides a large browsable/searchable anime catalog (posters, synopsis,
 * genres, score, episodes) plus the official YouTube trailer URL for playback.
 * Explicit (hentai) titles are filtered out — the app has a separate 18+ area.
 */
const express = require('express');
const router  = express.Router();
const https   = require('https');

const JIKAN = 'https://api.jikan.moe/v4';

// ── tiny in-memory cache ────────────────────────────────────────────────────
const cache = new Map();
function getCache(key) {
  const e = cache.get(key);
  if (e && e.exp > Date.now()) return e.data;
  if (e) cache.delete(key);
  return null;
}
function setCache(key, data, ttlMs) { cache.set(key, { data, exp: Date.now() + ttlMs }); }

// ── throttled JSON GET (min gap between Jikan calls) ────────────────────────
let lastCall = 0;
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NetMirror/1.0', 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode === 429) { res.resume(); return reject(new Error('rate_limited')); }
      if (res.statusCode >= 400)  { res.resume(); return reject(new Error('http_' + res.statusCode)); }
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function jget(path) {
  const wait = Math.max(0, 450 - (Date.now() - lastCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  return httpsGetJson(JIKAN + path);
}

// ── normalise a Jikan anime object → compact shape the app consumes ─────────
function norm(a) {
  if (!a) return null;
  const img = (a.images && a.images.jpg && (a.images.jpg.large_image_url || a.images.jpg.image_url)) ||
              (a.images && a.images.webp && a.images.webp.large_image_url) || '';
  const title = a.title_english || a.title || a.title_japanese || 'Untitled';
  const ytId  = a.trailer && a.trailer.youtube_id;
  return {
    id:       a.mal_id,
    title,
    image:    img,
    score:    a.score || null,
    year:     a.year || (a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year) || null,
    type:     a.type || '',
    episodes: a.episodes || null,
    status:   a.status || '',
    rating:   a.rating || '',
    genres:   (a.genres || []).map(g => g.name).filter(Boolean),
    synopsis: a.synopsis || '',
    trailer:  (a.trailer && a.trailer.url) || (ytId ? ('https://www.youtube.com/watch?v=' + ytId) : '')
  };
}
function clean(a) {
  const r = (a.rating || '').toLowerCase();
  if (r.includes('hentai') || r.startsWith('rx')) return false;
  if ((a.genres || []).some(g => /hentai|erotica/i.test(g.name || ''))) return false;
  return true;
}
function listFrom(j) {
  return (j && j.data ? j.data : []).filter(clean).map(norm).filter(x => x && x.image);
}

// ════════════════════════════════════════════════════════════════════════════
//  Routes — literal paths declared BEFORE '/:id' so they aren't shadowed.
// ════════════════════════════════════════════════════════════════════════════

// GET /api/anime/home — several curated rows for the browse screen.
router.get('/home', async (req, res) => {
  const cached = getCache('home');
  if (cached) return res.json(cached);
  const defs = [
    { key: 'airing',   title: 'Trending Now',      path: '/top/anime?filter=airing&limit=24' },
    { key: 'popular',  title: 'Most Popular',      path: '/top/anime?filter=bypopularity&limit=24' },
    { key: 'movies',   title: 'Top Anime Movies',  path: '/top/anime?type=movie&limit=24' },
    { key: 'favorite', title: 'All-Time Favorites',path: '/top/anime?filter=favorite&limit=24' },
    { key: 'upcoming', title: 'Upcoming Anime',     path: '/seasons/upcoming?limit=24' },
  ];
  const rows = [];
  for (const d of defs) {
    try {
      const items = listFrom(await jget(d.path));
      if (items.length) rows.push({ key: d.key, title: d.title, items });
    } catch (_) { /* skip a failed row, keep the rest */ }
  }
  const payload = { rows };
  if (rows.length) setCache('home', payload, 2 * 60 * 60 * 1000); // 2h
  res.json(payload);
});

// GET /api/anime/search?q=
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ items: [] });
  const key = 'search:' + q.toLowerCase();
  const cached = getCache(key);
  if (cached) return res.json(cached);
  try {
    const items = listFrom(await jget('/anime?q=' + encodeURIComponent(q) + '&sfw=true&limit=24&order_by=members&sort=desc'));
    const payload = { items };
    setCache(key, payload, 30 * 60 * 1000); // 30m
    res.json(payload);
  } catch (e) {
    res.status(502).json({ items: [], error: e.message });
  }
});

// GET /api/anime/genre/:genreId — browse by Jikan genre id (optional helper)
router.get('/genre/:genreId', async (req, res) => {
  const g = parseInt(req.params.genreId);
  if (!g) return res.json({ items: [] });
  const key = 'genre:' + g;
  const cached = getCache(key);
  if (cached) return res.json(cached);
  try {
    const items = listFrom(await jget('/anime?genres=' + g + '&sfw=true&limit=24&order_by=members&sort=desc'));
    const payload = { items };
    setCache(key, payload, 60 * 60 * 1000); // 1h
    res.json(payload);
  } catch (e) {
    res.status(502).json({ items: [], error: e.message });
  }
});

// GET /api/anime/:id — full details + trailer (declared LAST).
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const key = 'anime:' + id;
  const cached = getCache(key);
  if (cached) return res.json(cached);
  try {
    const j = await jget('/anime/' + id + '/full');
    const anime = norm(j && j.data);
    if (!anime) return res.status(404).json({ error: 'not found' });
    const payload = { anime };
    setCache(key, payload, 6 * 60 * 60 * 1000); // 6h
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
