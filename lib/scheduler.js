const cron = require('node-cron');
const { getDb } = require('./db');
const { publishPost } = require('./meta-publish');

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
    SELECT p.*, c.fb_page_id, c.fb_system_user_token, c.ig_user_id, c.ig_access_token
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
        fb_page_id: post.fb_page_id,
        fb_system_user_token: post.fb_system_user_token,
        ig_user_id: post.ig_user_id,
        ig_access_token: post.ig_access_token
      };

      const result = await publishPost(client, post.image_url, post.caption);

      if (result.errors.length && !result.fb_post_id && !result.ig_media_id) {
        db.prepare(`
          UPDATE posts SET status = 'failed', publish_error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(result.errors.join('; '), post.id);
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
      }
    } catch (err) {
      db.prepare(`
        UPDATE posts SET status = 'failed', publish_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(err.message, post.id);
      console.error(`[scheduler] Failed post ${post.id}:`, err.message);
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
