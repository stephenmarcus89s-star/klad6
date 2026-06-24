/**
 * Adult Telegram Channel Integration  — v2 (fixed)
 *
 * Key fixes over v1:
 *  - Removed broken require('telegram/events') — module didn't exist
 *  - Server-side interval poll every 5 min auto-imports new videos
 *  - INSERT uses only guaranteed-to-exist base columns
 *  - Thumbnail extracted from Telegram document thumbs (PhotoStrippedSize)
 *  - HTTP Range streaming preserved for original quality
 */
const express = require('express');
const router  = express.Router();
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram/tl');
const { computeCheck }   = require('telegram/Password');
const bigInt             = require('big-integer');
const db   = require('../config/database');
const fs   = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ── FFmpeg ────────────────────────────────────────────────────────────────────
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (_) {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); ffmpegPath = 'ffmpeg'; } catch (_2) {}
}

// ── Config ────────────────────────────────────────────────────────────────────
const API_ID   = 38667742;
const API_HASH = 'e2d1321760b33b3e013364a862ad84bb';

// ── State ─────────────────────────────────────────────────────────────────────
let client         = null;
let connected      = false;
let channelEntity  = null;
let connectPromise = null;
let pendingLogin   = { client: null, phoneCodeHash: null, phone: null };
let ioRef          = null;

router.setIo = (io) => { ioRef = io; };

// ── CREATE adult_videos TABLE IMMEDIATELY (fix: table was missing causing silent INSERT failures) ──
try {
  db.exec(`CREATE TABLE IF NOT EXISTS adult_videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT DEFAULT '',
    video_url TEXT DEFAULT '',
    genre TEXT DEFAULT 'General',
    type TEXT DEFAULT 'movie',
    description TEXT DEFAULT '',
    duration INTEGER DEFAULT 0,
    tags TEXT DEFAULT '',
    is_featured INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  console.log('[TelegramAdult] adult_videos table ensured');
} catch (e) {
  console.warn('[TelegramAdult] Table init warning:', e.message);
}

// ── Admin auth ────────────────────────────────────────────────────────────────
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.password;
  try {
    const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
    if (!stored || password !== stored.value) return res.status(401).json({ error: 'Unauthorized' });
  } catch (_) { return res.status(401).json({ error: 'Auth check failed' }); }
  next();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getChannelName() {
  try {
    const r = db.prepare("SELECT value FROM admin_settings WHERE key = 'adult_channel_username'").get();
    if (r && r.value) return r.value;
  } catch (_) {}
  // Fallback to env var, then a built-in default, so the channel always resolves
  // even after a DB reset / fresh Railway deploy (self-heals without manual setup).
  return (process.env.TELEGRAM_ADULT_CHANNEL || 'adultnetmirror').replace('@', '').trim();
}

function needsTranscode(name) {
  const u = name.toUpperCase();
  return u.includes('DDP') || u.includes('EAC3') || u.includes('E-AC-3') || u.includes('ATMOS');
}

/** Extract a base64 thumbnail from the Telegram document thumbs array */
function extractThumb(doc) {
  try {
    const thumbs = doc.thumbs || [];
    // PhotoStrippedSize is a tiny inline preview
    const stripped = thumbs.find(t => t.className === 'PhotoStrippedSize');
    if (stripped && stripped.bytes && stripped.bytes.length > 3) {
      const b = Buffer.from(stripped.bytes);
      // gramjs stripped bytes need a small header repair for JPEG
      const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
      const patched = Buffer.concat([header, b.slice(3)]);
      return 'data:image/jpeg;base64,' + patched.toString('base64');
    }
    // Fall back to first available thumb
    const anyThumb = thumbs.find(t => t.className === 'PhotoSize' || t.className === 'PhotoSizeEmpty');
    if (!anyThumb) return '';
    return ''; // Can't easily download photo sizes without additional request
  } catch (_) { return ''; }
}

/** Import a single Telegram message as an adult video (idempotent) */
function importAdultVideo(msg, msgId) {
  try {
    if (!msg.media || msg.media.className !== 'MessageMediaDocument') return false;
    const doc = msg.media.document;
    const isVideo = (doc.mimeType || '').startsWith('video/') ||
      (doc.attributes || []).some(a => a.className === 'DocumentAttributeVideo');
    if (!isVideo) return false;

    // Check if already imported
    const existing = db.prepare(
      "SELECT id FROM adult_videos WHERE video_url LIKE ?"
    ).get(`%/stream/${msgId}`);
    if (existing) return 'skipped';

    let fileName = 'video.mp4'; let dur = 0;
    for (const a of (doc.attributes || [])) {
      if (a.className === 'DocumentAttributeFilename') fileName = a.fileName || fileName;
      if (a.className === 'DocumentAttributeVideo')    dur = Number(a.duration || 0);
    }
    const rawTitle  = (msg.message || '').split('\n')[0].trim() || fileName.replace(/\.[^.]+$/, '');
    const title     = rawTitle.slice(0, 200); // trim very long titles
    const thumbUrl  = extractThumb(doc);
    const streamUrl = `/api/adult-telegram/stream/${msgId}`;
    const id        = require('crypto').randomUUID().replace(/-/g, '').slice(0, 16);

    // Use only the guaranteed base columns (created by server.js)
    db.prepare(`INSERT OR IGNORE INTO adult_videos
      (id, title, thumbnail_url, video_url, genre, type, description, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, title, thumbUrl, streamUrl, 'General', 'movie',
           `[TG:${msgId}] ${fileName}`, Math.round(dur));
    return true;
  } catch (e) {
    console.error('[TelegramAdult] importAdultVideo error:', e.message);
    return false;
  }
}

