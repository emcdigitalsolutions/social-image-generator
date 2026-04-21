const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { generateCaption } = require('../../lib/ai-provider');
const { publishPost, getPageToken } = require('../../lib/meta-publish');
const { notifyPublishFailed, notifyPublishPartial } = require('../../lib/notifier');
const { snapshotPostInsights, getLatestInsights } = require('../../lib/insights');
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
    ORDER BY week_number ASC, position ASC, scheduled_date ASC, created_at ASC
  `).all(req.params.planId, parseInt(req.params.month));
  posts.forEach(p => { if (p.image_data) p.image_data = JSON.parse(p.image_data); });
  res.json(posts);
});

// Bulk reorder: aggiorna week_number + position per più post in una sola transazione.
// Body: { items: [{ id, week_number, position }, ...] }
// Tutti i post devono appartenere allo stesso editorial_plan_id (verifica di coerenza).
router.post('/bulk-reorder', (req, res) => {
  const db = getDb();
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  if (!items || !items.length) return res.status(400).json({ error: 'items richiesto' });

  // Verifica struttura items
  for (const it of items) {
    if (!it.id || typeof it.id !== 'string') return res.status(400).json({ error: 'item.id richiesto (string)' });
    const wn = parseInt(it.week_number, 10);
    const pos = parseInt(it.position, 10);
    if (!Number.isInteger(wn) || wn < 1 || wn > 5) return res.status(400).json({ error: 'item.week_number deve essere 1-5' });
    if (!Number.isInteger(pos) || pos < 0) return res.status(400).json({ error: 'item.position deve essere >= 0' });
  }

  // Verifica che tutti i post esistano e siano dello stesso plan
  const ids = items.map(i => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, editorial_plan_id FROM posts WHERE id IN (${placeholders})`).all(...ids);
  if (rows.length !== ids.length) return res.status(404).json({ error: 'Uno o più post non trovati' });
  const planIds = new Set(rows.map(r => r.editorial_plan_id));
  if (planIds.size !== 1) return res.status(400).json({ error: 'Tutti gli item devono appartenere allo stesso piano' });

  const upd = db.prepare(`UPDATE posts SET week_number = ?, position = ?, updated_at = datetime('now') WHERE id = ?`);
  const tx = db.transaction((list) => {
    for (const it of list) upd.run(parseInt(it.week_number, 10), parseInt(it.position, 10), it.id);
  });
  tx(items);

  res.json({ updated: items.length });
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
    'ig_share_to_feed', 'week_number'];

  const updates = [];
  const values = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      let val = req.body[field];
      if (field === 'image_data') val = JSON.stringify(val);
      if (field === 'week_number') {
        const n = parseInt(val, 10);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          return res.status(400).json({ error: 'week_number deve essere un intero tra 1 e 5' });
        }
        val = n;
      }
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

  // Approval guard: se esiste un'approvazione attiva per questo mese, il post
  // deve essere stato approvato dal cliente. Se non c'è approvazione (workflow
  // non usato), si procede senza vincoli per backward-compat.
  if (post.editorial_plan_id) {
    const ap = db.prepare('SELECT id FROM monthly_approvals WHERE editorial_plan_id = ? AND month_number = ?')
      .get(post.editorial_plan_id, post.month_number);
    if (ap && post.approval_status !== 'approved') {
      const stateLabel = post.approval_status === 'pending' ? 'in attesa di approvazione cliente'
        : post.approval_status === 'change_requested' ? 'cliente ha chiesto modifiche'
        : post.approval_status === 'rejected' ? 'rifiutato dal cliente' : post.approval_status;
      return res.status(400).json({ error: `Pubblicazione bloccata: il post è ${stateLabel}. Aspetta che il cliente lo approvi.` });
    }
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

    // Email admin su errori (fire-and-forget, non blocca la risposta UI)
    if (status === 'failed' && result.errors.length) {
      notifyPublishFailed(post, client, result.errors.join('; '))
        .catch(e => console.error('[notifier] publish failed notify error:', e.message));
    } else if (status === 'published' && result.errors.length) {
      // Partial success: un canale OK, l'altro fallito (solo se utente NON ha deselezionato il canale)
      notifyPublishPartial(post, client, result)
        .catch(e => console.error('[notifier] publish partial notify error:', e.message));
    }

    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    res.json({ post: updated, publish_result: result });
  } catch (err) {
    // Eccezione non catturata dal flusso normale (es. crash Puppeteer, errore DB)
    notifyPublishFailed(post, client, 'Exception: ' + err.message)
      .catch(e => console.error('[notifier] publish exception notify error:', e.message));
    res.status(500).json({ error: 'Publishing failed', details: err.message });
  }
});

