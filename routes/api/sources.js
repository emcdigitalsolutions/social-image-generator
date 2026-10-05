/**
 * sources.js — fonti articoli per cliente + creazione post riassunto.
 * Mount: /dashboard/api/clients/:clientId/sources
 *
 * GET    /                              fonti, articoli recenti, impostazioni
 * PUT    /settings                      linee guida caption + avviso email
 * POST   /preview          {url}        prova una fonte senza salvarla
 * POST   /                 {url,label}  aggiunge una fonte (e la legge subito)
 * PUT    /:sourceId        {label,is_active}
 * DELETE /:sourceId
 * POST   /check                         controlla ora tutte le fonti attive
 * POST   /articles         {url}        aggiunge a mano un singolo articolo
 * POST   /articles/:articleId/status   {status: new|ignored}
 * POST   /articles/:articleId/create-post {editorial_plan_id, scheduled_date, scheduled_time}
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { getDb } = require('../../lib/db');
const postMedia = require('../../lib/post-media');
const audit = require('../../lib/audit');
const src = require('../../lib/article-sources');

// mergeParams=true per ereditare :clientId dal mount path in clients.js
const router = express.Router({ mergeParams: true });

function loadClient(req, res) {
  const client = getDb().prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) res.status(404).json({ error: 'Client not found' });
  return client;
}

router.get('/', (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const db = getDb();
  const sources = db.prepare('SELECT * FROM client_sources WHERE client_id = ? ORDER BY created_at').all(client.id);
  const articles = db.prepare(`
    SELECT a.*, s.label AS source_label, p.status AS post_status, p.scheduled_date AS post_date
    FROM source_articles a
    LEFT JOIN client_sources s ON s.id = a.source_id
    LEFT JOIN posts p ON p.id = a.post_id
    WHERE a.client_id = ?
    ORDER BY CASE a.status WHEN 'new' THEN 0 WHEN 'used' THEN 1 ELSE 2 END,
             COALESCE(a.published_at, a.created_at) DESC
    LIMIT 150
  `).all(client.id);
  const plans = db.prepare(`
    SELECT id, title, status, start_year_month FROM editorial_plans
    WHERE client_id = ? ORDER BY created_at DESC
  `).all(client.id);
  res.json({
    sources, articles, plans,
    settings: { article_caption_guidelines: client.article_caption_guidelines || '', sources_notify: client.sources_notify !== 0 }
  });
});

router.put('/settings', (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const g = typeof req.body.article_caption_guidelines === 'string' ? req.body.article_caption_guidelines.slice(0, 4000) : client.article_caption_guidelines;
  const n = req.body.sources_notify === undefined ? client.sources_notify : (req.body.sources_notify ? 1 : 0);
  getDb().prepare("UPDATE clients SET article_caption_guidelines = ?, sources_notify = ?, updated_at = datetime('now') WHERE id = ?").run(g || null, n, client.id);
  res.json({ ok: true });
});

router.post('/preview', async (req, res) => {
  try {
    const r = await src.resolveSource(req.body.url);
    res.json({ ok: true, type: r.type, feed_url: r.feed_url, title: r.title, count: r.sample.length, sample: r.sample.slice(0, 5) });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  }
});

router.post('/', async (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const db = getDb();
  let resolved;
  try {
    resolved = await src.resolveSource(req.body.url);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }
  const dup = db.prepare('SELECT id FROM client_sources WHERE client_id = ? AND (url = ? OR (feed_url IS NOT NULL AND feed_url = ?))')
    .get(client.id, resolved.url, resolved.feed_url);
  if (dup) return res.status(409).json({ error: 'Questa fonte è già configurata' });

  const id = crypto.randomUUID();
  const label = (req.body.label || '').trim().slice(0, 120) || resolved.title || new URL(resolved.url).hostname;
  db.prepare('INSERT INTO client_sources (id, client_id, label, url, feed_url, type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, client.id, label, resolved.url, resolved.feed_url, resolved.type);
  audit.logFromReq(req, { client_id: client.id, action: 'source.added', entity_type: 'source', entity_id: id, details: { url: resolved.url, type: resolved.type } });

  const report = await src.checkClientSources(db, client.id);
  res.status(201).json({ ok: true, source: db.prepare('SELECT * FROM client_sources WHERE id = ?').get(id), report });
});

router.put('/:sourceId', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM client_sources WHERE id = ? AND client_id = ?').get(req.params.sourceId, req.params.clientId);
  if (!s) return res.status(404).json({ error: 'Fonte non trovata' });
  const label = typeof req.body.label === 'string' ? req.body.label.trim().slice(0, 120) || s.label : s.label;
  const active = req.body.is_active === undefined ? s.is_active : (req.body.is_active ? 1 : 0);
  db.prepare('UPDATE client_sources SET label = ?, is_active = ? WHERE id = ?').run(label, active, s.id);
  res.json({ ok: true });
});

router.delete('/:sourceId', (req, res) => {
  const db = getDb();
  const r = db.prepare('DELETE FROM client_sources WHERE id = ? AND client_id = ?').run(req.params.sourceId, req.params.clientId);
  if (!r.changes) return res.status(404).json({ error: 'Fonte non trovata' });
  audit.logFromReq(req, { client_id: req.params.clientId, action: 'source.deleted', entity_type: 'source', entity_id: req.params.sourceId });
  res.json({ ok: true });
});

router.post('/check', async (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  res.json(await src.checkClientSources(getDb(), client.id));
});

router.post('/articles', async (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  let art;
  try {
    art = await src.fetchArticle(req.body.url);
  } catch (err) {
    return res.status(422).json({ error: 'Impossibile leggere l\'articolo: ' + err.message });
  }
  const db = getDb();
  const added = src.saveNewArticles(db, client.id, null, [art]);
  if (!added.length) {
    const existing = db.prepare('SELECT * FROM source_articles WHERE client_id = ? AND url = ?').get(client.id, art.url);
    if (existing && existing.status === 'ignored') db.prepare("UPDATE source_articles SET status = 'new' WHERE id = ?").run(existing.id);
    return res.json({ ok: true, article: existing, existing: true });
  }
  res.status(201).json({ ok: true, article: db.prepare('SELECT * FROM source_articles WHERE id = ?').get(added[0].id) });
});

router.post('/articles/:articleId/status', (req, res) => {
  const status = req.body.status;
  if (!['new', 'ignored'].includes(status)) return res.status(400).json({ error: 'status non valido' });
  const r = getDb().prepare("UPDATE source_articles SET status = ? WHERE id = ? AND client_id = ? AND status != 'used'")
    .run(status, req.params.articleId, req.params.clientId);
  if (!r.changes) return res.status(404).json({ error: 'Articolo non trovato o già usato' });
  res.json({ ok: true });
});

/**
 * Mese del piano (1-based) a partire dalla data di pubblicazione e dal mese di
 * inizio del piano. null se non calcolabile (piano senza start_year_month).
 */
