const express = require('express');
const { getDb } = require('../lib/db');
const { pageAuthMiddleware, verifyToken } = require('../lib/auth');
const { SETTORI, getQuestionnaireConfig } = require('../lib/questionnaire-config');
const audit = require('../lib/audit');

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
  const plan = db.prepare('SELECT id, title, client_id FROM editorial_plans WHERE id = ?').get(approval.editorial_plan_id);
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

  db.prepare(`
    UPDATE questionnaires SET responses = ?, status = 'submitted', submitted_at = datetime('now')
    WHERE token = ?
  `).run(JSON.stringify(req.body.responses), req.params.token);

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

  res.render('client-detail', { title: client.display_name, client, questionnaires, plans, sectors, onboarding, user: req.user });
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

  res.render('post-editor', { title: 'Editor Post', client, post, media, user: req.user, prevPostId, nextPostId, monthUrl });
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

module.exports = router;
