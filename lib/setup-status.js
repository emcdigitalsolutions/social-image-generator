/**
 * setup-status.js — stato di attivazione di un cliente.
 *
 * Calcola una checklist operativa che risponde alla domanda:
 * "questo cliente sta EFFETTIVAMENTE ricevendo il servizio per cui paga?"
 *
 * Usata da:
 *  - dashboard (badge "Setup incompleto" sulla card cliente)
 *  - client-detail (card "Stato attivazione" con checklist)
 *  - alert settimanale all'admin (clienti paganti fermi / token in scadenza)
 */
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Checklist di attivazione per un cliente.
 * @param {object} client riga clients
 * @param {object} db     better-sqlite3 db (per piano/schedule)
 * @returns {{checks: Array<{key:string,label:string,ok:boolean,critical:boolean,hint:string}>,
 *            criticalMissing:number, complete:boolean, isPaying:boolean}}
 */
function computeSetupStatus(client, db) {
  const checks = [];
  const add = (key, label, ok, critical, hint) => checks.push({ key, label, ok: !!ok, critical, hint });

  // 1. Canali social collegati (almeno uno pubblica davvero)
  const hasMeta = !!(client.fb_page_id && client.fb_system_user_token);
  const hasIg = !!client.ig_user_id;
  const hasLinkedin = !!(client.linkedin_org_id && client.linkedin_access_token);
  const hasTikTok = !!(client.tiktok_refresh_token || client.tiktok_access_token);
  const hasChannel = hasMeta || hasIg || hasLinkedin || hasTikTok;
  add('channels', 'Canali social collegati', hasChannel, true,
    hasChannel ? channelSummary({ hasMeta, hasIg, hasLinkedin, hasTikTok })
               : 'Nessun canale configurato: i post non possono essere pubblicati. Configura le credenziali social.');

  // 2. Piano editoriale
  const plan = db.prepare('SELECT id FROM editorial_plans WHERE client_id = ? LIMIT 1').get(client.id);
  add('plan', 'Piano editoriale creato', !!plan, true,
    plan ? '' : 'Genera il piano editoriale (o applica un template di settore).');

  // 3. Schedule attivo (pubblicazione automatica in corso)
  const activeSchedule = db.prepare(`
    SELECT s.id FROM schedules s
    JOIN editorial_plans ep ON ep.id = s.editorial_plan_id
    WHERE ep.client_id = ? AND s.is_active = 1 LIMIT 1
  `).get(client.id);
  add('schedule', 'Pubblicazione automatica attiva', !!activeSchedule, true,
    activeSchedule ? '' : 'Nessun mese attivo: apri il piano e premi "Attiva piano".');

  // 4. Email di contatto (approvazioni + report mensile)
  add('contact_email', 'Email di contatto', !!client.contact_email, false,
    client.contact_email ? '' : 'Senza email il cliente non riceve link di approvazione né report mensile.');

  // 5. Logo caricato (branding immagini)
  add('logo', 'Logo caricato', !!client.logo_filename, false,
    client.logo_filename ? '' : 'Carica il logo per il branding delle immagini.');

  // 6. Abbonamento registrato (tracciamento fatturato)
  add('subscription', 'Abbonamento registrato', !!client.subscription_plan, false,
    client.subscription_plan ? '' : 'Registra piano e prezzo per il tracciamento del servizio.');

  const criticalMissing = checks.filter(c => c.critical && !c.ok).length;
  return {
    checks,
    criticalMissing,
    complete: checks.every(c => c.ok),
    isPaying: !!client.subscription_plan
  };
}

function channelSummary({ hasMeta, hasIg, hasLinkedin, hasTikTok }) {
  const parts = [];
  if (hasMeta) parts.push('Facebook');
  if (hasIg) parts.push('Instagram');
  if (hasLinkedin) parts.push('LinkedIn');
  if (hasTikTok) parts.push('TikTok');
  return 'Attivi: ' + parts.join(', ');
}

/**
 * Scadenze token in avvicinamento per un cliente.
 * @returns {Array<{channel:string, expiresAt:string, daysLeft:number, expired:boolean}>}
 */
function tokenExpiryWarnings(client, now = Date.now()) {
  const out = [];
  const check = (channel, iso, warnDays) => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return;
    const daysLeft = Math.floor((t - now) / DAY_MS);
    if (daysLeft <= warnDays) {
      out.push({ channel, expiresAt: iso, daysLeft, expired: daysLeft < 0 });
    }
  };
  // LinkedIn: token 60gg, rinnovo manuale → avvisa con 14gg di anticipo
  if (client.linkedin_org_id || client.linkedin_access_token) {
    check('LinkedIn', client.linkedin_token_expires_at, 14);
  }
  // TikTok: refresh token 365gg → avvisa con 30gg di anticipo
  if (client.tiktok_refresh_token) {
    check('TikTok', client.tiktok_refresh_expires_at, 30);
  }
  return out;
}

/**
 * Report salute canali per l'alert settimanale all'admin.
 * Ritorna null se non c'è nulla da segnalare.
 */
function buildChannelHealthReport(db, now = Date.now()) {
  const clients = db.prepare(
    "SELECT * FROM clients WHERE status = 'active' AND deleted_at IS NULL ORDER BY display_name"
  ).all();

  const notActivated = []; // paganti senza setup critico completo
  const expiring = [];     // token in scadenza/scaduti

  for (const c of clients) {
    const status = computeSetupStatus(c, db);
    if (status.isPaying && status.criticalMissing > 0) {
      notActivated.push({
        id: c.id,
        name: c.display_name || c.id,
        plan: c.subscription_plan,
        price: c.subscription_price,
        missing: status.checks.filter(x => x.critical && !x.ok).map(x => x.label)
      });
    }
    for (const w of tokenExpiryWarnings(c, now)) {
      expiring.push({ id: c.id, name: c.display_name || c.id, ...w });
    }
  }

  if (!notActivated.length && !expiring.length) return null;
  return { notActivated, expiring };
}

module.exports = { computeSetupStatus, tokenExpiryWarnings, buildChannelHealthReport };
