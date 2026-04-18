const { callClaude, generateCaption: claudeCaption, generateEditorialPlan: claudePlan } = require('./ai');
const { callGemini, generateCaption: geminiCaption, generateEditorialPlan: geminiPlan } = require('./gemini');

function callAI(client, systemInstruction, userPrompt, options = {}) {
  if (client.ai_provider === 'claude') {
    return callClaude(client.anthropic_api_key, systemInstruction, userPrompt, options);
  }
  return callGemini(client.gemini_api_key, systemInstruction, userPrompt, options);
}

function generateCaption(client, post) {
  if (client.ai_provider === 'claude') {
    return claudeCaption(client, post);
  }
  return geminiCaption(client, post);
}

function generateEditorialPlan(client, questionnaireResponses) {
  if (client.ai_provider === 'claude') {
    return claudePlan(client, questionnaireResponses);
  }
  return geminiPlan(client, questionnaireResponses);
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

module.exports = { callAI, generateCaption, generateEditorialPlan, generateSystemInstruction };
