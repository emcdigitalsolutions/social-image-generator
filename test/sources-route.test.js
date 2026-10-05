/**
 * Integrazione API fonti articoli: router reale + DB temporaneo + server HTTP
 * locale che fa da rivista online. L'AI è simulata (nessuna chiamata esterna).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-sources-route-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

jest.mock('../lib/ai-provider', () => ({
  callAI: jest.fn(async (client, system, user) => ({
    text: 'Ecco il post:\n**L\'AI Act cambia le regole.**\nTre punti chiave:\n→ uno\n→ due\n→ tre\n\n#AIAct #Europa',
    raw: { mocked: true, promptHasArticle: /Testo dell'articolo di prova/.test(user) }
  }))
}));

const express = require('express');
const sharp = require('sharp');
const { getDb, runMigrations, close: closeDb } = require('../lib/db');
const postMedia = require('../lib/post-media');
const sourcesRouter = require('../routes/api/sources');
const { monthNumberFor } = require('../routes/api/sources');
const { callAI } = require('../lib/ai-provider');

const CLIENT = 'test-aiei-' + Date.now();
let fixture, base, app, api, appBase;
let webp;

beforeAll(async () => {
  webp = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3355aa' } }).webp().toBuffer();
  fixture = http.createServer((req, res) => {
    if (req.url === '/rivista') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html><head><link rel="alternate" type="application/rss+xml" href="/rivista/feed"></head></html>');
    }
    if (req.url === '/rivista/feed') {
      res.setHeader('content-type', 'application/rss+xml');
      return res.end(`<rss><channel><title>Rivista AIEI</title>
        <item><title>AI Act e imprese</title><link>${base}/articoli/ai-act-e-imprese</link><pubDate>Mon, 05 Oct 2026 08:00:00 +0000</pubDate>
        <description>Estratto</description><media:content url="${base}/img/cover.webp"/></item></channel></rss>`);
    }
    if (req.url === '/articoli/ai-act-e-imprese') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<html><head><meta property="og:title" content="AI Act e imprese"><meta name="author" content="Mario Rossi, CEO di Esempio Spa"></head>
        <body><article><p>Testo dell'articolo di prova sull'AI Act.</p></article></body></html>`);
    }
    if (req.url === '/img/cover.webp') { res.setHeader('content-type', 'image/webp'); return res.end(webp); }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${fixture.address().port}`;

  runMigrations();
  const db = getDb();
  db.prepare("INSERT INTO clients (id, display_name, sector) VALUES (?, 'AI Europe Institute', 'associazione_ai')").run(CLIENT);
  db.prepare("INSERT INTO editorial_plans (id, client_id, title, status, start_year_month) VALUES ('plan1', ?, 'Piano LinkedIn', 'confirmed', '2026-10')").run(CLIENT);

  app = express();
  app.use(express.json());
  app.use('/c/:clientId/sources', sourcesRouter);
  await new Promise(r => { app = app.listen(0, '127.0.0.1', r); });
  appBase = `http://127.0.0.1:${app.address().port}/c/${CLIENT}/sources`;
  api = async (p, method = 'GET', body) => {
    const r = await fetch(appBase + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
});

afterAll(async () => {
  await new Promise(r => app.close(r));
  await new Promise(r => fixture.close(r));
  postMedia.removeClientDir(CLIENT);
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('monthNumberFor', () => {
  expect(monthNumberFor('2026-10-20', '2026-10')).toBe(1);
  expect(monthNumberFor('2027-01-05', '2026-10')).toBe(4);
  expect(monthNumberFor('2026-09-30', '2026-10')).toBe(0);
  expect(monthNumberFor('2026-10-20', null)).toBeNull();
});

test('flusso completo: anteprima → aggiungi fonte → crea post → doppione bloccato', async () => {
  const prev = await api('/preview', 'POST', { url: base + '/rivista' });
  expect(prev.body).toMatchObject({ ok: true, type: 'rss', count: 1, title: 'Rivista AIEI' });

  const add = await api('', 'POST', { url: base + '/rivista', label: 'Rivista' });
  expect(add.status).toBe(201);
  expect(add.body.report.added).toHaveLength(1);

  const dup = await api('', 'POST', { url: base + '/rivista' });
  expect(dup.status).toBe(409);

  const list = await api('');
  expect(list.body.sources).toHaveLength(1);
  expect(list.body.plans.map(p => p.id)).toEqual(['plan1']);
  const art = list.body.articles[0];
  expect(art).toMatchObject({ title: 'AI Act e imprese', status: 'new' });

  const created = await api(`/articles/${art.id}/create-post`, 'POST', { editorial_plan_id: 'plan1', scheduled_date: '2026-11-10', scheduled_time: '09:30' });
  expect(created.status).toBe(201);
  expect(created.body.month_number).toBe(2);
  expect(created.body.warnings.join(' ')).toMatch(/Mese 2 del piano non è attivo/);

  // L'AI ha ricevuto il testo COMPLETO dell'articolo (non solo l'estratto del feed)
  expect(callAI).toHaveBeenCalledTimes(1);
  const post = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(created.body.post_id);
  expect(post).toMatchObject({
    client_id: CLIENT, editorial_plan_id: 'plan1', month_number: 2, week_number: 2,
    category: 'Articoli', sub_topic: 'AI Act e imprese', status: 'caption_generated',
    scheduled_date: '2026-11-10', scheduled_time: '09:30', source_article_url: base + '/articoli/ai-act-e-imprese'
  });
  expect(JSON.parse(post.caption_ai_raw).promptHasArticle).toBe(true);
  expect(post.caption).toBe("L'AI Act cambia le regole.\nTre punti chiave:\n→ uno\n→ due\n→ tre\n\nLeggi l'articolo completo: " + base + "/articoli/ai-act-e-imprese\n\n#AIAct #Europa");

  // Copertina WebP convertita in JPEG e allegata al post
  const media = postMedia.listMedia(post.id);
  expect(media).toHaveLength(1);
  expect(media[0]).toMatchObject({ kind: 'image', source: 'article' });
  const file = path.join(__dirname, '..', 'public', 'images', CLIENT, 'posts', post.id, media[0].filename);
  expect((await sharp(file).metadata()).format).toBe('jpeg');

  // Autore letto dalla pagina dell'articolo
  const stored = getDb().prepare('SELECT * FROM source_articles WHERE id = ?').get(art.id);
  expect(stored).toMatchObject({ status: 'used', post_id: post.id, author: 'Mario Rossi, CEO di Esempio Spa' });

  const again = await api(`/articles/${art.id}/create-post`, 'POST', { editorial_plan_id: 'plan1' });
  expect(again.status).toBe(409);
});

test('validazioni create-post e stato articolo', async () => {
  const db = getDb();
  db.prepare("INSERT INTO source_articles (id, client_id, url, title, excerpt) VALUES ('a2', ?, 'https://x.invalid/a', 'Altro', 'Estratto')").run(CLIENT);
  expect((await api('/articles/a2/create-post', 'POST', { scheduled_date: '10/11/2026' })).status).toBe(400);
  expect((await api('/articles/a2/create-post', 'POST', { editorial_plan_id: 'plan1', scheduled_date: '2026-09-01' })).body.error).toMatch(/precedente all'inizio del piano/);
  expect((await api('/articles/a2/status', 'POST', { status: 'ignored' })).body.ok).toBe(true);
  expect(db.prepare("SELECT status FROM source_articles WHERE id='a2'").get().status).toBe('ignored');
  expect((await api('/articles/a2/status', 'POST', { status: 'used' })).status).toBe(400);
  expect((await api('/articles/nope/create-post', 'POST', {})).status).toBe(404);
});

test('impostazioni: linee guida e avviso email', async () => {
  await api('/settings', 'PUT', { article_caption_guidelines: 'Tono autorevole', sources_notify: false });
  const s = (await api('')).body.settings;
  expect(s).toEqual({ article_caption_guidelines: 'Tono autorevole', sources_notify: false });
});

test('cliente inesistente → 404', async () => {
  const r = await fetch(appBase.replace(CLIENT, 'nessuno'));
  expect(r.status).toBe(404);
});
