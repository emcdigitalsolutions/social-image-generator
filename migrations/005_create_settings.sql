-- 005: Tabella impostazioni globali (key-value)
-- Usata per configurazione SMTP e altre impostazioni da UI

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
