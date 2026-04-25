/**
 * linkedin-publish.js — pubblicazione post su LinkedIn Page aziendale.
 *
 * Auth: OAuth 2.0 access token user-scoped con permesso `w_organization_social`.
 * L'admin EMC deve essere amministratore della Page LinkedIn del cliente, fare
 * OAuth flow una volta e salvare il token in `clients.linkedin_access_token`.
 * Il token scade ogni 60 giorni → cliente.linkedin_token_expires_at per warning.
 *
 * MVP attuale: supporta SOLO single_image (testo + 0..1 immagine). Per
 * carousel/video LinkedIn richiede flussi diversi che aggiungeremo in seguito.
 *
 * Doc API: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/posts-api
 */
'use strict';

const https = require('https');

const LINKEDIN_API_VERSION = '202403'; // YYYYMM, vedi LinkedIn versioning

function httpRequest(host, path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path,
      method,
      headers: { ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf,
          text: buf.toString('utf-8')
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonHeaders(token, extra = {}) {
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'LinkedIn-Version': LINKEDIN_API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra
  };
}

// Fetch immagine da URL pubblico (riusa lo stesso URL che passiamo a Meta).
async function fetchImageBuffer(imageUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(imageUrl);
    https.get({
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
      headers: { 'User-Agent': 'EMC-SMM-LinkedInUploader/1.0' }
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Fetch immagine ${imageUrl} → HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Step 1: registra upload, ottieni uploadUrl + image URN
async function initializeImageUpload(token, ownerUrn) {
  const body = JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } });
  const r = await httpRequest('api.linkedin.com', '/rest/images?action=initializeUpload', 'POST', body, jsonHeaders(token));
  if (r.status >= 400) throw new Error(`LinkedIn initializeUpload: ${r.status} ${r.text.substring(0, 200)}`);
  const data = JSON.parse(r.text);
  return { uploadUrl: data.value.uploadUrl, imageUrn: data.value.image };
}

// Step 2: PUT binary all'uploadUrl
async function uploadImageBinary(uploadUrl, imageBuffer, token) {
  const url = new URL(uploadUrl);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Length': imageBuffer.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`LinkedIn upload: ${res.statusCode} ${Buffer.concat(chunks).toString('utf-8').substring(0, 200)}`));
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(imageBuffer);
    req.end();
  });
}

// Step 3: crea il post (con o senza immagine)
async function createPost(token, ownerUrn, commentary, imageUrn) {
  const body = {
    author: ownerUrn,
    commentary: commentary || '',
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };
  if (imageUrn) {
    body.content = { media: { id: imageUrn } };
  }
  const r = await httpRequest('api.linkedin.com', '/rest/posts', 'POST', JSON.stringify(body), jsonHeaders(token));
  if (r.status >= 400) {
    throw new Error(`LinkedIn create post: ${r.status} ${r.text.substring(0, 300)}`);
  }
  // Header x-restli-id contiene l'URN del post creato (formato urn:li:share:xxx)
  return r.headers['x-restli-id'] || null;
}

/**
 * Pubblica un post su LinkedIn Page aziendale.
 * @param client {object} — deve avere linkedin_org_id, linkedin_access_token
 * @param post {object}   — caption + media_type
 * @param media {array}   — array di post_media (almeno per single_image)
 * @returns urn:li:share:xxx oppure throw
 */
async function publishToLinkedIn(client, post, media) {
  const orgId = client.linkedin_org_id;
  const token = client.linkedin_access_token;
  if (!orgId) throw new Error('linkedin_org_id mancante');
  if (!token) throw new Error('linkedin_access_token mancante');

  const ownerUrn = 'urn:li:organization:' + orgId;
  const caption = post.caption || '';

  // MVP: supportiamo solo single_image (con o senza immagine).
  // Carousel/video LinkedIn richiedono altri endpoint che faremo in seguito.
  if (post.media_type && post.media_type !== 'single_image') {
    // Per ora pubblichiamo solo il testo per carousel/reel/video LinkedIn
    console.warn(`[linkedin] media_type ${post.media_type} non ancora supportato — publish testo only`);
  }

  let imageUrn = null;
  const firstMedia = media && media[0];
  if (firstMedia && firstMedia.kind === 'image' && firstMedia.url) {
    const { uploadUrl, imageUrn: urn } = await initializeImageUpload(token, ownerUrn);
    const imgBuf = await fetchImageBuffer(firstMedia.url);
    await uploadImageBinary(uploadUrl, imgBuf, token);
    imageUrn = urn;
    // Piccolo delay per dar tempo a LinkedIn di processare l'asset
    await new Promise(r => setTimeout(r, 1500));
  }

  return await createPost(token, ownerUrn, caption, imageUrn);
}

module.exports = { publishToLinkedIn, LINKEDIN_API_VERSION };
