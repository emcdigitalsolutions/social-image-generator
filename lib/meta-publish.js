/**
 * meta-publish.js — pubblicazione su Facebook + Instagram via Graph API.
 * Supporta: single image, carousel (2-10 media stesso tipo), video, reel.
 *
 * Pattern unificato per ogni post:
 *   publishPost(client, post, media)
 *     → analizza post.media_type
 *     → invoca il flusso giusto per FB e per IG
 *     → ritorna { fb_post_id, ig_media_id, errors }
 *
 * Garanzie anti-duplicato (vedi incidente fratellidirosa 13/06/2026):
 *   - IDEMPOTENZA PER-CANALE: se il post ha già un id per un canale (es. fb_post_id),
 *     quel canale NON viene ripubblicato. Su retry si completano solo i canali mancanti.
 *   - RETRY TRANSITORI: gli errori temporanei di Meta (code 1/2/4/17/…) vengono
 *     ritentati con backoff invece di fallire subito (evita il "auto fallisce, manuale ok").
 *   - VERIFICA FB ANTI-FALSO-NEGATIVO: FB /photos a volte risponde code=1 pur avendo
 *     creato il post. Prima di considerarlo fallito (e prima di ritentare), interroghiamo
 *     i post recenti della Page e, se troviamo il nostro, ne adottiamo l'id.
 *   - NIENTE ROLLBACK DISTRUTTIVO: un successo parziale non viene più cancellato
 *     (il delete IG falliva comunque per permessi). Lo stato parziale è conservato e
 *     completato dal retry idempotente.
 */
'use strict';

const https = require('https');

const GRAPH_API_VERSION = 'v25.0';
const FB_HOST = 'graph.facebook.com';
// NOTA: IG_HOST (graph.instagram.com) era usato per il pattern legacy con
// IG User Token (IGAA...). Dopo il refactor multi-cliente, tutte le chiamate
// IG passano via FB_HOST con Page Token — serve che l'IG Business sia collegato
// alla Page FB. Vedi memory/client-onboarding-meta.md.

// Polling per video/reel container (status_code FINISHED)
const VIDEO_POLL_MAX_MS = 10 * 60 * 1000; // 10 minuti
const VIDEO_POLL_INTERVAL_MS = 5000;       // 5s

const HTTP_TIMEOUT_MS = 60 * 1000;         // hard timeout per chiamata Meta

// Codici errore Meta considerati TRANSITORI (vanno ritentati con backoff).
//   1   = generico "Please reduce the amount of data… / unknown" (spesso load Meta)
//   2   = "An unexpected error has occurred. Please retry your request later"
//   4   = application request limit reached (rate limit)
//   17  = user request limit reached (rate limit)
//   32  = page request limit reached
//   341 = temporarily blocked for policies / feature limit
//   368 = temporarily blocked
//   613 = calls to this api have exceeded the rate limit
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);

