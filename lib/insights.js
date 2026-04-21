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

// Metriche richieste per FB post (Page feed)
const FB_METRICS = [
  'post_impressions',            // totale visualizzazioni
  'post_impressions_unique',     // reach
  'post_clicks',                 // click sul link
  'post_reactions_by_type_total' // like+love+wow+haha+sad+angry aggregati
];

// Metriche richieste per IG media
// Note: 'impressions' è stato deprecato in alcuni casi per Reels — usiamo views.
// Le metriche non applicabili a quel tipo di media vengono ignorate da Meta.
const IG_METRICS = [
  'impressions',     // visualizzazioni totali (foto feed)
  'reach',           // utenti unici
  'likes',
  'comments',
  'shares',
  'saved',
  'video_views',     // per video/reel
  'total_interactions'
];

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

async function fetchFbInsights(pageToken, fbPostId) {
  const path = `/${GRAPH_API_VERSION}/${encodeURIComponent(fbPostId)}/insights` +
    `?metric=${FB_METRICS.join(',')}&access_token=${encodeURIComponent(pageToken)}`;
  const r = await httpGet(FB_HOST, path);
  if (r.error) {
    return { error: r.error.message || 'FB insights error', raw: r };
  }
  return {
    impressions: extractValue(r.data, 'post_impressions'),
    reach:       extractValue(r.data, 'post_impressions_unique'),
    clicks:      extractValue(r.data, 'post_clicks'),
    likes:       extractValue(r.data, 'post_reactions_by_type_total'),
    raw: r
  };
}

async function fetchIgInsights(pageToken, igMediaId) {
  const path = `/${GRAPH_API_VERSION}/${encodeURIComponent(igMediaId)}/insights` +
    `?metric=${IG_METRICS.join(',')}&access_token=${encodeURIComponent(pageToken)}`;
  const r = await httpGet(FB_HOST, path);
  if (r.error) {
    return { error: r.error.message || 'IG insights error', raw: r };
  }
  return {
    impressions:  extractValue(r.data, 'impressions'),
    reach:        extractValue(r.data, 'reach'),
    likes:        extractValue(r.data, 'likes'),
    comments:     extractValue(r.data, 'comments'),
    shares:       extractValue(r.data, 'shares'),
    saves:        extractValue(r.data, 'saved'),
    video_views:  extractValue(r.data, 'video_views'),
    engagement:   extractValue(r.data, 'total_interactions'),
    raw: r
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
  FB_METRICS, IG_METRICS
};
