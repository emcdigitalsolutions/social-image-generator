/**
 * tiktok-publish.js — pubblicazione su TikTok via Content Posting API (Direct Post).
 *
 * Doc: https://developers.tiktok.com/doc/content-posting-api-get-started
 *
 * Flusso Direct Post:
 *   1. (se serve) refresh dell'access token — dura solo 24h, si rinnova col
 *      refresh token (365gg) + client_key/secret dell'app.
 *   2. creator_info/query → opzioni di privacy disponibili + flag interazioni.
 *   3. video/init (PULL_FROM_URL) per i video, oppure content/init (PHOTO) per
 *      le immagini → ritorna un publish_id.
 *   4. status/fetch in polling → PUBLISH_COMPLETE.
 *
 * VINCOLO IMPORTANTE (PULL_FROM_URL): il dominio che ospita i media (es.
 * media.emcdigitalsolutions.it) deve essere VERIFICATO sul TikTok Developer
 * Portal (URL prefix / domain verification), altrimenti l'init fallisce con
 * url_ownership_unverified. È uno step di onboarding una-tantum, non di codice.
 *
 * Mappatura media_type → TikTok:
 *   - video / reel        → 1 video (video/init)
 *   - single_image        → 1 foto (content/init PHOTO)
 *   - carousel (immagini) → foto multiple (content/init PHOTO)
 *   - carousel con video  → NON supportato (TikTok: o 1 video o N foto)
 *   - story               → NON supportato
 */
'use strict';

const https = require('https');
const { getDb } = require('./db');
const { getTikTokClientKey, getTikTokClientSecret } = require('./settings');

const TIKTOK_HOST = 'open.tiktokapis.com';
// Rinnova l'access token se manca meno di questo margine alla scadenza.
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Polling status dopo l'init (PULL_FROM_URL è asincrono lato TikTok).
const STATUS_POLL_MAX_MS = 5 * 60 * 1000;
const STATUS_POLL_INTERVAL_MS = 5000;
// Limite caption TikTok.
const MAX_TITLE_LEN = 2200;
// Privacy di default se il cliente non ne ha scelta una.
const DEFAULT_PRIVACY = 'PUBLIC_TO_EVERYONE';

// ─────────────── HTTP helpers ───────────────

