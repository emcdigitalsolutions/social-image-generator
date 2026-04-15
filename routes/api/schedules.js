const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');

const router = express.Router();
router.use(authMiddleware);

// Get schedules by client
router.get('/by-client/:clientId', (req, res) => {
  const db = getDb();
  const schedules = db.prepare('SELECT * FROM schedules WHERE client_id = ? ORDER BY month_number').all(req.params.clientId);
  res.json(schedules);
});

// Update schedule
router.put('/:id', (req, res) => {
  const db = getDb();
  const { cron_expression, is_active } = req.body;

  const updates = [];
  const values = [];

  if (cron_expression !== undefined) { updates.push('cron_expression = ?'); values.push(cron_expression); }
  if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);

  db.prepare(`UPDATE schedules SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  res.json(schedule);
});

// Confirm month schedule (activate auto-publish)
router.post('/:planId/month/:month/confirm', (req, res) => {
  const db = getDb();
  const { planId, month } = req.params;
  const monthNum = parseInt(month);

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  // Check if schedule exists, create if not
  let schedule = db.prepare('SELECT * FROM schedules WHERE editorial_plan_id = ? AND month_number = ?').get(planId, monthNum);

  if (!schedule) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO schedules (id, client_id, editorial_plan_id, month_number, is_active, confirmed_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
    `).run(id, plan.client_id, planId, monthNum);
    schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  } else {
    db.prepare(`
      UPDATE schedules SET is_active = 1, confirmed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(schedule.id);
    schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(schedule.id);
  }

  res.json(schedule);
});

module.exports = router;
