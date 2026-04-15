const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dashboard-dev-secret';
const TOKEN_EXPIRY = '24h';

function seedUsers() {
  const usersStr = process.env.DASHBOARD_USERS;
  if (!usersStr) return;

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, role)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash
  `);

  const pairs = usersStr.split(',');
  for (const pair of pairs) {
    const [username, password] = pair.trim().split(':');
    if (!username || !password) continue;
    const hash = bcrypt.hashSync(password, 10);
    const role = username === 'admin' ? 'admin' : 'operator';
    const displayName = username.charAt(0).toUpperCase() + username.slice(1);
    upsert.run(username, hash, displayName, role);
    console.log(`[auth] User seeded: ${username} (${role})`);
  }
}

function login(username, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  return { token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const payload = verifyToken(header.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = payload;
  next();
}

function pageAuthMiddleware(req, res, next) {
  // For page routes, check cookie or redirect to login
  const token = req.cookies && req.cookies.dashboard_token;
  if (!token) {
    return res.redirect('/dashboard/login');
  }
  const payload = verifyToken(token);
  if (!payload) {
    return res.redirect('/dashboard/login');
  }
  req.user = payload;
  next();
}

module.exports = { seedUsers, login, verifyToken, authMiddleware, pageAuthMiddleware };
