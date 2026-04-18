const express = require('express');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { generateCaption } = require('../../lib/ai');
const { publishPost } = require('../../lib/meta-publish');
const { renderImage } = require('../../lib/renderer');

const router = express.Router();
router.use(authMiddleware);

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';

// Get posts by plan and month
router.get('/by-plan/:planId/month/:month', (req, res) => {
  const db = getDb();
  const posts = db.prepare(`
    SELECT * FROM posts
    WHERE editorial_plan_id = ? AND month_number = ?
    ORDER BY week_number, scheduled_date
  `).all(req.params.planId, parseInt(req.params.month));
  posts.forEach(p => { if (p.image_data) p.image_data = JSON.parse(p.image_data); });
  res.json(posts);
});

// Get single post
router.get('/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.image_data) post.image_data = JSON.parse(post.image_data);
  res.json(post);
});

// Update post
router.put('/:id', (req, res) => {
  const db = getDb();
  const fields = ['category', 'sub_topic', 'template', 'caption', 'image_data',
    'source_image_url', 'scheduled_date', 'scheduled_time', 'status'];

  const updates = [];
  const values = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      const val = field === 'image_data' ? JSON.stringify(req.body[field]) : req.body[field];
      updates.push(`${field} = ?`);
      values.push(val);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);

  db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (post.image_data) post.image_data = JSON.parse(post.image_data);
  res.json(post);
});

// Generate caption for a post
router.post('/:id/generate-caption', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  try {
    const result = await generateCaption(client, post);
    db.prepare(`
      UPDATE posts SET caption = ?, caption_ai_raw = ?, status = 'caption_generated', updated_at = datetime('now')
      WHERE id = ?
    `).run(result.text, JSON.stringify(result.raw), post.id);

    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Caption generation failed', details: err.message });
  }
});

// Generate image for a post
router.post('/:id/generate-image', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const template = post.template || 'quote';
  const data = {
    text: post.caption ? post.caption.split('\n')[0] : '',
    title: post.sub_topic || post.category || '',
    description: post.caption ? post.caption.split('\n')[0] : '',
    image_url: post.source_image_url || ''
  };

  try {
    const { filename } = await renderImage(template, post.client_id, data);
    const imageUrl = `${BASE_URL}/images/${post.client_id}/${filename}`;

    db.prepare(`
      UPDATE posts SET image_url = ?, image_data = ?, status = 'image_generated', updated_at = datetime('now')
      WHERE id = ?
    `).run(imageUrl, JSON.stringify(data), post.id);

    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    if (updated.image_data) updated.image_data = JSON.parse(updated.image_data);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Image generation failed', details: err.message });
  }
});

// Publish post to FB+IG
router.post('/:id/publish', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (!post.image_url || !post.caption) {
    return res.status(400).json({ error: 'Post must have both caption and image before publishing' });
  }

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  try {
    const result = await publishPost(client, post.image_url, post.caption);

    const status = (result.fb_post_id || result.ig_media_id) ? 'published' : 'failed';
    db.prepare(`
      UPDATE posts SET
        status = ?,
        fb_post_id = ?,
        ig_media_id = ?,
        published_at = datetime('now'),
        publish_error = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      status,
      result.fb_post_id,
      result.ig_media_id,
      result.errors.length ? result.errors.join('; ') : null,
      post.id
    );

    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    res.json({ post: updated, publish_result: result });
  } catch (err) {
    res.status(500).json({ error: 'Publishing failed', details: err.message });
  }
});

// Bulk generate captions+images
router.post('/bulk-generate', async (req, res) => {
  const db = getDb();
  const { post_ids, action } = req.body; // action: 'caption', 'image', 'both'

  if (!post_ids || !post_ids.length) {
    return res.status(400).json({ error: 'post_ids array required' });
  }

  const results = [];

  for (const postId of post_ids) {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post) { results.push({ id: postId, error: 'Not found' }); continue; }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);

    try {
      if (action === 'caption' || action === 'both') {
        const captionResult = await generateCaption(client, post);
        db.prepare(`
          UPDATE posts SET caption = ?, caption_ai_raw = ?, status = 'caption_generated', updated_at = datetime('now')
          WHERE id = ?
        `).run(captionResult.text, JSON.stringify(captionResult.raw), postId);
      }

      if (action === 'image' || action === 'both') {
        const currentPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
        const template = currentPost.template || 'quote';
        const data = {
          text: currentPost.caption ? currentPost.caption.split('\n')[0] : '',
          title: currentPost.sub_topic || currentPost.category || '',
          description: currentPost.caption ? currentPost.caption.split('\n')[0] : '',
          image_url: currentPost.source_image_url || ''
        };

        const { filename } = await renderImage(template, currentPost.client_id, data);
        const imageUrl = `${BASE_URL}/images/${currentPost.client_id}/${filename}`;

        db.prepare(`
          UPDATE posts SET image_url = ?, image_data = ?, status = 'image_generated', updated_at = datetime('now')
          WHERE id = ?
        `).run(imageUrl, JSON.stringify(data), postId);
      }

      // Mark as ready if both caption and image exist
      const finalPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      if (finalPost.caption && finalPost.image_url) {
        db.prepare("UPDATE posts SET status = 'ready', updated_at = datetime('now') WHERE id = ?").run(postId);
      }

      results.push({ id: postId, success: true });
    } catch (err) {
      results.push({ id: postId, error: err.message });
    }
  }

  res.json({ results });
});

module.exports = router;
