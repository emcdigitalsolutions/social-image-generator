/**
 * article-sources.js — fonti articoli per cliente (rivista online, blog, news).
 *
 * Flusso:
 *   1. In Impostazioni cliente si aggiunge una fonte (URL del sito/rivista o del feed).
 *      resolveSource() capisce se è un feed RSS/Atom, se la pagina ne dichiara uno,
 *      se risponde un percorso standard (/feed, /rss.xml…) oppure se va letta come
 *      pagina HTML (link agli articoli).
 *   2. checkClientSources() legge le fonti attive e salva gli articoli NUOVI in
 *      source_articles (UNIQUE client+url → niente doppioni). Gira ogni mattina
 *      via cron e on-demand dal pulsante "Controlla ora".
 *   3. createPostFromArticle() legge l'articolo, genera con l'AI una caption che
 *      lo riassume (pensata per LinkedIn), crea il post nel piano/mese giusto e
 *      allega l'immagine di copertina (convertita in JPEG).
 *
 * Nessuna dipendenza esterna: parser RSS/Atom/HTML minimale ma tollerante.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FETCH_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_ARTICLE_TEXT = 12000;
const MAX_ITEMS_PER_SOURCE = 30;
const USER_AGENT = 'Mozilla/5.0 (compatible; EMC-SMM-ArticleReader/1.0; +https://www.emcdigitalsolutions.it)';
const FEED_PATHS = ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/blog/feed', '/news/feed'];

// ─────────────── Utilità testo/HTML ───────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', euro: '€', copy: '©', reg: '®',
  agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù', Agrave: 'À', Egrave: 'È', Eacute: 'É'
};

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED_ENTITIES[n] !== undefined ? NAMED_ENTITIES[n] : m));
}
function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch (_) { return ''; }
}

function stripCdata(s) {
  return String(s || '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

/** HTML → testo leggibile (paragrafi separati da riga vuota). */
function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(String(html)
    .replace(/<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return max && t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function absUrl(href, base) {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch (_) { return null; }
}

function tagContent(block, names) {
  for (const n of names) {
    const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i');
    const m = block.match(re);
    if (m) return stripCdata(m[1]);
  }
  return '';
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]) : null;
}

function toIsoDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function firstImgSrc(html, base) {
  const m = String(html || '').match(/<img\b[^>]*>/i);
  return m ? absUrl(attr(m[0], 'src'), base) : null;
}

// ─────────────── Feed RSS / Atom ───────────────

function looksLikeFeed(text) {
  const head = String(text || '').slice(0, 2000);
  return /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(head);
}

