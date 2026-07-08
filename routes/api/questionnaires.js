const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const crypto = require('crypto');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { SETTORI, getQuestionnaireConfig } = require('../../lib/questionnaire-config');

const router = express.Router();

// Create questionnaire (auth required)
router.post('/', authMiddleware, (req, res) => {
  const db = getDb();
  const { client_id, sector } = req.body;

  if (!client_id) return res.status(400).json({ error: 'client_id required' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const sectorKey = sector || client.sector;
  if (sectorKey && !SETTORI[sectorKey]) {
    return res.status(400).json({ error: 'Invalid sector', available: Object.keys(SETTORI) });
  }

  const id = uuidv4();
  const token = crypto.randomBytes(16).toString('hex');

  db.prepare(`
    INSERT INTO questionnaires (id, client_id, token, sector, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(id, client_id, token, sectorKey || null);

  const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(id);
  res.status(201).json(q);
});

// Get questionnaire detail (auth required)
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Questionnaire not found' });
  if (q.responses) q.responses = JSON.parse(q.responses);
  res.json(q);
});

// Get questionnaires by client (auth required)
router.get('/by-client/:clientId', authMiddleware, (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT * FROM questionnaires WHERE client_id = ? ORDER BY created_at DESC').all(req.params.clientId);
  res.json(list);
});

// Invia il link del questionario al cliente via email (usa clients.contact_email)
router.post('/:id/send-email', authMiddleware, async (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Questionnaire not found' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(q.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.contact_email) {
    return res.status(400).json({ error: 'Il cliente non ha una email di contatto: impostala nel profilo (tab Profilo → Email di contatto cliente).' });
  }
  try {
    const { getBaseUrl } = require('../../lib/settings');
    const { sendQuestionnaireLinkToClient } = require('../../lib/notifier');
    const questionnaireUrl = getBaseUrl().replace(/\/$/, '') + '/dashboard/q/' + q.token;
    const result = await sendQuestionnaireLinkToClient({ client, questionnaireUrl });
    if (result.skipped) return res.status(400).json({ error: 'Invio saltato: ' + result.reason });
    res.json({ success: true, sent_to: result.sent_to });
  } catch (err) {
    console.error('[questionnaire send-email]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Scarica le risposte del questionario come file JSON (auth required)
router.get('/:id/export.json', authMiddleware, (req, res) => {
  const db = getDb();
  const q = db.prepare(`
    SELECT q.*, c.display_name AS client_name FROM questionnaires q
    JOIN clients c ON c.id = q.client_id WHERE q.id = ?
  `).get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Questionnaire not found' });
  const payload = {
    client_id: q.client_id,
    client_name: q.client_name,
    questionnaire_id: q.id,
    sector: q.sector,
    status: q.status,
    submitted_at: q.submitted_at,
    responses: q.responses ? JSON.parse(q.responses) : null
  };
  const fname = `questionario-${q.client_id}-${String(q.id).slice(0, 8)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Import CSV responses (auth required)
router.post('/:id/import-csv', authMiddleware, (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Questionnaire not found' });

  const { responses } = req.body;
  if (!responses) return res.status(400).json({ error: 'responses object required' });

  db.prepare(`
    UPDATE questionnaires SET responses = ?, status = 'submitted', submitted_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(responses), req.params.id);

  res.json({ success: true });
});

// Delete questionnaire (auth required)
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM questionnaires WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Questionnaire not found' });
  res.json({ success: true });
});

// Get available sectors
router.get('/config/sectors', authMiddleware, (req, res) => {
  const sectors = Object.entries(SETTORI).map(([key, val]) => ({ key, label: val.label }));
  res.json(sectors);
});

module.exports = router;
