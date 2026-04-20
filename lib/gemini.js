const https = require('https');
const { getGeminiKey } = require('./settings');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_RETRIES = 5;

function _doGeminiRequest(key, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${GEMINI_URL}?key=${key}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ json, status: res.statusCode });
        } catch (e) {
          reject(new Error('Failed to parse Gemini response'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callGemini(apiKey, systemInstruction, userPrompt, options = {}) {
  const key = apiKey || getGeminiKey();
  if (!key) throw new Error('No Gemini API key configured');

  const body = JSON.stringify({
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [{
      role: 'user',
      parts: [{ text: userPrompt }]
    }],
    generationConfig: {
      temperature: options.temperature || 0.8,
      maxOutputTokens: options.maxTokens || 1024,
      thinkingConfig: { thinkingBudget: 0 }
    }
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { json, status } = await _doGeminiRequest(key, body);

    if (json.error) {
      const msg = json.error.message || 'Gemini API error';
      const lower = msg.toLowerCase();

      // Retry: 429 quota, 503 overload, 500 internal, network timeouts
      const isQuota    = status === 429 || lower.includes('quota exceeded') || lower.includes('rate limit');
      const isOverload = status === 503 || lower.includes('high demand') || lower.includes('overloaded') || lower.includes('unavailable');
      const isServerErr = status === 500 || lower.includes('internal error');

      if (isQuota || isOverload || isServerErr) {
        // Per 429 Meta suggerisce il wait esatto. Per 503/500 aspettiamo meno (errori transienti).
        let waitSec;
        if (isQuota) {
          const waitMatch = msg.match(/retry in ([\d.]+)s/i);
          waitSec = waitMatch ? Math.ceil(parseFloat(waitMatch[1])) + 2 : 30;
        } else {
          // Backoff esponenziale per 503/500: 5, 10, 20, 40, 80s (cap 90s)
          waitSec = Math.min(90, Math.pow(2, attempt) * 2.5);
        }

        if (attempt < MAX_RETRIES) {
          const reason = isQuota ? 'quota' : isOverload ? 'sovraccarico modello' : 'errore server';
          console.warn(`[gemini] ${reason}, tentativo ${attempt}/${MAX_RETRIES} — attesa ${Math.ceil(waitSec)}s... (msg="${msg.substring(0, 100)}")`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
      }

      // Dopo esaurito retry, arricchisci il messaggio con consiglio utente-friendly
      if (isOverload) {
        throw new Error('Gemini in sovraccarico (free tier saturo). Riprova tra 5-10 minuti, oppure attiva il piano a pagamento Gemini ($1-2/mese per bypassare il limite).');
      }
      throw new Error(msg);
    }

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { text, raw: json };
  }
}

async function generateCaption(client, post) {
  const systemInstruction = client.system_instruction || buildDefaultSystemInstruction(client);
  const userPrompt = `Scrivi un post Facebook/Instagram per ${client.display_name} a ${client.location || ''}.
Sito: ${client.website || ''}

Categoria: ${post.category || ''}
Sotto-tema: ${post.sub_topic || ''}

REGOLE DI FORMATTAZIONE:
- Usa **grassetto** per enfatizzare parole chiave o piccole sezioni (sarà automaticamente convertito in caratteri Unicode bold che FB e Instagram renderizzano come grassetto nativo)
- Usa *corsivo* per citazioni o tono sommesso
- Per elenchi puntati usa "- voce" o "* voce" all'inizio riga (verranno convertiti in "• voce")
- NON usare # per titoli (usa invece **Titolo** che è più naturale nel flusso di un post social)
- Gli hashtag vanno SOLO alla fine del post (es. #BrandName #Settore), non in mezzo al testo e senza grassetto
- Mantieni il testo fluido e leggibile: usa il grassetto con parsimonia, max 2-3 occorrenze per post

Scrivi il post seguendo le linee guida del system instruction.`;

  const result = await callGemini(client.gemini_api_key, systemInstruction, userPrompt);
  return { ...result, text: stripMarkdown(result.text) };
}

// Converte i marker markdown in caratteri Unicode stilizzati (Mathematical
// Sans-Serif Bold / Italic). FB e Instagram NON supportano markdown ma
// renderizzano nativamente i caratteri Unicode di queste tabelle — è il
// trick standard dei tool di styling social (tipo yaytext / boldify).
// - **x** → 𝗫 (Mathematical Sans-Serif Bold)
// - *x* inline → 𝘅 (Mathematical Sans-Serif Italic)
// - __x__ → 𝗫 (trattato come bold)
// - *   item (inizio riga) → • item
// - -   item (inizio riga) → • item
// - # Titolo (inizio riga) → 𝗧𝗶𝘁𝗼𝗹𝗼 (bold)
function toUnicodeBold(s) {
  return s.replace(/[A-Za-z0-9]/g, c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90)  return String.fromCodePoint(0x1D5D4 + code - 65);   // A-Z
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + code - 97);   // a-z
    if (code >= 48 && code <= 57)  return String.fromCodePoint(0x1D7EC + code - 48);   // 0-9
    return c;
  });
}
function toUnicodeItalic(s) {
  return s.replace(/[A-Za-z]/g, c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90)  return String.fromCodePoint(0x1D608 + code - 65);
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D622 + code - 97);
    return c;
  });
}
function mdToSocialUnicode(s) {
  if (!s) return s;
  let out = s;
  // Header # Title → bold
  out = out.replace(/^#{1,6}\s+(.+)$/gm, (_, t) => toUnicodeBold(t));
  // Grassetto **x** e __x__
  out = out.replace(/\*\*([^\n*]+?)\*\*/g, (_, t) => toUnicodeBold(t));
  out = out.replace(/__([^\n_]+?)__/g,     (_, t) => toUnicodeBold(t));
  // Bullet list: gestisci PRIMA degli italici per non consumare gli asterischi
  out = out.replace(/^\s*[*-]\s{2,}/gm, '• ');
  out = out.replace(/^\s*[*-]\s(?=\S)/gm, '• ');
  // Corsivo *x* inline (dopo aver gestito bullet list)
  out = out.replace(/(?<=\s|^)\*([^\s*][^*\n]*?[^\s*])\*(?=\s|[.,;:!?)]|$)/g, (_, t) => toUnicodeItalic(t));
  return out;
}
// Alias kept for backwards compat
const stripMarkdown = mdToSocialUnicode;

