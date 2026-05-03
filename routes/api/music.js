// Libreria musicale globale per slideshow Reel AI.
// Storage: public/music/ (servito staticamente come /music/<filename>)
// Endpoints:
//   GET    /            → lista tracce (mp3/wav/m4a)
//   POST   /upload      → carica file utente
//   POST   /generate    → genera traccia con MusicGen (Hugging Face)
//   DELETE /:filename   → rimuove file (con sanitize)

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { authMiddleware } = require('../../lib/auth');
const { getHuggingFaceKey, getReplicateKey } = require('../../lib/settings');
const musicGenerator = require('../../lib/music-generator');
const audit = require('../../lib/audit');

const MUSIC_DIR = path.join(__dirname, '..', '..', 'public', 'music');
const ACCEPTED_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg']);
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

router.use(authMiddleware);

function ensureDir() {
  if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

// Sanitize filename: solo lettere/numeri/dash/underscore + ext, niente .. niente /
function sanitizeFilename(name) {
  const ext = path.extname(name).toLowerCase();
  if (!ACCEPTED_EXTS.has(ext)) return null;
  const base = path.basename(name, ext)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accenti
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 60);
  if (!base) return null;
  return base + ext;
}

function listTracks() {
  ensureDir();
  const files = fs.readdirSync(MUSIC_DIR)
    .filter(f => ACCEPTED_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => {
      const stat = fs.statSync(path.join(MUSIC_DIR, f));
      return {
        filename: f,
        url: '/music/' + f,
        bytes: stat.size,
        modified_at: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return files;
}

router.get('/', (req, res) => {
  try {
    res.json({
      tracks: listTracks(),
      hf_configured: !!getHuggingFaceKey(),
      replicate_configured: !!getReplicateKey(),
      ai_configured: !!(getReplicateKey() || getHuggingFaceKey())
    });
  } catch (err) {
    res.status(500).json({ error: 'Lettura libreria fallita', details: err.message });
  }
});

const upload = multer({
  dest: path.join(os.tmpdir(), 'sig-music-upload'),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File mancante' });
  const cleanName = sanitizeFilename(req.file.originalname);
  if (!cleanName) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'Formato non supportato. Accetto MP3, WAV, M4A, OGG.' });
  }

  ensureDir();
  // Se esiste già un file con quel nome, prefisso con timestamp
  let dest = path.join(MUSIC_DIR, cleanName);
  if (fs.existsSync(dest)) {
    const ts = Date.now();
    const ext = path.extname(cleanName);
    const base = path.basename(cleanName, ext);
    dest = path.join(MUSIC_DIR, `${base}_${ts}${ext}`);
  }

  try {
    fs.renameSync(req.file.path, dest);
  } catch (err) {
    // EXDEV cross-device: fallback copy+unlink
    if (err.code === 'EXDEV') {
      fs.copyFileSync(req.file.path, dest);
      fs.unlinkSync(req.file.path);
    } else {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(500).json({ error: 'Salvataggio fallito', details: err.message });
    }
  }

  const filename = path.basename(dest);
  audit.logFromReq(req, {
    client_id: null,
    action: 'music.uploaded',
    entity_type: 'music_track',
    entity_id: filename,
    details: { bytes: fs.statSync(dest).size }
  });

  res.json({ filename, url: '/music/' + filename });
});

router.post('/generate', async (req, res) => {
  const replicateToken = getReplicateKey();
  const hfToken = getHuggingFaceKey();
  if (!replicateToken && !hfToken) {
    return res.status(400).json({
      error: 'Nessun provider audio configurato. Vai su Settings e aggiungi Replicate token (consigliato) o Hugging Face token.',
      help_url: 'https://replicate.com/account/api-tokens'
    });
  }

  const prompt = (req.body && typeof req.body.prompt === 'string' && req.body.prompt.trim()) || null;
  if (!prompt) return res.status(400).json({ error: 'prompt richiesto' });

  const durationSec = Math.max(5, Math.min(30, parseInt(req.body && req.body.duration_sec, 10) || 15));

  try {
    const result = await musicGenerator.generateMusic(
      { replicateToken, huggingfaceToken: hfToken },
      prompt,
      { durationSec }
    );

    ensureDir();
    // Filename derivato dal prompt + uuid corto per univocità
    const slug = prompt.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 30);
    const shortId = uuidv4().substring(0, 6);
    const filename = `ai_${slug || 'music'}_${shortId}.wav`;
    const dest = path.join(MUSIC_DIR, filename);
    fs.writeFileSync(dest, result.buffer);

    audit.logFromReq(req, {
      client_id: null,
      action: 'music.generated',
      entity_type: 'music_track',
      entity_id: filename,
      details: { prompt: prompt.substring(0, 200), duration_sec: durationSec, model: result.model }
    });

    res.json({
      filename,
      url: '/music/' + filename,
      duration_sec: durationSec,
      model: result.model,
      bytes: result.buffer.length
    });
  } catch (err) {
    console.error('[music/generate] error:', err.message);
    res.status(500).json({ error: 'Generazione musicale fallita', details: err.message });
  }
});

router.delete('/:filename', (req, res) => {
  const cleanName = sanitizeFilename(req.params.filename);
  if (!cleanName) return res.status(400).json({ error: 'Filename non valido' });

  const filePath = path.join(MUSIC_DIR, cleanName);
  // Defense-in-depth: assicura che il path risolto sia sotto MUSIC_DIR
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(MUSIC_DIR) + path.sep) && resolved !== path.resolve(MUSIC_DIR)) {
    return res.status(400).json({ error: 'Path traversal rifiutato' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File non trovato' });

  try {
    fs.unlinkSync(filePath);
    audit.logFromReq(req, {
      client_id: null,
      action: 'music.deleted',
      entity_type: 'music_track',
      entity_id: cleanName,
      details: {}
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Cancellazione fallita', details: err.message });
  }
});

module.exports = router;
