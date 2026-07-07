// Sync writers (fs.writeSync flushes immediately even on abrupt container exit)
const fsSync = require('fs');
function _slog(prefix, msg) {
  try { fsSync.writeSync(2, `[${prefix}] ${msg}\n`); } catch (_) {}
}
process.on('uncaughtException', (err) => {
  _slog('FATAL uncaughtException', err && (err.stack || err.message || String(err)));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  _slog('FATAL unhandledRejection', reason && (reason.stack || reason.message || String(reason)));
  process.exit(1);
});

require('./lib/logger'); // Must be first — intercepts console.log/error/warn
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const cookieParser = require('cookie-parser');
const { renderImage, closeBrowser } = require('./lib/renderer');
const { runMigrations, close: closeDb } = require('./lib/db');
const { seedUsers } = require('./lib/auth');
const scheduler = require('./lib/scheduler');
const cron = require('node-cron');
const { runBackup } = require('./lib/backup');
const { sendMonthlyReminders } = require('./lib/reminders');

const app = express();
const PORT = process.env.PORT || 3100;
const API_KEY = process.env.API_KEY || 'dev-key';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── View engine ──
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Helper globali disponibili in tutte le view EJS senza require()
const { resolveCalendarMonth: __resolveCalendarMonth, fullMonthLabel: __fullMonthLabel } = require('./lib/month-labels');
app.locals.resolveCalendarMonth = __resolveCalendarMonth;
app.locals.fullMonthLabel = __fullMonthLabel;

// ── Middleware ──
// limit 10mb: serve per import piani editoriali lunghi (es. 6 mesi × 28 post con caption)
app.use(express.json({ limit: '10mb' }));

// Asset version fissato al boot: cambia ad ogni deploy/restart, fa cache-bust
// sui CSS/JS senza invalidare ad ogni request. Esposto come res.locals.assetVersion
// e come variable nell'EJS.
const ASSET_VERSION = String(Date.now());
const viewHelpers = require('./lib/view-helpers');
app.use((req, res, next) => {
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.fmtRome = viewHelpers.fmtRome;
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Access log per /images: utile per debuggare quando Meta non riesce a scaricare.
// Logga IP, UA, status, response time, content-length.
app.use('/images', (req, res, next) => {
  const start = Date.now();
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress;
  const ua = (req.headers['user-agent'] || '').substring(0, 80);
  res.on('finish', () => {
    const ms = Date.now() - start;
    const isMeta = /facebook|instagram|meta/i.test(ua);
    if (isMeta || res.statusCode >= 400) {
      console.log(`[images] ${res.statusCode} ${req.method} ${req.path} ip=${ip} ms=${ms} bytes=${res.getHeader('content-length') || '?'} ua="${ua}"`);
    }
  });
  next();
});

// Static files — serve generated images.
// NB: NO immutable qui. I file di post_media vengono sovrascritti dal crop-tool,
// con immutable Meta/CDN li mettono in cache alla prima versione e non rileggono
// mai la modifica → IG rifiuta al publish pensando che le proporzioni siano ancora
// quelle originali. Cache breve + ETag basato su mtime permette di rileggere.
//
// Access-Control-Allow-Origin: * serve al Cropper.js della lightbox: il canvas
// non viene marcato "tainted" e canvas.toBlob() può estrarre il blob croppato.
// Senza CORS header, l'<img crossorigin="anonymous"> fallisce il caricamento.
app.use('/images', express.static(path.join(__dirname, 'public', 'images'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  // acceptRanges:false forza risposta 200 OK invece di 206 Partial Content.
  // Il crawler di Meta/IG fa Range request → server risponde 206 → IG considera
  // il file non conforme e rifiuta il container ("URL not accessible / corrupt").
  // FB è più tollerante e accetta 206, ma IG no. File <200KB → range fetching
  // non porta benefici, solo rischi.
  acceptRanges: false,
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// Music library: tracce audio per slideshow Reel AI. Stesse regole CORS delle
// immagini per uniformità (anche se /music non viene linkato direttamente da Meta).
app.use('/music', express.static(path.join(__dirname, 'public', 'music'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  // acceptRanges:false: dietro il proxy Traefik/Coolify il Range header viene
  // rimaneggiato → 206 con Content-Range malformato → il player <audio> del
  // browser non parte (anteprima muta, durata 0:00). Stessa lezione di /library.
  acceptRanges: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Forza Content-Type esplicito (alcuni proxy strippano la deduzione mime)
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg'
    };
    if (mimeMap[ext]) res.setHeader('Content-Type', mimeMap[ext]);
  }
}));

// Libreria media per cliente (video + audio riusabili).
// URL pubblico: /library/<client_id>/<kind>/<filename>
// Filesystem REALE: public/images/library/... (sotto /images perché è
//   l'unico volume Coolify persistente; public/library nudo veniva
//   azzerato ad ogni restart container).
// acceptRanges:false: alcuni proxy/CDN mangiano i Range header → 206 con
//   Content-Range malformato → player browser non parte (durata 0:00).
app.use('/library', express.static(path.join(__dirname, 'public', 'images', 'library'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  acceptRanges: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // Forza Content-Type esplicito (alcuni proxy strippano la deduzione)
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg'
    };
    if (mimeMap[ext]) res.setHeader('Content-Type', mimeMap[ext]);
  }
}));

// Static files — dashboard assets (CSS/JS only)
app.use('/dashboard/css', express.static(path.join(__dirname, 'public', 'dashboard', 'css'), { maxAge: '1d' }));
app.use('/dashboard/js', express.static(path.join(__dirname, 'public', 'dashboard', 'js'), { maxAge: '1d' }));

// Rate limiting (simple in-memory)
const rateMap = new Map();
const RATE_LIMIT = 100;
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = rateMap.get(key);

  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(key, { start: now, count: 1 });
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  next();
}

