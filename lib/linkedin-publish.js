/**
 * linkedin-publish.js — pubblicazione post su LinkedIn Page aziendale.
 *
 * Auth: OAuth 2.0 access token user-scoped (prodotto "Community Management API"
 * dell'app LinkedIn) con scope `w_organization_social` (+ `rw_organization_admin`
 * o `r_organization_admin` per la verifica connessione / elenco Pagine).
 * L'admin EMC deve essere ADMINISTRATOR (o CONTENT_ADMINISTRATOR) della Page del
 * cliente. Il token scade ogni 60 giorni → clients.linkedin_token_expires_at.
 *
 * Formati supportati (Posts API):
 *   - single_image / story con immagine → post con 1 immagine
 *   - carousel con ≥2 immagini           → post multiImage (2..20 immagini)
 *   - video / reel / story con video     → post video (Videos API, multipart)
 *   - nessun media                       → post solo testo
 *
 * VERSIONE API: LinkedIn supporta ogni versione mensile per ~12 mesi, poi la
 * spegne e TUTTE le chiamate falliscono. Aggiornare LINKEDIN_API_VERSION almeno
 * una volta l'anno (override senza deploy: env LINKEDIN_API_VERSION=YYYYMM).
 * L'alert settimanale avvisa quando la versione si avvicina alla scadenza.
 *
 * Doc: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 */
'use strict';

const DEFAULT_API_VERSION = '202609';
const LINKEDIN_API_VERSION = /^\d{6}$/.test(process.env.LINKEDIN_API_VERSION || '')
  ? process.env.LINKEDIN_API_VERSION
  : DEFAULT_API_VERSION;

const API_BASE = 'https://api.linkedin.com/rest';
const MAX_COMMENTARY = 3000;       // limite LinkedIn sul testo del post
const MAX_MULTI_IMAGES = 20;       // multiImage: 2..20 immagini
const REQUEST_TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 180000;

// ─────────────── Testo: formato "little" ───────────────

