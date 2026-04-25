/**
 * meta-publish.js — pubblicazione su Facebook + Instagram via Graph API.
 * Supporta: single image, carousel (2-10 media stesso tipo), video, reel.
 *
 * Pattern unificato per ogni post:
 *   publishPost(client, post, media)
 *     → analizza post.media_type
 *     → invoca il flusso giusto per FB e per IG
 *     → ritorna { fb_post_id, ig_media_id, errors }
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

// ─────────────── Instagram ───────────────

function fmtMetaErr(prefix, r) {
  const e = r.error || {};
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

async function igCreateImageContainer(igUserId, pageToken, imageUrl, opts = {}) {
  const body = { image_url: imageUrl, access_token: pageToken };
  if (opts.caption) body.caption = opts.caption;
  if (opts.is_carousel_item) body.is_carousel_item = 'true';
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${igUserId}/media`), 'POST', body);
  if (r.error) throw new Error(fmtMetaErr('IG image container', r));
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
  if (r.error) throw new Error(fmtMetaErr('IG video container', r));
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
  if (r.error) throw new Error(fmtMetaErr('IG carousel container', r));
  return r.id;
}

async function igPublishContainer(igUserId, pageToken, creationId) {
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${igUserId}/media_publish`), 'POST', {
    creation_id: creationId,
    access_token: pageToken
  });
  if (r.error) throw new Error(fmtMetaErr('IG publish', r));
  return r.id;
}

async function igPollVideoReady(pageToken, containerId) {
  const start = Date.now();
  while (Date.now() - start < VIDEO_POLL_MAX_MS) {
    const path = urlBase(FB_HOST, `${containerId}?fields=status_code,status&access_token=${encodeURIComponent(pageToken)}`);
    const r = await httpRequest(FB_HOST, path, 'GET');
    if (r.error) throw new Error(fmtMetaErr('IG poll', r));
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR') throw new Error(`IG video processing ERROR (status=${r.status || 'n/a'})`);
    if (r.status_code === 'EXPIRED') throw new Error('IG video processing EXPIRED');
    await new Promise(res => setTimeout(res, VIDEO_POLL_INTERVAL_MS));
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
    const cid = await igCreateImageContainer(igUserId, token, withCacheBuster(m.url, m.created_at), { caption });
    await new Promise(r => setTimeout(r, 3000));
    return igPublishContainer(igUserId, token, cid);
  }

  if (post.media_type === 'carousel') {
    const childIds = [];
    for (const m of media) {
      let cid;
      if (m.kind === 'video') {
        cid = await igCreateVideoContainer(igUserId, token, withCacheBuster(m.url, m.created_at), { is_carousel_item: true });
        await igPollVideoReady(token, cid);
      } else {
        cid = await igCreateImageContainer(igUserId, token, withCacheBuster(m.url, m.created_at), { is_carousel_item: true });
      }
      childIds.push(cid);
    }
    const carouselId = await igCreateCarouselContainer(igUserId, token, childIds, caption);
    await new Promise(r => setTimeout(r, 3000));
    return igPublishContainer(igUserId, token, carouselId);
  }

  if (post.media_type === 'video' || post.media_type === 'reel') {
    const m = media[0];
    // post.ig_share_to_feed: 1/true (default) = appare anche in feed,
    // 0/false = Reel "puro" visibile solo in tab Reels.
    // Nota: la colonna SQLite ritorna 0/1 (INTEGER), trattiamo entrambi.
    const shareToFeed = post.ig_share_to_feed === 0 ? false : true;
    const cid = await igCreateVideoContainer(igUserId, token, withCacheBuster(m.url, m.created_at), {
      caption,
      share_to_feed: shareToFeed
    });
    await igPollVideoReady(token, cid);
    return igPublishContainer(igUserId, token, cid);
  }

  throw new Error('Unsupported media_type: ' + post.media_type);
}

// ─────────────── Facebook ───────────────

async function fbPublishPhoto(pageId, pageToken, imageUrl, caption, published = true) {
  const body = { url: imageUrl, access_token: pageToken, published: String(published) };
  if (caption) body.message = caption;
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${pageId}/photos`), 'POST', body);
  if (r.error) throw new Error(fmtMetaErr('FB photo', r));
  return r;
}

async function fbPublishVideo(pageId, pageToken, videoUrl, caption) {
  const body = { file_url: videoUrl, access_token: pageToken };
  if (caption) body.description = caption;
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${pageId}/videos`), 'POST', body);
  if (r.error) throw new Error(fmtMetaErr('FB video', r));
  return r.id;
}

// Rollback: cancella un post appena pubblicato quando l'altra piattaforma ha fallito.
// Il delete endpoint e' lo stesso per post, foto, video, carousel IG — DELETE {id}.
function parseDeleteHttp(host, path) {
  return new Promise((resolve, reject) => {
    const options = { hostname: host, path, method: 'DELETE', headers: {} };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${host}: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function deleteFbObject(pageToken, fbObjectId) {
  const path = urlBase(FB_HOST, `${fbObjectId}?access_token=${encodeURIComponent(pageToken)}`);
  const r = await parseDeleteHttp(FB_HOST, path);
  if (r.error) throw new Error(fmtMetaErr('FB delete rollback', r));
  return r.success !== false;
}

async function deleteIgObject(pageToken, igMediaId) {
  const path = urlBase(FB_HOST, `${igMediaId}?access_token=${encodeURIComponent(pageToken)}`);
  const r = await parseDeleteHttp(FB_HOST, path);
  if (r.error) throw new Error(fmtMetaErr('IG delete rollback', r));
  return r.success !== false;
}

async function fbPublishCarousel(pageId, pageToken, mediaItems, caption) {
  // Step 1: upload ogni foto come unpublished
  const photoIds = [];
  for (const m of mediaItems) {
    if (m.kind !== 'image') throw new Error('FB carousel: solo immagini supportate (no video misti)');
    const r = await fbPublishPhoto(pageId, pageToken, withCacheBuster(m.url, m.created_at), null, false);
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
  if (r.error) throw new Error(`FB carousel feed: ${r.error.message}`);
  return r.id;
}

async function publishToFacebook(client, post, media) {
  const pageId = client.fb_page_id;
  const pageToken = client._fb_page_token;
  const caption = post.caption || '';

  if (post.media_type === 'single_image') {
    const r = await fbPublishPhoto(pageId, pageToken, media[0].url, caption, true);
    return r.post_id || r.id;
  }
  if (post.media_type === 'carousel') {
    return fbPublishCarousel(pageId, pageToken, media, caption);
  }
  if (post.media_type === 'video' || post.media_type === 'reel') {
    return fbPublishVideo(pageId, pageToken, media[0].url, caption);
  }
  throw new Error('Unsupported media_type: ' + post.media_type);
}

// ─────────────── Public entry point ───────────────

/**
 * Pubblica un post.
 * @param client - row del client (con fb_*, ig_*)
 * @param post   - row del post (deve avere caption + media_type)
 * @param media  - array di post_media ordinato per position (almeno 1 item)
 * @param opts   - { channels?: ['fb','ig'] } — quali canali pubblicare. Default: entrambi.
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

  const ALLOWED_CHANNELS = ['fb', 'ig', 'linkedin'];
  const channels = (opts.channels && opts.channels.length)
    ? opts.channels.filter(c => ALLOWED_CHANNELS.includes(c))
    : ['fb', 'ig'];

  const results = { fb_post_id: null, ig_media_id: null, linkedin_post_id: null, errors: [], channels };

  if (!media || !media.length) {
    results.errors.push('Nessun media da pubblicare');
    return results;
  }

  const wantFb = channels.includes('fb');
  const wantIg = channels.includes('ig');
  const wantLinkedIn = channels.includes('linkedin');

  // Pre-check credenziali Meta (FB+IG): se l'utente ha chiesto un canale Meta
  // ma il cliente non ha i campi necessari, logga errore esplicito invece di
  // uscire silent. LinkedIn ha pre-check separato (chiavi diverse).
  if (wantFb || wantIg) {
    const missing = [];
    if (wantFb && !client.fb_page_id) missing.push('fb_page_id');
    if (!client.fb_system_user_token) missing.push('fb_system_user_token');
    if (wantIg && !client.ig_user_id) missing.push('ig_user_id');
    if (missing.length) {
      results.errors.push(`Configurazione Meta incompleta per cliente "${client.display_name || client.id}": manca ${missing.join(', ')}`);
      // Se SOLO Meta è chiesto, abort. Se anche LinkedIn è chiesto, continua per quello.
      if (!wantLinkedIn) return results;
    } else {
      // Token exchange Meta solo se le credenziali base ci sono
      try {
        client._fb_page_token = await getPageToken(client.fb_system_user_token, client.fb_page_id);
      } catch (err) {
        results.errors.push(`FB/IG token exchange: ${err.message}`);
        if (!wantLinkedIn) return results;
      }
    }
  }

  // Pre-check credenziali LinkedIn
  if (wantLinkedIn) {
    const missingLi = [];
    if (!client.linkedin_org_id) missingLi.push('linkedin_org_id');
    if (!client.linkedin_access_token) missingLi.push('linkedin_access_token');
    if (missingLi.length) {
      results.errors.push(`Configurazione LinkedIn incompleta per "${client.display_name || client.id}": manca ${missingLi.join(', ')}`);
    }
  }

  if (wantFb && client._fb_page_token && client.fb_page_id) {
    try {
      results.fb_post_id = await publishToFacebook(client, post, media);
    } catch (err) {
      results.errors.push(`FB: ${err.message}`);
    }
  }

  if (wantIg && client._fb_page_token && client.ig_user_id) {
    try {
      results.ig_media_id = await publishToInstagram(client, post, media);
    } catch (err) {
      results.errors.push(`IG: ${err.message}`);
    }
  }

  if (wantLinkedIn && client.linkedin_org_id && client.linkedin_access_token) {
    try {
      const { publishToLinkedIn } = require('./linkedin-publish');
      results.linkedin_post_id = await publishToLinkedIn(client, post, media);
    } catch (err) {
      results.errors.push(`LinkedIn: ${err.message}`);
    }
  }

  // Safety net: se nessuno dei branch ha girato (tutti gli ID null + nessun
  // errore), registra un errore sentinella.
  if (!results.fb_post_id && !results.ig_media_id && !results.linkedin_post_id && !results.errors.length) {
    results.errors.push('Nessun canale pubblicato: verifica configurazione cliente e canali richiesti');
  }

  // Transazionalità "all-or-nothing" quando l'utente ha chiesto ENTRAMBI
  // i canali: se uno riesce e l'altro no, rollback del riuscito così lo
  // stato resta consistente (niente post "orfani" su una sola piattaforma).
  if (wantFb && wantIg && client._fb_page_token) {
    const fbOk = !!results.fb_post_id;
    const igOk = !!results.ig_media_id;

    if (fbOk && !igOk) {
      // IG ha fallito → cancella FB
      try {
        await deleteFbObject(client._fb_page_token, results.fb_post_id);
        results.errors.push(`FB rolled back (post ${results.fb_post_id} cancellato perché IG ha fallito)`);
        results.fb_post_id = null;
        results.rolled_back = 'fb';
      } catch (err) {
        // Rollback fallito: il post FB rimane online, serve rimozione manuale
        results.errors.push(`ROLLBACK FB FALLITO: il post FB ${results.fb_post_id} resta online, rimuovilo manualmente da Meta Business Suite. Dettaglio: ${err.message}`);
      }
    } else if (igOk && !fbOk) {
      // FB ha fallito → cancella IG
      try {
        await deleteIgObject(client._fb_page_token, results.ig_media_id);
        results.errors.push(`IG rolled back (media ${results.ig_media_id} cancellato perché FB ha fallito)`);
        results.ig_media_id = null;
        results.rolled_back = 'ig';
      } catch (err) {
        results.errors.push(`ROLLBACK IG FALLITO: il post IG ${results.ig_media_id} resta online, rimuovilo manualmente da Meta Business Suite. Dettaglio: ${err.message}`);
      }
    }
  }

  return results;
}

module.exports = {
  publishPost,
  publishToFacebook, publishToInstagram, getPageToken,
  // exposed for testing / advanced use
  igCreateImageContainer, igCreateVideoContainer, igCreateCarouselContainer,
  igPublishContainer, igPollVideoReady,
  fbPublishPhoto, fbPublishVideo, fbPublishCarousel
};
