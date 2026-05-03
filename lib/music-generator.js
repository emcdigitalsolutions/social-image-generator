// Generazione musica AI via Replicate (provider stabile, ~$0.05/track).
// Modello: meta/musicgen (Meta MusicGen via Replicate hosting).
//
// Replicate è async (long-running): submit prediction → poll status → download.
// Il polling lo facciamo lato server perché è veloce (10-30s totali, dentro
// il timeout proxy a differenza di Veo).
//
// Token gratuito: https://replicate.com/account/api-tokens (5$ free credit
// al primo signup ≈ 100 tracce).
//
// Fallback tentativo: prima Replicate, poi HF Inference (se ancora attivo per
// quel modello/account). Se HF restituisce 404 o JSON error, salta a Replicate.

'use strict';

const https = require('https');

const REPLICATE_HOST = 'api.replicate.com';
const HF_HOST = 'api-inference.huggingface.co';

const MAX_PROMPT_LEN = 200;
const POLL_INTERVAL_MS = 2500;
const MAX_POLLS = 60; // 2.5 min max

function _httpsRequest({ host, path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: host, path, method, headers: { ...headers } };
    if (body) {
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Replicate flow ──────────────────────────────────────────────

async function _replicateSubmit(token, prompt, durationSec) {
  // Endpoint "official model" non richiede version explicit:
  // https://api.replicate.com/v1/models/meta/musicgen/predictions
  // Input shape: { prompt, duration, model_version, output_format }
  const body = JSON.stringify({
    input: {
      prompt: prompt.substring(0, MAX_PROMPT_LEN),
      duration: durationSec,
      model_version: 'stereo-melody-large',
      output_format: 'wav',
      normalization_strategy: 'peak'
    }
  });
  const res = await _httpsRequest({
    host: REPLICATE_HOST,
    path: '/v1/models/meta/musicgen/predictions',
    method: 'POST',
    headers: { 'Authorization': `Token ${token}`, 'Prefer': 'respond-async' },
    body
  });
  const text = res.body.toString('utf-8');
  let json;
  try { json = JSON.parse(text); }
  catch (_) { throw new Error('Replicate: risposta non JSON: ' + text.substring(0, 200)); }
  if (res.status >= 400) {
    throw new Error(`Replicate ${res.status}: ${json.detail || json.error || text.substring(0, 200)}`);
  }
  if (!json.id) throw new Error('Replicate: prediction id mancante');
  return json; // { id, status, urls: { get, cancel } }
}

async function _replicatePoll(token, prediction) {
  const getUrl = prediction.urls && prediction.urls.get;
  if (!getUrl) throw new Error('Replicate: URL polling mancante');
  const url = new URL(getUrl);

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await _httpsRequest({
      host: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Authorization': `Token ${token}` }
    });
    const text = res.body.toString('utf-8');
    let json;
    try { json = JSON.parse(text); }
    catch (_) { throw new Error('Replicate poll: risposta non JSON'); }

    if (json.status === 'succeeded') return json;
    if (json.status === 'failed' || json.status === 'canceled') {
      throw new Error(`Replicate ${json.status}: ${json.error || 'unknown error'}`);
    }
    // status: 'starting' | 'processing' → continue
  }
  throw new Error('Replicate: timeout polling (>2.5 min)');
}

async function _downloadFromUrl(url) {
  const u = new URL(url);
  const res = await new Promise((resolve, reject) => {
    https.get({ hostname: u.hostname, path: u.pathname + u.search }, (r) => {
      // Replicate output URLs sono CDN-pubbliche, no auth needed
      if (r.statusCode === 301 || r.statusCode === 302) {
        return _downloadFromUrl(r.headers.location).then(resolve, reject);
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  if (res.status !== 200) throw new Error('Download HTTP ' + res.status);
  return res.body;
}

async function _generateViaReplicate(token, prompt, durationSec) {
  const submitted = await _replicateSubmit(token, prompt, durationSec);
  const completed = await _replicatePoll(token, submitted);
  // output può essere stringa (URL) o array di URL
  const out = Array.isArray(completed.output) ? completed.output[0] : completed.output;
  if (!out || typeof out !== 'string') throw new Error('Replicate: output URL mancante');
  const buffer = await _downloadFromUrl(out);
  return { buffer, mime: 'audio/wav', model: 'meta/musicgen (replicate)' };
}

// ── Hugging Face flow (fallback legacy, spesso 404 ora) ────────

async function _generateViaHuggingFace(token, prompt, durationSec) {
  const maxNewTokens = Math.max(100, Math.min(1500, Math.round(durationSec * 50)));
  const body = JSON.stringify({
    inputs: prompt.substring(0, MAX_PROMPT_LEN),
    parameters: { max_new_tokens: maxNewTokens, do_sample: true, temperature: 1.0, guidance_scale: 3 },
    options: { wait_for_model: true, use_cache: false }
  });
  const res = await _httpsRequest({
    host: HF_HOST,
    path: '/models/facebook/musicgen-small',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'audio/wav' },
    body
  });
  if (res.status !== 200) {
    const msg = res.body.toString('utf-8').substring(0, 300);
    throw new Error(`HF MusicGen ${res.status}: ${msg}`);
  }
  return { buffer: res.body, mime: 'audio/wav', model: 'facebook/musicgen-small (hf)' };
}

/**
 * Genera una traccia musicale. Prova Replicate prima (stabile), poi HF come
 * fallback. Ritorna error se nessuno è configurato.
 *
 * @param {object} keys - { replicateToken?, huggingfaceToken? }
 * @param {string} prompt
 * @param {object} opts - { durationSec }
 */
async function generateMusic(keys, prompt, opts = {}) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt musicale vuoto');
  const durationSec = Math.max(5, Math.min(30, parseInt(opts.durationSec, 10) || 15));

  const replicate = keys.replicateToken;
  const hf = keys.huggingfaceToken;

  if (!replicate && !hf) {
    throw new Error('Nessun provider audio configurato. Aggiungi Replicate token (consigliato) o Hugging Face token in Settings.');
  }

  // Preferenza: Replicate (più stabile)
  if (replicate) {
    return _generateViaReplicate(replicate, prompt.trim(), durationSec);
  }
  return _generateViaHuggingFace(hf, prompt.trim(), durationSec);
}

module.exports = { generateMusic };
