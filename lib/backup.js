const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'dashboard.db');
const BACKUPS_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS = 7;

function runBackup() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      console.warn('[backup] DB non trovato:', DB_PATH);
      return;
    }

    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }

    const now = new Date();
    const stamp = now.getFullYear() +
      '-' + String(now.getMonth() + 1).padStart(2, '0') +
      '-' + String(now.getDate()).padStart(2, '0') +
      '_' + String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0');

    const backupName = `dashboard_${stamp}.db`;
    const backupPath = path.join(BACKUPS_DIR, backupName);

    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`[backup] Backup creato: ${backupName}`);

    // Rotate: keep only the latest MAX_BACKUPS
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('dashboard_') && f.endsWith('.db'))
      .sort();

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(0, files.length - MAX_BACKUPS);
      for (const f of toDelete) {
        fs.unlinkSync(path.join(BACKUPS_DIR, f));
        console.log(`[backup] Rimosso backup vecchio: ${f}`);
      }
    }
  } catch (err) {
    console.error(`[backup] Errore: ${err.message}`);
  }
}

module.exports = { runBackup };
