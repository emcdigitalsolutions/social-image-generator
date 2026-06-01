/**
 * post-caption.js — composizione della caption finale di un post.
 *
 * La caption "grezza" scritta/generata dall'utente viene arricchita, SOLO al
 * momento della pubblicazione (e nell'anteprima), con due blocchi opzionali:
 *
 *   1. Menzioni: lista di @username. I post organici Meta non permettono di
 *      "taggare tutti gli amici" via API (viola le policy anti-spam), quindi
 *      traduciamo i tag persone in menzioni testuali @username — sicure e
 *      universali: IG e FB(Pagine) le rendono cliccabili automaticamente.
 *   2. Call To Action: i post organici Meta NON hanno bottoni CTA nativi
 *      (quelli sono solo per le ads). La CTA è quindi una riga di testo con
 *      una label (es. "Prenota ora") + un link/telefono opzionale. Su IG il
 *      link in caption non è cliccabile → di fatto rimanda al "link in bio".
 *
 * Tutte le funzioni qui sono PURE (nessun I/O) per essere testabili.
 */
'use strict';

const MAX_MENTIONS = 30;
const MAX_HANDLE_LEN = 30;

/**
 * Normalizza un input di menzioni (stringa o array) in un array di handle
 * puliti, ciascuno con un singolo prefisso "@", deduplicati (case-insensitive).
 *
 * Accetta separatori spazio/virgola/newline. Caratteri validi per gli handle
 * Meta: lettere, numeri, punto, underscore.
 *
 * @param {string|string[]|null} input
 * @returns {string[]} es. ["@mario_rossi", "@negozio.xyz"]
 */
function normalizeMentions(input) {
  if (input == null) return [];

  let tokens;
  if (Array.isArray(input)) {
    tokens = input;
  } else if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return [];
    // Può arrivare come JSON array serializzato (dal DB) o testo libero.
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        tokens = Array.isArray(parsed) ? parsed : [s];
      } catch {
        tokens = s.split(/[\s,]+/);
      }
    } else {
      tokens = s.split(/[\s,]+/);
    }
  } else {
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const raw of tokens) {
    if (typeof raw !== 'string') continue;
    // Rimuovi @ iniziali e caratteri non validi, taglia alla lunghezza max.
    const handle = raw.trim().replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, MAX_HANDLE_LEN);
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push('@' + handle);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

/**
 * Per la visualizzazione: se l'URL è un telefono (tel:... o +numero), mostra il
 * numero "nudo"; altrimenti l'URL così com'è (rimuovendo eventuale spazio).
 */
function displayCtaTarget(url) {
  const u = (url || '').trim();
  if (!u) return '';
  if (/^tel:/i.test(u)) return u.replace(/^tel:/i, '').trim();
  return u;
}

/**
 * Costruisce la riga CTA da label + url. Ritorna '' se entrambi vuoti.
 * Formati:
 *   label + url  → "👉 Prenota ora: https://sito.it/prenota"
 *   solo label   → "👉 Prenota ora"
 *   solo url     → "👉 https://sito.it/prenota"
 */
function formatCtaLine(label, url) {
  const l = (label || '').trim();
  const target = displayCtaTarget(url);
  if (!l && !target) return '';
  if (l && target) return `👉 ${l}: ${target}`;
  return `👉 ${l || target}`;
}

/**
 * Compone la caption finale di un post unendo, in quest'ordine:
 *   caption base · menzioni · CTA
 * separati da una riga vuota. Salta i blocchi vuoti. Idempotenza: se il post
 * non ha menzioni né CTA, ritorna la caption base invariata (trim trailing).
 *
 * @param {object} post - { caption, mentions, cta_label, cta_url }
 * @returns {string}
 */
function composeCaption(post) {
  if (!post) return '';
  const base = (post.caption || '').replace(/\s+$/, '');
  const mentions = normalizeMentions(post.mentions);
  const ctaLine = formatCtaLine(post.cta_label, post.cta_url);

  const blocks = [];
  if (base) blocks.push(base);
  if (mentions.length) blocks.push(mentions.join(' '));
  if (ctaLine) blocks.push(ctaLine);

  return blocks.join('\n\n').trim();
}

module.exports = {
  composeCaption,
  normalizeMentions,
  formatCtaLine,
  displayCtaTarget,
  MAX_MENTIONS,
  MAX_HANDLE_LEN
};
