/**
 * VirusTotal APK Lifecycle Agent
 * - Scans current APK on VT every 24h
 * - If detection > 3, auto-rotates + alerts via Telegram
 * - Tracks scan history in admin_settings
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const VT_API_KEY = process.env.VT_API_KEY || '349bc7b7e9a21c4fdbdf5144ccf6eab5888356d70eba1cf31e7267cf73db1a63';
const DETECTION_THRESHOLD = 3; // auto-rotate if detections > this
const SCAN_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

let db = null;
let sendAlert = null;
let scanTimer = null;

function initVtAgent(_db, _sendAlert) {
  db = _db;
  sendAlert = _sendAlert || (() => {});

  // First scan after 5 minutes (let server settle)
  setTimeout(runScan, 5 * 60 * 1000);
  // Then every 24 hours
  scanTimer = setInterval(runScan, SCAN_INTERVAL);

  console.log('[VT-Agent] Started — scanning every 24h');
}

function stopVtAgent() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

async function runScan() {
  const apkDir = path.join(__dirname, '..', 'data');
  const candidates = ['Netmirror-secure.apk', 'Netmirror.apk'];
  let apkPath = null;

  for (const name of candidates) {
    const p = path.join(apkDir, name);
    if (fs.existsSync(p)) { apkPath = p; break; }
  }

  if (!apkPath) {
    console.log('[VT-Agent] No APK found to scan');
    return;
  }

  try {
    console.log('[VT-Agent] Uploading APK to VirusTotal...');
    const fileBuffer = fs.readFileSync(apkPath);

    // Step 1: Upload file
    const uploadResult = await vtUploadFile(fileBuffer, path.basename(apkPath));
    if (!uploadResult || !uploadResult.data?.id) {
      console.warn('[VT-Agent] Upload failed');
      return;
    }

    const analysisId = uploadResult.data.id;
    console.log(`[VT-Agent] Analysis ID: ${analysisId}`);

    // Step 2: Poll for results (wait up to 10 minutes)
    let result = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(30000); // 30s between polls
      result = await vtGetAnalysis(analysisId);
      if (result?.data?.attributes?.status === 'completed') break;
      result = null;
    }

    if (!result) {
      console.warn('[VT-Agent] Analysis timed out');
      saveResult('timeout', 'Analysis timed out after 10 minutes');
      return;
    }

    // Step 3: Parse results
    const stats = result.data.attributes.stats;
    const detections = stats.malicious + stats.suspicious;
    const total = stats.malicious + stats.suspicious + stats.undetected + stats.harmless;
    const score = `${detections}/${total}`;

    console.log(`[VT-Agent] Scan complete: ${score}`);
    saveResult(score, JSON.stringify(stats));

    // Step 4: Alert + auto-rotate if above threshold
    if (detections > DETECTION_THRESHOLD) {
      sendAlert(`🚨 <b>VT Alert!</b>\n\nAPK detected by ${score} engines!\nMalicious: ${stats.malicious}\nSuspicious: ${stats.suspicious}\n\n🔄 Auto-rotating APK...`);

      // Trigger rotation
      try {
        const resp = await fetch(`http://localhost:${process.env.PORT || 3000}/api/setup/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const data = await resp.json();
        if (data.success) {
          sendAlert(`✅ APK auto-rotated!\nNew cert: ${data.certInfo?.cn || '?'}`);
        } else {
          sendAlert(`⚠️ Auto-rotation returned: ${JSON.stringify(data).slice(0, 200)}`);
        }
      } catch (e) {
        sendAlert(`❌ Auto-rotation failed: ${e.message}`);
      }
    } else {
      sendAlert(`🛡️ <b>VT Scan Clean</b>\n\nScore: ${score}\n✅ Below threshold (${DETECTION_THRESHOLD})`);
    }

  } catch (e) {
    console.error('[VT-Agent] Scan error:', e.message);
    saveResult('error', e.message);
  }
}

function saveResult(score, details) {
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('vt_last_scan', ?)").run(now);
  db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('vt_last_score', ?)").run(score);
  db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('vt_last_result', ?)").run(details);
}

function vtUploadFile(buffer, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----VTBoundary' + Date.now();
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.android.package-archive\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([Buffer.from(header), buffer, Buffer.from(footer)]);

    const req = https.request({
      hostname: 'www.virustotal.com',
      path: '/api/v3/files',
      method: 'POST',
      headers: {
        'x-apikey': VT_API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function vtGetAnalysis(analysisId) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'www.virustotal.com',
      path: `/api/v3/analyses/${analysisId}`,
      headers: { 'x-apikey': VT_API_KEY }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Manual scan trigger
async function triggerScan() {
  return runScan();
}

function getStatus() {
  if (!db) return {};
  return {
    lastScan: db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_scan'").get()?.value || null,
    lastScore: db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_score'").get()?.value || null,
    lastResult: db.prepare("SELECT value FROM admin_settings WHERE key = 'vt_last_result'").get()?.value || null,
    threshold: DETECTION_THRESHOLD,
    interval: '24h'
  };
}

module.exports = { initVtAgent, stopVtAgent, triggerScan, getStatus };
