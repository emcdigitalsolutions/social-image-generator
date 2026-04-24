/**
 * view-helpers.js — funzioni esposte come res.locals per tutti i template EJS.
 *
 * Cablate in server.js via middleware globale, così da poter usare
 * `fmtRome(row.created_at)` direttamente negli `.ejs`.
 */
'use strict';

// Converte un timestamp SQLite ("YYYY-MM-DD HH:MM:SS", salvato in UTC da
// datetime('now')) nella stringa locale Europe/Rome — formato italiano.
// Ritorna il valore originale se non interpretabile.
function fmtRome(utcStr) {
  if (!utcStr) return '';
  const d = new Date(String(utcStr).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return utcStr;
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour12: false });
}

module.exports = { fmtRome };
