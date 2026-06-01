-- 028: Supporto pubblicazione TikTok (Content Posting API — Direct Post).
--
-- Auth TikTok (diversa da LinkedIn): l'access token dura solo 24h, ma c'è un
-- refresh token valido 365 giorni. Il modulo lib/tiktok-publish.js rinnova
-- automaticamente l'access token quando serve, usando client_key/client_secret
-- dell'app TikTok (a livello globale, via settings/env — MAI nel codice) e il
-- refresh token del cliente. I timestamp di scadenza vengono popolati/aggiornati
-- automaticamente ad ogni refresh.
--
-- Per ogni cliente:
--   - tiktok_open_id: identificativo utente TikTok (ritornato dall'OAuth)
--   - tiktok_access_token: token d'accesso corrente (24h, auto-rinnovato)
--   - tiktok_refresh_token: refresh token (365gg) — la credenziale durevole
--   - tiktok_token_expires_at: ISO scadenza access token (per sapere quando rinnovare)
--   - tiktok_refresh_expires_at: ISO scadenza refresh token (per warning UI)
--   - tiktok_privacy_level: visibilità desiderata (default PUBLIC_TO_EVERYONE);
--       al publish viene validata contro le opzioni reali del creator.
--
-- Per ogni post:
--   - tiktok_publish_id: publish_id ritornato dall'init (tracking del post)

ALTER TABLE clients ADD COLUMN tiktok_open_id TEXT;
ALTER TABLE clients ADD COLUMN tiktok_access_token TEXT;
ALTER TABLE clients ADD COLUMN tiktok_refresh_token TEXT;
ALTER TABLE clients ADD COLUMN tiktok_token_expires_at TEXT;
ALTER TABLE clients ADD COLUMN tiktok_refresh_expires_at TEXT;
ALTER TABLE clients ADD COLUMN tiktok_privacy_level TEXT;

ALTER TABLE posts ADD COLUMN tiktok_publish_id TEXT;