// POST JSON con Bearer token verso le API di contenuto. Ritorna l'oggetto
// parsato { data, error } (formato standard TikTok content API).
function apiPostJson(path, token, bodyObj) {
  const body = JSON.stringify(bodyObj || {});
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TIKTOK_HOST,
      path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`TikTok: risposta non-JSON da ${path}: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// POST x-www-form-urlencoded verso l'endpoint OAuth (formato diverso: JSON piatto).
function oauthPost(params) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TIKTOK_HOST,
      path: '/v2/oauth/token/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`TikTok OAuth: risposta non-JSON: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Estrae un messaggio d'errore leggibile dal formato content API.
function ttErr(prefix, r) {
  const e = (r && r.error) || {};
  const parts = [e.message || e.code || 'errore sconosciuto'];
  if (e.code && e.code !== 'ok') parts.push(`code=${e.code}`);
  if (e.log_id) parts.push(`log_id=${e.log_id}`);
  return `${prefix}: ${parts.join(' | ')}`;
}

function isOk(r) {
  return r && r.error && r.error.code === 'ok';
}

// ─────────────── Token refresh + persistenza ───────────────

/**
 * Garantisce un access token valido per il cliente. Se quello salvato è scaduto
 * (o sta per scadere) lo rinnova col refresh token e PERSISTE i nuovi token in
 * DB (mutando anche l'oggetto client passato). Ritorna l'access token valido.
 */
async function ensureAccessToken(client) {
  const now = Date.now();
  const exp = client.tiktok_token_expires_at ? Date.parse(client.tiktok_token_expires_at) : 0;
  if (client.tiktok_access_token && exp && (exp - now) > TOKEN_REFRESH_BUFFER_MS) {
    return client.tiktok_access_token;
  }

  // Serve rinnovare.
  if (!client.tiktok_refresh_token) {
    throw new Error('refresh token TikTok mancante — ri-autorizza l\'account');
  }
  const refreshExp = client.tiktok_refresh_expires_at ? Date.parse(client.tiktok_refresh_expires_at) : 0;
  if (refreshExp && refreshExp < now) {
    throw new Error('refresh token TikTok scaduto (durano 365gg) — ri-autorizza l\'account dal portale');
  }
  const clientKey = getTikTokClientKey();
  const clientSecret = getTikTokClientSecret();
  if (!clientKey || !clientSecret) {
    throw new Error('credenziali app TikTok mancanti (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET)');
  }

  const r = await oauthPost({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: client.tiktok_refresh_token
  });
  if (r.error || !r.access_token) {
    throw new Error(`refresh token fallito: ${r.error_description || r.error || 'nessun access_token'}`);
  }

  const newAccess = r.access_token;
  const newRefresh = r.refresh_token || client.tiktok_refresh_token; // può cambiare
  const accessExpIso = new Date(now + (Number(r.expires_in) || 86400) * 1000).toISOString();
  const refreshExpIso = new Date(now + (Number(r.refresh_expires_in) || 365 * 86400) * 1000).toISOString();
  const openId = r.open_id || client.tiktok_open_id || null;

  // Persisti in DB + muta l'oggetto in memoria.
  try {
    getDb().prepare(`
      UPDATE clients SET
        tiktok_access_token = ?,
        tiktok_refresh_token = ?,
        tiktok_token_expires_at = ?,
        tiktok_refresh_expires_at = ?,
        tiktok_open_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(newAccess, newRefresh, accessExpIso, refreshExpIso, openId, client.id);
  } catch (e) {
    console.warn('[tiktok] persistenza token fallita:', e.message);
  }
  client.tiktok_access_token = newAccess;
  client.tiktok_refresh_token = newRefresh;
  client.tiktok_token_expires_at = accessExpIso;
  client.tiktok_refresh_expires_at = refreshExpIso;
  client.tiktok_open_id = openId;

  return newAccess;
}

// ─────────────── Creator info + privacy ───────────────

async function queryCreatorInfo(token) {
  const r = await apiPostJson('/v2/post/publish/creator_info/query/', token, {});
  if (!isOk(r)) throw new Error(ttErr('creator_info', r));
  return r.data || {};
}

/**
 * Sceglie la privacy effettiva: usa quella desiderata se è tra le opzioni del
 * creator, altrimenti ricade su PUBLIC_TO_EVERYONE o sulla prima disponibile.
 * Funzione PURA (testabile). Ritorna { level, fellback }.
 */
function resolvePrivacy(desired, options) {
  const opts = Array.isArray(options) ? options : [];
  const want = desired || DEFAULT_PRIVACY;
  if (opts.includes(want)) return { level: want, fellback: false };
  if (opts.includes(DEFAULT_PRIVACY)) return { level: DEFAULT_PRIVACY, fellback: want !== DEFAULT_PRIVACY };
  if (opts.length) return { level: opts[0], fellback: true };
  // Nessuna opzione nota: tenta il default e lascia che l'API decida.
  return { level: want, fellback: false };
}

// ─────────────── Costruzione body (puri, testabili) ───────────────

function clampTitle(caption) {
  const t = (caption || '').trim();
  return t.length > MAX_TITLE_LEN ? t.slice(0, MAX_TITLE_LEN) : t;
}

/**
 * Body per video/init (PULL_FROM_URL). `creator` porta i flag di interazione
 * disabilitati a livello account: se l'account ha disabilitato commenti/duet/
 * stitch DOBBIAMO inviare disable_*=true, altrimenti l'API rifiuta.
 */
function buildVideoInitBody({ caption, privacy, videoUrl, creator = {} }) {
  return {
    post_info: {
      title: clampTitle(caption),
      privacy_level: privacy,
      disable_comment: !!creator.comment_disabled,
      disable_duet: !!creator.duet_disabled,
      disable_stitch: !!creator.stitch_disabled
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: videoUrl
    }
  };
}

/**
 * Body per content/init (PHOTO, Direct Post). photo_cover_index è 1-based.
 */
function buildPhotoInitBody({ caption, privacy, photoUrls, coverIndex = 1, creator = {} }) {
  return {
    post_info: {
      title: clampTitle(caption),
      description: clampTitle(caption),
      privacy_level: privacy,
      disable_comment: !!creator.comment_disabled
    },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: coverIndex,
      photo_images: photoUrls
    },
    post_mode: 'DIRECT_POST',
    media_type: 'PHOTO'
  };
}

// ─────────────── Init + polling ───────────────

async function initVideo(token, body) {
  const r = await apiPostJson('/v2/post/publish/video/init/', token, body);
  if (!isOk(r)) throw new Error(ttErr('video/init', r));
  return r.data.publish_id;
}

async function initPhoto(token, body) {
  const r = await apiPostJson('/v2/post/publish/content/init/', token, body);
  if (!isOk(r)) throw new Error(ttErr('content/init', r));
  return r.data.publish_id;
}

/**
 * Polla lo stato del publish. PULL_FROM_URL è asincrono: TikTok scarica e
 * processa il media. Ritorna lo stato finale; se va in FAILED lancia errore.
 * Se al timeout è ancora in lavorazione, NON è un errore: ritorna lo stato
 * corrente (il post comparirà appena TikTok finisce di processarlo).
 */
async function pollStatus(token, publishId) {
  const start = Date.now();
  let last = 'PROCESSING';
  while (Date.now() - start < STATUS_POLL_MAX_MS) {
    const r = await apiPostJson('/v2/post/publish/status/fetch/', token, { publish_id: publishId });
    if (!isOk(r)) throw new Error(ttErr('status/fetch', r));
    last = (r.data && r.data.status) || last;
    if (last === 'PUBLISH_COMPLETE') return last;
    if (last === 'FAILED') {
      const reason = (r.data && (r.data.fail_reason || r.data.error_code)) || 'sconosciuto';
      throw new Error(`pubblicazione fallita lato TikTok (${reason})`);
    }
    await new Promise(res => setTimeout(res, STATUS_POLL_INTERVAL_MS));
  }
  return last; // ancora in elaborazione: non blocchiamo, il publish_id resta valido
}

// ─────────────── Entry point ───────────────

/**
 * Pubblica un post su TikTok.
 * @param client - row del client (tiktok_* + verrà mutato col token rinnovato)
 * @param post   - row del post (caption già composta, media_type)
 * @param media  - array di post_media ordinato per position
 * @returns publish_id (string)
 */
async function publishToTikTok(client, post, media) {
  if (!media || !media.length) throw new Error('nessun media da pubblicare');
  const mediaType = post.media_type || 'single_image';
  if (mediaType === 'story') throw new Error('le Story non sono supportate su TikTok');

  const token = await ensureAccessToken(client);
  const creator = await queryCreatorInfo(token);
  const { level: privacy, fellback } = resolvePrivacy(client.tiktok_privacy_level, creator.privacy_level_options);
  if (fellback) {
    console.warn(`[tiktok] privacy "${client.tiktok_privacy_level || DEFAULT_PRIVACY}" non disponibile per @${creator.creator_username || '?'} → uso "${privacy}"`);
  }
  const caption = post.caption || '';

  const isVideoPost = mediaType === 'video' || mediaType === 'reel';

  let publishId;
  if (isVideoPost) {
    const m = media[0];
    if (m.kind !== 'video') throw new Error('media_type video ma il primo media non è un video');
    publishId = await initVideo(token, buildVideoInitBody({ caption, privacy, videoUrl: m.url, creator }));
  } else {
    // single_image o carousel di sole immagini → photo post
    const images = media.filter(m => m.kind === 'image');
    if (images.length !== media.length) {
      throw new Error('TikTok non supporta caroselli misti foto+video: usa un solo video oppure solo foto');
    }
    if (!images.length) throw new Error('nessuna immagine da pubblicare');
    publishId = await initPhoto(token, buildPhotoInitBody({
      caption, privacy, photoUrls: images.map(m => m.url), coverIndex: 1, creator
    }));
  }

  // Best-effort: aspetta la fine dell'elaborazione (non blocca se va in timeout).
  try {
    await pollStatus(token, publishId);
  } catch (err) {
    // FAILED in polling → propaga (il post non è andato online)
    throw new Error(`${err.message} (publish_id=${publishId})`);
  }

  return publishId;
}

module.exports = {
  publishToTikTok,
  ensureAccessToken,
  queryCreatorInfo,
  // esposti per test / uso avanzato
  resolvePrivacy,
  buildVideoInitBody,
  buildPhotoInitBody,
  clampTitle,
  MAX_TITLE_LEN,
  DEFAULT_PRIVACY
};
