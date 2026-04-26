-- 020: Soft delete per clienti — possibile solo dopo che il cliente è
-- stato archiviato. La cancellazione logica nasconde il cliente da tutte
-- le UI (lista attivi, archiviati, insights, cron) ma il record resta in
-- DB insieme a tutti i dati collegati (posts, insights, audit log) per
-- ripristino in caso di errore o accesso futuro.

ALTER TABLE clients ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_deleted_at ON clients(deleted_at);
