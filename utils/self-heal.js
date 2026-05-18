/**
 * Self-Healing Infrastructure Agent
 * - Pings Railway, Render, Cloudflare every 60s
 * - If primary fails, updates domain.json on GitHub + alerts via Telegram
 * - Auto-recovers when primary comes back online
 */

const https = require('https');
let db = null;
let sendAlert = null;
let healTimer = null;

const SERVERS = [
  { name: 'Render', url: 'https://leakspro-backup-production.up.railway.app/api/health', primary: true },
  { name: 'Railway', url: 'https://leakspro-backup-production.up.railway.app/api/health', primary: false },
  { name: 'Cloudflare', url: 'https://netmirror.lholtkaren.workers.dev/api/health', primary: false },
];

const GITHUB_REPO = 'Aldura5398/klad4';
const DOMAIN_JSON_PATH = 'domain.json';

let lastStatus = {}; // name -> { ok, lastCheck, downSince }
let failoverActive = false;

function initSelfHeal(_db, _sendAlert) {
  db = _db;
  sendAlert = _sendAlert || (() => {});

  // Initialize status
  for (const s of SERVERS) {
    lastStatus[s.name] = { ok: true, lastCheck: null, downSince: null, consecutiveFails: 0 };
  }

  // Check every 60 seconds
  healTimer = setInterval(runHealthCheck, 60 * 1000);
  // First check after 30s (let server boot)
  setTimeout(runHealthCheck, 30 * 1000);

  console.log('[SelfHeal] Agent started — monitoring every 60s');
}

function stopSelfHeal() {
  if (healTimer) { clearInterval(healTimer); healTimer = null; }
}

async function runHealthCheck() {
  const results = {};
  for (const s of SERVERS) {
    results[s.name] = await checkServer(s.url);
  }

  // Update status tracking
  for (const s of SERVERS) {
    const prev = lastStatus[s.name];
    const now = results[s.name];
    prev.lastCheck = new Date().toISOString();

    if (now) {
      // Server is UP
      if (!prev.ok) {
        // Was down, now recovered
        prev.consecutiveFails = 0;
        prev.downSince = null;
        prev.ok = true;
        sendAlert(`✅ <b>${s.name}</b> is back online!`);

        // If primary recovered and failover was active, switch back
        if (s.primary && failoverActive) {
          await switchToPrimary();
          failoverActive = false;
          sendAlert('🔄 Auto-switched back to primary (Render)');
        }
      }
      prev.ok = true;
    } else {
      // Server is DOWN
      prev.consecutiveFails++;
      if (prev.ok) {
        prev.downSince = new Date().toISOString();
        prev.ok = false;
      }

      // Alert after 3 consecutive failures (3 minutes)
      if (prev.consecutiveFails === 3) {
        sendAlert(`🔴 <b>${s.name}</b> is DOWN!\nDown since: ${prev.downSince}\nConsecutive fails: ${prev.consecutiveFails}`);

        // If primary is down, trigger failover to Railway
        if (s.primary && !failoverActive) {
          const railwayOk = results['Railway'];
          if (railwayOk) {
            await switchToBackup();
            failoverActive = true;
            sendAlert('⚡ Auto-failover: Switched to Railway (backup)');
          } else {
            sendAlert('⚠️ Both Render AND Railway are down! Manual intervention needed.');
          }
        }
      }
    }
  }

  // Store status in DB
  try {
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('selfheal_status', ?)").run(JSON.stringify({
      lastCheck: new Date().toISOString(),
      failoverActive,
      servers: lastStatus
    }));
  } catch (_) {}
}

function checkServer(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function switchToBackup() {
  try {
    const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get()?.value;
    if (!token) return;

    const domainData = {
      primary: 'https://leakspro-backup-production.up.railway.app',
      fallback: 'https://leakspro-backup-production.up.railway.app',
      updated_at: new Date().toISOString(),
      reason: 'auto-failover: Render down, switching to Railway'
    };

    await updateGitHubFile(token, DOMAIN_JSON_PATH, JSON.stringify(domainData, null, 2), 'Auto-failover: switch to Railway');
    console.log('[SelfHeal] Switched to Railway (backup)');
  } catch (e) {
    console.error('[SelfHeal] Failover error:', e.message);
  }
}

async function switchToPrimary() {
  try {
    const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get()?.value;
    if (!token) return;

    const domainData = {
      primary: 'https://leakspro-backup-production.up.railway.app',
      fallback: 'https://leakspro-backup-production.up.railway.app',
      updated_at: new Date().toISOString(),
      reason: 'auto-recovery: Render back online'
    };

    await updateGitHubFile(token, DOMAIN_JSON_PATH, JSON.stringify(domainData, null, 2), 'Auto-recovery: switch back to Render');
    console.log('[SelfHeal] Switched back to Render (primary)');
  } catch (e) {
    console.error('[SelfHeal] Recovery switch error:', e.message);
  }
}

async function updateGitHubFile(token, filePath, content, commitMsg) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'LeaksPro-SelfHeal'
  };

  // Get current SHA
  let sha = null;
  try {
    const resp = await fetch(apiUrl, { headers });
    if (resp.ok) sha = (await resp.json()).sha;
  } catch (_) {}

  const body = { message: commitMsg, content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;

  const putResp = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!putResp.ok) throw new Error(`GitHub API: ${putResp.status}`);
}

function getStatus() {
  return { failoverActive, servers: lastStatus };
}

module.exports = { initSelfHeal, stopSelfHeal, getStatus };
