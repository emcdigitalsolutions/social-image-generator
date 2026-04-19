const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'dashboard.db');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const MAX_BACKUPS = 7;

function timestamp() {
  const now = new Date();
  return now.getFullYear() +
    '-' + String(now.getMonth() + 1).padStart(2, '0') +
    '-' + String(now.getDate()).padStart(2, '0') +
    '_' + String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0');
}

function rotate(prefix, ext) {
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(ext))
    .sort();
  if (files.length > MAX_BACKUPS) {
    const toDelete = files.slice(0, files.length - MAX_BACKUPS);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(BACKUPS_DIR, f));
      console.log(`[backup] Rimosso backup vecchio: ${f}`);
    }
  }
}

function backupDb(stamp) {
  if (!fs.existsSync(DB_PATH)) {
    console.warn('[backup] DB non trovato:', DB_PATH);
    return;
  }
  const backupName = `dashboard_${stamp}.db`;
  const backupPath = path.join(BACKUPS_DIR, backupName);
  fs.copyFileSync(DB_PATH, backupPath);
  console.log(`[backup] DB backup creato: ${backupName}`);
  rotate('dashboard_', '.db');
}

function backupMedia(stamp) {
  if (!fs.existsSync(PUBLIC_IMAGES_DIR)) {
    console.log('[backup] public/images non esiste, skip media backup');
    return;
  }
  // Skip se vuoto: tar di una dir vuota crea ~120 byte inutili al giorno
  let isEmpty = true;
  try { isEmpty = fs.readdirSync(PUBLIC_IMAGES_DIR).length === 0; } catch (_) {}
  if (isEmpty) {
    console.log('[backup] public/images vuoto, skip media backup');
    return;
  }

  const backupName = `media_${stamp}.tar.gz`;
  const backupPath = path.join(BACKUPS_DIR, backupName);

  // Usiamo tar di sistema per evitare deps. Su node:20-slim è sempre presente.
  // Path relativo per non avere il prefisso /app/public nel tar.
  const result = spawnSync('tar', ['-czf', backupPath, '-C', path.join(__dirname, '..', 'public'), 'images'], {
    stdio: ['ignore', 'ignore', 'pipe']
  });

  if (result.error) {
    console.error('[backup] media: tar non disponibile o errore:', result.error.message);
    return;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : '';
    console.error('[backup] media: tar exit', result.status, stderr.substring(0, 200));
    return;
  }

  let bytes = 0;
  try { bytes = fs.statSync(backupPath).size; } catch (_) {}
  const mb = (bytes / 1024 / 1024).toFixed(1);
  console.log(`[backup] media backup creato: ${backupName} (${mb} MB)`);
  rotate('media_', '.tar.gz');
}

function runBackup() {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = timestamp();
    backupDb(stamp);
    backupMedia(stamp);
  } catch (err) {
    console.error(`[backup] Errore: ${err.message}`);
  }
}

module.exports = { runBackup, backupDb, backupMedia };
