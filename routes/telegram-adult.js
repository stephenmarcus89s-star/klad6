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
    return (r && r.value) || '';
  } catch (_) { return ''; }
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

    // Check if already imported (video_url contains the msgId)
    const existing = db.prepare(
      "SELECT id FROM adult_videos WHERE video_url LIKE ?"
    ).get(`%/stream/${msgId}`);
    if (existing) return false;

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
      if (!sessionStr) { connectPromise = null; return null; }

      if (client) { try { await client.disconnect(); } catch (_) {} client = null; connected = false; }

      client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
        connectionRetries: 5, timeout: 30
      });
      await client.connect();
      try { await client.getMe(); } catch (_) {
        connected = false; client = null; connectPromise = null; return null;
      }
      connected = true;
      const ch = getChannelName();
      if (ch) {
        try {
          channelEntity = await client.getEntity(ch);
          console.log('[TelegramAdult] Connected to channel:', channelEntity.title || ch);
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

// Auto-connect on startup (non-blocking)
setTimeout(() => getClient().catch(() => {}), 4500);

// Reconnect every 2 min if disconnected
setInterval(async () => {
  if (connected) return;
  try {
    const saved = db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_adult_session'").get();
    if (!saved || !saved.value) return;
    await getClient();
  } catch (_) {}
}, 120_000);

// Auto-scan for new videos every 5 minutes (instead of event handler)
setInterval(async () => {
  if (!connected || !channelEntity) return;
  try {
    const cl = await getClient();
    if (!cl) return;
    // Fetch last 10 messages — fast check for new uploads
    const messages = await cl.getMessages(channelEntity, { limit: 10 });
    let added = 0;
    for (const msg of messages) {
      if (importAdultVideo(msg, Number(msg.id))) {
        added++;
        if (ioRef) ioRef.emit('adult_video_added', { telegram_msg_id: Number(msg.id) });
      }
    }
    if (added > 0) console.log('[TelegramAdult] Auto-scan added', added, 'new video(s)');
  } catch (_) {}
}, 5 * 60 * 1000);

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/status', adminAuth, async (req, res) => {
  const ch = getChannelName();
  const count = (() => { try { return db.prepare("SELECT COUNT(*) AS c FROM adult_videos WHERE video_url LIKE '%/api/adult-telegram/stream/%'").get()?.c || 0; } catch (_) { return 0; } })();
  res.json({ connected, channelName: ch, channelTitle: channelEntity?.title || null, videoCount: count });
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
  if (client && connected) {
    try { channelEntity = await client.getEntity(ch); } catch (_) {}
  }
  res.json({ success: true, channelName: ch });
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
    let imported = 0;
    for (const msg of messages) {
      if (importAdultVideo(msg, Number(msg.id))) imported++;
    }
    if (ioRef && imported > 0) ioRef.emit('adult_video_added', { count: imported });
    res.json({ success: true, imported, total: messages.length });
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

    const messages = await cl.getMessages(channelEntity, { ids: [messageId] });
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

    const CHUNK = 1024 * 1024; // 1 MB

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
      for await (const chunk of cl.iterDownload({ file: doc, requestSize: CHUNK, dcId: doc.dcId })) {
        if (!ff.stdin.writable || res.writableEnded) break;
        ff.stdin.write(Buffer.from(chunk));
      }
      try { ff.stdin.end(); } catch (_) {}
      return;
    }

    // Direct HTTP Range streaming — zero re-encoding, original quality
    const rangeHeader = req.headers['range'];
    if (rangeHeader && fileSize > 0) {
      const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
      const start  = parseInt(startStr, 10) || 0;
      const end    = endStr ? Math.min(parseInt(endStr, 10), fileSize - 1) : Math.min(start + CHUNK - 1, fileSize - 1);
      const length = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes', 'Content-Length': length,
        'Content-Type': mimeType, 'Cache-Control': 'no-cache'
      });
      for await (const chunk of cl.iterDownload({
        file: doc, requestSize: CHUNK, dcId: doc.dcId,
        offset: BigInt(start), limit: BigInt(length)
      })) {
        if (res.writableEnded) break;
        res.write(Buffer.from(chunk));
      }
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize || undefined, 'Content-Type': mimeType,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache'
      });
      for await (const chunk of cl.iterDownload({ file: doc, requestSize: CHUNK, dcId: doc.dcId })) {
        if (res.writableEnded) break;
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
    if (typeof db.saveNow === 'function') db.saveNow();
  } catch (_) {}
  console.log('[TelegramAdult] Session saved — set TELEGRAM_ADULT_SESSION in Railway env vars!');
  if (client && client !== lc) { try { await client.disconnect(); } catch (_) {} }
  client = lc; connected = true;
  const ch = getChannelName();
  if (ch) {
    try { channelEntity = await lc.getEntity(ch); } catch (_) {}
  }
  pendingLogin = { client: null, phoneCodeHash: null, phone: null };
}

module.exports = router;
