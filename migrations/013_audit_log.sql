-- Audit log: traccia ogni operazione rilevante fatta nel sistema.
-- Serve per capire "chi ha fatto cosa a quale cliente e quando", con enfasi
-- sulle approvazioni dei clienti (approvazione piano/post) per avere evidenza
-- cronologica in caso di contestazione.
--
-- actor_type:
--   'user'   → operatore loggato nella dashboard (admin)
--   'client' → azione fatta dal cliente via link pubblico di approvazione
--   'system' → azione automatica (scheduler, cron reminder, ecc.)
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  actor_label   TEXT,
  client_id     TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  details       TEXT,
  ip            TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_client     ON audit_log(client_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor      ON audit_log(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_log(action);
