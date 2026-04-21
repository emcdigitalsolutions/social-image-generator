-- Aggiunge position INTEGER per permettere il riordino dei post DENTRO la stessa
-- settimana di un piano editoriale. L'ordinamento globale diventa:
--   ORDER BY week_number ASC, position ASC, scheduled_date ASC, created_at ASC
-- position è 0-based per (editorial_plan_id, month_number, week_number).

ALTER TABLE posts ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- Inizializza position per i post esistenti, partizionando per (plan, mese, settimana)
-- e ordinando per scheduled_date → created_at → id come ordine deterministico.
UPDATE posts SET position = (
  SELECT rn - 1 FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY COALESCE(editorial_plan_id, ''), month_number, week_number
      ORDER BY scheduled_date ASC, created_at ASC, id ASC
    ) AS rn FROM posts
  ) sub WHERE sub.id = posts.id
);

CREATE INDEX IF NOT EXISTS idx_posts_plan_month_week_pos
  ON posts(editorial_plan_id, month_number, week_number, position);
