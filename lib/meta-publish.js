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
const IG_HOST = 'graph.instagram.com';

// Polling per video/reel container (status_code FINISHED)
const VIDEO_POLL_MAX_MS = 10 * 60 * 1000; // 10 minuti
const VIDEO_POLL_INTERVAL_MS = 5000;       // 5s

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

async function getPageToken(systemUserToken) {
  const path = urlBase(FB_HOST, `me/accounts?access_token=${encodeURIComponent(systemUserToken)}`);
  const result = await httpRequest(FB_HOST, path, 'GET');
  if (result.error) throw new Error(result.error.message);
  if (!result.data || !result.data.length) throw new Error('No pages found for this token');
  return result.data[0].access_token;
}

// ─────────────── Instagram ───────────────

async function igCreateImageContainer(igUserId, token, imageUrl, opts = {}) {
  const body = { image_url: imageUrl, access_token: token };
  if (opts.caption) body.caption = opts.caption;
  if (opts.is_carousel_item) body.is_carousel_item = 'true';
  const r = await httpRequest(IG_HOST, urlBase(IG_HOST, `${igUserId}/media`), 'POST', body);
  if (r.error) throw new Error(`IG image container: ${r.error.message}`);
  return r.id;
}

async function igCreateVideoContainer(igUserId, token, videoUrl, opts = {}) {
  const body = {
    video_url: videoUrl,
    media_type: opts.is_reel ? 'REELS' : 'VIDEO',
    access_token: token
  };
  if (opts.caption) body.caption = opts.caption;
  if (opts.is_carousel_item) body.is_carousel_item = 'true';
  if (opts.is_reel) body.share_to_feed = 'true';
  const r = await httpRequest(IG_HOST, urlBase(IG_HOST, `${igUserId}/media`), 'POST', body);
  if (r.error) throw new Error(`IG video container: ${r.error.message}`);
  return r.id;
}

async function igCreateCarouselContainer(igUserId, token, childIds, caption) {
  const body = {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    access_token: token
  };
  if (caption) body.caption = caption;
  const r = await httpRequest(IG_HOST, urlBase(IG_HOST, `${igUserId}/media`), 'POST', body);
  if (r.error) throw new Error(`IG carousel container: ${r.error.message}`);
  return r.id;
}

async function igPublishContainer(igUserId, token, creationId) {
  const r = await httpRequest(IG_HOST, urlBase(IG_HOST, `${igUserId}/media_publish`), 'POST', {
    creation_id: creationId,
    access_token: token
  });
  if (r.error) throw new Error(`IG publish: ${r.error.message}`);
  return r.id;
}

async function igPollVideoReady(token, containerId) {
  const start = Date.now();
  while (Date.now() - start < VIDEO_POLL_MAX_MS) {
    const path = urlBase(IG_HOST, `${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`);
    const r = await httpRequest(IG_HOST, path, 'GET');
    if (r.error) throw new Error(`IG poll: ${r.error.message}`);
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR') throw new Error('IG video processing ERROR');
    if (r.status_code === 'EXPIRED') throw new Error('IG video processing EXPIRED');
    await new Promise(res => setTimeout(res, VIDEO_POLL_INTERVAL_MS));
  }
  throw new Error('IG video timeout (10min) waiting for FINISHED');
}

async function publishToInstagram(client, post, media) {
  const igUserId = client.ig_user_id;
  const token = client.ig_access_token;
  const caption = post.caption || '';

  if (post.media_type === 'single_image') {
    const m = media[0];
    const cid = await igCreateImageContainer(igUserId, token, m.url, { caption });
    await new Promise(r => setTimeout(r, 3000)); // small wait
    return igPublishContainer(igUserId, token, cid);
  }

  if (post.media_type === 'carousel') {
    const childIds = [];
    for (const m of media) {
      let cid;
      if (m.kind === 'video') {
        cid = await igCreateVideoContainer(igUserId, token, m.url, { is_carousel_item: true });
        await igPollVideoReady(token, cid);
      } else {
        cid = await igCreateImageContainer(igUserId, token, m.url, { is_carousel_item: true });
      }
      childIds.push(cid);
    }
    const carouselId = await igCreateCarouselContainer(igUserId, token, childIds, caption);
    await new Promise(r => setTimeout(r, 3000));
    return igPublishContainer(igUserId, token, carouselId);
  }

  if (post.media_type === 'video' || post.media_type === 'reel') {
    const m = media[0];
    const cid = await igCreateVideoContainer(igUserId, token, m.url, {
      caption,
      is_reel: post.media_type === 'reel'
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
  if (r.error) throw new Error(`FB photo: ${r.error.message}`);
  return r;
}

async function fbPublishVideo(pageId, pageToken, videoUrl, caption) {
  const body = { file_url: videoUrl, access_token: pageToken };
  if (caption) body.description = caption;
  const r = await httpRequest(FB_HOST, urlBase(FB_HOST, `${pageId}/videos`), 'POST', body);
  if (r.error) throw new Error(`FB video: ${r.error.message}`);
  return r.id;
}

async function fbPublishCarousel(pageId, pageToken, mediaItems, caption) {
  // Step 1: upload ogni foto come unpublished
  const photoIds = [];
  for (const m of mediaItems) {
    if (m.kind !== 'image') throw new Error('FB carousel: solo immagini supportate (no video misti)');
    const r = await fbPublishPhoto(pageId, pageToken, m.url, null, false);
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
 *
 * Compatibilità retroattiva: se chiamata con (client, imageUrl, caption)
 * costruisce un finto post single_image (vecchio scheduler ancora supportato).
 */
async function publishPost(client, post, media) {
  // Backward-compat: vecchio call pattern (client, imageUrl, caption)
  if (typeof post === 'string') {
    const imageUrl = post;
    const caption = media;
    post = { media_type: 'single_image', caption };
    media = [{ kind: 'image', url: imageUrl }];
  }

  const results = { fb_post_id: null, ig_media_id: null, errors: [] };

  if (!media || !media.length) {
    results.errors.push('Nessun media da pubblicare');
    return results;
  }

  // Facebook: scambio token system user → page token (una volta)
  if (client.fb_system_user_token && client.fb_page_id) {
    try {
      client._fb_page_token = await getPageToken(client.fb_system_user_token);
    } catch (err) {
      results.errors.push(`FB token exchange: ${err.message}`);
    }
  }

  if (client._fb_page_token && client.fb_page_id) {
    try {
      results.fb_post_id = await publishToFacebook(client, post, media);
    } catch (err) {
      results.errors.push(`FB: ${err.message}`);
    }
  }

  if (client.ig_user_id && client.ig_access_token) {
    try {
      results.ig_media_id = await publishToInstagram(client, post, media);
    } catch (err) {
      results.errors.push(`IG: ${err.message}`);
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
