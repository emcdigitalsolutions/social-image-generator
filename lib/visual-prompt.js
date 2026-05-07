// Trasforma il contesto del post (caption + brand + settore) in un prompt visivo
// dettagliato per Gemini Image. La differenza tra "immagine generica" e "immagine
// pronta per IG" sta tutta qui: prompt vago = output mediocre, prompt ricco di
// lighting/composition/mood = output pubblicabile.
//
// Per evitare che immagini consecutive si assomiglino, usiamo:
//  - Rotazione di STILI VISIVI (visual_styles per cliente, default 6 preset)
//  - Seed di VARIAZIONE casuale (camera angle + mood + lighting)
//  - Iniezione contesto ricco (brand_colors, tagline, settore, location)

const { callGemini } = require('./gemini');
const { getEffectiveGeminiKey } = require('./settings');
const { getDb } = require('./db');

// Stili visivi default usati quando il cliente non ha configurazione propria
// in clients.visual_styles. 6 preset abbastanza diversi tra loro per garantire
// varietà visibile con rotazione. L'utente può sostituirli dalla UI.
const DEFAULT_VISUAL_STYLES = [
  'professional editorial photography, golden hour warm light, shallow depth of field, soft bokeh, photorealistic, high detail',
  'minimal flat lay top-down, clean white or pastel background, geometric composition, soft diffused light, magazine style',
  'macro close-up shot, extreme detail, dramatic shallow depth of field, side lighting with subtle shadows, photorealistic',
  'lifestyle candid documentary photography, soft window natural light, authentic spontaneous mood, slight grain, cinematic',
  'cinematic wide establishing shot, atmospheric mood, moody color grading, dramatic side light, anamorphic feel, photorealistic',
  'studio product photography, clean minimalist background, three-point softbox lighting, sharp focus, commercial polish'
];

const VARIATION_ANGLES = [
  'wide establishing shot', 'close-up macro detail', 'medium shot eye-level',
  'over-the-shoulder perspective', 'low-angle hero shot', 'top-down flat lay',
  'three-quarter angle', 'side profile composition'
];
const VARIATION_MOODS = [
  'serene and calm', 'energetic and vibrant', 'sophisticated and refined',
  'warm and inviting', 'minimalist and clean', 'rustic and authentic',
  'modern and elegant', 'cozy and intimate'
];
const VARIATION_LIGHTING = [
  'golden hour warm light', 'overcast diffused soft light', 'morning sunlight through window',
  'studio softbox three-point', 'dramatic side rim light', 'twilight blue hour',
  'natural noon daylight', 'backlit silhouette glow'
];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function parseVisualStyles(raw) {
  if (!raw) return DEFAULT_VISUAL_STYLES;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) {
      const cleaned = arr.filter(s => typeof s === 'string' && s.trim().length > 5);
      return cleaned.length ? cleaned : DEFAULT_VISUAL_STYLES;
    }
  } catch { /* malformed, fallback */ }
  return DEFAULT_VISUAL_STYLES;
}

function parseBrandColors(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter(c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
  } catch { /* malformed */ }
  return [];
}

// Pesca uno stile diverso dall'ultimo usato (no ripetizioni consecutive).
// Se c'è 1 solo stile, lo restituisce sempre.
function pickNextStyleIndex(styles, lastIdx) {
  if (styles.length <= 1) return 0;
  let candidate;
  do { candidate = Math.floor(Math.random() * styles.length); }
  while (candidate === lastIdx);
  return candidate;
}

