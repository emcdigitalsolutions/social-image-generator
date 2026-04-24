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

module.exports = {
  fetchFbInsights, fetchIgInsights,
  snapshotPostInsights, getLatestInsights,
  FB_METRIC_MAP, IG_METRIC_MAP
};