function isTransientMeta(err) {
  return !!err && TRANSIENT_META_CODES.has(Number(err.metaCode));
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/**
 * Ritenta una funzione async su errori Meta transitori, con backoff esponenziale.
 * NON usare su create FB single_image (rischio falso-negativo → duplicato): per
 * quello c'è la verifica dedicata in fbPublishSingleImage.
 */
async function withRetry(fn, { label = 'meta call', attempts = 3, baseDelayMs = 3000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      if (isLast || !isTransientMeta(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(`[meta] ${label}: errore transitorio (code=${err.metaCode}), retry ${i + 1}/${attempts - 1} fra ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Aggiunge un cache-buster all'URL basato su created_at del media, per evitare
// che Meta / CDN riusino una versione in cache (es. dopo crop il file è cambiato
// ma il path resta identico → Meta scarica la versione vecchia).
function withCacheBuster(url, createdAt) {
  if (!url) return url;
  const ts = createdAt ? Date.parse(createdAt + (createdAt.includes('Z') ? '' : 'Z')) : Date.now();
  const v = Number.isFinite(ts) ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000);
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'v=' + v;
}

// ─────────────── HTTP helper ───────────────

function httpRequest(host, pathAndQuery, method, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname: host, path: pathAndQuery, method, headers: {} };
    let bodyStr = '';
    if (body && method === 'POST') {
      bodyStr = new URLSearchParams(body).toString();
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${host}: ${data.substring(0, 200)}`)); }
      });
    });
    // Hard timeout: senza questo una richiesta appesa bloccherebbe l'intero
    // tick dello scheduler (che è seriale per post).
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout ${HTTP_TIMEOUT_MS}ms da ${host}`));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function urlBase(host, pathAfterVersion) {
  return `/${GRAPH_API_VERSION}/${pathAfterVersion}`;
}

// ─────────────── Token helpers ───────────────

async function getPageToken(systemUserToken, pageId) {
  const path = urlBase(FB_HOST, `me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(systemUserToken)}`);
  const result = await httpRequest(FB_HOST, path, 'GET');
  if (result.error) throw new Error(result.error.message);
  if (!result.data || !result.data.length) throw new Error('No pages available for this system user token');
  // Se pageId specificato, cerca quello specifico (caso multi-cliente).
  // Altrimenti ritorna la prima (backward-compat).
  if (pageId) {
    const match = result.data.find(p => p.id === String(pageId));
    if (!match) {
      throw new Error(`Page ${pageId} not in system user assets (only found: ${result.data.map(p => p.id).join(', ')})`);
    }
    return match.access_token;
  }
  return result.data[0].access_token;
}

// ─────────────── Error helpers ───────────────

function fmtMetaErr(prefix, r) {
  const e = (r && r.error) || {};
  const parts = [e.message || 'unknown'];
  if (e.code)                parts.push(`code=${e.code}`);
  if (e.error_subcode)       parts.push(`subcode=${e.error_subcode}`);
  if (e.error_user_title)    parts.push(`user_title="${e.error_user_title}"`);
  if (e.error_user_msg)      parts.push(`user_msg="${e.error_user_msg}"`);
  if (e.type)                parts.push(`type=${e.type}`);
  if (e.fbtrace_id)          parts.push(`trace=${e.fbtrace_id}`);
  const detail = parts.join(' | ');
  console.error(`[meta] ${prefix} failed: ${detail}`);
  return `${prefix}: ${detail}`;
}

// Costruisce un Error che TRASPORTA il code Meta (per la classificazione transitoria).
function metaErr(prefix, r) {
  const e = new Error(fmtMetaErr(prefix, r));
  const me = (r && r.error) || {};
  e.metaCode = me.code;
  e.metaSubcode = me.error_subcode;
  return e;
}

// ─────────────── Instagram ───────────────

async function igCreateImageContainer(igUserId, pageToken, imageUrl, opts = {}) {
  const body = { image_url: imageUrl, access_token: pageToken };
  if (opts.caption) body.caption = opts.caption;
  if (opts.is_carousel_item) body.is_carousel_item = 'true';
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${igUserId}/media`), 'POST', body);
  if (r.error) throw metaErr('IG image container', r);
  return r.id;
}

async function igCreateVideoContainer(igUserId, pageToken, videoUrl, opts = {}) {
  // Meta ha deprecato media_type=VIDEO (subcode 2207067).
  // Tutti i video IG ora usano REELS — share_to_feed controlla se appare
  // anche nel feed normale (true) oppure solo nella tab Reels (false).
  const body = {
    video_url: videoUrl,
    media_type: 'REELS',
    access_token: pageToken
  };
  if (opts.caption) body.caption = opts.caption;
  if (opts.is_carousel_item) body.is_carousel_item = 'true';
  // share_to_feed default true (visibile in feed). Solo se esplicitamente
  // chiesto false (es. Reel "puro" che vive solo in tab Reels), passa false.
  if (opts.share_to_feed !== false) body.share_to_feed = 'true';
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${igUserId}/media`), 'POST', body);
  if (r.error) throw metaErr('IG video container', r);
  return r.id;
}

async function igCreateCarouselContainer(igUserId, pageToken, childIds, caption) {
  const body = {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    access_token: pageToken
  };
  if (caption) body.caption = caption;
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${igUserId}/media`), 'POST', body);
  if (r.error) throw metaErr('IG carousel container', r);
  return r.id;
}

