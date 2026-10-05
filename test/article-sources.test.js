/**
 * Test fonti articoli: parsing RSS/Atom/HTML (puri) + rete reale verso un
 * server HTTP locale di fixture + salvataggio su DB SQLite temporaneo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sources-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const src = require('../lib/article-sources');
const { getDb, runMigrations, close: closeDb } = require('../lib/db');

// ─────────────── Fixture ───────────────

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Rivista AI Europe</title>
<item>
  <title><![CDATA[L'AI Act &amp; le imprese: cosa cambia]]></title>
  <link>https://rivista.test/ai-act-imprese</link>
  <dc:creator><![CDATA[Mario Rossi]]></dc:creator>
  <pubDate>Mon, 05 Oct 2026 08:00:00 +0000</pubDate>
  <description><![CDATA[<p>Una guida <strong>pratica</strong> per i CEO.</p>]]></description>
  <media:content url="https://rivista.test/img/cover1.jpg" medium="image"/>
</item>
<item>
  <title>Secondo articolo</title>
  <link>https://rivista.test/secondo-articolo</link>
  <pubDate>Sun, 04 Oct 2026 08:00:00 +0000</pubDate>
  <description>Testo &#232; breve</description>
  <enclosure url="https://rivista.test/img/cover2.webp" type="image/webp"/>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
<entry><title>Atom uno</title><link rel="alternate" href="/atom-uno"/><updated>2026-10-01T10:00:00Z</updated>
<author><name>Anna Bianchi</name></author><summary>Sommario atom</summary>
<content type="html">&lt;p&gt;&lt;img src="/img/a.png"&gt;Testo&lt;/p&gt;</content></entry></feed>`;

describe('parseFeed', () => {
  test('RSS 2.0 con CDATA, entità, autore, immagine media:content', () => {
    const items = src.parseFeed(RSS, 'https://rivista.test/feed');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: 'https://rivista.test/ai-act-imprese',
      title: "L'AI Act & le imprese: cosa cambia",
      author: 'Mario Rossi',
      excerpt: 'Una guida pratica per i CEO.',
      image_url: 'https://rivista.test/img/cover1.jpg',
      published_at: '2026-10-05T08:00:00.000Z'
    });
    expect(items[1].excerpt).toBe('Testo è breve');
    expect(items[1].image_url).toBe('https://rivista.test/img/cover2.webp');
  });

  test('Atom: link relativo, autore, immagine dal contenuto', () => {
    const [it] = src.parseFeed(ATOM, 'https://blog.test/feed.atom');
    expect(it).toMatchObject({
      url: 'https://blog.test/atom-uno', title: 'Atom uno', author: 'Anna Bianchi',
      excerpt: 'Sommario atom', image_url: 'https://blog.test/img/a.png'
    });
  });

  test('looksLikeFeed', () => {
    expect(src.looksLikeFeed(RSS)).toBe(true);
    expect(src.looksLikeFeed(ATOM)).toBe(true);
    expect(src.looksLikeFeed('<html><body>ciao</body></html>')).toBe(false);
  });
});

describe('HTML', () => {
  test('findFeedLinks ignora i feed dei commenti', () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" href="/feed/">
      <link rel="alternate" type="application/rss+xml" href="/comments/feed/"></head>`;
    expect(src.findFeedLinks(html, 'https://s.test/')).toEqual(['https://s.test/feed/']);
  });

  test('extractArticleLinks: link articolo sì, tag/categorie/esterni no', () => {
    const html = `<nav><a href="/chi-siamo">Chi siamo</a></nav>
      <article><h2><a href="/magazine/ai-e-lavoro">AI e lavoro</a></h2></article>
      <a href="/magazine/il-futuro-delle-pmi-europee">Il futuro delle PMI europee</a>
      <a href="/tag/ai">AI</a><a href="/category/news">News</a>
      <a href="https://altro.test/un-articolo-esterno-lungo">Esterno</a>
      <a href="/magazine/foto.jpg">img</a>`;
    const links = src.extractArticleLinks(html, 'https://s.test/magazine');
    expect(links.map(l => l.url)).toEqual([
      'https://s.test/magazine/ai-e-lavoro',
      'https://s.test/magazine/il-futuro-delle-pmi-europee'
    ]);
    expect(links[0].title).toBe('AI e lavoro');
  });

  test('extractArticle: Open Graph + JSON-LD + testo articolo', () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Titolo OG &amp; co">
      <meta property="og:description" content="Descrizione">
      <meta property="og:image" content="/img/og.jpg">
      <script type="application/ld+json">{"@type":"NewsArticle","author":{"name":"Luca Verdi"},"datePublished":"2026-09-30T09:00:00Z"}</script>
      </head><body><nav>menu</nav><article><h1>Titolo</h1><p>Primo paragrafo.</p><script>x()</script><p>Secondo &egrave; qui.</p></article></body></html>`;
    const a = src.extractArticle(html, 'https://s.test/art');
    expect(a).toMatchObject({
      title: 'Titolo OG & co', excerpt: 'Descrizione', author: 'Luca Verdi',
      image_url: 'https://s.test/img/og.jpg', published_at: '2026-09-30T09:00:00.000Z'
    });
    expect(a.text).toBe('Titolo\n\nPrimo paragrafo.\n\nSecondo è qui.');
  });

  test('htmlToText e decodeEntities', () => {
    expect(src.decodeEntities('&quot;Ciao&quot; &#x1F600; &amp;')).toBe('"Ciao" 😀 &');
    expect(src.htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('• a\n\n• b');
  });

  test('normalizeInputUrl', () => {
    expect(src.normalizeInputUrl('rivista.test/news')).toBe('https://rivista.test/news');
    expect(() => src.normalizeInputUrl('')).toThrow(/mancante/);
  });
});

describe('caption', () => {
  const client = { display_name: 'AI Europe Institute', article_caption_guidelines: 'Hashtag fisso #AIEurope' };
  const article = { title: 'T', author: 'Mario Rossi', url: 'https://r.test/a', excerpt: 'E', text: 'Testo', published_at: '2026-10-05T08:00:00.000Z' };

  test('buildArticlePrompt include URL, autore, linee guida, divieto di inventare', () => {
    const { system, user } = src.buildArticlePrompt(client, article);
    expect(system).toMatch(/AI Europe Institute/);
    expect(user).toMatch(/Leggi l'articolo completo: https:\/\/r\.test\/a/);
    expect(user).toMatch(/Mario Rossi/);
    expect(user).toMatch(/#AIEurope/);
    expect(user).toMatch(/non inventare/);
  });

  test('cleanCaption: toglie preambolo e markdown, aggiunge link prima degli hashtag', () => {
    const out = src.cleanCaption('Ecco il post:\n**Titolo forte**\nCorpo.\n\n#AI #Europa', 'https://r.test/a');
    expect(out).toBe("Titolo forte\nCorpo.\n\nLeggi l'articolo completo: https://r.test/a\n\n#AI #Europa");
  });

  test('cleanCaption: link già presente → invariato', () => {
    const t = "Testo\n\nLeggi l'articolo completo: https://r.test/a\n\n#AI";
    expect(src.cleanCaption(t, 'https://r.test/a')).toBe(t);
  });
});

// ─────────────── Rete reale (server locale) + DB ───────────────

describe('resolveSource / checkClientSources con server locale', () => {
  let server, base;
  let feedVersion = 1;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/home') {
        res.setHeader('content-type', 'text/html');
        return res.end(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed-segreto.xml"></head><body>Home</body></html>`);
      }
      if (req.url === '/feed-segreto.xml') {
        res.setHeader('content-type', 'application/rss+xml');
        const extra = feedVersion > 1 ? `<item><title>Nuovissimo</title><link>${base}/nuovissimo-articolo-oggi</link><pubDate>Tue, 06 Oct 2026 08:00:00 +0000</pubDate></item>` : '';
        const items = Array.from({ length: 5 }, (_, i) =>
          `<item><title>Art ${i}</title><link>${base}/articolo-numero-${i}</link><pubDate>Thu, 0${i + 1} Oct 2026 08:00:00 +0000</pubDate></item>`).join('');
        return res.end(`<rss><channel><title>Feed locale</title>${extra}${items}</channel></rss>`);
      }
      if (req.url === '/senza-feed') {
        res.setHeader('content-type', 'text/html');
        return res.end(`<html><body><article><a href="/senza-feed/primo-articolo-qui">Primo</a></article></body></html>`);
      }
      if (req.url === '/vuota') { res.setHeader('content-type', 'text/html'); return res.end('<html><body>niente</body></html>'); }
      res.statusCode = 404; res.end('nf');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    runMigrations();
    getDb().prepare("INSERT INTO clients (id, display_name) VALUES ('aiei', 'AI Europe Institute')").run();
  });
  afterAll(async () => {
    await new Promise(r => server.close(r));
    closeDb();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  test('home con <link rel=alternate> → feed trovato', async () => {
    const r = await src.resolveSource(base + '/');
    expect(r.type).toBe('rss');
    expect(r.feed_url).toBe(base + '/feed-segreto.xml');
    expect(r.title).toBe('Feed locale');
    expect(r.sample).toHaveLength(5);
  });

  test('pagina senza feed → modalità pagina con link articoli', async () => {
    const r = await src.resolveSource(base + '/senza-feed');
    expect(r.type).toBe('page');
    expect(r.sample[0].url).toBe(base + '/senza-feed/primo-articolo-qui');
  });

  test('pagina senza feed né articoli → errore spiegato', async () => {
    await expect(src.resolveSource(base + '/vuota')).rejects.toThrow(/Nessun feed RSS/);
  });

  test('primo controllo: 3 recenti "new", resto storico; poi solo i nuovi; niente doppioni', async () => {
    const db = getDb();
    db.prepare("INSERT INTO client_sources (id, client_id, label, url, feed_url, type) VALUES ('s1', 'aiei', 'Rivista', ?, ?, 'rss')")
      .run(base + '/', base + '/feed-segreto.xml');

    const r1 = await src.checkClientSources(db, 'aiei');
    expect(r1.errors).toEqual([]);
    expect(r1.added.map(a => a.title)).toEqual(['Art 4', 'Art 3', 'Art 2']);
    const counts = () => Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM source_articles WHERE client_id='aiei' GROUP BY status").all().map(r => [r.status, r.n]));
    expect(counts()).toEqual({ new: 3, ignored: 2 });

    feedVersion = 2;
    const r2 = await src.checkClientSources(db, 'aiei');
    expect(r2.added.map(a => a.title)).toEqual(['Nuovissimo']);
    expect(counts()).toEqual({ new: 4, ignored: 2 });

    const r3 = await src.checkClientSources(db, 'aiei');
    expect(r3.added).toEqual([]);
    expect(db.prepare("SELECT last_error FROM client_sources WHERE id='s1'").get().last_error).toBeNull();
  });

  test('fonte rotta → errore registrato sulla fonte, le altre continuano', async () => {
    const db = getDb();
    db.prepare("INSERT INTO client_sources (id, client_id, label, url, feed_url, type) VALUES ('s2', 'aiei', 'Rotta', ?, ?, 'rss')")
      .run(base + '/x', base + '/non-esiste.xml');
    const r = await src.checkClientSources(db, 'aiei');
    expect(r.checked).toBe(1);
    expect(r.errors).toEqual([{ source: 'Rotta', error: 'Feed HTTP 404' }]);
    expect(db.prepare("SELECT last_error FROM client_sources WHERE id='s2'").get().last_error).toBe('Feed HTTP 404');
  });
});
