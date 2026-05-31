-- Toggle per-cliente per l'invio automatico del report performance a fine mese.
-- Default 0 (disattivato). Abilitiamo automaticamente i clienti che hanno già un
-- piano commerciale attivo, così l'invio mensile parte per loro senza intervento.
ALTER TABLE clients ADD COLUMN monthly_report_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE clients SET monthly_report_enabled = 1
  WHERE subscription_plan IS NOT NULL AND subscription_plan != '';
