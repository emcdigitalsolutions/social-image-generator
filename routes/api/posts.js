const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { generateCaption } = require('../../lib/ai-provider');
const { publishPost } = require('../../lib/meta-publish');
const { renderImage } = require('../../lib/renderer');
const postMedia = require('../../lib/post-media');

const router = express.Router();
router.use(authMiddleware);

// 'video' rimosso dall'UI (Meta ha deprecato media_type=VIDEO, tutto va come REELS).
// Tenuto qui per backward-compat dei post legacy migrati a 'reel' dalla migration 008.
// 'story' = task per il cliente (non publish da noi), accettato in DB ma il publish
// endpoint lo rifiuta esplicitamente.
const MEDIA_TYPES = new Set(['single_image', 'carousel', 'video', 'reel', 'story']);

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
    'source_image_url', 'scheduled_date', 'scheduled_time', 'status', 'media_type',
    'ig_share_to_feed'];

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
    const { filename, filePath } = await renderImage(template, post.client_id, data);
    const imageUrl = `${BASE_URL}/images/${post.client_id}/${filename}`;

    db.prepare(`
      UPDATE posts SET image_url = ?, image_data = ?, status = 'image_generated', updated_at = datetime('now')
      WHERE id = ?
    `).run(imageUrl, JSON.stringify(data), post.id);

    // Registra anche come post_media per la nuova UI (sposta il file in posts/{id}/)
    try {
      postMedia.attachGeneratedFile({
        clientId: post.client_id,
        postId: post.id,
        absolutePath: filePath,
        source: 'generated',
        kind: 'image'
      });
    } catch (mErr) {
      // non blocca: il fallback legacy image_url funziona comunque
      console.warn('[generate-image] post_media attach failed:', mErr.message);
    }

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
  if (post.media_type === 'story') {
    return res.status(400).json({ error: 'Le storie non si pubblicano dalla dashboard — sono task per il cliente (durano 24h)' });
  }

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

  // channels: array opzionale tipo ['fb'], ['ig'], ['fb','ig']. Default: entrambi.
  const channels = Array.isArray(req.body.channels) && req.body.channels.length
    ? req.body.channels.filter(c => c === 'fb' || c === 'ig')
    : ['fb', 'ig'];

  try {
    const result = await publishPost(client, { ...post, media_type: mediaType }, media, { channels });

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

// Crop / edit: sovrascrive il file del media con il blob croppato ricevuto dal client
// (es. da Cropper.js). Mantiene lo stesso id/filename per semplicità.
router.post('/:id/media/:mediaId/crop', mediaUpload.single('file'), (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const m = postMedia.getMedia(req.params.mediaId);
  if (!m || m.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });
  if (m.kind !== 'image') return res.status(400).json({ error: 'Solo immagini possono essere croppate' });
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });

  try {
    const path = require('path');
    const fs = require('fs');
    const dest = path.join(postMedia.postDir(post.client_id, post.id), m.filename);
    // Sovrascrivi il file originale con il blob croppato
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    // Usa renameSync safe con EXDEV fallback via copyFile+unlink
    try {
      fs.renameSync(req.file.path, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(req.file.path, dest);
      fs.unlinkSync(req.file.path);
    }

    const stat = fs.statSync(dest);
    db.prepare(`UPDATE post_media SET bytes = ?, created_at = datetime('now') WHERE id = ?`).run(stat.size, m.id);

    // cache-bust: il client aggiungerà ?v=<updated_at>
    const updated = postMedia.getMedia(m.id);
    res.json({ media: updated });
  } catch (err) {
    console.error('[crop] error:', err.message);
    res.status(500).json({ error: 'Crop fallito', details: err.message });
  }
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

// Bulk update scheduled_time per N post (usato dal "Imposta orario default")
router.post('/bulk-time', (req, res) => {
  const db = getDb();
  const { post_ids, scheduled_time, only_unscheduled } = req.body;
  if (!Array.isArray(post_ids) || !post_ids.length) return res.status(400).json({ error: 'post_ids richiesti' });
  if (!scheduled_time || !/^\d{2}:\d{2}(:\d{2})?$/.test(scheduled_time)) {
    return res.status(400).json({ error: 'scheduled_time deve essere HH:MM' });
  }

  let sql = "UPDATE posts SET scheduled_time = ?, updated_at = datetime('now') WHERE id IN (" + post_ids.map(() => '?').join(',') + ")";
  const params = [scheduled_time, ...post_ids];
  if (only_unscheduled) {
    sql += " AND (scheduled_time IS NULL OR scheduled_time = '')";
  }
  const result = db.prepare(sql).run(...params);
  res.json({ updated: result.changes });
});

// Crea un nuovo post manualmente (es. aggiungere un post extra in una settimana)
router.post('/', (req, res) => {
  const db = getDb();
  const { client_id, editorial_plan_id, month_number, week_number, category, sub_topic, template, media_type, scheduled_date, scheduled_time } = req.body;

  if (!client_id) return res.status(400).json({ error: 'client_id richiesto' });
  if (!month_number || !week_number) return res.status(400).json({ error: 'month_number e week_number richiesti' });

  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const mt = MEDIA_TYPES.has(media_type) ? media_type : 'single_image';
  const id = uuidv4();
  db.prepare(`
    INSERT INTO posts (id, client_id, editorial_plan_id, month_number, week_number, category, sub_topic, template, media_type, scheduled_date, scheduled_time, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(
    id, client_id, editorial_plan_id || null,
    parseInt(month_number), parseInt(week_number),
    category || null, sub_topic || null,
    template || 'quote', mt,
    scheduled_date || null, scheduled_time || null
  );

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  res.status(201).json(post);
});

// Elimina un post (e i suoi media via cascade FK + cleanup file)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  // Cleanup file media su disco prima del DELETE (FK CASCADE elimina le righe DB)
  try { postMedia.removePostDir(post.client_id, post.id); }
  catch (err) { console.warn('[posts] cleanup post dir failed:', err.message); }

  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
