-- Aggiunge il mese calendario di partenza al piano editoriale.
-- Formato: 'YYYY-MM' (es. '2026-08'). NULL = piani legacy.
-- Tutti i month_number dei post si "ancorano" a questo mese:
--   month_number=1 → start_year_month
--   month_number=2 → start_year_month + 1 mese
--   ...
ALTER TABLE editorial_plans ADD COLUMN start_year_month TEXT;
