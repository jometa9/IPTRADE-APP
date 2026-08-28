function escapeHtml(str) {
  if (str == null) return '';
  const s = String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeId(accountId) {
  return (escapeHtml(accountId || '').replace(/[^a-z0-9_]/gi, '_') || 'acc');
}

async function getApiUrl() {
  if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.getServerUrl) {
    const url = await window.electronAPI.getServerUrl();
    if (url) return url;
  }
  return 'http://localhost:7777';
}

let licenseKey = sessionStorage.getItem('iptrade_license_key') || null;

async function apiFetch(path, options = {}) {
  const base = await getApiUrl();
  const url = `${base}${path}`;
  const headers = { ...options.headers };
  if (licenseKey && !path.includes('/api/system/validate/')) {
    headers['Authorization'] = `Bearer ${licenseKey}`;
  }
  if (options.body !== undefined && options.body !== null) {
    const isJsonBody = typeof options.body === 'string' || (typeof options.body === 'object' && !(options.body instanceof FormData));
    if (isJsonBody && !('Content-Type' in headers)) {
      headers['Content-Type'] = 'application/json';
    }
  }
  return fetch(url, { ...options, headers });
}

function renderRoot() {
  const root = document.getElementById('root');
  if (!root) return;
  if (!licenseKey) {
    root.innerHTML = `
      <header class="app-header"><h1>IPTRADE</h1></header>
      <main class="app-content">
        <div class="card login-box">
          <h2>Sign in</h2>
          <form id="login-form">
            <label for="apiKey">License key / API key</label>
            <input type="password" id="apiKey" name="apiKey" placeholder="Enter your API key" style="margin: 8px 0 16px 0;" />
            <button type="submit">Login</button>
          </form>
          <p id="login-error" class="error"></p>
        </div>
      </main>
    `;
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const apiKey = e.target.apiKey.value.trim();
      const errEl = document.getElementById('login-error');
      errEl.textContent = '';
      try {
        const res = await apiFetch(
          '/api/system/validate/' + encodeURIComponent(apiKey),
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        if (data.success && data.data) {
          licenseKey = data.data.api_key || apiKey;
          sessionStorage.setItem('iptrade_license_key', licenseKey);
          renderRoot();
        } else {
          errEl.textContent = data.error || 'Invalid key';
        }
      } catch (err) {
        errEl.textContent = err.message || 'Request failed';
      }
    });
    return;
  }
  root.innerHTML = `
    <header class="app-header">
      <h1>IPTRADE</h1>
      <button id="logout-btn" class="secondary">Logout</button>
    </header>
    <main class="app-content">
      <div class="card">
        <h2>Accounts</h2>
        <div id="accounts-list">Loading...</div>
      </div>
      <div class="card">
        <h2>Link cTrader</h2>
        <button id="ctrader-link">Open cTrader OAuth</button>
        <p id="ctrader-link-error" class="error" style="margin-top: 8px; min-height: 1.4em;"></p>
      </div>
      <div id="install-bots-section" class="card" style="display: none;">
        <h2>Install Bots (Windows)</h2>
        <input type="text" id="bots-target-path" placeholder="Target path (e.g. C:\\Bots)" style="margin: 8px 0; max-width: 400px;" />
        <button id="install-bots-btn" style="margin-top: 8px;">Install MT4/MT5 Bots</button>
        <p id="install-bots-msg" style="color: #16a34a; margin-top: 8px;"></p>
      </div>
    </main>
  `;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await apiFetch('/api/system/logout', { method: 'POST' });
    } catch (_) {}
    licenseKey = null;
    sessionStorage.removeItem('iptrade_license_key');
    renderRoot();
  });
  document.getElementById('ctrader-link').addEventListener('click', async () => {
    const errEl = document.getElementById('ctrader-link-error');
    if (errEl) errEl.textContent = '';
    try {
      const res = await apiFetch('/api/auth/ctrader', {
        method: 'GET',
      });
      const data = await res.json().catch(() => ({}));
      if (data.success && data.data && data.data.url) {
        if (window.electronAPI && window.electronAPI.openExternalLink) {
          window.electronAPI.openExternalLink(data.data.url);
        } else {
          window.open(data.data.url, '_blank');
        }
      } else {
        const msg = data.error || (res.ok ? 'No URL returned' : res.statusText || `Error ${res.status}`);
        if (errEl) errEl.textContent = msg;
      }
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Request failed';
    }
  });
  if (window.electronAPI && window.electronAPI.getPlatform) {
    window.electronAPI.getPlatform().then((p) => {
      const section = document.getElementById('install-bots-section');
      if (section && p === 'win32') section.style.display = 'block';
    }).catch(() => {});
  }
  const installBtn = document.getElementById('install-bots-btn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      const pathEl = document.getElementById('bots-target-path');
      const msgEl = document.getElementById('install-bots-msg');
      const targetPath = pathEl && pathEl.value ? pathEl.value.trim() : '';
      if (!targetPath) {
        if (msgEl) msgEl.textContent = 'Enter a target path.';
        return;
      }
      try {
        const res = await apiFetch('/api/metatrader/install', {
          method: 'POST',
          body: JSON.stringify({ target_path: targetPath }),
        });
        const data = await res.json();
        if (msgEl) msgEl.textContent = res.ok ? (data.message || 'Installed.') : (data.error || res.statusText);
      } catch (e) {
        if (msgEl) msgEl.textContent = e.message || 'Request failed';
      }
    });
  }
  apiFetch('/api/accounts/status')
    .then((r) => r.json())
    .then((data) => {
      const el = document.getElementById('accounts-list');
      if (!el) return;
      const all = data.accounts || [];
      const nodes = data.heartbeat_nodes || [];
      let html = '';
      if (all.length) {
        all.forEach((a) => {
          const id = safeId(a.account_id);
          const accId = escapeHtml(a.account_id);
          const role = escapeHtml(a.role || 'pending');
          const tcpUrl = escapeHtml(a.tcp_url);
          const masterTcpUrl = escapeHtml(a.master_tcp_url || '');
          html += '<div class="account-item">';
          html += '<strong>' + accId + '</strong> (' + role + ')';
          if (a.tcp_url) html += ' — <code>' + tcpUrl + '</code>';
          html += '<div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">';
          html += '<select id="role_' + id + '" data-account-id="' + accId + '" style="width: auto;">';
          html += '<option value="pending"' + ((a.role || '') === 'pending' ? ' selected' : '') + '>pending</option>';
          html += '<option value="master"' + (a.role === 'master' ? ' selected' : '') + '>master</option>';
          html += '<option value="slave"' + (a.role === 'slave' ? ' selected' : '') + '>slave</option>';
          html += '</select>';
          html += '<input type="text" id="master_' + id + '" data-account-id="' + accId + '" placeholder="Master TCP URL (if slave)" style="flex: 1; min-width: 200px; max-width: 320px;" value="' + masterTcpUrl + '" />';
          html += '<button type="button" class="save-account" data-account-id="' + accId + '">Save</button>';
          html += '<button type="button" class="delete-account secondary" data-account-id="' + accId + '">Delete</button>';
          html += '</div></div>';
        });
      } else {
        html += '<p>No accounts</p>';
      }
      if (nodes.length) {
        html += '<p><strong>Heartbeat nodes:</strong></p><ul>';
        nodes.forEach((n) => {
          const label = escapeHtml(n.api_url || n.api_type || 'node');
          const count = (n.accounts && n.accounts.length) || 0;
          html += '<li>' + label + ' (' + count + ' accounts)</li>';
        });
        html += '</ul>';
      }
      el.innerHTML = html || '<p>No accounts</p>';
      el.querySelectorAll('.save-account').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const accountId = btn.getAttribute('data-account-id');
          const id = safeId(accountId);
          const roleEl = document.getElementById('role_' + id);
          const masterEl = document.getElementById('master_' + id);
          const role = roleEl ? roleEl.value : 'pending';
          const masterTcpUrl = masterEl && masterEl.value ? masterEl.value.trim() : null;
          try {
            await apiFetch('/api/accounts/' + encodeURIComponent(accountId), {
              method: 'PUT',
              body: JSON.stringify({ role, master_tcp_url: masterTcpUrl || undefined }),
            });
            renderRoot();
          } catch (_e) {
          }
        });
      });
      el.querySelectorAll('.delete-account').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const accountId = btn.getAttribute('data-account-id');
          if (!confirm('Remove account ' + accountId + '?')) return;
          try {
            await apiFetch('/api/accounts/' + encodeURIComponent(accountId), { method: 'DELETE' });
            renderRoot();
          } catch (_e) {
          }
        });
      });
    })
    .catch(() => {
      const el = document.getElementById('accounts-list');
      if (el) el.textContent = 'Failed to load';
    });
}

function handleCtraderDeepLink(url) {
  if (!url || !url.startsWith('iptrade://ctrader')) return;
  const u = new URL(url);
  const code = u.searchParams.get('code');
  if (code) {
    apiFetch('/api/auth/ctrader', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
      .then((r) => r.json())
      .then(() => renderRoot())
      .catch(() => {});
  }
}

if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.onDeepLink) {
  window.electronAPI.onDeepLink((data) => {
    handleCtraderDeepLink(data && data.url);
  });
}
window.addEventListener('auth-callback', (e) => {
  const url = e.detail && e.detail.url;
  handleCtraderDeepLink(url);
});

document.addEventListener('DOMContentLoaded', renderRoot);
