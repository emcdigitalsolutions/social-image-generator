/**
 * insights.js — fetch Meta Insights per post pubblicati (FB + IG).
 * Riusa l'infra Graph API del meta-publish.js (Page Token derivato dal
 * system user EMC, stesso host graph.facebook.com per entrambi).
 */
'use strict';

const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');

const GRAPH_API_VERSION = 'v25.0';
const FB_HOST = 'graph.facebook.com';

// Mappa metrica Meta → campo interno per FB post (Page feed + Reels).
// Nota: una chiamata batch con più metriche fallisce completamente se anche
// UNA sola è invalida per quel tipo di media (errore #100). Per questo
// fetchiamo ogni metrica come call separata: isoliamo gli errori e mostriamo
// comunque i dati disponibili.
const FB_METRIC_MAP = {
  post_impressions:             'impressions',
  post_impressions_unique:      'reach',
  post_clicks:                  'clicks',
  post_reactions_by_type_total: 'likes',
  post_video_views:             'video_views'
};

// IG v22+: 'impressions' e 'video_views' sono stati rimossi, sostituiti da 'views'.
// Gli altri campi restano. Stesso approccio per-metrica.
const IG_METRIC_MAP = {
  views:              'impressions',   // mappa a colonna DB 'impressions' per compat
  reach:              'reach',
  likes:              'likes',
  comments:           'comments',
  shares:             'shares',
  saved:              'saves',
  total_interactions: 'engagement'
};

