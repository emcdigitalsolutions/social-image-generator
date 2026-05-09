/**
 * client-library.js — libreria media per cliente (video + audio + immagini riusabili).
 * Storage: public/images/library/{client_id}/{audio,video,image}/<filename>
 *   (sotto public/images perché è il SOLO volume Coolify persistente —
 *    public/library nudo veniva azzerato a ogni restart container).
 * URL pubblico: /library/{client_id}/{kind}/<filename> (alias verso lo
 *   stesso filesystem, vedi server.js).
 * DB: client_media_library
 */
'use strict';

const fs = require('fs');
const path = require('path');
const FileType = require('file-type');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { getBaseUrl } = require('./settings');

const PUBLIC_LIBRARY_ROOT = path.join(__dirname, '..', 'public', 'images', 'library');

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;    // 15 MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;   // 100 MB
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;     // 8 MB target finale
// File immagine accettato fino a 50MB grezzi: sharp comprime sotto 8MB
const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;

const ACCEPT_MIME = {
  audio: new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave',
                  'audio/mp4', 'audio/x-m4a', 'audio/ogg']),
  video: new Set(['video/mp4', 'video/quicktime']),
  image: new Set(['image/jpeg', 'image/png', 'image/webp'])
};

function libraryDir(clientId, kind) {
  return path.join(PUBLIC_LIBRARY_ROOT, clientId, kind);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function moveSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function publicUrl(clientId, kind, filename) {
  return `${getBaseUrl()}/library/${clientId}/${kind}/${filename}`;
}

function classifyExt(originalName, mimetype) {
  const ext = (path.extname(originalName) || '').toLowerCase();
  if (AUDIO_EXTS.has(ext)) return { kind: 'audio', ext };
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', ext };
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', ext: ext === '.jpeg' ? '.jpg' : ext };
  if (mimetype && mimetype.startsWith('audio/')) {
    if (mimetype.includes('mpeg') || mimetype.includes('mp3')) return { kind: 'audio', ext: '.mp3' };
    if (mimetype.includes('wav'))  return { kind: 'audio', ext: '.wav' };
    if (mimetype.includes('m4a') || mimetype.includes('mp4')) return { kind: 'audio', ext: '.m4a' };
    if (mimetype.includes('ogg'))  return { kind: 'audio', ext: '.ogg' };
  }
  if (mimetype && mimetype.startsWith('video/')) {
    if (mimetype.includes('mp4'))       return { kind: 'video', ext: '.mp4' };
    if (mimetype.includes('quicktime')) return { kind: 'video', ext: '.mov' };
  }
  if (mimetype && mimetype.startsWith('image/')) {
    if (mimetype.includes('jpeg') || mimetype.includes('jpg')) return { kind: 'image', ext: '.jpg' };
    if (mimetype.includes('png'))                              return { kind: 'image', ext: '.png' };
    if (mimetype.includes('webp'))                             return { kind: 'image', ext: '.webp' };
  }
  return null;
}

async function validateMagicNumber(tmpPath, expectedKind) {
  const fd = fs.openSync(tmpPath, 'r');
  let buf;
  try {
    buf = Buffer.alloc(4100);
    const n = fs.readSync(fd, buf, 0, 4100, 0);
    buf = buf.slice(0, n);
  } finally {
    fs.closeSync(fd);
  }
  const detected = await FileType.fromBuffer(buf);
  if (!detected) throw new Error('Tipo file non riconosciuto: header non valido');
  const detectedKind = detected.mime.startsWith('audio/') ? 'audio'
                     : detected.mime.startsWith('video/') ? 'video'
                     : detected.mime.startsWith('image/') ? 'image' : null;
  if (detectedKind !== expectedKind) {
    throw new Error(`Mismatch tipo file: dichiarato ${expectedKind}, contenuto reale ${detected.mime}`);
  }
  if (!ACCEPT_MIME[expectedKind].has(detected.mime)) {
    throw new Error(`Formato ${detected.mime} non accettato per ${expectedKind}`);
  }
  return detected;
}

/**
 * Riduce un'immagine sopra MAX_IMAGE_BYTES finché rientra. Strategia:
 *   1. resize a 2560px lato lungo, JPG q85 progressive
 *   2. se ancora oltre, 1920px q80
 *   3. se ancora oltre, 1440px q75
 * Sovrascrive il file in-place. Ritorna i nuovi metadata.
 * @param {string} tmpPath  file su disco (mutato)
 * @returns {Promise<{bytes:number, width:number, height:number, ext:string}>}
 */
async function compressImageInPlace(tmpPath) {
  const steps = [
    { maxSide: 2560, quality: 85 },
    { maxSide: 1920, quality: 80 },
    { maxSide: 1440, quality: 75 }
  ];
  let lastMeta = null;
  for (const step of steps) {
    const out = await sharp(tmpPath)
      .rotate()
      .resize({ width: step.maxSide, height: step.maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: step.quality, progressive: true, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (out.data.length <= MAX_IMAGE_BYTES) {
      fs.writeFileSync(tmpPath, out.data);
      return { bytes: out.data.length, width: out.info.width, height: out.info.height, ext: '.jpg' };
    }
    lastMeta = out;
  }
  // Fallback: scrivo comunque l'ultimo (più piccolo) ma segnalo
  fs.writeFileSync(tmpPath, lastMeta.data);
  if (lastMeta.data.length > MAX_IMAGE_BYTES) {
    throw new Error(`Immagine troppo complessa per scendere sotto ${Math.round(MAX_IMAGE_BYTES/1024/1024)}MB anche dopo compressione aggressiva`);
  }
  return { bytes: lastMeta.data.length, width: lastMeta.info.width, height: lastMeta.info.height, ext: '.jpg' };
}

/**
 * Lista la libreria visibile a clientId: include sia gli item del cliente
 * sia quelli con is_shared=1 (libreria comune fra tutti i clienti).
 * Gli item shared appartengono comunque al loro client_id originale ai fini
 * di delete/audit; il flag is_shared li rende solo READABLE da tutti.
 */
function listLibrary(clientId, kindFilter = null) {
  const db = getDb();
  if (kindFilter) {
    return db.prepare(
      'SELECT * FROM client_media_library WHERE (client_id = ? OR is_shared = 1) AND kind = ? ORDER BY is_shared ASC, created_at DESC'
    ).all(clientId, kindFilter);
  }
  return db.prepare(
    'SELECT * FROM client_media_library WHERE client_id = ? OR is_shared = 1 ORDER BY kind ASC, is_shared ASC, created_at DESC'
  ).all(clientId);
}

/**
 * Toggla il flag is_shared di un item della libreria.
 * @param {string} itemId
 * @param {boolean} shared
 * @returns {object|null} l'item aggiornato o null se non trovato
 */
function setShared(itemId, shared) {
  const db = getDb();
  const item = getLibraryItem(itemId);
  if (!item) return null;
  db.prepare('UPDATE client_media_library SET is_shared = ? WHERE id = ?').run(shared ? 1 : 0, itemId);
  return getLibraryItem(itemId);
}

function getLibraryItem(itemId) {
  const db = getDb();
  return db.prepare('SELECT * FROM client_media_library WHERE id = ?').get(itemId);
}

/**
 * Salva un file uploadato nella libreria del cliente. Idempotenza: se esiste
 * già un file con lo stesso filename sanitizzato lo prefissamo con timestamp.
 * @param {object} opts { clientId, tmpPath, originalName, mimetype }
 * @returns {Promise<object>} riga DB inserita
 */
async function addFromUpload({ clientId, tmpPath, originalName, mimetype }) {
  const cls = classifyExt(originalName, mimetype);
  if (!cls) throw new Error(`Formato non supportato: ${originalName}`);

  const stat = fs.statSync(tmpPath);
  const uploadLimit = cls.kind === 'video' ? MAX_VIDEO_BYTES
                    : cls.kind === 'image' ? MAX_IMAGE_UPLOAD_BYTES
                    : MAX_AUDIO_BYTES;
  if (stat.size > uploadLimit) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error(`File troppo grande (${Math.round(stat.size / 1024)}KB, max ${Math.round(uploadLimit / 1024)}KB)`);
  }

  try {
    await validateMagicNumber(tmpPath, cls.kind);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }

  // Auto-compressione immagine se sopra MAX_IMAGE_BYTES (8MB).
  // sharp ridimensiona + ricodifica in JPG progressive; aggiorna ext + size.
  let finalSize = stat.size;
  let finalExt  = cls.ext;
  let width = null, height = null;
  if (cls.kind === 'image') {
    if (stat.size > MAX_IMAGE_BYTES) {
      try {
        const meta = await compressImageInPlace(tmpPath);
        finalSize = meta.bytes; finalExt = meta.ext;
        width = meta.width; height = meta.height;
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
      }
    } else {
      try {
        const m = await sharp(tmpPath).metadata();
        width = m.width; height = m.height;
      } catch (_) { /* metadati opzionali */ }
    }
  }

  const dir = libraryDir(clientId, cls.kind);
  ensureDir(dir);

  const id = uuidv4();
  const filename = `${id}${finalExt}`;
  const dest = path.join(dir, filename);
  moveSync(tmpPath, dest);

  const url = publicUrl(clientId, cls.kind, filename);
  const db = getDb();
  db.prepare(`
    INSERT INTO client_media_library (id, client_id, kind, filename, original_name, url, bytes, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, clientId, cls.kind, filename, originalName || filename, url, finalSize, width, height);

  return getLibraryItem(id);
}

/**
 * Copia un file di libreria verso la cartella di un post (così rimane
 * indipendente: cancellando dalla libreria non si rompe il post).
 * Usata dall'endpoint /:id/library-attach.
 * @returns {Promise<string>} path assoluto del file copiato (input per attachGeneratedFile)
 */
function copyToPostDir({ libraryItem, destDir, destFilename }) {
  ensureDir(destDir);
  const src = path.join(libraryDir(libraryItem.client_id, libraryItem.kind), libraryItem.filename);
  if (!fs.existsSync(src)) throw new Error('File libreria non trovato su disco');
  const dest = path.join(destDir, destFilename);
  fs.copyFileSync(src, dest);
  return dest;
}

function deleteLibraryItem(itemId) {
  const db = getDb();
  const item = getLibraryItem(itemId);
  if (!item) return false;
  const filePath = path.join(libraryDir(item.client_id, item.kind), item.filename);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  catch (err) { console.warn('[client-library] delete file failed:', err.message); }
  db.prepare('DELETE FROM client_media_library WHERE id = ?').run(itemId);
  return true;
}

function removeClientLibraryDir(clientId) {
  const dir = path.join(PUBLIC_LIBRARY_ROOT, clientId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  PUBLIC_LIBRARY_ROOT,
  AUDIO_EXTS, VIDEO_EXTS, IMAGE_EXTS,
  MAX_AUDIO_BYTES, MAX_VIDEO_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_UPLOAD_BYTES,
  libraryDir, publicUrl,
  listLibrary, getLibraryItem,
  addFromUpload, copyToPostDir, deleteLibraryItem,
  removeClientLibraryDir
};