async function igPublishContainer(igUserId, pageToken, creationId) {
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${igUserId}/media_publish`), 'POST', {
    creation_id: creationId,
    access_token: pageToken
  });
  if (r.error) throw metaErr('IG publish', r);
  return r.id;
}

async function igPollVideoReady(pageToken, containerId) {
  const start = Date.now();
  while (Date.now() - start < VIDEO_POLL_MAX_MS) {
    const path = urlBase(FB_HOST, `${containerId}?fields=status_code,status&access_token=${encodeURIComponent(pageToken)}`);
    const r = await httpRequest(FB_HOST, path, 'GET');
    if (r.error) throw metaErr('IG poll', r);
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR') throw new Error(`IG video processing ERROR (status=${r.status || 'n/a'})`);
    if (r.status_code === 'EXPIRED') throw new Error('IG video processing EXPIRED');
    await sleep(VIDEO_POLL_INTERVAL_MS);
  }
  throw new Error('IG video timeout (10min) waiting for FINISHED');
}

async function publishToInstagram(client, post, media) {
  const igUserId = client.ig_user_id;
  // Page Token (con scope IG) derivato dal system user → usato anche per IG.
  // Richiede che l'IG Business sia collegato alla Page FB del cliente.
  const token = client._fb_page_token;
  const caption = post.caption || '';

  if (post.media_type === 'single_image') {
    const m = media[0];
    const cid = await withRetry(
      () => igCreateImageContainer(igUserId, token, withCacheBuster(m.url, m.created_at), { caption }),
      { label: 'IG image container' }
    );
    await sleep(3000);
    return withRetry(() => igPublishContainer(igUserId, token, cid), { label: 'IG publish' });
  }

  if (post.media_type === 'carousel') {
    const childIds = [];
    for (const m of media) {
      let cid;
      if (m.kind === 'video') {
        cid = await withRetry(
          () => igCreateVideoContainer(igUserId, token, withCacheBuster(m.url, m.created_at), { is_carousel_item: true }),
          { label: 'IG carousel video child' }
        );
        await igPollVideoReady(token, cid);
      } else {
        cid = await withRetry(
          () => igCreateImageContainer(igUserId, token, withCacheBuster(m.url, m.created_at), { is_carousel_item: true }),
          { label: 'IG carousel image child' }
        );
      }
      childIds.push(cid);
    }
    const carouselId = await withRetry(
      () => igCreateCarouselContainer(igUserId, token, childIds, caption),
      { label: 'IG carousel container' }
    );
    await sleep(3000);
    return withRetry(() => igPublishContainer(igUserId, token, carouselId), { label: 'IG publish' });
  }

  if (post.media_type === 'video' || post.media_type === 'reel') {
    const m = media[0];
    // post.ig_share_to_feed: 1/true (default) = appare anche in feed,
    // 0/false = Reel "puro" visibile solo in tab Reels.
    // Nota: la colonna SQLite ritorna 0/1 (INTEGER), trattiamo entrambi.
    const shareToFeed = post.ig_share_to_feed === 0 ? false : true;
    const cid = await withRetry(
      () => igCreateVideoContainer(igUserId, token, withCacheBuster(m.url, m.created_at), { caption, share_to_feed: shareToFeed }),
      { label: 'IG video container' }
    );
    await igPollVideoReady(token, cid);
    return withRetry(() => igPublishContainer(igUserId, token, cid), { label: 'IG publish' });
  }

  throw new Error('Unsupported media_type: ' + post.media_type);
}

// ─────────────── Facebook ───────────────

async function fbPublishPhoto(pageId, pageToken, imageUrl, caption, published = true) {
  const body = { url: imageUrl, access_token: pageToken, published: String(published) };
  if (caption) body.message = caption;
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${pageId}/photos`), 'POST', body);
  if (r.error) throw metaErr('FB photo', r);
  return r;
}

