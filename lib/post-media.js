/**
 * post-media.js — helper per gestione media dei post (carousel + video).
 * Storage: public/images/{client_id}/posts/{post_id}/
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const FileType = require('file-type');
const imageSize = require('image-size');
const { getDb } = require('./db');
const { getBaseUrl } = require('./settings');

// Range aspect ratio accettato da Instagram per i post feed.
// FB è più tollerante, IG invece rifiuta tutto fuori da [0.8, 1.91].
const IG_MIN_RATIO = 0.8;   // 4:5 verticale
const IG_MAX_RATIO = 1.91;  // 1.91:1 orizzontale quasi paesaggio

const PUBLIC_IMAGES_ROOT = path.join(__dirname, '..', 'public', 'images');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov']);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;     // 8 MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;   // 100 MB
const MAX_CAROUSEL_ITEMS = 10;

function postDir(clientId, postId) {
  return path.join(PUBLIC_IMAGES_ROOT, clientId, 'posts', postId);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Sposta un file tra paths. Gestisce il caso EXDEV (cross-device)
// che capita in Docker quando tmp è sul root filesystem e dest su un volume.
function moveSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function publicUrl(clientId, postId, filename) {
  return `${getBaseUrl()}/images/${clientId}/posts/${postId}/${filename}`;
}

function classifyExt(originalName, mimetype) {
  const ext = (path.extname(originalName) || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', ext };
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', ext };
  // Fallback su mimetype se ext mancante
  if (mimetype && mimetype.startsWith('image/')) {
    if (mimetype.includes('jpeg') || mimetype.includes('jpg')) return { kind: 'image', ext: '.jpg' };
    if (mimetype.includes('png'))                              return { kind: 'image', ext: '.png' };
    if (mimetype.includes('webp'))                             return { kind: 'image', ext: '.webp' };
  }
  if (mimetype && mimetype.startsWith('video/')) {
    if (mimetype.includes('mp4'))   return { kind: 'video', ext: '.mp4' };
    if (mimetype.includes('quicktime')) return { kind: 'video', ext: '.mov' };
  }
  return null;
}

function nextPosition(postId) {
  const db = getDb();
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM post_media WHERE post_id = ?').get(postId);
  return row.next;
}

function listMedia(postId) {
  const db = getDb();
  return db.prepare('SELECT * FROM post_media WHERE post_id = ? ORDER BY position ASC').all(postId);
}

function getMedia(mediaId) {
  const db = getDb();
  return db.prepare('SELECT * FROM post_media WHERE id = ?').get(mediaId);
}

/**
 * Validazione magic number: leggiamo i primi 4100 bytes del file (più che
 * sufficiente per qualunque header noto) e verifichiamo che il file reale
 * corrisponda al kind dichiarato dall'estensione/mimetype. Previene:
 * - .exe rinominati .mp4
 * - file corrotti senza header valido
 * - mismatch tipo (es. PDF con estensione .png)
 */
async function validateMagicNumber(tmpPath, expectedKind) {
  const fd = fs.openSync(tmpPath, 'r');
  let buf;
  try {
    buf = Buffer.alloc(4100);
    const bytesRead = fs.readSync(fd, buf, 0, 4100, 0);
    buf = buf.slice(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  const detected = await FileType.fromBuffer(buf);
  if (!detected) {
    throw new Error('Tipo file non riconosciuto: header non valido');
  }
  // detected.mime es. 'image/jpeg', 'video/mp4'
  const detectedKind = detected.mime.startsWith('image/') ? 'image'
                     : detected.mime.startsWith('video/') ? 'video' : null;
  if (detectedKind !== expectedKind) {
    throw new Error(`Mismatch tipo file: dichiarato ${expectedKind}, contenuto reale ${detected.mime} (${detected.ext})`);
  }
  // Whitelist mime accettati per kind
  const ACCEPT = {
    image: new Set(['image/jpeg', 'image/png', 'image/webp']),
    video: new Set(['video/mp4', 'video/quicktime'])
  };
  if (!ACCEPT[expectedKind].has(detected.mime)) {
    throw new Error(`Formato ${detected.mime} non accettato per ${expectedKind}`);
  }
  return detected;
}

/**
 * Normalizza un'immagine per pubblicazione Meta (FB/IG):
 *   - PNG con alpha → flatten contro sfondo bianco (IG rifiuta trasparenza)
 *   - Re-encode → strip metadata (ICC profile, EXIF) che Meta a volte
 *     non riesce a parsare correttamente
 *   - Force colorspace sRGB
 *
 * Sharp di default rimuove TUTTA la metadata se non si chiama .keepMetadata()/
 * .keepIccProfile(). Quindi il semplice re-encode è sufficiente per lo strip.
 *
 * Idempotente sul risultato: una seconda chiamata su un file già normalizzato
 * non lo rovina (re-encode con stessa qualità è quasi lossless).
 */
async function normalizeImageForMeta(filePath) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(filePath).metadata();
    if (!['png', 'jpeg'].includes(meta.format)) {
      return { changed: false, reason: 'unsupported-format', format: meta.format };
    }

    let pipeline = sharp(filePath).toColorspace('srgb');

    if (meta.format === 'png' && meta.hasAlpha) {
      pipeline = pipeline.flatten({ background: '#ffffff' });
    }

    if (meta.format === 'jpeg') {
      // mozjpeg=false (default libjpeg-turbo): massima compatibilità con
      // parser stretti come quello di Meta. mozjpeg ottimizza dimensione ma
      // produce sintassi che alcuni decoder rifiutano.
      pipeline = pipeline.jpeg({ quality: 92, mozjpeg: false, progressive: false });
    } else {
      pipeline = pipeline.png({ compressionLevel: 9, palette: false });
    }

    const buf = await pipeline.toBuffer();
    fs.writeFileSync(filePath, buf);
    return { changed: true, format: meta.format, hadAlpha: !!meta.hasAlpha, hadIcc: !!meta.icc };
  } catch (err) {
    console.warn('[post-media] normalizeImageForMeta failed:', filePath, err.message);
    return { changed: false, error: err.message };
  }
}