// Auth middleware for API key
function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ── Original API Routes ──

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/generate', auth, rateLimit, async (req, res) => {
  try {
    const { template, client, data } = req.body;

    if (!template || !client || !data) {
      return res.status(400).json({
        error: 'Missing required fields: template, client, data',
      });
    }

    // Validate template exists
    const templatePath = path.join(__dirname, 'templates', `${template}.html`);
    try {
      await fs.access(templatePath);
    } catch {
      return res.status(400).json({ error: `Template "${template}" not found` });
    }

    // Sanitize client name
    const safeClient = client.replace(/[^a-z0-9_-]/gi, '');

    console.log(`[generate] template=${template} client=${safeClient}`);
    const { filename } = await renderImage(template, safeClient, data);
    const url = `${BASE_URL}/images/${safeClient}/${filename}`;

    console.log(`[generate] done → ${url}`);
    res.json({ url, filename });
  } catch (err) {
    console.error('[generate] Error:', err.message);
    res.status(500).json({ error: 'Image generation failed', details: err.message });
  }
});

// ── Dashboard Routes ──

// API routes
app.use('/dashboard/api/auth', require('./routes/api/auth'));
app.use('/dashboard/api/clients', require('./routes/api/clients'));
app.use('/dashboard/api/questionnaires', require('./routes/api/questionnaires'));
app.use('/dashboard/api/plans', require('./routes/api/plans'));
app.use('/dashboard/api/posts', require('./routes/api/posts'));
app.use('/dashboard/api/schedules', require('./routes/api/schedules'));
app.use('/dashboard/api/logs', require('./routes/api/logs'));
app.use('/dashboard/api/settings', require('./routes/api/settings'));
app.use('/dashboard/api/approvals', require('./routes/api/approvals'));
app.use('/dashboard/api/insights-share', require('./routes/api/insights-share'));
app.use('/dashboard/api/plan-templates', require('./routes/api/plan-templates'));
app.use('/dashboard/api/music', require('./routes/api/music'));

// Page routes
app.use('/dashboard', require('./routes/dashboard'));

