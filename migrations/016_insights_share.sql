-- 016: Link condivisibili per la dashboard insights cliente.
--
-- Per ogni cliente l'admin può generare uno o più link pubblici (no-login,
-- token-based) che mostrano una dashboard "live" con KPI account-level + top
-- post degli ultimi N giorni. Il cliente apre il link dal browser e vede
-- aggiornamenti automatici ogni volta che il cron insights gira.
--
-- Pattern simile a monthly_approvals (token random, scadenza opzionale, audit
-- su apertura), ma SENZA azioni di scrittura: è solo lettura.

CREATE TABLE IF NOT EXISTS insights_share_links (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  label TEXT,                            -- es. "Report 2026", "Dashboard live"
  period_days INTEGER NOT NULL DEFAULT 30, -- finestra dati mostrati di default
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                       -- NULL = no scadenza
  first_opened_at TEXT,
  last_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'revoked'
);

CREATE INDEX IF NOT EXISTS idx_insights_share_token ON insights_share_links(token);
CREATE INDEX IF NOT EXISTS idx_insights_share_client ON insights_share_links(client_id, status);
