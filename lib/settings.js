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

// Lookup safe: se la tabella settings non esiste ancora (boot pre-migrazioni),
// fallback diretto su env var senza propagare l'eccezione.
function safeGet(key, envName) {
  try {
    return getSetting(key) || process.env[envName] || '';
  } catch (_) {
    return process.env[envName] || '';
  }
}

function getAnthropicKey()    { return safeGet('anthropic_api_key', 'ANTHROPIC_API_KEY'); }
function getGeminiKey()       { return safeGet('gemini_api_key',    'GEMINI_API_KEY'); }
function getHuggingFaceKey()  { return safeGet('huggingface_api_key', 'HUGGINGFACE_API_KEY'); }
function getReplicateKey()    { return safeGet('replicate_api_key', 'REPLICATE_API_KEY'); }
function getBaseUrl()         { return safeGet('base_url',          'BASE_URL') || 'http://localhost:3100'; }

// Risolve la Gemini key effettiva da usare per un cliente.
// Logica:
//   1. Se setting 'gemini_force_global'='1' e c'è una key globale → usa globale (override totale)
//   2. Se il cliente ha una key propria → usa quella
//   3. Altrimenti → fallback alla key globale dei settings/env
// Utile quando billing è attivo solo sulla key globale e si vuole evitare di
// configurare singolarmente ogni cliente.
function getEffectiveGeminiKey(client) {
  const globalKey = getGeminiKey();
  const forceGlobal = (() => {
    try { return getSetting('gemini_force_global') === '1'; }
    catch (_) { return false; }
  })();
  if (forceGlobal && globalKey) return globalKey;
  if (client && client.gemini_api_key) return client.gemini_api_key;
  return globalKey || '';
}
// Webhook URL di un Google Apps Script che invia email via MailApp (usato al posto
// di SMTP quando Hetzner/hosting blocca outbound SMTP). Esce via HTTPS:443.
// `google_script_url` è il GAS legacy dei contact form (no allegati).
// `gas_email_url` + `gas_email_secret` è il nuovo relay dedicato con allegati base64
// + destinatario custom (vedi emcdigitalsolutions/sig-email-relay.gs).
function getGoogleScriptUrl() { return safeGet('google_script_url', 'GOOGLE_SCRIPT_URL'); }
function getGasEmailUrl()     { return safeGet('gas_email_url',     'GAS_EMAIL_URL'); }
function getGasEmailSecret()  { return safeGet('gas_email_secret',  'GAS_EMAIL_SECRET'); }

// Credenziali app TikTok (a livello globale, non per-cliente). Servono per
// rinnovare l'access token dei clienti via refresh_token. MAI hardcodate:
// si impostano via settings (DB) o env TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET.
function getTikTokClientKey()    { return safeGet('tiktok_client_key',    'TIKTOK_CLIENT_KEY'); }
function getTikTokClientSecret() { return safeGet('tiktok_client_secret', 'TIKTOK_CLIENT_SECRET'); }

module.exports = {
  getSetting, setSetting, getAllSettings, getSmtpConfig,
  getAnthropicKey, getGeminiKey, getHuggingFaceKey, getReplicateKey,
  getEffectiveGeminiKey,
  getBaseUrl, getGoogleScriptUrl, getGasEmailUrl, getGasEmailSecret,
  getTikTokClientKey, getTikTokClientSecret
};
