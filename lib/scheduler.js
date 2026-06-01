const cron = require('node-cron');
const { getDb } = require('./db');
const { publishPost, getPageToken, detectChannels } = require('./meta-publish');
const { notifyPublishFailed, notifyPublishPartial } = require('./notifier');
const { snapshotPostInsights, snapshotAccountInsights } = require('./insights');
const postMedia = require('./post-media');
const audit = require('./audit');

let task = null;
let insightsTask = null;
let monthlyReportTask = null;

// Lock in-memory: previene doppio publish dello stesso post quando il cron tick
// (ogni 60s) si sovrappone a un publish in corso (es. video IG con polling che
// dura 2-3 minuti). Senza questo, la stessa riga DB `status='ready'` viene
// ri-letta dal tick successivo prima che il primo abbia finito.
// Il lock vive solo in memoria: se il container crasha durante il publish,
// lo status DB resta 'ready' e verrà ripreso al restart (comportamento voluto).
const inFlightPosts = new Set();

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

  // Report PDF mensile: gira OGNI giorno alle 09:00 Europe/Rome e invia solo
  // se oggi è l'ULTIMO giorno del mese (gestisce 28/29/30/31 senza hardcodare il
  // giorno). Invia il report del mese che si sta chiudendo ai clienti con piano
  // attivo (subscription_plan valorizzato).
  monthlyReportTask = cron.schedule('0 9 * * *', async () => {
    try {
      const nowRome = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
      const tomorrow = new Date(nowRome);
      tomorrow.setDate(nowRome.getDate() + 1);
      const isLastDayOfMonth = tomorrow.getMonth() !== nowRome.getMonth();
      if (!isLastDayOfMonth) return; // non è fine mese → niente invio oggi
      await sendMonthlyReports();
    } catch (err) {
      console.error('[monthly-report-cron] Error:', err.stack || err.message);
    }
  }, { timezone: 'Europe/Rome' });

  console.log('[scheduler] Auto-publish scheduler started (every 60s)');
  console.log('[scheduler] Insights refresh cron started (daily 04:00)');
  console.log('[scheduler] Monthly PDF report cron started (ultimo giorno del mese, 09:00 Europe/Rome)');
}

/**
 * Refresh insights — post recenti + snapshot account-level per ogni cliente
 * con FB Page configurata.
 *
 * Raggruppa per cliente per riusare il Page Token una volta sola.
 * L'account snapshot è idempotente (UNIQUE su client/platform/date).
 */
