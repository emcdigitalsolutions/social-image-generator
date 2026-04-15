const express = require('express');
const { v4: uuidv4 } = require('uuid');
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

// Get available sectors
router.get('/config/sectors', authMiddleware, (req, res) => {
  const sectors = Object.entries(SETTORI).map(([key, val]) => ({ key, label: val.label }));
  res.json(sectors);
});

module.exports = router;
