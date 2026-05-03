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

// Per il video slideshow servono N prompt che condividono soggetto/brand/mood
// ma cambiano angolo / inquadratura / dettaglio scena. Risultato: N immagini
// che animate insieme sembrano una piccola sequenza coerente.
const VARIATION_SYSTEM_INSTRUCTION = `Sei un art director per video editoriale di social media.
Devi creare ${'<<COUNT>>'} prompt visivi in INGLESE per un AI image generator. I prompt
devono rappresentare la STESSA scena/brand ma con angolazioni e dettagli diversi,
così assemblati in slideshow daranno l'impressione di un piccolo video.

Output: SOLO ${'<<COUNT>>'} prompt, uno per riga, niente numerazione né prefissi.

Regole:
- Lingua: inglese.
- Soggetto e brand IDENTICI in tutti i prompt (coerenza visiva).
- Cambia: angolo camera (wide / close-up / medium / detail / over-the-shoulder),
  composition, focus point. NON cambiare: subject, location, mood, lighting, palette.
- Includi sempre: lighting, color palette, style, "no text, no typography, no watermark".
- Aspect ratio: dichiaralo in ogni prompt.
- Stile predefinito: "professional editorial photography, natural light, shallow depth of field, photorealistic".`;

async function buildVariationPrompts(client, post, aspectRatio, count = 3) {
  const n = Math.max(2, Math.min(6, parseInt(count, 10) || 3));
  const apiKey = client.gemini_api_key;

  // Senza key: fallback deterministico — N varianti del fallback con angoli diversi
  if (!apiKey) {
    const angles = ['wide establishing shot', 'close-up macro detail', 'medium shot eye-level',
                    'over-the-shoulder perspective', 'low-angle hero shot', 'top-down flat lay'];
    const base = _fallbackPrompt(client, post, aspectRatio);
    return Array.from({ length: n }, (_, i) =>
      base.replace('Professional editorial', angles[i % angles.length] + ' professional editorial'));
  }

  const parts = [];
  if (client.brand_name)   parts.push(`brand="${client.brand_name}"`);
  if (client.sector)       parts.push(`settore="${client.sector}"`);
  if (client.location)     parts.push(`località="${client.location}"`);
  if (post.category)       parts.push(`categoria="${post.category}"`);
  if (post.sub_topic)      parts.push(`tema="${post.sub_topic}"`);
  const captionLine = (post.caption || '').replace(/\s+/g, ' ').trim().substring(0, 400);
  if (captionLine) parts.push(`caption="${captionLine}"`);
  parts.push(`aspect=${aspectRatio || '9:16'}`);
  parts.push(`count=${n}`);
  const userPrompt = parts.join(', ');

  const sysInstr = VARIATION_SYSTEM_INSTRUCTION.replace(/<<COUNT>>/g, String(n));

  try {
    const { text } = await callGemini(apiKey, sysInstr, userPrompt, {
      temperature: 0.7,
      maxTokens: 800
    });
    const lines = (text || '').split('\n').map(l => l.trim()).filter(l =>
      l && !/^[0-9]+[.)]\s*$/.test(l) && !l.startsWith('#')
    ).map(l => l.replace(/^[0-9]+[.)]\s*/, '').replace(/^["'`]|["'`]$/g, '').trim());

    if (lines.length >= n) return lines.slice(0, n);
    // Padding con la base se l'AI ne ha restituiti meno
    const base = await buildPrompt(client, post, aspectRatio);
    while (lines.length < n) lines.push(base);
    return lines;
  } catch (err) {
    console.warn('[visual-prompt] buildVariationPrompts failed, using fallback:', err.message);
    const base = _fallbackPrompt(client, post, aspectRatio);
    return Array.from({ length: n }, () => base);
  }
}

// Prompt builder dedicato per Veo 3: stile cinematografico con movimenti camera
// espliciti, ambient sound suggestions, durata. Output diverso da buildPrompt
// (che è per immagini statiche): qui servono verbi di movimento ("camera slowly
// pans", "subject moves", "wind blows", "leaves rustle"), e audio descriptions
// (ambient sound, dialogue, music) perché Veo 3 genera audio nativo.
const VIDEO_SYSTEM_INSTRUCTION = `Sei un direttore della fotografia per spot social brevi.
Trasformi il contesto di un post in un prompt video in INGLESE per Google Veo 3 (text-to-video AI).

Output: SOLO il prompt finale, una singola riga di testo, senza prefissi.

Regole obbligatorie:
- Lingua: inglese.
- Includi SEMPRE in quest'ordine: subject + action, camera movement, lighting,
  ambient sound, mood, style, quality keywords.
- Camera movement: usa termini specifici ("slow dolly in", "smooth tracking shot",
  "static medium shot", "subtle handheld", "crane up reveal", "macro push-in").
- Ambient sound: descrivi cosa si sente ("birds chirping in distance", "soft
  acoustic guitar", "gentle wind through trees", "ambient cafe chatter", "no music").
  Veo 3 genera audio nativo, sfruttalo.
- Mood + lighting + palette coerenti con il brand/settore.
- NO testo on-screen: aggiungi "no text overlay, no captions, no logo".
- Aspect ratio: dichiaralo ("vertical 9:16 cinematic" / "horizontal 16:9 cinematic").
- Stile predefinito: "cinematic, photorealistic, shallow depth of field, soft natural light, 4k quality".
- Durata 8 secondi: descrivi un'azione che si svolge in quel tempo, non una scena statica.

Esempio.
Input: brand="Apicoltore La Greca", settore="apicoltura", caption="Il miele d'arancio appena estratto profuma di primavera siciliana", aspect=9:16
Output: Macro push-in shot of fresh orange blossom honey slowly dripping from a wooden honey dipper into a glass jar, golden warm sunlight streaming through Sicilian orange grove leaves in background, soft bokeh, ambient sound of bees buzzing gently and leaves rustling in light breeze, peaceful authentic mood, amber and honey-gold tones, cinematic photorealistic style, shallow depth of field, 4k quality, vertical 9:16 cinematic, no text overlay, no captions, no logo.`;

async function buildVideoPrompt(client, post, aspectRatio) {
  const parts = [];
  if (client.brand_name)   parts.push(`brand="${client.brand_name}"`);
  if (client.sector)       parts.push(`settore="${client.sector}"`);
  if (client.location)     parts.push(`località="${client.location}"`);
  if (client.tagline)      parts.push(`tagline="${client.tagline}"`);
  if (post.category)       parts.push(`categoria="${post.category}"`);
  if (post.sub_topic)      parts.push(`tema="${post.sub_topic}"`);
  const captionLine = (post.caption || '').replace(/\s+/g, ' ').trim().substring(0, 400);
  if (captionLine) parts.push(`caption="${captionLine}"`);
  parts.push(`aspect=${aspectRatio || '9:16'}`);

  const userPrompt = parts.join(', ');
  const apiKey = client.gemini_api_key;
  if (!apiKey) return _fallbackVideoPrompt(client, post, aspectRatio);

  try {
    const { text } = await callGemini(apiKey, VIDEO_SYSTEM_INSTRUCTION, userPrompt, {
      temperature: 0.7,
      maxTokens: 600
    });
    const cleaned = (text || '').replace(/^["'`]|["'`]$/g, '').trim();
    return cleaned || _fallbackVideoPrompt(client, post, aspectRatio);
  } catch (err) {
    console.warn('[visual-prompt] buildVideoPrompt failed, using fallback:', err.message);
    return _fallbackVideoPrompt(client, post, aspectRatio);
  }
}

function _fallbackVideoPrompt(client, post, aspectRatio) {
  const subject = post.sub_topic || post.category || client.brand_name || 'product';
  const sector = client.sector || 'lifestyle';
  const ratioWord = aspectRatio === '16:9' ? 'horizontal 16:9' : 'vertical 9:16';
  return `Slow dolly-in shot of ${subject} in a ${sector} setting, soft natural light, gentle ambient sound, peaceful authentic mood, warm earthy palette, cinematic photorealistic style, shallow depth of field, 4k quality, ${ratioWord} cinematic, no text overlay, no captions, no logo.`;
}

module.exports = { buildPrompt, buildVariationPrompts, buildVideoPrompt };
