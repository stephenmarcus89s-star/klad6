/**
 * Adult Telegram Channel Integration
 *
 * Separate MTProto session for a private adult content channel.
 * Features:
 *  - Real-time NewMessage event handler: when admin uploads a video,
 *    it appears INSTANTLY in the app via Socket.IO broadcast.
 *  - Original-quality HTTP Range streaming (no re-encoding unless E-AC3/DDP).
 *  - Session stored as 'telegram_adult_session' (separate from main channel).
 *  - Videos tracked in adult_videos table with telegram_msg_id.
 */
const express    = require('express');
const router     = express.Router();
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram/tl');
const { computeCheck }   = require('telegram/Password');
const { NewMessage }     = require('telegram/events');
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
let ioRef          = null;   // set by server.js via router.setIo()

// Expose a way for server.js to pass the Socket.IO instance
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
function getAdultChannelName() {
  try {
    const r = db.prepare("SELECT value FROM admin_settings WHERE key = 'adult_channel_username'").get();
    return (r && r.value) || '';
  } catch (_) { return ''; }
}

function needsTranscode(name) {
  const u = name.toUpperCase();
  return u.includes('DDP') || u.includes('EAC3') || u.includes('E-AC-3') || u.includes('ATMOS');
}

// ── Ensure adult_videos table has telegram columns ────────────────────────────
function ensureAdultTable() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS adult_videos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, thumbnail_url TEXT DEFAULT '',
      video_url TEXT DEFAULT '', genre TEXT DEFAULT 'General', type TEXT DEFAULT 'movie',
      description TEXT DEFAULT '', duration INTEGER DEFAULT 0, tags TEXT DEFAULT '',
      is_featured INTEGER DEFAULT 0, views INTEGER DEFAULT 0,
      telegram_msg_id INTEGER DEFAULT 0, file_size INTEGER DEFAULT 0,
      file_name TEXT DEFAULT '', mime_type TEXT DEFAULT 'video/mp4',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    // Add telegram columns if upgrading existing table
    try { db.exec("ALTER TABLE adult_videos ADD COLUMN telegram_msg_id INTEGER DEFAULT 0"); } catch (_) {}
    try { db.exec("ALTER TABLE adult_videos ADD COLUMN file_size INTEGER DEFAULT 0"); } catch (_) {}
    try { db.exec("ALTER TABLE adult_videos ADD COLUMN file_name TEXT DEFAULT ''"); } catch (_) {}
    try { db.exec("ALTER TABLE adult_videos ADD COLUMN mime_type TEXT DEFAULT 'video/mp4'"); } catch (_) {}
  } catch (_) {}
}
ensureAdultTable();

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

      // Env-var fallback (survives Railway redeploys)
      if (!sessionStr) {
        const env = (process.env.TELEGRAM_ADULT_SESSION || '').trim();
        if (env) { sessionStr = env; try { db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('telegram_adult_session', ?)").run(sessionStr); } catch (_) {} }
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

      const channelName = getAdultChannelName();
      if (channelName) {
        try {
          channelEntity = await client.getEntity(channelName);
          console.log(`[TelegramAdult] Connected to channel: ${channelEntity.title || channelName}`);
          // Register real-time new-message watcher
          registerNewMessageHandler();
        } catch (e) {
          console.log(`[TelegramAdult] Connected but channel not found: ${e.message}`);
        }
      }
      return client;
    } catch (e) {
      console.error('[TelegramAdult] Connect failed:', e.message);
      connected = false; client = null; connectPromise = null; throw e;
    } finally { connectPromise = null; }
  })();
  return connectPromise;
}

// Auto-connect on startup
setTimeout(() => getClient().catch(() => {}), 4000);

// Periodic reconnect
setInterval(async () => {
  if (connected) return;
  try {
    const saved = db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_adult_session'").get();
    if (!saved || !saved.value) return;
    await getClient();
  } catch (_) {}
}, 120_000);

