const express = require('express');
const { getDb } = require('../lib/db');
const { pageAuthMiddleware, verifyToken } = require('../lib/auth');
const { SETTORI, getQuestionnaireConfig } = require('../lib/questionnaire-config');

const router = express.Router();

// Login page (no auth)
router.get('/login', (req, res) => {
  res.render('login', { title: 'Login' });
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

// Dashboard home
router.get('/', (req, res) => {
  const db = getDb();
  const clients = db.prepare("SELECT * FROM clients ORDER BY status = 'active' DESC, updated_at DESC").all();
  res.render('dashboard', { title: 'Dashboard', clients, user: req.user });
});

// Client detail
router.get('/clients/:id', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/dashboard');

  const questionnaires = db.prepare('SELECT * FROM questionnaires WHERE client_id = ? ORDER BY created_at DESC').all(req.params.id);
  const plans = db.prepare('SELECT * FROM editorial_plans WHERE client_id = ? ORDER BY created_at DESC').all(req.params.id);
  const sectors = Object.entries(SETTORI).map(([k, v]) => ({ key: k, label: v.label }));

  res.render('client-detail', { title: client.display_name, client, questionnaires, plans, sectors, user: req.user });
});

// Plan editor
router.get('/clients/:id/plan/:planId', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.redirect('/dashboard');

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.planId);
  if (!plan) return res.redirect(`/dashboard/clients/${req.params.id}`);
  if (plan.plan_data) plan.plan_data = JSON.parse(plan.plan_data);

  res.render('plan-editor', { title: `Piano - ${client.display_name}`, client, plan, user: req.user });
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
    SELECT * FROM posts WHERE editorial_plan_id = ? AND month_number = ? ORDER BY week_number
  `).all(req.params.planId, parseInt(req.params.month));

  const schedule = db.prepare('SELECT * FROM schedules WHERE editorial_plan_id = ? AND month_number = ?').get(req.params.planId, parseInt(req.params.month));

  res.render('month-view', {
    title: `Mese ${req.params.month} - ${client.display_name}`,
    client, plan, posts, month: parseInt(req.params.month), schedule, user: req.user
  });
});

// Post editor
router.get('/posts/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.redirect('/dashboard');
  if (post.image_data) post.image_data = JSON.parse(post.image_data);

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);

  res.render('post-editor', { title: 'Editor Post', client, post, user: req.user });
});

// Logs page
router.get('/logs', (req, res) => {
  res.render('logs', { title: 'Log', user: req.user });
});

module.exports = router;
