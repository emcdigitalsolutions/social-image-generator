/**
 * insights.js — fetch Meta Insights per post pubblicati (FB + IG).
 * Riusa l'infra Graph API del meta-publish.js (Page Token derivato dal
 * system user EMC, stesso host graph.facebook.com per entrambi).
 */
'use strict';

const https = require('https');
const { randomUUID: uuidv4 } = require('crypto');
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

// Mappa per oggetti VIDEO della Page (pubblicati via /{page_id}/videos).
// Hanno endpoint /video_insights diverso e metriche dedicate (total_video_*).
// Usato come fallback quando /{id}/insights ritorna "nonexisting field (insights)".
const FB_VIDEO_METRIC_MAP = {
  total_video_views:                  'video_views',
  total_video_views_unique:           'reach',
  total_video_impressions:            'impressions',
  total_video_reactions_by_type_total: 'likes'
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
// `endpoint` = 'insights' (post normali) | 'video_insights' (video Page).
// Ritorna {result, errors, raw}.
async function fetchMetricsIndividually(mediaId, metricMap, pageToken, endpoint = 'insights') {
  const result = {};
  const raw = {};
  const errors = [];
  for (const [metric, field] of Object.entries(metricMap)) {
    result[field] = null;
    const path = `/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}/${endpoint}?metric=${metric}&access_token=${encodeURIComponent(pageToken)}`;
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

  // Se TUTTE le metriche post hanno fallito con "nonexisting field (insights)",
  // significa che fbPostId è un VIDEO ID (no /insights endpoint) — ripeti su
  // /video_insights con la mappa video.
  const allNonexisting = errors.length === Object.keys(FB_METRIC_MAP).length
    && errors.every(e => /nonexisting field \(insights\)/i.test(e.message));
  if (allNonexisting) {
    const v = await fetchMetricsIndividually(fbPostId, FB_VIDEO_METRIC_MAP, pageToken, 'video_insights');
    const allFailedVideo = v.errors.length === Object.keys(FB_VIDEO_METRIC_MAP).length
      && new Set(v.errors.map(e => e.message)).size === 1;
    return {
      ...v.result,
      // i campi non presenti nella mappa video (es. clicks) restano null
      raw: { data: v.raw, errors: v.errors, fallback: 'video_insights' },
      error: allFailedVideo ? v.errors[0].message : null
    };
  }

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
// NOTA: `page_impressions` è stata deprecata in v25 (#100 invalid metric).
const FB_ACCOUNT_METRIC_MAP = {
  page_impressions_unique: 'reach',
  page_views_total:        'profile_views',
  page_post_engagements:   'engaged_users'
};

// IG account-level: alcune metriche v22+ richiedono `metric_type=total_value`
// in aggiunta a `period`. profile_views vuole entrambi.
const IG_ACCOUNT_METRIC_CONFIG = {
  reach:         { params: 'period=day',                          field: 'reach',         valueExtractor: 'period' },
  profile_views: { params: 'metric_type=total_value&period=day',  field: 'profile_views', valueExtractor: 'total_value' }
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

/**
 * Riepilogo KPI account-level per la dashboard cliente. Calcola:
 *   - valori "now" (ultima riga disponibile per platform)
 *   - delta vs N giorni fa (positivo = crescita, negativo = perdita, null = no dati)
 *   - reach totale del periodo (somma reach giornalieri)
 */
function getAccountSummary(clientId, days = 30) {
  const rows = getAccountInsightsHistory(clientId, days);
  const summary = { fb: null, ig: null };

  for (const platform of ['fb', 'ig']) {
    const platformRows = rows.filter(r => r.platform === platform);
    if (!platformRows.length) continue;

    const first = platformRows[0];
    const last = platformRows[platformRows.length - 1];
    const followersNow = platform === 'fb' ? last.fans : last.followers;
    const followersStart = platform === 'fb' ? first.fans : first.followers;
    const reachTotal = platformRows.reduce((s, r) => s + (r.reach || 0), 0);
    const profileViewsTotal = platformRows.reduce((s, r) => s + (r.profile_views || 0), 0);

    summary[platform] = {
      followers_now: followersNow,
      followers_delta: (followersNow != null && followersStart != null) ? (followersNow - followersStart) : null,
      reach_total: reachTotal,
      profile_views_total: profileViewsTotal,
      days_with_data: platformRows.length,
      first_date: first.date,
      last_date: last.date
    };
  }

  return summary;
}

/**
 * Top N post pubblicati ordinati per engagement (likes+comments+shares+saves).
 * Aggrega per post (un post ha fino a 2 righe insights: fb + ig) prendendo
 * SEMPRE l'ultimo snapshot per platform.
 */
function getTopPosts(clientId, days = 30, limit = 5) {
  const db = getDb();
  return db.prepare(`
    SELECT
      p.id, p.sub_topic, p.media_type, p.category, p.scheduled_date, p.published_at,
      p.fb_post_id, p.ig_media_id,
      -- ultimo snapshot per platform (subquery con MAX(fetched_at))
      (SELECT pi.engagement FROM post_insights pi
        WHERE pi.post_id = p.id AND pi.platform = 'ig'
        ORDER BY pi.fetched_at DESC LIMIT 1) AS ig_engagement,
      (SELECT pi.reach FROM post_insights pi
        WHERE pi.post_id = p.id AND pi.platform = 'ig'
        ORDER BY pi.fetched_at DESC LIMIT 1) AS ig_reach,
      (SELECT pi.likes FROM post_insights pi
        WHERE pi.post_id = p.id AND pi.platform = 'ig'
        ORDER BY pi.fetched_at DESC LIMIT 1) AS ig_likes,
      (SELECT pi.engagement FROM post_insights pi
        WHERE pi.post_id = p.id AND pi.platform = 'fb'
        ORDER BY pi.fetched_at DESC LIMIT 1) AS fb_engagement,
      (SELECT pi.reach FROM post_insights pi
        WHERE pi.post_id = p.id AND pi.platform = 'fb'
        ORDER BY pi.fetched_at DESC LIMIT 1) AS fb_reach
    FROM posts p
    WHERE p.client_id = ?
      AND p.status = 'published'
      AND p.published_at >= datetime('now', ?)
      AND (p.fb_post_id IS NOT NULL OR p.ig_media_id IS NOT NULL)
    ORDER BY (COALESCE((SELECT pi.engagement FROM post_insights pi
                        WHERE pi.post_id = p.id AND pi.platform = 'ig'
                        ORDER BY pi.fetched_at DESC LIMIT 1), 0)
            + COALESCE((SELECT pi.engagement FROM post_insights pi
                        WHERE pi.post_id = p.id AND pi.platform = 'fb'
                        ORDER BY pi.fetched_at DESC LIMIT 1), 0)) DESC
    LIMIT ?
  `).all(clientId, `-${days} days`, limit);
}

/**
 * KPI sintetici del periodo (zero call Meta, solo DB locale):
 *   - post_count        — post pubblicati nel periodo
 *   - total_interactions — somma dell'ultimo engagement per platform di ogni post
 *                          (FB = like; IG = like+commenti+condivisioni+salvataggi)
 * Reach totale ed engagement rate vengono calcolati dal chiamante combinando
 * questo con getAccountSummary (per coerenza col reach mostrato per piattaforma).
 */
function getPeriodKpis(clientId, days = 30) {
  const db = getDb();
  const window = `-${days} days`;

  const postCount = db.prepare(`
    SELECT COUNT(*) AS n FROM posts
    WHERE client_id = ? AND status = 'published'
      AND published_at >= datetime('now', ?)
  `).get(clientId, window).n;

  const row = db.prepare(`
    SELECT COALESCE(SUM(
        COALESCE((SELECT pi.engagement FROM post_insights pi
          WHERE pi.post_id = p.id AND pi.platform = 'ig'
          ORDER BY pi.fetched_at DESC LIMIT 1), 0)
      + COALESCE((SELECT pi.engagement FROM post_insights pi
          WHERE pi.post_id = p.id AND pi.platform = 'fb'
          ORDER BY pi.fetched_at DESC LIMIT 1), 0)
    ), 0) AS total_interactions
    FROM posts p
    WHERE p.client_id = ?
      AND p.status = 'published'
      AND p.published_at >= datetime('now', ?)
      AND (p.fb_post_id IS NOT NULL OR p.ig_media_id IS NOT NULL)
  `).get(clientId, window);

  return {
    post_count: postCount,
    total_interactions: row.total_interactions || 0
  };
}

/**
 * Overview admin multi-cliente: per ogni cliente attivo ritorna gli ultimi
 * dati account + delta vs N giorni fa, per la pagina admin Insights.
 */
function getInsightsOverview(days = 30) {
  const db = getDb();
  const clients = db.prepare(`
    SELECT id, display_name, sector, location, logo_filename, status
    FROM clients
    WHERE status != 'archived' AND deleted_at IS NULL
    ORDER BY display_name COLLATE NOCASE ASC
  `).all();

  return clients.map(c => {
    const summary = getAccountSummary(c.id, days);
    // Conta post pubblicati nel periodo
    const postCount = db.prepare(`
      SELECT COUNT(*) AS n FROM posts
      WHERE client_id = ? AND status = 'published'
        AND published_at >= datetime('now', ?)
    `).get(c.id, `-${days} days`).n;
    return {
      id: c.id,
      display_name: c.display_name,
      sector: c.sector,
      location: c.location,
      has_logo: !!c.logo_filename,
      summary,
      post_count: postCount,
      has_data: !!(summary.fb || summary.ig)
    };
  });
}

module.exports = {
  fetchFbInsights, fetchIgInsights,
  snapshotPostInsights, getLatestInsights,
  snapshotAccountInsights, getAccountInsightsHistory,
  getAccountSummary, getTopPosts, getPeriodKpis, getInsightsOverview,
  fetchFbAccountInsights, fetchIgAccountInsights,
  FB_METRIC_MAP, FB_VIDEO_METRIC_MAP, IG_METRIC_MAP,
  FB_ACCOUNT_METRIC_MAP, IG_ACCOUNT_METRIC_CONFIG
};
