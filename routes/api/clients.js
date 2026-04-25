const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { callAI, generateSystemInstruction, generateThemeCSS } = require('../../lib/ai-provider');
const { getSectorKeys } = require('../../lib/questionnaire-config');
const postMedia = require('../../lib/post-media');
const audit = require('../../lib/audit');

const router = express.Router();
router.use(authMiddleware);

const logoUpload = multer({
  dest: path.join(__dirname, '..', '..', 'assets'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/svg+xml', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype) || /\.(svg|jpg|jpeg|png)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Solo file SVG, JPG o PNG'));
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
    audit.logFromReq(req, {
      client_id: id,
      action: 'client.created',
      entity_type: 'client',
      entity_id: id,
      details: { display_name, sector, location }
    });
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
    'contact_email',
    'fb_page_id', 'fb_system_user_token', 'ig_user_id',
    'system_instruction', 'anthropic_api_key', 'gemini_api_key', 'ai_provider',
    'status', 'logo_filename', 'theme_filename',
    'subscription_plan', 'subscription_price', 'subscription_notes',
    'editorial_months'];

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

  const before = db.prepare('SELECT status FROM clients WHERE id = ?').get(req.params.id);
  const result = db.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (!result.changes) return res.status(404).json({ error: 'Client not found' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);

  // Tracciamo separatamente il cambio di stato (archived/active/paused) perché
  // è l'informazione più rilevante nel contesto audit.
  if (before && req.body.status !== undefined && before.status !== client.status) {
    audit.logFromReq(req, {
      client_id: req.params.id,
      action: 'client.status_changed',
      entity_type: 'client',
      entity_id: req.params.id,
      details: { from: before.status, to: client.status }
    });
  } else {
    audit.logFromReq(req, {
      client_id: req.params.id,
      action: 'client.updated',
      entity_type: 'client',
      entity_id: req.params.id,
      details: { fields: Object.keys(req.body || {}) }
    });
  }

  res.json(client);
});

// Delete client
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Client not found' });

  // Pulizia file orfani: rimuovi tutta la cartella media del cliente
  try { postMedia.removeClientDir(req.params.id); }
  catch (err) { console.warn('[clients] cleanup failed for', req.params.id, err.message); }

  res.json({ success: true });
});

