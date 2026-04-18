// Dashboard client-side JavaScript

function getToken() {
  return localStorage.getItem('dashboard_token');
}

async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const fetchOptions = {
    method: options.method || 'GET',
    headers
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, fetchOptions);

  if (res.status === 401) {
    localStorage.removeItem('dashboard_token');
    document.cookie = 'dashboard_token=; path=/; max-age=0';
    window.location.href = '/dashboard/login';
    throw new Error('Session expired');
  }

  return res.json();
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function logout() {
  localStorage.removeItem('dashboard_token');
  document.cookie = 'dashboard_token=; path=/; max-age=0';
  window.location.href = '/dashboard/login';
}

// Close modal on backdrop click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    const alertOv = document.getElementById('alert-overlay');
    if (alertOv && alertOv.classList.contains('active')) {
      alertOv.classList.remove('active');
      if (window._alertResolve) { window._alertResolve(false); window._alertResolve = null; }
    }
  }
});

// ── Alert / Confirm / Toast system ──

// Create alert DOM once
(function initAlertSystem() {
  if (document.getElementById('alert-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'alert-overlay';
  overlay.innerHTML = '<div id="alert-box">' +
    '<div id="alert-msg"></div>' +
    '<div id="alert-actions">' +
    '<button id="alert-copy-btn" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copia</button>' +
    '<button id="alert-cancel-btn" type="button" style="display:none">Annulla</button>' +
    '<button id="alert-ok-btn" type="button">OK</button>' +
    '</div></div>';
  document.body.appendChild(overlay);

  // Toast container
  const tc = document.createElement('div');
  tc.id = 'toast-container';
  document.body.appendChild(tc);
})();

function showAlert(message) {
  return new Promise(resolve => {
    const ov = document.getElementById('alert-overlay');
    const msg = document.getElementById('alert-msg');
    const cancelBtn = document.getElementById('alert-cancel-btn');
    const copyBtn = document.getElementById('alert-copy-btn');

    msg.textContent = message;
    cancelBtn.style.display = 'none';
    ov.classList.add('active');
    window._alertResolve = resolve;

    document.getElementById('alert-ok-btn').onclick = () => {
      ov.classList.remove('active');
      resolve(true);
      window._alertResolve = null;
    };

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(message).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copiato';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copia';
        }, 1500);
      });
    };

    document.getElementById('alert-ok-btn').focus();
  });
}

function showConfirm(message) {
  return new Promise(resolve => {
    const ov = document.getElementById('alert-overlay');
    const msg = document.getElementById('alert-msg');
    const cancelBtn = document.getElementById('alert-cancel-btn');
    const copyBtn = document.getElementById('alert-copy-btn');

    msg.textContent = message;
    cancelBtn.style.display = '';
    ov.classList.add('active');
    window._alertResolve = resolve;

    document.getElementById('alert-ok-btn').onclick = () => {
      ov.classList.remove('active');
      resolve(true);
      window._alertResolve = null;
    };

    cancelBtn.onclick = () => {
      ov.classList.remove('active');
      resolve(false);
      window._alertResolve = null;
    };

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(message).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copiato';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copia';
        }, 1500);
      });
    };

    document.getElementById('alert-ok-btn').focus();
  });
}

function toast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => t.remove(), 300);
  }, duration);
}