async function generateEditorialPlan(client, questionnaireResponses, months = 6, postsPerMonth = 8) {
  const perWeek = (postsPerMonth / 4).toFixed(postsPerMonth % 4 === 0 ? 0 : 1);
  const systemInstruction = `Sei un esperto social media strategist italiano. Devi creare un piano editoriale dettagliato per ${client.display_name}, un'attività nel settore ${client.sector || 'generico'} a ${client.location || 'Italia'}.

Il piano deve coprire ${months} mesi di contenuti con:
- ${postsPerMonth} post al mese (~${perWeek} a settimana, distribuisci sui giorni infrasettimanali più adatti al settore)
- Categorie di contenuto rotanti
- Sub-topic specifici per ogni post
- TIPO DI CONTENUTO (media_type) suggerito per ogni post in base al messaggio:
  * "single_image" — una sola immagine + caption (default per: post statici, citazioni, annunci singoli, recensioni, novità rapide)
  * "carousel" — 2-10 immagini sequenziali (per: presentazione di più servizi, prima/dopo, mini-guide step-by-step, gallerie prodotti, raccolte di recensioni)
  * "reel" — video verticale 9:16, durata 3-90s (per: dietro le quinte, processi produttivi, anteprime eventi, brevi storie del brand, tutorial veloci)
  * "story" — contenuto effimero 24h (per: sondaggi, urgenze, momenti quotidiani veloci, anteprime di un Reel — verrà pubblicato MANUALMENTE dal cliente dalla sua app, NOI lo SUGGERIAMO solamente)
- Template grafico (template) suggerito SOLO per i post di tipo single_image: una di "service", "quote", "event", "floral", "advice"
- Tono e stile coerenti con il brand

DISTRIBUZIONE CONSIGLIATA mensile (su ${postsPerMonth} post):
- ~${Math.round(postsPerMonth * 0.55)} single_image (statici, pubblicabili automaticamente)
- ~${Math.max(1, Math.round(postsPerMonth * 0.18))} carousel (approfondimenti)
- ~${Math.max(1, Math.round(postsPerMonth * 0.18))} reel (momenti dinamici)
- 0-2 story extra (oltre agli ${postsPerMonth}, suggerite come task per il cliente)

FORMATO OUTPUT (JSON):
{
  "title": "Piano Editoriale - [Nome Cliente]",
  "categories": [
    { "code": "C1", "name": "...", "frequency": "1-2/mese", "description": "..." }
  ],
  "months": [
    {
      "month_number": 1,
      "weeks": [
        {
          "week_number": 1,
          "posts": [
            {
              "day": "martedì",
              "time": "10:00",
              "category": "C1",
              "sub_topic": "...",
              "media_type": "carousel",
              "template": "service",
              "notes": "..."
            }
          ]
        }
      ]
    }
  ]
}

Rispondi SOLO con il JSON, senza blocchi di codice o spiegazioni.`;

  const responses = typeof questionnaireResponses === 'string'
    ? questionnaireResponses
    : JSON.stringify(questionnaireResponses, null, 2);

  const userPrompt = `Ecco le risposte al questionario del cliente:

${responses}

Genera il piano editoriale completo per ${months} mesi (${postsPerMonth} post al mese) basandoti su queste informazioni.`;

  const result = await callGemini(
    client.gemini_api_key,
    systemInstruction,
    userPrompt,
    // 8192 era troppo poco per piani lunghi → JSON troncato. Gemini 2.5 supporta
    // fino a 65k token output: 32768 lascia ampio margine.
    { maxTokens: 32768, temperature: 0.7 }
  );

  // Try to parse JSON from the response
  let planData = null;
  try {
    // Remove markdown code fences if present
    let text = result.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    planData = JSON.parse(text);
  } catch {
    // Return raw text if JSON parsing fails
    planData = null;
  }

  return { planData, raw: result.text };
}

function buildDefaultSystemInstruction(client) {
  return `Sei il social media manager di ${client.display_name || client.brand_name || client.id}.
Settore: ${client.sector || 'generico'}
Località: ${client.location || 'Italia'}
Sito: ${client.website || 'N/A'}

TONO E STILE:
- Scrivi in italiano corretto
- Tono: professionale ma accessibile
- Registro: informale (tu)
- Usa al massimo 1-2 emoji per post
- Frasi brevi e chiare, 2-4 frasi per il corpo del post

STRUTTURA POST:
- Corpo: 2-4 frasi coinvolgenti
- Una riga vuota, poi una call-to-action
- Una riga vuota, poi 5-8 hashtag
- Rispondi SOLO con il testo del post`;
}

module.exports = { callGemini, generateCaption, generateEditorialPlan };