// Upload logo (SVG, JPG, PNG — raster images are wrapped in SVG)
router.post('/:id/logo', logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const db = getDb();
  const filename = `logo-${req.params.id}.svg`;
  const dest = path.join(__dirname, '..', '..', 'assets', filename);
  const isSvg = req.file.mimetype === 'image/svg+xml' || req.file.originalname.endsWith('.svg');

  if (isSvg) {
    fs.renameSync(req.file.path, dest);
  } else {
    // Convert JPG/PNG to SVG wrapper with embedded base64
    const imageData = fs.readFileSync(req.file.path);
    const base64 = imageData.toString('base64');
    const mimeType = req.file.mimetype === 'image/png' ? 'image/png' : 'image/jpeg';
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200" viewBox="0 0 200 200">
  <image width="200" height="200" href="data:${mimeType};base64,${base64}" />
</svg>`;
    fs.writeFileSync(dest, svgContent);
    // Remove temp file
    fs.unlinkSync(req.file.path);
  }

  db.prepare("UPDATE clients SET logo_filename = ?, updated_at = datetime('now') WHERE id = ?").run(filename, req.params.id);
  res.json({ filename });
});

// Serve logo preview (extracts raw image from SVG wrapper for raster logos)
router.get('/:id/logo-preview', (req, res) => {
  const filename = `logo-${req.params.id}.svg`;
  const filepath = path.join(__dirname, '..', '..', 'assets', filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Logo non trovato' });
  }

  const svg = fs.readFileSync(filepath, 'utf-8');
  // Check if it's a raster-wrapped SVG (contains embedded base64 image)
  const dataUriMatch = svg.match(/href="data:(image\/(?:png|jpeg));base64,([^"]+)"/);
  if (dataUriMatch) {
    // Serve the raw image directly (browsers block data: URIs inside SVG loaded via <img>)
    const mimeType = dataUriMatch[1];
    const base64Data = dataUriMatch[2];
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(Buffer.from(base64Data, 'base64'));
  } else {
    // Native SVG — serve as-is
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(svg);
  }
});

// Import logo from external URL
router.post('/:id/import-logo', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL immagine richiesto' });

  try {
    // Download image as binary
    const imageBuffer = await new Promise((resolve, reject) => {
      let targetUrl = url;
      if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

      const doFetch = (fetchUrl, redirectsLeft) => {
        const mod = fetchUrl.startsWith('https') ? https : http;
        const req = mod.get(fetchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 10000
        }, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            if (redirectsLeft <= 0) return reject(new Error('Troppi redirect'));
            let loc = response.headers.location;
            if (loc.startsWith('/')) {
              const u = new URL(fetchUrl);
              loc = u.protocol + '//' + u.host + loc;
            } else if (loc.startsWith('//')) {
              loc = 'https:' + loc;
            }
            return doFetch(loc, redirectsLeft - 1);
          }
          if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));

          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: response.headers['content-type'] || '' }));
          response.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', reject);
      };

      doFetch(targetUrl, 5);
    });

    const db = getDb();
    const filename = `logo-${req.params.id}.svg`;
    const dest = path.join(__dirname, '..', '..', 'assets', filename);
    const contentType = imageBuffer.contentType.toLowerCase();
    const buf = imageBuffer.buffer;

    if (contentType.includes('svg')) {
      // Native SVG
      fs.writeFileSync(dest, buf);
    } else {
      // Raster image (PNG, JPEG, etc.) — wrap in SVG
      const mimeType = contentType.includes('png') ? 'image/png' : 'image/jpeg';
      const base64 = buf.toString('base64');
      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200" viewBox="0 0 200 200">
  <image width="200" height="200" href="data:${mimeType};base64,${base64}" />
</svg>`;
      fs.writeFileSync(dest, svgContent);
    }

    db.prepare("UPDATE clients SET logo_filename = ?, updated_at = datetime('now') WHERE id = ?").run(filename, req.params.id);
    res.json({ filename, imported: true });
  } catch (err) {
    console.error('Import logo error:', err);
    res.status(500).json({ error: 'Impossibile scaricare il logo: ' + err.message });
  }
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

// Generate theme CSS from brand colors using AI
router.post('/:id/generate-theme', async (req, res) => {
  try {
    const db = getDb();
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { colors } = req.body;
    if (!colors || !Array.isArray(colors) || colors.length < 2) {
      return res.status(400).json({ error: 'Fornire almeno 2 colori brand (array di hex)' });
    }

    const css = await generateThemeCSS(client, colors);

    const filename = `${req.params.id}.css`;
    const dest = path.join(__dirname, '..', '..', 'templates', 'themes', filename);
    fs.writeFileSync(dest, css);
    db.prepare("UPDATE clients SET theme_filename = ?, updated_at = datetime('now') WHERE id = ?").run(filename, req.params.id);

    // Parse generated CSS to extract colors
    const parsedColors = {};
    const varRegex = /--([\w-]+)\s*:\s*([^;]+);/g;
    let match;
    while ((match = varRegex.exec(css)) !== null) {
      parsedColors['--' + match[1]] = match[2].trim();
    }

    res.json({ filename, css, colors: parsedColors });
  } catch (err) {
    console.error('Generate theme error:', err);
    res.status(500).json({ error: err.message || 'Errore durante la generazione del tema' });
  }
});

// Get theme colors from current CSS
router.get('/:id/theme-colors', (req, res) => {
  const filename = `${req.params.id}.css`;
  const filepath = path.join(__dirname, '..', '..', 'templates', 'themes', filename);

  if (!fs.existsSync(filepath)) {
    return res.json({ exists: false, colors: {} });
  }

  const css = fs.readFileSync(filepath, 'utf-8');
  const colors = {};
  const varRegex = /--([\w-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = varRegex.exec(css)) !== null) {
    colors['--' + match[1]] = match[2].trim();
  }

  res.json({ exists: true, colors });
});

