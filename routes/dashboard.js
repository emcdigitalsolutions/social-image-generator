const express = require('express');
const { getDb } = require('../lib/db');
const { pageAuthMiddleware, verifyToken } = require('../lib/auth');
const { SETTORI, getQuestionnaireConfig } = require('../lib/questionnaire-config');
const audit = require('../lib/audit');
const notifier = require('../lib/notifier');

const router = express.Router();

// Login page (no auth)
router.get('/login', (req, res) => {
  res.render('login', { title: 'Login' });
});

// Public approval page (no auth, token-based)
// Il cliente apre il link che gli arriva tipo /dashboard/approve/<token>
// e vede la pagina di approvazione mensile.
router.get('/approve/:token', (req, res) => {
  const db = getDb();
  const approval = db.prepare('SELECT * FROM monthly_approvals WHERE token = ?').get(req.params.token);
  if (!approval) {
    return res.status(404).render('approval-error', { title: 'Link non valido', message: 'Il link di approvazione non &egrave; valido o &egrave; stato revocato. Contatta il tuo gestore social per riceverne uno nuovo.' });
  }
  if (approval.expires_at && new Date(approval.expires_at) < new Date()) {
    return res.status(410).render('approval-error', { title: 'Link scaduto', message: 'Questo link di approvazione &egrave; scaduto. Contatta il tuo gestore social per riceverne uno nuovo.' });
  }
  const plan = db.prepare('SELECT id, title, client_id, start_year_month FROM editorial_plans WHERE id = ?').get(approval.editorial_plan_id);
  const client = db.prepare('SELECT id, display_name, brand_name FROM clients WHERE id = ?').get(plan.client_id);
  res.render('approval-public', {
    title: `Approvazione mese ${approval.month_number} — ${client.display_name}`,
    token: req.params.token,
    approval,
    plan,
    client
  });
});

// Public insights dashboard (no auth, token-based)
// Il cliente apre il link tipo /dashboard/insights/<token> e vede la dashboard
// con KPI account-level + top post degli ultimi N giorni.
router.get('/insights/:token', (req, res) => {
  const db = getDb();
  const link = db.prepare('SELECT * FROM insights_share_links WHERE token = ? AND status = ?').get(req.params.token, 'active');
  if (!link) {
    return res.status(404).render('approval-error', { title: 'Link non valido', message: 'Il link &egrave; stato revocato o non &egrave; valido. Contatta il tuo gestore social per riceverne uno nuovo.' });
  }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return res.status(410).render('approval-error', { title: 'Link scaduto', message: 'Questo link &egrave; scaduto. Contatta il tuo gestore social per riceverne uno nuovo.' });
  }
  const client = db.prepare('SELECT id, display_name, sector, location, logo_filename FROM clients WHERE id = ?').get(link.client_id);
  res.render('insights-public', {
    title: `Performance — ${client.display_name}`,
    token: req.params.token,
    client,
    link
  });
});

// Public questionnaire (no auth)
router.get('/q/:token', (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT q.*, c.display_name as client_name FROM questionnaires q JOIN clients c ON c.id = q.client_id WHERE q.token = ?').get(req.params.token);
  if (!q) return res.status(404).render('login', { title: 'Non trovato', error: 'Questionario non trovato' });

  const config = q.sector ? getQuestionnaireConfig(q.sector) : null;
  res.render('questionnaire-public', {
    questionnaire: q,
    config,
    sectors: Object.entries(SETTORI).map(([k, v]) => ({ key: k, label: v.label })),
    title: `Questionario — ${q.client_name}`
  });
});

