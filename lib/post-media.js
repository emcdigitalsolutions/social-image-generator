/**
 * post-media.js — helper per gestione media dei post (carousel + video).
 * Storage: public/images/{client_id}/posts/{post_id}/
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { getBaseUrl } = require('./settings');

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
 * Sposta un file uploadato nella cartella del post e lo registra in DB.
 * Ritorna la riga DB del media inserito.
 */
function attachUploadedFile({ clientId, postId, tmpPath, originalName, mimetype, source = 'upload' }) {
  const cls = classifyExt(originalName, mimetype);
  if (!cls) throw new Error(`Formato non supportato: ${originalName}`);

  const stat = fs.statSync(tmpPath);
  const limit = cls.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (stat.size > limit) {
    fs.unlinkSync(tmpPath);
    throw new Error(`File troppo grande (${Math.round(stat.size / 1024)}KB, max ${Math.round(limit / 1024)}KB)`);
  }

  const dir = postDir(clientId, postId);
  ensureDir(dir);

  const id = uuidv4();
  const filename = `${source}-${id}${cls.ext}`;
  const dest = path.join(dir, filename);
  moveSync(tmpPath, dest);

  const db = getDb();
  const url = publicUrl(clientId, postId, filename);
  const position = nextPosition(postId);
  db.prepare(`
    INSERT INTO post_media (id, post_id, position, kind, source, filename, url, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, postId, position, cls.kind, source, filename, url, stat.size);

  return getMedia(id);
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
  validateForMediaType,
  removePostDir, removeClientDir
};
