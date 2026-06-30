const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../lib/db');
const { authMiddleware } = require('../../lib/auth');
const { generateCaption } = require('../../lib/ai-provider');
const { publishPost, getPageToken, detectChannels } = require('../../lib/meta-publish');
const { notifyPublishFailed, notifyPublishPartial, sendSinglePostNotification } = require('../../lib/notifier');
const { snapshotPostInsights, getLatestInsights } = require('../../lib/insights');
const { renderImage } = require('../../lib/renderer');
const postMedia = require('../../lib/post-media');
const audit = require('../../lib/audit');
const geminiImage = require('../../lib/gemini-image');
const visualPrompt = require('../../lib/visual-prompt');
const { getEffectiveGeminiKey } = require('../../lib/settings');
const fs = require('fs');

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
    'ig_share_to_feed', 'week_number', 'cta_label', 'cta_url', 'mentions'];

  const { normalizeMentions } = require('../../lib/post-caption');
  const updates = [];
  const values = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      let val = req.body[field];
      if (field === 'image_data') val = JSON.stringify(val);
      // Menzioni: normalizza (stringa libera o array) → array di @handle pulito,
      // salvato come JSON. Vuoto → NULL (nessuna menzione).
      if (field === 'mentions') {
        const handles = normalizeMentions(val);
        val = handles.length ? JSON.stringify(handles) : null;
      }
      // CTA: stringhe corte, trim; vuoto → NULL.
      if (field === 'cta_label' || field === 'cta_url') {
        val = (typeof val === 'string' ? val.trim() : '').slice(0, 300) || null;
      }
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

// Invia al CLIENTE la notifica di un singolo post programmato (post evento ad-hoc
// già concordato). NON è una richiesta di approvazione cliente: marca il post come
// APPROVATO lato admin (così non resta bloccato dal publish guard) e invia un'email
// di anteprima del singolo contenuto, con EMC sempre in CC.
router.post('/:id/send-to-client', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const recipient = (req.body && req.body.to) || client.contact_email;
  if (!recipient) return res.status(400).json({ error: 'Cliente senza contact_email — configura il campo o passa { to: "..." }' });

  // Auto-approvazione admin: il post è già concordato col cliente → non deve
  // restare bloccato dal publish guard di un'eventuale approvazione mensile.
  db.prepare("UPDATE posts SET approval_status = 'approved', updated_at = datetime('now') WHERE id = ?").run(post.id);

  // Anteprima: primo media (immagine se disponibile), fallback image_url legacy
  const media = db.prepare('SELECT url, kind FROM post_media WHERE post_id = ? ORDER BY position LIMIT 1').get(post.id);
  const mediaUrl = (media && media.url) || post.image_url || null;
  const mediaKind = media ? media.kind : 'image';

  // Etichetta data programmazione in italiano (parse robusto YYYY-MM-DD)
  let scheduledLabel = 'da definire';
  if (post.scheduled_date) {
    const [y, m, d] = String(post.scheduled_date).split('-').map(Number);
    if (y && m && d) {
      scheduledLabel = new Date(y, m - 1, d).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
      if (post.scheduled_time) scheduledLabel += ' alle ' + post.scheduled_time;
    }
  }

  try {
    const r = await sendSinglePostNotification({ client, recipient, post, mediaUrl, mediaKind, scheduledLabel });
    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.sent_to_client',
      entity_type: 'post',
      entity_id: post.id,
      details: { recipient, scheduled: post.scheduled_date, category: post.category, sub_topic: post.sub_topic }
    });
    res.json({ ok: true, sent_to: r.sent_to, approved: true });
  } catch (err) {
    console.error('[send-to-client]', err.message);
    res.status(500).json({ error: 'Invio email fallito', details: err.message });
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

// Build visual prompt SENZA generare l'immagine. Serve all'editor manuale:
// l'utente vede il prompt auto-generato, lo affina, poi conferma → /generate-ai-image
// con `prompt` override. Evita di sprecare quote Gemini Image durante l'iterazione.
router.post('/:id/build-visual-prompt', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const validRatios = ['1:1', '4:5', '9:16', '16:9'];
  const aspectRatio = validRatios.includes(req.body && req.body.aspect_ratio) ? req.body.aspect_ratio : '1:1';

  try {
    // consumeRotation:false → la preview non avanza il last_visual_style_index;
    // verrà avanzato al momento della generazione vera (/generate-ai-image).
    const prompt = await visualPrompt.buildPrompt(client, post, aspectRatio, { consumeRotation: false });
    res.json({ prompt, aspect_ratio: aspectRatio });
  } catch (err) {
    console.error('[build-visual-prompt] error:', err.message);
    res.status(500).json({ error: 'Costruzione prompt fallita', details: err.message });
  }
});

// Traduce un prompt visivo (EN) in italiano per UX leggibile.
// Il prompt resta in inglese per qualità immagine, ma sotto la textarea
// l'utente vede "Cosa stai chiedendo all'AI" in italiano (sola lettura).
router.post('/:id/translate-prompt', async (req, res) => {
  const { callGemini } = require('../../lib/gemini');
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const promptText = String((req.body && req.body.prompt) || '').slice(0, 4000).trim();
  if (!promptText) return res.status(400).json({ error: 'prompt richiesto' });

  const apiKey = getEffectiveGeminiKey(client);
  if (!apiKey) return res.status(400).json({ error: 'Nessuna Gemini API key disponibile' });

  const sysInstr = `Traduci in italiano corrente questo prompt visivo per un AI image generator.
Output: SOLO la traduzione, una singola riga, senza prefissi tipo "Traduzione:" o virgolette.
Mantieni i termini tecnici fotografici comprensibili a un non addetto (es. "shallow depth of field" → "messa a fuoco selettiva", "bokeh" → "bokeh", "editorial photography" → "fotografia editoriale").
Non aggiungere spiegazioni, non parafrasare in modo eccessivo: l'obiettivo è che l'utente capisca cosa sta chiedendo all'AI.`;

  try {
    const { text } = await callGemini(apiKey, sysInstr, promptText, {
      temperature: 0.2,
      maxTokens: 500
    });
    const translation = (text || '').replace(/^["'`]|["'`]$/g, '').trim();
    if (!translation) return res.status(500).json({ error: 'Traduzione vuota' });
    res.json({ translation });
  } catch (err) {
    console.error('[translate-prompt] error:', err.message);
    res.status(500).json({ error: 'Traduzione fallita', details: err.message });
  }
});

// Generate AI image via Gemini Flash Image (NanoBanana2 = gemini-3.1-flash-image).
// Differente da /generate-image: niente template HTML, l'immagine è generata
// dall'AI a partire dalla caption + brand. Aspect ratio configurabile.
router.post('/:id/generate-ai-image', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const apiKey = getEffectiveGeminiKey(client);
  if (!apiKey) {
    return res.status(400).json({ error: 'Nessuna Gemini API key disponibile (né per il cliente né globale).' });
  }

  const validRatios = ['1:1', '4:5', '9:16', '16:9'];
  const aspectRatio = validRatios.includes(req.body && req.body.aspect_ratio) ? req.body.aspect_ratio : '1:1';
  // Override prompt opzionale: se l'utente vuole controllare manualmente bypassa
  // il visual-prompt builder e passa la stringa esatta a Gemini Image.
  const overridePrompt = (req.body && typeof req.body.prompt === 'string' && req.body.prompt.trim()) || null;

  try {
    let finalPrompt;
    if (overridePrompt) {
      finalPrompt = overridePrompt;
      // Override → buildPrompt non gira: avanzo la rotazione manualmente
      // così la prossima preview/generazione non ripete lo stesso stile.
      visualPrompt.advanceStyleRotation(client);
    } else {
      // buildPrompt consume la rotazione internamente (consumeRotation=true default)
      finalPrompt = await visualPrompt.buildPrompt(client, post, aspectRatio);
    }
    const { buffer, mime } = await geminiImage.generateForPost(apiKey, finalPrompt, aspectRatio);

    // Scrivi su tmp e attacca come post_media generato
    const ext = mime === 'image/png' ? '.png' : '.jpg';
    const tmpPath = path.join(os.tmpdir(), `sig-aiimg-${uuidv4()}${ext}`);
    fs.writeFileSync(tmpPath, buffer);

    let media;
    try {
      media = postMedia.attachGeneratedFile({
        clientId: post.client_id,
        postId: post.id,
        absolutePath: tmpPath,
        source: 'ai',
        kind: 'image'
      });
    } catch (err) {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      throw err;
    }

    // Normalizza per Meta (flatten alpha, strip ICC) — già JPEG flatten dal nostro
    // sharp pipeline, ma chiamiamo per sicurezza e per popolare width/height nel DB.
    try {
      const dest = path.join(postMedia.postDir(post.client_id, post.id), media.filename);
      await postMedia.normalizeImageForMeta(dest);
      const imageSize = require('image-size');
      const dim = imageSize(dest);
      if (dim && dim.width && dim.height) {
        db.prepare('UPDATE post_media SET width = ?, height = ?, bytes = ? WHERE id = ?')
          .run(dim.width, dim.height, fs.statSync(dest).size, media.id);
        media = postMedia.getMedia(media.id);
      }
    } catch (e) { console.warn('[generate-ai-image] post-process failed:', e.message); }

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.ai_image_generated',
      entity_type: 'post',
      entity_id: post.id,
      details: { aspect_ratio: aspectRatio, prompt_used: finalPrompt.substring(0, 200) }
    });

    res.json({ media, prompt: finalPrompt, aspect_ratio: aspectRatio });
  } catch (err) {
    console.error('[generate-ai-image] error:', err.message);
    res.status(500).json({ error: 'Generazione AI fallita', details: err.message });
  }
});

