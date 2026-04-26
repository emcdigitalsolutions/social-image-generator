-- 018: Template di piano editoriale riusabili per settore
--
-- Idea: invece di generare ogni piano da zero con AI (5-10 min + costo token),
-- l'admin salva un piano "modello" per settore (es. "Onoranze funebri", "Erboristeria")
-- e al nuovo cliente lo applica clonandolo. Le caption restano vuote (verranno
-- generate dal bulk-generate AI con system_instruction del cliente specifico).
--
-- Placeholder supportati nei campi string del plan_data:
--   {{brand_name}}, {{display_name}}, {{location}}, {{website}}, {{tagline}}, {{sector_label}}
-- Vengono sostituiti al momento dell'applicazione del template a un cliente.

CREATE TABLE IF NOT EXISTS plan_templates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,                       -- es. "Funebre · Standard 6 mesi"
  sector       TEXT,                                -- es. "onoranze_funebri" — filtro per settore (NULL = generico)
  description  TEXT,                                -- nota libera per l'admin
  plan_data    TEXT NOT NULL,                       -- JSON struttura piano (categories + months/weeks/posts)
  months_count INTEGER NOT NULL DEFAULT 6,          -- numero mesi nel template
  is_default   INTEGER NOT NULL DEFAULT 0,          -- 1 = default per quel settore
  source_plan_id TEXT,                              -- piano da cui è stato creato (audit/traceability)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_templates_sector ON plan_templates(sector);
CREATE INDEX IF NOT EXISTS idx_plan_templates_default ON plan_templates(sector, is_default DESC);