// Submit questionnaire (no auth)
router.post('/q/:token/submit', express.json(), (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM questionnaires WHERE token = ?').get(req.params.token);
  if (!q) return res.status(404).json({ error: 'Questionnaire not found' });

  const responses = (req.body && req.body.responses) || {};
  db.prepare(`
    UPDATE questionnaires SET responses = ?, status = 'submitted', submitted_at = datetime('now')
    WHERE token = ?
  `).run(JSON.stringify(responses), req.params.token);

  // Recap email a EMC (con il cliente in CC) — non blocca la risposta al cliente
  try {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(q.client_id);
    const fresh = db.prepare('SELECT * FROM questionnaires WHERE token = ?').get(req.params.token);
    Promise.resolve(notifier.sendQuestionnaireRecap({ client, questionnaire: fresh, responses }))
      .catch(err => console.error('[questionnaire] recap email error:', err.message));
  } catch (err) {
    console.error('[questionnaire] recap email setup error:', err.message);
  }

  res.json({ success: true, message: 'Grazie per aver compilato il questionario!' });
});

// Protected pages below
router.use(pageAuthMiddleware);

// Dashboard home: solo clienti NON archiviati
router.get('/', (req, res) => {
  const db = getDb();
  const clients = db.prepare(`
    SELECT * FROM clients
    WHERE status != 'archived' AND deleted_at IS NULL
    ORDER BY status = 'active' DESC, updated_at DESC
  `).all();
  const archivedCount = db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE status = 'archived' AND deleted_at IS NULL`).get().n;

  // Post stats per client
  const statsRows = db.prepare(`
    SELECT client_id,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft_count,
      SUM(CASE WHEN status IN ('caption_generated','image_generated') THEN 1 ELSE 0 END) as wip_count,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_count,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      MIN(CASE WHEN status = 'ready' AND scheduled_date IS NOT NULL
        THEN scheduled_date || ' ' || COALESCE(scheduled_time, '00:00') END) as next_scheduled
    FROM posts GROUP BY client_id
  `).all();

  const statsMap = {};
  const defaultStats = { draft_count: 0, wip_count: 0, ready_count: 0, published_count: 0, failed_count: 0, next_scheduled: null };
  for (const row of statsRows) statsMap[row.client_id] = row;
  clients.forEach(c => { c.stats = statsMap[c.id] || defaultStats; });

  // Stato attivazione: badge "Setup incompleto" sulla card cliente
  const { computeSetupStatus } = require('../lib/setup-status');
  clients.forEach(c => { c.setup = computeSetupStatus(c, db); });

  res.render('dashboard', { title: 'Dashboard', clients, archivedCount, user: req.user });
});

// Clienti archiviati: vista separata accessibile dalla sidebar
router.get('/archived', (req, res) => {
  const db = getDb();
  const clients = db.prepare(`
    SELECT * FROM clients WHERE status = 'archived' AND deleted_at IS NULL ORDER BY updated_at DESC
  `).all();
  res.render('archived', { title: 'Clienti archiviati', clients, user: req.user });
});

// Client detail
router.get('/clients/:id', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/dashboard');

  const questionnaires = db.prepare('SELECT * FROM questionnaires WHERE client_id = ? ORDER BY created_at DESC').all(req.params.id);
  const plans = db.prepare('SELECT * FROM editorial_plans WHERE client_id = ? ORDER BY created_at DESC').all(req.params.id);
  const sectors = Object.entries(SETTORI).map(([k, v]) => ({ key: k, label: v.label }));

  // Shortcut "mese in corso": prende il piano più rilevante (active > confirmed > draft,
  // più recente) e deriva il month_number dalla differenza calendariale tra il mese
  // solare corrente e plan.start_year_month. Fallback: scheduled_date nel mese solare,
  // poi primo mese con post non-published rimanenti.
  let currentMonthShortcut = null;
  const activePlan = db.prepare(`
    SELECT id, start_year_month FROM editorial_plans WHERE client_id = ?
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
      datetime(updated_at) DESC
    LIMIT 1
  `).get(req.params.id);
  if (activePlan) {
    let m = null;

    // 1. Preferito: calcolo dal start_year_month del piano
    const startYM = (activePlan.start_year_month || '').match(/^(\d{4})-(\d{2})$/);
    if (startYM) {
      const startYear = parseInt(startYM[1], 10);
      const startMonth = parseInt(startYM[2], 10);
      const now = new Date();
      const diff = (now.getFullYear() - startYear) * 12 + (now.getMonth() + 1 - startMonth) + 1;
      const maxRow = db.prepare(`
        SELECT MAX(month_number) AS max_m FROM posts
        WHERE editorial_plan_id = ? AND month_number IS NOT NULL
      `).get(activePlan.id);
      const maxM = (maxRow && maxRow.max_m) || 1;
      m = Math.max(1, Math.min(diff, maxM));
    }

    // 2. Fallback: post con scheduled_date nel mese solare corrente
    if (!m) {
      const row = db.prepare(`
        SELECT month_number, COUNT(*) AS n FROM posts
        WHERE editorial_plan_id = ?
          AND substr(scheduled_date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')
        GROUP BY month_number ORDER BY n DESC LIMIT 1
      `).get(activePlan.id);
      m = row && row.month_number;
    }

    // 3. Fallback finale: primo mese con post non-published rimanenti
    if (!m) {
      const fb = db.prepare(`
        SELECT month_number FROM posts
        WHERE editorial_plan_id = ? AND status != 'published' AND month_number IS NOT NULL
        ORDER BY month_number ASC LIMIT 1
      `).get(activePlan.id);
      m = fb && fb.month_number;
    }

    if (m) {
      currentMonthShortcut = `/dashboard/clients/${req.params.id}/plan/${activePlan.id}/month/${m}`;
    }
  }

  // Onboarding checklist
  const onboardingSteps = {
    profile: !!(client.sector && client.location),
    social: !!(client.fb_page_id && client.fb_system_user_token),
    logo: !!client.logo_filename,
    questionnaire: questionnaires.some(q => q.status === 'submitted'),
    system_instruction: !!client.system_instruction,
    plan: plans.some(p => p.status !== 'draft'),
    theme: !!client.theme_filename
  };
  const onboarding = {
    ...onboardingSteps,
    completed: Object.values(onboardingSteps).filter(Boolean).length,
    total: Object.keys(onboardingSteps).length
  };

  // Stili visivi: parsati dal JSON salvato, con flag se sono i default (per la UI).
  const { parseVisualStyles, DEFAULT_VISUAL_STYLES } = require('../lib/visual-prompt');
  const visualStyles = parseVisualStyles(client.visual_styles);
  const visualStylesIsDefault = !client.visual_styles;

  // Stato attivazione (checklist servizio) + scadenze token
  const { computeSetupStatus, tokenExpiryWarnings } = require('../lib/setup-status');
  const setup = computeSetupStatus(client, db);
  const tokenWarnings = tokenExpiryWarnings(client);

  res.render('client-detail', { title: client.display_name, client, questionnaires, plans, sectors, onboarding, currentMonthShortcut, visualStyles, visualStylesIsDefault, defaultVisualStyles: DEFAULT_VISUAL_STYLES, setup, tokenWarnings, user: req.user });
});

// ── TikTok OAuth: connetti un account cliente (ottiene access+refresh token) ──
// Step 1: redirige l'admin all'authorize di TikTok. Lo state è firmato (JWT) e
// contiene il clientId, così al callback sappiamo a chi assegnare i token (e
// abbiamo protezione CSRF: lo state non è falsificabile senza JWT_SECRET).
router.get('/tiktok/connect/:id', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/dashboard');

  const { getTikTokClientKey, getBaseUrl } = require('../lib/settings');
  const clientKey = getTikTokClientKey();
  if (!clientKey) {
    return res.redirect('/dashboard/clients/' + client.id + '?tiktok=noappkey');
  }
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dashboard-dev-secret';
  const state = jwt.sign({ cid: client.id, p: 'tiktok' }, JWT_SECRET, { expiresIn: '10m' });
  const redirectUri = getBaseUrl().replace(/\/$/, '') + '/dashboard/tiktok/callback';

  const { buildAuthorizeUrl } = require('../lib/tiktok-oauth');
  res.redirect(buildAuthorizeUrl({ clientKey, redirectUri, state }));
});

// Step 2: callback. TikTok torna qui con code+state (o error). Scambiamo il code
// con i token e li salviamo sul cliente.
router.get('/tiktok/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const fail = (cid, msg) => res.redirect('/dashboard/clients/' + (cid || '') + '?tiktok=error&msg=' + encodeURIComponent(msg));

  if (error) return fail(null, error_description || error);
  if (!code || !state) return fail(null, 'Risposta TikTok incompleta (code/state mancanti)');

  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dashboard-dev-secret';
  let clientId;
  try {
    const decoded = jwt.verify(state, JWT_SECRET);
    if (decoded.p !== 'tiktok' || !decoded.cid) throw new Error('state non valido');
    clientId = decoded.cid;
  } catch (e) {
    return fail(null, 'State non valido o scaduto — riprova la connessione');
  }

  const db = getDb();
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.redirect('/dashboard');

  const { getTikTokClientKey, getTikTokClientSecret, getBaseUrl } = require('../lib/settings');
  const { exchangeCodeForToken } = require('../lib/tiktok-oauth');
  const redirectUri = getBaseUrl().replace(/\/$/, '') + '/dashboard/tiktok/callback';

  try {
    const tok = await exchangeCodeForToken({
      clientKey: getTikTokClientKey(),
      clientSecret: getTikTokClientSecret(),
      code: String(code),
      redirectUri
    });
    db.prepare(`
      UPDATE clients SET
        tiktok_access_token = ?,
        tiktok_refresh_token = ?,
        tiktok_open_id = ?,
        tiktok_token_expires_at = ?,
        tiktok_refresh_expires_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(tok.access_token, tok.refresh_token, tok.open_id, tok.token_expires_at, tok.refresh_expires_at, clientId);

    audit.logFromReq(req, {
      client_id: clientId,
      action: 'client.tiktok_connected',
      entity_type: 'client',
      entity_id: clientId,
      details: { open_id: tok.open_id, scope: tok.scope }
    });
    res.redirect('/dashboard/clients/' + clientId + '?tiktok=connected');
  } catch (e) {
    console.error('[tiktok-oauth] exchange fallito:', e.message);
    fail(clientId, e.message);
  }
});

