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
const { notifyApprovalSummary, sendApprovalLinkToClient } = require('../../lib/notifier');
const audit = require('../../lib/audit');

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

router.post('/admin/plans/:planId/months/:month', authMiddleware, async (req, res) => {
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

  // Email automatica al cliente (fire-and-forget). Skip silenzioso se manca
  // contact_email — l'admin vedrà nell'audit log se l'email è stata inviata.
  let emailResult = null;
  const client = db.prepare('SELECT id, display_name, contact_email FROM clients WHERE id = ?').get(plan.client_id);
  if (client && client.contact_email) {
    try {
      const baseUrl = require('../../lib/settings').getBaseUrl();
      const approvalUrl = baseUrl.replace(/\/$/, '') + '/dashboard/approve/' + token;
      const totalPosts = db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE editorial_plan_id = ? AND month_number = ?`).get(planId, month).n;
      emailResult = await sendApprovalLinkToClient({
        client, approvalUrl, planTitle: plan.title, monthNumber: month, expiresAt, totalPosts
      });
    } catch (err) {
      console.error('[approvals] sendApprovalLinkToClient error:', err.message);
      emailResult = { error: err.message };
    }
  }

  audit.logFromReq(req, {
    client_id: plan.client_id,
    action: 'approval.link_created',
    entity_type: 'monthly_approval',
    entity_id: id,
    details: {
      plan_id: planId, month_number: month, expires_at: expiresAt,
      email_sent_to: emailResult && emailResult.sent_to,
      email_skipped: emailResult && emailResult.skipped ? emailResult.reason : null,
      email_error: emailResult && emailResult.error
    }
  });
  res.status(201).json({ approval, created: true, email: emailResult });
});

// Re-invia l'email approvazione al cliente (es. il primo invio non era arrivato
// o il cliente l'ha persa).
router.post('/admin/:approvalId/resend-email', authMiddleware, async (req, res) => {
  const db = getDb();
  const approval = db.prepare('SELECT * FROM monthly_approvals WHERE id = ?').get(req.params.approvalId);
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(approval.editorial_plan_id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const client = db.prepare('SELECT id, display_name, contact_email FROM clients WHERE id = ?').get(plan.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const customTo = (req.body && req.body.to) || null;
  const recipient = customTo || client.contact_email;
  if (!recipient) return res.status(400).json({ error: 'Cliente senza contact_email — passa { to: "..." } nel body' });

  try {
    const baseUrl = require('../../lib/settings').getBaseUrl();
    const approvalUrl = baseUrl.replace(/\/$/, '') + '/dashboard/approve/' + approval.token;
    const totalPosts = db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE editorial_plan_id = ? AND month_number = ?`).get(approval.editorial_plan_id, approval.month_number).n;
    const clientForEmail = customTo ? { ...client, contact_email: customTo } : client;
    const r = await sendApprovalLinkToClient({
      client: clientForEmail, approvalUrl, planTitle: plan.title, monthNumber: approval.month_number, expiresAt: approval.expires_at, totalPosts
    });
    audit.logFromReq(req, {
      client_id: plan.client_id,
      action: 'approval.email_resent',
      entity_type: 'monthly_approval',
      entity_id: approval.id,
      details: { recipient, month_number: approval.month_number }
    });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[approvals] resend email error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  const approvalToDelete = db.prepare('SELECT ma.*, p.client_id FROM monthly_approvals ma JOIN editorial_plans p ON p.id = ma.editorial_plan_id WHERE ma.id = ?').get(req.params.approvalId);
  const result = db.prepare('DELETE FROM monthly_approvals WHERE id = ?').run(req.params.approvalId);
  if (!result.changes) return res.status(404).json({ error: 'Approval not found' });
  if (approvalToDelete) {
    audit.logFromReq(req, {
      client_id: approvalToDelete.client_id,
      action: 'approval.link_revoked',
      entity_type: 'monthly_approval',
      entity_id: req.params.approvalId,
      details: { plan_id: approvalToDelete.editorial_plan_id, month_number: approvalToDelete.month_number }
    });
  }
  res.json({ deleted: true });
});

// Helper: manda la stessa email di riepilogo che riceve il cliente quando ha
// terminato la revisione, ma con wording "approvato dal tuo gestore social".
// Si attiva solo se pending === 0 (ovvero il mese è "chiuso"). CC al cliente
// quando lo stato finale è 'approved' e client.contact_email è presente.
function sendAdminSummaryIfComplete(db, approval, planId, monthNumber, counts, newApprovalStatus) {
  if (!counts || counts.pending !== 0) return;
  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(planId);
  if (!plan) return;
  const client = db.prepare('SELECT id, display_name, brand_name, logo_filename, contact_email FROM clients WHERE id = ?').get(plan.client_id);
  if (!client) return;
  const posts = db.prepare(`
    SELECT p.id, p.category, p.sub_topic, p.week_number, p.month_number, p.approval_status,
      (SELECT GROUP_CONCAT(text, '||')
         FROM post_comments
         WHERE post_id = p.id AND author = 'client') AS client_comments
    FROM posts p
    WHERE editorial_plan_id = ? AND month_number = ?
    ORDER BY week_number ASC, id ASC
  `).all(planId, monthNumber);
  notifyApprovalSummary(approval, plan, client, posts, counts, newApprovalStatus, 'admin')
    .catch(err => console.error('[approval summary notifier admin]', err.message));
}

// Admin: imposta approval_status di un singolo post (bypassa il flusso token cliente).
// Body: { status: 'pending'|'approved'|'change_requested'|'rejected', comment?: string }
// Se esiste un'approvazione mensile per il post, ricalcola il suo status aggregato.
const ADMIN_APPROVAL_STATES = new Set(['pending', 'approved', 'change_requested', 'rejected']);
router.post('/admin/posts/:postId/set-approval', authMiddleware, (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const status = req.body && req.body.status;
  if (!ADMIN_APPROVAL_STATES.has(status)) return res.status(400).json({ error: 'status deve essere pending/approved/change_requested/rejected' });
  const comment = req.body && req.body.comment ? String(req.body.comment).trim().slice(0, 2000) : '';

  db.prepare("UPDATE posts SET approval_status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, post.id);

  // Cerca l'approvazione mensile corrispondente; se c'è, aggiungi il commento con author='admin'
  // e ricalcola lo status aggregato (stessa logica di recordPostAction).
  const approval = db.prepare('SELECT * FROM monthly_approvals WHERE editorial_plan_id = ? AND month_number = ?')
    .get(post.editorial_plan_id, post.month_number);
  if (comment) {
    db.prepare("INSERT INTO post_comments (id, post_id, approval_id, author, text) VALUES (?, ?, ?, 'admin', ?)")
      .run(uuidv4(), post.id, approval ? approval.id : null, comment);
  }
  if (approval) {
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN approval_status = 'change_requested' THEN 1 ELSE 0 END) AS change_requested,
        SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
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

    // Se il mese è appena stato chiuso (pending === 0), manda il riepilogo come
    // per il flusso cliente ma con wording "approvato dal tuo gestore".
    const updatedApproval = db.prepare('SELECT * FROM monthly_approvals WHERE id = ?').get(approval.id);
    sendAdminSummaryIfComplete(db, updatedApproval, approval.editorial_plan_id, approval.month_number, counts, newApprovalStatus);
  }
  audit.logFromReq(req, {
    client_id: post.client_id,
    action: 'post.approval_changed_by_admin',
    entity_type: 'post',
    entity_id: post.id,
    details: { new_status: status, comment: comment || null, plan_id: post.editorial_plan_id, month_number: post.month_number }
  });
  res.json({ ok: true, approval_status: status });
});

// Admin: approva in massa tutti i post di un mese senza passare dal cliente.
// Opzionale: crea automaticamente un'approvazione mensile se non esiste, così
// l'aggregato monthly_approvals resta coerente.
router.post('/admin/plans/:planId/months/:month/approve-all', authMiddleware, (req, res) => {
  const db = getDb();
  const planId = req.params.planId;
  const month = parseInt(req.params.month);
  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const approved = db.prepare(`
    UPDATE posts SET approval_status = 'approved', updated_at = datetime('now')
    WHERE editorial_plan_id = ? AND month_number = ?
      AND approval_status IN ('pending', 'change_requested', 'rejected')
  `).run(planId, month);

  // Se esiste un'approvazione mensile, passa a 'approved' per coerenza col publish guard
  const existing = db.prepare('SELECT * FROM monthly_approvals WHERE editorial_plan_id = ? AND month_number = ?').get(planId, month);
  if (existing) {
    db.prepare(`UPDATE monthly_approvals
                SET status = 'approved', approved_at = datetime('now'), last_action_at = datetime('now')
                WHERE id = ?`).run(existing.id);
  }

  // Manda il riepilogo email (admin + CC cliente se ha contact_email).
  // Se non c'era monthly_approvals, ne costruisco uno "virtuale" per la mail
  // — serve solo per avere month_number e approved_at nel template.
  const approvalForEmail = existing
    ? db.prepare('SELECT * FROM monthly_approvals WHERE id = ?').get(existing.id)
    : { id: null, editorial_plan_id: planId, month_number: month, status: 'approved', approved_at: new Date().toISOString() };
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN approval_status = 'change_requested' THEN 1 ELSE 0 END) AS change_requested,
      SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM posts WHERE editorial_plan_id = ? AND month_number = ?
  `).get(planId, month);
  sendAdminSummaryIfComplete(db, approvalForEmail, planId, month, counts, 'approved');

  audit.logFromReq(req, {
    client_id: plan.client_id,
    action: 'plan_month.approved_by_admin',
    entity_type: 'editorial_plan',
    entity_id: planId,
    details: { month_number: month, posts_approved: approved.changes }
  });
  res.json({ ok: true, approved: approved.changes, approval_updated: !!existing });
});

// ─────────────── PUBLIC endpoints (token-based) ───────────────

function loadPublicContext(req, res, next) {
  const db = getDb();
  const approval = getApprovalByToken(db, req.params.token);
  if (!approval) return res.status(404).json({ error: 'Token non valido o link revocato' });
  if (isExpired(approval)) return res.status(410).json({ error: 'Link scaduto. Chiedi un nuovo link al tuo gestore social.' });

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(approval.editorial_plan_id);
  if (!plan) return res.status(404).json({ error: 'Piano editoriale non trovato' });

  const client = db.prepare('SELECT id, display_name, brand_name, logo_filename, contact_email FROM clients WHERE id = ?').get(plan.client_id);

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
      SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
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

  return { counts, newApprovalStatus };
}

// Invia UNA email di riepilogo all'admin quando il cliente ha completato la
// revisione (pending === 0). Sostituisce il comportamento precedente che
// mandava una mail per ogni singola azione del cliente.
// Inoltre logga l'evento aggregato nell'audit se lo stato del mese è appena
// diventato 'approved' (informazione chiave: "il cliente ha approvato tutto").
function notifySummaryIfComplete(req, counts, newApprovalStatus) {
  if (!counts || counts.pending !== 0) return;
  const db = getDb();
  const posts = db.prepare(`
    SELECT p.id, p.category, p.sub_topic, p.week_number, p.month_number, p.approval_status,
      (SELECT GROUP_CONCAT(text, '||')
         FROM post_comments
         WHERE post_id = p.id AND author = 'client') AS client_comments
    FROM posts p
    WHERE editorial_plan_id = ? AND month_number = ?
    ORDER BY week_number ASC, id ASC
  `).all(req.approval.editorial_plan_id, req.approval.month_number);
  notifyApprovalSummary(req.approval, req.plan, req.client, posts, counts, newApprovalStatus)
    .catch(err => console.error('[approval summary notifier]', err.message));

  // Audit aggregato: tracciamo il cambio di stato del mese (approved / changes_requested)
  // con le statistiche complete — è la riga che l'admin cercherà per dimostrare
  // "il cliente ha approvato il piano".
  if (newApprovalStatus === 'approved' || newApprovalStatus === 'changes_requested') {
    audit.logAsClient(req.client, {
      action: newApprovalStatus === 'approved' ? 'plan_month.approved_by_client' : 'plan_month.changes_requested_by_client',
      entity_type: 'monthly_approval',
      entity_id: req.approval.id,
      details: {
        plan_id: req.approval.editorial_plan_id,
        plan_title: req.plan && req.plan.title,
        month_number: req.approval.month_number,
        counts
      }
    }, req.ip);
  }
}

router.post('/public/:token/posts/:postId/approve', loadPublicContext, (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND editorial_plan_id = ? AND month_number = ?')
    .get(req.params.postId, req.approval.editorial_plan_id, req.approval.month_number);
  if (!post) return res.status(404).json({ error: 'Post not found in this approval' });
  const { counts, newApprovalStatus } = recordPostAction(db, req.approval, post, 'approved', null);
  audit.logAsClient(req.client, {
    action: 'post.approved_by_client',
    entity_type: 'post',
    entity_id: post.id,
    details: { plan_id: post.editorial_plan_id, month_number: post.month_number, category: post.category, sub_topic: post.sub_topic }
  }, req.ip);
  notifySummaryIfComplete(req, counts, newApprovalStatus);
  res.json({ ok: true });
});

router.post('/public/:token/posts/:postId/request', loadPublicContext, (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND editorial_plan_id = ? AND month_number = ?')
    .get(req.params.postId, req.approval.editorial_plan_id, req.approval.month_number);
  if (!post) return res.status(404).json({ error: 'Post not found in this approval' });
  const text = req.body && req.body.comment ? req.body.comment : '';
  if (!text || !text.trim()) return res.status(400).json({ error: 'Per chiedere una modifica scrivi un commento' });
  const { counts, newApprovalStatus } = recordPostAction(db, req.approval, post, 'change_requested', text);
  audit.logAsClient(req.client, {
    action: 'post.change_requested_by_client',
    entity_type: 'post',
    entity_id: post.id,
    details: { plan_id: post.editorial_plan_id, month_number: post.month_number, category: post.category, comment: text.slice(0, 500) }
  }, req.ip);
  notifySummaryIfComplete(req, counts, newApprovalStatus);
  res.json({ ok: true });
});

router.post('/public/:token/posts/:postId/reject', loadPublicContext, (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND editorial_plan_id = ? AND month_number = ?')
    .get(req.params.postId, req.approval.editorial_plan_id, req.approval.month_number);
  if (!post) return res.status(404).json({ error: 'Post not found in this approval' });
  const text = req.body && req.body.comment ? req.body.comment : '';
  const { counts, newApprovalStatus } = recordPostAction(db, req.approval, post, 'rejected', text);
  audit.logAsClient(req.client, {
    action: 'post.rejected_by_client',
    entity_type: 'post',
    entity_id: post.id,
    details: { plan_id: post.editorial_plan_id, month_number: post.month_number, category: post.category, comment: (text || '').slice(0, 500) }
  }, req.ip);
  notifySummaryIfComplete(req, counts, newApprovalStatus);
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

  // Ricalcola conteggi e manda un riepilogo unico (il cliente ha usato
  // "approva tutto", quindi pending ora è 0).
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN approval_status = 'change_requested' THEN 1 ELSE 0 END) AS change_requested,
      SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM posts WHERE editorial_plan_id = ? AND month_number = ?
  `).get(req.approval.editorial_plan_id, req.approval.month_number);
  audit.logAsClient(req.client, {
    action: 'plan_month.approve_all_by_client',
    entity_type: 'monthly_approval',
    entity_id: req.approval.id,
    details: { plan_id: req.approval.editorial_plan_id, month_number: req.approval.month_number, posts_approved: result.changes }
  }, req.ip);
  notifySummaryIfComplete(req, counts, 'approved');

  res.json({ ok: true, approved: result.changes });
});

module.exports = router;
