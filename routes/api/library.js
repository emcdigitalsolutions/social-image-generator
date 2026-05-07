/**
 * library.js — endpoint libreria media per cliente.
 * Mount: /dashboard/api/clients/:clientId/library
 *
 * GET    /                       lista video+audio del cliente
 * POST   /upload                 upload file (multipart, field 'file', kind auto-detected)
 * DELETE /:itemId                rimuove item dalla libreria (file + DB)
 */
'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');

const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const clientLibrary = require('../../lib/client-library');
const audit = require('../../lib/audit');

// mergeParams=true per ereditare :clientId dal mount path in clients.js
const router = express.Router({ mergeParams: true });
router.use(authMiddleware);

const upload = multer({
  dest: path.join(os.tmpdir(), 'sig-library-upload'),
  limits: { fileSize: clientLibrary.MAX_VIDEO_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    if (clientLibrary.AUDIO_EXTS.has(ext) || clientLibrary.VIDEO_EXTS.has(ext)) cb(null, true);
    else cb(new Error('Formato non supportato. Audio: MP3/WAV/M4A/OGG. Video: MP4/MOV.'));
  }
});

function ensureClient(req, res) {
  const db = getDb();
  const c = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.clientId);
  if (!c) {
    res.status(404).json({ error: 'Cliente non trovato' });
    return null;
  }
  return c;
}

// Lista libreria del cliente (opz. filtro ?kind=audio|video)
router.get('/', (req, res) => {
  if (!ensureClient(req, res)) return;
  const kind = req.query.kind === 'audio' || req.query.kind === 'video' ? req.query.kind : null;
  const items = clientLibrary.listLibrary(req.params.clientId, kind);
  res.json({ items });
});

// Upload file in libreria
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!ensureClient(req, res)) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    return;
  }
  if (!req.file) return res.status(400).json({ error: 'File mancante' });

  try {
    const item = await clientLibrary.addFromUpload({
      clientId: req.params.clientId,
      tmpPath: req.file.path,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype
    });
    audit.logFromReq(req, {
      client_id: req.params.clientId,
      action: 'library.uploaded',
      entity_type: 'library_item',
      entity_id: item.id,
      details: { kind: item.kind, original_name: item.original_name, bytes: item.bytes }
    });
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Elimina un item dalla libreria
router.delete('/:itemId', (req, res) => {
  if (!ensureClient(req, res)) return;
  const db = getDb();
  const item = db.prepare(
    'SELECT * FROM client_media_library WHERE id = ? AND client_id = ?'
  ).get(req.params.itemId, req.params.clientId);
  if (!item) return res.status(404).json({ error: 'Item non trovato' });

  const ok = clientLibrary.deleteLibraryItem(req.params.itemId);
  if (!ok) return res.status(500).json({ error: 'Cancellazione fallita' });

  audit.logFromReq(req, {
    client_id: req.params.clientId,
    action: 'library.deleted',
    entity_type: 'library_item',
    entity_id: req.params.itemId,
    details: { kind: item.kind, original_name: item.original_name }
  });
  res.json({ success: true });
});

module.exports = router;
