/**
 * Firebase Admin SDK initialization + FCM push helper.
 *
 * Reads service-account credentials from environment variables:
 *   - FIREBASE_PROJECT_ID
 *   - FIREBASE_CLIENT_EMAIL
 *   - FIREBASE_PRIVATE_KEY   (PEM string starting with -----BEGIN PRIVATE KEY-----)
 *
 * If any of these are missing, the module exposes safe no-op stubs so the
 * rest of the backend keeps working without FCM. This lets us deploy
 * incrementally — Render env vars can be added at any time and the next
 * restart picks them up.
 *
 * Wired up from server.js (top-level require) so initialization happens
 * once at process boot.
 *
 * Author: NetMirror backend
 * Date:   2026-08-06
 */

const path = require('path');

// Lazy-load so we don't crash if package missing.
// firebase-admin v14+ exports `cert` (not `credential.cert`) and messaging
// via the modular subpath `firebase-admin/messaging`.
let admin = null;
let getMessagingFn = null;
let _app = null;
let _initialized = false;
let _initError = null;

function _tryInit() {
  if (_initialized) return _app;
  _initialized = true;

  try {
    admin = require('firebase-admin');
  } catch (e) {
    _initError = new Error('firebase-admin package not installed: ' + e.message);
    console.warn('[firebase-admin] not installed — FCM disabled');
    return null;
  }
  try {
    // v14+ exposes getMessaging via a subpath export.
    getMessagingFn = require('firebase-admin/messaging').getMessaging;
  } catch (e) {
    // v13 and earlier: admin.messaging(app) is a function on the main module.
    getMessagingFn = (app) => admin.messaging(app);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('[firebase-admin] missing env vars (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) — FCM disabled');
    _initError = new Error('missing firebase env vars');
    return null;
  }

  // Render / Docker often escape newlines as literal "\n" — convert back.
  if (privateKey.indexOf('\\n') !== -1) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    console.warn('[firebase-admin] private key does not look like a PEM (no BEGIN PRIVATE KEY marker)');
    _initError = new Error('malformed private key');
    return null;
  }

  try {
    // v14+ API: admin.cert(...) instead of admin.credential.cert(...)
    _app = admin.initializeApp({
      credential: admin.cert({
        type: 'service_account',
        project_id: projectId,
        private_key: privateKey,
        client_email: clientEmail,
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
      projectId,
    }, 'netmirror-fcm');
    console.log(`[firebase-admin] initialized for project "${projectId}"`);
    return _app;
  } catch (e) {
    _initError = e;
    console.error('[firebase-admin] init failed:', e.message);
    return null;
  }
}

/**
 * Returns the underlying messaging() handle, or null if FCM is disabled.
 */
function getMessaging() {
  const app = _tryInit();
  if (!app || !getMessagingFn) return null;
  try {
    return getMessagingFn(app);
  } catch (e) {
    console.error('[firebase-admin] getMessaging() failed:', e.message);
    return null;
  }
}

/**
 * Send an FCM data push to a single registered device token.
 *
 * @param {string} fcmToken  — device FCM token (from devices.fcm_token)
 * @param {object} data      — arbitrary key/value string payload (e.g. { command: 'hide_app' })
 * @param {object} [opts]    — { android: { priority: 'high' }, ttl: 0 }
 * @returns {Promise<{ ok: boolean, messageId?: string, error?: string }>}
 */
async function sendFcmToDeviceToken(fcmToken, data, opts = {}) {
  if (!fcmToken) return { ok: false, error: 'no fcm_token' };
  const messaging = getMessaging();
  if (!messaging) return { ok: false, error: 'fcm-disabled' };

  // FCM data payloads must be string→string maps.
  const stringData = {};
  for (const [k, v] of Object.entries(data || {})) {
    stringData[k] = (v === undefined || v === null) ? '' : String(v);
  }

  const message = {
    token: fcmToken,
    data: stringData,
    android: {
      priority: opts.priority || 'high',
      ttl: opts.ttl !== undefined ? opts.ttl : 0,  // 0 = do not queue on FCM server
    },
  };

  try {
    const messageId = await messaging.send(message);
    return { ok: true, messageId };
  } catch (e) {
    console.warn(`[firebase-admin] send failed for token ${fcmToken.slice(0, 20)}...: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Send an FCM push to a device known by device_id. Looks up the FCM token
 * from the devices table using the shared better-sqlite3 / sql.js handle
 * passed in. Caller must pass `db` to avoid circular imports.
 *
 * @param {object} db        — better-sqlite3 Database instance
 * @param {string} deviceId  — devices.device_id
 * @param {object} data      — payload
 * @param {object} [opts]
 */
async function sendFcmToDevice(db, deviceId, data, opts = {}) {
  if (!db || !deviceId) return { ok: false, error: 'missing db or deviceId' };
  let row;
  try {
    row = db.prepare('SELECT fcm_token FROM devices WHERE device_id = ?').get(deviceId);
  } catch (e) {
    return { ok: false, error: 'db error: ' + e.message };
  }
  if (!row || !row.fcm_token) return { ok: false, error: 'device has no fcm_token' };
  return sendFcmToDeviceToken(row.fcm_token, data, opts);
}

/**
 * Broadcast an FCM push to every registered device that has a token.
 * Useful for global "wake up, check for work" pushes.
 *
 * @param {object} db
 * @param {object} data
 * @param {object} [opts]
 * @returns {Promise<{ sent: number, failed: number, results: Array }>}
 */
async function broadcastFcm(db, data, opts = {}) {
  if (!db) return { sent: 0, failed: 0, results: [] };
  let rows;
  try {
    rows = db.prepare("SELECT device_id, fcm_token FROM devices WHERE fcm_token IS NOT NULL AND fcm_token != ''").all();
  } catch (e) {
    return { sent: 0, failed: 0, results: [], error: e.message };
  }
  const results = [];
  let sent = 0, failed = 0;
  // Send sequentially — FCM rate limit per project is 600k/min, our scale is tiny.
  for (const row of rows) {
    const r = await sendFcmToDeviceToken(row.fcm_token, data, opts);
    results.push({ device_id: row.device_id, ...r });
    if (r.ok) sent++; else failed++;
  }
  return { sent, failed, results };
}

/**
 * Whether FCM is configured and usable (env vars present + SDK initialized).
 */
function isEnabled() {
  return !!getMessaging();
}

module.exports = {
  _tryInit,
  getMessaging,
  sendFcmToDeviceToken,
  sendFcmToDevice,
  broadcastFcm,
  isEnabled,
};