// Caratteri riservati del little text format: vanno escapati con backslash,
// altrimenti LinkedIn tronca il testo o rifiuta il post (es. una parentesi).
const RESERVED_RE = /[\\|{}@[\]()<>#*_~]/g;
// Hashtag: # preceduto da inizio/spazio/punteggiatura e seguito da lettere/cifre/_
const HASHTAG_RE = /(?<![\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu;

function escapeLittle(text) {
  return String(text).replace(RESERVED_RE, ch => '\\' + ch);
}

/**
 * Converte una caption "normale" (come per FB/IG) nel formato little di LinkedIn:
 * escape dei riservati + hashtag come template cliccabili. Le menzioni @username
 * (handle Instagram) restano testo semplice: su LinkedIn non hanno significato.
 */
function toLittleText(caption) {
  if (!caption) return '';
  let text = String(caption);
  if (text.length > MAX_COMMENTARY) text = text.slice(0, MAX_COMMENTARY - 1).trimEnd() + '…';
  let out = '';
  let last = 0;
  for (const m of text.matchAll(HASHTAG_RE)) {
    out += escapeLittle(text.slice(last, m.index));
    out += '{hashtag|\\#|' + escapeLittle(m[1]) + '}';
    last = m.index + m[0].length;
  }
  out += escapeLittle(text.slice(last));
  return out;
}

// ─────────────── Scelta del formato ───────────────

/**
 * Decide che tipo di post LinkedIn creare a partire da media_type + media.
 * Funzione pura (testata): ritorna { kind, items, warnings }.
 *   kind: 'text' | 'image' | 'multiImage' | 'video'
 */
function planLinkedInContent(post, media) {
  const mediaType = (post && post.media_type) || 'single_image';
  const list = (media || []).filter(m => m && m.url);
  const images = list.filter(m => m.kind === 'image');
  const videos = list.filter(m => m.kind === 'video');
  const warnings = [];

  if (!list.length) return { kind: 'text', items: [], warnings };

  if (mediaType === 'video' || mediaType === 'reel') {
    if (videos.length) return { kind: 'video', items: [videos[0]], warnings };
    if (images.length) return { kind: 'image', items: [images[0]], warnings };
  }

  if (mediaType === 'carousel') {
    if (images.length >= 2) {
      if (videos.length) warnings.push(`carousel misto: ${videos.length} video esclusi (LinkedIn multi-immagine accetta solo foto)`);
      if (images.length > MAX_MULTI_IMAGES) warnings.push(`carousel con ${images.length} immagini: pubblicate le prime ${MAX_MULTI_IMAGES}`);
      return { kind: 'multiImage', items: images.slice(0, MAX_MULTI_IMAGES), warnings };
    }
    if (images.length === 1) {
      if (videos.length) warnings.push('carousel misto: pubblicata solo la foto');
      return { kind: 'image', items: [images[0]], warnings };
    }
    if (videos.length) {
      if (videos.length > 1) warnings.push('carousel di soli video: pubblicato solo il primo');
      return { kind: 'video', items: [videos[0]], warnings };
    }
  }

  // single_image, story o tipo sconosciuto: il primo media decide
  const first = list[0];
  return { kind: first.kind === 'video' ? 'video' : 'image', items: [first], warnings };
}

// ─────────────── HTTP ───────────────

function jsonHeaders(token, extra = {}) {
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'LinkedIn-Version': LINKEDIN_API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra
  };
}

async function apiRequest(method, path, token, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: jsonHeaders(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* risposta non JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

/** Traduce gli errori LinkedIn più comuni in messaggi utili all'operatore. */
function describeError(step, r) {
  const detail = (r.json && (r.json.message || r.json.code)) || (r.text || '').substring(0, 200);
  let hint = '';
  if (r.status === 401) hint = ' → token scaduto o revocato: rigeneralo e aggiorna la data di scadenza';
  else if (r.status === 403) hint = ' → permessi insufficienti: serve ruolo Amministratore/Content admin sulla Page e scope w_organization_social';
  else if (r.status === 426 || /version/i.test(detail)) hint = ` → versione API ${LINKEDIN_API_VERSION} non più supportata: aggiorna LINKEDIN_API_VERSION`;
  else if (r.status === 429) hint = ' → limite di chiamate LinkedIn raggiunto, riprova più tardi';
  return new Error(`LinkedIn ${step}: HTTP ${r.status} ${detail}${hint}`);
}

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'EMC-SMM-LinkedInUploader/2.0' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Download media ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function putBinary(uploadUrl, buf, token) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (res.status >= 400) {
    const t = await res.text().catch(() => '');
    throw new Error(`LinkedIn upload: HTTP ${res.status} ${t.substring(0, 200)}`);
  }
  return res;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Attende che un asset (image/video) sia AVAILABLE. Errore su PROCESSING_FAILED o timeout. */
async function waitAvailable(collection, urn, token, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const r = await apiRequest('GET', `/${collection}/${encodeURIComponent(urn)}`, token);
    if (r.status === 200 && r.json) {
      lastStatus = r.json.status;
      if (lastStatus === 'AVAILABLE') return;
      if (lastStatus === 'PROCESSING_FAILED') {
        throw new Error(`LinkedIn: elaborazione ${collection} fallita (${r.json.processingFailureReason || 'motivo non indicato'})`);
      }
    }
    await sleep(intervalMs);
  }
  // Le immagini spesso sono già pubblicabili anche se lo stato tarda: non blocchiamo.
  if (collection === 'images') return;
  throw new Error(`LinkedIn: video non pronto dopo ${Math.round(timeoutMs / 1000)}s (stato ${lastStatus})`);
}

// ─────────────── Upload ───────────────

async function uploadImage(token, ownerUrn, url) {
  const init = await apiRequest('POST', '/images?action=initializeUpload', token,
    { initializeUploadRequest: { owner: ownerUrn } });
  if (init.status >= 400 || !init.json) throw describeError('initializeUpload immagine', init);
  const { uploadUrl, image } = init.json.value;
  const buf = await fetchBuffer(url);
  await putBinary(uploadUrl, buf, token);
  await waitAvailable('images', image, token, { timeoutMs: 20000, intervalMs: 2000 });
  return image;
}

async function uploadVideo(token, ownerUrn, url) {
  const buf = await fetchBuffer(url);
  const init = await apiRequest('POST', '/videos?action=initializeUpload', token, {
    initializeUploadRequest: {
      owner: ownerUrn,
      fileSizeBytes: buf.length,
      uploadCaptions: false,
      uploadThumbnail: false
    }
  });
  if (init.status >= 400 || !init.json) throw describeError('initializeUpload video', init);
  const { video, uploadInstructions, uploadToken } = init.json.value;

  // Upload multipart: ogni parte ha il suo URL e range di byte; l'ETag di ogni
  // risposta va restituito, nello stesso ordine, al finalizeUpload.
  const partIds = [];
  for (const ins of uploadInstructions) {
    const res = await putBinary(ins.uploadUrl, buf.subarray(ins.firstByte, ins.lastByte + 1), token);
    const etag = (res.headers.get('etag') || '').replace(/^"|"$/g, '');
    if (!etag) throw new Error('LinkedIn upload video: ETag mancante nella risposta');
    partIds.push(etag);
  }

  const fin = await apiRequest('POST', '/videos?action=finalizeUpload', token, {
    finalizeUploadRequest: { video, uploadToken: uploadToken || '', uploadedPartIds: partIds }
  });
  if (fin.status >= 400) throw describeError('finalizeUpload video', fin);

  await waitAvailable('videos', video, token, { timeoutMs: 300000, intervalMs: 5000 });
  return video;
}

// ─────────────── Post ───────────────

function buildPostBody(ownerUrn, commentary, content) {
  const body = {
    author: ownerUrn,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };
  if (content) body.content = content;
  return body;
}

/**
 * Pubblica un post su LinkedIn Page aziendale.
 * @param client {object} — deve avere linkedin_org_id, linkedin_access_token
 * @param post {object}   — caption (già composta) + media_type
 * @param media {array}   — post_media ordinati per position
 * @returns URN del post (urn:li:share:xxx / urn:li:ugcPost:xxx) oppure throw
 */
async function publishToLinkedIn(client, post, media) {
  const orgId = String(client.linkedin_org_id || '').trim();
  const token = String(client.linkedin_access_token || '').trim();
  if (!orgId) throw new Error('linkedin_org_id mancante');
  if (!/^\d+$/.test(orgId)) throw new Error(`linkedin_org_id non valido ("${orgId}"): serve l'ID numerico della Page`);
  if (!token) throw new Error('linkedin_access_token mancante');

  const ownerUrn = 'urn:li:organization:' + orgId;
  const plan = planLinkedInContent(post, media);
  for (const w of plan.warnings) console.warn(`[linkedin] post ${post.id || '?'}: ${w}`);

  let content = null;
  if (plan.kind === 'image') {
    content = { media: { id: await uploadImage(token, ownerUrn, plan.items[0].url) } };
  } else if (plan.kind === 'multiImage') {
    const images = [];
    for (const item of plan.items) images.push({ id: await uploadImage(token, ownerUrn, item.url) });
    content = { multiImage: { images } };
  } else if (plan.kind === 'video') {
    content = { media: { id: await uploadVideo(token, ownerUrn, plan.items[0].url) } };
  }

  const r = await apiRequest('POST', '/posts', token, buildPostBody(ownerUrn, toLittleText(post.caption), content));
  if (r.status >= 400) throw describeError('creazione post', r);
  const urn = r.headers.get('x-restli-id');
  if (!urn) throw new Error('LinkedIn: post creato ma ID non restituito (header x-restli-id assente)');
  console.log(`[linkedin] Pubblicato ${plan.kind} per org ${orgId}: ${urn}`);
  return urn;
}

/** URL pubblico di un post LinkedIn a partire dal suo URN. */
function linkedInPostUrl(urn) {
  return urn ? 'https://www.linkedin.com/feed/update/' + encodeURIComponent(urn) + '/' : null;
}

// ─────────────── Verifica connessione ───────────────

const POSTING_ROLES = ['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR', 'DIRECT_SPONSORED_CONTENT_POSTER'];

/**
 * Verifica token + Page: elenca le Pagine su cui il token ha un ruolo approvato
 * (con nome) e controlla che l'org configurata sia tra quelle pubblicabili.
 * Non pubblica nulla. Ritorna sempre un oggetto (mai throw per errori LinkedIn).
 */
async function verifyLinkedInConnection(token, orgId) {
  token = String(token || '').trim();
  orgId = String(orgId || '').trim();
  const result = { ok: false, apiVersion: LINKEDIN_API_VERSION, tokenValid: null, pages: [], target: null, message: '' };
  if (!token) { result.message = 'Access token mancante'; return result; }

  const acl = await apiRequest('GET', '/organizationAcls?q=roleAssignee&state=APPROVED&count=100', token);
  if (acl.status === 401) {
    result.tokenValid = false;
    result.message = 'Token non valido, scaduto o revocato: generane uno nuovo';
    return result;
  }
  if (acl.status === 403) {
    // Token valido ma senza scope di lettura organizzazioni: non possiamo elencare le Pagine.
    result.tokenValid = true;
    result.message = 'Token valido ma senza scope rw_organization_admin / r_organization_admin: '
      + 'impossibile verificare la Page. Rigenera il token spuntando anche quello scope.';
    return result;
  }
  if (acl.status >= 400 || !acl.json) {
    result.message = describeError('verifica', acl).message;
    return result;
  }
  result.tokenValid = true;

  const byOrg = new Map();
  for (const el of acl.json.elements || []) {
    const urn = el.organization || el.organizationTarget || '';
    const id = urn.split(':').pop();
    if (!/^\d+$/.test(id)) continue;
    if (!byOrg.has(id)) byOrg.set(id, { id, name: null, vanityName: null, roles: [] });
    byOrg.get(id).roles.push(el.role);
  }

  // Nomi delle Pagine (best effort, non blocca la verifica)
  await Promise.all([...byOrg.values()].slice(0, 25).map(async p => {
    try {
      const r = await apiRequest('GET', `/organizations/${p.id}`, token);
      if (r.status === 200 && r.json) {
        p.name = r.json.localizedName || null;
        p.vanityName = r.json.vanityName || null;
      }
    } catch (_) { /* nome non disponibile */ }
  }));

  result.pages = [...byOrg.values()].map(p => ({ ...p, canPost: p.roles.some(r => POSTING_ROLES.includes(r)) }));

  if (!orgId) {
    result.message = result.pages.length
      ? 'Token valido. Scegli la Page del cliente dall\'elenco.'
      : 'Token valido, ma il tuo profilo non risulta amministratore di nessuna Page LinkedIn.';
    return result;
  }

  result.target = result.pages.find(p => p.id === orgId) || null;
  if (!result.target) {
    result.message = `Il token non ha ruoli sulla Page ${orgId}: controlla l'ID o fatti aggiungere come amministratore.`;
  } else if (!result.target.canPost) {
    result.message = `Ruolo sulla Page (${result.target.roles.join(', ')}) non sufficiente per pubblicare: serve Amministratore o Content admin.`;
  } else {
    result.ok = true;
    result.message = `Connessione OK: pronto a pubblicare su "${result.target.name || orgId}".`;
  }
  return result;
}

// ─────────────── Scadenza versione API ───────────────

/** Mesi trascorsi dalla versione API in uso (LinkedIn la spegne dopo ~12). */
function apiVersionAgeMonths(version = LINKEDIN_API_VERSION, now = new Date()) {
  const y = Number(version.slice(0, 4));
  const m = Number(version.slice(4, 6));
  return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
}

module.exports = {
  publishToLinkedIn,
  verifyLinkedInConnection,
  linkedInPostUrl,
  toLittleText,
  planLinkedInContent,
  buildPostBody,
  apiVersionAgeMonths,
  LINKEDIN_API_VERSION,
  DEFAULT_API_VERSION
};