// Plan editor
router.get('/clients/:id/plan/:planId', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/dashboard');

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.planId);
  if (!plan) return res.redirect(`/dashboard/clients/${req.params.id}`);
  if (plan.plan_data) plan.plan_data = JSON.parse(plan.plan_data);

  // KPI per mese: contatori per status per ogni mese del piano
  const statsRows = db.prepare(`
    SELECT month_number,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_count,
      SUM(CASE WHEN status IN ('caption_generated','image_generated') THEN 1 ELSE 0 END) AS wip_count,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
    FROM posts WHERE editorial_plan_id = ?
    GROUP BY month_number
  `).all(req.params.planId);
  const monthStats = {};
  statsRows.forEach(r => { monthStats[r.month_number] = r; });

  res.render('plan-editor', { title: `Piano - ${client.display_name}`, client, plan, monthStats, user: req.user });
});

// Month view
router.get('/clients/:id/plan/:planId/month/:month', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/dashboard');

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.planId);
  if (!plan) return res.redirect(`/dashboard/clients/${req.params.id}`);
  if (plan.plan_data) plan.plan_data = JSON.parse(plan.plan_data);

  const posts = db.prepare(`
    SELECT * FROM posts WHERE editorial_plan_id = ? AND month_number = ?
    ORDER BY week_number ASC, position ASC, scheduled_date ASC, created_at ASC
  `).all(req.params.planId, parseInt(req.params.month));

  // Per ogni post: se image_url (legacy) è vuoto, prendi il primo media immagine da post_media
  const previewStmt = db.prepare(`
    SELECT url FROM post_media WHERE post_id = ? AND kind = 'image' ORDER BY position ASC LIMIT 1
  `);
  // Ultimo commento del cliente per post con change_requested / rejected (per visualizzazione nella card)
  const lastClientCommentStmt = db.prepare(`
    SELECT text, created_at FROM post_comments
    WHERE post_id = ? AND author = 'client'
    ORDER BY created_at DESC LIMIT 1
  `);
  // Check aspect ratio: se il cliente ha IG e almeno un'immagine è fuori range → flag has_bad_ratio
  const hasIg = !!client.ig_user_id;
  const imageMediaStmt = db.prepare(`
    SELECT width, height FROM post_media WHERE post_id = ? AND kind = 'image' AND width IS NOT NULL AND height IS NOT NULL
  `);
  for (const p of posts) {
    if (!p.image_url) {
      const row = previewStmt.get(p.id);
      if (row) p.image_url = row.url;
    }
    if (p.approval_status === 'change_requested' || p.approval_status === 'rejected') {
      const c = lastClientCommentStmt.get(p.id);
      if (c) { p.last_client_comment = c.text; p.last_client_comment_at = c.created_at; }
    }
    if (hasIg) {
      const imgs = imageMediaStmt.all(p.id);
      const badImg = imgs.find(m => { const r = m.width / m.height; return r < 0.8 || r > 1.91; });
      if (badImg) {
        p.has_bad_ratio = true;
        p.bad_ratio_detail = `${(badImg.width / badImg.height).toFixed(2)}:1 (${badImg.width}×${badImg.height})`;
      }
    }
  }

  // Mappa code → name delle categorie del piano (es. "C1" → "Servizi offerti")
  const categoriesMap = {};
  if (plan.plan_data && Array.isArray(plan.plan_data.categories)) {
    for (const c of plan.plan_data.categories) {
      if (c && c.code) categoriesMap[c.code] = c.name || c.code;
    }
  }

  const schedule = db.prepare('SELECT * FROM schedules WHERE editorial_plan_id = ? AND month_number = ?').get(req.params.planId, parseInt(req.params.month));

  res.render('month-view', {
    title: `Mese ${req.params.month} - ${client.display_name}`,
    client, plan, posts, month: parseInt(req.params.month), schedule, categoriesMap, user: req.user
  });
});

