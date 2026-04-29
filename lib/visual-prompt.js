// Trasforma il contesto del post (caption + brand + settore) in un prompt visivo
// dettagliato per Gemini Image. La differenza tra "immagine generica" e "immagine
// pronta per IG" sta tutta qui: prompt vago = output mediocre, prompt ricco di
// lighting/composition/mood = output pubblicabile.

const { callGemini } = require('./gemini');

const SYSTEM_INSTRUCTION = `Sei un art director esperto di social media e fotografia editoriale.
Trasformi una caption Instagram in un prompt visivo in INGLESE per un AI image generator.

Output: SOLO il prompt finale, una singola riga di testo, senza prefissi tipo "Prompt:" o "Here is".

Regole obbligatorie:
- Lingua: inglese (i modelli di image generation rispondono meglio).
- Includi sempre: subject, composition, lighting, mood, color palette, style, quality keywords.
- NO testo nell'immagine: aggiungi "no text, no typography, no watermark, no logo overlay" perché il modello tende ad aggiungere lettere malformate.
- Coerenza brand: se è un'attività locale (apicoltura, pasticceria, onoranze, ecc.), tono autentico/artigianale, non plastica/stock.
- Aspect ratio: dichiaralo nel prompt ("vertical 9:16 composition" / "square 1:1 composition" / etc).
- Stile predefinito: "professional editorial photography, natural light, shallow depth of field, soft warm tones, high detail, photorealistic".
- Per settori specifici adatta lo stile (es. food → close-up macro, garden → golden hour, fashion → minimal studio).

Esempio.
Input: brand="Apicoltore La Greca", settore="apicoltura", caption="Il miele d'arancio appena estratto profuma di primavera siciliana", aspect=1:1
Output: Close-up macro photography of fresh orange blossom honey dripping from a wooden honey dipper into a glass jar, golden warm sunlight filtering through a Sicilian orange grove in the background, soft bokeh, amber and honey-gold tones with hints of green leaves, professional editorial food photography, natural light, shallow depth of field, photorealistic, high detail, square 1:1 composition, no text, no typography, no watermark.`;

async function buildPrompt(client, post, aspectRatio) {
  const parts = [];
  if (client.brand_name)   parts.push(`brand="${client.brand_name}"`);
  if (client.sector)       parts.push(`settore="${client.sector}"`);
  if (client.location)     parts.push(`località="${client.location}"`);
  if (client.tagline)      parts.push(`tagline="${client.tagline}"`);
  if (post.category)       parts.push(`categoria="${post.category}"`);
  if (post.sub_topic)      parts.push(`tema="${post.sub_topic}"`);

  const captionLine = (post.caption || '').replace(/\s+/g, ' ').trim().substring(0, 400);
  if (captionLine) parts.push(`caption="${captionLine}"`);

  parts.push(`aspect=${aspectRatio || '1:1'}`);

  const userPrompt = parts.join(', ');

  const apiKey = client.gemini_api_key;
  if (!apiKey) {
    // Fallback senza AI: prompt grezzo deterministico (qualità minore ma funziona)
    return _fallbackPrompt(client, post, aspectRatio);
  }

  try {
    const { text } = await callGemini(apiKey, SYSTEM_INSTRUCTION, userPrompt, {
      temperature: 0.6,
      maxTokens: 400
    });
    const cleaned = (text || '').replace(/^["'`]|["'`]$/g, '').trim();
    return cleaned || _fallbackPrompt(client, post, aspectRatio);
  } catch (err) {
    console.warn('[visual-prompt] callGemini failed, using fallback:', err.message);
    return _fallbackPrompt(client, post, aspectRatio);
  }
}

function _fallbackPrompt(client, post, aspectRatio) {
  const subject = post.sub_topic || post.category || client.brand_name || 'product';
  const sector = client.sector || 'lifestyle';
  const ratioWord = aspectRatio === '9:16' ? 'vertical 9:16' :
                    aspectRatio === '16:9' ? 'horizontal 16:9' :
                    aspectRatio === '4:5'  ? 'vertical 4:5' :
                    'square 1:1';
  return `Professional editorial ${sector} photography of ${subject}, natural soft light, warm earthy color palette, shallow depth of field, photorealistic, high detail, ${ratioWord} composition, no text, no typography, no watermark.`;
}

module.exports = { buildPrompt };
