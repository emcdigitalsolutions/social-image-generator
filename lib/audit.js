const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');

// Audit log: registra operazioni rilevanti sul sistema.
// Usato dai moduli (routes, scheduler, reminder...) per lasciare una traccia
// ordinata nel tempo di "chi ha fatto cosa a quale cliente". Le scritture sono
// best-effort: non devono MAI interrompere il flusso principale.

function log(entry) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log
        (id, actor_type, actor_id, actor_label, client_id, action, entity_type, entity_id, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      entry.actor_type || 'system',
      entry.actor_id || null,
      entry.actor_label || null,
      entry.client_id || null,
      entry.action,
      entry.entity_type || null,
      entry.entity_id || null,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.ip || null
    );
  } catch (err) {
    console.error('[audit] log failed:', err.message);
  }
}

// Estrae actor dal request (operatore loggato). I flussi pubblici cliente
// usano logAsClient() invece.
function logFromReq(req, entry) {
  const actor = req && req.user
    ? { actor_type: 'user', actor_id: String(req.user.id || req.user.username || ''), actor_label: req.user.display_name || req.user.username }
    : { actor_type: 'system', actor_id: null, actor_label: 'system' };
  const ip = (req && (req.ip || (req.headers && req.headers['x-forwarded-for']))) || null;
  log({ ...actor, ip, ...entry });
}

function logAsClient(client, entry, ip) {
  log({
    actor_type: 'client',
    actor_id: client && client.id ? String(client.id) : null,
    actor_label: client && (client.display_name || client.id) ? (client.display_name || client.id) : 'cliente',
    client_id: client && client.id ? String(client.id) : null,
    ip: ip || null,
    ...entry
  });
}

function logAsSystem(entry) {
  log({ actor_type: 'system', actor_id: null, actor_label: entry.actor_label || 'system', ...entry });
}

function query(filters = {}) {
  const db = getDb();
  const { client_id, actor_type, actor_id, action, date_from, date_to } = filters;
  const limit = Math.min(parseInt(filters.limit || 100, 10) || 100, 1000);
  const offset = parseInt(filters.offset || 0, 10) || 0;

  const conds = [];
  const params = [];
  if (client_id)  { conds.push('client_id = ?');   params.push(client_id); }
  if (actor_type) { conds.push('actor_type = ?');  params.push(actor_type); }
  if (actor_id)   { conds.push('actor_id = ?');    params.push(actor_id); }
  if (action)     { conds.push('action LIKE ?');   params.push(action.includes('%') ? action : action + '%'); }
  if (date_from)  { conds.push('created_at >= ?'); params.push(date_from); }
  if (date_to)    { conds.push('created_at <= ?'); params.push(date_to); }

  const where = conds.length ? ('WHERE ' + conds.join(' AND ')) : '';
  const rows = db.prepare(`
    SELECT a.*, c.display_name AS client_name
    FROM audit_log a
    LEFT JOIN clients c ON c.id = a.client_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  for (const r of rows) {
    if (r.details) {
      try { r.details = JSON.parse(r.details); } catch (_) { /* keep raw */ }
    }
  }

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM audit_log a ${where}`).get(...params);
  return { rows, total, limit, offset };
}

// Helper per elenchi filtri nella UI
function distinctActors() {
  const db = getDb();
  return db.prepare(`
    SELECT actor_type, actor_id, actor_label, COUNT(*) AS n
    FROM audit_log
    WHERE actor_id IS NOT NULL
    GROUP BY actor_type, actor_id, actor_label
    ORDER BY n DESC
  `).all();
}

function distinctActions() {
  const db = getDb();
  return db.prepare(`SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC`).all();
}

module.exports = { log, logFromReq, logAsClient, logAsSystem, query, distinctActors, distinctActions };
