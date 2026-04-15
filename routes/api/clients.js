const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');

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
    'system_instruction', 'gemini_api_key', 'status', 'logo_filename', 'theme_filename'];

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

module.exports = router;