/**
 * @deprecated usa normalizeImageForMeta. Wrapper per back-compat.
 */
async function flattenPngAlpha(filePath) {
  return normalizeImageForMeta(filePath);
}

/**
 * Sposta un file uploadato nella cartella del post e lo registra in DB.
 * Ritorna la riga DB del media inserito.
 */
async function attachUploadedFile({ clientId, postId, tmpPath, originalName, mimetype, source = 'upload' }) {
  const cls = classifyExt(originalName, mimetype);
  if (!cls) throw new Error(`Formato non supportato: ${originalName}`);

  const stat = fs.statSync(tmpPath);
  const limit = cls.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (stat.size > limit) {
    fs.unlinkSync(tmpPath);
    throw new Error(`File troppo grande (${Math.round(stat.size / 1024)}KB, max ${Math.round(limit / 1024)}KB)`);
  }

  // Magic number check — solo dopo size check (più economico)
  try {
    await validateMagicNumber(tmpPath, cls.kind);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }

  const dir = postDir(clientId, postId);
  ensureDir(dir);

  const id = uuidv4();
  const filename = `${source}-${id}${cls.ext}`;
  const dest = path.join(dir, filename);
  moveSync(tmpPath, dest);

  // Normalizza per Meta: flatten alpha + strip metadata (ICC/EXIF)
  if (cls.kind === 'image') {
    await normalizeImageForMeta(dest);
  }

  // Leggi dimensioni per IMMAGINI (video le gestisce Meta lato suo)
  let width = null, height = null, warnings = [];
  if (cls.kind === 'image') {
    try {
      const dim = imageSize(dest);
      if (dim && dim.width && dim.height) {
        width = dim.width;
        height = dim.height;
        const ratio = width / height;
        if (ratio < IG_MIN_RATIO || ratio > IG_MAX_RATIO) {
          const niceRatio = (ratio).toFixed(2);
          warnings.push(
            `Aspect ratio ${niceRatio}:1 (${width}x${height}) fuori dal range accettato da Instagram ` +
            `(4:5 verticale fino a 1.91:1 orizzontale). Facebook accetter\u00e0, IG rifiuter\u00e0 al publish. ` +
            `Usa il crop tool (click sulla thumb) per sistemarla a 1:1 o 4:5.`
          );
        }
      }
    } catch (err) {
      // Non blocco l'upload, solo warning diagnostico
      console.warn('[post-media] image-size failed for', filename, ':', err.message);
    }
  }

  // Bytes possono essere cambiati dopo il flatten — rileggiamo
  const finalSize = (cls.kind === 'image') ? fs.statSync(dest).size : stat.size;

  const db = getDb();
  const url = publicUrl(clientId, postId, filename);
  const position = nextPosition(postId);
  db.prepare(`
    INSERT INTO post_media (id, post_id, position, kind, source, filename, url, width, height, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, postId, position, cls.kind, source, filename, url, width, height, finalSize);

  const media = getMedia(id);
  // Attach warnings come campo non-persistente solo nella risposta
  if (warnings.length) media._warnings = warnings;
  return media;
}

/**
 * Registra un file generato direttamente sul filesystem (es. Puppeteer)
 * passando il path già scritto.
 */
function attachGeneratedFile({ clientId, postId, absolutePath, source = 'generated', styledFromId = null, kind = 'image' }) {
  if (!fs.existsSync(absolutePath)) throw new Error('File generato non trovato: ' + absolutePath);
  const dir = postDir(clientId, postId);
  ensureDir(dir);

  const ext = path.extname(absolutePath) || '.png';
  const id = uuidv4();
  const filename = `${source}-${id}${ext}`;
  const dest = path.join(dir, filename);
  moveSync(absolutePath, dest);

  const stat = fs.statSync(dest);
  const url = publicUrl(clientId, postId, filename);
  const position = nextPosition(postId);

  const db = getDb();
  db.prepare(`
    INSERT INTO post_media (id, post_id, position, kind, source, filename, url, bytes, styled_from_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, postId, position, kind, source, filename, url, stat.size, styledFromId);

  return getMedia(id);
}

function deleteMedia(mediaId) {
  const db = getDb();
  const m = getMedia(mediaId);
  if (!m) return false;

  const post = db.prepare('SELECT client_id FROM posts WHERE id = ?').get(m.post_id);
  if (post) {
    const filePath = path.join(postDir(post.client_id, m.post_id), m.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('DELETE FROM post_media WHERE id = ?').run(mediaId);
  // Ricompatta posizioni
  const remaining = db.prepare('SELECT id FROM post_media WHERE post_id = ? ORDER BY position ASC').all(m.post_id);
  const upd = db.prepare('UPDATE post_media SET position = ? WHERE id = ?');
  remaining.forEach((r, idx) => upd.run(idx, r.id));
  return true;
}

function reorder(postId, orderedIds) {
  const db = getDb();
  const upd = db.prepare('UPDATE post_media SET position = ? WHERE id = ? AND post_id = ?');
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => upd.run(idx, id, postId));
  });
  tx(orderedIds);
  return listMedia(postId);
}

