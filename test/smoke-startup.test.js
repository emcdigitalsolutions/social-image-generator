/**
 * Smoke test: avvia il server con DB temporaneo e verifica che /health risponda.
 * Valida che: migrations SQLite passino, seedUsers non fallisca, scheduler parta,
 * backup non blocchi l'avvio.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const TEST_PORT = 3399;
const TEST_DIR = path.join(os.tmpdir(), `sig-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const TEST_DB = path.join(TEST_DIR, 'test.db');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('request timeout')); });
  });
}

async function waitForServer(url, maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await httpGet(url);
      if (r.status === 200) return r;
    } catch (_) { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`server non raggiungibile su ${url} dopo ${maxAttempts} tentativi`);
}

describe('smoke startup', () => {
  let child;
  let stdoutBuf = '';
  let stderrBuf = '';

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
  });

  test('server avvia con DB temp, migrations passano, /health risponde 200', async () => {
    const env = {
      ...process.env,
      PORT: String(TEST_PORT),
      DB_PATH: TEST_DB,
      DASHBOARD_USERS: 'testadmin:testpass',
      BASE_URL: `http://localhost:${TEST_PORT}`,
      // Disabilita puppeteer/renderer in contesto test — se mai invocato
      NODE_ENV: 'test'
    };

    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env,
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    const result = await waitForServer(`http://localhost:${TEST_PORT}/health`);
    expect(result.status).toBe(200);
    const json = JSON.parse(result.body);
    expect(json.status).toBe('ok');
    expect(json.timestamp).toBeDefined();

    expect(fs.existsSync(TEST_DB)).toBe(true);
  }, 30000);

  test('nessun errore fatale durante boot', () => {
    expect(stderrBuf).not.toMatch(/FATAL uncaughtException/);
    expect(stderrBuf).not.toMatch(/FATAL unhandledRejection/);
  });
});
