// Analisi visiva di un'immagine via Gemini Flash (multimodale).
// Differenza da gemini-image.js (che GENERA immagini): qui DESCRIVIAMO
// un'immagine esistente → { description, tags }. Usato per popolare la cache
// di descrizioni delle immagini di libreria (lib/library-match.js), così il
// match caption->immagine è poi un confronto testuale veloce ed economico.
//
// Override modello con env GEMINI_VISION_MODEL (default gemini-2.5-flash).

const https = require('https');

const MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_RETRIES = 3;

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
          reject(new Error('Invalid Gemini Vision response: ' + raw.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function _extractJson(text) {
  if (!text) return null;
  // toglie eventuali fence ```json ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); }
  catch (_) { return null; }
}

/**
 * Descrive un'immagine. Ritorna { description: string, tags: string[] }.
 * @param {string} apiKey
 * @param {Buffer} imageBuffer
 * @param {string} mimeType  es. 'image/jpeg'
 * @param {object} [context] { brand, sector } per arricchire i tag
 */
async function describeImage(apiKey, imageBuffer, mimeType, context = {}) {
  if (!apiKey) throw new Error('Gemini API key mancante');
  if (!imageBuffer || !imageBuffer.length) throw new Error('Immagine vuota');

  const ctx = [
    context.brand ? `Brand: ${context.brand}.` : '',
    context.sector ? `Settore: ${context.sector}.` : ''
  ].filter(Boolean).join(' ');

  const prompt = `Analizza l'immagine e descrivi OGGETTIVAMENTE cosa mostra, per aiutare un social media manager a scegliere l'immagine giusta per un post.${ctx ? ' Contesto del cliente (solo per orientare i tag, non inventare ciò che non si vede): ' + ctx : ''}

Rispondi SOLO con JSON valido in questo formato:
{"description":"<1-2 frasi in italiano: soggetti, ambientazione, azione, atmosfera/colori dominanti>","tags":["<5-10 keyword in italiano: oggetti, soggetti, luogo, colori, mood>"]}

Niente testo prima o dopo il JSON.`;

  const body = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBuffer.toString('base64') } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 500,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }
    }
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { json, status } = await _request(apiKey, body);

    if (json.error) {
      const msg = json.error.message || 'Gemini Vision API error';
      const lower = msg.toLowerCase();
      const retryable = status === 429 || status === 503 || status === 500
        || lower.includes('quota') || lower.includes('overload') || lower.includes('unavailable');
      if (retryable && attempt < MAX_RETRIES) {
        const wait = Math.min(45, Math.pow(2, attempt) * 3);
        console.warn(`[gemini-vision] ${status} retry ${attempt}/${MAX_RETRIES} in ${wait}s — ${msg.substring(0, 80)}`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      throw new Error(msg);
    }

    const text = json.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    const parsed = _extractJson(text);
    if (!parsed || !parsed.description) {
      throw new Error('Gemini Vision: risposta non interpretabile');
    }
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 12)
      : [];
    return { description: String(parsed.description).trim().slice(0, 600), tags };
  }
}

module.exports = { describeImage, MODEL };
