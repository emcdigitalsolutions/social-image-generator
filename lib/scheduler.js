const cron = require('node-cron');
const { getDb } = require('./db');
const { publishPost, getPageToken } = require('./meta-publish');
const { notifyPublishFailed, notifyPublishPartial } = require('./notifier');
const { snapshotPostInsights } = require('./insights');
const postMedia = require('./post-media');
const audit = require('./audit');

let task = null;
let insightsTask = null;

function start() {
  if (task) return;

  // Check every 60 seconds for posts ready to publish
  task = cron.schedule('* * * * *', async () => {
    try {
      await checkAndPublish();
    } catch (err) {
      console.error('[scheduler] Error:', err.message);
    }
  });

  // Insights daily at 04:00 (orario basso per non concorrere con publish)
  insightsTask = cron.schedule('0 4 * * *', async () => {
    try {
      await refreshAllInsights();
    } catch (err) {
      console.error('[insights-cron] Error:', err.stack || err.message);
    }
  });

  console.log('[scheduler] Auto-publish scheduler started (every 60s)');
  console.log('[scheduler] Insights refresh cron started (daily 04:00)');
}

/**
 * Refresh insights per tutti i post pubblicati negli ultimi 30 giorni.
 * Raggruppa per cliente per riusare il Page Token una volta sola.
 */
async function refreshAllInsights() {
  const db = getDb();
  const posts = db.prepare(`
    SELECT p.id, p.client_id, p.fb_post_id, p.ig_media_id,
      c.fb_page_id, c.fb_system_user_token
    FROM posts p
    JOIN clients c ON c.id = p.client_id
    WHERE p.status = 'published'
      AND (p.fb_post_id IS NOT NULL OR p.ig_media_id IS NOT NULL)
      AND p.published_at > datetime('now', '-30 days')
  `).all();

  if (!posts.length) {
    console.log('[insights-cron] No recent published posts — skip');
    return;
  }

  // Grouping per evitare di chiedere page_token N volte per lo stesso cliente
  const byClient = {};
  posts.forEach(p => {
    if (!p.fb_system_user_token || !p.fb_page_id) return;
    const key = p.client_id;
    if (!byClient[key]) byClient[key] = { token: p.fb_system_user_token, pageId: p.fb_page_id, posts: [] };
    byClient[key].posts.push(p);
  });

  let totalOk = 0, totalErr = 0;
  for (const [clientId, group] of Object.entries(byClient)) {
    let pageToken;
    try {
      pageToken = await getPageToken(group.token, group.pageId);
    } catch (err) {
      console.warn(`[insights-cron] Page token ${clientId} failed:`, err.message);
      continue;
    }
    for (const p of group.posts) {
      try {
        await snapshotPostInsights(pageToken, p);
        totalOk++;
      } catch (err) {
        totalErr++;
        console.warn(`[insights-cron] post ${p.id}:`, err.message);
      }
    }
  }
  console.log(`[insights-cron] done: ${totalOk} ok, ${totalErr} err, ${posts.length} total`);
}

