const https = require('https');
const { getGeminiKey, getEffectiveGeminiKey } = require('./settings');

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

// Normalizza il sito in formato https://www.dominio.tld per l'inserimento nei post.
// Il prompt AI chiede di incollare QUESTO valore invariato, senza etichette tipo
// "Link al sito:" né varianti senza protocollo/www.
function normalizeWebsite(url) {
  if (!url) return '';
  let s = String(url).trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^\/\//, '');
  s = s.replace(/\/+$/, '');
  if (!/^www\./i.test(s)) s = 'www.' + s;
  return 'https://' + s;
}

async function generateCaption(client, post) {
  const systemInstruction = client.system_instruction || buildDefaultSystemInstruction(client);
  const siteUrl = normalizeWebsite(client.website);
  const userPrompt = `Scrivi un post Facebook/Instagram per ${client.display_name} a ${client.location || ''}.
${siteUrl ? `Sito ufficiale (URL COMPLETO da usare esattamente così): ${siteUrl}` : ''}

Categoria: ${post.category || ''}
Sotto-tema: ${post.sub_topic || ''}

REGOLE DI OUTPUT (FONDAMENTALI):
- Rispondi SOLO con il testo del post, senza alcun preambolo, introduzione o commento.
- NON iniziare con frasi tipo "Ecco...", "Ecco una proposta...", "Ecco un post...", "Certo,...", "Questa è una bozza...". Scrivi DIRETTAMENTE il corpo del post.
- NON aggiungere note finali, spiegazioni, alternative o suggerimenti dopo il post.
${siteUrl ? `- Quando citi il sito web, incolla ESATTAMENTE "${siteUrl}" come URL pieno. NON scrivere "link al sito", "visita il nostro sito:", "scopri di più su:" come etichetta seguita da URL troncato: metti SOLO l'URL completo ${siteUrl} (con https:// e www.), eventualmente integrato in una frase naturale.` : ''}

REGOLE DI FORMATTAZIONE:
- Usa **grassetto** per enfatizzare parole chiave o piccole sezioni (sarà automaticamente convertito in caratteri Unicode bold che FB e Instagram renderizzano come grassetto nativo)
- Usa *corsivo* per citazioni o tono sommesso
- Per elenchi puntati usa "- voce" o "* voce" all'inizio riga (verranno convertiti in "• voce")
- NON usare # per titoli (usa invece **Titolo** che è più naturale nel flusso di un post social)
- Gli hashtag vanno SOLO alla fine del post (es. #BrandName #Settore), non in mezzo al testo e senza grassetto
- Mantieni il testo fluido e leggibile: usa il grassetto con parsimonia, max 2-3 occorrenze per post

Scrivi il post seguendo le linee guida del system instruction.`;

  const result = await callGemini(getEffectiveGeminiKey(client), systemInstruction, userPrompt);
  return { ...result, text: stripPreamble(stripMarkdown(result.text)) };
}

// Safety net lato parser: anche col prompt chiaro, l'AI a volte aggiunge
// "Ecco una proposta..." prima del post. Tagliamo le prime righe se sono
// un preambolo riconoscibile.
function stripPreamble(s) {
  if (!s) return s;
  const preambleRx = /^\s*(ecco|eccoti|certo|certamente|va bene|perfetto|ok)[^\n]*[:\-–—][^\n]*\n+/i;
  let out = s.replace(preambleRx, '');
  // Rimuovi anche un'eventuale riga introduttiva tipo "Ecco una proposta di post:" seguita da blank line
  out = out.replace(/^\s*(ecco|eccoti)[^\n]{0,200}\n\s*\n/i, '');
  return out.trimStart();
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

async function generateEditorialPlan(client, questionnaireResponses, months = 6, postsPerMonth = 8, startYearMonth = null) {
  const perWeek = (postsPerMonth / 4).toFixed(postsPerMonth % 4 === 0 ? 0 : 1);
  const { resolveCalendarMonth } = require('./month-labels');
  let calendarBlock = '';
  if (startYearMonth) {
    const lines = [];
    for (let i = 1; i <= months; i++) {
      const cal = resolveCalendarMonth(i, startYearMonth);
      if (cal) lines.push(`- Mese ${i} = ${cal.label}`);
    }
    if (lines.length) {
      calendarBlock = `

CALENDARIO MESI (IMPORTANTE — usalo per contenuti stagionali e rilevanti):
${lines.join('\n')}

Per ogni mese pensa a STAGIONE, METEO, FESTIVITÀ e RICORRENZE italiane rilevanti per il settore. Esempi:
- Gennaio: saldi invernali, buoni propositi, post-festività
- Febbraio: San Valentino (14/2), Carnevale (variabile)
- Marzo: festa del papà (19/3), inizio primavera
- Aprile: Pasqua (variabile), 25 Aprile, primavera piena
- Maggio: festa della mamma (2ª dom.), 1 Maggio, sagre
- Giugno: inizio estate, fine scuola, matrimoni
- Luglio: piena estate, vacanze, saldi estivi
- Agosto: Ferragosto (15/8), molte attività in ferie, mood vacanziero
- Settembre: rientro, back-to-school, vendemmia
- Ottobre: foliage, Halloween (31/10), inizio autunno
- Novembre: Black Friday (4ª settimana), Ognissanti (1/11)
- Dicembre: Immacolata (8/12), Natale (25/12), Capodanno, regali

Adatta sub_topic, tono e media_type al periodo. Non tutti i mesi devono parlare di festività, ma cogli le opportunità rilevanti per il settore.`;
    }
  }
  const systemInstruction = `Sei un esperto social media strategist italiano. Devi creare un piano editoriale dettagliato per ${client.display_name}, un'attività nel settore ${client.sector || 'generico'} a ${client.location || 'Italia'}.${calendarBlock}

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

  const brandVoice = (client.system_instruction || '').trim();
  const brandBlock = brandVoice
    ? `LINEE GUIDA BRAND (da rispettare su ogni sub_topic, tono, scelta media_type):

${brandVoice}

---

`
    : '';

  const userPrompt = `${brandBlock}Ecco le risposte al questionario del cliente:

${responses}

Genera il piano editoriale completo per ${months} mesi (${postsPerMonth} post al mese) basandoti su queste informazioni${brandVoice ? ' e rispettando rigorosamente le linee guida brand sopra' : ''}.`;

  const result = await callGemini(
    getEffectiveGeminiKey(client),
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