async function refreshAllInsights() {
  const db = getDb();

  // Post pubblicati negli ultimi 30 giorni (per cui ha senso rifare fetch)
  const posts = db.prepare(`
    SELECT p.id, p.client_id, p.fb_post_id, p.ig_media_id,
      c.fb_page_id, c.fb_system_user_token
    FROM posts p
    JOIN clients c ON c.id = p.client_id
    WHERE p.status = 'published'
      AND (p.fb_post_id IS NOT NULL OR p.ig_media_id IS NOT NULL)
      AND p.published_at > datetime('now', '-30 days')
  `).all();

  // Tutti i clienti attivi con token + page: serve per lo snapshot account
  // anche quando non ci sono post recenti (es. cliente nuovo, follower growth).
  const clientsRaw = db.prepare(`
    SELECT id, display_name, fb_page_id, ig_user_id, fb_system_user_token
    FROM clients
    WHERE status != 'archived' AND deleted_at IS NULL
      AND fb_system_user_token IS NOT NULL
      AND fb_page_id IS NOT NULL
  `).all();

  // Raggruppa post per cliente (solo quelli con credenziali) + unisci clientsRaw
  const byClient = {};
  clientsRaw.forEach(c => {
    byClient[c.id] = {
      client: c,
      token: c.fb_system_user_token,
      pageId: c.fb_page_id,
      posts: []
    };
  });
  posts.forEach(p => {
    if (!byClient[p.client_id]) return; // cliente archiviato o senza credenziali
    byClient[p.client_id].posts.push(p);
  });

  let postOk = 0, postErr = 0, accOk = 0, accErr = 0;
  for (const [clientId, group] of Object.entries(byClient)) {
    let pageToken;
    try {
      pageToken = await getPageToken(group.token, group.pageId);
    } catch (err) {
      console.warn(`[insights-cron] Page token ${clientId} failed:`, err.message);
      continue;
    }

    // Account snapshot (1 riga per platform per giorno)
    try {
      await snapshotAccountInsights(pageToken, group.client);
      accOk++;
    } catch (err) {
      accErr++;
      console.warn(`[insights-cron] account ${clientId}:`, err.message);
    }

    // Post insights (per i post pubblicati recenti)
    for (const p of group.posts) {
      try {
        await snapshotPostInsights(pageToken, p);
        postOk++;
      } catch (err) {
        postErr++;
        console.warn(`[insights-cron] post ${p.id}:`, err.message);
      }
    }
  }
  console.log(`[insights-cron] done: posts ${postOk} ok / ${postErr} err, accounts ${accOk} ok / ${accErr} err`);
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
      c.fb_page_id, c.fb_system_user_token, c.ig_user_id,
      c.linkedin_org_id, c.linkedin_access_token
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
    // Re-entrancy guard: se un tick precedente sta ancora pubblicando questo
    // post (es. video IG con polling di 3 minuti), lo skippiamo. Senza questo
    // check, il cron ogni 60s rivedrebbe il record DB ancora come 'ready' e
    // avvierebbe una seconda publish in parallelo → doppio post + possibile
    // inconsistenza ID.
    if (inFlightPosts.has(post.id)) {
      console.log(`[scheduler] Skip post ${post.id}: publish già in corso`);
      continue;
    }
    inFlightPosts.add(post.id);

    console.log(`[scheduler] Publishing post ${post.id} for client ${post.client_id}`);

    try {
      const client = {
        id: post._client_id,
        display_name: post._client_name,
        fb_page_id: post.fb_page_id,
        fb_system_user_token: post.fb_system_user_token,
        ig_user_id: post.ig_user_id,
        linkedin_org_id: post.linkedin_org_id,
        linkedin_access_token: post.linkedin_access_token
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

      // Auto-rileva i canali in base alle credenziali del cliente (FB/IG/LinkedIn),
      // coerente con l'endpoint di pubblicazione manuale. Senza questo i post
      // programmati andavano sempre solo su FB+IG, ignorando LinkedIn.
      const channels = detectChannels(client);
      const result = await publishPost(client, { ...post, media_type: mediaType }, media, { channels });

      // Fail se nessun canale (FB/IG/LinkedIn) ha pubblicato (a prescindere da
      // errors.length). Senza questa condizione, un publishPost "no-op silenzioso"
      // (es. credenziali mancanti) marcava il post come published con ID null.
      if (!result.fb_post_id && !result.ig_media_id && !result.linkedin_post_id && !result.tiktok_publish_id) {
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
            linkedin_post_id = ?,
            tiktok_publish_id = ?,
            published_at = datetime('now'),
            publish_error = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          result.fb_post_id,
          result.ig_media_id,
          result.linkedin_post_id,
          result.tiktok_publish_id,
          result.errors.length ? result.errors.join('; ') : null,
          post.id
        );
        console.log(`[scheduler] Published post ${post.id}: FB=${result.fb_post_id}, IG=${result.ig_media_id}, LI=${result.linkedin_post_id}, TT=${result.tiktok_publish_id}`);
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
    } finally {
      inFlightPosts.delete(post.id);
    }
  }
}

/**
 * Cron mensile: per ogni cliente con PIANO ATTIVO (subscription_plan) e
 * contact_email, genera il PDF report del mese CORRENTE (quello che si sta
 * chiudendo) e lo invia via email (con EMC sempre in CC).
 *
 * Invocato l'ULTIMO giorno del mese alle 09:00 Europe/Rome. Usa solo dati DB
 * locali (zero call Meta) — gli snapshot insights del mese sono già popolati
 * dal cron giornaliero refreshAllInsights.
 *
 * Idempotente all'interno della stessa esecuzione (ma non resistente a doppio
 * trigger del cron — node-cron schedula un'unica volta per pattern, quindi OK).
 */