async function checkAndPublish() {
  const db = getDb();
  // Timezone: il server container è quasi sempre in UTC, ma gli admin impostano
  // scheduled_time pensando all'orario italiano. Usiamo Europe/Rome per il confronto.
  // toLocaleString('sv-SE') ritorna YYYY-MM-DD HH:mm:ss in formato ISO-like, perfetto.
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).slice(0, 16);

  // Find posts that are ready and scheduled for now or earlier.
  // GUARD: solo i post con approval_status = 'approved' (oppure piano senza
  // alcuna approvazione attiva → backward-compat) vengono pubblicati.
  // Se il piano ha un approval per il mese ma il post è 'pending'/'change_requested'/'rejected'
  // → skip silenzioso (lo scheduler ricontrollerà al prossimo tick).
  const posts = db.prepare(`
    SELECT p.*,
      c.id as _client_id, c.display_name as _client_name,
      c.fb_page_id, c.fb_system_user_token, c.ig_user_id, c.ig_access_token
    FROM posts p
    JOIN clients c ON c.id = p.client_id
    JOIN schedules s ON s.editorial_plan_id = p.editorial_plan_id
      AND s.month_number = p.month_number
      AND s.is_active = 1
    LEFT JOIN monthly_approvals ma ON ma.editorial_plan_id = p.editorial_plan_id
      AND ma.month_number = p.month_number
    WHERE p.status = 'ready'
      AND p.scheduled_date IS NOT NULL
      AND (p.scheduled_date || ' ' || COALESCE(p.scheduled_time, '00:00')) <= ?
      AND (ma.id IS NULL OR p.approval_status = 'approved')
  `).all(now);

  for (const post of posts) {
    console.log(`[scheduler] Publishing post ${post.id} for client ${post.client_id}`);

    try {
      const client = {
        id: post._client_id,
        display_name: post._client_name,
        fb_page_id: post.fb_page_id,
        fb_system_user_token: post.fb_system_user_token,
        ig_user_id: post.ig_user_id,
        ig_access_token: post.ig_access_token
      };

      // Costruisci la lista media: prima da post_media, fallback all'image_url legacy
      let media = postMedia.listMedia(post.id);
      if (!media.length && post.image_url) {
        media = [{ kind: 'image', url: post.image_url, position: 0 }];
      }
      if (!media.length) {
        const errMsg = 'Nessun media disponibile per la pubblicazione';
        db.prepare("UPDATE posts SET status = 'failed', publish_error = ?, updated_at = datetime('now') WHERE id = ?").run(errMsg, post.id);
        console.error(`[scheduler] Skip post ${post.id}: ${errMsg}`);
        notifyPublishFailed(post, client, errMsg).catch(e => console.error('[notifier]', e.message));
        continue;
      }

      // Valida coerenza media_type ↔ media (solo se ci sono post_media veri)
      const mediaType = post.media_type || 'single_image';
      if (postMedia.listMedia(post.id).length > 0) {
        try {
          postMedia.validateForMediaType(post.id, mediaType);
        } catch (validationErr) {
          db.prepare("UPDATE posts SET status = 'failed', publish_error = ?, updated_at = datetime('now') WHERE id = ?").run(validationErr.message, post.id);
          console.error(`[scheduler] Skip post ${post.id}: ${validationErr.message}`);
          notifyPublishFailed(post, client, validationErr.message).catch(e => console.error('[notifier]', e.message));
          continue;
        }
      }

      const result = await publishPost(client, { ...post, media_type: mediaType }, media);

      // Fail se nessuno dei due canali ha pubblicato (a prescindere da errors.length).
      // Senza questa condizione, un publishPost "no-op silenzioso" (es. credenziali
      // mancanti) marcava il post come published con ID null.
      if (!result.fb_post_id && !result.ig_media_id) {
        const errMsg = result.errors.length
          ? result.errors.join('; ')
          : 'Publish fallito: nessun canale ha ricevuto l\'ID Meta';
        db.prepare(`
          UPDATE posts SET status = 'failed', publish_error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(errMsg, post.id);
        notifyPublishFailed(post, client, errMsg).catch(e => console.error('[notifier]', e.message));
        audit.logAsSystem({
          actor_label: 'scheduler',
          client_id: post.client_id,
          action: 'post.publish_failed_auto',
          entity_type: 'post',
          entity_id: post.id,
          details: { errors: result.errors, category: post.category, sub_topic: post.sub_topic }
        });
      } else {
        db.prepare(`
          UPDATE posts SET
            status = 'published',
            fb_post_id = ?,
            ig_media_id = ?,
            published_at = datetime('now'),
            publish_error = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          result.fb_post_id,
          result.ig_media_id,
          result.errors.length ? result.errors.join('; ') : null,
          post.id
        );
        console.log(`[scheduler] Published post ${post.id}: FB=${result.fb_post_id}, IG=${result.ig_media_id}`);
        if (result.errors.length) {
          notifyPublishPartial(post, client, result).catch(e => console.error('[notifier]', e.message));
        }
        audit.logAsSystem({
          actor_label: 'scheduler',
          client_id: post.client_id,
          action: 'post.published_auto',
          entity_type: 'post',
          entity_id: post.id,
          details: {
            fb_post_id: result.fb_post_id || null,
            ig_media_id: result.ig_media_id || null,
            partial_errors: result.errors && result.errors.length ? result.errors : null,
            category: post.category, sub_topic: post.sub_topic,
            scheduled_at: post.scheduled_date + ' ' + (post.scheduled_time || '')
          }
        });
      }
    } catch (err) {
      db.prepare(`
        UPDATE posts SET status = 'failed', publish_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(err.message, post.id);
      console.error(`[scheduler] Failed post ${post.id}:`, err.message);
      const clientForNotify = { id: post._client_id, display_name: post._client_name };
      notifyPublishFailed(post, clientForNotify, err.message).catch(e => console.error('[notifier]', e.message));
      audit.logAsSystem({
        actor_label: 'scheduler',
        client_id: post.client_id,
        action: 'post.publish_exception',
        entity_type: 'post',
        entity_id: post.id,
        details: { error: err.message, category: post.category }
      });
    }
  }
}

function stop() {
  if (task) { task.stop(); task = null; }
  if (insightsTask) { insightsTask.stop(); insightsTask = null; }
}

module.exports = { start, stop, checkAndPublish, refreshAllInsights };