/**
 * Valida che i media correnti siano coerenti col media_type indicato.
 * Lancia errore con messaggio user-facing se non coerente.
 */
function validateForMediaType(postId, mediaType) {
  const items = listMedia(postId);
  if (mediaType === 'story') {
    // Le storie sono suggerimenti per il cliente. Accettiamo 0 o 1 media di
    // riferimento, non c'è publish backend.
    if (items.length > 1) throw new Error('Storia: massimo 1 media di riferimento');
    return;
  }
  if (mediaType === 'single_image') {
    if (items.length > 1) throw new Error('Singola immagine: rimuovi i media in eccesso');
    if (items.length === 1 && items[0].kind !== 'image') throw new Error('Singola immagine: il media deve essere di tipo image');
  } else if (mediaType === 'carousel') {
    if (items.length < 2) throw new Error('Carousel: servono almeno 2 media');
    if (items.length > MAX_CAROUSEL_ITEMS) throw new Error(`Carousel: massimo ${MAX_CAROUSEL_ITEMS} media`);
    const kinds = new Set(items.map(i => i.kind));
    if (kinds.size > 1) throw new Error('Carousel: tutti i media devono essere dello stesso tipo (tutti image o tutti video)');
  } else if (mediaType === 'video' || mediaType === 'reel') {
    if (items.length !== 1) throw new Error(`${mediaType}: serve esattamente 1 video`);
    if (items[0].kind !== 'video') throw new Error(`${mediaType}: il media deve essere di tipo video`);
  } else {
    throw new Error('media_type non valido: ' + mediaType);
  }
}

/**
 * Rimuove la cartella di un singolo post (tutti i suoi media file).
 * Non tocca il DB. Da chiamare prima/dopo DELETE FROM posts.
 */
function removePostDir(clientId, postId) {
  const dir = postDir(clientId, postId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Rimuove l'intera cartella media di un cliente (tutti i post + immagini singole).
 * Non tocca il DB. Da chiamare prima/dopo DELETE FROM clients.
 */
function removeClientDir(clientId) {
  const dir = path.join(PUBLIC_IMAGES_ROOT, clientId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  PUBLIC_IMAGES_ROOT,
  IMAGE_EXTS, VIDEO_EXTS,
  MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MAX_CAROUSEL_ITEMS,
  postDir, ensureDir, publicUrl, classifyExt,
  listMedia, getMedia,
  attachUploadedFile, attachGeneratedFile, deleteMedia, reorder,
  validateForMediaType, flattenPngAlpha, normalizeImageForMeta,
  removePostDir, removeClientDir
};
