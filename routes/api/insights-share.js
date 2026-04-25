/**
 * routes/api/insights-share.js — Link condivisibili per dashboard insights cliente.
 *
 * A) ADMIN (auth Bearer JWT)
 *    POST   /admin/clients/:clientId        crea un nuovo share link
 *    GET    /admin/clients/:clientId        lista link attivi del cliente
 *    DELETE /admin/:linkId                  revoca link (status='revoked')
 *
 * B) PUBBLICO (token-based, no login) — vedi routes/dashboard.js per la view
 *    GET /public/:token/data                dati JSON per la dashboard
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const audit = require('../../lib/audit');
const insights = require('../../lib/insights');

const router = express.Router();

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function isExpired(link) {
  if (!link.expires_at) return false;
  return new Date(link.expires_at) < new Date();
}

// ─────────────── ADMIN ───────────────

router.post('/admin/clients/:clientId', authMiddleware, (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT id, display_name FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const periodDays = parseInt(req.body.period_days, 10) || 30;
  const expiresDays = parseInt(req.body.expires_days, 10);
  const label = (req.body.label || '').trim().substring(0, 100) || null;

  const expiresAt = expiresDays > 0
    ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const id = uuidv4();
  const token = generateToken();
  db.prepare(`
    INSERT INTO insights_share_links (id, client_id, token, label, period_days, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(id, client.id, token, label, periodDays, expiresAt);

  const link = db.prepare('SELECT * FROM insights_share_links WHERE id = ?').get(id);
  audit.logFromReq(req, {
    client_id: client.id,
    action: 'insights.share_created',
    entity_type: 'insights_share_link',
    entity_id: id,
    details: { period_days: periodDays, expires_at: expiresAt, label }
  });
  res.status(201).json({ link });
});

router.get('/admin/clients/:clientId', authMiddleware, (req, res) => {
  const db = getDb();
  const links = db.prepare(`
    SELECT * FROM insights_share_links
    WHERE client_id = ?
    ORDER BY created_at DESC
  `).all(req.params.clientId);
  res.json({ links });
});

router.delete('/admin/:linkId', authMiddleware, (req, res) => {
  const db = getDb();
  const link = db.prepare('SELECT * FROM insights_share_links WHERE id = ?').get(req.params.linkId);
  if (!link) return res.status(404).json({ error: 'Link not found' });

  db.prepare("UPDATE insights_share_links SET status = 'revoked' WHERE id = ?").run(req.params.linkId);
  audit.logFromReq(req, {
    client_id: link.client_id,
    action: 'insights.share_revoked',
    entity_type: 'insights_share_link',
    entity_id: link.id
  });
  res.json({ ok: true });
});

// ─────────────── PUBLIC (no auth) ───────────────

// JSON endpoint usato dalla view pubblica. Non richiede login: il token È
// l'autenticazione. Espone solo dati aggregati read-only.
router.get('/public/:token/data', (req, res) => {
  const db = getDb();
  const link = db.prepare('SELECT * FROM insights_share_links WHERE token = ? AND status = ?').get(req.params.token, 'active');
  if (!link) return res.status(404).json({ error: 'Link non valido o revocato' });
  if (isExpired(link)) return res.status(410).json({ error: 'Link scaduto' });

  // Track view (idempotente: incrementa contatore + last_viewed_at)
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE insights_share_links
    SET view_count = view_count + 1,
        last_viewed_at = ?,
        first_opened_at = COALESCE(first_opened_at, ?)
    WHERE id = ?
  `).run(now, now, link.id);

  const client = db.prepare('SELECT id, display_name, sector, location, logo_filename FROM clients WHERE id = ?').get(link.client_id);
  if (!client) return res.status(404).json({ error: 'Cliente non trovato' });

  const days = link.period_days || 30;
  const summary = insights.getAccountSummary(client.id, days);
  const history = insights.getAccountInsightsHistory(client.id, days);
  const topPosts = insights.getTopPosts(client.id, days, 5);

  res.json({
    client: { id: client.id, display_name: client.display_name, sector: client.sector, location: client.location, has_logo: !!client.logo_filename },
    period: { days, label: link.label },
    summary,
    history,
    top_posts: topPosts,
    generated_at: now
  });
});

module.exports = router;
