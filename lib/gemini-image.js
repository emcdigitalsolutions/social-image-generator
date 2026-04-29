// Generazione immagini AI via gemini-2.5-flash-image (Nano-Banana, gratuito).
// Differenze chiave da `gemini.js` (text):
//   - modello differente (gemini-2.5-flash-image)
//   - request body: `responseModalities: ['IMAGE']` (alcune doc mostrano TEXT+IMAGE,
//     IMAGE-only riduce token spesi su descrizioni testuali inutili)
//   - response parsing: estrae `inlineData.data` (base64) invece di text
//
// Quote: free tier ha rate limit ~10 req/min e quota giornaliera. Stessi retry
// di gemini.js per 429/503/500.

const https = require('https');
const sharp = require('sharp');

const MODEL = 'gemini-2.5-flash-image';
const URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_RETRIES = 4;

// Dimensioni IG-safe per ciascun aspect ratio. Sharp post-process porta a queste
// dimensioni esatte indipendentemente da quello che ritorna il modello.
const RATIO_DIMS = {
  '1:1':  { w: 1080, h: 1080 },
  '4:5':  { w: 1080, h: 1350 },
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 }
};

function _request(key, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${URL_BASE}?key=${key}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ json: JSON.parse(raw), status: res.statusCode });
        } catch (e) {
          reject(new Error('Invalid Gemini Image response: ' + raw.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function _generate(apiKey, prompt, aspectRatio) {
  if (!apiKey) throw new Error('Gemini API key mancante per il cliente');

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      // imageConfig.aspect_ratio è supportato da Imagen 3 ma non sempre da
      // flash-image. Lo passiamo "best effort": se ignorato, sharp post-process
      // ricondiziona comunque all'aspect target.
      imageConfig: aspectRatio ? { aspectRatio } : undefined
    }
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { json, status } = await _request(apiKey, body);

    if (json.error) {
      const msg = json.error.message || 'Gemini Image API error';
      const lower = msg.toLowerCase();
      const isRetryable =
        status === 429 || status === 503 || status === 500 ||
        lower.includes('quota') || lower.includes('overload') || lower.includes('unavailable');

      if (isRetryable && attempt < MAX_RETRIES) {
        const wait = Math.min(60, Math.pow(2, attempt) * 3);
        console.warn(`[gemini-image] ${status} retry ${attempt}/${MAX_RETRIES} in ${wait}s — ${msg.substring(0, 80)}`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      throw new Error(msg);
    }

    // Risposta attesa: candidates[0].content.parts[*].inlineData.{mimeType,data}
    const parts = json.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
    if (!imgPart) {
      // A volte il modello rifiuta con un text part (safety filter, prompt vago...)
      const textPart = parts.find(p => p.text);
      const reason = textPart ? textPart.text.substring(0, 200) : 'nessuna immagine nella risposta';
      throw new Error('Gemini non ha generato l\u2019immagine: ' + reason);
    }

    return Buffer.from(imgPart.inlineData.data, 'base64');
  }
}

// Genera + post-process: garantisce dimensioni esatte IG-safe e PNG flatten
// senza alpha (compatibile con Meta upload, vedi normalizeImageForMeta).
async function generateForPost(apiKey, prompt, aspectRatio = '1:1') {
  const dims = RATIO_DIMS[aspectRatio] || RATIO_DIMS['1:1'];
  const raw = await _generate(apiKey, prompt, aspectRatio);

  // Cover-fit alle dimensioni target. Se il modello ha rispettato l'aspect,
  // è un crop/scale minimo; se no, riadatta senza distorcere.
  const shaped = await sharp(raw)
    .resize(dims.w, dims.h, { fit: 'cover', position: 'center' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92, mozjpeg: false, progressive: false })
    .toBuffer();

  return { buffer: shaped, width: dims.w, height: dims.h, mime: 'image/jpeg' };
}

module.exports = { generateForPost, RATIO_DIMS };
