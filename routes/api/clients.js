const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { callClaude } = require('../../lib/ai');
const { getSectorKeys } = require('../../lib/questionnaire-config');

const router = express.Router();
router.use(authMiddleware);

const logoUpload = multer({
  dest: path.join(__dirname, '..', '..', 'assets'),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/svg+xml' || file.originalname.endsWith('.svg')) {
      cb(null, true);
    } else {
      cb(new Error('Only SVG files allowed'));
    }
  }
});

const themeUpload = multer({
  dest: path.join(__dirname, '..', '..', 'templates', 'themes'),
  limits: { fileSize: 512 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/css' || file.originalname.endsWith('.css')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSS files allowed'));
    }
  }
});

// List all clients
router.get('/', (req, res) => {
  const db = getDb();
  const clients = db.prepare('SELECT id, display_name, sector, location, status, logo_filename, created_at FROM clients ORDER BY created_at DESC').all();
  res.json(clients);
});

// Create client
router.post('/', (req, res) => {
  const db = getDb();
  const { id, display_name, sector, location, website, tagline, brand_name } = req.body;

  if (!id || !display_name) {
    return res.status(400).json({ error: 'id and display_name required' });
  }

  // Validate slug format
  if (!/^[a-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'id must be lowercase alphanumeric with hyphens/underscores' });
  }

  try {
    db.prepare(`
      INSERT INTO clients (id, display_name, sector, location, website, tagline, brand_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, display_name, sector || null, location || null, website || null, tagline || null, brand_name || display_name);

    // Create image output directory
    const imgDir = path.join(__dirname, '..', '..', 'public', 'images', id);
    if (!fs.existsSync(imgDir)) {
      fs.mkdirSync(imgDir, { recursive: true });
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    res.status(201).json(client);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Client ID already exists' });
    }
    throw err;
  }
});

// Get client
router.get('/:id', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

// Update client
router.put('/:id', (req, res) => {
  const db = getDb();
  const fields = ['display_name', 'sector', 'location', 'website', 'tagline', 'brand_name',
    'fb_page_id', 'fb_system_user_token', 'ig_user_id', 'ig_access_token',
    'system_instruction', 'anthropic_api_key', 'status', 'logo_filename', 'theme_filename'];

  const updates = [];
  const values = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  }

  if (!updates.length) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);

  const result = db.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (!result.changes) return res.status(404).json({ error: 'Client not found' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  res.json(client);
});

// Delete client
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Client not found' });
  res.json({ success: true });
});

// Upload logo
router.post('/:id/logo', logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const db = getDb();
  const filename = `logo-${req.params.id}.svg`;
  const dest = path.join(__dirname, '..', '..', 'assets', filename);

  fs.renameSync(req.file.path, dest);
  db.prepare("UPDATE clients SET logo_filename = ?, updated_at = datetime('now') WHERE id = ?").run(filename, req.params.id);

  res.json({ filename });
});

// Upload/generate theme CSS
router.post('/:id/theme', themeUpload.single('theme'), (req, res) => {
  const db = getDb();

  if (req.file) {
    const filename = `${req.params.id}.css`;
    const dest = path.join(__dirname, '..', '..', 'templates', 'themes', filename);
    fs.renameSync(req.file.path, dest);
    db.prepare("UPDATE clients SET theme_filename = ?, updated_at = datetime('now') WHERE id = ?").run(filename, req.params.id);
    return res.json({ filename });
  }

  // Generate from body CSS content
  if (req.body.css) {
    const filename = `${req.params.id}.css`;
    const dest = path.join(__dirname, '..', '..', 'templates', 'themes', filename);
    fs.writeFileSync(dest, req.body.css);
    db.prepare("UPDATE clients SET theme_filename = ?, updated_at = datetime('now') WHERE id = ?").run(filename, req.params.id);
    return res.json({ filename });
  }

  res.status(400).json({ error: 'Upload a CSS file or send css in body' });
});

// --- Website scan helpers ---

function fetchWebsite(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    const doFetch = (targetUrl, redirectsLeft) => {
      const mod = targetUrl.startsWith('https') ? https : http;
      const req = mod.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
        },
        timeout: 10000
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Troppi redirect'));
          let loc = res.headers.location;
          if (loc.startsWith('/')) {
            const u = new URL(targetUrl);
            loc = u.protocol + '//' + u.host + loc;
          }
          return doFetch(loc, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        let data = '';
        let size = 0;
        const MAX_SIZE = 100 * 1024;

        res.on('data', chunk => {
          size += chunk.length;
          if (size <= MAX_SIZE) data += chunk;
        });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout (10s)')); });
      req.on('error', reject);
    };

    doFetch(url, maxRedirects);
  });
}

function extractTextFromHtml(html) {
  const meta = {};

  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) meta.title = titleMatch[1].replace(/\s+/g, ' ').trim();

  // Extract meta description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i)
    || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["']/i);
  if (descMatch) meta.description = descMatch[1].trim();

  // Extract OG tags
  const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([\s\S]*?)["']/i);
  if (ogTitle) meta.og_title = ogTitle[1].trim();

  const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["']/i);
  if (ogDesc) meta.og_description = ogDesc[1].trim();

  // Extract colors from CSS (inline styles and style tags)
  const colorMatches = html.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const uniqueColors = [...new Set(colorMatches.map(c => c.toLowerCase()))].slice(0, 20);
  if (uniqueColors.length) meta.css_colors = uniqueColors;

  // Remove non-visible content
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, (m) => m); // keep header
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, ''); // remove nav

  // Strip HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x[0-9a-fA-F]+;/g, ' ').replace(/&#\d+;/g, ' ');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Truncate to 8000 chars for AI
  if (text.length > 8000) text = text.substring(0, 8000);

  return { text, meta };
}

async function analyzeWebsite(client, extractedText, extractedMeta, url) {
  const sectorList = getSectorKeys().map(s => `${s.key} (${s.label})`).join(', ');

  const systemInstruction = `Sei un analista web esperto. Analizza il contenuto di un sito web e estrai informazioni strutturate per creare un profilo cliente. Rispondi SOLO con un JSON valido, senza blocchi di codice markdown.`;

  const userPrompt = `Analizza questo sito web e estrai le informazioni per il profilo del cliente.

URL: ${url}
Titolo pagina: ${extractedMeta.title || 'N/A'}
Meta description: ${extractedMeta.description || 'N/A'}
OG Title: ${extractedMeta.og_title || 'N/A'}
OG Description: ${extractedMeta.og_description || 'N/A'}
Colori CSS trovati: ${extractedMeta.css_colors ? extractedMeta.css_colors.join(', ') : 'N/A'}

Testo del sito:
${extractedText}

Estrai e restituisci un JSON con SOLO questi campi (usa null se non riesci a determinare un valore):

{
  "display_name": "Nome completo dell'attività (come appare sul sito)",
  "brand_name": "Nome brand/marchio (versione breve/logo)",
  "sector": "Uno tra: ${sectorList}. Scegli il più appropriato, solo la chiave (es. 'ristorazione'). null se nessuno corrisponde.",
  "tagline": "Slogan/tagline dell'attività (se presente sul sito)",
  "location": "Città e provincia (es. 'Ravanusa, AG')",
  "description": "Breve descrizione dell'attività (2-3 frasi)",
  "services": "Lista servizi/prodotti principali separati da virgola",
  "colors": ["#hex1", "#hex2", "#hex3"]
}

IMPORTANTE:
- Per "sector" usa SOLO una delle chiavi elencate, o null
- Per "colors" scegli i 2-4 colori principali del brand/sito dai colori CSS trovati
- Rispondi SOLO con il JSON, nient'altro`;

  const result = await callClaude(
    client.anthropic_api_key,
    systemInstruction,
    userPrompt,
    { temperature: 0.3, maxTokens: 1024 }
  );

  // Parse JSON from response
  let parsed = null;
  try {
    let text = result.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Claude non ha restituito un JSON valido');
  }

  return parsed;
}

// Scan website and extract profile data
router.post('/:id/scan-website', async (req, res) => {
  try {
    const db = getDb();
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const url = req.body.url || client.website;
    if (!url) return res.status(400).json({ error: 'Nessun URL fornito. Inserisci un sito web.' });

    // Fetch
    let html;
    try {
      html = await fetchWebsite(url);
    } catch (err) {
      return res.status(400).json({ error: `Impossibile raggiungere il sito: ${err.message}` });
    }

    // Extract text
    const { text, meta } = extractTextFromHtml(html);
    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Il sito non contiene abbastanza testo da analizzare.' });
    }

    // Analyze with Claude
    const data = await analyzeWebsite(client, text, meta, url);

    res.json({ success: true, data });
  } catch (err) {
    console.error('Scan website error:', err);
    res.status(500).json({ error: err.message || 'Errore durante la scansione del sito' });
  }
});

module.exports = router;
