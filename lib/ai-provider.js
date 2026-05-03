const { callClaude, generateCaption: claudeCaption, generateEditorialPlan: claudePlan } = require('./ai');
const { callGemini, generateCaption: geminiCaption, generateEditorialPlan: geminiPlan } = require('./gemini');
const { getEffectiveGeminiKey } = require('./settings');

function callAI(client, systemInstruction, userPrompt, options = {}) {
  if (client.ai_provider === 'claude') {
    return callClaude(client.anthropic_api_key, systemInstruction, userPrompt, options);
  }
  return callGemini(getEffectiveGeminiKey(client), systemInstruction, userPrompt, options);
}

function generateCaption(client, post) {
  if (client.ai_provider === 'claude') {
    return claudeCaption(client, post);
  }
  return geminiCaption(client, post);
}

// Estrae dalle risposte del questionario il numero di post/mese desiderato.
// La domanda chiave è "Quanti post al mese vorresti?" con opzioni tipo
// "12 post/mese (3 a settimana) — consigliato". Cerchiamo la prima cifra.
function parsePostsPerMonth(responses) {
  if (!responses || typeof responses !== 'object') return null;
  for (const [q, a] of Object.entries(responses)) {
    if (/quanti\s+post\s+al\s+mese/i.test(q)) {
      const ans = Array.isArray(a) ? a.join(' ') : String(a || '');
      const m = ans.match(/(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
  }
  return null;
}

function generateEditorialPlan(client, questionnaireResponses, months = 6, postsPerMonth) {
  // Se non specificato esplicitamente, prova a derivare dalla risposta questionario.
  // Default conservativo: 8 post/mese (2 a settimana) come prima.
  const ppm = postsPerMonth || parsePostsPerMonth(questionnaireResponses) || 8;
  if (client.ai_provider === 'claude') {
    return claudePlan(client, questionnaireResponses, months, ppm);
  }
  return geminiPlan(client, questionnaireResponses, months, ppm);
}

async function generateSystemInstruction(client, questionnaireResponses) {
  // Build context from client profile (scan data is already saved in the client record)
  const profileParts = [];
  if (client.display_name) profileParts.push(`Nome attività: ${client.display_name}`);
  if (client.brand_name) profileParts.push(`Brand: ${client.brand_name}`);
  if (client.sector) profileParts.push(`Settore: ${client.sector}`);
  if (client.location) profileParts.push(`Località: ${client.location}`);
  if (client.website) profileParts.push(`Sito web: ${client.website}`);
  if (client.tagline) profileParts.push(`Tagline: ${client.tagline}`);

  // Build questionnaire context
  let questionnaireBlock = '';
  if (questionnaireResponses && Object.keys(questionnaireResponses).length > 0) {
    const formatted = Object.entries(questionnaireResponses)
      .map(([q, a]) => `- ${q}: ${Array.isArray(a) ? a.join(', ') : a}`)
      .join('\n');
    questionnaireBlock = `\n\nRISPOSTE QUESTIONARIO DEL CLIENTE:\n${formatted}`;
  }

  const systemPrompt = `Sei un esperto di social media marketing. Il tuo compito è generare un "System Instruction" completo e dettagliato che verrà usato come prompt di sistema per un AI social media manager.

Il system instruction che generi verrà dato a un'AI che dovrà scrivere post per Facebook e Instagram per conto di questa attività. Deve contenere tutte le indicazioni necessarie affinché ogni post generato sia coerente con il brand, il tono, lo stile e gli obiettivi del cliente.`;

  const userPrompt = `Genera un System Instruction personalizzato per il social media manager AI di questa attività.

PROFILO ATTIVITÀ:
${profileParts.length > 0 ? profileParts.join('\n') : 'Nessun dato profilo disponibile'}${questionnaireBlock}

Il System Instruction che generi deve includere queste sezioni:

1. **IDENTITÀ**: Chi è l'attività, cosa fa, dove si trova, qual è la sua missione
2. **TONO E STILE**: Come deve parlare (formale/informale, registro tu/voi/Lei, aggettivi che descrivono il brand)
3. **TARGET**: A chi ci rivolgiamo (fascia d'età, tipo di clientela, area geografica)
4. **OBIETTIVI**: Cosa vogliamo ottenere con i social (visibilità, nuovi clienti, fidelizzazione, etc.)
5. **CONTENUTI**: Tipi di contenuto preferiti, temi ricorrenti, categorie
6. **RESTRIZIONI**: Cosa NON fare, argomenti da evitare, limiti
7. **STRUTTURA POST**: Come deve essere strutturato ogni post (corpo, CTA, hashtag, emoji)

REGOLE:
- Scrivi in italiano corretto
- Scrivi il system instruction in seconda persona ("Sei il social media manager di...")
- Sii specifico e dettagliato, non generico
- Se non hai informazioni su un aspetto, usa valori ragionevoli basati sul settore
- NON usare blocchi di codice o markdown — scrivi testo libero formattato con elenchi puntati
- Il risultato deve essere direttamente utilizzabile come prompt di sistema`;

  const result = await callAI(client, systemPrompt, userPrompt, {
    temperature: 0.7,
    maxTokens: 2048
  });

  return result.text;
}

async function generateThemeCSS(client, brandColors) {
  const systemPrompt = `Sei un designer esperto di UI/UX con specializzazione in dark themes per social media. Il tuo compito è generare un tema CSS coerente basato sui colori del brand forniti. Rispondi SOLO con il blocco CSS :root { ... }, senza blocchi di codice markdown, senza spiegazioni.`;

  const userPrompt = `Genera un tema CSS dark per le immagini social di un brand.

Colori del brand: ${brandColors.join(', ')}

Devi generare ESATTAMENTE queste 17 variabili CSS in un blocco :root { }:

BACKGROUNDS (derivati dai colori brand, sempre scuri):
- --bg-deep: il colore di sfondo più scuro (quasi nero, con una leggera tinta dal brand)
- --bg-primary: sfondo principale (leggermente più chiaro di bg-deep)
- --bg-card: sfondo dei riquadri (un po' più chiaro di bg-primary)
- --bg-elevated: sfondo elementi in rilievo (il più chiaro dei bg, ma ancora scuro)

ACCENTS (derivati dai colori principali del brand):
- --accent: colore accent principale (dal colore brand dominante)
- --accent-light: versione più chiara dell'accent
- --accent-silver: versione argentata/desaturata dell'accent
- --accent-bright: versione brillante/luminosa dell'accent

TESTI (devono essere leggibili sugli sfondi scuri):
- --text-primary: testo principale (quasi bianco)
- --text-light: testo secondario (grigio chiaro)
- --text-medium: testo terziario (grigio medio)
- --text-muted: testo poco evidente (grigio scuro)

BORDI (usa rgba con il colore accent):
- --border-cool: bordo sottile (rgba con alpha 0.15)
- --border-elevated: bordo più visibile (rgba con alpha 0.25)

EFFETTI (usa rgba):
- --glass-bg: sfondo glassmorphism (rgba del bg-primary con alpha 0.75)
- --overlay-top: overlay superiore (rgba scuro con alpha 0.4)
- --overlay-bottom: overlay inferiore (rgba scuro con alpha 0.95)

REGOLE IMPORTANTI:
- I backgrounds devono essere SEMPRE scuri (luminosità < 20%)
- Gli accent devono riflettere i colori del brand
- Il contrasto testo/sfondo deve essere sufficiente per la leggibilità
- I bordi devono usare formato rgba()
- Rispondi SOLO con il CSS, nient'altro: :root { ... }`;

  const result = await callAI(client, systemPrompt, userPrompt, {
    temperature: 0.5,
    maxTokens: 1024
  });

  let css = result.text.trim();
  // Strip markdown code fences if present
  if (css.startsWith('```')) {
    css = css.replace(/^```(?:css)?\n?/, '').replace(/\n?```$/, '');
  }

  // Validate it contains :root
  if (!css.includes(':root')) {
    throw new Error('AI non ha generato un tema CSS valido');
  }

  return css;
}

/**
 * Rigenera SOLO i post di una specifica categoria di un piano editoriale esistente,
 * mantenendo intatta la struttura del piano (mesi/settimane). Usata dall'editor
 * categorie quando l'utente cambia frequenza/descrizione e vuole aggiornare i post
 * senza rigenerare l'intero piano.
 */
async function generateCategoryPosts(client, planData, category, options = {}) {
  const months = (planData.months || []).length;
  const desiredCount = options.targetCount || estimatePostsForCategory(category, months);

  const systemInstruction = `Sei un esperto social media strategist italiano. Devi generare un set mirato di post per una SPECIFICA categoria del piano editoriale di ${client.display_name} (settore: ${client.sector || 'generico'}, location: ${client.location || 'Italia'}).

Per ogni post devi specificare:
- "month_number" (intero da 1 a ${months})
- "week_number" (intero, di solito 1-4)
- "day" (es. "martedì", "giovedì")
- "time" (es. "10:00", "18:30")
- "category" (DEVE essere "${category.code}")
- "sub_topic" (specifico, non generico)
- "media_type" (uno di: "single_image", "carousel", "reel", "story")
- "template" (solo per single_image: una di "service", "quote", "event", "floral", "advice")
- "notes" (opzionale)

Distribuisci i post nei ${months} mesi in modo coerente con la frequenza "${category.frequency || 'media'}".

Rispondi SOLO con un array JSON, senza commenti né blocchi di codice. Esempio:
[
  { "month_number": 1, "week_number": 1, "day": "martedì", "time": "10:00", "category": "${category.code}", "sub_topic": "...", "media_type": "single_image", "template": "quote", "notes": "..." }
]`;

  const userPrompt = `CATEGORIA DA RIGENERARE:
- Codice: ${category.code}
- Nome: ${category.name}
- Frequenza target: ${category.frequency || 'non specificata'}
- Descrizione: ${category.description || 'nessuna'}

NUMERO POST DA GENERARE: ${desiredCount}
MESI DEL PIANO: ${months}

Genera l'array JSON dei post.`;

  const result = await callAI(client, systemInstruction, userPrompt, {
    temperature: 0.7,
    maxTokens: 4096
  });

  let text = result.text.trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let posts;
  try {
    posts = JSON.parse(text);
    if (!Array.isArray(posts)) throw new Error('Risposta AI non è un array');
  } catch (err) {
    throw new Error('AI ha risposto con JSON non valido: ' + err.message);
  }
  // Forza category code coerente
  posts.forEach(p => { p.category = category.code; });
  return { posts, raw: result.text };
}

// Heuristic: traduce frequency string in numero di post nel piano completo
function estimatePostsForCategory(category, months) {
  const f = (category.frequency || '').toLowerCase();
  // Pattern comuni: "1/mese", "2/mese", "1-2/mese", "settimanale", "ogni 2 settimane"
  let perMonth = 1;
  const m1 = f.match(/(\d+)\s*[-\/]\s*(\d+)\s*\/\s*mese/);
  const m2 = f.match(/(\d+)\s*\/\s*mese/);
  if (m1) perMonth = (parseInt(m1[1]) + parseInt(m1[2])) / 2;
  else if (m2) perMonth = parseInt(m2[1]);
  else if (/settimanale/.test(f)) perMonth = 4;
  else if (/quindicinale|ogni 2 settimane/.test(f)) perMonth = 2;
  return Math.max(1, Math.round(perMonth * months));
}

module.exports = { callAI, generateCaption, generateEditorialPlan, generateSystemInstruction, generateThemeCSS, generateCategoryPosts, parsePostsPerMonth };
