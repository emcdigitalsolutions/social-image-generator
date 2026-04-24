-- 014: Drop colonna `ig_access_token` da `clients`.
--
-- Storia: usata dal pattern legacy con token IGAA* user-scoped (scadenza 60gg).
-- Dal refactor multi-cliente, tutte le chiamate IG passano via graph.facebook.com
-- con il Page Token derivato dal System User EMC (vedi lib/meta-publish.js).
-- Il campo è quindi dead code. Si elimina per ridurre la confusione nell'onboarding.
--
-- SQLite supporta DROP COLUMN da 3.35 (marzo 2021); better-sqlite3 v11+ è >= 3.45.

ALTER TABLE clients DROP COLUMN ig_access_token;