const SYSTEM_INSTRUCTION = `Sei un art director esperto di social media e fotografia editoriale.
Trasformi una caption Instagram in un prompt visivo in INGLESE per un AI image generator.

Output: SOLO il prompt finale, una singola riga di testo, senza prefissi tipo "Prompt:" o "Here is".

Regole obbligatorie:
- Lingua: inglese (i modelli di image generation rispondono meglio).
- Includi sempre: subject (dalla caption), composition, lighting, mood, color palette, style, quality keywords.
- Se il cliente fornisce STYLE_DIRECTIVE, INCORPORALA fedelmente come stile principale del prompt (è il preset visivo scelto a rotazione, garantisce varietà tra immagini consecutive).
- Se il cliente fornisce VARIATION (angle/mood/lighting), USA quei valori specifici per quel post (forzano diversità anche dentro lo stesso stile).
- Se il cliente fornisce brand_colors (palette hex), MENZIONALI esplicitamente nel prompt come palette di riferimento (es. "color palette dominated by #0c1120 and #6b9ef7 accents").
- NO testo nell'immagine: aggiungi "no text, no typography, no watermark, no logo overlay" perché il modello tende ad aggiungere lettere malformate.
- Coerenza brand: tono autentico/artigianale per attività locali (apicoltura, pasticceria, onoranze...), non plastica/stock.
- Aspect ratio: dichiaralo nel prompt ("vertical 9:16 composition" / "square 1:1 composition" / etc).

Esempio.
Input: brand="Apicoltore La Greca", settore="apicoltura", tagline="il miele autentico di Sicilia", brand_colors=#a86b1f,#f4d03f, caption="Il miele d'arancio appena estratto profuma di primavera siciliana", STYLE_DIRECTIVE="macro close-up shot, extreme detail, dramatic shallow depth of field, side lighting", VARIATION="angle=close-up macro detail, mood=warm and inviting, lighting=golden hour warm light", aspect=1:1
Output: Macro close-up shot of fresh orange blossom honey dripping from a wooden honey dipper into a glass jar, extreme detail with dramatic shallow depth of field, golden hour warm light side-lit creating a warm and inviting mood, color palette dominated by amber #a86b1f tones with golden #f4d03f highlights, blurred Sicilian orange grove background with soft bokeh, professional editorial food photography, photorealistic, high detail, square 1:1 composition, no text, no typography, no watermark.`;

/**
 * Costruisce il prompt visivo per un post.
 *
 * @param {object} client - record clients
 * @param {object} post - record post
 * @param {string} aspectRatio - es. '1:1', '9:16'
 * @param {object} [opts]
 * @param {boolean} [opts.consumeRotation=true] - se true, persiste l'indice dello
 *   stile usato (last_visual_style_index) così la prossima chiamata pesca uno
 *   stile diverso. Passare false per preview senza consumare la rotazione.
 */