// ── Cleanup cron: delete legacy top-level images older than 30 days ──
// Regole: NON tocca le sottocartelle (posts/, branding/, library/ ...), salta
// qualsiasi file ancora referenziato in DB (posts.image_url / post_media),
// e un errore su un file NON interrompe il resto del giro.
async function cleanupOldImages() {
  const imagesDir = path.join(__dirname, 'public', 'images');
  const maxAge = 30 * 24 * 60 * 60 * 1000;
  let deleted = 0, skippedRef = 0, errors = 0;

  // Set dei filename referenziati in DB (una query sola per giro)
  let referenced = new Set();
  try {
    const { getDb } = require('./lib/db');
    const db = getDb();
    for (const r of db.prepare("SELECT image_url FROM posts WHERE image_url IS NOT NULL AND image_url != ''").all()) {
      const base = String(r.image_url).split('/').pop().split('?')[0];
      if (base) referenced.add(base);
    }
    for (const r of db.prepare("SELECT filename FROM post_media WHERE filename IS NOT NULL AND filename != ''").all()) {
      const base = String(r.filename).split('/').pop();
      if (base) referenced.add(base);
    }
  } catch (err) {
    // Se non riusciamo a leggere i riferimenti, meglio NON cancellare nulla.
    console.error('[cleanup] Impossibile leggere i riferimenti DB, giro annullato:', err.message);
    return;
  }

  let clients = [];
  try { clients = await fs.readdir(imagesDir); } catch { return; }

  for (const client of clients) {
    const clientDir = path.join(imagesDir, client);
    try {
      const stat = await fs.stat(clientDir);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    let files = [];
    try { files = await fs.readdir(clientDir); } catch { continue; }

    for (const file of files) {
      const filePath = path.join(clientDir, file);
      try {
        const fileStat = await fs.stat(filePath);
        if (fileStat.isDirectory()) continue;            // posts/, branding/, library/...
        if (Date.now() - fileStat.mtimeMs <= maxAge) continue;
        if (referenced.has(file)) { skippedRef++; continue; } // ancora usato da un post
        await fs.unlink(filePath);
        deleted++;
        console.log(`[cleanup] Deleted: ${filePath}`);
      } catch (err) {
        errors++;
        console.error(`[cleanup] Errore su ${filePath}:`, err.message);
      }
    }
  }
  if (deleted || skippedRef || errors) {
    console.log(`[cleanup] Giro completato: ${deleted} eliminati, ${skippedRef} mantenuti (referenziati), ${errors} errori`);
  }
}

// Run cleanup every 24 hours
setInterval(cleanupOldImages, 24 * 60 * 60 * 1000);

// ── Initialize database and start ──
runMigrations();
seedUsers();
scheduler.start();
runBackup(); // boot: solo DB (il tar media da ~1GB a ogni deploy è sprecato)
cron.schedule('0 3 * * *', () => {
  // DB ogni notte; media solo la domenica (retention 3 copie ≈ 3 settimane)
  runBackup({ includeMedia: new Date().getDay() === 0 });
});

// Promemoria mensile: il 25 di ogni mese alle 08:00 (Europe/Rome) — invia all'admin
// un digest dello stato dei piani per ciascun cliente attivo, ed eventuali solleciti
// ai clienti che hanno un piano in attesa di approvazione (richiede contact_email).
cron.schedule('0 8 25 * *', () => {
  console.log('[reminders] Avvio invio promemoria mensile');
  Promise.resolve(sendMonthlyReminders()).catch(e => console.error('[reminders]', e.message));
}, { timezone: 'Europe/Rome' });

// Salute canali: ogni lunedì alle 08:30 (Europe/Rome) — avvisa l'admin se ci sono
// clienti PAGANTI con setup incompleto (servizio fermo = fatturato a rischio)
// o token social in scadenza (LinkedIn 60gg, TikTok refresh 365gg).
cron.schedule('30 8 * * 1', () => {
  try {
    const { buildChannelHealthReport } = require('./lib/setup-status');
    const { sendNotification } = require('./lib/notifier');
    const { getDb } = require('./lib/db');
    const report = buildChannelHealthReport(getDb());
    if (!report) { console.log('[channel-health] Tutto ok, nessun avviso'); return; }

    let html = '<h2>Salute canali social — controllo settimanale</h2>';
    if (report.notActivated.length) {
      html += '<h3>⚠️ Clienti con abbonamento ma servizio NON operativo</h3><ul>';
      for (const c of report.notActivated) {
        html += `<li><strong>${c.name}</strong> (${c.plan}${c.price ? ', ' + c.price + '€/mese' : ''}) — manca: ${c.missing.join(', ')}</li>`;
      }
      html += '</ul>';
    }
    if (report.expiring.length) {
      html += '<h3>⏰ Token in scadenza</h3><ul>';
      for (const t of report.expiring) {
        html += `<li><strong>${t.name}</strong> — ${t.channel}: ${t.expired ? 'SCADUTO' : 'scade tra ' + t.daysLeft + ' giorni'} (${t.expiresAt})</li>`;
      }
      html += '</ul>';
    }
    html += `<p><a href="${BASE_URL}/dashboard">Apri la dashboard</a></p>`;
    const subject = `[SIG] Salute canali: ${report.notActivated.length} da attivare, ${report.expiring.length} token in scadenza`;
    Promise.resolve(sendNotification(subject, html)).catch(e => console.error('[channel-health]', e.message));
  } catch (err) {
    console.error('[channel-health]', err.message);
  }
}, { timezone: 'Europe/Rome' });

app.listen(PORT, () => {
  console.log(`Social Image Generator running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Dashboard: ${BASE_URL}/dashboard`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  scheduler.stop();
  closeDb();
  await closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  scheduler.stop();
  closeDb();
  await closeBrowser();
  process.exit(0);
});