// Update theme colors manually
router.put('/:id/theme-colors', (req, res) => {
  const { colors } = req.body;
  if (!colors || typeof colors !== 'object') {
    return res.status(400).json({ error: 'Fornire un oggetto colors con le variabili CSS' });
  }

  const db = getDb();
  const filename = `${req.params.id}.css`;
  const dest = path.join(__dirname, '..', '..', 'templates', 'themes', filename);

  // Build CSS content
  const vars = Object.entries(colors)
    .map(([key, value]) => `    ${key}: ${value};`)
    .join('\n');
  const css = `:root {\n${vars}\n}\n`;

  fs.writeFileSync(dest, css);
  db.prepare("UPDATE clients SET theme_filename = ?, updated_at = datetime('now') WHERE id = ?").run(filename, req.params.id);

  res.json({ filename, css });
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

  // Extract logo candidates
  const logoUrls = [];
  // apple-touch-icon (high-res, best candidate)
  const appleIcon = html.match(/<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']apple-touch-icon["']/i);
  if (appleIcon) logoUrls.push(appleIcon[1]);
  // og:image
  const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (ogImg) logoUrls.push(ogImg[1]);
  // img tags with "logo" in class, id, alt, or src
  const logoImgPatterns = [
    /<img[^>]*src=["']([^"']+)["'][^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["']/gi,
    /<img[^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/gi
  ];
  for (const pattern of logoImgPatterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) logoUrls.push(m[1]);
  }
  // favicon (last resort, often small)
  const favicon = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
  if (favicon) logoUrls.push(favicon[1]);
  if (logoUrls.length) meta.logo_urls = [...new Set(logoUrls)];

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

  const result = await callAI(
    client,
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
    throw new Error('AI non ha restituito un JSON valido');
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

    // Resolve logo URLs to absolute
    if (meta.logo_urls && meta.logo_urls.length) {
      let baseUrl = url;
      if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
      try {
        const base = new URL(baseUrl);
        data.logo_urls = meta.logo_urls.map(u => {
          if (u.startsWith('http')) return u;
          if (u.startsWith('//')) return base.protocol + u;
          if (u.startsWith('/')) return base.origin + u;
          return base.origin + '/' + u;
        });
      } catch { data.logo_urls = meta.logo_urls; }
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('Scan website error:', err);
    res.status(500).json({ error: err.message || 'Errore durante la scansione del sito' });
  }
});

// Generate system instruction with AI
router.post('/:id/generate-system-instruction', async (req, res) => {
  try {
    const db = getDb();
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Get questionnaire responses
    let questionnaireResponses = null;
    const qId = req.body.questionnaire_id;

    if (qId) {
      const q = db.prepare('SELECT * FROM questionnaires WHERE id = ? AND client_id = ?').get(qId, req.params.id);
      if (q && q.responses) {
        questionnaireResponses = JSON.parse(q.responses);
      }
    } else {
      // Get the latest submitted questionnaire
      const q = db.prepare("SELECT * FROM questionnaires WHERE client_id = ? AND status = 'submitted' ORDER BY submitted_at DESC LIMIT 1").get(req.params.id);
      if (q && q.responses) {
        questionnaireResponses = JSON.parse(q.responses);
      }
    }

    const systemInstruction = await generateSystemInstruction(client, questionnaireResponses);

    res.json({ system_instruction: systemInstruction });
  } catch (err) {
    console.error('Generate system instruction error:', err);
    res.status(500).json({ error: err.message || 'Errore durante la generazione' });
  }
});

// ───────── Account-level insights (per cliente) ─────────

// Snapshot on-demand: utile per testare subito senza aspettare il cron 04:00.
// Il cron giornaliero resta la fonte principale per la serie storica.
router.post('/:id/insights/snapshot', async (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.fb_system_user_token || !client.fb_page_id) {
    return res.status(400).json({ error: 'Cliente senza fb_system_user_token/fb_page_id configurati' });
  }

  try {
    const { getPageToken } = require('../../lib/meta-publish');
    const { snapshotAccountInsights } = require('../../lib/insights');
    const pageToken = await getPageToken(client.fb_system_user_token, client.fb_page_id);
    const results = await snapshotAccountInsights(pageToken, client);
    res.json({ results });
  } catch (err) {
    console.error('[insights snapshot]', err);
    res.status(500).json({ error: err.message });
  }
});

// History account_insights (per grafici time-series)
router.get('/:id/insights/history', (req, res) => {
  const { getAccountInsightsHistory } = require('../../lib/insights');
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const rows = getAccountInsightsHistory(req.params.id, days);
  res.json({ days, rows });
});

// ───────── Media repair: detect MIME effettivo + rinomina con extension corretta ─────────
//
// Bug storico: l'endpoint /crop sovrascriveva il file .png con un blob JPEG
// (Cropper.js può ritornare JPEG). I file salvati hanno extension .png MA
// contenuto JPEG → Meta rifiuta al publish (errore 9004 "Only photo or video").
// Fixato in c8904d5 per i nuovi crop. Questo endpoint ripara retroattivamente
// i file già rotti: scansiona tutti i media immagine del cliente, detecta il
// MIME reale con file-type, rinomina i file mismatched + aggiorna il record DB.
//
// ?dry_run=1 → mostra cosa farebbe senza toccare i file
router.post('/:id/media/repair-mime', async (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT id, display_name FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const fsLib = require('fs');
  const pathLib = require('path');
  // file-type v16 (sincrono via fromBuffer/fromFile, no fileTypeFromFile)
  const FileType = require('file-type');

  const media = db.prepare(`
    SELECT pm.id, pm.post_id, pm.filename, pm.url, pm.kind, p.client_id
    FROM post_media pm
    JOIN posts p ON p.id = pm.post_id
    WHERE p.client_id = ? AND pm.kind = 'image'
  `).all(client.id);

  const dryRun = req.query.dry_run === '1';
  const results = { total: media.length, scanned: 0, fixed: 0, ok: 0, skipped: 0, errors: 0, details: [] };

  for (const m of media) {
    const dir = postMedia.postDir(m.client_id, m.post_id);
    const filePath = pathLib.join(dir, m.filename);
    if (!fsLib.existsSync(filePath)) {
      results.skipped++;
      results.details.push({ id: m.id, status: 'missing', filename: m.filename });
      continue;
    }
    results.scanned++;
    try {
      // v16: leggi i primi byte (magic numbers) e passali a fromBuffer
      const fd = fsLib.openSync(filePath, 'r');
      const head = Buffer.alloc(4100);
      fsLib.readSync(fd, head, 0, 4100, 0);
      fsLib.closeSync(fd);
      const detected = await FileType.fromBuffer(head);
      if (!detected) {
        results.skipped++;
        results.details.push({ id: m.id, status: 'unknown_mime', filename: m.filename });
        continue;
      }
      const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
      const correctExt = mimeToExt[detected.mime];
      if (!correctExt) {
        results.skipped++;
        results.details.push({ id: m.id, status: 'unsupported_mime', mime: detected.mime, filename: m.filename });
        continue;
      }
      const oldExt = pathLib.extname(m.filename).toLowerCase();
      const normalizedOldExt = oldExt === '.jpeg' ? '.jpg' : oldExt;
      const extMismatch = normalizedOldExt !== correctExt;

      // Check 2: PNG con canale alpha → IG rifiuta. Flatten necessario.
      let alphaToFlatten = false;
      if (detected.mime === 'image/png') {
        try {
          const sharp = require('sharp');
          const meta = await sharp(filePath).metadata();
          if (meta.hasAlpha) alphaToFlatten = true;
        } catch (e) { /* sharp non disponibile o file corrotto, skip alpha check */ }
      }

      if (!extMismatch && !alphaToFlatten) {
        results.ok++;
        continue;
      }

      const fixDetails = { id: m.id, mime: detected.mime, alpha_flattened: false, ext_renamed: false };

      if (alphaToFlatten) {
        if (dryRun) {
          fixDetails.status = 'would_flatten_alpha';
          fixDetails.filename = m.filename;
        } else {
          await postMedia.flattenPngAlpha(filePath);
          fixDetails.alpha_flattened = true;
        }
      }

      if (extMismatch) {
        const baseName = pathLib.basename(m.filename, oldExt);
        const newFilename = baseName + correctExt;
        const newPath = pathLib.join(dir, newFilename);
        const newUrl = postMedia.publicUrl(m.client_id, m.post_id, newFilename);
        fixDetails.from = m.filename;
        fixDetails.to = newFilename;
        if (dryRun) {
          fixDetails.status = fixDetails.status || 'would_fix';
        } else {
          fsLib.renameSync(filePath, newPath);
          db.prepare(`UPDATE post_media SET filename = ?, url = ?, bytes = ?, created_at = datetime('now') WHERE id = ?`)
            .run(newFilename, newUrl, fsLib.statSync(newPath).size, m.id);
          fixDetails.ext_renamed = true;
          fixDetails.status = 'fixed';
        }
      } else if (alphaToFlatten && !dryRun) {
        // Solo flatten, niente rename. Aggiorna comunque bytes nel DB.
        db.prepare(`UPDATE post_media SET bytes = ?, created_at = datetime('now') WHERE id = ?`)
          .run(fsLib.statSync(filePath).size, m.id);
        fixDetails.status = 'flattened';
        fixDetails.filename = m.filename;
      }

      results.fixed++;
      results.details.push(fixDetails);
    } catch (err) {
      results.errors++;
      results.details.push({ id: m.id, status: 'error', filename: m.filename, error: err.message });
    }
  }

  audit.logFromReq(req, {
    client_id: client.id,
    action: 'media.repair_mime',
    entity_type: 'client',
    entity_id: client.id,
    details: { total: results.total, scanned: results.scanned, fixed: results.fixed, errors: results.errors, dry_run: dryRun }
  });
  res.json({ dry_run: dryRun, ...results });
});

// Insights overview admin (autenticato): panoramica per la pagina /dashboard/insights
router.get('/_admin/insights/overview', (req, res) => {
  const insights = require('../../lib/insights');
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  res.json({ days, overview: insights.getInsightsOverview(days) });
});

// Insights dettaglio admin per un cliente specifico (autenticato): dati live
// per la pagina /dashboard/insights/client/:id. Stesso payload della view
// pubblica `insights-share/public/:token/data` ma senza token.
router.get('/_admin/insights/client/:id', (req, res) => {
  const insights = require('../../lib/insights');
  const db = getDb();
  const client = db.prepare('SELECT id, display_name, sector, location, logo_filename FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente non trovato' });
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  res.json({
    client: { id: client.id, display_name: client.display_name, sector: client.sector, location: client.location, has_logo: !!client.logo_filename },
    period: { days, label: 'Vista admin' },
    summary: insights.getAccountSummary(client.id, days),
    history: insights.getAccountInsightsHistory(client.id, days),
    top_posts: insights.getTopPosts(client.id, days, 10),
    generated_at: new Date().toISOString()
  });
});