function monthNumberFor(dateStr, startYM) {
  const d = /^(\d{4})-(\d{2})-\d{2}$/.exec(dateStr || '');
  const s = /^(\d{4})-(\d{2})$/.exec(startYM || '');
  if (!d || !s) return null;
  return (Number(d[1]) - Number(s[1])) * 12 + (Number(d[2]) - Number(s[2])) + 1;
}

router.post('/articles/:articleId/create-post', async (req, res) => {
  const client = loadClient(req, res);
  if (!client) return;
  const db = getDb();
  const article = db.prepare('SELECT * FROM source_articles WHERE id = ? AND client_id = ?').get(req.params.articleId, client.id);
  if (!article) return res.status(404).json({ error: 'Articolo non trovato' });
  if (article.post_id && db.prepare('SELECT id FROM posts WHERE id = ?').get(article.post_id)) {
    return res.status(409).json({ error: 'Da questo articolo è già stato creato un post', post_id: article.post_id });
  }

  const { editorial_plan_id, scheduled_date, scheduled_time } = req.body;
  if (scheduled_date && !/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) return res.status(400).json({ error: 'Data non valida (AAAA-MM-GG)' });
  if (scheduled_time && !/^\d{2}:\d{2}$/.test(scheduled_time)) return res.status(400).json({ error: 'Ora non valida (HH:MM)' });

  const plan = editorial_plan_id
    ? db.prepare('SELECT * FROM editorial_plans WHERE id = ? AND client_id = ?').get(editorial_plan_id, client.id)
    : db.prepare('SELECT * FROM editorial_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1').get(client.id);
  if (!plan) return res.status(400).json({ error: 'Il cliente non ha piani editoriali: creane uno (anche vuoto) prima di generare post dagli articoli' });

  const warnings = [];
  let monthNumber = monthNumberFor(scheduled_date, plan.start_year_month);
  if (monthNumber === null) {
    monthNumber = 1;
    if (scheduled_date) warnings.push('Il piano non ha un mese di inizio: il post è stato messo nel Mese 1');
  } else if (monthNumber < 1) {
    return res.status(400).json({ error: `La data è precedente all'inizio del piano (${plan.start_year_month})` });
  }
  const weekNumber = scheduled_date ? Math.min(5, Math.ceil(Number(scheduled_date.slice(8, 10)) / 7)) : 1;

  // Testo completo dell'articolo per il riassunto (i dati del feed sono solo un estratto)
  let full = { ...article };
  try {
    const fetched = await src.fetchArticle(article.url);
    full = {
      ...article,
      title: article.title || fetched.title,
      author: article.author || fetched.author,
      excerpt: article.excerpt || fetched.excerpt,
      image_url: article.image_url || fetched.image_url,
      published_at: article.published_at || fetched.published_at,
      text: fetched.text
    };
    db.prepare('UPDATE source_articles SET title = ?, author = ?, excerpt = ?, image_url = ?, published_at = ? WHERE id = ?')
      .run(full.title, full.author, full.excerpt, full.image_url, full.published_at, article.id);
  } catch (err) {
    warnings.push('Testo completo non leggibile, riassunto basato sull\'estratto del feed: ' + err.message);
  }
  if (!full.text && !full.excerpt) return res.status(422).json({ error: 'Articolo senza testo leggibile: impossibile riassumerlo' });

  let caption;
  try {
    caption = await src.generateArticleCaption(client, full);
  } catch (err) {
    return res.status(502).json({ error: 'Generazione caption fallita: ' + err.message });
  }

  const postId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO posts (id, client_id, editorial_plan_id, month_number, week_number, category, sub_topic, template,
                       media_type, caption, caption_ai_raw, scheduled_date, scheduled_time, status, source_article_url)
    VALUES (?, ?, ?, ?, ?, 'Articoli', ?, 'quote', 'single_image', ?, ?, ?, ?, 'caption_generated', ?)
  `).run(postId, client.id, plan.id, monthNumber, weekNumber, (full.title || 'Articolo').slice(0, 200),
    caption.text, JSON.stringify(caption.raw || null), scheduled_date || null, scheduled_time || null, article.url);

  if (full.image_url) {
    let tmp = null;
    try {
      tmp = await src.downloadCoverAsJpeg(full.image_url);
      await postMedia.attachUploadedFile({ clientId: client.id, postId, tmpPath: tmp, originalName: 'copertina-articolo.jpg', mimetype: 'image/jpeg', source: 'article' });
    } catch (err) {
      warnings.push('Immagine di copertina non allegata: ' + err.message);
    } finally {
      if (tmp && fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (_) {} }
    }
  } else {
    warnings.push('L\'articolo non ha un\'immagine di copertina: aggiungila dall\'editor (o il post uscirà solo testo)');
  }

  db.prepare("UPDATE source_articles SET status = 'used', post_id = ? WHERE id = ?").run(postId, article.id);

  const sched = db.prepare('SELECT is_active FROM schedules WHERE editorial_plan_id = ? AND month_number = ?').get(plan.id, monthNumber);
  if (scheduled_date && !(sched && sched.is_active)) {
    warnings.push(`Il Mese ${monthNumber} del piano non è attivo: il post uscirà solo dopo "Attiva piano" per quel mese (o con pubblicazione manuale)`);
  }

  audit.logFromReq(req, { client_id: client.id, action: 'post.created_from_article', entity_type: 'post', entity_id: postId, details: { article_url: article.url, plan_id: plan.id, month_number: monthNumber } });
  res.status(201).json({ ok: true, post_id: postId, editor_url: '/dashboard/posts/' + postId, month_number: monthNumber, warnings });
});

module.exports = router;
module.exports.monthNumberFor = monthNumberFor;