// ── Client connection ─────────────────────────────────────────────────────────
async function getClient() {
  if (client && connected) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      let sessionStr = '';
      try {
        const saved = db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_adult_session'").get();
        if (saved && saved.value) sessionStr = saved.value;
      } catch (_) {}
      if (!sessionStr) {
        const env = (process.env.TELEGRAM_ADULT_SESSION || '').trim();
        if (env) {
          sessionStr = env;
          try { db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('telegram_adult_session', ?)").run(sessionStr); } catch (_) {}
        }
      }
      // Fallback: use main Telegram session if no dedicated adult session saved
      // (works when both channels use the same Telegram account)
      if (!sessionStr) {
        try {
          const mainSaved = db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_session'").get();
          if (mainSaved && mainSaved.value) {
            sessionStr = mainSaved.value;
            console.log('[TelegramAdult] No adult session found — trying main Telegram session as fallback');
          }
        } catch (_) {}
      }
      if (!sessionStr) { connectPromise = null; return null; }

      if (client) { try { await client.disconnect(); } catch (_) {} client = null; connected = false; }

      client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
        connectionRetries: 5, timeout: 30
      });
      await client.connect();
      // Verify session is valid — retry up to 2x before giving up
      let meOk = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await client.getMe(); meOk = true; break; } catch (_) {
          if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (!meOk) {
        console.warn('[TelegramAdult] getMe failed after retries — session likely expired');
        connected = false; client = null; connectPromise = null; return null;
      }
      connected = true;
      const ch = getChannelName();
      if (ch) {
        try {
          channelEntity = await client.getEntity(ch);
          console.log('[TelegramAdult] Connected to channel:', channelEntity.title || ch);
          // Persist the resolved channel so it's captured by the next backup
          try { db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('adult_channel_username', ?)").run(ch); } catch (_) {}
          // Proactively import recent videos so the listing is populated right
          // after a restart — makes the section self-heal with no manual scan.
          setTimeout(async () => {
            try {
              const messages = await client.getMessages(channelEntity, { limit: 100 });
              let added = 0;
              for (const msg of messages) {
                if (importAdultVideo(msg, Number(msg.id)) === true) {
                  added++;
                  if (ioRef) ioRef.emit('adult_video_added', { telegram_msg_id: Number(msg.id) });
                }
              }
              if (added > 0) {
                console.log('[TelegramAdult] Startup scan imported', added, 'video(s)');
                try { if (typeof db.saveNow === 'function') db.saveNow(); } catch (_) {}
              }
            } catch (_) {}
          }, 1200);
        } catch (e) {
          console.log('[TelegramAdult] Channel not found:', e.message);
        }
      }
      return client;
    } catch (e) {
      console.error('[TelegramAdult] Connect error:', e.message);
      connected = false; client = null; connectPromise = null; throw e;
    } finally { connectPromise = null; }
  })();
  return connectPromise;
}

