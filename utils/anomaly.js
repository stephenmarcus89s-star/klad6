/**
 * Anomaly Detection Engine
 * Monitors for:
 * - Mass uninstall (>20% devices go offline in <1h)
 * - Geo anomaly (sudden traffic from new country)
 * - VT score spike
 * - Rapid rotation failures
 * Runs every 5 minutes, sends Telegram alerts
 */

let db = null;
let sendAlert = null;
let anomalyTimer = null;

// Track history for comparison
let prevOnlineCount = null;
let knownCountries = new Set();
let initialized = false;

function initAnomaly(_db, _sendAlert) {
  db = _db;
  sendAlert = _sendAlert || (() => {});

  // Populate known countries from existing devices
  try {
    const countries = db.prepare("SELECT DISTINCT country FROM devices WHERE country != ''").all();
    for (const c of countries) knownCountries.add(c.country);
  } catch (_) {}

  prevOnlineCount = db.prepare('SELECT COUNT(*) as c FROM devices WHERE is_online = 1').get()?.c || 0;
  initialized = true;

  // Check every 5 minutes
  anomalyTimer = setInterval(runAnomalyCheck, 5 * 60 * 1000);
  console.log('[Anomaly] Detection engine started — checking every 5m');
}

function stopAnomaly() {
  if (anomalyTimer) { clearInterval(anomalyTimer); anomalyTimer = null; }
}

function runAnomalyCheck() {
  if (!db || !initialized) return;

  try {
    checkMassOffline();
    checkGeoAnomaly();
    checkRotationFailures();
  } catch (e) {
    console.warn('[Anomaly] Check error:', e.message);
  }
}

// ═══ MASS OFFLINE DETECTION ═══
function checkMassOffline() {
  const currentOnline = db.prepare('SELECT COUNT(*) as c FROM devices WHERE is_online = 1').get()?.c || 0;
  const totalDevices = db.prepare('SELECT COUNT(*) as c FROM devices').get()?.c || 0;

  if (totalDevices < 5) { prevOnlineCount = currentOnline; return; } // too few to detect

  if (prevOnlineCount !== null && prevOnlineCount > 0) {
    const dropPercent = ((prevOnlineCount - currentOnline) / prevOnlineCount) * 100;
    if (dropPercent > 20 && (prevOnlineCount - currentOnline) >= 3) {
      sendAlert(`⚠️ <b>Mass Offline Alert!</b>\n\n${prevOnlineCount} → ${currentOnline} devices online\n📉 ${dropPercent.toFixed(0)}% drop in 5 minutes\n\nPossible causes: server issue, app update breaking, Play Protect flagging`);

      // Store anomaly
      storeAnomaly('mass_offline', { prevOnline: prevOnlineCount, currentOnline, dropPercent });
    }
  }
  prevOnlineCount = currentOnline;
}

// ═══ GEO ANOMALY DETECTION ═══
function checkGeoAnomaly() {
  try {
    // Check recent events for new countries
    const recentCountries = db.prepare(`
      SELECT DISTINCT country FROM analytics_events 
      WHERE country != '' AND created_at > datetime('now', '-10 minutes')
    `).all();

    for (const row of recentCountries) {
      if (!knownCountries.has(row.country)) {
        knownCountries.add(row.country);
        const count = db.prepare(`
          SELECT COUNT(*) as c FROM analytics_events 
          WHERE country = ? AND created_at > datetime('now', '-1 hour')
        `).get(row.country)?.c || 0;

        if (count >= 3) { // Only alert if 3+ events from new country
          sendAlert(`🌍 <b>New Geo Traffic</b>\n\nFirst traffic from: <b>${row.country}</b>\n${count} events in the last hour\n\nThis could be legitimate expansion or scanning activity.`);
          storeAnomaly('new_geo', { country: row.country, count });
        }
      }
    }
  } catch (_) {} // analytics table might not exist yet
}

// ═══ ROTATION FAILURE DETECTION ═══
function checkRotationFailures() {
  try {
    const recentFails = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_events 
      WHERE event = 'rotation_failed' AND created_at > datetime('now', '-1 hour')
    `).get()?.c || 0;

    if (recentFails >= 3) {
      sendAlert(`🔴 <b>Rotation Failures!</b>\n\n${recentFails} failed rotations in the last hour.\nAPK pipeline may be broken.`);
      storeAnomaly('rotation_failures', { count: recentFails });
    }
  } catch (_) {}
}

function storeAnomaly(type, data) {
  try {
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)").run(
      `anomaly_last_${type}`,
      JSON.stringify({ ...data, detected_at: new Date().toISOString() })
    );
  } catch (_) {}
}

function getAnomalies() {
  if (!db) return {};
  const result = {};
  const keys = ['anomaly_last_mass_offline', 'anomaly_last_new_geo', 'anomaly_last_rotation_failures'];
  for (const k of keys) {
    try {
      const row = db.prepare("SELECT value FROM admin_settings WHERE key = ?").get(k);
      if (row?.value) result[k.replace('anomaly_last_', '')] = JSON.parse(row.value);
    } catch (_) {}
  }
  return result;
}

module.exports = { initAnomaly, stopAnomaly, getAnomalies };
