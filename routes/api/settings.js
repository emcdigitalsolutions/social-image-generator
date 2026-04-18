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

router.use(authMiddleware);

const ALLOWED_KEYS = [
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_notify_to',
  'anthropic_api_key', 'gemini_api_key',
  'base_url'
];
const SECRET_KEYS = new Set(['smtp_pass', 'anthropic_api_key', 'gemini_api_key']);
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
  try {
    const nodemailer = require('nodemailer');
    const smtpConfig = settings.getSmtpConfig();

    if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
      return res.status(400).json({ error: 'Configurazione SMTP incompleta. Salva host, user e password prima di testare.' });
    }

    const recipient = smtpConfig.notify_to || smtpConfig.user;

    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.port === 465,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass
      }
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
    console.error('[Settings test-smtp]', err.message);
    res.status(500).json({ error: 'Errore invio email: ' + err.message });
  }
});

module.exports = router;