async function fbPublishVideo(pageId, pageToken, videoUrl, caption) {
  const body = { file_url: videoUrl, access_token: pageToken };
  if (caption) body.description = caption;
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${pageId}/videos`), 'POST', body);
  if (r.error) throw metaErr('FB video', r);
  return r.id;
}

/**
 * Predicato puro: cerca tra i post recenti della Page uno che combaci con la
 * caption e sia stato creato entro `withinMs`. Estratto per testabilità.
 * @param items - array di { id, message, created_time } (formato Graph /feed)
 * @returns l'id del post combaciante, oppure null.
 */
function matchRecentFbPost(items, caption, nowMs, withinMs) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const target = norm(caption);
  if (!target) return null; // caption vuota → impossibile disambiguare in sicurezza
  const cutoff = nowMs - withinMs;
  for (const item of items || []) {
    const t = item.created_time ? Date.parse(item.created_time) : NaN;
    if (Number.isFinite(t) && t >= cutoff && norm(item.message) === target) {
      return item.id;
    }
  }
  return null;
}

/**
 * Verifica anti-falso-negativo: FB /photos a volte risponde con errore (es. code=1)
 * pur avendo CREATO il post. Interroghiamo il feed recente della Page per capire se
 * il nostro post è effettivamente online, così da adottarne l'id invece di ritentare
 * (che creerebbe un duplicato).
 */
async function fbFindRecentPost(pageId, pageToken, caption, withinMs = 5 * 60 * 1000) {
  const path = urlBase(FB_HOST, `${pageId}/feed?fields=id,message,created_time&limit=15&access_token=${encodeURIComponent(pageToken)}`);
  const r = await httpRequest(FB_HOST, path, 'GET');
  if (r.error || !Array.isArray(r.data)) return null;
  return matchRecentFbPost(r.data, caption, Date.now(), withinMs);
}

/**
 * FB single image con protezione anti-duplicato:
 *   1. tenta la pubblicazione;
 *   2. su errore, verifica se il post è in realtà già online (falso negativo) → adotta l'id;
 *   3. se non è online ED è un errore transitorio, fa UN solo retry sicuro;
 *   4. altrimenti rilancia l'errore.
 */
async function fbPublishSingleImage(pageId, pageToken, imageUrl, caption) {
  const attempt = () => fbPublishPhoto(pageId, pageToken, imageUrl, caption, true);
  try {
    const r = await attempt();
    return r.post_id || r.id;
  } catch (err) {
    // 2) Falso negativo? Il post potrebbe essere stato creato comunque.
    const found = await fbFindRecentPost(pageId, pageToken, caption).catch(() => null);
    if (found) {
      console.log(`[meta] FB photo: falso negativo rilevato (code=${err.metaCode}), post già online: ${found}`);
      return found;
    }
    // 3) Non è online: se transitorio, un retry è sicuro (sappiamo che non ha creato nulla).
    if (isTransientMeta(err)) {
      console.warn(`[meta] FB photo: transitorio (code=${err.metaCode}) e nessun post trovato → retry singolo`);
      await sleep(3000);
      const found2 = await fbFindRecentPost(pageId, pageToken, caption).catch(() => null);
      if (found2) return found2; // creato nel frattempo
      const r2 = await attempt();
      return r2.post_id || r2.id;
    }
    throw err;
  }
}

// ─────────────── Facebook carousel/video ───────────────

async function fbPublishCarousel(pageId, pageToken, mediaItems, caption) {
  // Step 1: upload ogni foto come unpublished
  const photoIds = [];
  for (const m of mediaItems) {
    if (m.kind !== 'image') throw new Error('FB carousel: solo immagini supportate (no video misti)');
    const r = await withRetry(
      () => fbPublishPhoto(pageId, pageToken, withCacheBuster(m.url, m.created_at), null, false),
      { label: 'FB carousel photo' }
    );
    photoIds.push(r.id);
  }
  // Step 2: post di tipo feed con attached_media
  const attached = JSON.stringify(photoIds.map(id => ({ media_fbid: id })));
  const body = {
    message: caption || '',
    attached_media: attached,
    access_token: pageToken
  };
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${pageId}/feed`), 'POST', body);
  if (r.error) throw metaErr('FB carousel feed', r);
  return r.id;
}

async function publishToFacebook(client, post, media) {
  const pageId = client.fb_page_id;
  const pageToken = client._fb_page_token;
  const caption = post.caption || '';

  if (post.media_type === 'single_image') {
    return fbPublishSingleImage(pageId, pageToken, media[0].url, caption);
  }
  if (post.media_type === 'carousel') {
    return fbPublishCarousel(pageId, pageToken, media, caption);
  }
  if (post.media_type === 'video' || post.media_type === 'reel') {
    return withRetry(() => fbPublishVideo(pageId, pageToken, media[0].url, caption), { label: 'FB video' });
  }
  throw new Error('Unsupported media_type: ' + post.media_type);
}

