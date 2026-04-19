-- 007: Multi-media per post (carousel + video) e tipo del post
-- Estende posts con media_type e introduce post_media per gestire
-- carousel di immagini e video.

ALTER TABLE posts ADD COLUMN media_type TEXT NOT NULL DEFAULT 'single_image';
-- valori: 'single_image' | 'carousel' | 'video' | 'reel'

CREATE TABLE IF NOT EXISTS post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,   -- 0..9, ordine nel carousel
  kind TEXT NOT NULL,                    -- 'image' | 'video'
  source TEXT NOT NULL,                  -- 'upload' | 'generated' | 'styled'
  filename TEXT NOT NULL,                -- nome file su disco (relativo alla cartella post)
  url TEXT NOT NULL,                     -- URL pubblico HTTPS (per Meta API)
  width INTEGER,
  height INTEGER,
  duration_sec REAL,                     -- solo video
  bytes INTEGER,
  styled_from_id TEXT REFERENCES post_media(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media(post_id, position);