async function buildPrompt(client, post, aspectRatio, opts = {}) {
  const consumeRotation = opts.consumeRotation !== false;

  // 1. Rotazione stile visivo: scelgo uno stile diverso dall'ultimo usato.
  const styles = parseVisualStyles(client.visual_styles);
  const lastIdx = (typeof client.last_visual_style_index === 'number') ? client.last_visual_style_index : -1;
  const chosenIdx = pickNextStyleIndex(styles, lastIdx);
  const chosenStyle = styles[chosenIdx];

  if (consumeRotation && client.id) {
    try {
      getDb().prepare('UPDATE clients SET last_visual_style_index = ? WHERE id = ?')
        .run(chosenIdx, client.id);
    } catch (e) {
      console.warn('[visual-prompt] update last_visual_style_index failed:', e.message);
    }
  }

  // 2. Seed di variazione random: forza diversità anche all'interno dello stesso stile
  const angle = pickRandom(VARIATION_ANGLES);
  const mood = pickRandom(VARIATION_MOODS);
  const lighting = pickRandom(VARIATION_LIGHTING);

  // 3. Costruisci userPrompt con TUTTO il contesto disponibile
  const parts = [];
  if (client.brand_name)   parts.push(`brand="${client.brand_name}"`);
  if (client.sector)       parts.push(`settore="${client.sector}"`);
  if (client.location)     parts.push(`località="${client.location}"`);
  if (client.tagline)      parts.push(`tagline="${client.tagline}"`);

  const brandColors = parseBrandColors(client.brand_colors);
  if (brandColors.length) parts.push(`brand_colors=${brandColors.join(',')}`);

  if (post.category)       parts.push(`categoria="${post.category}"`);
  if (post.sub_topic)      parts.push(`tema="${post.sub_topic}"`);

  const captionLine = (post.caption || '').replace(/\s+/g, ' ').trim().substring(0, 400);
  if (captionLine) parts.push(`caption="${captionLine}"`);

  parts.push(`STYLE_DIRECTIVE="${chosenStyle}"`);
  parts.push(`VARIATION="angle=${angle}, mood=${mood}, lighting=${lighting}"`);
  parts.push(`aspect=${aspectRatio || '1:1'}`);

  const userPrompt = parts.join(', ');

  const apiKey = getEffectiveGeminiKey(client);
  if (!apiKey) {
    return _fallbackPrompt(client, post, aspectRatio, chosenStyle, { angle, mood, lighting });
  }

  try {
    const { text } = await callGemini(apiKey, SYSTEM_INSTRUCTION, userPrompt, {
      // Temperature più alta (0.85) per varianza maggiore: con prompt arricchito
      // di style + variation, vogliamo che il modello "esplori" più liberamente.
      temperature: 0.85,
      maxTokens: 500
    });
    const cleaned = (text || '').replace(/^["'`]|["'`]$/g, '').trim();
    return cleaned || _fallbackPrompt(client, post, aspectRatio, chosenStyle, { angle, mood, lighting });
  } catch (err) {
    console.warn('[visual-prompt] callGemini failed, using fallback:', err.message);
    return _fallbackPrompt(client, post, aspectRatio, chosenStyle, { angle, mood, lighting });
  }
}

function _fallbackPrompt(client, post, aspectRatio, style, variation) {
  const subject = post.sub_topic || post.category || client.brand_name || 'product';
  const sector = client.sector || 'lifestyle';
  const ratioWord = aspectRatio === '9:16' ? 'vertical 9:16' :
                    aspectRatio === '16:9' ? 'horizontal 16:9' :
                    aspectRatio === '4:5'  ? 'vertical 4:5' :
                    'square 1:1';
  // Se chiamato con style/variation, li includiamo nel prompt deterministico
  // per mantenere comunque la diversità anche senza AI.
  const styleStr = style ? style : `professional editorial ${sector} photography, natural soft light, shallow depth of field, photorealistic, high detail`;
  const varStr = variation
    ? `${variation.angle}, ${variation.mood} mood, ${variation.lighting}`
    : 'medium shot, warm and inviting mood, natural daylight';
  const brandColors = parseBrandColors(client.brand_colors);
  const colorStr = brandColors.length ? `, color palette featuring ${brandColors.slice(0, 3).join(' and ')}` : '';
  return `${styleStr}, ${varStr}, of ${subject} in a ${sector} setting${colorStr}, ${ratioWord} composition, no text, no typography, no watermark.`;
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
  const apiKey = getEffectiveGeminiKey(client);

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
  const apiKey = getEffectiveGeminiKey(client);
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

// Avanza manualmente la rotazione degli stili. Usato da /generate-ai-image
// quando l'utente passa un prompt override (in quel caso buildPrompt non
// viene chiamato e la rotazione resterebbe ferma).
function advanceStyleRotation(client) {
  if (!client || !client.id) return;
  const styles = parseVisualStyles(client.visual_styles);
  const lastIdx = (typeof client.last_visual_style_index === 'number') ? client.last_visual_style_index : -1;
  const nextIdx = pickNextStyleIndex(styles, lastIdx);
  try {
    getDb().prepare('UPDATE clients SET last_visual_style_index = ? WHERE id = ?').run(nextIdx, client.id);
  } catch (e) {
    console.warn('[visual-prompt] advance rotation failed:', e.message);
  }
}

module.exports = {
  buildPrompt,
  buildVariationPrompts,
  buildVideoPrompt,
  advanceStyleRotation,
  DEFAULT_VISUAL_STYLES
};
