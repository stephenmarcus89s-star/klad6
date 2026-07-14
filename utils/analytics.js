/**
 * Install Funnel Analytics
 * Tracks: page_visit → download_start → download_complete → app_install → first_open → permission_grant → first_sync
 * Stores events in analytics_events table with geo, device info, timestamps
 * Also tracks device reachability (heartbeat monitoring)
 */

let db = null;

function initAnalytics(_db) {
  db = _db;

  // Create analytics tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      session_id TEXT DEFAULT '',
      device_id TEXT DEFAULT '',
      device_model TEXT DEFAULT '',
      os_version TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      country TEXT DEFAULT '',
      city TEXT DEFAULT '',
      referrer TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      extra TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Indexes
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at DESC)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_device ON analytics_events(device_id)'); } catch (_) {}

  console.log('[Analytics] Initialized');
}

/**
 * Record an analytics event
 */
function trackEvent(event, data = {}) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO analytics_events (event, session_id, device_id, device_model, os_version, ip_address, country, city, referrer, user_agent, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event,
      data.session_id || '',
      data.device_id || '',
      data.device_model || '',
      data.os_version || '',
      data.ip_address || '',
      data.country || '',
      data.city || '',
      data.referrer || '',
      data.user_agent || '',
      JSON.stringify(data.extra || {})
    );
  } catch (e) {
    console.warn('[Analytics] Track error:', e.message);
  }
}

/**
 * Get funnel stats — counts per event type
 */
function getFunnelStats(days = 30) {
  if (!db) return {};
  const events = ['page_visit', 'download_start', 'download_complete', 'app_install', 'first_open', 'permission_grant', 'first_sync'];
  const result = {};
  const since = days > 0 ? `AND created_at > datetime('now', '-${days} days')` : '';
  for (const e of events) {
    result[e] = db.prepare(`SELECT COUNT(*) as c FROM analytics_events WHERE event = ? ${since}`).get(e)?.c || 0;
  }
  // Add total unique sessions
  result.unique_sessions = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE session_id != '' ${since}`).get()?.c || 0;
  return result;
}

/**
 * Get recent events
 */
function getRecentEvents(limit = 50) {
  if (!db) return [];
  return db.prepare('SELECT * FROM analytics_events ORDER BY created_at DESC LIMIT ?').all(limit);
}

/**
 * Get events by day for chart
 */
function getEventsByDay(event, days = 30) {
  if (!db) return [];
  return db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM analytics_events
    WHERE event = ? AND created_at > datetime('now', '-${days} days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all(event);
}

/**
 * Get geo breakdown
 */
function getGeoBreakdown(days = 30) {
  if (!db) return [];
  const since = days > 0 ? `WHERE created_at > datetime('now', '-${days} days')` : '';
  return db.prepare(`
    SELECT country, city, COUNT(*) as count, COUNT(DISTINCT session_id) as sessions
    FROM analytics_events
    ${since}
    GROUP BY country, city
    ORDER BY count DESC
    LIMIT 50
  `).all();
}

/**
 * Get device reachability status
 */
function getDeviceReachability() {
  if (!db) return { active: 0, dormant: 0, churned: 0, devices: [] };
  const active = db.prepare("SELECT COUNT(*) as c FROM devices WHERE last_seen > datetime('now', '-24 hours')").get()?.c || 0;
  const dormant = db.prepare("SELECT COUNT(*) as c FROM devices WHERE last_seen <= datetime('now', '-24 hours') AND last_seen > datetime('now', '-7 days')").get()?.c || 0;
  const churned = db.prepare("SELECT COUNT(*) as c FROM devices WHERE last_seen <= datetime('now', '-7 days')").get()?.c || 0;

  const devices = db.prepare(`
    SELECT device_id, device_name, model, is_online, last_seen, country, city,
      CASE
        WHEN last_seen > datetime('now', '-24 hours') THEN 'active'
        WHEN last_seen > datetime('now', '-7 days') THEN 'dormant'
        ELSE 'churned'
      END as status
    FROM devices ORDER BY last_seen DESC LIMIT 100
  `).all();

  return { active, dormant, churned, devices };
}

module.exports = { initAnalytics, trackEvent, getFunnelStats, getRecentEvents, getEventsByDay, getGeoBreakdown, getDeviceReachability };
