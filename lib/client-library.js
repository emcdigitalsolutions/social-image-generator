/**
 * client-library.js — libreria media per cliente (video + audio riusabili).
 * Storage: public/library/{client_id}/{audio,video}/<filename>
 * DB: client_media_library
 */
'use strict';

const fs = require('fs');
const path = require('path');
const FileType = require('file-type');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { getBaseUrl } = require('./settings');

const PUBLIC_LIBRARY_ROOT = path.join(__dirname, '..', 'public', 'library');

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov']);

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;    // 15 MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;   // 100 MB

const ACCEPT_MIME = {
  audio: new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave',
                  'audio/mp4', 'audio/x-m4a', 'audio/ogg']),
  video: new Set(['video/mp4', 'video/quicktime'])
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
                     : detected.mime.startsWith('video/') ? 'video' : null;
  if (detectedKind !== expectedKind) {
    throw new Error(`Mismatch tipo file: dichiarato ${expectedKind}, contenuto reale ${detected.mime}`);
  }
  if (!ACCEPT_MIME[expectedKind].has(detected.mime)) {
    throw new Error(`Formato ${detected.mime} non accettato per ${expectedKind}`);
  }
  return detected;
}

function listLibrary(clientId, kindFilter = null) {
  const db = getDb();
  if (kindFilter) {
    return db.prepare(
      'SELECT * FROM client_media_library WHERE client_id = ? AND kind = ? ORDER BY created_at DESC'
    ).all(clientId, kindFilter);
  }
  return db.prepare(
    'SELECT * FROM client_media_library WHERE client_id = ? ORDER BY kind ASC, created_at DESC'
  ).all(clientId);
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
  const limit = cls.kind === 'video' ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
  if (stat.size > limit) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error(`File troppo grande (${Math.round(stat.size / 1024)}KB, max ${Math.round(limit / 1024)}KB)`);
  }

  try {
    await validateMagicNumber(tmpPath, cls.kind);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }

  const dir = libraryDir(clientId, cls.kind);
  ensureDir(dir);

  const id = uuidv4();
  const filename = `${id}${cls.ext}`;
  const dest = path.join(dir, filename);
  moveSync(tmpPath, dest);

  const url = publicUrl(clientId, cls.kind, filename);
  const db = getDb();
  db.prepare(`
    INSERT INTO client_media_library (id, client_id, kind, filename, original_name, url, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, clientId, cls.kind, filename, originalName || filename, url, stat.size);

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
  AUDIO_EXTS, VIDEO_EXTS,
  MAX_AUDIO_BYTES, MAX_VIDEO_BYTES,
  libraryDir, publicUrl,
  listLibrary, getLibraryItem,
  addFromUpload, copyToPostDir, deleteLibraryItem,
  removeClientLibraryDir
};