// Post editor
router.get('/posts/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.redirect('/dashboard');
  if (post.image_data) post.image_data = JSON.parse(post.image_data);

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  const media = db.prepare('SELECT * FROM post_media WHERE post_id = ? ORDER BY position ASC').all(post.id);

  // Navigazione prev/next tra i post dello stesso mese/piano, nello stesso ordine
  // della vista mensile (week_number, position, scheduled_date, created_at).
  let prevPostId = null, nextPostId = null, monthUrl = null;
  if (post.editorial_plan_id && post.month_number) {
    const siblings = db.prepare(`
      SELECT id FROM posts
      WHERE editorial_plan_id = ? AND month_number = ?
      ORDER BY week_number ASC, position ASC, scheduled_date ASC, created_at ASC
    `).all(post.editorial_plan_id, post.month_number);
    const idx = siblings.findIndex(s => s.id === post.id);
    if (idx > 0) prevPostId = siblings[idx - 1].id;
    if (idx >= 0 && idx < siblings.length - 1) nextPostId = siblings[idx + 1].id;
    monthUrl = `/dashboard/clients/${post.client_id}/plan/${post.editorial_plan_id}/month/${post.month_number}`;
  }

  // Categorie del piano: code → name. Permette al post-editor di mostrare il
  // nome leggibile invece del codice, e di offrire un select dropdown.
  // Carichiamo anche start_year_month per mostrare il mese calendario.
  let categories = [];
  let planStartYM = null;
  if (post.editorial_plan_id) {
    const plan = db.prepare('SELECT plan_data, start_year_month FROM editorial_plans WHERE id = ?').get(post.editorial_plan_id);
    if (plan) {
      planStartYM = plan.start_year_month || null;
      if (plan.plan_data) {
        try {
          const parsed = JSON.parse(plan.plan_data);
          if (Array.isArray(parsed.categories)) {
            categories = parsed.categories
              .filter(c => c && c.code)
              .map(c => ({ code: c.code, name: c.name || c.code }));
          }
        } catch (_) { /* plan_data malformato — fallback array vuoto */ }
      }
    }
  }

  // Commenti (cliente + admin) ordinati cronologicamente. Servono al post-editor
  // per mostrare le richieste di modifica del cliente — senza questi l'admin
  // vedeva solo il badge "Modifiche richieste" ma non sapeva cosa modificare.
  const comments = db.prepare(`
    SELECT id, author, text, created_at FROM post_comments
    WHERE post_id = ?
    ORDER BY created_at ASC
  `).all(post.id);

  res.render('post-editor', { title: 'Editor Post', client, post, media, comments, user: req.user, prevPostId, nextPostId, monthUrl, categories, planStartYM });
});