// ─────────────── Public entry point ───────────────

/**
 * Rileva i canali pubblicabili per un cliente in base alle credenziali presenti.
 * Usato sia dallo scheduler (auto-publish) sia come default dell'endpoint manuale,
 * così i due percorsi restano coerenti.
 * @param client - row del client
 * @returns array di canali tra 'fb','ig','linkedin'. Fallback ['fb','ig'] se nulla configurato.
 */
function detectChannels(client) {
  const channels = [];
  if (client.fb_page_id && client.fb_system_user_token) channels.push('fb');
  if (client.ig_user_id && client.fb_system_user_token) channels.push('ig');
  if (client.linkedin_org_id && client.linkedin_access_token) channels.push('linkedin');
  if (client.tiktok_refresh_token || client.tiktok_access_token) channels.push('tiktok');
  return channels.length ? channels : ['fb', 'ig'];
}

/**
 * Pubblica un post.
 * @param client - row del client (con fb_*, ig_*)
 * @param post   - row del post (deve avere caption + media_type; può portare gli id
 *                 già pubblicati fb_post_id/ig_media_id/linkedin_post_id/tiktok_publish_id)
 * @param media  - array di post_media ordinato per position (almeno 1 item)
 * @param opts   - { channels?: ['fb','ig'] } — quali canali pubblicare. Default: entrambi.
 *
 * IDEMPOTENZA: i canali che hanno GIÀ un id sul post non vengono ripubblicati
 * (anti-duplicato su retry manuale/automatico). Vengono elencati in results.skipped.
 *
 * Compatibilità retroattiva: se chiamata con (client, imageUrl, caption)
 * costruisce un finto post single_image (vecchio scheduler ancora supportato).
 */