/** Parsa RSS 2.0 / RSS 1.0 (RDF) / Atom. Ritorna articoli normalizzati. */
function parseFeed(xml, baseUrl) {
  const out = [];
  const text = String(xml || '');
  const isAtom = /<feed[\s>]/i.test(text.slice(0, 2000)) && !/<rss[\s>]/i.test(text.slice(0, 2000));
  const blocks = isAtom
    ? text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []
    : text.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

  for (const b of blocks) {
    let url = null;
    if (isAtom) {
      const links = b.match(/<link\b[^>]*>/gi) || [];
      const alt = links.find(l => !attr(l, 'rel') || attr(l, 'rel') === 'alternate') || links[0];
      url = alt ? absUrl(attr(alt, 'href'), baseUrl) : null;
    } else {
      url = absUrl(decodeEntities(tagContent(b, ['link']).trim()), baseUrl)
        || absUrl(decodeEntities(tagContent(b, ['guid']).trim()), baseUrl);
    }
    if (!url) continue;

    // Atom/RSS possono portare l'HTML come testo con escape (&lt;p&gt;…)
    const unescape = h => (/&lt;[a-z/]/i.test(h) && !/<[a-z]/i.test(h) ? decodeEntities(h) : h);
    const contentHtml = unescape(tagContent(b, ['content:encoded', 'content']));
    const summaryHtml = unescape(tagContent(b, ['description', 'summary']));
    let image = null;
    const media = b.match(/<media:(content|thumbnail)\b[^>]*>/i);
    if (media) image = absUrl(attr(media[0], 'url'), baseUrl);
    if (!image) {
      const enc = (b.match(/<enclosure\b[^>]*>/gi) || []).find(e => /^image\//i.test(attr(e, 'type') || ''));
      if (enc) image = absUrl(attr(enc, 'url'), baseUrl);
    }
    if (!image) image = firstImgSrc(contentHtml || summaryHtml, url);

    const authorRaw = tagContent(b, ['dc:creator', 'author']);
    out.push({
      url,
      title: oneLine(htmlToText(decodeEntities(tagContent(b, ['title']))), 300),
      excerpt: oneLine(htmlToText(decodeEntities(summaryHtml || contentHtml)), 600),
      author: oneLine(htmlToText(tagContent(authorRaw, ['name']) || authorRaw), 120) || null,
      image_url: image,
      published_at: toIsoDate(tagContent(b, ['pubDate', 'published', 'updated', 'dc:date']))
    });
    if (out.length >= MAX_ITEMS_PER_SOURCE) break;
  }
  return out;
}

/** <link rel="alternate" type="application/rss+xml" href="…"> dichiarati dalla pagina. */
function findFeedLinks(html, baseUrl) {
  const links = String(html || '').match(/<link\b[^>]*>/gi) || [];
  return links
    .filter(l => /alternate/i.test(attr(l, 'rel') || '') && /(rss|atom)\+xml/i.test(attr(l, 'type') || ''))
    .map(l => absUrl(attr(l, 'href'), baseUrl))
    .filter(u => u && !/comments/i.test(u));
}

// ─────────────── Pagina HTML (fallback senza feed) ───────────────

/**
 * Estrae i link che sembrano articoli da una pagina elenco (home rivista, /news…).
 * Euristica: stesso dominio, percorso "profondo" con slug a trattini, oppure
 * link dentro <article>/<h2>/<h3>. Esclude tag/categorie/autori/pagine legali.
 */
function extractArticleLinks(html, pageUrl) {
  const base = new URL(pageUrl);
  const seen = new Map();
  const EXCLUDE = /\/(tag|tags|category|categorie|categoria|author|autore|page|pagina|search|wp-login|wp-admin|feed|login|privacy|cookie|contatti|contact|chi-siamo|about)(\/|$)|\.(jpg|jpeg|png|gif|webp|pdf|zip|xml)$/i;
  const consider = (href, text, strong) => {
    const u = absUrl(href, pageUrl);
    if (!u) return;
    const p = new URL(u);
    if (p.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return;
    if (EXCLUDE.test(p.pathname)) return;
    const pathClean = p.pathname.replace(/\/+$/, '');
    if (!pathClean || pathClean === base.pathname.replace(/\/+$/, '')) return;
    const slug = pathClean.split('/').pop();
    const slugLike = /[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i.test(slug);
    if (!strong && !slugLike) return;
    const title = oneLine(htmlToText(text), 300);
    const prev = seen.get(u);
    if (!prev || (title.length > (prev.title || '').length)) seen.set(u, { url: u, title: title || null });
  };

  const h = String(html || '');
  for (const block of h.match(/<(article|h2|h3)\b[\s\S]*?<\/\1>/gi) || []) {
    const a = block.match(/<a\b[^>]*href\s*=[^>]*>([\s\S]*?)<\/a>/i);
    if (a) consider(attr(a[0], 'href'), a[1], true);
  }
  for (const a of h.match(/<a\b[^>]*href\s*=[^>]*>[\s\S]*?<\/a>/gi) || []) {
    const inner = a.replace(/^<a\b[^>]*>/i, '').replace(/<\/a>$/i, '');
    consider(attr(a, 'href'), inner, false);
  }
  return [...seen.values()].slice(0, MAX_ITEMS_PER_SOURCE);
}

/** Metadati + testo di un singolo articolo (Open Graph, JSON-LD, <article>). */
function extractArticle(html, url) {
  const h = String(html || '');
  const metas = h.match(/<meta\b[^>]*>/gi) || [];
  const meta = (...keys) => {
    for (const k of keys) {
      const m = metas.find(t => (attr(t, 'property') || attr(t, 'name') || '').toLowerCase() === k);
      if (m && attr(m, 'content')) return decodeEntities(attr(m, 'content'));
    }
    return null;
  };

  // JSON-LD (Article/NewsArticle/BlogPosting): spesso ha autore e data affidabili
  let ld = {};
  for (const s of h.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
    try {
      const data = JSON.parse(s.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, ''));
      const nodes = [].concat(data['@graph'] || data);
      const art = nodes.find(n => n && /Article|BlogPosting|NewsArticle|Report/i.test([].concat(n['@type'] || '').join(' ')));
      if (art) { ld = art; break; }
    } catch (_) { /* JSON-LD malformato: ignorato */ }
  }
  const ldAuthor = [].concat(ld.author || []).map(a => (typeof a === 'string' ? a : a && a.name)).filter(Boolean).join(', ');
  const ldImage = [].concat(ld.image || []).map(i => (typeof i === 'string' ? i : i && i.url)).find(Boolean);

  const articleHtml = (h.match(/<article\b[\s\S]*?<\/article>/i) || [])[0]
    || (h.match(/<main\b[\s\S]*?<\/main>/i) || [])[0]
    || (h.match(/<p\b[\s\S]*<\/p>/i) || [])[0]
    || '';
  let text = htmlToText(articleHtml);
  if (text.length > MAX_ARTICLE_TEXT) text = text.slice(0, MAX_ARTICLE_TEXT) + '…';

  const titleTag = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  return {
    url: absUrl(meta('og:url'), url) || url,
    title: oneLine(meta('og:title', 'twitter:title') || ld.headline || htmlToText(titleTag || ''), 300) || null,
    excerpt: oneLine(meta('og:description', 'description', 'twitter:description') || ld.description || '', 600) || null,
    author: oneLine(meta('author', 'article:author') || ldAuthor || '', 120) || null,
    image_url: absUrl(meta('og:image', 'og:image:url', 'twitter:image') || ldImage, url) || firstImgSrc(articleHtml, url),
    published_at: toIsoDate(meta('article:published_time') || ld.datePublished),
    site_name: meta('og:site_name'),
    text
  };
}

// ─────────────── Rete ───────────────

async function httpGet(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_HTML_BYTES) throw new Error('Pagina troppo grande');
  return { status: res.status, ok: res.ok, url: res.url || url, text: buf.toString('utf-8'), contentType: res.headers.get('content-type') || '' };
}

function normalizeInputUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('URL mancante');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error('URL non valido');
  return u.toString();
}

