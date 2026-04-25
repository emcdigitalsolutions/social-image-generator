-- 017: Aggiunge supporto LinkedIn (publish + tracking)
--
-- Per ogni cliente:
--   - linkedin_org_id: ID numerico Page aziendale (es. 12345678)
--     usato come urn:li:organization:{id} nelle chiamate API
--   - linkedin_access_token: OAuth 2.0 access token con scope
--     w_organization_social. Scade ogni 60 giorni.
--   - linkedin_token_expires_at: ISO timestamp scadenza (per warning UI)
--
-- Per ogni post:
--   - linkedin_post_id: urn:li:share:{id} ritornato dall'API dopo publish

ALTER TABLE clients ADD COLUMN linkedin_org_id TEXT;
ALTER TABLE clients ADD COLUMN linkedin_access_token TEXT;
ALTER TABLE clients ADD COLUMN linkedin_token_expires_at TEXT;

ALTER TABLE posts ADD COLUMN linkedin_post_id TEXT;
