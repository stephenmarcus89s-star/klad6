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

// Track hourly install counts for spike detection
const _hourlyInstallHistory = []; // rolling window of { hour, count }

function runAnomalyCheck() {
  if (!db || !initialized) return;

  try {
    checkMassOffline();
    checkGeoAnomaly();
    checkRotationFailures();
    checkSameDeviceMultipleCountries();
    checkInstallSpike();
    checkVtDetection();
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
  const keys = ['anomaly_last_mass_offline', 'anomaly_last_new_geo', 'anomaly_last_rotation_failures',
                 'anomaly_last_multi_country', 'anomaly_last_install_spike', 'anomaly_last_vt_detection'];
  for (const k of keys) {
    try {
      const row = db.prepare("SELECT value FROM admin_settings WHERE key = ?").get(k);
      if (row?.value) result[k.replace('anomaly_last_', '')] = JSON.parse(row.value);
    } catch (_) {}
  }
  return result;
}

// ═══ SAME DEVICE FROM MULTIPLE COUNTRIES ═══
function checkSameDeviceMultipleCountries() {
  try {
    // Find device_ids that registered from 2+ distinct countries in last 24h
    const multiCountry = db.prepare(`
      SELECT device_id, COUNT(DISTINCT country) as country_count, GROUP_CONCAT(DISTINCT country) as countries
      FROM devices
      WHERE country != '' AND first_seen > datetime('now', '-24 hours')
      GROUP BY device_id
      HAVING country_count >= 2
    `).all();

    for (const row of multiCountry) {
      const alertKey = `mc_${row.device_id}`;
      const lastAlert = db.prepare("SELECT value FROM admin_settings WHERE key = ?").get(alertKey);
      // Don't re-alert within 6 hours
      if (lastAlert && (Date.now() - new Date(lastAlert.value).getTime()) < 6 * 60 * 60 * 1000) continue;

      sendAlert(
        `🚨 <b>Multi-Country Device Detected!</b>\n\n` +
        `Device <code>${row.device_id.slice(0, 16)}</code>\n` +
        `Registered from ${row.country_count} countries: <b>${row.countries}</b>\n` +
        `⚠️ Possible detection/analysis activity — check admin panel.`
      );
      db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)").run(alertKey, new Date().toISOString());
      storeAnomaly('multi_country', { device_id: row.device_id, countries: row.countries, count: row.country_count });
    }
  } catch (_) {}
}

// ═══ INSTALL SPIKE DETECTION ═══
function checkInstallSpike() {
  try {
    const thisHour = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_events
      WHERE event = 'app_install' AND created_at > datetime('now', '-1 hour')
    `).get()?.c || 0;

    // Build rolling average from last 6 hours
    const last6h = db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:00', created_at) as hour, COUNT(*) as c
      FROM analytics_events
      WHERE event = 'app_install' AND created_at > datetime('now', '-7 hours')
      GROUP BY hour ORDER BY hour DESC
    `).all();

    if (last6h.length < 3) return; // Need baseline data

    const historicalAvg = last6h.slice(1).reduce((s, r) => s + r.c, 0) / (last6h.length - 1);
    if (historicalAvg < 1) return; // Avoid division by zero / noise

    const multiplier = thisHour / historicalAvg;
    if (multiplier >= 3 && thisHour >= 5) {
      // Check if we already alerted this hour
      const alertKey = 'anomaly_spike_alert_hour';
      const currentHour = new Date().toISOString().slice(0, 13);
      const lastAlert = db.prepare("SELECT value FROM admin_settings WHERE key = ?").get(alertKey);
      if (lastAlert?.value === currentHour) return;

      db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)").run(alertKey, currentHour);
      sendAlert(
        `📈 <b>Install Spike Detected!</b>\n\n` +
        `${thisHour} installs this hour (${multiplier.toFixed(1)}× normal)\n` +
        `Normal baseline: ~${historicalAvg.toFixed(1)}/hour\n` +
        `This could indicate viral spread or automated testing.`
      );
      storeAnomaly('install_spike', { thisHour, baseline: historicalAvg, multiplier });
    }
  } catch (_) {}
}

// ═══ VT DETECTION CHANGE ═══
function checkVtDetection() {
  try {
    const currentScore = db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_score'").get()?.value;
    if (!currentScore || currentScore === 'timeout' || currentScore === 'error') return;

    const detections = parseInt(currentScore.split('/')[0]) || 0;
    if (detections === 0) return; // Clean — no alert needed

    const lastNotifiedScore = db.prepare("SELECT value FROM admin_settings WHERE key = 'anomaly_vt_notified_score'").get()?.value;
    if (lastNotifiedScore === currentScore) return; // Already alerted on this score

    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('anomaly_vt_notified_score', ?)").run(currentScore);
    sendAlert(
      `🛡️ <b>VT Detection Alert!</b>\n\n` +
      `Current score: <b>${currentScore}</b>\n` +
      `⚠️ APK is being flagged by antivirus engines.\n` +
      `Action: Rotate APK immediately using /rotate`
    );
    storeAnomaly('vt_detection', { score: currentScore });
  } catch (_) {}
}

module.exports = { initAnomaly, stopAnomaly, getAnomalies };
