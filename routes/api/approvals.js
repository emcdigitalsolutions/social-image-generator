/**
 * routes/api/approvals.js — Workflow approvazione cliente per il mese intero.
 *
 * Due gruppi di endpoint:
 *
 * A) ADMIN (auth Bearer JWT) — gestione del link approvazione
 *    POST   /admin/plans/:planId/months/:month         crea (o ritorna esistente) approvazione
 *    GET    /admin/plans/:planId                        elenca le approvazioni del piano
 *    DELETE /admin/:approvalId                          elimina/revoca l'approvazione
 *
 * B) PUBBLICO (token-based, no login) — usato dal cliente
 *    GET    /public/:token                              dati piano + post per la pagina
 *    POST   /public/:token/posts/:postId/approve       approva singolo post
 *    POST   /public/:token/posts/:postId/request       chiedi modifica con commento
 *    POST   /public/:token/posts/:postId/reject        rifiuta singolo post
 *    POST   /public/:token/approve-all                  approva tutti i post in stato pending
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { notifyApprovalAction } = require('../../lib/notifier');

const router = express.Router();

function generateToken() {
  // 24 byte = 32 char base64url, abbastanza randomico per essere sicuro
  return crypto.randomBytes(24).toString('base64url');
}

function getApprovalByToken(db, token) {
  return db.prepare('SELECT * FROM monthly_approvals WHERE token = ?').get(token);
}

function isExpired(approval) {
  if (!approval.expires_at) return false;
  return new Date(approval.expires_at) < new Date();
}

// ─────────────── ADMIN endpoints ───────────────

router.post('/admin/plans/:planId/months/:month', authMiddleware, (req, res) => {
  const db = getDb();
  const planId = req.params.planId;
  const month = parseInt(req.params.month);

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  // Se esiste già, ritorna quella (idempotente). Per rigenerare il token
  // l'admin deve prima cancellarla.
  const existing = db.prepare('SELECT * FROM monthly_approvals WHERE editorial_plan_id = ? AND month_number = ?').get(planId, month);
  if (existing) return res.json({ approval: existing, created: false });

  // Default: scadenza 30 giorni dalla creazione
  const expiresDays = parseInt(req.body.expires_days) || 30;
  const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString();

  const id = uuidv4();
  const token = generateToken();
  db.prepare(`
    INSERT INTO monthly_approvals (id, editorial_plan_id, month_number, token, status, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, planId, month, token, expiresAt);

  // Reset approval_status di tutti i post draft del mese a 'pending' (caso re-approvazione futura)
  db.prepare(`
    UPDATE posts SET approval_status = 'pending', updated_at = datetime('now')
    WHERE editorial_plan_id = ? AND month_number = ? AND status = 'draft'
  `).run(planId, month);

  const approval = db.prepare('SELECT * FROM monthly_approvals WHERE id = ?').get(id);
  res.status(201).json({ approval, created: true });
});

router.get('/admin/plans/:planId', authMiddleware, (req, res) => {
  const db = getDb();
  const approvals = db.prepare('SELECT * FROM monthly_approvals WHERE editorial_plan_id = ? ORDER BY month_number ASC').all(req.params.planId);
  // Per ogni mese, aggiungi summary stato post
  const summaries = {};
  for (const a of approvals) {
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN approval_status = 'approved'         THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN approval_status = 'change_requested' THEN 1 ELSE 0 END) AS change_requested,
        SUM(CASE WHEN approval_status = 'rejected'         THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN approval_status = 'pending'          THEN 1 ELSE 0 END) AS pending,
        COUNT(*) AS total
      FROM posts WHERE editorial_plan_id = ? AND month_number = ?
    `).get(req.params.planId, a.month_number);
    summaries[a.id] = counts;
  }
  res.json({ approvals, summaries });
});

router.delete('/admin/:approvalId', authMiddleware, (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM monthly_approvals WHERE id = ?').run(req.params.approvalId);
  if (!result.changes) return res.status(404).json({ error: 'Approval not found' });
  res.json({ deleted: true });
});

// ─────────────── PUBLIC endpoints (token-based) ───────────────

function loadPublicContext(req, res, next) {
  const db = getDb();
  const approval = getApprovalByToken(db, req.params.token);
  if (!approval) return res.status(404).json({ error: 'Token non valido o link revocato' });
  if (isExpired(approval)) return res.status(410).json({ error: 'Link scaduto. Chiedi un nuovo link al tuo gestore social.' });

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(approval.editorial_plan_id);
  if (!plan) return res.status(404).json({ error: 'Piano editoriale non trovato' });

  const client = db.prepare('SELECT id, display_name, brand_name, logo_filename FROM clients WHERE id = ?').get(plan.client_id);

  req.approval = approval;
  req.plan = plan;
  req.client = client;
  next();
}

router.get('/public/:token', loadPublicContext, (req, res) => {
  const db = getDb();
  const posts = db.prepare(`
    SELECT id, month_number, week_number, scheduled_date, scheduled_time,
           category, sub_topic, template, media_type, status, approval_status,
           caption, image_url
    FROM posts
    WHERE editorial_plan_id = ? AND month_number = ? AND status != 'published'
    ORDER BY week_number, scheduled_date NULLS LAST, scheduled_time NULLS LAST
  `).all(req.approval.editorial_plan_id, req.approval.month_number);

  // Allega media + commenti per ogni post
  for (const p of posts) {
    p.media = db.prepare('SELECT id, position, kind, source, url FROM post_media WHERE post_id = ? ORDER BY position').all(p.id);
    p.comments = db.prepare('SELECT id, author, text, created_at FROM post_comments WHERE post_id = ? ORDER BY created_at ASC').all(p.id);
  }

  // Marca first_opened_at se è la prima volta che il cliente apre
  if (!req.approval.first_opened_at) {
    db.prepare("UPDATE monthly_approvals SET first_opened_at = datetime('now'), status = CASE WHEN status='pending' THEN 'in_review' ELSE status END WHERE id = ?")
      .run(req.approval.id);
  }

  res.json({
    approval: { id: req.approval.id, status: req.approval.status, expires_at: req.approval.expires_at, month_number: req.approval.month_number },
    plan: { id: req.plan.id, title: req.plan.title },
    client: req.client,
    posts
  });
});

function recordPostAction(db, approval, post, newStatus, commentText) {
  db.prepare("UPDATE posts SET approval_status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newStatus, post.id);
  if (commentText && commentText.trim()) {
    db.prepare("INSERT INTO post_comments (id, post_id, approval_id, author, text) VALUES (?, ?, ?, 'client', ?)")
      .run(uuidv4(), post.id, approval.id, commentText.trim().slice(0, 2000));
  }
  // Aggiorna last_action_at + ricalcola lo stato globale dell'approvazione
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN approval_status = 'change_requested' THEN 1 ELSE 0 END) AS change_requested,
      SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM posts WHERE editorial_plan_id = ? AND month_number = ?
  `).get(approval.editorial_plan_id, approval.month_number);

  let newApprovalStatus;
  if (counts.change_requested > 0) newApprovalStatus = 'changes_requested';
  else if (counts.pending === 0 && counts.approved > 0) newApprovalStatus = 'approved';
  else newApprovalStatus = 'in_review';

  const setApprovedAt = newApprovalStatus === 'approved' && approval.status !== 'approved'
    ? ", approved_at = datetime('now')" : '';
  db.prepare(`UPDATE monthly_approvals SET status = ?, last_action_at = datetime('now')${setApprovedAt} WHERE id = ?`)
    .run(newApprovalStatus, approval.id);
}

function notifyAdminFireAndForget(req, post, action, comment) {
  // Email admin: fire-and-forget per non bloccare la risposta al cliente
  notifyApprovalAction(req.approval, req.plan, req.client, post, action, comment)
    .catch(err => console.error('[approval notifier]', err.message));
}

router.post('/public/:token/posts/:postId/approve', loadPublicContext, (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND editorial_plan_id = ? AND month_number = ?')
    .get(req.params.postId, req.approval.editorial_plan_id, req.approval.month_number);
  if (!post) return res.status(404).json({ error: 'Post not found in this approval' });
  recordPostAction(db, req.approval, post, 'approved', null);
  notifyAdminFireAndForget(req, post, 'approved', null);
  res.json({ ok: true });
});

router.post('/public/:token/posts/:postId/request', loadPublicContext, (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND editorial_plan_id = ? AND month_number = ?')
    .get(req.params.postId, req.approval.editorial_plan_id, req.approval.month_number);
  if (!post) return res.status(404).json({ error: 'Post not found in this approval' });
  const text = req.body && req.body.comment ? req.body.comment : '';
  if (!text || !text.trim()) return res.status(400).json({ error: 'Per chiedere una modifica scrivi un commento' });
  recordPostAction(db, req.approval, post, 'change_requested', text);
  notifyAdminFireAndForget(req, post, 'change_requested', text);
  res.json({ ok: true });
});

router.post('/public/:token/posts/:postId/reject', loadPublicContext, (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND editorial_plan_id = ? AND month_number = ?')
    .get(req.params.postId, req.approval.editorial_plan_id, req.approval.month_number);
  if (!post) return res.status(404).json({ error: 'Post not found in this approval' });
  const text = req.body && req.body.comment ? req.body.comment : '';
  recordPostAction(db, req.approval, post, 'rejected', text);
  notifyAdminFireAndForget(req, post, 'rejected', text);
  res.json({ ok: true });
});

router.post('/public/:token/approve-all', loadPublicContext, (req, res) => {
  const db = getDb();
  const result = db.prepare(`
    UPDATE posts SET approval_status = 'approved', updated_at = datetime('now')
    WHERE editorial_plan_id = ? AND month_number = ? AND approval_status = 'pending'
  `).run(req.approval.editorial_plan_id, req.approval.month_number);

  db.prepare("UPDATE monthly_approvals SET status = 'approved', approved_at = datetime('now'), last_action_at = datetime('now') WHERE id = ?")
    .run(req.approval.id);

  res.json({ ok: true, approved: result.changes });
});

module.exports = router;
