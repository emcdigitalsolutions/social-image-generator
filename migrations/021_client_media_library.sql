-- 021: Libreria media per cliente (video + audio riusabili)
-- Storage filesystem: public/library/{client_id}/{audio,video}/<filename>

CREATE TABLE IF NOT EXISTS client_media_library (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- 'audio' | 'video'
  filename TEXT NOT NULL,          -- nome file su disco (sanitizzato, univoco)
  original_name TEXT,              -- nome originale dell'upload (per UI)
  url TEXT NOT NULL,               -- URL pubblico (/library/<client_id>/<kind>/<filename>)
  bytes INTEGER,
  duration_sec REAL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_client_media_library_client
  ON client_media_library(client_id, kind, created_at DESC);
