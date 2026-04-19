-- 008: Reel "puro" vs Reel condiviso anche nel feed Instagram
-- Inoltre migra i post vecchi con media_type='video' a 'reel'
-- (Meta ha deprecato media_type=VIDEO, REELS è il nuovo standard).

ALTER TABLE posts ADD COLUMN ig_share_to_feed INTEGER NOT NULL DEFAULT 1;
-- 1 (default) = il Reel appare anche nel feed normale (più visibilità)
-- 0           = Reel "puro", visibile solo nella tab Reels

UPDATE posts SET media_type = 'reel' WHERE media_type = 'video';