// Migrazione bulk: sostituisci una stringa nell'URL di TUTTI i post_media.
// Usato quando si cambia il dominio host delle immagini (es. img.emc → media.emc
// per bypassare un block Meta sul dominio precedente).
//
// Body: { "from": "img.emcdigitalsolutions.it", "to": "media.emcdigitalsolutions.it" }
// Optional ?dry_run=1
router.post('/_admin/migrate-media-url', async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'Body { from, to } richiesto' });
  if (from === to) return res.status(400).json({ error: 'from e to identici' });
  const dryRun = req.query.dry_run === '1';

  const db = getDb();
  const matching = db.prepare(`SELECT COUNT(*) AS n FROM post_media WHERE url LIKE ?`).get(`%${from}%`);
  if (!matching.n) return res.json({ matched: 0, updated: 0, dry_run: dryRun, note: 'Nessun media da aggiornare' });

  if (dryRun) {
    const sample = db.prepare(`SELECT id, url FROM post_media WHERE url LIKE ? LIMIT 3`).all(`%${from}%`);
    return res.json({ matched: matching.n, updated: 0, dry_run: true, sample });
  }

  const result = db.prepare(`UPDATE post_media SET url = REPLACE(url, ?, ?) WHERE url LIKE ?`)
    .run(from, to, `%${from}%`);
  audit.logFromReq(req, {
    client_id: null,
    action: 'admin.migrate_media_url',
    entity_type: 'post_media',
    entity_id: null,
    details: { from, to, matched: matching.n, updated: result.changes }
  });
  res.json({ matched: matching.n, updated: result.changes, dry_run: false });
});

module.exports = router;
