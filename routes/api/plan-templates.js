/**
 * routes/api/plan-templates.js — CRUD template piano editoriale.
 *
 * Endpoints (admin auth):
 *   GET    /                         lista template (filtro opzionale ?sector=)
 *   GET    /:id                      dettaglio (con plan_data parsed)
 *   POST   /                         crea da {name, sector, description, plan_data, months_count}
 *   POST   /from-plan/:planId        crea template a partire da un editorial_plan esistente
 *   PUT    /:id                      aggiorna metadata o plan_data
 *   DELETE /:id                      elimina
 *   POST   /:id/apply                applica a un cliente: body {client_id, scheduled_start_date?}
 *                                    → restituisce editorial_plan_id appena creato
 */
'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const audit = require('../../lib/audit');
const { planToTemplate, applyTemplateToClient, SECTOR_LABELS } = require('../../lib/plan-templates');

const router = express.Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  const db = getDb();
  const sector = req.query.sector;
  const rows = sector
    ? db.prepare('SELECT id, name, sector, description, months_count, is_default, source_plan_id, created_at, updated_at FROM plan_templates WHERE sector = ? ORDER BY is_default DESC, name ASC').all(sector)
    : db.prepare('SELECT id, name, sector, description, months_count, is_default, source_plan_id, created_at, updated_at FROM plan_templates ORDER BY sector ASC, is_default DESC, name ASC').all();
  res.json({ templates: rows, sector_labels: SECTOR_LABELS });
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM plan_templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  try { tpl.plan_data = JSON.parse(tpl.plan_data); } catch { tpl.plan_data = {}; }
  res.json({ template: tpl });
});

router.post('/', (req, res) => {
  const db = getDb();
  const { name, sector, description, plan_data, months_count, is_default } = req.body || {};
  if (!name || !plan_data) return res.status(400).json({ error: 'name e plan_data richiesti' });

  const planDataStr = typeof plan_data === 'string' ? plan_data : JSON.stringify(plan_data);

  // Se is_default=true, rimuovi flag dagli altri template dello stesso settore
  if (is_default && sector) {
    db.prepare('UPDATE plan_templates SET is_default = 0 WHERE sector = ?').run(sector);
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO plan_templates (id, name, sector, description, plan_data, months_count, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, sector || null, description || null, planDataStr,
         parseInt(months_count, 10) || 6, is_default ? 1 : 0);

  audit.logFromReq(req, {
    action: 'plan_template.created',
    entity_type: 'plan_template', entity_id: id,
    details: { name, sector, months_count }
  });
  const tpl = db.prepare('SELECT * FROM plan_templates WHERE id = ?').get(id);
  res.status(201).json({ template: tpl });
});

// Crea template clonando un editorial_plan esistente (più comodo)
router.post('/from-plan/:planId', (req, res) => {
  const db = getDb();
  const plan = db.prepare(`
    SELECT ep.*, c.sector AS client_sector
    FROM editorial_plans ep
    LEFT JOIN clients c ON c.id = ep.client_id
    WHERE ep.id = ?
  `).get(req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const planData = typeof plan.plan_data === 'string' ? JSON.parse(plan.plan_data) : plan.plan_data;
  const cleaned = planToTemplate(planData);

  const { name, sector, description, is_default } = req.body || {};
  const finalSector = sector || plan.client_sector || null;
  const finalName = name || `Template da "${plan.title || plan.id}"`;
  const monthsCount = (cleaned.months || []).length || 6;

  if (is_default && finalSector) {
    db.prepare('UPDATE plan_templates SET is_default = 0 WHERE sector = ?').run(finalSector);
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO plan_templates (id, name, sector, description, plan_data, months_count, is_default, source_plan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, finalName, finalSector, description || null, JSON.stringify(cleaned),
         monthsCount, is_default ? 1 : 0, plan.id);

  audit.logFromReq(req, {
    client_id: plan.client_id,
    action: 'plan_template.created_from_plan',
    entity_type: 'plan_template', entity_id: id,
    details: { name: finalName, sector: finalSector, source_plan_id: plan.id }
  });
  const tpl = db.prepare('SELECT * FROM plan_templates WHERE id = ?').get(id);
  res.status(201).json({ template: tpl });
});

router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM plan_templates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Template not found' });

  const fields = [];
  const values = [];
  for (const k of ['name', 'sector', 'description', 'months_count']) {
    if (req.body[k] !== undefined) { fields.push(`${k} = ?`); values.push(req.body[k]); }
  }
  if (req.body.plan_data !== undefined) {
    fields.push('plan_data = ?');
    values.push(typeof req.body.plan_data === 'string' ? req.body.plan_data : JSON.stringify(req.body.plan_data));
  }
  if (req.body.is_default !== undefined) {
    fields.push('is_default = ?');
    values.push(req.body.is_default ? 1 : 0);
    if (req.body.is_default && (req.body.sector || existing.sector)) {
      db.prepare('UPDATE plan_templates SET is_default = 0 WHERE sector = ? AND id != ?')
        .run(req.body.sector || existing.sector, req.params.id);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  fields.push('updated_at = datetime(\'now\')');
  values.push(req.params.id);
  db.prepare(`UPDATE plan_templates SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  audit.logFromReq(req, {
    action: 'plan_template.updated',
    entity_type: 'plan_template', entity_id: req.params.id,
    details: { fields: Object.keys(req.body) }
  });
  const tpl = db.prepare('SELECT * FROM plan_templates WHERE id = ?').get(req.params.id);
  res.json({ template: tpl });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const r = db.prepare('DELETE FROM plan_templates WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Template not found' });
  audit.logFromReq(req, {
    action: 'plan_template.deleted',
    entity_type: 'plan_template', entity_id: req.params.id
  });
  res.json({ ok: true });
});

router.post('/:id/apply', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM plan_templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  const { client_id, scheduled_start_date } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id richiesto' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  try {
    const result = applyTemplateToClient({
      template: tpl, client, scheduledStartDate: scheduled_start_date
    });
    audit.logFromReq(req, {
      client_id: client.id,
      action: 'plan_template.applied',
      entity_type: 'editorial_plan', entity_id: result.plan_id,
      details: { template_id: tpl.id, template_name: tpl.name, scheduled_start_date }
    });
    res.status(201).json({ plan_id: result.plan_id, months_count: result.months_count });
  } catch (err) {
    console.error('[plan-templates apply]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
