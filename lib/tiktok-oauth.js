/**
 * tiktok-oauth.js — flusso OAuth Authorization Code per ottenere i token TikTok
 * di un cliente (access + refresh) senza incollarli a mano.
 *
 * Flusso:
 *   1. /dashboard/tiktok/connect/:clientId redirige l'admin all'authorize URL.
 *   2. TikTok torna su /dashboard/tiktok/callback?code=...&state=...
 *   3. exchangeCodeForToken() scambia il code con access+refresh token, che
 *      vengono salvati sul cliente.
 *
 * Doc: https://developers.tiktok.com/doc/login-kit-web
 * Auth host: open.tiktokapis.com (token), www.tiktok.com (authorize).
 */
'use strict';

const https = require('https');

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_HOST = 'open.tiktokapis.com';
// Scope minimo per Direct Post (creator_info + publish). user.info.basic dà anche
// username/avatar mostrati nel creator_info.
const DEFAULT_SCOPE = 'user.info.basic,video.publish';

/**
 * Costruisce l'authorize URL. Funzione PURA (testabile).
 * @param {{clientKey, redirectUri, state, scope?}} opts
 */
function buildAuthorizeUrl({ clientKey, redirectUri, state, scope = DEFAULT_SCOPE }) {
  const qs = new URLSearchParams({
    client_key: clientKey,
    scope,
    response_type: 'code',
    redirect_uri: redirectUri,
    state
  });
  return `${AUTHORIZE_URL}?${qs.toString()}`;
}

// POST x-www-form-urlencoded all'endpoint OAuth, ritorna JSON piatto.
function oauthPost(params) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path: '/v2/oauth/token/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`TikTok OAuth: risposta non-JSON: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Scambia l'authorization code con i token. Ritorna un oggetto normalizzato
 * pronto per essere salvato sul cliente, con i timestamp ISO di scadenza.
 * @returns {{access_token, refresh_token, open_id, scope, token_expires_at, refresh_expires_at}}
 */
async function exchangeCodeForToken({ clientKey, clientSecret, code, redirectUri }) {
  const r = await oauthPost({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  if (r.error || !r.access_token) {
    throw new Error(r.error_description || r.error || 'nessun access_token nella risposta');
  }
  const now = Date.now();
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token || null,
    open_id: r.open_id || null,
    scope: r.scope || null,
    token_expires_at: new Date(now + (Number(r.expires_in) || 86400) * 1000).toISOString(),
    refresh_expires_at: new Date(now + (Number(r.refresh_expires_in) || 365 * 86400) * 1000).toISOString()
  };
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  AUTHORIZE_URL,
  DEFAULT_SCOPE
};
