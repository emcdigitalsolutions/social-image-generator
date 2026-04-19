const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { generateEditorialPlan } = require('../../lib/ai-provider');
const postMedia = require('../../lib/post-media');

const router = express.Router();
router.use(authMiddleware);

// Generate plan from questionnaire
router.post('/generate', async (req, res) => {
  const db = getDb();
  const { client_id, questionnaire_id, months } = req.body;

  if (!client_id) return res.status(400).json({ error: 'client_id required' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Get questionnaire responses if available
  let responses = {};
  if (questionnaire_id) {
    const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(questionnaire_id);
    if (q && q.responses) {
      responses = JSON.parse(q.responses);
    }
  } else {
    // Try to get the latest submitted questionnaire
    const q = db.prepare("SELECT * FROM questionnaires WHERE client_id = ? AND status = 'submitted' ORDER BY submitted_at DESC LIMIT 1").get(client_id);
    if (q && q.responses) {
      responses = JSON.parse(q.responses);
    }
  }

  try {
    const planMonths = parseInt(months) || client.editorial_months || 6;
    const result = await generateEditorialPlan(client, responses, planMonths);

    const id = uuidv4();
    const title = result.planData?.title || `Piano Editoriale - ${client.display_name}`;

    db.prepare(`
      INSERT INTO editorial_plans (id, client_id, title, status, plan_data, ai_raw)
      VALUES (?, ?, ?, 'draft', ?, ?)
    `).run(id, client_id, title, result.planData ? JSON.stringify(result.planData) : null, result.raw);

    // Create posts from plan data if available
    if (result.planData && result.planData.months) {
      const insertPost = db.prepare(`
        INSERT INTO posts (id, client_id, editorial_plan_id, month_number, week_number, category, sub_topic, template, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
      `);

      for (const month of result.planData.months) {
        for (const week of month.weeks || []) {
          for (const post of week.posts || []) {
            insertPost.run(
              uuidv4(), client_id, id,
              month.month_number, week.week_number,
              post.category || null, post.sub_topic || null,
              post.template || 'quote'
            );
          }
        }
      }
    }

    const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(id);
    if (plan.plan_data) plan.plan_data = JSON.parse(plan.plan_data);
    res.status(201).json(plan);
  } catch (err) {
    console.error('[plans] Generation error:', err.message);
    res.status(500).json({ error: 'Plan generation failed', details: err.message });
  }
});

// Get plans by client
router.get('/by-client/:clientId', (req, res) => {
  const db = getDb();
  const plans = db.prepare('SELECT * FROM editorial_plans WHERE client_id = ? ORDER BY created_at DESC').all(req.params.clientId);
  plans.forEach(p => { if (p.plan_data) p.plan_data = JSON.parse(p.plan_data); });
  res.json(plans);
});

// Get plan detail
router.get('/:id', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (plan.plan_data) plan.plan_data = JSON.parse(plan.plan_data);
  res.json(plan);
});

// Update plan
router.put('/:id', (req, res) => {
  const db = getDb();
  const { title, plan_data, status } = req.body;

  const updates = [];
  const values = [];

  if (title !== undefined) { updates.push('title = ?'); values.push(title); }
  if (plan_data !== undefined) { updates.push('plan_data = ?'); values.push(JSON.stringify(plan_data)); }
  if (status !== undefined) { updates.push('status = ?'); values.push(status); }

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);

  db.prepare(`UPDATE editorial_plans SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.id);
  if (plan.plan_data) plan.plan_data = JSON.parse(plan.plan_data);
  res.json(plan);
});

// Confirm plan
router.post('/:id/confirm', (req, res) => {
  const db = getDb();
  db.prepare(`
    UPDATE editorial_plans SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(req.params.id);

  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (plan.plan_data) plan.plan_data = JSON.parse(plan.plan_data);
  res.json(plan);
});

// Delete plan (only draft)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (plan.status !== 'draft') return res.status(400).json({ error: 'Solo i piani in draft possono essere eliminati' });

  // Raccogli i post draft prima di cancellarli per pulire i file su disco
  const draftPosts = db.prepare("SELECT id, client_id FROM posts WHERE editorial_plan_id = ? AND status = 'draft'").all(req.params.id);

  db.prepare("DELETE FROM posts WHERE editorial_plan_id = ? AND status = 'draft'").run(req.params.id);
  db.prepare('DELETE FROM schedules WHERE editorial_plan_id = ?').run(req.params.id);
  db.prepare('DELETE FROM editorial_plans WHERE id = ?').run(req.params.id);

  // Pulizia file orfani: rimuovi le cartelle dei post draft cancellati
  for (const p of draftPosts) {
    try { postMedia.removePostDir(p.client_id, p.id); }
    catch (err) { console.warn('[plans] cleanup failed for post', p.id, err.message); }
  }

  res.json({ deleted: true });
});

// Activate plan
router.post('/:id/activate', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (plan.status !== 'confirmed') return res.status(400).json({ error: 'Solo i piani confirmed possono essere attivati' });

  db.prepare("UPDATE editorial_plans SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

  const updated = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.id);
  if (updated.plan_data) updated.plan_data = JSON.parse(updated.plan_data);
  res.json(updated);
});

// Deactivate plan
router.post('/:id/deactivate', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (plan.status !== 'active') return res.status(400).json({ error: 'Solo i piani attivi possono essere disattivati' });

  db.prepare("UPDATE editorial_plans SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

  const updated = db.prepare('SELECT * FROM editorial_plans WHERE id = ?').get(req.params.id);
  if (updated.plan_data) updated.plan_data = JSON.parse(updated.plan_data);
  res.json(updated);
});

module.exports = router;
