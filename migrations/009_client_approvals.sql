-- 009: Workflow approvazione cliente per il mese intero del piano editoriale
--
-- Idea: per ogni mese di un piano, l'admin può generare un link pubblico
-- (token-based, no login) che il cliente apre per vedere TUTTI i post del
-- mese in anteprima. Per ogni post il cliente può:
--   - Approvare
--   - Chiedere una modifica (con commento)
--   - Rifiutare
-- Lo scheduler auto-publish pubblicherà SOLO i post con approval_status='approved'.

CREATE TABLE IF NOT EXISTS monthly_approvals (
  id TEXT PRIMARY KEY,
  editorial_plan_id TEXT NOT NULL REFERENCES editorial_plans(id) ON DELETE CASCADE,
  month_number INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' = link generato, cliente non ha ancora completato
    -- 'in_review' = cliente ha aperto il link almeno una volta
    -- 'approved' = cliente ha approvato l'intero mese
    -- 'changes_requested' = almeno un post ha "change requested"
    -- 'expired' = scaduto, va rigenerato
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                    -- NULL = nessuna scadenza
  first_opened_at TEXT,
  last_action_at TEXT,
  approved_at TEXT,                   -- quando il cliente ha approvato il mese intero
  UNIQUE(editorial_plan_id, month_number)
);

CREATE INDEX IF NOT EXISTS idx_approvals_token ON monthly_approvals(token);
CREATE INDEX IF NOT EXISTS idx_approvals_plan_month ON monthly_approvals(editorial_plan_id, month_number);

-- Stato di approvazione del singolo post (gestito dal cliente via link pubblico)
ALTER TABLE posts ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending';
  -- 'pending' = non ancora valutato dal cliente
  -- 'approved' = OK, può essere pubblicato dallo scheduler
  -- 'change_requested' = il cliente vuole modifiche (vedere post_comments)
  -- 'rejected' = scartato definitivamente

-- Commenti del cliente sul singolo post (richieste di modifica, motivazioni rifiuto)
CREATE TABLE IF NOT EXISTS post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  approval_id TEXT REFERENCES monthly_approvals(id) ON DELETE SET NULL,
  author TEXT NOT NULL DEFAULT 'client',  -- 'client' | 'admin'
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id);
