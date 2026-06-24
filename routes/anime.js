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
const db      = require('../config/database');

const JIKAN = 'https://api.jikan.moe/v4';

// ── full-episode catalog (admin-managed; streamed in original quality) ──────
try {
  db.exec(`CREATE TABLE IF NOT EXISTS anime_episodes (
    id TEXT PRIMARY KEY,
    mal_id INTEGER NOT NULL,
    episode_number INTEGER DEFAULT 0,
    title TEXT DEFAULT '',
    source TEXT NOT NULL,
    quality TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_anime_ep_mal ON anime_episodes(mal_id)`);
  console.log('[Anime] anime_episodes table ensured');
} catch (e) { console.warn('[Anime] table init warning:', e.message); }

function isAdmin(req) {
  const pw = req.headers['x-admin-password'] || req.query.password;
  let expected = process.env.ADMIN_PASSWORD || 'admin123';
  try {
    const r = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
    if (r && r.value) expected = r.value;
  } catch (_) {}
  return pw === expected;
}

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
function trailerUrl(t) {
  if (!t) return '';
  if (t.youtube_id) return 'https://www.youtube.com/watch?v=' + t.youtube_id;
  if (t.url && /youtu/.test(t.url)) return t.url;
  // Jikan often only fills embed_url — pull the id out of it.
  if (t.embed_url) {
    const m = String(t.embed_url).match(/embed\/([A-Za-z0-9_-]{6,})/);
    if (m) return 'https://www.youtube.com/watch?v=' + m[1];
  }
  return '';
}
function norm(a) {
  if (!a) return null;
  const img = (a.images && a.images.jpg && (a.images.jpg.large_image_url || a.images.jpg.image_url)) ||
              (a.images && a.images.webp && a.images.webp.large_image_url) || '';
  const title = a.title_english || a.title || a.title_japanese || 'Untitled';
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
    trailer:  trailerUrl(a.trailer)
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

// ════════════════════════════════════════════════════════════════════════════
//  Full episodes — admin-managed sources (Telegram stream URL, direct, official)
//  These are declared BEFORE '/:id' so they are not shadowed by it.
// ════════════════════════════════════════════════════════════════════════════

// GET /api/anime/:id/episodes — public list the app uses to play full episodes
router.get('/:id/episodes', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json({ episodes: [] });
  let episodes = [];
  try {
    episodes = db.prepare(
      'SELECT id, mal_id, episode_number, title, source, quality FROM anime_episodes WHERE mal_id = ? ORDER BY episode_number ASC'
    ).all(id);
  } catch (_) {}
  res.json({ episodes });
});

// POST /api/anime/admin/episode — add (or replace) an episode for an anime
router.post('/admin/episode', express.json({ limit: '256kb' }), (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { mal_id, episode_number, title, source, quality } = req.body || {};
  if (!mal_id || !source) return res.status(400).json({ error: 'mal_id and source required' });
  const mid = parseInt(mal_id);
  const epn = parseInt(episode_number) || 0;
  try {
    // one row per (anime, episode number) — replace if it already exists
    db.prepare('DELETE FROM anime_episodes WHERE mal_id = ? AND episode_number = ?').run(mid, epn);
    const id = require('crypto').randomUUID().replace(/-/g, '').slice(0, 16);
    db.prepare('INSERT INTO anime_episodes (id, mal_id, episode_number, title, source, quality) VALUES (?,?,?,?,?,?)')
      .run(id, mid, epn, (title || '').toString().slice(0, 200), source.toString().trim(), (quality || '').toString().slice(0, 20));
    if (typeof db.saveNow === 'function') db.saveNow();
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/anime/admin/episodes/:malId — list episodes for the admin panel
router.get('/admin/episodes/:malId', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  let episodes = [];
  try { episodes = db.prepare('SELECT * FROM anime_episodes WHERE mal_id = ? ORDER BY episode_number ASC').all(parseInt(req.params.malId)); } catch (_) {}
  res.json({ episodes });
});

// DELETE /api/anime/admin/episode/:epId — remove an episode
router.delete('/admin/episode/:epId', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { db.prepare('DELETE FROM anime_episodes WHERE id = ?').run(req.params.epId); if (typeof db.saveNow === 'function') db.saveNow(); } catch (_) {}
  res.json({ success: true });
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
