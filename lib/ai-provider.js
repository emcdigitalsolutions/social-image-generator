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

module.exports = { callAI, generateCaption, generateEditorialPlan };
