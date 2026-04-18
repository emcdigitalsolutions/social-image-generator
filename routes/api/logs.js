const express = require('express');
const { authMiddleware } = require('../../lib/auth');
const { getLogs, clearLogs } = require('../../lib/logger');

const router = express.Router();

router.use(authMiddleware);

router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const level = req.query.level || '';
  let entries = getLogs(limit);
  if (level) entries = entries.filter(e => e.level === level);
  res.json({ logs: entries });
});

router.delete('/', (req, res) => {
  clearLogs();
  res.json({ success: true });
});

module.exports = router;
