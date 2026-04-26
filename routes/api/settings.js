/**
 * routes/api/settings.js - API impostazioni globali
 * GET  /             - Legge tutte le impostazioni
 * PUT  /             - Salva impostazioni (body: {settings: {key: value}})
 * POST /test-smtp    - Invia email di test
 */
'use strict';

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../lib/auth');
const settings = require('../../lib/settings');

// Endpoint diagnostico PUBBLICO (no auth): TCP probe da container.
// Nessuna info sensibile, solo connect+disconnect verso host:port arbitrari.
// Definito PRIMA di router.use(authMiddleware) così non richiede login.
router.get('/net-test', async (req, res) => {
  const net = require('net');
  const host = String(req.query.host || 'smtps.aruba.it').slice(0, 200);
  const port = parseInt(req.query.port, 10) || 465;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'port invalido' });
  const start = Date.now();
  const result = await new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 5000 });
    let done = false;
    const finish = (p) => { if (done) return; done = true; try { socket.destroy(); } catch (_) {} resolve(p); };
    socket.once('connect', () => finish({ ok: true, ms: Date.now() - start }));
    socket.once('timeout', () => finish({ ok: false, error: 'TCP timeout (porta probabilmente bloccata dal firewall)', ms: Date.now() - start }));
    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message, ms: Date.now() - start }));
  });
  res.json({ host, port, ...result });
});

router.use(authMiddleware);

const ALLOWED_KEYS = [
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_notify_to',
  'google_script_url',
  'gas_email_url', 'gas_email_secret',
  'anthropic_api_key', 'gemini_api_key',
  'base_url'
];
const SECRET_KEYS = new Set(['smtp_pass', 'anthropic_api_key', 'gemini_api_key', 'gas_email_secret']);
const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

// GET - legge tutte le impostazioni (segreti mascherati)
router.get('/', (req, res) => {
  try {
    const all = settings.getAllSettings();
    for (const key of SECRET_KEYS) {
      if (all[key]) all[key] = MASK;
    }
    res.json({ settings: all });
  } catch (err) {
    console.error('[Settings GET]', err.message);
    res.status(500).json({ error: 'Errore nel caricamento impostazioni' });
  }
});

// PUT - salva impostazioni
router.put('/', (req, res) => {
  try {
    const data = req.body.settings;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Formato non valido' });
    }

    for (const [key, value] of Object.entries(data)) {
      if (!ALLOWED_KEYS.includes(key)) continue;
      // Se il segreto e' mascherato, non sovrascriverlo
      if (SECRET_KEYS.has(key) && value === MASK) continue;
      settings.setSetting(key, value);
    }

    res.json({ message: 'Impostazioni salvate' });
  } catch (err) {
    console.error('[Settings PUT]', err.message);
    res.status(500).json({ error: 'Errore nel salvataggio impostazioni' });
  }
});

