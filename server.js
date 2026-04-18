// ── Sync logger (fs.writeSync flushes immediately even before container exit) ──
const fsSync = require('fs');
function dlog(msg) {
  try { fsSync.writeSync(2, `[STARTUP] ${msg}\n`); } catch (_) {}
}
function dfatal(label, err) {
  const stack = err && (err.stack || err.message || String(err));
  try { fsSync.writeSync(2, `[STARTUP FATAL ${label}] ${stack}\n`); } catch (_) {}
}

process.on('uncaughtException', (err) => {
  dfatal('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  dfatal('unhandledRejection', reason);
  process.exit(1);
});

dlog('process started, node ' + process.version);
dlog('cwd=' + process.cwd());
dlog('PORT=' + (process.env.PORT || '(unset)'));
dlog('DB_PATH=' + (process.env.DB_PATH || '(default)'));

try {
  dlog('require lib/logger');
  require('./lib/logger');

  dlog('require express');
  const express = require('express');

  dlog('require path/fs/cookie-parser');
  const path = require('path');
  const fs = require('fs/promises');
  const cookieParser = require('cookie-parser');

  dlog('require lib/renderer');
  const { renderImage, closeBrowser } = require('./lib/renderer');

  dlog('require lib/db');
  const { runMigrations, close: closeDb } = require('./lib/db');

  dlog('require lib/auth');
  const { seedUsers } = require('./lib/auth');

  dlog('require lib/scheduler');
  const scheduler = require('./lib/scheduler');

  dlog('require node-cron');
  const cron = require('node-cron');

  dlog('require lib/backup');
  const { runBackup } = require('./lib/backup');

  dlog('all core modules loaded');

  const app = express();
  const PORT = process.env.PORT || 3100;
  const API_KEY = process.env.API_KEY || 'dev-key';
  const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

  // ── View engine ──
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // ── Middleware ──
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Static files — serve generated images
  app.use('/images', express.static(path.join(__dirname, 'public', 'images'), {
    maxAge: '7d',
    immutable: true,
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
  dlog('mounting API routes');

  // API routes (each require logged so we know which one fails to load)
  dlog('require routes/api/auth');
  app.use('/dashboard/api/auth', require('./routes/api/auth'));
  dlog('require routes/api/clients');
  app.use('/dashboard/api/clients', require('./routes/api/clients'));
  dlog('require routes/api/questionnaires');
  app.use('/dashboard/api/questionnaires', require('./routes/api/questionnaires'));
  dlog('require routes/api/plans');
  app.use('/dashboard/api/plans', require('./routes/api/plans'));
  dlog('require routes/api/posts');
  app.use('/dashboard/api/posts', require('./routes/api/posts'));
  dlog('require routes/api/schedules');
  app.use('/dashboard/api/schedules', require('./routes/api/schedules'));
  dlog('require routes/api/logs');
  app.use('/dashboard/api/logs', require('./routes/api/logs'));
  dlog('require routes/api/settings');
  app.use('/dashboard/api/settings', require('./routes/api/settings'));

  // Page routes
  dlog('require routes/dashboard');
  app.use('/dashboard', require('./routes/dashboard'));

  dlog('all routes mounted');

  // ── Cleanup cron: delete images older than 30 days ──
  async function cleanupOldImages() {
    const imagesDir = path.join(__dirname, 'public', 'images');
    const maxAge = 30 * 24 * 60 * 60 * 1000;

    try {
      const clients = await fs.readdir(imagesDir);
      for (const client of clients) {
        const clientDir = path.join(imagesDir, client);
        const stat = await fs.stat(clientDir);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(clientDir);
        for (const file of files) {
          const filePath = path.join(clientDir, file);
          const fileStat = await fs.stat(filePath);
          if (Date.now() - fileStat.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            console.log(`[cleanup] Deleted: ${filePath}`);
          }
        }
      }
    } catch (err) {
      console.error('[cleanup] Error:', err.message);
    }
  }

  // Run cleanup every 24 hours
  setInterval(cleanupOldImages, 24 * 60 * 60 * 1000);

  // ── Initialize database and start ──
  dlog('runMigrations()');
  try {
    runMigrations();
    dlog('migrations OK');
  } catch (err) {
    dfatal('runMigrations', err);
    process.exit(1);
  }

  dlog('seedUsers()');
  try {
    seedUsers();
    dlog('seedUsers OK');
  } catch (err) {
    dfatal('seedUsers', err);
    process.exit(1);
  }

  dlog('scheduler.start()');
  try {
    scheduler.start();
    dlog('scheduler OK');
  } catch (err) {
    dfatal('scheduler.start', err);
    process.exit(1);
  }

  dlog('runBackup() initial');
  try {
    runBackup();
    cron.schedule('0 3 * * *', runBackup);
    dlog('backup OK + cron scheduled');
  } catch (err) {
    dfatal('runBackup', err);
    process.exit(1);
  }

  dlog('app.listen(' + PORT + ')');
  app.listen(PORT, () => {
    dlog('server listening on ' + PORT);
    console.log(`Social Image Generator running on port ${PORT}`);
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Dashboard: ${BASE_URL}/dashboard`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    dlog('SIGTERM received');
    scheduler.stop();
    closeDb();
    await closeBrowser();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    dlog('SIGINT received');
    scheduler.stop();
    closeDb();
    await closeBrowser();
    process.exit(0);
  });
} catch (startupErr) {
  dfatal('top-level', startupErr);
  process.exit(1);
}
