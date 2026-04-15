const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const cookieParser = require('cookie-parser');
const { renderImage, closeBrowser } = require('./lib/renderer');
const { runMigrations, close: closeDb } = require('./lib/db');
const { seedUsers } = require('./lib/auth');
const scheduler = require('./lib/scheduler');

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

// API routes
app.use('/dashboard/api/auth', require('./routes/api/auth'));
app.use('/dashboard/api/clients', require('./routes/api/clients'));
app.use('/dashboard/api/questionnaires', require('./routes/api/questionnaires'));
app.use('/dashboard/api/plans', require('./routes/api/plans'));
app.use('/dashboard/api/posts', require('./routes/api/posts'));
app.use('/dashboard/api/schedules', require('./routes/api/schedules'));

// Page routes
app.use('/dashboard', require('./routes/dashboard'));

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
try {
  runMigrations();
  seedUsers();
  console.log('[db] Database initialized');
} catch (err) {
  console.error('[db] Initialization error:', err.message);
}

// Start scheduler
scheduler.start();

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
