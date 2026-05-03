// Generazione video AI tramite Google Veo 3 (Gemini API).
// Differenza chiave da gemini-image.js: l'operazione è LONG-RUNNING, non sincrona.
//   1) submit job → riceve { name: "operations/xxx" }
//   2) polling GET /v1beta/{name} ogni 5s finché done=true
//   3) download del video binario dall'URI ritornato (richiede ?key=API_KEY in query)
//
// Modelli supportati:
//   - veo-3.0-generate-preview    : qualità top, ~$0.75/sec con audio
//   - veo-3.0-fast-generate-preview: 720p, più veloce, ~$0.40/sec
//
// Aspect ratio supportati da Veo 3: solo "16:9" e "9:16" (NON 1:1).
// Durata: 4-8 sec (default 8). Audio nativo generato dal modello.

'use strict';

const https = require('https');

const HOST = 'generativelanguage.googleapis.com';

function _request({ method = 'GET', path, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST,
      path,
      method,
      headers: { ...headers }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function _submit(apiKey, model, prompt, opts) {
  const instance = { prompt };
  if (opts.negativePrompt)  instance.negativePrompt = opts.negativePrompt;
  if (opts.aspectRatio)     instance.aspectRatio = opts.aspectRatio;
  if (opts.durationSeconds) instance.durationSeconds = opts.durationSeconds;
  // personGeneration: 'allow_all' | 'allow_adult' | 'dont_allow'.
  // Default conservativo: dont_allow per minori, ma 'allow_adult' è quello realistico
  // per post brand (es. apicoltore, pasticceria).
  instance.personGeneration = opts.personGeneration || 'allow_adult';

  const body = JSON.stringify({ instances: [instance] });
  const res = await _request({
    method: 'POST',
    path: `/v1beta/models/${model}:predictLongRunning?key=${apiKey}`,
    body
  });
  const text = res.body.toString('utf-8');
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('Veo: risposta non JSON: ' + text.substring(0, 200)); }
  if (json.error) throw new Error(json.error.message || 'Veo submit error');
  if (!json.name) throw new Error('Veo: operation name mancante nella risposta');
  return json.name; // es. "models/veo-3.0-generate-preview/operations/xxxxxxxx"
}

// Single poll (no loop): usato dal frontend che fa il polling lui via HTTP.
// Evita di tenere la connessione aperta per minuti (Caddy/Coolify timeout).
async function checkOperation(apiKey, opName) {
  const res = await _request({
    method: 'GET',
    path: `/v1beta/${opName}?key=${apiKey}`
  });
  const text = res.body.toString('utf-8');
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('Veo poll: risposta non JSON: ' + text.substring(0, 200)); }
  if (json.error) throw new Error(json.error.message || 'Veo poll error');
  return { done: !!json.done, response: json.response || null };
}

// Estrae URI o bytes inline dalla response. Lo shape è instabile (preview API):
// proviamo le forme note in ordine.
function _extractVideoRef(response) {
  // Forma A: generateVideoResponse.generatedSamples[].video.uri
  const a = response.generateVideoResponse?.generatedSamples;
  if (Array.isArray(a) && a.length && a[0].video?.uri) {
    return { uri: a[0].video.uri, mime: a[0].video.mimeType || 'video/mp4' };
  }
  // Forma B: predictions[].video.uri
  const b = response.predictions;
  if (Array.isArray(b) && b.length) {
    if (b[0].video?.uri) return { uri: b[0].video.uri, mime: b[0].video.mimeType || 'video/mp4' };
    if (b[0].videoUri)   return { uri: b[0].videoUri, mime: 'video/mp4' };
    if (b[0].bytesBase64Encoded) {
      return { buffer: Buffer.from(b[0].bytesBase64Encoded, 'base64'), mime: 'video/mp4' };
    }
  }
  throw new Error('Veo: impossibile estrarre URI video dalla response: ' + JSON.stringify(response).substring(0, 300));
}

async function _download(apiKey, videoUri) {
  const url = new URL(videoUri);
  // Veo file URIs richiedono ?key= in query string per autenticarsi
  const sep = url.search ? '&' : '?';
  const path = url.pathname + url.search + sep + 'alt=media&key=' + apiKey;
  const res = await new Promise((resolve, reject) => {
    https.get({ hostname: url.hostname, path }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  if (res.status !== 200) {
    throw new Error('Veo download HTTP ' + res.status + ': ' + res.body.toString('utf-8').substring(0, 200));
  }
  return res.body;
}

/**
 * Submit job Veo. Ritorna immediatamente con operation name (non aspetta done).
 * Il frontend dovrà poi pollare /check-veo-status finché ready.
 */
async function submitJob(apiKey, prompt, opts = {}) {
  if (!apiKey) throw new Error('Veo: API key mancante');
  if (!prompt || !prompt.trim()) throw new Error('Veo: prompt vuoto');

  const aspectRatio = (opts.aspectRatio === '16:9' || opts.aspectRatio === '9:16') ? opts.aspectRatio : '9:16';
  const durationSeconds = Math.max(4, Math.min(8, parseInt(opts.durationSeconds, 10) || 8));
  const modelVariant = opts.modelVariant === 'fast' ? 'fast' : 'standard';
  const model = modelVariant === 'fast' ? 'veo-3.0-fast-generate-preview' : 'veo-3.0-generate-preview';

  const opName = await _submit(apiKey, model, prompt, {
    aspectRatio, durationSeconds,
    negativePrompt: opts.negativePrompt,
    personGeneration: opts.personGeneration
  });

  return { opName, model, aspectRatio, durationSeconds, modelVariant };
}

/**
 * Recupera il video da una operation completata (done=true).
 * Estrae URI dalla response e fa il download del binario.
 */
async function fetchCompletedVideo(apiKey, opResponse) {
  const ref = _extractVideoRef(opResponse);
  if (ref.buffer) return { buffer: ref.buffer, mime: ref.mime };
  const buffer = await _download(apiKey, ref.uri);
  return { buffer, mime: ref.mime };
}

module.exports = { submitJob, checkOperation, fetchCompletedVideo };
