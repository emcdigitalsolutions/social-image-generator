-- 010: Insights Meta (reach / engagement / likes / comments / saves / shares) per
-- ogni post pubblicato. Una riga per (post, platform, day) → storico nel tempo.

CREATE TABLE IF NOT EXISTS post_insights (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,        -- 'fb' | 'ig'
  external_id TEXT NOT NULL,     -- fb_post_id oppure ig_media_id
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Metriche comuni (FB + IG), nullable perché non tutti i tipi le hanno
  impressions INTEGER,
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,                 -- solo IG
  clicks INTEGER,                -- solo FB
  video_views INTEGER,           -- solo video/reel
  engagement INTEGER,            -- aggregato: likes + comments + shares + saves

  raw_json TEXT,                 -- dump response completa per futuri campi non mappati
  error TEXT                     -- se fetch fallito, qui il messaggio
);

CREATE INDEX IF NOT EXISTS idx_post_insights_post ON post_insights(post_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_insights_platform ON post_insights(platform);
