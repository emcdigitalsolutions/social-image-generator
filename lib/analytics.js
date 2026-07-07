/**
 * analytics.js — aggregati di performance per cliente (backlog F-pro-7d).
 *
 * Lavora SOLO su dati già in DB (post_insights popolata dal cron giornaliero
 * + posts). Nessuna chiamata Meta. Per ogni post/platform si usa lo snapshot
 * più recente (MAX(fetched_at)).
 *
 * Risponde a: quale FORMATO rende di più? quale CATEGORIA? quale GIORNO/ORA?
 * FB vs IG? — dati per ottimizzare il piano e argomentare il valore al cliente.
 */
'use strict';

const { getDb } = require('./db');

const DAY_LABELS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

const MEDIA_LABELS = {
  single_image: 'Immagine singola',
  carousel: 'Carousel',
  video: 'Video',
  reel: 'Reel',
  story: 'Story'
};

/**
 * Righe base: ultimo snapshot per (post, platform) dei post pubblicati
 * negli ultimi `days` giorni, con i metadati del post.
 */
function baseRows(clientId, days) {
  const db = getDb();
  return db.prepare(`
    SELECT p.id AS post_id, p.media_type, p.category,
           COALESCE(p.published_at, p.updated_at) AS published_at,
           pi.platform, pi.reach, pi.engagement, pi.likes, pi.comments, pi.shares
    FROM posts p
    JOIN editorial_plans ep ON ep.id = p.editorial_plan_id
    JOIN post_insights pi ON pi.post_id = p.id
      AND pi.fetched_at = (
        SELECT MAX(pi2.fetched_at) FROM post_insights pi2
        WHERE pi2.post_id = pi.post_id AND pi2.platform = pi.platform
      )
    WHERE ep.client_id = ?
      AND p.status = 'published'
      AND pi.error IS NULL
      AND datetime(COALESCE(p.published_at, p.updated_at)) >= datetime('now', ?)
  `).all(clientId, `-${Math.max(1, Math.min(365, days | 0))} days`);
}

function avg(list, sel) {
  const vals = list.map(sel).filter(v => v !== null && v !== undefined);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function round1(v) { return v === null ? null : Math.round(v * 10) / 10; }

/** Raggruppa per chiave e calcola medie reach/engagement + conteggio post distinti. */
function groupStats(rows, keyFn, labelFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, list] of groups) {
    const posts = new Set(list.map(r => r.post_id)).size;
    out.push({
      key,
      label: labelFn ? labelFn(key) : String(key),
      posts,
      avg_reach: round1(avg(list, r => r.reach)),
      avg_engagement: round1(avg(list, r => r.engagement))
    });
  }
  // Ordina per engagement medio decrescente (null in fondo)
  out.sort((a, b) => (b.avg_engagement ?? -1) - (a.avg_engagement ?? -1));
  return out;
}

/**
 * Analytics complete per un cliente.
 * @param {string} clientId
 * @param {number} days finestra (default 90)
 */
function getClientAnalytics(clientId, days = 90) {
  const rows = baseRows(clientId, days);

  const platforms = groupStats(rows,
    r => r.platform,
    k => (k === 'fb' ? 'Facebook' : k === 'ig' ? 'Instagram' : k));

  const byMediaType = groupStats(rows,
    r => r.media_type || 'single_image',
    k => MEDIA_LABELS[k] || k);

  const byCategory = groupStats(rows.filter(r => r.category),
    r => r.category);

  const byWeekday = groupStats(rows, r => {
    const d = new Date(String(r.published_at).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d.getDay();
  }, k => DAY_LABELS[k] || String(k));

  const byHour = groupStats(rows, r => {
    const d = new Date(String(r.published_at).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d.getHours();
  }, k => String(k).padStart(2, '0') + ':00');

  const distinctPosts = new Set(rows.map(r => r.post_id)).size;

  return {
    days,
    posts: distinctPosts,
    snapshots: rows.length,
    platforms,
    byMediaType,
    byCategory,
    byWeekday,
    byHour: byHour.slice(0, 6), // top 6 fasce orarie
    best: {
      mediaType: byMediaType[0] || null,
      category: byCategory[0] || null,
      weekday: byWeekday[0] || null,
      hour: byHour[0] || null
    }
  };
}

module.exports = { getClientAnalytics, groupStats, DAY_LABELS, MEDIA_LABELS };
