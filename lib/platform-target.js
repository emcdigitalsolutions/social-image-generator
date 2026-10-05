/**
 * platform-target.js — per quali social scriviamo i testi di un cliente.
 *
 * I prompt AI erano scritti solo per Facebook/Instagram. Per i clienti
 * LinkedIn (es. settore associazione_ai, o con solo la Page LinkedIn
 * configurata) il testo deve essere professionale e un po' più lungo.
 */
'use strict';

const LINKEDIN_FIRST_SECTORS = new Set(['associazione_ai']);

function targetPlatforms(client) {
  const c = client || {};
  const hasMeta = !!(c.fb_page_id || c.ig_user_id);
  const hasLinkedIn = !!c.linkedin_org_id || LINKEDIN_FIRST_SECTORS.has(c.sector);
  if (hasLinkedIn && !hasMeta) return { label: 'LinkedIn', linkedinOnly: true, includesLinkedIn: true };
  if (hasLinkedIn) return { label: 'Facebook, Instagram e LinkedIn', linkedinOnly: false, includesLinkedIn: true };
  return { label: 'Facebook/Instagram', linkedinOnly: false, includesLinkedIn: false };
}

/** Regola di lunghezza da usare nel prompt caption. */
function lengthRule(client) {
  if (targetPlatforms(client).linkedinOnly) {
    return `- Il post è per LinkedIn: tono professionale, prima riga che aggancia (è l'unica visibile prima di "…altro"), corpo di circa 80-150 parole in paragrafi brevi.
- Un solo messaggio chiaro per post: niente ripetizioni, giri di parole o riempitivi.`;
  }
  return `- Il post deve essere BREVE e scorrevole: massimo 3-4 frasi nel corpo, circa 40-70 parole. Le persone si stancano a leggere post lunghi sui social.
- Un solo messaggio chiaro per post, dritto al punto: niente ripetizioni, giri di parole o riempitivi.`;
}

module.exports = { targetPlatforms, lengthRule, LINKEDIN_FIRST_SECTORS };