async function publishPost(client, post, media, opts = {}) {
  // Backward-compat: vecchio call pattern (client, imageUrl, caption)
  if (typeof post === 'string') {
    const imageUrl = post;
    const caption = media;
    post = { media_type: 'single_image', caption };
    media = [{ kind: 'image', url: imageUrl }];
  }

  // Componi la caption finale (caption base + menzioni @username + riga CTA) una
  // volta sola: FB/IG/LinkedIn leggono tutti da post.caption, quindi qui sotto
  // i branch ricevono già il testo completo. Se il post non ha menzioni né CTA
  // la caption resta invariata.
  const { composeCaption } = require('./post-caption');
  post = { ...post, caption: composeCaption(post) };

  const ALLOWED_CHANNELS = ['fb', 'ig', 'linkedin', 'tiktok'];
  const channels = (opts.channels && opts.channels.length)
    ? opts.channels.filter(c => ALLOWED_CHANNELS.includes(c))
    : ['fb', 'ig'];

  // IDEMPOTENZA: preserva gli id già presenti sul post. Un canale già pubblicato
  // non viene ritoccato → niente duplicati su retry.
  const results = {
    fb_post_id: post.fb_post_id || null,
    ig_media_id: post.ig_media_id || null,
    linkedin_post_id: post.linkedin_post_id || null,
    tiktok_publish_id: post.tiktok_publish_id || null,
    errors: [],
    skipped: [],
    channels
  };

  if (!media || !media.length) {
    results.errors.push('Nessun media da pubblicare');
    return results;
  }

  const wantFb = channels.includes('fb');
  const wantIg = channels.includes('ig');
  const wantLinkedIn = channels.includes('linkedin');
  const wantTikTok = channels.includes('tiktok');

  // Quali canali RESTANO da pubblicare (escludendo quelli già fatti)
  const needFb = wantFb && !results.fb_post_id;
  const needIg = wantIg && !results.ig_media_id;
  const needLinkedIn = wantLinkedIn && !results.linkedin_post_id;
  const needTikTok = wantTikTok && !results.tiktok_publish_id;

  if (wantFb && !needFb) results.skipped.push('fb');
  if (wantIg && !needIg) results.skipped.push('ig');
  if (wantLinkedIn && !needLinkedIn) results.skipped.push('linkedin');
  if (wantTikTok && !needTikTok) results.skipped.push('tiktok');
  if (results.skipped.length) {
    console.log(`[meta] Canali già pubblicati, salto: ${results.skipped.join(', ')} (post ${post.id || '?'})`);
  }

  // Pre-check credenziali Meta (FB+IG): solo se serve davvero pubblicare un canale Meta.
  if (needFb || needIg) {
    const missing = [];
    if (needFb && !client.fb_page_id) missing.push('fb_page_id');
    if (!client.fb_system_user_token) missing.push('fb_system_user_token');
    if (needIg && !client.ig_user_id) missing.push('ig_user_id');
    if (missing.length) {
      results.errors.push(`Configurazione Meta incompleta per cliente "${client.display_name || client.id}": manca ${missing.join(', ')}`);
    } else {
      // Token exchange Meta solo se le credenziali base ci sono
      try {
        client._fb_page_token = await getPageToken(client.fb_system_user_token, client.fb_page_id);
      } catch (err) {
        results.errors.push(`FB/IG token exchange: ${err.message}`);
      }
    }
  }

  // Pre-check credenziali LinkedIn
  if (needLinkedIn) {
    const missingLi = [];
    if (!client.linkedin_org_id) missingLi.push('linkedin_org_id');
    if (!client.linkedin_access_token) missingLi.push('linkedin_access_token');
    if (missingLi.length) {
      results.errors.push(`Configurazione LinkedIn incompleta per "${client.display_name || client.id}": manca ${missingLi.join(', ')}`);
    }
  }

  if (needFb && client._fb_page_token && client.fb_page_id) {
    try {
      results.fb_post_id = await publishToFacebook(client, post, media);
    } catch (err) {
      results.errors.push(`FB: ${err.message}`);
    }
  }

  if (needIg && client._fb_page_token && client.ig_user_id) {
    try {
      results.ig_media_id = await publishToInstagram(client, post, media);
    } catch (err) {
      results.errors.push(`IG: ${err.message}`);
    }
  }

  if (needLinkedIn && client.linkedin_org_id && client.linkedin_access_token) {
    try {
      const { publishToLinkedIn } = require('./linkedin-publish');
      results.linkedin_post_id = await publishToLinkedIn(client, post, media);
    } catch (err) {
      results.errors.push(`LinkedIn: ${err.message}`);
    }
  }

  // Pre-check + publish TikTok (credenziali separate, refresh automatico interno).
  if (needTikTok) {
    if (!client.tiktok_refresh_token && !client.tiktok_access_token) {
      results.errors.push(`Configurazione TikTok incompleta per "${client.display_name || client.id}": manca tiktok_access_token/tiktok_refresh_token`);
    } else {
      try {
        const { publishToTikTok } = require('./tiktok-publish');
        results.tiktok_publish_id = await publishToTikTok(client, post, media);
      } catch (err) {
        results.errors.push(`TikTok: ${err.message}`);
      }
    }
  }

  // Safety net: se nessun canale risulta pubblicato (id tutti null) e non c'è
  // alcun errore registrato, segnala una sentinella.
  if (!results.fb_post_id && !results.ig_media_id && !results.linkedin_post_id && !results.tiktok_publish_id && !results.errors.length) {
    results.errors.push('Nessun canale pubblicato: verifica configurazione cliente e canali richiesti');
  }

  // NIENTE ROLLBACK: un successo parziale (es. IG ok, FB ko) viene CONSERVATO.
  // Il canale mancante verrà completato a un retry successivo grazie all'idempotenza
  // per-canale (i canali con id già valorizzato vengono saltati). Il vecchio
  // "cancella l'altro se uno fallisce" è stato rimosso perché:
  //   - il delete IG falliva comunque per permessi insufficienti (code=10);
  //   - cancellare un post riuscito + far ripubblicare a mano = causa principale
  //     dei duplicati (incidente fratellidirosa 13/06/2026).

  return results;
}

module.exports = {
  publishPost, detectChannels,
  publishToFacebook, publishToInstagram, getPageToken,
  // exposed for testing / advanced use
  igCreateImageContainer, igCreateVideoContainer, igCreateCarouselContainer,
  igPublishContainer, igPollVideoReady,
  fbPublishPhoto, fbPublishVideo, fbPublishCarousel,
  fbFindRecentPost, fbPublishSingleImage,
  isTransientMeta, withRetry, matchRecentFbPost, TRANSIENT_META_CODES
};
