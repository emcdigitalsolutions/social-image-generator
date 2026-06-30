// library-match.js — abbina la caption di un post alle immagini della libreria
// del cliente. Due fasi:
//   1) ensureImageDescriptions: descrive (vision, una volta) le immagini prive di
//      descrizione e cachea il risultato in client_media_library.
//   2) pickImagesForCaption: dato il testo della caption, un LLM testuale sceglie
//      le immagini (già descritte) più coerenti e le ordina per pertinenza.
'use strict';

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const clientLibrary = require('./client-library');
const vision = require('./gemini-vision');
const { callGemini } = require('./gemini');

// Cap di immagini analizzate per singola chiamata: evita di sforare il timeout
// del proxy (~60s) quando una libreria ha molte immagini mai descritte. Le
// restanti si analizzano ai click successivi (la cache è incrementale).
const MAX_ANALYZE_PER_CALL = 12;

function _mimeFor(filename) {
  const ext = (path.extname(filename) || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function _safeTags(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

function _extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); }
  catch (_) { return null; }
}

/**
 * Analizza (vision) le immagini di libreria del cliente ancora prive di
 * descrizione, fino a un massimo per chiamata. Idempotente.
 * @returns {Promise<{analyzed:number, remaining:number, total:number}>}
 */
async function ensureImageDescriptions(clientId, apiKey, context = {}) {
  const db = getDb();
  const images = clientLibrary.listLibrary(clientId, 'image');
  const pending = images.filter(it => !it.description || !it.analyzed_at);

  let analyzed = 0;
  for (const it of pending) {
    if (analyzed >= MAX_ANALYZE_PER_CALL) break;
    const filePath = path.join(clientLibrary.libraryDir(it.client_id, 'image'), it.filename);
    if (!fs.existsSync(filePath)) continue;
    try {
      const buf = fs.readFileSync(filePath);
      const r = await vision.describeImage(apiKey, buf, _mimeFor(it.filename), context);
      db.prepare(`
        UPDATE client_media_library
        SET description = ?, tags = ?, vision_model = ?, analyzed_at = datetime('now')
        WHERE id = ?
      `).run(r.description, JSON.stringify(r.tags), vision.MODEL, it.id);
      analyzed++;
    } catch (err) {
      console.warn('[library-match] describe failed for', it.id, '-', err.message);
    }
  }

  return {
    analyzed,
    remaining: Math.max(0, pending.length - analyzed),
    total: images.length
  };
}

/**
 * Sceglie le immagini di libreria (già descritte) più coerenti con la caption.
 * @returns {Promise<Array<{item:object, reason:string}>>} ordinate per pertinenza
 */
async function pickImagesForCaption({ caption, clientId, count = 1, apiKey }) {
  const db = getDb();
  const images = clientLibrary.listLibrary(clientId, 'image').filter(i => i.description);
  if (!images.length) return [];
  if (images.length === 1) return [{ item: images[0], reason: 'unica immagine disponibile in libreria' }];

  const list = images.map((i, idx) =>
    `${idx + 1}. id=${i.id} | ${i.description} | tag: ${_safeTags(i.tags).join(', ')}`
  ).join('\n');

  const systemInstruction =
    'Sei un direttore creativo. Devi scegliere, da un archivio di immagini di repertorio, ' +
    'quelle visivamente e tematicamente più coerenti con il testo di un post social. ' +
    'Valuta soggetto, contesto e tono. Non inventare immagini: scegli solo tra quelle elencate.';

  const userPrompt = `TESTO DEL POST (caption):
"""
${caption}
"""

IMMAGINI DISPONIBILI (id | descrizione | tag):
${list}

Scegli le ${count} immagini PIÙ pertinenti al contenuto e al tono del post, ordinate dalla più adatta.
Se nessuna è davvero coerente, restituisci meno elementi (anche zero).

Rispondi SOLO con JSON valido:
{"picks":[{"id":"<id esatto dall'elenco>","reason":"<motivo in 6-12 parole>"}]}`;

  const { text } = await callGemini(apiKey, systemInstruction, userPrompt, { temperature: 0.3, maxTokens: 700 });
  const parsed = _extractJson(text);
  const rawPicks = (parsed && Array.isArray(parsed.picks)) ? parsed.picks : [];

  const byId = new Map(images.map(i => [i.id, i]));
  const seen = new Set();
  const out = [];
  for (const p of rawPicks) {
    const id = p && p.id;
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ item: byId.get(id), reason: (p.reason || '').toString().trim() });
    if (out.length >= count) break;
  }
  return out;
}

module.exports = { ensureImageDescriptions, pickImagesForCaption, MAX_ANALYZE_PER_CALL };