// Auto-connect on startup — fast (800ms to avoid race with first status check)
setTimeout(() => getClient().catch(() => {}), 800);

// Reconnect every 15s if disconnected and session exists
setInterval(async () => {
  if (connected) return;
  try {
    const hasSess = !!db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_adult_session'").get()?.value ||
                    !!(process.env.TELEGRAM_ADULT_SESSION || '').trim();
    if (!hasSess) return;
    await getClient();
  } catch (_) {}
}, 15_000);

// Auto-scan every 5 minutes — check last 50 messages for new uploads
setInterval(async () => {
  if (!connected || !channelEntity) return;
  try {
    const cl = await getClient();
    if (!cl) return;
    const messages = await cl.getMessages(channelEntity, { limit: 50 });
    let added = 0;
    for (const msg of messages) {
      if (importAdultVideo(msg, Number(msg.id)) === true) {
        added++;
        if (ioRef) ioRef.emit('adult_video_added', { telegram_msg_id: Number(msg.id) });
      }
    }
    if (added > 0) console.log('[TelegramAdult] Auto-scan added', added, 'new video(s)');
  } catch (_) {}
}, 5 * 60 * 1000);

// \u2500\u2500 Routes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// GET /refresh \u2014 PUBLIC, no auth, rate-limited (1 req/device/2 min)
// App calls this when PremiumAdultContent finds 0 videos, to trigger an
// automatic channel scan so ALL existing videos appear immediately.
const _refreshLimits = new Map();
router.get('/refresh', async (req, res) => {
  try {
    const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const now = Date.now();
    const last = _refreshLimits.get(ip) || 0;
    const alreadySynced = (now - last) < 120_000;

    let videos = [];
    try { videos = db.prepare('SELECT * FROM adult_videos ORDER BY is_featured DESC, created_at DESC').all(); } catch (_) {}

    if (alreadySynced) {
      return res.json({ videos, imported: 0, refreshed: false });
    }
    _refreshLimits.set(ip, now);

    // Trigger background channel scan (non-blocking)
    let imported = 0;
    try {
      const cl = await getClient();
      if (cl && connected && channelEntity) {
        const messages = await cl.getMessages(channelEntity, { limit: 100 });
        for (const msg of messages) {
          if (importAdultVideo(msg, Number(msg.id)) === true) imported++;
        }
        if (imported > 0) {
          if (ioRef) ioRef.emit('adult_video_added', { count: imported });
          // Re-read videos after import
          try { videos = db.prepare('SELECT * FROM adult_videos ORDER BY is_featured DESC, created_at DESC').all(); } catch (_) {}
        }
        console.log('[TelegramAdult] /refresh triggered by device, imported', imported, 'videos');
      }
    } catch (_) {}

    res.json({ videos, imported, refreshed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', adminAuth, async (req, res) => {
  const ch    = getChannelName();
  const count = (() => { try { return db.prepare("SELECT COUNT(*) AS c FROM adult_videos WHERE video_url LIKE '%/api/adult-telegram/stream/%'").get()?.c || 0; } catch (_) { return 0; } })();

  // If not connected, check if a session exists in DB or env var
  let hasSession = false;
  let reconnecting = false;
  if (!connected) {
    try {
      const r = db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_adult_session'").get();
      hasSession = !!(r && r.value) || !!(process.env.TELEGRAM_ADULT_SESSION || '').trim();
    } catch (_) {}
    if (hasSession) {
      reconnecting = true;  // session exists — auto-connect is running / will run
      if (!connectPromise) getClient().catch(() => {});  // trigger reconnect if idle
    }
  }

  res.json({ connected, reconnecting, hasSession, channelName: ch, channelTitle: channelEntity?.title || null, videoCount: count });
});

router.get('/session-string', adminAuth, (req, res) => {
  try {
    let s = '';
    try { const r = db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_adult_session'").get(); if (r) s = r.value; } catch (_) {}
    if (!s) s = (process.env.TELEGRAM_ADULT_SESSION || '').trim();
    if (!s) return res.json({ success: false, message: 'Not logged in yet.' });
    res.json({ success: true, session: s });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/set-channel', adminAuth, express.json(), async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  const ch = username.replace('@', '').trim();
  db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('adult_channel_username', ?)").run(ch);
  // Persist immediately so the channel survives a Railway restart (don't wait for the debounced backup)
  try { if (typeof db.saveNow === 'function') db.saveNow(); } catch (_) {}
  if (client && connected) {
    try { channelEntity = await client.getEntity(ch); } catch (_) {}
  }
  res.json({ success: true, channelName: ch });
  // Auto-scan entire channel after setting (background, doesn't block response)
  setTimeout(async () => {
    try {
      const cl = await getClient();
      if (!cl || !channelEntity) return;
      console.log('[TelegramAdult] Post-set-channel full scan starting…');
      const messages = await cl.getMessages(channelEntity, { limit: 100 });
      let imported = 0;
      for (const msg of messages) {
        if (importAdultVideo(msg, Number(msg.id)) === true) imported++;
      }
      if (imported > 0 && ioRef) ioRef.emit('adult_video_added', { count: imported });
      console.log('[TelegramAdult] Post-set-channel scan done:', imported, 'imported');
    } catch (_) {}
  }, 1500);
});

router.post('/send-code', adminAuth, express.json(), async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });
    if (pendingLogin.client) {
      try { await pendingLogin.client.disconnect(); } catch (_) {}
    }
    const lc = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 3, timeout: 20 });
    await lc.connect();
    const result = await lc.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId: API_ID, apiHash: API_HASH, settings: new Api.CodeSettings({})
    }));
    pendingLogin = { client: lc, phoneCodeHash: result.phoneCodeHash, phone };
    console.log('[TelegramAdult] OTP sent to', phone);
    res.json({ success: true, message: 'OTP sent to your Telegram app' });
  } catch (e) {
    console.error('[TelegramAdult] send-code error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/verify-code', adminAuth, express.json(), async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'OTP code required' });
    if (!pendingLogin.client || !pendingLogin.phoneCodeHash) {
      return res.status(400).json({ error: 'No pending login. Please send OTP first (do not refresh page between steps).' });
    }
    try {
      await pendingLogin.client.invoke(new Api.auth.SignIn({
        phoneNumber: pendingLogin.phone,
        phoneCodeHash: pendingLogin.phoneCodeHash,
        phoneCode: code
      }));
      await finishAdultLogin(pendingLogin.client);
      res.json({ success: true, message: 'Logged in successfully!' });
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        return res.json({ success: false, needs2FA: true });
      }
      throw e;
    }
  } catch (e) {
    console.error('[TelegramAdult] verify-code error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/verify-2fa', adminAuth, express.json(), async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || !pendingLogin.client) return res.status(400).json({ error: 'password required or no pending login' });
    const srp = await pendingLogin.client.invoke(new Api.account.GetPassword());
    await pendingLogin.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(srp, password) }));
    await finishAdultLogin(pendingLogin.client);
    res.json({ success: true, message: 'Logged in with 2FA!' });
  } catch (e) {
    console.error('[TelegramAdult] verify-2fa error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/logout', adminAuth, async (req, res) => {
  try {
    if (client) { try { await client.disconnect(); } catch (_) {} }
    client = null; connected = false; channelEntity = null;
    try { db.prepare("DELETE FROM admin_settings WHERE key = 'telegram_adult_session'").run(); } catch (_) {}
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/scan', adminAuth, async (req, res) => {
  try {
    const cl = await getClient();
    if (!cl || !connected) return res.status(503).json({ error: 'Not connected. Please login first.' });
    if (!channelEntity) return res.status(503).json({ error: 'Channel not set. Please set the channel username first.' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const messages = await cl.getMessages(channelEntity, { limit });
    let imported = 0; let skipped = 0; let notVideo = 0;
    for (const msg of messages) {
      const result = importAdultVideo(msg, Number(msg.id));
      if (result === true) imported++;
      else if (result === 'skipped') skipped++;
      else notVideo++;
    }
    console.log(`[TelegramAdult] Scan complete: ${imported} imported, ${skipped} already existed, ${notVideo} non-video`);
    if (ioRef && imported > 0) ioRef.emit('adult_video_added', { count: imported });
    // Verify count in DB
    const dbCount = (() => { try { return db.prepare("SELECT COUNT(*) AS c FROM adult_videos WHERE video_url LIKE '%/api/adult-telegram/stream/%'").get()?.c || 0; } catch (_) { return -1; } })();
    res.json({ success: true, imported, skipped, total: messages.length, totalInDb: dbCount });
  } catch (e) {
    console.error('[TelegramAdult] scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Streaming — original quality with HTTP Range support ──────────────────────
router.get('/stream/:messageId', async (req, res) => {
  try {
    let cl = await getClient();
    if (!cl || !connected) return res.status(503).json({ error: 'Adult channel not connected' });
    if (!channelEntity) return res.status(503).json({ error: 'Channel not configured' });

    const messageId = parseInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'Invalid message ID' });

    // Guard against a hung Telegram fetch — fail fast so the player can retry.
    const messages = await Promise.race([
      cl.getMessages(channelEntity, { ids: [messageId] }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('getMessages timeout')), 25000))
    ]);
    if (!messages || !messages[0]) return res.status(404).json({ error: 'Message not found' });

    const msg = messages[0];
    if (!msg.media || msg.media.className !== 'MessageMediaDocument')
      return res.status(400).json({ error: 'Not a video message' });

    const doc      = msg.media.document;
    const fileSize = Number(doc.size || 0);
    let mimeType   = doc.mimeType || 'video/mp4';
    let fileName   = 'video.mp4';
    for (const a of (doc.attributes || [])) {
      if (a.className === 'DocumentAttributeFilename') fileName = a.fileName || fileName;
    }

    const CHUNK = 1024 * 1024; // 1 MB (must be divisible by 4096; offset must be CHUNK-aligned)

    // Build an explicit file location — gramjs needs this (not the raw doc) to
    // open a borrowed sender to the file's DC. Passing the raw document object
    // makes iterDownload hang on cross-DC files. This mirrors the proven
    // main-channel streamer in routes/telegram.js.
    const fileLocation = new Api.InputDocumentFileLocation({
      id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: ''
    });

    // Transcode E-AC3/DDP → AAC (video copied at original quality)
    if (ffmpegPath && needsTranscode(fileName)) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4', 'Accept-Ranges': 'none',
        'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive'
      });
      const ff = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-probesize', '32768', '-analyzeduration', '500000',
        '-i', 'pipe:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', '500000', 'pipe:1'
      ]);
      ff.stdout.pipe(res);
      ff.stderr.on('data', () => {});
      res.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
      for await (const chunk of cl.iterDownload({ file: fileLocation, dcId: doc.dcId, offset: bigInt(0), requestSize: CHUNK })) {
        if (!ff.stdin.writable || res.writableEnded) break;
        ff.stdin.write(Buffer.from(chunk));
      }
      try { ff.stdin.end(); } catch (_) {}
      return;
    }

    // Direct HTTP Range streaming — zero re-encoding, original quality.
    // Offset is aligned to the 1 MB request boundary (MTProto requires the
    // download offset to be aligned and a request must not cross a 1 MB
    // boundary), and the leading delta is trimmed from the first chunk.
    const rangeHeader = req.headers['range'];

    if (rangeHeader && fileSize > 0) {
      const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
      const start = Math.max(0, parseInt(startStr, 10) || 0);
      const end   = endStr ? Math.min(parseInt(endStr, 10), fileSize - 1)
                           : Math.min(start + CHUNK - 1, fileSize - 1);
      const downloadSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes', 'Content-Length': downloadSize,
        'Content-Type': mimeType, 'Cache-Control': 'no-cache'
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const alignedOffset = Math.floor(start / CHUNK) * CHUNK;
      let needSkip   = start - alignedOffset;   // bytes to drop from the first chunk
      let downloaded = 0;
      for await (const chunk of cl.iterDownload({
        file: fileLocation, dcId: doc.dcId, offset: bigInt(alignedOffset), requestSize: CHUNK
      })) {
        if (res.destroyed || res.writableEnded) break;
        let buf = Buffer.from(chunk);
        if (needSkip > 0) { buf = buf.subarray(needSkip); needSkip = 0; }
        const remaining = downloadSize - downloaded;
        if (remaining <= 0) break;
        if (buf.length > remaining) buf = buf.subarray(0, remaining);
        res.write(buf); downloaded += buf.length;
        if (downloaded >= downloadSize) break;
      }
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize || undefined, 'Content-Type': mimeType,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache'
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      for await (const chunk of cl.iterDownload({
        file: fileLocation, dcId: doc.dcId, offset: bigInt(0), requestSize: CHUNK
      })) {
        if (res.destroyed || res.writableEnded) break;
        res.write(Buffer.from(chunk));
      }
    }
    if (!res.writableEnded) res.end();
  } catch (e) {
    console.error('[TelegramAdult] Stream error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

async function finishAdultLogin(lc) {
  const sessionStr = lc.session.save();
  try {
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('telegram_adult_session', ?)").run(sessionStr);
    // Force immediate cloud backup regardless of video count (bypass the videos < 5 threshold)
    try {
      const { initCloudinary, uploadDbBackup } = require('../config/cloudinary');
      const fs2   = require('fs');
      const path2 = require('path');
      const DB_PATH = path2.join(__dirname, '..', 'data', 'leakspro.db');
      // Write DB to disk first
      if (typeof db.saveNow === 'function') db.saveNow();
      initCloudinary();
      uploadDbBackup(DB_PATH)
        .then(() => console.log('[TelegramAdult] FORCED Cloudinary backup after session save'))
        .catch(e => console.warn('[TelegramAdult] Forced backup failed:', e.message));
    } catch (backupErr) {
      console.warn('[TelegramAdult] Backup error:', backupErr.message);
      if (typeof db.saveNow === 'function') db.saveNow();
    }
  } catch (e) {
    console.error('[TelegramAdult] Session save error:', e.message);
  }
  console.log('[TelegramAdult] Session saved. IMPORTANT: also set TELEGRAM_ADULT_SESSION env var in Railway!');
  if (client && client !== lc) { try { await client.disconnect(); } catch (_) {} }
  client = lc; connected = true;
  const ch = getChannelName();
  if (ch) {
    try { channelEntity = await lc.getEntity(ch); } catch (_) {}
  }
  pendingLogin = { client: null, phoneCodeHash: null, phone: null };
  // Auto-scan entire channel after login (background)
  setTimeout(async () => {
    try {
      if (!channelEntity) return;
      console.log('[TelegramAdult] Post-login full scan starting…');
      const messages = await lc.getMessages(channelEntity, { limit: 100 });
      let imported = 0;
      for (const msg of messages) {
        if (importAdultVideo(msg, Number(msg.id)) === true) imported++;
      }
      if (imported > 0 && ioRef) ioRef.emit('adult_video_added', { count: imported });
      console.log('[TelegramAdult] Post-login scan done:', imported, 'imported');
    } catch (_) {}
  }, 2000);
}

module.exports = router;