function httpGet(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${host}: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Parser comune: Meta ritorna data[] con {name, values: [{value}]}
function extractValue(metaData, metricName) {
  const m = (metaData || []).find(x => x.name === metricName);
  if (!m || !m.values || !m.values.length) return null;
  const v = m.values[0].value;
  // Alcune metriche tornano oggetti (es. post_reactions_by_type_total)
  if (typeof v === 'object' && v !== null) {
    return Object.values(v).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  }
  return v;
}

// Fetch per-metrica: isola gli errori #100 (metrica invalida per questo media).
// Ritorna {result, errors, raw}.
async function fetchMetricsIndividually(mediaId, metricMap, pageToken) {
  const result = {};
  const raw = {};
  const errors = [];
  for (const [metric, field] of Object.entries(metricMap)) {
    result[field] = null;
    const path = `/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}/insights?metric=${metric}&access_token=${encodeURIComponent(pageToken)}`;
    try {
      const r = await httpGet(FB_HOST, path);
      if (r.error) {
        // Metrica non applicabile (es. post_clicks su reel) → skip silenzioso
        errors.push({ metric, message: r.error.message });
        continue;
      }
      const v = extractValue(r.data, metric);
      // Se un campo viene già valorizzato da un'altra metrica (non succede con la
      // mappa attuale, ma la safety è barata), non sovrascriviamo un valore
      // numerico con null.
      if (v != null) result[field] = v;
      raw[metric] = r.data;
    } catch (err) {
      errors.push({ metric, message: err.message });
    }
  }
  return { result, raw, errors };
}

async function fetchFbInsights(pageToken, fbPostId) {
  const { result, raw, errors } = await fetchMetricsIndividually(fbPostId, FB_METRIC_MAP, pageToken);
  // Se TUTTE le metriche sono fallite con lo stesso errore (es. media cancellato,
  // token scaduto) consideriamo la chiamata fallita.
  const allSame = errors.length === Object.keys(FB_METRIC_MAP).length
    && new Set(errors.map(e => e.message)).size === 1;
  return {
    ...result,
    raw: { data: raw, errors },
    error: allSame ? errors[0].message : null
  };
}

async function fetchIgInsights(pageToken, igMediaId) {
  const { result, raw, errors } = await fetchMetricsIndividually(igMediaId, IG_METRIC_MAP, pageToken);
  // Campi non presenti nella nuova API IG ma attesi dallo schema DB → null
  result.video_views = null;
  const allSame = errors.length === Object.keys(IG_METRIC_MAP).length
    && new Set(errors.map(e => e.message)).size === 1;
  return {
    ...result,
    raw: { data: raw, errors },
    error: allSame ? errors[0].message : null
  };
}

/**
 * Snapshot degli insights per un singolo post. Lo chiama il cron giornaliero +
 * on-demand via API. Salva SEMPRE una nuova riga (così abbiamo storico).
 */
async function snapshotPostInsights(pageToken, post) {
  const db = getDb();
  const results = [];

  if (post.fb_post_id) {
    const fb = await fetchFbInsights(pageToken, post.fb_post_id);
    const engagement = (fb.likes || 0);
    db.prepare(`
      INSERT INTO post_insights (id, post_id, platform, external_id, impressions, reach, likes, clicks, engagement, raw_json, error)
      VALUES (?, ?, 'fb', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), post.id, post.fb_post_id,
      fb.impressions, fb.reach, fb.likes, fb.clicks, engagement,
      JSON.stringify(fb.raw || null), fb.error || null
    );
    results.push({ platform: 'fb', ...fb });
  }

  if (post.ig_media_id) {
    const ig = await fetchIgInsights(pageToken, post.ig_media_id);
    const engagement = ig.engagement != null ? ig.engagement
      : ((ig.likes || 0) + (ig.comments || 0) + (ig.shares || 0) + (ig.saves || 0));
    db.prepare(`
      INSERT INTO post_insights (id, post_id, platform, external_id, impressions, reach, likes, comments, shares, saves, video_views, engagement, raw_json, error)
      VALUES (?, ?, 'ig', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), post.id, post.ig_media_id,
      ig.impressions, ig.reach, ig.likes, ig.comments, ig.shares, ig.saves, ig.video_views, engagement,
      JSON.stringify(ig.raw || null), ig.error || null
    );
    results.push({ platform: 'ig', ...ig });
  }

  return results;
}

/**
 * Ultimo snapshot per ogni platform di un post — usato dalla UI.
 */
function getLatestInsights(postId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pi1.*
    FROM post_insights pi1
    INNER JOIN (
      SELECT post_id, platform, MAX(fetched_at) AS max_fetched
      FROM post_insights WHERE post_id = ?
      GROUP BY post_id, platform
    ) pi2 ON pi1.post_id = pi2.post_id
        AND pi1.platform = pi2.platform
        AND pi1.fetched_at = pi2.max_fetched
    WHERE pi1.post_id = ?
  `).all(postId, postId);
  return rows;
}

// ─────────────────────── Account-level insights ───────────────────────

// FB account-level: mappa metrica Meta → campo DB. Chiamate per-metrica per
// isolare le invalide (Meta cambia spesso i nomi tra versioni Graph API).
const FB_ACCOUNT_METRIC_MAP = {
  page_impressions:        'impressions',
  page_impressions_unique: 'reach',
  page_views_total:        'profile_views',
  page_post_engagements:   'engaged_users'
};

// IG account-level: alcune metriche v22+ richiedono `metric_type=total_value`
// invece del classico `period=day`. Configurazione per metrica.
const IG_ACCOUNT_METRIC_CONFIG = {
  reach:         { params: 'period=day', field: 'reach',         valueExtractor: 'period' },
  profile_views: { params: 'metric_type=total_value', field: 'profile_views', valueExtractor: 'total_value' }
};

/**
 * Snapshot giornaliero per cliente. Chiamato dal cron una volta al giorno.
 * Usa INSERT OR REPLACE (via UNIQUE (client_id, platform, date)) per essere
 * idempotente se il cron riparte nella stessa giornata.
 *
 * @param pageToken  — Page Access Token (valido anche per IG)
 * @param client     — row del cliente (id, fb_page_id, ig_user_id)
 * @param dateStr    — YYYY-MM-DD (default: oggi UTC)
 */
async function snapshotAccountInsights(pageToken, client, dateStr) {
  const db = getDb();
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const results = [];

  if (client.fb_page_id) {
    const fb = await fetchFbAccountInsights(pageToken, client.fb_page_id);
    db.prepare(`
      INSERT INTO account_insights
        (id, client_id, platform, date, fans, reach, impressions, profile_views, engaged_users, raw_json, error)
      VALUES (?, ?, 'fb', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id, platform, date) DO UPDATE SET
        fans = excluded.fans,
        reach = excluded.reach,
        impressions = excluded.impressions,
        profile_views = excluded.profile_views,
        engaged_users = excluded.engaged_users,
        raw_json = excluded.raw_json,
        error = excluded.error,
        fetched_at = datetime('now')
    `).run(
      uuidv4(), client.id, date,
      fb.fans, fb.reach, fb.impressions, fb.profile_views, fb.engaged_users,
      JSON.stringify(fb.raw || null), fb.error || null
    );
    results.push({ platform: 'fb', ...fb });
  }

  if (client.ig_user_id) {
    const ig = await fetchIgAccountInsights(pageToken, client.ig_user_id);
    db.prepare(`
      INSERT INTO account_insights
        (id, client_id, platform, date, followers, media_count, reach, profile_views, raw_json, error)
      VALUES (?, ?, 'ig', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id, platform, date) DO UPDATE SET
        followers = excluded.followers,
        media_count = excluded.media_count,
        reach = excluded.reach,
        profile_views = excluded.profile_views,
        raw_json = excluded.raw_json,
        error = excluded.error,
        fetched_at = datetime('now')
    `).run(
      uuidv4(), client.id, date,
      ig.followers, ig.media_count, ig.reach, ig.profile_views,
      JSON.stringify(ig.raw || null), ig.error || null
    );
    results.push({ platform: 'ig', ...ig });
  }

  return results;
}

async function fetchFbAccountInsights(pageToken, pageId) {
  const raw = {};
  let error = null;
  const out = { fans: null, reach: null, impressions: null, profile_views: null, engaged_users: null };

  // Snapshot fan_count (non è un insight giornaliero, è il totale corrente)
  try {
    const r = await httpGet(FB_HOST, `/${GRAPH_API_VERSION}/${pageId}?fields=fan_count,followers_count&access_token=${encodeURIComponent(pageToken)}`);
    if (r.error) error = r.error.message;
    else {
      out.fans = r.fan_count != null ? r.fan_count : r.followers_count;
      raw.page = r;
    }
  } catch (err) { error = err.message; }

  // Daily insights: chiamate per-metrica per isolare le invalide. Se una
  // metrica viene deprecata/rinominata, le altre continuano a funzionare.
  raw.insights = {};
  const metricErrors = [];
  for (const [metric, field] of Object.entries(FB_ACCOUNT_METRIC_MAP)) {
    try {
      const r = await httpGet(FB_HOST, `/${GRAPH_API_VERSION}/${pageId}/insights?metric=${metric}&period=day&access_token=${encodeURIComponent(pageToken)}`);
      if (r.error) {
        raw.insights[metric] = { error: r.error.message };
        metricErrors.push(`${metric}: ${r.error.message}`);
        continue;
      }
      raw.insights[metric] = r.data;
      const v = extractValue(r.data, metric);
      if (v != null) out[field] = v;
    } catch (err) {
      raw.insights[metric] = { error: err.message };
      metricErrors.push(`${metric}: ${err.message}`);
    }
  }
  // L'errore principale rimane quello del fan_count se presente; altrimenti
  // riportiamo l'errore solo se TUTTE le metriche giornaliere sono fallite
  // (caso "token scaduto" / "page non più accessibile").
  if (!error && metricErrors.length === Object.keys(FB_ACCOUNT_METRIC_MAP).length) {
    error = metricErrors.join('; ');
  }

  return { ...out, raw, error };
}

async function fetchIgAccountInsights(pageToken, igUserId) {
  const raw = {};
  let error = null;
  const out = { followers: null, media_count: null, reach: null, profile_views: null };

  // Snapshot followers/media_count (totali correnti, non per-day)
  try {
    const r = await httpGet(FB_HOST, `/${GRAPH_API_VERSION}/${igUserId}?fields=followers_count,media_count&access_token=${encodeURIComponent(pageToken)}`);
    if (r.error) error = r.error.message;
    else {
      out.followers = r.followers_count;
      out.media_count = r.media_count;
      raw.account = r;
    }
  } catch (err) { error = err.message; }

  // Daily insights. Ogni metrica può avere parametri diversi (period=day vs
  // metric_type=total_value introdotto in v22). Chiamate separate per isolare
  // gli errori e usare la struttura di parsing corretta per ciascuna.
  raw.insights = {};
  for (const [metric, cfg] of Object.entries(IG_ACCOUNT_METRIC_CONFIG)) {
    try {
      const r = await httpGet(FB_HOST, `/${GRAPH_API_VERSION}/${igUserId}/insights?metric=${metric}&${cfg.params}&access_token=${encodeURIComponent(pageToken)}`);
      if (r.error) {
        raw.insights[metric] = { error: r.error.message };
        continue;
      }
      raw.insights[metric] = r.data;
      // Parsing dipende dal tipo di response:
      //   - period=day  → values: [{value, end_time}]   (extractValue normale)
      //   - total_value → total_value: {value: N}       (struttura piatta)
      let v = null;
      const item = (r.data || []).find(x => x.name === metric);
      if (item) {
        if (cfg.valueExtractor === 'total_value' && item.total_value) {
          v = item.total_value.value != null ? item.total_value.value : null;
        } else {
          v = extractValue(r.data, metric);
        }
      }
      if (v != null) out[cfg.field] = v;
    } catch (err) {
      raw.insights[metric] = { error: err.message };
    }
  }

  return { ...out, raw, error };
}

/**
 * Ultimi N giorni di account_insights per un cliente.
 * Ritorna righe ordinate per data ascendente (ottimale per chart time-series).
 */
function getAccountInsightsHistory(clientId, days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT platform, date, fans, followers, media_count, reach, impressions, profile_views, engaged_users, error
    FROM account_insights
    WHERE client_id = ?
      AND date >= date('now', ?)
    ORDER BY date ASC, platform ASC
  `).all(clientId, `-${days} days`);
}

module.exports = {
  fetchFbInsights, fetchIgInsights,
  snapshotPostInsights, getLatestInsights,
  snapshotAccountInsights, getAccountInsightsHistory,
  fetchFbAccountInsights, fetchIgAccountInsights,
  FB_METRIC_MAP, IG_METRIC_MAP,
  FB_ACCOUNT_METRIC_MAP, IG_ACCOUNT_METRIC_CONFIG
};