// Generate AI video slideshow Ken Burns: N immagini AI animate con zoom/pan +
// crossfade via ffmpeg. Costo = N immagini (~$0.04 × N), niente API video.
// Output salvato come post_media kind='video' source='ai_video'.
const videoSlideshow = require('../../lib/video-slideshow');
const veoVideo = require('../../lib/veo-video');

// Build prompt video Veo (preview senza generare). Speculare a /build-visual-prompt
// ma usa il system instruction cinematografico (camera movement + ambient sound).
router.post('/:id/build-video-prompt', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const aspectRatio = (req.body && req.body.aspect_ratio) === '16:9' ? '16:9' : '9:16';
  try {
    const prompt = await visualPrompt.buildVideoPrompt(client, post, aspectRatio);
    res.json({ prompt, aspect_ratio: aspectRatio });
  } catch (err) {
    console.error('[build-video-prompt] error:', err.message);
    res.status(500).json({ error: 'Costruzione prompt fallita', details: err.message });
  }
});

// Submit job Veo 3. Ritorna immediatamente con operation_name. Il frontend
// poi polla /check-veo-status ogni N secondi finché ready, perché Veo richiede
// 1-3 min e supererebbe il timeout del proxy (Caddy/Coolify ~60s).
router.post('/:id/generate-veo-video', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const apiKey = getEffectiveGeminiKey(client);
  if (!apiKey) {
    return res.status(400).json({ error: 'Nessuna Gemini API key disponibile (né per il cliente né globale).' });
  }

  const aspectRatio = (req.body && req.body.aspect_ratio) === '16:9' ? '16:9' : '9:16';
  const durationSeconds = Math.max(4, Math.min(8, parseInt(req.body && req.body.duration_seconds, 10) || 8));
  const modelVariant = (req.body && req.body.model_variant) === 'fast' ? 'fast' : 'standard';
  const overridePrompt = (req.body && typeof req.body.prompt === 'string' && req.body.prompt.trim()) || null;

  try {
    const finalPrompt = overridePrompt || await visualPrompt.buildVideoPrompt(client, post, aspectRatio);
    const job = await veoVideo.submitJob(apiKey, finalPrompt, {
      aspectRatio, durationSeconds, modelVariant
    });

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.veo_video_submitted',
      entity_type: 'post',
      entity_id: post.id,
      details: {
        operation_name: job.opName, model: job.model,
        aspect_ratio: aspectRatio, duration_seconds: durationSeconds,
        prompt_used: finalPrompt.substring(0, 200)
      }
    });

    res.json({
      operation_name: job.opName,
      model: job.model,
      prompt: finalPrompt,
      aspect_ratio: aspectRatio,
      duration_seconds: durationSeconds,
      model_variant: modelVariant
    });
  } catch (err) {
    console.error('[generate-veo-video] submit error:', err.message);
    res.status(500).json({ error: 'Submit Veo fallito', details: err.message });
  }
});

// Polling status di un job Veo. Se done=true scarica il video, lo attacca come
// post_media kind='video' source='veo' e ritorna il media. Altrimenti { done: false }.
router.post('/:id/check-veo-status', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const apiKey = getEffectiveGeminiKey(client);
  if (!apiKey) {
    return res.status(400).json({ error: 'Nessuna Gemini API key disponibile (né per il cliente né globale).' });
  }

  const opName = req.body && req.body.operation_name;
  if (!opName || typeof opName !== 'string') {
    return res.status(400).json({ error: 'operation_name richiesto' });
  }

  let videoTmpPath = null;
  try {
    const status = await veoVideo.checkOperation(apiKey, opName);
    if (!status.done) return res.json({ done: false });

    // Done: scarica binario, salva, attach
    const { buffer } = await veoVideo.fetchCompletedVideo(apiKey, status.response);
    videoTmpPath = path.join(os.tmpdir(), `sig-veo-${uuidv4()}.mp4`);
    fs.writeFileSync(videoTmpPath, buffer);

    const media = postMedia.attachGeneratedFile({
      clientId: post.client_id,
      postId: post.id,
      absolutePath: videoTmpPath,
      source: 'veo',
      kind: 'video'
    });
    videoTmpPath = null;

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.veo_video_completed',
      entity_type: 'post',
      entity_id: post.id,
      details: { operation_name: opName, media_id: media.id }
    });

    res.json({ done: true, media });
  } catch (err) {
    console.error('[check-veo-status] error:', err.message);
    res.status(500).json({ error: 'Check Veo fallito', details: err.message });
  } finally {
    if (videoTmpPath) {
      try { if (fs.existsSync(videoTmpPath)) fs.unlinkSync(videoTmpPath); } catch (_) {}
    }
  }
});

