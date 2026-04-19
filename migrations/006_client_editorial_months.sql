-- 006: Numero di mesi del piano editoriale configurabile per cliente
-- (es. cliente "premium" 12 mesi, "base" 6 mesi)

ALTER TABLE clients ADD COLUMN editorial_months INTEGER NOT NULL DEFAULT 6;
