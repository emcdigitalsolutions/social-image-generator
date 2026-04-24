const https = require('https');
const { getAnthropicKey } = require('./settings');

const CLAUDE_MODEL = 'claude-opus-4-6';

function callClaude(apiKey, systemInstruction, userPrompt, options = {}) {
  const key = apiKey || getAnthropicKey();
  if (!key) return Promise.reject(new Error('No Anthropic API key configured'));

  const body = JSON.stringify({
    model: CLAUDE_MODEL,
    system: systemInstruction,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: options.maxTokens || 1024,
    temperature: options.temperature || 0.8
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message || 'Claude API error'));
            return;
          }
          const text = json.content?.[0]?.text || '';
          resolve({ text, raw: json });
        } catch (e) {
          reject(new Error('Failed to parse Claude response'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function normalizeWebsite(url) {
  if (!url) return '';
  let s = String(url).trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^\/\//, '');
  s = s.replace(/\/+$/, '');
  if (!/^www\./i.test(s)) s = 'www.' + s;
  return 'https://' + s;
}

function stripPreamble(s) {
  if (!s) return s;
  const preambleRx = /^\s*(ecco|eccoti|certo|certamente|va bene|perfetto|ok)[^\n]*[:\-–—][^\n]*\n+/i;
  let out = s.replace(preambleRx, '');
  out = out.replace(/^\s*(ecco|eccoti)[^\n]{0,200}\n\s*\n/i, '');
  return out.trimStart();
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

  const result = await callClaude(client.anthropic_api_key, systemInstruction, userPrompt);
  return { ...result, text: stripPreamble(stripMarkdown(result.text)) };
}

// Converte markdown → Unicode Mathematical Bold/Italic (FB/IG renderizzano
// questi caratteri come grassetto/corsivo nativi, trick standard del settore).
function toUnicodeBold(s) {
  return s.replace(/[A-Za-z0-9]/g, c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90)  return String.fromCodePoint(0x1D5D4 + code - 65);
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + code - 97);
    if (code >= 48 && code <= 57)  return String.fromCodePoint(0x1D7EC + code - 48);
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
  out = out.replace(/^#{1,6}\s+(.+)$/gm, (_, t) => toUnicodeBold(t));
  out = out.replace(/\*\*([^\n*]+?)\*\*/g, (_, t) => toUnicodeBold(t));
  out = out.replace(/__([^\n_]+?)__/g,     (_, t) => toUnicodeBold(t));
  out = out.replace(/^\s*[*-]\s{2,}/gm, '• ');
  out = out.replace(/^\s*[*-]\s(?=\S)/gm, '• ');
  out = out.replace(/(?<=\s|^)\*([^\s*][^*\n]*?[^\s*])\*(?=\s|[.,;:!?)]|$)/g, (_, t) => toUnicodeItalic(t));
  return out;
}
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

  const result = await callClaude(
    client.anthropic_api_key,
    systemInstruction,
    userPrompt,
    // 8192 era troppo poco: per 6 mesi × 8 post = 48 entry il JSON viene troncato
    // a metà generazione. 16384 lascia margine per piani fino a ~12 mesi.
    { maxTokens: 16384, temperature: 0.7 }
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

module.exports = {
  callClaude, generateCaption, generateEditorialPlan,
  // Esposte per test
  toUnicodeBold, toUnicodeItalic, mdToSocialUnicode, stripMarkdown
};
