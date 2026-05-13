'use strict';

const MONTHS_IT = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
];

// Restituisce l'anno-mese (es. {year:2026, month:8, label:'Agosto 2026'}) per
// il month_number del piano dato il start_year_month ('YYYY-MM'). Se startYM
// è nullo/invalido restituisce null — il chiamante mostrerà il fallback "Mese N".
function resolveCalendarMonth(monthNumber, startYM) {
  if (!startYM || typeof startYM !== 'string') return null;
  const m = startYM.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const startYear = parseInt(m[1], 10);
  const startMonth = parseInt(m[2], 10); // 1..12
  if (startMonth < 1 || startMonth > 12) return null;

  const n = parseInt(monthNumber, 10);
  if (!Number.isFinite(n) || n < 1) return null;

  // Indici 0-based per la matematica, poi rinormalizzo.
  const zeroBased = (startMonth - 1) + (n - 1);
  const year = startYear + Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return {
    year,
    month,
    name: MONTHS_IT[month - 1],
    label: `${MONTHS_IT[month - 1]} ${year}`,
    short: `${MONTHS_IT[month - 1].slice(0, 3)} ${year}`
  };
}

// "Mese 2 · Settembre 2026" oppure "Mese 2" se startYM mancante.
function fullMonthLabel(monthNumber, startYM) {
  const cal = resolveCalendarMonth(monthNumber, startYM);
  if (!cal) return `Mese ${monthNumber}`;
  return `Mese ${monthNumber} · ${cal.label}`;
}

module.exports = { MONTHS_IT, resolveCalendarMonth, fullMonthLabel };