router.post('/:id/generate-ai-video', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const apiKey = getEffectiveGeminiKey(client);
  if (!apiKey) {
    return res.status(400).json({ error: 'Nessuna Gemini API key disponibile (né per il cliente né globale).' });
  }

  const validRatios = ['1:1', '4:5', '9:16', '16:9'];
  const aspectRatio = validRatios.includes(req.body && req.body.aspect_ratio) ? req.body.aspect_ratio : '9:16';
  const numClips = Math.max(2, Math.min(6, parseInt(req.body && req.body.num_clips, 10) || 3));
  const clipDuration = Math.max(2, Math.min(8, parseInt(req.body && req.body.clip_duration, 10) || 4));
  // Override prompts opzionale: array di stringhe (uno per clip). Se non fornito,
  // visual-prompt costruisce N varianti automatiche.
  const overridePrompts = Array.isArray(req.body && req.body.prompts) && req.body.prompts.length
    ? req.body.prompts.slice(0, numClips).map(p => String(p).trim()).filter(Boolean)
    : null;

  // Audio: due sorgenti supportate
  //  - Libreria globale: filename relativo a public/music/ (sanitized da music.js)
  //  - Libreria cliente: prefisso "client:<library_item_id>" (audio in client_media_library)
  let audioPath = null;
  if (req.body && req.body.audio_filename && typeof req.body.audio_filename === 'string') {
    const raw = req.body.audio_filename;
    if (raw.startsWith('client:')) {
      const clientLibrary = require('../../lib/client-library');
      const itemId = raw.slice('client:'.length);
      const item = clientLibrary.getLibraryItem(itemId);
      // Sicurezza: audio del cliente OPPURE marcato come condiviso (is_shared=1).
      if (item && item.kind === 'audio' && (item.client_id === post.client_id || item.is_shared)) {
        const candidate = path.join(clientLibrary.libraryDir(item.client_id, 'audio'), item.filename);
        if (fs.existsSync(candidate)) audioPath = candidate;
      }
      if (!audioPath) console.warn('[generate-ai-video] audio cliente non valido:', raw);
    } else {
      const af = raw.replace(/[^a-zA-Z0-9._-]/g, '');
      const musicDir = path.join(__dirname, '..', '..', 'public', 'music');
      const candidate = path.resolve(musicDir, af);
      if (candidate.startsWith(path.resolve(musicDir) + path.sep) && fs.existsSync(candidate)) {
        audioPath = candidate;
      } else {
        console.warn('[generate-ai-video] audio_filename non valido o non trovato:', raw);
      }
    }
  }

  const tmpFiles = [];
  try {
    // Step 1: costruisci N prompt
    const prompts = (overridePrompts && overridePrompts.length === numClips)
      ? overridePrompts
      : await visualPrompt.buildVariationPrompts(client, post, aspectRatio, numClips);

    // Step 2: genera N immagini in parallelo (riusa geminiImage)
    const imageBuffers = await Promise.all(prompts.map(p =>
      geminiImage.generateForPost(apiKey, p, aspectRatio)
    ));

    // Step 3: scrivi su tmp
    const imagePaths = imageBuffers.map((img) => {
      const ext = img.mime === 'image/png' ? '.png' : '.jpg';
      const tmpPath = path.join(os.tmpdir(), `sig-aivid-frame-${uuidv4()}${ext}`);
      fs.writeFileSync(tmpPath, img.buffer);
      tmpFiles.push(tmpPath);
      return tmpPath;
    });

    // Step 4: ffmpeg slideshow Ken Burns (con audio se selezionato)
    const videoTmp = path.join(os.tmpdir(), `sig-aivid-${uuidv4()}.mp4`);
    tmpFiles.push(videoTmp);
    const result = await videoSlideshow.createSlideshow(imagePaths, {
      aspectRatio, clipDuration, outputPath: videoTmp, audioPath
    });

    // Step 5: attacca come post_media kind='video'
    let media;
    try {
      media = postMedia.attachGeneratedFile({
        clientId: post.client_id,
        postId: post.id,
        absolutePath: videoTmp,
        source: 'ai_video',
        kind: 'video'
      });
      // attachGeneratedFile fa moveSync, quindi videoTmp non esiste più
      const idx = tmpFiles.indexOf(videoTmp); if (idx >= 0) tmpFiles.splice(idx, 1);
    } catch (err) {
      throw err;
    }

    // Aggiorna width/height/duration nel DB (post_media ha le colonne)
    try {
      db.prepare('UPDATE post_media SET width = ?, height = ? WHERE id = ?')
        .run(result.width, result.height, media.id);
      media = postMedia.getMedia(media.id);
    } catch (e) { console.warn('[generate-ai-video] dim update failed:', e.message); }

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.ai_video_generated',
      entity_type: 'post',
      entity_id: post.id,
      details: {
        aspect_ratio: aspectRatio, num_clips: numClips, clip_duration: clipDuration,
        duration_sec: result.durationSec, audio: audioPath ? path.basename(audioPath) : null
      }
    });

    // Opzionale: copia in libreria del cliente per riuso futuro.
    let libraryItem = null;
    if (req.body && req.body.save_to_library) {
      try {
        const clientLibrary = require('../../lib/client-library');
        const srcVideo = path.join(postMedia.postDir(post.client_id, post.id), media.filename);
        if (fs.existsSync(srcVideo)) {
          const tmpCopy = path.join(os.tmpdir(), `sig-libauto-${uuidv4()}${path.extname(media.filename)}`);
          fs.copyFileSync(srcVideo, tmpCopy);
          libraryItem = await clientLibrary.addFromUpload({
            clientId: post.client_id,
            tmpPath: tmpCopy,
            originalName: media.filename,
            mimetype: 'video/mp4'
          });
          audit.logFromReq(req, {
            client_id: post.client_id,
            action: 'library.saved_from_post',
            entity_type: 'library_item',
            entity_id: libraryItem.id,
            details: { post_id: post.id, source_media_id: media.id, auto: true }
          });
        }
      } catch (e) {
        console.warn('[generate-ai-video] save_to_library failed:', e.message);
      }
    }

    res.json({
      media, aspect_ratio: aspectRatio, num_clips: numClips,
      clip_duration: clipDuration, duration_sec: result.durationSec, prompts,
      audio: audioPath ? path.basename(audioPath) : null,
      library_item: libraryItem
    });
  } catch (err) {
    console.error('[generate-ai-video] error:', err.message);
    res.status(500).json({ error: 'Generazione video AI fallita', details: err.message });
  } finally {
    // Cleanup tmp residui (immagini frame + eventuale video se attach fallito)
    for (const f of tmpFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
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

  // channels: array opzionale tipo ['fb'], ['ig'], ['linkedin'], combinazioni.
  // Default: tutti i canali per cui il cliente ha credenziali configurate.
  let channels;
  if (Array.isArray(req.body.channels) && req.body.channels.length) {
    channels = req.body.channels.filter(c => ['fb', 'ig', 'linkedin', 'tiktok'].includes(c));
  } else {
    channels = detectChannels(client); // auto-rileva, coerente con lo scheduler
  }

  // Re-entrancy guard: condiviso con lo scheduler tramite `inFlightPosts`.
  // Senza questo:
  //  - admin clicca "Pubblica" → publishPost gira 30-90s (es. video IG con polling)
  //  - tick scheduler (ogni 60s) trova lo stesso post in 'ready' e lo pubblica di nuovo
  //  → doppia pubblicazione su FB/IG.
  // Già il blocco status='published' al termine impedisce ulteriori tentativi,
  // ma durante il publish manuale lo status DB è ancora 'ready'.
  const { inFlightPosts } = require('../../lib/scheduler');
  if (inFlightPosts.has(post.id)) {
    return res.status(409).json({ error: 'Pubblicazione già in corso per questo post — attendi qualche secondo e ricarica la pagina.' });
  }
  inFlightPosts.add(post.id);

  try {
    const result = await publishPost(client, { ...post, media_type: mediaType }, media, { channels });

    const anyOk = result.fb_post_id || result.ig_media_id || result.linkedin_post_id || result.tiktok_publish_id;
    const status = anyOk ? 'published' : 'failed';
    const publishErrorMsg = status === 'failed' && !result.errors.length
      ? 'Publish fallito: nessun canale ha pubblicato'
      : (result.errors.length ? result.errors.join('; ') : null);
    db.prepare(`
      UPDATE posts SET
        status = ?,
        fb_post_id = ?,
        ig_media_id = ?,
        linkedin_post_id = ?,
        tiktok_publish_id = ?,
        published_at = datetime('now'),
        publish_error = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      status,
      result.fb_post_id,
      result.ig_media_id,
      result.linkedin_post_id,
      result.tiktok_publish_id,
      publishErrorMsg,
      post.id
    );

    // Email admin su errori (fire-and-forget, non blocca la risposta UI)
    if (status === 'failed') {
      notifyPublishFailed(post, client, publishErrorMsg)
        .catch(e => console.error('[notifier] publish failed notify error:', e.message));
    } else if (status === 'published' && result.errors.length) {
      // Partial success: un canale OK, l'altro fallito (solo se utente NON ha deselezionato il canale)
      notifyPublishPartial(post, client, result)
        .catch(e => console.error('[notifier] publish partial notify error:', e.message));
    }

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: status === 'published' ? 'post.published_manual' : 'post.publish_failed',
      entity_type: 'post',
      entity_id: post.id,
      details: {
        channels,
        fb_post_id: result.fb_post_id || null,
        ig_media_id: result.ig_media_id || null,
        errors: result.errors && result.errors.length ? result.errors : null,
        category: post.category, sub_topic: post.sub_topic
      }
    });

    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
    res.json({ post: updated, publish_result: result });
  } catch (err) {
    // Eccezione non catturata dal flusso normale (es. crash Puppeteer, errore DB)
    notifyPublishFailed(post, client, 'Exception: ' + err.message)
      .catch(e => console.error('[notifier] publish exception notify error:', e.message));
    res.status(500).json({ error: 'Publishing failed', details: err.message });
  } finally {
    inFlightPosts.delete(post.id);
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

// Aggancia un video dalla libreria del cliente al post (copia indipendente:
// cancellando dalla libreria il post non si rompe).
// Body: { library_item_id }
router.post('/:id/library-attach', async (req, res) => {
  const clientLibrary = require('../../lib/client-library');
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const itemId = req.body && req.body.library_item_id;
  if (!itemId) return res.status(400).json({ error: 'library_item_id richiesto' });

  const item = clientLibrary.getLibraryItem(itemId);
  if (!item || (item.client_id !== post.client_id && !item.is_shared)) {
    return res.status(404).json({ error: 'Item libreria non trovato per questo cliente' });
  }
  if (item.kind !== 'video' && item.kind !== 'image') {
    return res.status(400).json({ error: 'Solo video o immagini possono essere agganciati ai post (gli audio si selezionano nel modal Reel AI)' });
  }

  try {
    // Copia il file in una cartella temporanea poi lascia che attachGeneratedFile
    // lo sposti nella post dir come "library-<uuid>.<ext>".
    const tmpDest = path.join(os.tmpdir(), `sig-libattach-${uuidv4()}${path.extname(item.filename)}`);
    clientLibrary.copyToPostDir({
      libraryItem: item,
      destDir: path.dirname(tmpDest),
      destFilename: path.basename(tmpDest)
    });
    const media = postMedia.attachGeneratedFile({
      clientId: post.client_id,
      postId: post.id,
      absolutePath: tmpDest,
      source: 'library',
      kind: item.kind
    });
    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.media.library_attached',
      entity_type: 'post_media',
      entity_id: media.id,
      details: { library_item_id: item.id }
    });
    res.json({ media });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-scelta immagini da libreria: dato un post con caption, sceglie dalla
// libreria del cliente le immagini più coerenti (vision-tagging cachato + match
// AI) e le allega automaticamente. Solo single_image (1) e carousel (N).
router.post('/:id/auto-pick-library-images', async (req, res) => {
  const clientLibrary = require('../../lib/client-library');
  const libraryMatch = require('../../lib/library-match');
  const imageSize = require('image-size');
  const db = getDb();

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const apiKey = getEffectiveGeminiKey(client);
  if (!apiKey) return res.status(400).json({ error: 'Nessuna Gemini API key disponibile (né per il cliente né globale).' });

  const caption = (post.caption || '').trim();
  if (!caption) return res.status(400).json({ error: 'Il post non ha una caption: genera o scrivi prima la caption, serve per scegliere le immagini più pertinenti.' });

  const mediaType = post.media_type || 'single_image';
  if (mediaType !== 'single_image' && mediaType !== 'carousel') {
    return res.status(400).json({ error: 'La scelta automatica da libreria è disponibile solo per i post di tipo Singola immagine o Carousel.' });
  }
  const reqCount = parseInt(req.body && req.body.count, 10);
  const count = mediaType === 'carousel'
    ? Math.min(10, Math.max(1, Number.isFinite(reqCount) ? reqCount : 3))
    : 1;

  try {
    const context = { brand: client.display_name, sector: client.sector };
    const stats = await libraryMatch.ensureImageDescriptions(client.id, apiKey, context);

    const picks = await libraryMatch.pickImagesForCaption({ caption, clientId: client.id, count, apiKey });
    if (!picks.length) {
      const msg = stats.total === 0
        ? 'La libreria immagini di questo cliente è vuota: carica prima qualche foto.'
        : 'Nessuna immagine della libreria risulta abbastanza coerente con la caption.';
      return res.json({ attached: [], analyzed: stats.analyzed, remaining: stats.remaining, total: stats.total, message: msg });
    }

    const attached = [];
    for (const pk of picks) {
      const item = pk.item;
      const tmpDest = path.join(os.tmpdir(), `sig-autopick-${uuidv4()}${path.extname(item.filename)}`);
      clientLibrary.copyToPostDir({
        libraryItem: item,
        destDir: path.dirname(tmpDest),
        destFilename: path.basename(tmpDest)
      });
      const media = postMedia.attachGeneratedFile({
        clientId: post.client_id,
        postId: post.id,
        absolutePath: tmpDest,
        source: 'library',
        kind: 'image'
      });
      // Normalizza per Meta + popola width/height/bytes
      try {
        const dest = path.join(postMedia.postDir(post.client_id, post.id), media.filename);
        await postMedia.normalizeImageForMeta(dest);
        const dim = imageSize(dest);
        if (dim && dim.width && dim.height) {
          db.prepare('UPDATE post_media SET width = ?, height = ?, bytes = ? WHERE id = ?')
            .run(dim.width, dim.height, fs.statSync(dest).size, media.id);
        }
      } catch (e) { console.warn('[auto-pick-library] post-process failed:', e.message); }

      attached.push({
        media_id: media.id,
        library_item_id: item.id,
        original_name: item.original_name,
        reason: pk.reason
      });
    }

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.library.auto_picked',
      entity_type: 'post',
      entity_id: post.id,
      details: { count: attached.length, analyzed: stats.analyzed, item_ids: attached.map(a => a.library_item_id) }
    });

    res.json({ attached, analyzed: stats.analyzed, remaining: stats.remaining, total: stats.total });
  } catch (err) {
    console.error('[auto-pick-library] error:', err.message);
    res.status(500).json({ error: 'Scelta automatica da libreria fallita', details: err.message });
  }
});

// Salva un media del post (video o immagine) nella libreria del cliente.
// Crea una COPIA del file, così cancellare il media dal post non rompe la libreria.
router.post('/:id/media/:mediaId/save-to-library', async (req, res) => {
  const clientLibrary = require('../../lib/client-library');
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const m = postMedia.getMedia(req.params.mediaId);
  if (!m || m.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });

  // Per ora salviamo in libreria solo i video (richiesta utente).
  if (m.kind !== 'video') {
    return res.status(400).json({ error: 'Solo i video possono essere salvati in libreria' });
  }

  try {
    const srcPath = path.join(postMedia.postDir(post.client_id, post.id), m.filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'File sorgente non trovato' });

    // Copio in tmp e poi addFromUpload sposta+registra. Manteniamo l'originale nel post.
    const tmpDest = path.join(os.tmpdir(), `sig-libsave-${uuidv4()}${path.extname(m.filename)}`);
    fs.copyFileSync(srcPath, tmpDest);

    const item = await clientLibrary.addFromUpload({
      clientId: post.client_id,
      tmpPath: tmpDest,
      originalName: m.filename,
      mimetype: 'video/mp4'
    });
    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'library.saved_from_post',
      entity_type: 'library_item',
      entity_id: item.id,
      details: { post_id: post.id, source_media_id: m.id }
    });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sostituisce la traccia audio di un video del post con un audio scelto
// dalla libreria cliente o dalla libreria globale, opzionalmente con trim e
// con loop automatico se l'audio è più corto del video.
//
// Body:
//   audio_source: "client:<libraryItemId>" | "<filename in /music/>"
//   start_sec: number (default 0)
//   end_sec: number | null (null = fino a fine traccia)
//   mode: "overwrite" (default) | "duplicate"
router.post('/:id/media/:mediaId/replace-audio', async (req, res) => {
  const clientLibrary = require('../../lib/client-library');
  const audioReplace = require('../../lib/audio-replace');
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const m = postMedia.getMedia(req.params.mediaId);
  if (!m || m.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });
  if (m.kind !== 'video') return res.status(400).json({ error: 'Solo i video possono avere l\'audio sostituito' });

  const raw = req.body && req.body.audio_source;
  if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'audio_source richiesto' });

  // Risolvi audio source con stesso pattern di /generate-ai-video.
  let audioPath = null;
  let audioLabel = '';
  if (raw.startsWith('client:')) {
    const itemId = raw.slice('client:'.length);
    const item = clientLibrary.getLibraryItem(itemId);
    if (item && item.kind === 'audio' && (item.client_id === post.client_id || item.is_shared)) {
      const candidate = path.join(clientLibrary.libraryDir(item.client_id, 'audio'), item.filename);
      if (fs.existsSync(candidate)) { audioPath = candidate; audioLabel = item.original_name || item.filename; }
    }
  } else {
    const af = raw.replace(/[^a-zA-Z0-9._-]/g, '');
    const musicDir = path.join(__dirname, '..', '..', 'public', 'music');
    const candidate = path.resolve(musicDir, af);
    if (candidate.startsWith(path.resolve(musicDir) + path.sep) && fs.existsSync(candidate)) {
      audioPath = candidate;
      audioLabel = af;
    }
  }
  if (!audioPath) return res.status(400).json({ error: 'Audio non trovato o non accessibile' });

  const startSec = Number(req.body.start_sec) || 0;
  const endSec = (req.body.end_sec === null || req.body.end_sec === undefined || req.body.end_sec === '')
    ? null : Number(req.body.end_sec);
  const mode = req.body.mode === 'duplicate' ? 'duplicate' : 'overwrite';

  const srcVideo = path.join(postMedia.postDir(post.client_id, post.id), m.filename);
  if (!fs.existsSync(srcVideo)) return res.status(404).json({ error: 'File video sorgente non trovato' });

  const tmpOut = path.join(os.tmpdir(), `sig-audio-replace-${uuidv4()}.mp4`);
  try {
    await audioReplace.replaceVideoAudio({
      videoPath: srcVideo,
      audioPath,
      startSec,
      endSec,
      outputPath: tmpOut
    });

    let result;
    if (mode === 'overwrite') {
      // Sovrascrivi il file fisico, mantieni la riga DB con stesso id/position.
      fs.copyFileSync(tmpOut, srcVideo);
      try { fs.unlinkSync(tmpOut); } catch (_) {}
      const stat = fs.statSync(srcVideo);
      db.prepare('UPDATE post_media SET bytes = ? WHERE id = ?').run(stat.size, m.id);
      result = postMedia.getMedia(m.id);
    } else {
      // Crea nuovo media (next position) puntando all'originale via styled_from_id.
      result = postMedia.attachGeneratedFile({
        clientId: post.client_id,
        postId: post.id,
        absolutePath: tmpOut,
        source: 'audio_dub',
        styledFromId: m.id,
        kind: 'video'
      });
      // attachGeneratedFile fa moveSync, quindi tmpOut non esiste più
      // Copia anche width/height del media originale (no re-encode video → stesse dim)
      if (m.width && m.height) {
        db.prepare('UPDATE post_media SET width = ?, height = ? WHERE id = ?')
          .run(m.width, m.height, result.id);
        result = postMedia.getMedia(result.id);
      }
    }

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.audio_replaced',
      entity_type: 'post_media',
      entity_id: m.id,
      details: {
        post_id: post.id,
        source_audio: audioLabel,
        audio_source_raw: raw,
        start_sec: startSec,
        end_sec: endSec,
        mode,
        new_media_id: mode === 'duplicate' ? result.id : null
      }
    });

    res.json({ media: result, mode });
  } catch (err) {
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (_) {}
    console.error('[replace-audio] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ritaglia un video del post tra start_sec e end_sec.
// Body:
//   start_sec: number (default 0)
//   end_sec: number (richiesto)
//   mode: "overwrite" (default) | "duplicate"
router.post('/:id/media/:mediaId/trim', async (req, res) => {
  const videoTrim = require('../../lib/video-trim');
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const m = postMedia.getMedia(req.params.mediaId);
  if (!m || m.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });
  if (m.kind !== 'video') return res.status(400).json({ error: 'Solo i video possono essere trimmati' });

  const startSec = Math.max(0, Number(req.body && req.body.start_sec) || 0);
  const endSec = Number(req.body && req.body.end_sec);
  if (!isFinite(endSec) || endSec <= startSec) {
    return res.status(400).json({ error: 'start_sec / end_sec non validi' });
  }
  const mode = req.body.mode === 'duplicate' ? 'duplicate' : 'overwrite';

  const srcVideo = path.join(postMedia.postDir(post.client_id, post.id), m.filename);
  if (!fs.existsSync(srcVideo)) return res.status(404).json({ error: 'File video sorgente non trovato' });

  const tmpOut = path.join(os.tmpdir(), `sig-trim-${uuidv4()}.mp4`);
  try {
    const trimResult = await videoTrim.trimVideo({
      videoPath: srcVideo,
      startSec, endSec,
      outputPath: tmpOut
    });

    let result;
    if (mode === 'overwrite') {
      fs.copyFileSync(tmpOut, srcVideo);
      try { fs.unlinkSync(tmpOut); } catch (_) {}
      const stat = fs.statSync(srcVideo);
      db.prepare('UPDATE post_media SET bytes = ? WHERE id = ?').run(stat.size, m.id);
      result = postMedia.getMedia(m.id);
    } else {
      result = postMedia.attachGeneratedFile({
        clientId: post.client_id,
        postId: post.id,
        absolutePath: tmpOut,
        source: 'trimmed',
        styledFromId: m.id,
        kind: 'video'
      });
      // Stesse dimensioni del video originale (no scale)
      if (m.width && m.height) {
        db.prepare('UPDATE post_media SET width = ?, height = ? WHERE id = ?')
          .run(m.width, m.height, result.id);
        result = postMedia.getMedia(result.id);
      }
    }

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.video_trimmed',
      entity_type: 'post_media',
      entity_id: m.id,
      details: {
        post_id: post.id,
        start_sec: startSec,
        end_sec: endSec,
        new_duration_sec: trimResult.durationSec,
        mode,
        new_media_id: mode === 'duplicate' ? result.id : null
      }
    });

    res.json({ media: result, mode, duration_sec: trimResult.durationSec });
  } catch (err) {
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (_) {}
    console.error('[trim] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Anima un'immagine del post in un video Reel via Ken Burns slideshow
// (1 sola immagine, durata configurabile, audio opzionale con trim+loop).
// L'immagine originale resta nel post; il video viene aggiunto come nuovo media.
//
// Body:
//   duration_sec: 3-8 (default 5)
//   aspect_ratio: '9:16' | '1:1' | '4:5' | '16:9' (default 9:16)
//   audio_source: "client:<id>" | "<filename in /music/>" | null
//   audio_start_sec: number (default 0, ignored se no audio)
//   audio_end_sec: number | null (null = fino a fine traccia)
router.post('/:id/media/:mediaId/animate-image', async (req, res) => {
  const clientLibrary = require('../../lib/client-library');
  const { spawn } = require('child_process');
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const m = postMedia.getMedia(req.params.mediaId);
  if (!m || m.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });
  if (m.kind !== 'image') return res.status(400).json({ error: 'Solo le immagini possono essere animate in Reel' });

  const validRatios = ['1:1', '4:5', '9:16', '16:9'];
  const aspectRatio = validRatios.includes(req.body && req.body.aspect_ratio) ? req.body.aspect_ratio : '9:16';
  const duration = Math.max(3, Math.min(8, parseInt(req.body && req.body.duration_sec, 10) || 5));

  const srcImage = path.join(postMedia.postDir(post.client_id, post.id), m.filename);
  if (!fs.existsSync(srcImage)) return res.status(404).json({ error: 'File immagine sorgente non trovato' });

  // Risolvi audio source (stesso pattern di /generate-ai-video e /replace-audio)
  let audioPathRaw = null;
  let audioLabel = '';
  const rawAudio = req.body && req.body.audio_source;
  if (rawAudio && typeof rawAudio === 'string') {
    if (rawAudio.startsWith('client:')) {
      const itemId = rawAudio.slice('client:'.length);
      const item = clientLibrary.getLibraryItem(itemId);
      if (item && item.kind === 'audio' && (item.client_id === post.client_id || item.is_shared)) {
        const candidate = path.join(clientLibrary.libraryDir(item.client_id, 'audio'), item.filename);
        if (fs.existsSync(candidate)) { audioPathRaw = candidate; audioLabel = item.original_name || item.filename; }
      }
    } else {
      const af = rawAudio.replace(/[^a-zA-Z0-9._-]/g, '');
      const musicDir = path.join(__dirname, '..', '..', 'public', 'music');
      const candidate = path.resolve(musicDir, af);
      if (candidate.startsWith(path.resolve(musicDir) + path.sep) && fs.existsSync(candidate)) {
        audioPathRaw = candidate;
        audioLabel = af;
      }
    }
    if (!audioPathRaw) console.warn('[animate-image] audio non valido:', rawAudio);
  }

  // Se è richiesto un trim audio, pre-trimmo in un file temporaneo.
  // createSlideshow looppa l'audio passato con -stream_loop -1, quindi
  // gli passiamo già il segmento desiderato.
  const tmpFiles = [];
  let audioPath = audioPathRaw;
  if (audioPathRaw) {
    const startSec = Math.max(0, Number(req.body.audio_start_sec) || 0);
    const endVal = req.body.audio_end_sec;
    const endSec = (endVal == null || endVal === '') ? null : Number(endVal);
    if (startSec > 0 || endSec != null) {
      const trimmedTmp = path.join(os.tmpdir(), `sig-anim-audio-${uuidv4()}${path.extname(audioPathRaw)}`);
      const args = ['-y', '-i', audioPathRaw, '-ss', startSec.toFixed(3)];
      if (endSec != null) args.push('-to', endSec.toFixed(3));
      args.push('-c:a', 'copy', trimmedTmp);
      try {
        await new Promise((resolve, reject) => {
          const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          p.stderr.on('data', (c) => { stderr += c.toString(); });
          p.on('close', (code) => code === 0 ? resolve() : reject(new Error('audio trim ' + code + ': ' + stderr.split('\n').slice(-5).join('\n'))));
          p.on('error', reject);
        });
        audioPath = trimmedTmp;
        tmpFiles.push(trimmedTmp);
      } catch (err) {
        return res.status(500).json({ error: 'Trim audio fallito: ' + err.message });
      }
    }
  }

  const videoTmp = path.join(os.tmpdir(), `sig-anim-${uuidv4()}.mp4`);
  tmpFiles.push(videoTmp);

  try {
    const slideshowResult = await videoSlideshow.createSlideshow([srcImage], {
      aspectRatio,
      clipDuration: duration,
      outputPath: videoTmp,
      audioPath
    });

    const newMedia = postMedia.attachGeneratedFile({
      clientId: post.client_id,
      postId: post.id,
      absolutePath: videoTmp,
      source: 'animated_from_image',
      styledFromId: m.id,
      kind: 'video'
    });
    // attachGeneratedFile fa moveSync: videoTmp è stato spostato
    const idx = tmpFiles.indexOf(videoTmp);
    if (idx >= 0) tmpFiles.splice(idx, 1);

    db.prepare('UPDATE post_media SET width = ?, height = ? WHERE id = ?')
      .run(slideshowResult.width, slideshowResult.height, newMedia.id);
    const result = postMedia.getMedia(newMedia.id);

    audit.logFromReq(req, {
      client_id: post.client_id,
      action: 'post.image_animated',
      entity_type: 'post_media',
      entity_id: m.id,
      details: {
        post_id: post.id,
        source_image_id: m.id,
        new_media_id: newMedia.id,
        aspect_ratio: aspectRatio,
        duration_sec: duration,
        audio_source: audioLabel || null
      }
    });

    res.json({ media: result, duration_sec: duration });
  } catch (err) {
    console.error('[animate-image] error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    for (const f of tmpFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  }
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

// Bust: rinomina il file con nuovo UUID per generare un URL completamente nuovo.
// Necessario quando Meta ha cachato il path come "non valido" e ignora i nuovi
// tentativi anche dopo aver sistemato il file. Il cache buster ?v= non basta:
// Meta usa il path come chiave cache.
router.post('/:id/media/:mediaId/bust-url', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const m = postMedia.getMedia(req.params.mediaId);
  if (!m || m.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });

  try {
    const path = require('path');
    const fs = require('fs');
    const { v4: uuidv4 } = require('uuid');
    const dir = postMedia.postDir(post.client_id, post.id);
    const oldPath = path.join(dir, m.filename);
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File non trovato' });

    const ext = path.extname(m.filename);
    // Nuovo UUID, mantiene il prefisso (upload/styled/generated/transcoded)
    const oldBase = path.basename(m.filename, ext);
    const prefix = oldBase.split('-')[0]; // upload, styled, ecc.
    const newId = uuidv4();
    const newFilename = `${prefix}-${newId}${ext}`;
    const newPath = path.join(dir, newFilename);
    const newUrl = postMedia.publicUrl(post.client_id, post.id, newFilename);

    fs.renameSync(oldPath, newPath);
    db.prepare(`UPDATE post_media SET filename = ?, url = ?, created_at = datetime('now') WHERE id = ?`)
      .run(newFilename, newUrl, m.id);

    res.json({ media: postMedia.getMedia(m.id), old_filename: m.filename, new_filename: newFilename });
  } catch (err) {
    console.error('[bust-url] error:', err.message);
    res.status(500).json({ error: 'Bust URL fallito', details: err.message });
  }
});

// Normalize: re-encode il file con sharp strippando ICC profile / EXIF.
// Utile quando Meta rifiuta un file apparentemente OK (errore 9004 "Only
// photo/video accepted") perché ha metadata che non riesce a parsare.
//
// Query opzionali:
//   ?target_width=N → upscale (o keep) a almeno N pixel di larghezza.
//                     Meta raccomanda 1080+ per single-image, file più piccoli
//                     possono essere rifiutati silenziosamente.
router.post('/:id/media/:mediaId/normalize', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id, client_id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const m = postMedia.getMedia(req.params.mediaId);
  if (!m || m.post_id !== post.id) return res.status(404).json({ error: 'Media not found' });
  if (m.kind !== 'image') return res.status(400).json({ error: 'Solo immagini possono essere normalizzate' });

  try {
    const path = require('path');
    const fs = require('fs');
    const filePath = path.join(postMedia.postDir(post.client_id, post.id), m.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File non trovato sul disco' });

    const targetWidth = parseInt(req.query.target_width, 10);

    let result;
    if (targetWidth > 0) {
      // Upscale + normalize in un colpo solo
      const sharp = require('sharp');
      const meta = await sharp(filePath).metadata();
      let pipeline = sharp(filePath).toColorspace('srgb');
      if (meta.format === 'png' && meta.hasAlpha) pipeline = pipeline.flatten({ background: '#ffffff' });
      if (meta.width < targetWidth) {
        pipeline = pipeline.resize(targetWidth, null, { kernel: 'lanczos3', withoutEnlargement: false });
      }
      pipeline = (meta.format === 'jpeg')
        ? pipeline.jpeg({ quality: 92, mozjpeg: false, progressive: false })
        : pipeline.png({ compressionLevel: 9, palette: false });
      const buf = await pipeline.toBuffer();
      fs.writeFileSync(filePath, buf);
      const newMeta = await sharp(filePath).metadata();
      result = { changed: true, format: meta.format, hadAlpha: !!meta.hasAlpha, hadIcc: !!meta.icc, original_width: meta.width, new_width: newMeta.width, new_height: newMeta.height };
    } else {
      result = await postMedia.normalizeImageForMeta(filePath);
    }

    if (result.changed) {
      const stat = fs.statSync(filePath);
      // Aggiorna anche width/height se sono cambiate (upscale)
      const sharp = require('sharp');
      const meta = await sharp(filePath).metadata();
      db.prepare(`UPDATE post_media SET bytes = ?, width = ?, height = ?, created_at = datetime('now') WHERE id = ?`)
        .run(stat.size, meta.width, meta.height, m.id);
    }
    res.json({ media: postMedia.getMedia(m.id), result });
  } catch (err) {
    console.error('[normalize] error:', err.message);
    res.status(500).json({ error: 'Normalize fallito', details: err.message });
  }
});

// Crop / edit: sovrascrive il file del media con il blob croppato ricevuto dal client.
// IMPORTANTE: Cropper.js può ritornare un BLOB con tipo diverso dall'originale
// (es. JPEG anche se il file originale era PNG). Express.static serve il file
// con Content-Type basato sull'extension → mismatch tra Content-Type dichiarato
// e payload reale → Meta rifiuta al publish (errore "Only photo/video accepted").
// Soluzione: detectiamo il MIME effettivo del blob e rinominiamo se necessario.
router.post('/:id/media/:mediaId/crop', mediaUpload.single('file'), async (req, res) => {
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

    // Detect MIME effettivo dal contenuto del blob ricevuto (sniffing magic bytes).
    // file-type v16: usa fromBuffer (no fileTypeFromFile, quello è v17+ ESM).
    let detectedExt = path.extname(m.filename); // fallback: estensione attuale
    try {
      const FileType = require('file-type');
      const fd = fs.openSync(req.file.path, 'r');
      const head = Buffer.alloc(4100);
      fs.readSync(fd, head, 0, 4100, 0);
      fs.closeSync(fd);
      const detected = await FileType.fromBuffer(head);
      if (detected) {
        if (detected.mime === 'image/jpeg') detectedExt = '.jpg';
        else if (detected.mime === 'image/png') detectedExt = '.png';
        else if (detected.mime === 'image/webp') detectedExt = '.webp';
      }
    } catch (e) { console.warn('[crop] file-type detect failed:', e.message); }

    // Calcola nuovo filename: cambia solo l'extension se il MIME è cambiato.
    // Mantiene lo stesso prefisso/uuid per non perdere la traccia.
    const oldExt = path.extname(m.filename);
    const baseName = path.basename(m.filename, oldExt);
    const newFilename = baseName + detectedExt;
    const dir = postMedia.postDir(post.client_id, post.id);
    const dest = path.join(dir, newFilename);
    const oldPath = path.join(dir, m.filename);

    // Cancella sia il vecchio file (se nome diverso) sia eventuale dest esistente
    if (oldPath !== dest && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);

    try {
      fs.renameSync(req.file.path, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(req.file.path, dest);
      fs.unlinkSync(req.file.path);
    }

    // Normalizza per Meta: flatten alpha PNG + strip metadata (ICC, EXIF)
    await postMedia.normalizeImageForMeta(dest);

    const stat = fs.statSync(dest);
    let w = null, h = null;
    try {
      const imageSize = require('image-size');
      const dim = imageSize(dest);
      if (dim && dim.width && dim.height) { w = dim.width; h = dim.height; }
    } catch (e) { console.warn('[crop] image-size failed:', e.message); }

    // Aggiorna record con eventuali nuovi filename/url se l'extension è cambiata
    const newUrl = postMedia.publicUrl(post.client_id, post.id, newFilename);
    db.prepare(`UPDATE post_media
                SET filename = ?, url = ?, bytes = ?, width = ?, height = ?, created_at = datetime('now')
                WHERE id = ?`)
      .run(newFilename, newUrl, stat.size, w, h, m.id);

    const updated = postMedia.getMedia(m.id);
    res.json({ media: updated, mime_changed: oldExt !== detectedExt });
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

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(post.client_id);

  const template = req.body.template || 'image-overlay';
  const includeCaption = req.body.include_caption !== false;     // default true
  const variant = ['badge','watermark','banner','none'].includes(req.body.variant) ? req.body.variant : 'badge';
  const position = ['tl','tr','bl','br','c'].includes(req.body.logo_position) ? req.body.logo_position : 'tr';
  const showBrandName = req.body.show_brand_name !== false;       // default true
  const showTagline = !!req.body.show_tagline;                    // default false

  const escHtml = s => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

  // Costruisci HEADER_BLOCK in base alle scelte utente. Per variant=none
  // nessun overlay logo (solo immagine + caption opzionale).
  let headerBlock = '';
  if (variant !== 'none' && client) {
    const brandName = client.brand_name || client.display_name || '';
    const tagline = client.tagline || '';
    const showLogoOnly = !showBrandName && !(showTagline && tagline);
    const textParts = [];
    if (showBrandName && brandName) textParts.push(`<span class="brand-name">${escHtml(brandName)}</span>`);
    if (showTagline && tagline) textParts.push(`<span class="brand-tagline">${escHtml(tagline)}</span>`);
    const textBlock = textParts.length ? `<div class="brand-text">${textParts.join('')}</div>` : '';
    headerBlock = `<div class="header var-${variant} pos-${position}">{{LOGO_SVG}}${textBlock}</div>`;
  }

  const captionSnippet = includeCaption && post.caption
    ? post.caption.split('\n')[0].slice(0, 240)
    : '';

  const data = {
    image_url: orig.url,
    header_block: headerBlock,
    caption_block: captionSnippet
      ? `<div class="caption-strip">${captionSnippet.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>`
      : '',
    title: post.sub_topic || post.category || '',
    description: post.caption ? post.caption.split('\n')[0].slice(0, 240) : ''
  };

  try {
    const { filePath } = await renderImage(template, post.client_id, data);
    // Normalizza output Puppeteer: flatten alpha + strip metadata
    await postMedia.normalizeImageForMeta(filePath);
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

// Resetta scheduled_date a NULL per tutti i post di un mese del piano.
// Utile per ridistribuire da zero dopo un errore di distribuzione.
// Non tocca i post 'published' (sono già stati pubblicati e la data è storica).
router.post('/bulk-clear-dates', (req, res) => {
  const db = getDb();
  const { plan_id, month } = req.body;
  if (!plan_id || !Number.isInteger(parseInt(month))) {
    return res.status(400).json({ error: 'plan_id e month richiesti' });
  }
  const r = db.prepare(`
    UPDATE posts SET scheduled_date = NULL, updated_at = datetime('now')
    WHERE editorial_plan_id = ? AND month_number = ?
      AND status != 'published' AND scheduled_date IS NOT NULL
  `).run(plan_id, parseInt(month));
  res.json({ cleared: r.changes });
});

// Distribuisce le date dei post di un mese. Due modalità:
//  mode='weeks' (legacy): 4 settimane consecutive da start_date — può andare a
//    cavallo di due mesi calendario.
//  mode='calendar_month' (consigliato): distribuisce i post sui giorni del mese
//    CALENDARIO corrispondente (editorial_plans.start_year_month + month-1) che
//    cadono nei weekday consentiti. Garantisce che il "Mese N del piano" coincida
//    con un singolo mese calendario.
//
//  Body comune:
//    - plan_id, month: scopa i post al mese corrente del piano
//    - weekdays: array di interi 1-7 (1=lun ... 7=dom)
//    - only_unscheduled: se true, aggiorna solo i post senza scheduled_date
//    - mode: 'weeks' | 'calendar_month' (default 'weeks' per retro-compat)
//  Mode-specific:
//    - mode='weeks': start_date YYYY-MM-DD richiesto
//    - mode='calendar_month': nessun start_date (deriva da plan.start_year_month)
router.post('/bulk-distribute-dates', (req, res) => {
  const db = getDb();
  const { plan_id, month, start_date, weekdays, only_unscheduled, mode } = req.body;
  if (!plan_id || !Number.isInteger(parseInt(month))) return res.status(400).json({ error: 'plan_id e month richiesti' });
  if (!Array.isArray(weekdays) || !weekdays.length) return res.status(400).json({ error: 'weekdays richiesto (almeno un giorno)' });
  const sortedWd = [...new Set(weekdays.map(n => parseInt(n, 10)))].filter(n => Number.isInteger(n) && n >= 1 && n <= 7).sort((a, b) => a - b);
  if (!sortedWd.length) return res.status(400).json({ error: 'weekdays: interi 1-7 (1=lun)' });

  const monthNum = parseInt(month);
  const useCalendar = mode === 'calendar_month';

  const posts = db.prepare(`
    SELECT id, week_number, position, scheduled_date FROM posts
    WHERE editorial_plan_id = ? AND month_number = ?
    ORDER BY week_number ASC, position ASC, created_at ASC
  `).all(plan_id, monthNum);

  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const upd = db.prepare(`UPDATE posts SET scheduled_date = ?, updated_at = datetime('now') WHERE id = ?`);
  let updated = 0;

  if (useCalendar) {
    // Carica il piano per leggere start_year_month
    const plan = db.prepare('SELECT start_year_month FROM editorial_plans WHERE id = ?').get(plan_id);
    if (!plan || !plan.start_year_month) {
      return res.status(400).json({ error: 'Modalità "Mese calendario" richiede start_year_month sul piano. Imposta il mese di partenza dal plan-editor.' });
    }
    const { resolveCalendarMonth } = require('../../lib/month-labels');
    const cal = resolveCalendarMonth(monthNum, plan.start_year_month);
    if (!cal) return res.status(400).json({ error: 'Impossibile risolvere il mese calendario' });

    // Elenca i giorni del mese che cadono nei weekday consentiti
    const lastDay = new Date(cal.year, cal.month, 0).getDate();
    const candidates = [];
    for (let d = 1; d <= lastDay; d++) {
      const date = new Date(cal.year, cal.month - 1, d);
      const dow = date.getDay() === 0 ? 7 : date.getDay(); // 1=lun..7=dom
      if (sortedWd.includes(dow)) candidates.push(date);
    }
    if (!candidates.length) {
      return res.status(400).json({ error: `Nessun giorno valido in ${cal.label} con i weekday selezionati.` });
    }
    // Distribuisci i post sui candidati, evenly spaced
    const target = posts.filter(p => !only_unscheduled || !p.scheduled_date);
    const N = target.length;
    const tx = db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const idx = N === 1 ? 0 : Math.round(i * (candidates.length - 1) / Math.max(N - 1, 1));
        const d = candidates[Math.min(idx, candidates.length - 1)];
        upd.run(fmt(d), target[i].id);
        updated++;
      }
    });
    tx();
    return res.json({ updated, total: posts.length, mode: 'calendar_month', calendar_month: cal.label, candidates_count: candidates.length });
  }

  // Modalità 'weeks' (legacy)
  if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return res.status(400).json({ error: 'start_date deve essere YYYY-MM-DD' });
  const start = new Date(start_date + 'T00:00:00');
  if (isNaN(start.getTime())) return res.status(400).json({ error: 'start_date invalida' });
  const startDow = start.getDay() === 0 ? 7 : start.getDay();
  const startMonday = new Date(start); startMonday.setDate(start.getDate() - (startDow - 1));

  const indexInWeek = new Map();
  const counters = {};
  for (const p of posts) {
    const w = p.week_number || 1;
    counters[w] = counters[w] || 0;
    indexInWeek.set(p.id, counters[w]++);
  }

  const tx = db.transaction(() => {
    for (const p of posts) {
      if (only_unscheduled && p.scheduled_date) continue;
      const idx = indexInWeek.get(p.id) || 0;
      const weekday = sortedWd[idx % sortedWd.length];
      const week = (p.week_number || 1) - 1;
      const d = new Date(startMonday);
      d.setDate(d.getDate() + week * 7 + (weekday - 1));
      upd.run(fmt(d), p.id);
      updated++;
    }
  });
  tx();
  res.json({ updated, total: posts.length, mode: 'weeks' });
});

// Segna in stato 'ready' tutti i post indicati che soddisfano le pre-condizioni:
//   - caption non vuota
//   - almeno un media (post_media OR image_url legacy)
//   - se il cliente ha IG configurato: TUTTE le immagini devono avere aspect ratio
//     nel range [0.8, 1.91] (verticale 4:5 → orizzontale 1.91:1), altrimenti IG
//     rifiuta al publish con "Proporzioni non valide"
// I post che non passano vengono ritornati nel summary con il motivo.
// Body: { post_ids: [...], force?: boolean } — force salta TUTTE le validazioni.
router.post('/bulk-ready', (req, res) => {
  const db = getDb();
  const { post_ids, force } = req.body;
  if (!Array.isArray(post_ids) || !post_ids.length) return res.status(400).json({ error: 'post_ids richiesti' });

  const placeholders = post_ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT p.id, p.caption, p.image_url, p.status, p.client_id, c.ig_user_id
    FROM posts p LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id IN (${placeholders})
  `).all(...post_ids);
  const mediaStmt = db.prepare(`
    SELECT id, kind, width, height FROM post_media WHERE post_id = ? ORDER BY position ASC
  `);
  const IG_MIN_RATIO = 0.8, IG_MAX_RATIO = 1.91;

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
        const mediaList = mediaStmt.all(p.id);
        const hasMedia = !!p.image_url || mediaList.length > 0;
        if (!hasCaption) { skipped.push({ id: p.id, reason: 'caption mancante' }); continue; }
        if (!hasMedia)   { skipped.push({ id: p.id, reason: 'nessun media' }); continue; }
        // Validazione aspect ratio Instagram: solo se il cliente ha IG configurato
        if (p.ig_user_id) {
          const badImage = mediaList.find(m => {
            if (m.kind !== 'image' || !m.width || !m.height) return false;
            const r = m.width / m.height;
            return r < IG_MIN_RATIO || r > IG_MAX_RATIO;
          });
          if (badImage) {
            const r = (badImage.width / badImage.height).toFixed(2);
            skipped.push({ id: p.id, reason: `proporzioni ${r}:1 (${badImage.width}x${badImage.height}) fuori range IG — croppa a 1:1 o 4:5` });
            continue;
          }
        }
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

// Elimina un post (e i suoi media via cascade FK + cleanup file).
// Guard: i post pubblicati non possono essere eliminati dall'utente standard.
// Per la futura gerarchia ruoli, l'admin avrà un override (header X-Admin-Force
// o ruolo nel JWT) — per ora blocco tutti.
router.delete('/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT id, client_id, status FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (post.status === 'published') {
    return res.status(403).json({
      error: 'Questo post è già stato pubblicato e non può essere eliminato. Per rimuoverlo contatta l\u2019amministratore.',
      code: 'POST_PUBLISHED_LOCKED'
    });
  }

  try { postMedia.removePostDir(post.client_id, post.id); }
  catch (err) { console.warn('[posts] cleanup post dir failed:', err.message); }

  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  audit.logFromReq(req, {
    client_id: post.client_id,
    action: 'post.deleted',
    entity_type: 'post',
    entity_id: post.id,
    details: { previous_status: post.status }
  });
  res.json({ success: true });
});

module.exports = router;
