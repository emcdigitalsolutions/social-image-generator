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
  }
});
