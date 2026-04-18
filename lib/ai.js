const https = require('https');

const DEFAULT_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = 'claude-opus-4-6';

function callClaude(apiKey, systemInstruction, userPrompt, options = {}) {
  const key = apiKey || DEFAULT_ANTHROPIC_KEY;
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

async function generateCaption(client, post) {
  const systemInstruction = client.system_instruction || buildDefaultSystemInstruction(client);
  const userPrompt = `Scrivi un post Facebook/Instagram per ${client.display_name} a ${client.location || ''}.
Sito: ${client.website || ''}

Categoria: ${post.category || ''}
Sotto-tema: ${post.sub_topic || ''}

Scrivi il post seguendo le linee guida del system instruction.`;

  return callClaude(client.anthropic_api_key, systemInstruction, userPrompt);
}

async function generateEditorialPlan(client, questionnaireResponses) {
  const systemInstruction = `Sei un esperto social media strategist italiano. Devi creare un piano editoriale dettagliato per ${client.display_name}, un'attività nel settore ${client.sector || 'generico'} a ${client.location || 'Italia'}.

Il piano deve coprire 5 mesi di contenuti con:
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

Genera il piano editoriale completo per 5 mesi basandoti su queste informazioni.`;

  const result = await callClaude(
    client.anthropic_api_key,
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

module.exports = { callClaude, generateCaption, generateEditorialPlan };