// Insights overview admin: panoramica multi-cliente con KPI sintetici
router.get('/insights', (req, res) => {
  const insights = require('../lib/insights');
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const overview = insights.getInsightsOverview(days);
  res.render('admin-insights', {
    title: 'Insights',
    user: req.user,
    activeNav: 'insights',
    overview,
    days
  });
});

// Insights dettaglio cliente admin (riusa il template della view pubblica)
router.get('/insights/client/:id', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT id, display_name, sector, location, logo_filename FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).send('Cliente non trovato');
  res.render('admin-insights-client', {
    title: `Insights — ${client.display_name}`,
    user: req.user,
    activeNav: 'insights',
    client,
    days: Math.min(parseInt(req.query.days, 10) || 30, 365)
  });
});

// Plan templates admin page
router.get('/plan-templates', (req, res) => {
  const { SECTOR_LABELS } = require('../lib/plan-templates');
  res.render('plan-templates', {
    title: 'Template Piani',
    user: req.user,
    activeNav: 'plan-templates',
    sectorLabels: SECTOR_LABELS
  });
});

// Logs page
router.get('/logs', (req, res) => {
  res.render('logs', { title: 'Log', user: req.user });
});

// Audit log page
router.get('/audit', (req, res) => {
  const db = getDb();
  const filters = {
    client_id:  req.query.client_id || '',
    actor_type: req.query.actor_type || '',
    actor_id:   req.query.actor_id || '',
    action:     req.query.action || '',
    date_from:  req.query.date_from || '',
    date_to:    req.query.date_to || '',
    limit:      parseInt(req.query.limit, 10) || 200,
    offset:     parseInt(req.query.offset, 10) || 0
  };
  // Normalizza date_to per includere tutta la giornata selezionata
  const qFilters = { ...filters };
  if (qFilters.date_to && qFilters.date_to.length === 10) qFilters.date_to = qFilters.date_to + ' 23:59:59';
  const result = audit.query(qFilters);
  const clients = db.prepare(`SELECT id, display_name FROM clients ORDER BY display_name`).all();
  const actors = audit.distinctActors();
  const actions = audit.distinctActions();
  res.render('audit', {
    title: 'Audit',
    user: req.user,
    rows: result.rows,
    total: result.total,
    filters,
    clients,
    actors,
    actions
  });
});

// Settings page
router.get('/settings', (req, res) => {
  res.render('settings', { title: 'Impostazioni', user: req.user });
});

// Manuale utente
router.get('/manuale', (req, res) => {
  res.render('manuale', { title: 'Manuale Utente', user: req.user, activeNav: 'manuale' });
});

module.exports = router;
