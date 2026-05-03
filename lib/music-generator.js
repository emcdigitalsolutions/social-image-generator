// Generazione musica AI via Hugging Face Inference API.
// Modello: facebook/musicgen-small (free tier, ~600MB, lento al primo
// inference per cold-start del modello, ~10-30s, poi cached).
//
// Token gratuito: https://huggingface.co/settings/tokens (read access).
// Quota free tier: generosa per uso personale, rate limit per minuto.
//
// Output MusicGen: WAV stereo 32kHz mono dal modello small. Lo passiamo
// così com'è a ffmpeg che lo accetta in input.

'use strict';

const https = require('https');

const HF_HOST = 'api-inference.huggingface.co';
const MODEL_SMALL = 'facebook/musicgen-small';
const MODEL_MEDIUM = 'facebook/musicgen-medium';

const MAX_PROMPT_LEN = 200;

function _request(token, model, prompt, durationSec) {
  // MusicGen usa duration interno calcolato dai max_new_tokens.
  // 50 tokens ≈ 1 sec di audio nel preset musicgen.
  const maxNewTokens = Math.max(100, Math.min(1500, Math.round(durationSec * 50)));
  const body = JSON.stringify({
    inputs: prompt.substring(0, MAX_PROMPT_LEN),
    parameters: {
      max_new_tokens: maxNewTokens,
      do_sample: true,
      temperature: 1.0,
      guidance_scale: 3
    },
    options: {
      wait_for_model: true,  // se cold, aspetta invece di fallire 503
      use_cache: false
    }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HF_HOST,
      path: `/models/${model}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${token}`,
        'Accept': 'audio/wav'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Se HF ritorna JSON è un errore (200 = audio binario, !200 = JSON error)
        const ct = (res.headers['content-type'] || '').toLowerCase();
        if (res.statusCode !== 200) {
          let msg = buf.toString('utf-8').substring(0, 300);
          try {
            const j = JSON.parse(msg);
            if (j.error) msg = j.error;
          } catch (_) {}
          return reject(new Error(`HF MusicGen ${res.statusCode}: ${msg}`));
        }
        if (ct.includes('json')) {
          // Alcuni endpoint ritornano JSON con base64 invece di audio binario
          try {
            const j = JSON.parse(buf.toString('utf-8'));
            if (Array.isArray(j) && j[0] && j[0].audio) {
              return resolve(Buffer.from(j[0].audio, 'base64'));
            }
            if (j.error) return reject(new Error('HF MusicGen: ' + j.error));
          } catch (_) {}
          return reject(new Error('HF MusicGen: risposta JSON inattesa'));
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Genera una traccia musicale da un prompt.
 * @param {string} hfToken - Hugging Face token (Bearer)
 * @param {string} prompt - prompt testuale (es. "upbeat acoustic guitar, mediterranean vibes")
 * @param {object} opts
 * @param {number} opts.durationSec - durata target (default 15)
 * @param {string} opts.modelSize - 'small' | 'medium' (default 'small')
 * @returns {Promise<{buffer: Buffer, mime: string, model: string}>}
 */
async function generateMusic(hfToken, prompt, opts = {}) {
  if (!hfToken) throw new Error('Hugging Face token mancante (configurare in settings)');
  if (!prompt || !prompt.trim()) throw new Error('Prompt musicale vuoto');

  const durationSec = Math.max(5, Math.min(30, parseInt(opts.durationSec, 10) || 15));
  const model = opts.modelSize === 'medium' ? MODEL_MEDIUM : MODEL_SMALL;

  const buffer = await _request(hfToken, model, prompt.trim(), durationSec);
  return { buffer, mime: 'audio/wav', model };
}

module.exports = { generateMusic };
