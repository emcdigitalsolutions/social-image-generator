/**
 * settings.js - Helper per impostazioni globali (tabella settings)
 * Lettura/scrittura key-value con fallback su env vars per SMTP
 */
'use strict';

const { getDb } = require('./db');

function getSetting(key, defaultValue = null) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

function getAllSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

function getSmtpConfig() {
  const settings = getAllSettings();
  return {
    host: settings.smtp_host || process.env.SMTP_HOST || '',
    port: parseInt(settings.smtp_port || process.env.SMTP_PORT || '587'),
    user: settings.smtp_user || process.env.SMTP_USER || '',
    pass: settings.smtp_pass || process.env.SMTP_PASS || '',
    notify_to: settings.smtp_notify_to || process.env.NOTIFY_TO || ''
  };
}

module.exports = { getSetting, setSetting, getAllSettings, getSmtpConfig };
