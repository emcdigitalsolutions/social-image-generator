-- 030: Fonti articoli per cliente (es. rivista online di un'associazione).
-- Il SIG legge periodicamente le fonti (feed RSS/Atom o pagina del sito),
-- salva i nuovi articoli e da ognuno genera, su richiesta, un post che ne
-- riassume i contenuti (caption pensata per LinkedIn, con link all'articolo).
--
-- client_sources: elenco fonti configurate in Impostazioni cliente.
--   type: 'rss' (feed trovato/indicato) | 'page' (pagina HTML: si cercano link articolo)
-- source_articles: articoli trovati. UNIQUE(client_id, url) = niente doppioni.
--   status: 'new' | 'used' (post creato) | 'ignored'

CREATE TABLE IF NOT EXISTS client_sources (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label TEXT,
  url TEXT NOT NULL,
  feed_url TEXT,
  type TEXT NOT NULL DEFAULT 'rss',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_client_sources_client ON client_sources(client_id);

CREATE TABLE IF NOT EXISTS source_articles (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES client_sources(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  title TEXT,
  excerpt TEXT,
  author TEXT,
  image_url TEXT,
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_id, url)
);
CREATE INDEX IF NOT EXISTS idx_source_articles_client ON source_articles(client_id, status);

-- Indicazioni editoriali per i post da articoli (tono, lunghezza, firma, hashtag fissi…)
ALTER TABLE clients ADD COLUMN article_caption_guidelines TEXT;
-- Avviso email all'admin quando il controllo giornaliero trova articoli nuovi
ALTER TABLE clients ADD COLUMN sources_notify INTEGER NOT NULL DEFAULT 1;

-- Collegamento post → articolo di origine
ALTER TABLE posts ADD COLUMN source_article_url TEXT;