// Bulk generate captions+images per N post.
// Caption: funziona per tutti i media_type (anche reel/story/carousel —
//   ha senso una caption per ognuno).
// Image: funziona SOLO per single_image. Per carousel/reel/story si fa
//   skip esplicito perché:
//   - carousel → l'utente carica N immagini lui
//   - reel     → richiede un video, non un'immagine generata da template
//   - story    → da pubblicare manualmente dal cliente, niente publish nostro
router.post('/bulk-generate', async (req, res) => {
  const db = getDb();
  const { post_ids, action } = req.body; // action: 'caption', 'image', 'both'

  if (!post_ids || !post_ids.length) {
    return res.status(400).json({ error: 'post_ids array required' });
  }
  if (!['caption', 'image', 'both'].includes(action)) {
    return res.status(400).json({ error: 'action deve essere caption, image o both' });
  }

  const results = [];
  const summary = { captions_ok: 0, images_ok: 0, skipped_image: 0, errors: 0 };

  for (const postId of post_ids) {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post) { results.push({ id: postId, error: 'Not found' }); summary.errors++; continue; }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
    const mediaType = post.media_type || 'single_image';
    const result = { id: postId, media_type: mediaType };

    try {
      if (action === 'caption' || action === 'both') {
        const captionResult = await generateCaption(client, post);
        db.prepare(`
          UPDATE posts SET caption = ?, caption_ai_raw = ?, status = 'caption_generated', updated_at = datetime('now')
          WHERE id = ?
        `).run(captionResult.text, JSON.stringify(captionResult.raw), postId);
        result.caption = 'ok';
        summary.captions_ok++;
      }

      if (action === 'image' || action === 'both') {
        if (mediaType !== 'single_image') {
          result.image = 'skipped';
          result.image_reason = `media_type=${mediaType}: ` + (
            mediaType === 'carousel' ? 'carica le immagini manualmente' :
            mediaType === 'reel'     ? 'serve un video MP4/MOV, non generabile da template' :
            mediaType === 'story'    ? 'storia: pubblicazione manuale dal cliente' :
            'tipo non gestito da bulk-generate'
          );
          summary.skipped_image++;
        } else {
          const currentPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
          const template = currentPost.template || 'quote';
          const data = {
            text: currentPost.caption ? currentPost.caption.split('\n')[0] : '',
            title: currentPost.sub_topic || currentPost.category || '',
            description: currentPost.caption ? currentPost.caption.split('\n')[0] : '',
            image_url: currentPost.source_image_url || ''
          };
          const { filename, filePath } = await renderImage(template, currentPost.client_id, data);
          const imageUrl = `${BASE_URL}/images/${currentPost.client_id}/${filename}`;
          db.prepare(`
            UPDATE posts SET image_url = ?, image_data = ?, status = 'image_generated', updated_at = datetime('now')
            WHERE id = ?
          `).run(imageUrl, JSON.stringify(data), postId);
          // Registra anche come post_media per la nuova UI (sposta il file in posts/{id}/)
          try {
            postMedia.attachGeneratedFile({
              clientId: currentPost.client_id, postId,
              absolutePath: filePath, source: 'generated', kind: 'image'
            });
          } catch (mErr) {
            console.warn('[bulk-generate] post_media attach failed:', mErr.message);
          }
          result.image = 'ok';
          summary.images_ok++;
        }
      }

      // Mark as ready solo per single_image con caption + immagine
      const finalPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      if ((finalPost.media_type || 'single_image') === 'single_image' && finalPost.caption && finalPost.image_url) {
        db.prepare("UPDATE posts SET status = 'ready', updated_at = datetime('now') WHERE id = ?").run(postId);
        result.ready = true;
      }

      result.success = true;
      results.push(result);
    } catch (err) {
      summary.errors++;
      console.error('[bulk-generate]', postId, err.message);
      results.push({ ...result, error: err.message });
    }
  }

  res.json({ results, summary });
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
router.post('/:id/media', mediaUpload.array('media', postMedia.MAX_CAROUSEL_ITEMS), async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nessun file caricato' });

  const created = [];
  const errors = [];
  for (const f of req.files) {
    try {
      const m = await postMedia.attachUploadedFile({
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
    // Rileggi dimensioni aggiornate (width/height/ratio cambiano dopo il crop!)
    let w = null, h = null;
    try {
      const imageSize = require('image-size');
      const dim = imageSize(dest);
      if (dim && dim.width && dim.height) { w = dim.width; h = dim.height; }
    } catch (e) { console.warn('[crop] image-size failed:', e.message); }
    db.prepare(`UPDATE post_media SET bytes = ?, width = ?, height = ?, created_at = datetime('now') WHERE id = ?`).run(stat.size, w, h, m.id);

    // cache-bust: il client aggiungerà ?v=<updated_at>
    const updated = postMedia.getMedia(m.id);
    res.json({ media: updated });
  } catch (err) {
    console.error('[crop] error:', err.message);
    res.status(500).json({ error: 'Crop fallito', details: err.message });
  }
});

// Rate limit per /stylize: max 3 chiamate/min per utente.
// Stylize è costoso (Puppeteer 5-10s di CPU). Senza limite, click ripetuti
// rapidi possono saturare il browser pool.
const stylizeWindow = new Map(); // userId -> [timestamps...]
function stylizeRateLimit(req, res, next) {
  const userId = req.user && req.user.id;
  if (!userId) return next();
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxPerWindow = 3;
  const arr = (stylizeWindow.get(userId) || []).filter(t => now - t < windowMs);
  if (arr.length >= maxPerWindow) {
    const retryAfter = Math.ceil((arr[0] + windowMs - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `Troppe richieste di stilizzazione (max ${maxPerWindow}/min). Riprova tra ${retryAfter}s.` });
  }
  arr.push(now);
  stylizeWindow.set(userId, arr);
  next();
}

// Stylize an existing image media via Puppeteer template overlay.
// Crea un NUOVO post_media con source='styled' e styled_from_id riferito all'originale.
router.post('/:id/media/:mediaId/stylize', stylizeRateLimit, async (req, res) => {
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

// Distribuisce le date dei post di un mese in base a:
//  - start_date: data di partenza (il lunedì della sua settimana segna la settimana 1)
//  - weekdays:   array di interi 1-7 (1=lun ... 7=dom) — i giorni settimanali "consentiti"
//  - plan_id, month: scopa i post al solo mese corrente
//  - only_unscheduled: se true, aggiorna solo i post senza scheduled_date
// Logica:
//  per ogni post, in base a (week_number, position):
//    weekday = weekdays_sorted[position % len(weekdays_sorted)]
//    date = startMonday + (week_number - 1) * 7 giorni + (weekday - 1) giorni
router.post('/bulk-distribute-dates', (req, res) => {
  const db = getDb();
  const { plan_id, month, start_date, weekdays, only_unscheduled } = req.body;
  if (!plan_id || !Number.isInteger(parseInt(month))) return res.status(400).json({ error: 'plan_id e month richiesti' });
  if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return res.status(400).json({ error: 'start_date deve essere YYYY-MM-DD' });
  if (!Array.isArray(weekdays) || !weekdays.length) return res.status(400).json({ error: 'weekdays richiesto (almeno un giorno)' });
  const sortedWd = [...new Set(weekdays.map(n => parseInt(n, 10)))].filter(n => Number.isInteger(n) && n >= 1 && n <= 7).sort((a, b) => a - b);
  if (!sortedWd.length) return res.status(400).json({ error: 'weekdays: interi 1-7 (1=lun)' });

  const start = new Date(start_date + 'T00:00:00');
  if (isNaN(start.getTime())) return res.status(400).json({ error: 'start_date invalida' });
  // Lunedì della settimana che contiene start_date
  const startDow = start.getDay() === 0 ? 7 : start.getDay(); // 1..7
  const startMonday = new Date(start); startMonday.setDate(start.getDate() - (startDow - 1));

  const posts = db.prepare(`
    SELECT id, week_number, position, scheduled_date FROM posts
    WHERE editorial_plan_id = ? AND month_number = ?
    ORDER BY week_number ASC, position ASC, created_at ASC
  `).all(plan_id, parseInt(month));

  // Numera position per settimana: alcuni post potrebbero avere position=0 tutti
  // (legacy). Rigeneriamo un indice sequenziale per (week).
  const indexInWeek = new Map(); // post.id -> idx
  const counters = {};
  for (const p of posts) {
    const w = p.week_number || 1;
    counters[w] = counters[w] || 0;
    indexInWeek.set(p.id, counters[w]++);
  }

  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const upd = db.prepare(`UPDATE posts SET scheduled_date = ?, updated_at = datetime('now') WHERE id = ?`);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const p of posts) {
      if (only_unscheduled && p.scheduled_date) continue;
      const idx = indexInWeek.get(p.id) || 0;
      const weekday = sortedWd[idx % sortedWd.length]; // 1..7
      const week = (p.week_number || 1) - 1;
      const d = new Date(startMonday);
      d.setDate(d.getDate() + week * 7 + (weekday - 1));
      upd.run(fmt(d), p.id);
      updated++;
    }
  });
  tx();
  res.json({ updated, total: posts.length });
});

// Segna in stato 'ready' tutti i post indicati che soddisfano le pre-condizioni
// (caption non vuota + almeno un media OR image_url legacy). I post che non passano
// vengono ritornati nel summary con il motivo — l'admin può sistemarli manualmente.
// Body: { post_ids: [...], force?: boolean } — force salta la validazione caption/media.
router.post('/bulk-ready', (req, res) => {
  const db = getDb();
  const { post_ids, force } = req.body;
  if (!Array.isArray(post_ids) || !post_ids.length) return res.status(400).json({ error: 'post_ids richiesti' });

  const placeholders = post_ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, caption, image_url, status FROM posts WHERE id IN (${placeholders})`).all(...post_ids);
  const mediaCount = db.prepare(`SELECT COUNT(*) AS n FROM post_media WHERE post_id = ?`);

  const updated = [], skipped = [];
  const upd = db.prepare("UPDATE posts SET status = 'ready', updated_at = datetime('now') WHERE id = ?");
  const tx = db.transaction(() => {
    for (const p of rows) {
      if (p.status === 'ready' || p.status === 'published') {
        skipped.push({ id: p.id, reason: 'già ' + p.status });
        continue;
      }
      if (!force) {
        const hasCaption = p.caption && p.caption.trim();
        const hasMedia = !!p.image_url || mediaCount.get(p.id).n > 0;
        if (!hasCaption) { skipped.push({ id: p.id, reason: 'caption mancante' }); continue; }
        if (!hasMedia)   { skipped.push({ id: p.id, reason: 'nessun media' }); continue; }
      }
      upd.run(p.id);
      updated.push(p.id);
    }
  });
  tx();
  res.json({ updated: updated.length, skipped });
});

// Imposta la stessa scheduled_date per più post in un colpo solo.
// Body: { post_ids: [...], scheduled_date: "YYYY-MM-DD", only_unscheduled: boolean }
router.post('/bulk-date', (req, res) => {
  const db = getDb();
  const { post_ids, scheduled_date, only_unscheduled } = req.body;
  if (!Array.isArray(post_ids) || !post_ids.length) return res.status(400).json({ error: 'post_ids richiesti' });
  if (!scheduled_date || !/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) {
    return res.status(400).json({ error: 'scheduled_date deve essere YYYY-MM-DD' });
  }
  // Valida che la data sia effettivamente valida (es. non 2026-02-30)
  const d = new Date(scheduled_date + 'T00:00:00');
  if (isNaN(d.getTime()) || scheduled_date !== d.toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Data non valida' });
  }

  let sql = "UPDATE posts SET scheduled_date = ?, updated_at = datetime('now') WHERE id IN (" + post_ids.map(() => '?').join(',') + ")";
  const params = [scheduled_date, ...post_ids];
  if (only_unscheduled) sql += " AND (scheduled_date IS NULL OR scheduled_date = '')";
  const result = db.prepare(sql).run(...params);
  res.json({ updated: result.changes });
});

// Insights di un post (ultimo snapshot, o refresh forzato via ?refresh=1)
router.get('/:id/insights', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.status !== 'published') return res.json({ insights: [], note: 'Post non ancora pubblicato' });

  const refresh = req.query.refresh === '1';
  if (refresh) {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
    if (!client || !client.fb_system_user_token || !client.fb_page_id) {
      return res.status(400).json({ error: 'Credenziali Meta del cliente mancanti' });
    }
    try {
      const pageToken = await getPageToken(client.fb_system_user_token, client.fb_page_id);
      await snapshotPostInsights(pageToken, post);
    } catch (err) {
      return res.status(500).json({ error: 'Refresh insights fallito', details: err.message });
    }
  }

  res.json({ insights: getLatestInsights(post.id) });
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