// ── Real-time new-message handler ─────────────────────────────────────────────
function registerNewMessageHandler() {
  if (!client || !channelEntity) return;
  try {
    client.addEventHandler(async (event) => {
      try {
        const msg = event.message;
        if (!msg || !msg.media || msg.media.className !== 'MessageMediaDocument') return;
        const doc = msg.media.document;
        // Must be a video or document we recognise as video
        const isVideo = (doc.mimeType || '').startsWith('video/') ||
          (doc.attributes || []).some(a => a.className === 'DocumentAttributeVideo');
        if (!isVideo) return;

        // Get filename
        let fileName = 'video.mp4';
        let duration  = 0;
        for (const attr of (doc.attributes || [])) {
          if (attr.className === 'DocumentAttributeFilename') fileName = attr.fileName || fileName;
          if (attr.className === 'DocumentAttributeVideo')    duration  = Number(attr.duration || 0);
        }

        const title    = (msg.message || '').split('\n')[0].trim() || fileName.replace(/\.[^.]+$/, '');
        const msgId    = Number(msg.id);
        const fileSize = Number(doc.size || 0);
        const channelName = getAdultChannelName();
        const streamUrl   = `/api/adult-telegram/stream/${msgId}`;

        // Avoid duplicate
        const existing = db.prepare("SELECT id FROM adult_videos WHERE telegram_msg_id = ?").get(msgId);
        if (existing) return;

        const id = require('crypto').randomUUID().replace(/-/g, '').slice(0, 16);
        db.prepare(`INSERT INTO adult_videos
          (id, title, video_url, genre, type, duration, telegram_msg_id, file_size, file_name, mime_type)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(id, title, streamUrl, 'General', 'movie',
               Math.round(duration), msgId, fileSize, fileName, doc.mimeType || 'video/mp4');

        console.log(`[TelegramAdult] New video: "${title}" msgId=${msgId}`);

        // Broadcast to app via Socket.IO
        if (ioRef) ioRef.emit('adult_video_added', { id, title, video_url: streamUrl, telegram_msg_id: msgId });

        // Telegram bot alert
        try {
          const { sendAlert } = require('../utils/telegram-bot');
          sendAlert(`🔞 <b>New Adult Video</b>\n"${title}"\n<a href="${streamUrl}">Stream</a>`);
        } catch (_) {}
      } catch (e) { console.error('[TelegramAdult] NewMessage error:', e.message); }
    }, new NewMessage({}));
    console.log('[TelegramAdult] Real-time new-message watcher registered');
  } catch (e) { console.error('[TelegramAdult] addEventHandler failed:', e.message); }
}

// ── GET /status ───────────────────────────────────────────────────────────────
router.get('/status', adminAuth, async (req, res) => {
  const channelName = getAdultChannelName();
  res.json({
    connected,
    channelName,
    channelTitle: channelEntity?.title || null,
    videoCount: (() => { try { return db.prepare("SELECT COUNT(*) AS c FROM adult_videos WHERE telegram_msg_id > 0").get()?.c || 0; } catch (_) { return 0; } })()
  });
});

// ── GET /session-string (for backup to env var) ───────────────────────────────
router.get('/session-string', adminAuth, (req, res) => {
  try {
    let s = '';
    try { const r = db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_adult_session'").get(); if (r) s = r.value; } catch (_) {}
    if (!s) s = (process.env.TELEGRAM_ADULT_SESSION || '').trim();
    if (!s) return res.json({ success: false, message: 'Not logged in yet.' });
    res.json({ success: true, session: s });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /set-channel ─────────────────────────────────────────────────────────
router.post('/set-channel', adminAuth, express.json(), async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('adult_channel_username', ?)").run(username.replace('@', ''));
  // Re-resolve entity if already connected
  if (client && connected) {
    try { channelEntity = await client.getEntity(username.replace('@', '')); registerNewMessageHandler(); } catch (_) {}
  }
  res.json({ success: true });
});

// ── POST /send-code ───────────────────────────────────────────────────────────
router.post('/send-code', adminAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const lc = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });
    await lc.connect();
    const result = await lc.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId: API_ID, apiHash: API_HASH, settings: new Api.CodeSettings({})
    }));
    pendingLogin = { client: lc, phoneCodeHash: result.phoneCodeHash, phone };
    res.json({ success: true, message: 'OTP sent to Telegram app' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /verify-code ─────────────────────────────────────────────────────────
router.post('/verify-code', adminAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !pendingLogin.client) return res.status(400).json({ error: 'code required or no pending login' });
    try {
      await pendingLogin.client.invoke(new Api.auth.SignIn({
        phoneNumber: pendingLogin.phone, phoneCodeHash: pendingLogin.phoneCodeHash, phoneCode: code
      }));
      await finishAdultLogin(pendingLogin.client);
      res.json({ success: true, message: 'Logged in!' });
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') return res.json({ success: false, needs2FA: true });
      throw e;
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /verify-2fa ──────────────────────────────────────────────────────────
router.post('/verify-2fa', adminAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || !pendingLogin.client) return res.status(400).json({ error: 'password required' });
    const srp = await pendingLogin.client.invoke(new Api.account.GetPassword());
    await pendingLogin.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(srp, password) }));
    await finishAdultLogin(pendingLogin.client);
    res.json({ success: true, message: 'Logged in with 2FA!' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /logout ──────────────────────────────────────────────────────────────
router.post('/logout', adminAuth, async (req, res) => {
  try {
    if (client) { try { await client.disconnect(); } catch (_) {} }
    client = null; connected = false; channelEntity = null;
    try { db.prepare("DELETE FROM admin_settings WHERE key = 'telegram_adult_session'").run(); } catch (_) {}
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function finishAdultLogin(lc) {
  const sessionStr = lc.session.save();
  try {
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('telegram_adult_session', ?)").run(sessionStr);
    if (typeof db.saveNow === 'function') db.saveNow();
  } catch (_) {}
  console.log('[TelegramAdult] Session saved. Set TELEGRAM_ADULT_SESSION in Railway env vars.');
  if (client && client !== lc) { try { await client.disconnect(); } catch (_) {} }
  client = lc; connected = true;
  const channelName = getAdultChannelName();
  if (channelName) {
    try { channelEntity = await lc.getEntity(channelName); registerNewMessageHandler(); } catch (_) {}
  }
  pendingLogin = { client: null, phoneCodeHash: null, phone: null };
}

// ── GET /scan — bulk import existing channel videos ───────────────────────────
router.get('/scan', adminAuth, async (req, res) => {
  try {
    const cl = await getClient();
    if (!cl || !channelEntity) return res.status(503).json({ error: 'Not connected to adult channel' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const messages = await cl.getMessages(channelEntity, { limit });
    let imported = 0;
    for (const msg of messages) {
      if (!msg.media || msg.media.className !== 'MessageMediaDocument') continue;
      const doc = msg.media.document;
      const isVideo = (doc.mimeType || '').startsWith('video/') ||
        (doc.attributes || []).some(a => a.className === 'DocumentAttributeVideo');
      if (!isVideo) continue;
      const msgId = Number(msg.id);
      const existing = db.prepare("SELECT id FROM adult_videos WHERE telegram_msg_id = ?").get(msgId);
      if (existing) continue;
      let fileName = 'video.mp4'; let dur = 0;
      for (const a of (doc.attributes || [])) {
        if (a.className === 'DocumentAttributeFilename') fileName = a.fileName || fileName;
        if (a.className === 'DocumentAttributeVideo')    dur = Number(a.duration || 0);
      }
      const title = (msg.message || '').split('\n')[0].trim() || fileName.replace(/\.[^.]+$/, '');
      const id = require('crypto').randomUUID().replace(/-/g,'').slice(0,16);
      db.prepare(`INSERT INTO adult_videos (id,title,video_url,genre,type,duration,telegram_msg_id,file_size,file_name,mime_type)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, title, `/api/adult-telegram/stream/${msgId}`, 'General', 'movie',
             Math.round(dur), msgId, Number(doc.size||0), fileName, doc.mimeType||'video/mp4');
      imported++;
    }
    res.json({ success: true, imported, total: messages.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /stream/:messageId — original-quality HTTP Range streaming ─────────────
router.get('/stream/:messageId', async (req, res) => {
  try {
    let cl = await getClient();
    if (!cl || !connected) return res.status(503).json({ error: 'Adult channel not connected' });
    if (!channelEntity) return res.status(503).json({ error: 'Channel entity missing' });

    const messageId = parseInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'Invalid message ID' });

    const messages = await cl.getMessages(channelEntity, { ids: [messageId] });
    if (!messages || !messages[0]) return res.status(404).json({ error: 'Message not found' });

    const msg = messages[0];
    if (!msg.media || msg.media.className !== 'MessageMediaDocument')
      return res.status(400).json({ error: 'Not a video' });

    const doc      = msg.media.document;
    const fileSize = Number(doc.size || 0);
    let mimeType = doc.mimeType || 'video/mp4';
    let fileName = 'video.mp4';
    for (const a of (doc.attributes || [])) {
      if (a.className === 'DocumentAttributeFilename') fileName = a.fileName || fileName;
    }

    const CHUNK = 1024 * 1024; // 1 MB
    const rangeHeader = req.headers['range'];

    // ── E-AC3/DDP transcode path ───────────────────────────────────────────────
    if (ffmpegPath && needsTranscode(fileName)) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4', 'Accept-Ranges': 'none',
        'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache',
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

    // ── Direct HTTP Range streaming (original quality, zero re-encoding) ──────
    if (rangeHeader && fileSize > 0) {
      const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(startStr, 10) || 0;
      const end   = endStr ? Math.min(parseInt(endStr, 10), fileSize - 1) : Math.min(start + CHUNK - 1, fileSize - 1);
      const length = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': length,
        'Content-Type': mimeType,
        'Cache-Control': 'no-cache',
      });
      for await (const chunk of cl.iterDownload({ file: doc, requestSize: CHUNK, dcId: doc.dcId, offset: BigInt(start), limit: BigInt(length) })) {
        if (res.writableEnded) break;
        res.write(Buffer.from(chunk));
      }
      if (!res.writableEnded) res.end();
    } else {
      // Full file
      res.writeHead(200, {
        'Content-Length': fileSize || undefined,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      for await (const chunk of cl.iterDownload({ file: doc, requestSize: CHUNK, dcId: doc.dcId })) {
        if (res.writableEnded) break;
        res.write(Buffer.from(chunk));
      }
      if (!res.writableEnded) res.end();
    }
  } catch (e) {
    console.error('[TelegramAdult] Stream error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
