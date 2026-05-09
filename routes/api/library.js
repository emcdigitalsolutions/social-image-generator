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
    if (clientLibrary.AUDIO_EXTS.has(ext)
     || clientLibrary.VIDEO_EXTS.has(ext)
     || clientLibrary.IMAGE_EXTS.has(ext)) cb(null, true);
    else cb(new Error('Formato non supportato. Audio: MP3/WAV/M4A/OGG · Video: MP4/MOV · Immagini: JPG/PNG/WEBP.'));
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
  const k = req.query.kind;
  const kind = (k === 'audio' || k === 'video' || k === 'image') ? k : null;
  const items = clientLibrary.listLibrary(req.params.clientId, kind);
  res.json({ items });
});

// Upload file in libreria. Accetta sia 'files' (multiplo) che 'file' (singolo,
// per compat). Risposta: { items: [...], errors: [...] } in caso multiplo;
// se viene caricato 1 solo file restituisce ANCHE l'item al top-level (compat).
router.post('/upload', upload.fields([
  { name: 'files', maxCount: 20 },
  { name: 'file',  maxCount: 1 }
]), async (req, res) => {
  const cleanupAll = () => {
    for (const list of Object.values(req.files || {})) {
      for (const f of list) { try { fs.unlinkSync(f.path); } catch (_) {} }
    }
  };
  if (!ensureClient(req, res)) { cleanupAll(); return; }

  const incoming = [
    ...((req.files && req.files.files) || []),
    ...((req.files && req.files.file)  || [])
  ];
  if (!incoming.length) return res.status(400).json({ error: 'Nessun file ricevuto' });

  const items = [];
  const errors = [];
  for (const f of incoming) {
    try {
      const item = await clientLibrary.addFromUpload({
        clientId: req.params.clientId,
        tmpPath: f.path,
        originalName: f.originalname,
        mimetype: f.mimetype
      });
      audit.logFromReq(req, {
        client_id: req.params.clientId,
        action: 'library.uploaded',
        entity_type: 'library_item',
        entity_id: item.id,
        details: { kind: item.kind, original_name: item.original_name, bytes: item.bytes }
      });
      items.push(item);
    } catch (err) {
      // addFromUpload pulisce il tmp se fallisce, ma rete sicurezza:
      try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) {}
      errors.push({ filename: f.originalname, error: err.message });
    }
  }

  // Status: 200 se almeno uno OK, 400 se TUTTI falliti.
  if (!items.length) return res.status(400).json({ items: [], errors });
  // Compat single-file: campo top-level oltre a items[]
  const out = { items, errors };
  if (incoming.length === 1 && items.length === 1) Object.assign(out, items[0]);
  res.json(out);
});

// Elimina un item dalla libreria
router.delete('/:itemId', (req, res) => {
  if (!ensureClient(req, res)) return;
  const db = getDb();
  const item = db.prepare(
    'SELECT * FROM client_media_library WHERE id = ? AND client_id = ?'
  ).get(req.params.itemId, req.params.clientId);
  if (!item) return res.status(404).json({ error: 'Item non trovato (solo il cliente proprietario può eliminarlo)' });

  const ok = clientLibrary.deleteLibraryItem(req.params.itemId);
  if (!ok) return res.status(500).json({ error: 'Cancellazione fallita' });

  audit.logFromReq(req, {
    client_id: req.params.clientId,
    action: 'library.deleted',
    entity_type: 'library_item',
    entity_id: req.params.itemId,
    details: { kind: item.kind, original_name: item.original_name, was_shared: !!item.is_shared }
  });
  res.json({ success: true });
});

// Toggla flag is_shared di un item. Solo il cliente proprietario può cambiarlo.
// Body: { shared: true|false }
router.patch('/:itemId/share', (req, res) => {
  if (!ensureClient(req, res)) return;
  const db = getDb();
  const item = db.prepare(
    'SELECT * FROM client_media_library WHERE id = ? AND client_id = ?'
  ).get(req.params.itemId, req.params.clientId);
  if (!item) return res.status(404).json({ error: 'Item non trovato (solo il cliente proprietario può condividerlo)' });

  const shared = !!(req.body && req.body.shared);
  const updated = clientLibrary.setShared(req.params.itemId, shared);
  audit.logFromReq(req, {
    client_id: req.params.clientId,
    action: shared ? 'library.shared' : 'library.unshared',
    entity_type: 'library_item',
    entity_id: req.params.itemId,
    details: { kind: item.kind, original_name: item.original_name }
  });
  res.json({ item: updated });
});

// One-shot: promuove a is_shared=1 tutti gli item del cliente di un certo kind.
// Body: { kind: 'audio'|'video'|'image' }  default 'audio'
router.post('/promote-all', (req, res) => {
  if (!ensureClient(req, res)) return;
  const kind = req.body && (req.body.kind === 'video' || req.body.kind === 'image') ? req.body.kind : 'audio';
  const db = getDb();
  const r = db.prepare(
    'UPDATE client_media_library SET is_shared = 1 WHERE client_id = ? AND kind = ? AND is_shared = 0'
  ).run(req.params.clientId, kind);
  audit.logFromReq(req, {
    client_id: req.params.clientId,
    action: 'library.bulk_shared',
    entity_type: 'client_media_library',
    entity_id: req.params.clientId,
    details: { kind, promoted: r.changes }
  });
  res.json({ promoted: r.changes });
});

module.exports = router;
