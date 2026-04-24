-- 015: Account-level insights per cliente (non per-post).
--
-- Usato per il grafico "crescita follower" e altri KPI che i clienti guardano
-- di più. Popolata da un cron giornaliero (lib/insights.js → snapshotAccountInsights).
--
-- Una riga per (client, platform, date) → serie storica giornaliera.
-- UNIQUE impedisce duplicati se il cron riparte nella stessa giornata (idempotente).

CREATE TABLE IF NOT EXISTS account_insights (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,              -- 'fb' | 'ig'
  date          TEXT NOT NULL,              -- YYYY-MM-DD (data "logica" del campione)
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),

  -- Total di riferimento (snapshot corrente, non per-day)
  fans          INTEGER,                    -- FB page fan_count
  followers     INTEGER,                    -- IG followers_count
  media_count   INTEGER,                    -- IG media_count

  -- Metriche giornaliere (valore del giorno `date`)
  reach         INTEGER,                    -- FB page_impressions_unique / IG reach
  impressions   INTEGER,                    -- FB page_impressions
  profile_views INTEGER,                    -- IG profile_views (FB: page_views_total)
  engaged_users INTEGER,                    -- FB page_engaged_users

  raw_json      TEXT,                       -- response completa per debug / campi futuri
  error         TEXT                        -- messaggio errore se fetch fallito (riga comunque scritta)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_insights_unique
  ON account_insights(client_id, platform, date);

CREATE INDEX IF NOT EXISTS idx_account_insights_client_date
  ON account_insights(client_id, date DESC);