/**
 * Capisce come leggere una fonte. Ritorna { type: 'rss'|'page', feed_url, url, title, sample }
 * dove sample sono gli articoli trovati subito (anteprima per l'utente).
 */
async function resolveSource(rawUrl) {
  const url = normalizeInputUrl(rawUrl);
  const page = await httpGet(url);
  if (!page.ok) throw new Error(`Il sito risponde HTTP ${page.status}`);

  if (looksLikeFeed(page.text)) {
    return { type: 'rss', url, feed_url: page.url, title: oneLine(htmlToText(tagContent(page.text, ['title'])), 120) || null, sample: parseFeed(page.text, page.url) };
  }

  const candidates = [...findFeedLinks(page.text, page.url)];
  const origin = new URL(page.url).origin;
  for (const p of FEED_PATHS) candidates.push(origin + p);
  const pagePath = new URL(page.url).pathname.replace(/\/+$/, '');
  if (pagePath) candidates.unshift(origin + pagePath + '/feed');

  for (const feedUrl of [...new Set(candidates)]) {
    try {
      const f = await httpGet(feedUrl);
      if (f.ok && looksLikeFeed(f.text)) {
        const items = parseFeed(f.text, f.url);
        if (items.length) return { type: 'rss', url, feed_url: f.url, title: oneLine(htmlToText(tagContent(f.text, ['title'])), 120) || null, sample: items };
      }
    } catch (_) { /* candidato non valido: provo il successivo */ }
  }

  const links = extractArticleLinks(page.text, page.url);
  if (!links.length) throw new Error('Nessun feed RSS e nessun link ad articoli trovato in questa pagina: indica la pagina che elenca gli articoli (es. /news o /blog)');
  return { type: 'page', url, feed_url: null, title: oneLine(htmlToText((page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''), 120) || null, sample: links };
}

/** Legge una fonte già configurata e ritorna gli articoli correnti. */
async function readSource(source) {
  if (source.type === 'rss' && source.feed_url) {
    const f = await httpGet(source.feed_url);
    if (!f.ok) throw new Error(`Feed HTTP ${f.status}`);
    if (!looksLikeFeed(f.text)) throw new Error('Il feed non risponde più in formato RSS/Atom');
    return parseFeed(f.text, f.url);
  }
  const p = await httpGet(source.url);
  if (!p.ok) throw new Error(`Pagina HTTP ${p.status}`);
  return extractArticleLinks(p.text, p.url);
}

async function fetchArticle(url) {
  const p = await httpGet(normalizeInputUrl(url));
  if (!p.ok) throw new Error(`Articolo HTTP ${p.status}`);
  return extractArticle(p.text, p.url);
}

// ─────────────── DB ───────────────

/** Salva gli articoli non ancora visti. Ritorna quelli inseriti. */
function saveNewArticles(db, clientId, sourceId, items) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO source_articles (id, client_id, source_id, url, title, excerpt, author, image_url, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const added = [];
  db.transaction(() => {
    for (const it of items) {
      const id = crypto.randomUUID();
      const r = ins.run(id, clientId, sourceId, it.url, it.title || null, it.excerpt || null, it.author || null, it.image_url || null, it.published_at || null);
      if (r.changes) added.push({ id, ...it });
    }
  })();
  return added;
}

/**
 * Controlla tutte le fonti attive di un cliente. Alla PRIMA lettura di una fonte
 * gli articoli già esistenti vengono marcati 'ignored' (sono lo storico): così
 * l'utente non si ritrova 30 "novità" e l'avviso riguarda solo gli articoli
 * usciti dopo l'attivazione. Lo storico resta visibile e utilizzabile.
 */
async function checkClientSources(db, clientId) {
  const sources = db.prepare('SELECT * FROM client_sources WHERE client_id = ? AND is_active = 1').all(clientId);
  const report = { checked: 0, added: [], errors: [] };
  for (const s of sources) {
    try {
      const items = await readSource(s);
      const firstRun = !s.last_checked_at;
      const added = saveNewArticles(db, clientId, s.id, items);
      if (firstRun && added.length) {
        const mark = db.prepare("UPDATE source_articles SET status = 'ignored' WHERE id = ?");
        // Le 3 più recenti restano 'new' come spunto immediato.
        const sorted = [...added].sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
        for (const a of sorted.slice(3)) mark.run(a.id);
        report.added.push(...sorted.slice(0, 3).map(a => ({ ...a, source: s.label || s.url })));
      } else {
        report.added.push(...added.map(a => ({ ...a, source: s.label || s.url })));
      }
      db.prepare("UPDATE client_sources SET last_checked_at = datetime('now'), last_error = NULL WHERE id = ?").run(s.id);
      report.checked++;
    } catch (err) {
      db.prepare("UPDATE client_sources SET last_checked_at = datetime('now'), last_error = ? WHERE id = ?").run(err.message.substring(0, 300), s.id);
      report.errors.push({ source: s.label || s.url, error: err.message });
    }
  }
  return report;
}

// ─────────────── AI: caption riassunto ───────────────

function buildArticlePrompt(client, article, opts = {}) {
  const guidelines = (client.article_caption_guidelines || '').trim();
  const system = [
    client.system_instruction || `Sei il social media manager di ${client.display_name}.`,
    '',
    'COMPITO SPECIFICO: trasformi gli articoli pubblicati dal cliente in post LinkedIn professionali che ne riassumono il contenuto e invitano a leggerli.'
  ].join('\n');

  const user = `Scrivi un post LinkedIn per ${client.display_name} che riassuma questo articolo.

ARTICOLO
Titolo: ${article.title || '(senza titolo)'}
${article.author ? `Autore: ${article.author}\n` : ''}${article.published_at ? `Data: ${article.published_at.slice(0, 10)}\n` : ''}URL: ${article.url}
Sommario: ${article.excerpt || '(non disponibile)'}

Testo:
"""
${(article.text || article.excerpt || '').slice(0, MAX_ARTICLE_TEXT)}
"""

STRUTTURA DEL POST
1. Prima riga = gancio forte e specifico (max 140 caratteri): è l'unica parte visibile prima di "…altro".
2. 2-3 frasi che spiegano il tema e perché conta per manager e imprese.
3. 3 punti chiave dell'articolo, uno per riga, che iniziano con "→ ".
${article.author ? `4. Cita l'autore (${article.author}) e il suo punto di vista.\n` : ''}5. Chiusura con una domanda o un invito alla discussione, poi la riga: "Leggi l'articolo completo: ${article.url}"
6. In fondo 3-5 hashtag pertinenti.

REGOLE
- Lunghezza: 120-220 parole. Tono autorevole ma accessibile, niente gergo inutile.
- Usa SOLO informazioni presenti nell'articolo: non inventare dati, numeri, citazioni o nomi.
- Testo semplice: niente markdown (niente **, __, #titoli), niente preamboli tipo "Ecco il post".
- L'URL va scritto esattamente come sopra.
${opts.language ? `- Lingua del post: ${opts.language}.` : "- Scrivi nella lingua dell'articolo, salvo indicazioni diverse nelle linee guida."}
${guidelines ? `\nLINEE GUIDA DEL CLIENTE (hanno la precedenza):\n${guidelines}` : ''}

Rispondi SOLO con il testo del post.`;
  return { system, user };
}

/** Pulizia output AI: niente preamboli/markdown, URL garantito. */
function cleanCaption(text, articleUrl) {
  let out = String(text || '').trim();
  out = out.replace(/^\s*(ecco|eccoti|certo|certamente|perfetto|ok|here is|here's)[^\n]*\n+/i, '');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/^"""|"""$/g, '').trim();
  if (articleUrl && !out.includes(articleUrl)) {
    // Inserisce il link prima degli hashtag finali (se presenti)
    const m = out.match(/\n+((?:#[\p{L}\p{N}_]+\s*)+)$/u);
    const link = `Leggi l'articolo completo: ${articleUrl}`;
    out = m ? out.slice(0, m.index) + '\n\n' + link + '\n\n' + m[1].trim() : out + '\n\n' + link;
  }
  return out;
}

async function generateArticleCaption(client, article, opts = {}) {
  const { callAI } = require('./ai-provider');
  const { system, user } = buildArticlePrompt(client, article, opts);
  const result = await callAI(client, system, user, { maxTokens: 2048, temperature: 0.6 });
  return { text: cleanCaption(result.text, article.url), raw: result.raw };
}

// ─────────────── Immagine di copertina ───────────────

/** Scarica l'immagine e la converte in JPEG (LinkedIn e Meta non accettano WebP). */
async function downloadCoverAsJpeg(imageUrl) {
  const res = await fetch(imageUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Immagine HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sharp = require('sharp');
  const jpg = await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  const tmp = path.join(os.tmpdir(), 'article-cover-' + crypto.randomUUID() + '.jpg');
  fs.writeFileSync(tmp, jpg);
  return tmp;
}

module.exports = {
  // parsing (puri, testati)
  decodeEntities, htmlToText, parseFeed, findFeedLinks, extractArticleLinks, extractArticle,
  looksLikeFeed, normalizeInputUrl, buildArticlePrompt, cleanCaption,
  // rete / db
  resolveSource, readSource, fetchArticle, saveNewArticles, checkClientSources,
  generateArticleCaption, downloadCoverAsJpeg
};