async function sendMonthlyReports() {
  const db = getDb();

  // Calcola il mese CORRENTE (quello che si sta chiudendo) in timezone Europe/Rome.
  // Il cron invia l'ultimo giorno del mese, quindi il periodo coincide col mese in corso.
  const nowRome = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const monthStart = new Date(nowRome.getFullYear(), nowRome.getMonth(), 1);
  const monthEnd = new Date(nowRome.getFullYear(), nowRome.getMonth() + 1, 0); // ultimo giorno mese corrente
  const monthName = monthStart.toLocaleString('it-IT', { month: 'long', year: 'numeric', timeZone: 'Europe/Rome' });
  const periodLabel = monthName.charAt(0).toUpperCase() + monthName.slice(1); // es. "Maggio 2026"
  const daysInMonth = monthEnd.getDate();

  console.log(`[monthly-report-cron] start — periodo: ${periodLabel} (${daysInMonth} giorni)`);

  // Solo clienti attivi che hanno ESPLICITAMENTE abilitato il report mensile
  // (toggle monthly_report_enabled nel profilo) e con email destinatario configurata.
  const clients = db.prepare(`
    SELECT id, display_name, sector, location, logo_filename, contact_email
    FROM clients
    WHERE status != 'archived' AND deleted_at IS NULL
      AND monthly_report_enabled = 1
      AND contact_email IS NOT NULL
      AND contact_email != ''
  `).all();

  if (!clients.length) {
    console.log('[monthly-report-cron] Nessun cliente con report mensile attivo + contact_email — skip');
    return;
  }

  const insights = require('./insights');
  const { renderInsightsReportPdf } = require('./pdf');
  const { sendInsightsReport } = require('./notifier');
  const audit = require('./audit');

  let okCount = 0, skipCount = 0, errCount = 0;
  for (const client of clients) {
    try {
      const summary = insights.getAccountSummary(client.id, daysInMonth);
      // Skip se proprio non ci sono dati nel periodo (cliente nuovo, niente snapshot)
      if (!summary.fb && !summary.ig) {
        skipCount++;
        console.log(`[monthly-report-cron] SKIP ${client.id}: nessun dato insights nel periodo`);
        audit.logAsSystem({
          actor_label: 'monthly-report-cron', client_id: client.id,
          action: 'insights.report_skipped',
          entity_type: 'client', entity_id: client.id,
          details: { period: periodLabel, reason: 'no-data' }
        });
        continue;
      }

      const history = insights.getAccountInsightsHistory(client.id, daysInMonth);
      const topPosts = insights.getTopPosts(client.id, daysInMonth, 5);
      const kpis = insights.getPeriodKpis(client.id, daysInMonth);

      const pdfBuffer = await renderInsightsReportPdf(client, periodLabel, summary, history, topPosts, kpis);
      const filename = `report-${client.id}-${monthStart.toISOString().slice(0, 7)}.pdf`;

      await sendInsightsReport({
        client, recipient: client.contact_email, periodLabel, summary, pdfBuffer, filename
      });

      okCount++;
      audit.logAsSystem({
        actor_label: 'monthly-report-cron', client_id: client.id,
        action: 'insights.report_emailed',
        entity_type: 'client', entity_id: client.id,
        details: { period: periodLabel, recipient: client.contact_email, bytes: pdfBuffer.length }
      });
    } catch (err) {
      errCount++;
      console.error(`[monthly-report-cron] ERR ${client.id}:`, err.message);
      audit.logAsSystem({
        actor_label: 'monthly-report-cron', client_id: client.id,
        action: 'insights.report_failed',
        entity_type: 'client', entity_id: client.id,
        details: { period: periodLabel, error: err.message }
      });
    }
  }
  console.log(`[monthly-report-cron] done: ${okCount} ok, ${skipCount} skip, ${errCount} err su ${clients.length} clienti`);
}

function stop() {
  if (task) { task.stop(); task = null; }
  if (insightsTask) { insightsTask.stop(); insightsTask = null; }
  if (monthlyReportTask) { monthlyReportTask.stop(); monthlyReportTask = null; }
}

module.exports = { start, stop, checkAndPublish, refreshAllInsights, sendMonthlyReports, inFlightPosts };
