const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { generateCaption } = require('../../lib/ai-provider');
const { publishPost } = require('../../lib/meta-publish');
const { renderImage } = require('../../lib/renderer');
const postMedia = require('../../lib/post-media');

const router = express.Router();
router.use(authMiddleware);

const MEDIA_TYPES = new Set(['single_image', 'carousel', 'video', 'reel']);

// Multer per upload media (tmp dir, sposteremo dopo)
const mediaUpload = multer({
  dest: path.join(os.tmpdir(), 'sig-upload'),
  limits: { fileSize: postMedia.MAX_VIDEO_BYTES }, // limite hard al video
  fileFilter: (req, file, cb) => {
    const cls = postMedia.classifyExt(file.originalname, file.mimetype);
    if (cls) cb(null, true);
    else cb(new Error('Formato non supportato. Accetto JPG/PNG/WEBP/MP4/MOV.'));
  }
});

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
    'source_image_url', 'scheduled_date', 'scheduled_time', 'status', 'media_type'];

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

// Publish post to FB+IG (single_image / carousel / video / reel)
router.post('/:id/publish', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!post.caption) return res.status(400).json({ error: 'Caption required' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Costruisci la lista media: prima da post_media, fallback all'image_url legacy.
  let media = postMedia.listMedia(post.id);
  if (!media.length && post.image_url) {
    media = [{ kind: 'image', url: post.image_url, position: 0 }];
  }
  if (!media.length) return res.status(400).json({ error: 'Nessun media disponibile per la pubblicazione' });

  // Valida coerenza media_type ↔ media (skip se siamo in modalità legacy single_image)
  const mediaType = post.media_type || 'single_image';
  if (postMedia.listMedia(post.id).length > 0) {
    try {
      postMedia.validateForMediaType(post.id, mediaType);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  try {
    const result = await publishPost(client, { ...post, media_type: mediaType }, media);

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

// ─────────────── Multi-media (carousel + video) ───────────────

// List media for a post
router.get('/:id/media', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json({ media: postMedia.listMedia(req.params.id) });
});

// Upload one or more media files
router.post('/:id/media', mediaUpload.array('media', postMedia.MAX_CAROUSEL_ITEMS), (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nessun file caricato' });

  const created = [];
  const errors = [];
  for (const f of req.files) {
    try {
      const m = postMedia.attachUploadedFile({
        clientId: post.client_id,
        postId: post.id,
        tmpPath: f.path,
        originalName: f.originalname,
        mimetype: f.mimetype
      });
      created.push(m);
    } catch (err) {
      errors.push({ file: f.originalname, error: err.message });
    }
  }

  res.status(created.length ? 201 : 400).json({ media: created, errors });
});

// Delete a single media item
router.delete('/:id/media/:mediaId', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const m = postMedia.getMedia(req.params.mediaId);
  if (!m || m.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });

  postMedia.deleteMedia(req.params.mediaId);
  res.json({ success: true });
});

// Reorder media items
router.put('/:id/media/reorder', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const order = Array.isArray(req.body.order) ? req.body.order : null;
  if (!order || !order.length) return res.status(400).json({ error: 'order array required' });

  const items = postMedia.listMedia(post.id);
  const knownIds = new Set(items.map(i => i.id));
  if (order.some(id => !knownIds.has(id)) || order.length !== items.length) {
    return res.status(400).json({ error: 'order deve contenere ESATTAMENTE gli id dei media del post' });
  }

  const updated = postMedia.reorder(post.id, order);
  res.json({ media: updated });
});

// Stylize an existing image media via Puppeteer template overlay.
// Crea un NUOVO post_media con source='styled' e styled_from_id riferito all'originale.
router.post('/:id/media/:mediaId/stylize', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const orig = postMedia.getMedia(req.params.mediaId);
  if (!orig || orig.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });
  if (orig.kind !== 'image') return res.status(400).json({ error: 'Solo immagini possono essere stilizzate' });

  const template = req.body.template || 'image-overlay';
  const includeCaption = req.body.include_caption !== false; // default true

  const captionSnippet = includeCaption && post.caption
    ? post.caption.split('\n')[0].slice(0, 240)
    : '';

  const data = {
    image_url: orig.url,
    caption_block: captionSnippet
      ? `<div class="caption-strip">${captionSnippet.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>`
      : '',
    title: post.sub_topic || post.category || '',
    description: post.caption ? post.caption.split('\n')[0].slice(0, 240) : ''
  };

  try {
    const { filePath } = await renderImage(template, post.client_id, data);
    const styled = postMedia.attachGeneratedFile({
      clientId: post.client_id,
      postId: post.id,
      absolutePath: filePath,
      source: 'styled',
      styledFromId: orig.id,
      kind: 'image'
    });
    res.status(201).json({ media: styled, original: orig });
  } catch (err) {
    console.error('[stylize] error:', err.message);
    res.status(500).json({ error: 'Stilizzazione fallita', details: err.message });
  }
});

// Change post media_type with coherence validation
router.put('/:id/media-type', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const { media_type } = req.body;
  if (!MEDIA_TYPES.has(media_type)) return res.status(400).json({ error: 'media_type non valido' });

  // Permettiamo il cambio anche se i media esistenti non sono ancora coerenti:
  // sarà la pubblicazione a richiedere coerenza. Qui validiamo solo se ci sono media.
  const items = postMedia.listMedia(post.id);
  if (items.length > 0) {
    try {
      postMedia.validateForMediaType(post.id, media_type);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  db.prepare("UPDATE posts SET media_type = ?, updated_at = datetime('now') WHERE id = ?").run(media_type, post.id);
  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  res.json(updated);
});

module.exports = router;