// POST - invia email di test
router.post('/test-smtp', async (req, res) => {
  // Scoped fuori dal try così il catch può leggere host/port per il messaggio di errore.
  const nodemailer = require('nodemailer');
  const smtpConfig = settings.getSmtpConfig();
  if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
    return res.status(400).json({ error: 'Configurazione SMTP incompleta. Salva host, user e password prima di testare.' });
  }
  try {

    const recipient = smtpConfig.notify_to || smtpConfig.user;

    const isSsl = smtpConfig.port === 465;
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: isSsl,
      // 587 = STARTTLS obbligatorio (senza, Aruba rifiuta AUTH in chiaro)
      requireTLS: !isSsl,
      auth: { user: smtpConfig.user, pass: smtpConfig.pass },
      // Timeout aggressivi: Traefik/Coolify davanti all'app ha un timeout di risposta
      // attorno ai 30s. Se nodemailer supera, il proxy restituisce 502 Bad Gateway
      // invece dell'errore vero. Teniamoci molto sotto.
      connectionTimeout: 8000,
      greetingTimeout: 5000,
      socketTimeout: 10000
    });

    await transporter.sendMail({
      from: `"SMM Dashboard" <${smtpConfig.user}>`,
      to: recipient,
      subject: 'SMM Dashboard - Test SMTP',
      text: 'Questa e\' un\'email di test inviata dal pannello Impostazioni.\n\nSe ricevi questo messaggio, la configurazione SMTP e\' corretta.',
      html: '<h3>SMM Dashboard</h3><p>Questa &egrave; un\'email di test inviata dal pannello <strong>Impostazioni</strong>.</p><p>Se ricevi questo messaggio, la configurazione SMTP &egrave; corretta.</p>'
    });

    res.json({ message: `Email di test inviata a ${recipient}` });
  } catch (err) {
    console.error('[Settings test-smtp]', err.code || '', err.message);
    // Espone codice errore SMTP + suggerimento diagnostico così il bug è autodiagnostico.
    const code = err.code ? `[${err.code}] ` : '';
    let hint = '';
    if (err.code === 'EAUTH') hint = ' — Credenziali rifiutate dal server. Verifica user/password (Gmail richiede una "App Password" se hai 2FA attivo).';
    else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION') hint = ` — Connessione fallita verso ${smtpConfig.host}:${smtpConfig.port}. Verifica host/porta e che il firewall del server permetta la connessione in uscita.`;
    else if (err.code === 'ESOCKET' || (err.message || '').includes('self signed')) hint = ' — Problema TLS. Se il server SMTP usa un certificato self-signed contatta il supporto.';
    res.status(500).json({ error: 'Errore invio email: ' + code + err.message + hint });
  }
});

// POST - invia email di test tramite Google Apps Script (bypassa SMTP)
router.post('/test-google-script', async (req, res) => {
  const url = settings.getGoogleScriptUrl();
  if (!url) return res.status(400).json({ error: 'URL Google Apps Script non configurato. Incolla il webhook dello script nel campo apposito e salva prima di testare.' });
  try {
    const https = require('https');
    const { URL } = require('url');
    const u = new URL(url);
    const smtpConfig = settings.getSmtpConfig();
    const testCc = (req.body && typeof req.body.cc === 'string') ? req.body.cc.trim() : '';
    // site='emcdigitalsolutions' così lo script GAS routa il destinatario su EMC
    // (lo stesso target dei form contatti del sito emcdigitalsolutions).
    // Prefisso "[SIG] " attiva nel GAS il ramo notifiche (HTML come-è, senza wrapper form contatti).
    const payload = JSON.stringify({
      site: 'emcdigitalsolutions',
      name: '[SIG] Test configurazione Google Apps Script' + (testCc ? ' (con CC)' : ''),
      email: smtpConfig.user || 'noreply@emcdigitalsolutions.it',
      phone: '',
      message: '<p>Questa è una email di test dalla dashboard SIG.</p>'
        + '<p>Se la ricevi, Google Apps Script è configurato correttamente per inviare le notifiche admin (publish failed/partial, approvazioni cliente).</p>'
        + (testCc ? '<p><strong>CC test attivo:</strong> ' + testCc.replace(/[<>&]/g, '') + ' dovrebbe aver ricevuto una copia di questa email.</p>' : ''),
      cc: testCc
    });
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (r) => {
        let data = ''; r.on('data', c => data += c);
        r.on('end', () => {
          if (r.statusCode === 302 && r.headers.location) {
            https.get(r.headers.location, (r2) => {
              let d2 = ''; r2.on('data', c => d2 += c);
              r2.on('end', () => resolve({ status: r2.statusCode, body: d2 }));
            }).on('error', reject);
          } else if (r.statusCode >= 200 && r.statusCode < 400) resolve({ status: r.statusCode, body: data });
          else reject(new Error(`HTTP ${r.statusCode}: ${data.slice(0, 200)}`));
        });
      });
      req2.on('error', reject);
      req2.setTimeout(10000, () => req2.destroy(new Error('Timeout verso Google Script')));
      req2.write(payload);
      req2.end();
    });
    res.json({ message: `Richiesta inviata a Google Script (HTTP ${result.status}). Controlla la tua email.` });
  } catch (err) {
    console.error('[Settings test-google-script]', err.message);
    res.status(500).json({ error: 'Errore invio via Google Script: ' + err.message });
  }
});

module.exports = router;
