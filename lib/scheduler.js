const cron = require('node-cron');
const { getDb } = require('./db');
const { publishPost } = require('./meta-publish');
const { notifyPublishFailed, notifyPublishPartial } = require('./notifier');
const postMedia = require('./post-media');

let task = null;

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

  console.log('[scheduler] Auto-publish scheduler started (every 60s)');
}

async function checkAndPublish() {
  const db = getDb();
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Find posts that are ready and scheduled for now or earlier
  const posts = db.prepare(`
    SELECT p.*,
      c.id as _client_id, c.display_name as _client_name,
      c.fb_page_id, c.fb_system_user_token, c.ig_user_id, c.ig_access_token
    FROM posts p
    JOIN clients c ON c.id = p.client_id
    JOIN schedules s ON s.editorial_plan_id = p.editorial_plan_id
      AND s.month_number = p.month_number
      AND s.is_active = 1
    WHERE p.status = 'ready'
      AND p.scheduled_date IS NOT NULL
      AND (p.scheduled_date || ' ' || COALESCE(p.scheduled_time, '00:00')) <= ?
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

      if (result.errors.length && !result.fb_post_id && !result.ig_media_id) {
        db.prepare(`
          UPDATE posts SET status = 'failed', publish_error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(result.errors.join('; '), post.id);
        notifyPublishFailed(post, client, result.errors.join('; ')).catch(e => console.error('[notifier]', e.message));
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
      }
    } catch (err) {
      db.prepare(`
        UPDATE posts SET status = 'failed', publish_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(err.message, post.id);
      console.error(`[scheduler] Failed post ${post.id}:`, err.message);
      const clientForNotify = { id: post._client_id, display_name: post._client_name };
      notifyPublishFailed(post, clientForNotify, err.message).catch(e => console.error('[notifier]', e.message));
    }
  }
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { start, stop, checkAndPublish };
