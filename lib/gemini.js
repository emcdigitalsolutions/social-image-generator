const https = require('https');
const { getGeminiKey } = require('./settings');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_RETRIES = 3;

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

      // Check for rate limit / quota exceeded — retry with wait
      if (status === 429 || msg.includes('Quota exceeded') || msg.includes('rate limit')) {
        const waitMatch = msg.match(/retry in ([\d.]+)s/i);
        const waitSec = waitMatch ? Math.ceil(parseFloat(waitMatch[1])) + 2 : 30;

        if (attempt < MAX_RETRIES) {
          console.warn(`[gemini] Quota exceeded, tentativo ${attempt}/${MAX_RETRIES} — attesa ${waitSec}s...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
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

Scrivi il post seguendo le linee guida del system instruction.`;

  return callGemini(client.gemini_api_key, systemInstruction, userPrompt);
}

async function generateEditorialPlan(client, questionnaireResponses, months = 6) {
  const systemInstruction = `Sei un esperto social media strategist italiano. Devi creare un piano editoriale dettagliato per ${client.display_name}, un'attività nel settore ${client.sector || 'generico'} a ${client.location || 'Italia'}.

Il piano deve coprire ${months} mesi di contenuti con:
- 8 post al mese (2 a settimana: martedì e giovedì)
- Categorie di contenuto rotanti
- Sub-topic specifici per ogni post
- Template suggerito per ogni post (service, quote, event, floral)
- Tono e stile coerenti con il brand

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

Genera il piano editoriale completo per ${months} mesi basandoti su queste informazioni.`;

  const result = await callGemini(
    client.gemini_api_key,
    systemInstruction,
    userPrompt,
    { maxTokens: 8192, temperature: 0.7 }
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
