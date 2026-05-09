-- 024: Libreria media condivisa fra tutti i clienti.
-- Quando is_shared=1 l'item è visibile da TUTTI i clienti (ma resta
-- "di proprietà" del client_id originale ai fini di delete/audit).
-- listLibrary(clientId) ritorna: client_id = ? OR is_shared = 1.

ALTER TABLE client_media_library ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_client_media_library_shared
  ON client_media_library(is_shared, kind, created_at DESC);
