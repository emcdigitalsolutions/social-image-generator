const express = require('express');
const { login, authMiddleware } = require('../../lib/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const result = login(username, password);
  if (!result) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json(result);
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
