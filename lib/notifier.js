const nodemailer = require('nodemailer');
const https = require('https');
const { URL } = require('url');
const { getSmtpConfig, getGoogleScriptUrl } = require('./settings');

let cachedConfig = null;
let cachedConfigJson = '';
let transporter = null;

function getTransporter() {
  const config = getSmtpConfig();
  if (!config.user || !config.pass) return null;

  // Ricrea transporter se la config e' cambiata
  const configJson = JSON.stringify(config);
  if (configJson !== cachedConfigJson) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass }
    });
    cachedConfig = config;
    cachedConfigJson = configJson;
  }

  return transporter;
}

function getRecipient() {
  const config = cachedConfig || getSmtpConfig();
  return config.notify_to || config.user;
}

// Invio via Google Apps Script (HTTPS POST, porta 443 — bypassa blocco SMTP Hetzner).
// Riusa lo stesso script dei form contatti dei siti EMC. Payload compatibile con lo
// script esistente: {site, name, email, phone, message}. Il messaggio include
// subject + html così l'admin li riceve comunque.
function sendViaGoogleScript(gasUrl, subject, html, smtpConfig, cc) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(gasUrl); } catch (e) { return reject(new Error('URL Google Script non valido')); }
    // NB: usiamo site='emcdigitalsolutions' perché lo script ha una lookup table
    // statica dei destinatari basata sul site e NON ha (ancora) un entry per
    // 'social-image-generator'. La mail finisce comunque su emcdigitalsolution@gmail.com
    // (stesso destinatario dei contact form di EMC). Il subject/body distinguono il tipo.
    const payload = JSON.stringify({
      site: 'emcdigitalsolutions',
      name: `[SIG] ${subject}`,
      email: (smtpConfig && smtpConfig.user) || 'noreply@emcdigitalsolutions.it',
      phone: '',
      message: html,
      cc: cc || ''
    });
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      // GAS spesso reindirizza con 302 verso googleusercontent.com — lo seguiamo manualmente
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 302 && res.headers.location) {
          // Segui il redirect
          https.get(res.headers.location, (r2) => {
            let d2 = ''; r2.on('data', c => d2 += c); r2.on('end', () => resolve({ status: r2.statusCode, body: d2 }));
          }).on('error', reject);
        } else if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`Google Script HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Google Script timeout')));
    req.write(payload);
    req.end();
  });
}

async function sendNotification(subject, html, cc) {
  // 1) Preferisci Google Apps Script se configurato (HTTPS, sempre raggiungibile)
  const gasUrl = getGoogleScriptUrl();
  if (gasUrl) {
    try {
      await sendViaGoogleScript(gasUrl, subject, html, getSmtpConfig(), cc);
      console.log(`[notifier] Email inviata via Google Script: ${subject}${cc ? ' (cc: ' + cc + ')' : ''}`);
      return;
    } catch (err) {
      console.error(`[notifier] Google Script fallito: ${err.message} — provo SMTP se configurato`);
    }
  }
  // 2) Fallback: SMTP classico
  const t = getTransporter();
  if (!t) {
    console.warn('[notifier] Né Google Script né SMTP configurati — notifica saltata');
    return;
  }
  try {
    const config = cachedConfig || getSmtpConfig();
    const mail = {
      from: `"Social Image Generator" <${config.user}>`,
      to: getRecipient(),
      subject,
      html
    };
    if (cc) mail.cc = cc;
    await t.sendMail(mail);
    console.log(`[notifier] Email inviata via SMTP: ${subject}${cc ? ' (cc: ' + cc + ')' : ''}`);
  } catch (err) {
    console.error(`[notifier] Errore invio email SMTP: ${err.message}`);
  }
}

function notifyPublishFailed(post, client, error) {
  const clientName = client.display_name || client.id || 'Sconosciuto';
  const subject = `[FALLITO] Pubblicazione post — ${clientName}`;
  const html = `
    <h2 style="color:#dc2626">Pubblicazione Fallita</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Cliente:</td><td>${clientName}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Categoria:</td><td>${post.category || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Sub-topic:</td><td>${post.sub_topic || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Data schedulata:</td><td>${post.scheduled_date || '—'} ${post.scheduled_time || ''}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Post ID:</td><td>${post.id}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;color:#dc2626">Errore:</td><td style="color:#dc2626">${error}</td></tr>
    </table>
    <p style="margin-top:16px;font-size:13px;color:#666">
      <a href="${process.env.BASE_URL || 'http://localhost:3100'}/dashboard/posts/${post.id}">Apri post nel dashboard</a>
    </p>`;
  return sendNotification(subject, html);
}

function notifyPublishPartial(post, client, result) {
  const clientName = client.display_name || client.id || 'Sconosciuto';
  const fbOk = !!result.fb_post_id;
  const igOk = !!result.ig_media_id;
  const subject = `[PARZIALE] Pubblicazione post — ${clientName}`;
  const html = `
    <h2 style="color:#d97706">Pubblicazione Parziale</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Cliente:</td><td>${clientName}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Categoria:</td><td>${post.category || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Data schedulata:</td><td>${post.scheduled_date || '—'} ${post.scheduled_time || ''}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Post ID:</td><td>${post.id}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Facebook:</td><td style="color:${fbOk ? '#16a34a' : '#dc2626'}">${fbOk ? 'OK — ' + result.fb_post_id : 'FALLITO'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Instagram:</td><td style="color:${igOk ? '#16a34a' : '#dc2626'}">${igOk ? 'OK — ' + result.ig_media_id : 'FALLITO'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;color:#d97706">Errori:</td><td style="color:#d97706">${result.errors.join('; ')}</td></tr>
    </table>
    <p style="margin-top:16px;font-size:13px;color:#666">
      <a href="${process.env.BASE_URL || 'http://localhost:3100'}/dashboard/posts/${post.id}">Apri post nel dashboard</a>
    </p>`;
  return sendNotification(subject, html);
}

function notifyApprovalAction(approval, plan, client, post, action, comment) {
  const clientName = client.display_name || client.id || 'Sconosciuto';
  const actionLabel = action === 'approved' ? 'APPROVATO'
    : action === 'change_requested' ? 'MODIFICA RICHIESTA'
    : action === 'rejected' ? 'RIFIUTATO'
    : 'AZIONE';
  const color = action === 'approved' ? '#16a34a'
    : action === 'change_requested' ? '#d97706'
    : action === 'rejected' ? '#dc2626' : '#374151';
  const subject = `[${actionLabel}] ${clientName} — Mese ${approval.month_number} — ${post.category || ''} ${post.sub_topic || ''}`.trim();
  const html = `
    <h2 style="color:${color}">Cliente ${clientName}: post ${actionLabel.toLowerCase()}</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Cliente:</td><td>${clientName}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Piano:</td><td>${plan.title || plan.id}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Mese:</td><td>${approval.month_number}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Categoria:</td><td>${post.category || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Sub-topic:</td><td>${post.sub_topic || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Post ID:</td><td>${post.id}</td></tr>
      ${comment ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;color:${color}">Commento cliente:</td><td style="color:${color}"><em>${String(comment).replace(/[<>&]/g,'')}</em></td></tr>` : ''}
    </table>
    <p style="margin-top:16px;font-size:13px;color:#666">
      <a href="${process.env.BASE_URL || 'http://localhost:3100'}/dashboard/posts/${post.id}">Apri post nel dashboard</a>
    </p>`;
  return sendNotification(subject, html);
}

// Email di riepilogo: inviata UNA sola volta quando il cliente ha processato
// tutti i post del mese (pending = 0). Sostituisce lo stream di mail per-azione
// che intasava la casella. Include tabella con stato e commenti di ogni post.
function notifyApprovalSummary(approval, plan, client, posts, counts, finalStatus, source) {
  const clientName = client.display_name || client.id || 'Sconosciuto';
  const isApproved = finalStatus === 'approved';
  const byAdmin = source === 'admin';
  const statusLabel = isApproved ? 'APPROVATO COMPLETAMENTE'
    : finalStatus === 'changes_requested' ? 'MODIFICHE RICHIESTE'
    : 'RIVISTO';
  const statusColor = isApproved ? '#16a34a'
    : finalStatus === 'changes_requested' ? '#d97706' : '#374151';
  const subject = isApproved
    ? (byAdmin
        ? `Piano social mese ${approval.month_number} approvato — ${clientName}`
        : `Grazie per l'approvazione — ${clientName} — Mese ${approval.month_number}`)
    : `[RIEPILOGO ${statusLabel}] ${clientName} — Mese ${approval.month_number}`;

  const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const badge = (status) => {
    const map = {
      approved:         { txt: 'Approvato',    color: '#16a34a' },
      change_requested: { txt: 'Modifiche',    color: '#d97706' },
      rejected:         { txt: 'Rifiutato',    color: '#dc2626' },
      pending:          { txt: 'In attesa',    color: '#6b7280' }
    };
    const m = map[status] || { txt: status || '—', color: '#374151' };
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;color:#fff;background:${m.color}">${m.txt}</span>`;
  };

  const rows = (posts || []).map(p => {
    const comments = (p.client_comments || '').trim();
    const commentHtml = comments
      ? `<div style="margin-top:4px;padding:6px 8px;background:#fef3c7;border-left:3px solid #d97706;font-size:12px;color:#78350f"><em>${esc(comments.replace(/\|\|/g, ' • '))}</em></div>`
      : '';
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top">W${p.week_number || '—'}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top">${esc(p.category || '—')}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top">${esc(p.sub_topic || '—')}${commentHtml}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top">${badge(p.approval_status)}</td>
      </tr>`;
  }).join('');

  const total = counts.total || 0;
  const header = isApproved
    ? (byAdmin
        ? `Piano social mese ${approval.month_number} approvato — ${esc(clientName)}`
        : `Grazie per l'approvazione — ${esc(clientName)}`)
    : `Riepilogo approvazioni — ${esc(clientName)}`;
  const intro = isApproved
    ? (byAdmin
        ? `<p style="margin:0 0 12px;color:#374151;line-height:1.6">Ciao <strong>${esc(clientName)}</strong>, ti confermiamo che il piano editoriale del <strong>mese ${approval.month_number}</strong> è stato approvato dal tuo gestore social.</p>
           <p style="margin:0 0 16px;color:#374151;line-height:1.6">Qui sotto trovi l'elenco dei contenuti che verranno pubblicati secondo il calendario concordato. Se noti qualcosa che non va, contattaci il prima possibile: eventuali segnalazioni su contenuti già pubblicati non potranno essere accolte.</p>`
        : `<p style="margin:0 0 12px;color:#374151;line-height:1.6">Ciao <strong>${esc(clientName)}</strong>, grazie per aver approvato il piano editoriale del <strong>mese ${approval.month_number}</strong>.</p>
           <p style="margin:0 0 16px;color:#374151;line-height:1.6">Con questa email confermi di aver visionato e validato i contenuti elencati qui sotto. Da questo momento i post saranno pubblicati secondo il calendario concordato: eventuali contestazioni sui contenuti già approvati non potranno essere accolte.</p>`)
    : `<p style="margin:0 0 16px;color:#374151">Il cliente <strong>${esc(clientName)}</strong> ha completato la revisione del piano editoriale per il <strong>mese ${approval.month_number}</strong>.</p>`;
  const html = `
    <h2 style="color:${statusColor};margin:0 0 8px">${header}</h2>
    ${intro}
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;margin-bottom:16px">
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Piano:</td><td>${esc(plan.title || plan.id)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Mese:</td><td>${approval.month_number}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Stato finale:</td><td style="color:${statusColor};font-weight:600">${statusLabel}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Totale post:</td><td>${total}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;color:#16a34a">Approvati:</td><td>${counts.approved || 0}</td></tr>
      ${counts.change_requested ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;color:#d97706">Modifiche richieste:</td><td>${counts.change_requested}</td></tr>` : ''}
      ${counts.rejected ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;color:#dc2626">Rifiutati:</td><td>${counts.rejected}</td></tr>` : ''}
    </table>
    <h3 style="margin:0 0 8px;color:#111827">Dettaglio post</h3>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;max-width:720px">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">Sett.</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">Categoria</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">Sub-topic / Commento cliente</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">Stato</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  const cc = (isApproved && client.contact_email) ? client.contact_email : null;
  return sendNotification(subject, html, cc);
}

/**
 * Invia il PDF report performance al cliente come allegato email.
 * USA SMTP diretto (Google Apps Script non supporta allegati binari).
 *
 * @param {object} opts
 * @param {object} opts.client       — row clients
 * @param {string} opts.recipient    — email destinatario
 * @param {string} opts.periodLabel  — es. "Ultimi 30 giorni"
 * @param {object} opts.summary      — risultato getAccountSummary
 * @param {Buffer} opts.pdfBuffer    — buffer del PDF generato
 * @param {string} opts.filename     — nome del file allegato
 */
async function sendInsightsReport({ client, recipient, periodLabel, summary, pdfBuffer, filename }) {
  const t = getTransporter();
  if (!t) throw new Error('SMTP non configurato — impossibile inviare email con allegato PDF');

  const config = cachedConfig || getSmtpConfig();
  const clientName = client.display_name || client.id;

  const fb = summary && summary.fb;
  const ig = summary && summary.ig;
  const fbLine = fb
    ? `<li><strong>Facebook</strong>: ${fb.followers_now || 0} follower (${fb.followers_delta != null ? (fb.followers_delta >= 0 ? '+' : '') + fb.followers_delta : '—'} nel periodo) · ${fb.reach_total || 0} persone raggiunte</li>`
    : '';
  const igLine = ig
    ? `<li><strong>Instagram</strong>: ${ig.followers_now || 0} follower (${ig.followers_delta != null ? (ig.followers_delta >= 0 ? '+' : '') + ig.followers_delta : '—'} nel periodo) · ${ig.reach_total || 0} persone raggiunte</li>`
    : '';

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#111;line-height:1.5">
      <h2 style="color:#0f1e4a;margin:0 0 12px">Report performance social</h2>
      <p>Ciao!<br>In allegato trovi il report con i risultati dei tuoi canali social per il periodo: <strong>${periodLabel}</strong>.</p>
      ${(fbLine || igLine) ? `<h3 style="font-size:14px;margin:18px 0 6px;color:#1e3a8a">Riepilogo rapido</h3><ul style="padding-left:20px;margin:0 0 12px">${fbLine}${igLine}</ul>` : ''}
      <p>Nel PDF trovi anche i grafici di crescita follower, il reach giornaliero e i 5 post che hanno performato meglio nel periodo.</p>
      <p style="margin-top:20px">Grazie per la collaborazione,<br><strong>EMC Digital Solutions</strong></p>
      <p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:8px">www.emcdigitalsolutions.it</p>
    </div>`;

  const mail = {
    from: `"EMC Digital Solutions" <${config.user}>`,
    to: recipient,
    subject: `Report performance social — ${clientName} (${periodLabel})`,
    html,
    attachments: [{
      filename: filename || 'report-performance.pdf',
      content: pdfBuffer,
      contentType: 'application/pdf'
    }]
  };

  await t.sendMail(mail);
  console.log(`[notifier] Report PDF inviato a ${recipient} (${pdfBuffer.length} bytes) per ${clientName}`);
}

/**
 * Invia al CLIENTE l'email con il link pubblico di approvazione mensile.
 * Chiamata quando l'admin genera un nuovo monthly_approval.
 *
 * @param {object} opts
 * @param {object} opts.client      — row clients (deve avere contact_email)
 * @param {string} opts.approvalUrl — URL completo /dashboard/approve/<token>
 * @param {string} opts.planTitle
 * @param {number} opts.monthNumber — 1..N (mese del piano)
 * @param {string} opts.expiresAt   — ISO datetime (opzionale)
 * @param {number} opts.totalPosts  — numero post da approvare nel mese
 */
async function sendApprovalLinkToClient({ client, approvalUrl, planTitle, monthNumber, expiresAt, totalPosts }) {
  const recipient = client && client.contact_email;
  if (!recipient) {
    console.warn(`[notifier] sendApprovalLinkToClient: nessun contact_email per ${client && client.id} — skip`);
    return { skipped: true, reason: 'no-contact-email' };
  }

  const t = getTransporter();
  if (!t) {
    // Fallback Google Apps Script (no allegati ma email semplice OK)
    const gasUrl = getGoogleScriptUrl();
    if (gasUrl) {
      const subject = `Approvazione contenuti social — ${client.display_name || client.id}`;
      const html = renderApprovalEmailHtml({ client, approvalUrl, planTitle, monthNumber, expiresAt, totalPosts });
      try {
        // sendViaGoogleScript firma: (gasUrl, subject, html, smtpConfig, cc) — non c'è "to" custom.
        // Per ora forziamo SMTP-only per email cliente (servono custom recipient + branding).
        throw new Error('Google Script fallback non supporta destinatario custom — usa SMTP');
      } catch (e) { /* fallthrough */ }
    }
    throw new Error('SMTP non configurato — impossibile inviare email approvazione al cliente');
  }

  const config = cachedConfig || getSmtpConfig();
  const subject = `Approvazione contenuti social — ${client.display_name || client.id}`;
  const html = renderApprovalEmailHtml({ client, approvalUrl, planTitle, monthNumber, expiresAt, totalPosts });

  await t.sendMail({
    from: `"EMC Digital Solutions" <${config.user}>`,
    to: recipient,
    subject,
    html
  });
  console.log(`[notifier] Approval link inviato a ${recipient} per ${client.display_name || client.id} mese ${monthNumber}`);
  return { sent_to: recipient };
}

function renderApprovalEmailHtml({ client, approvalUrl, planTitle, monthNumber, expiresAt, totalPosts }) {
  const expiresStr = expiresAt
    ? new Date(expiresAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })
    : null;
  const clientName = client.display_name || client.id;
  return `
    <div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#111;line-height:1.55;max-width:580px;margin:0 auto">
      <div style="background:#0f1e4a;color:white;padding:18px 22px;border-radius:8px 8px 0 0">
        <h1 style="margin:0;font-size:18px;font-weight:700">Contenuti social pronti per la tua revisione</h1>
        <div style="opacity:0.85;font-size:12px;margin-top:4px">${clientName}${planTitle ? ' · ' + planTitle : ''}</div>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:22px;border-radius:0 0 8px 8px;background:white">
        <p>Ciao!</p>
        <p>Abbiamo preparato i contenuti del <strong>mese ${monthNumber}</strong> del tuo piano editoriale${totalPosts ? ` (${totalPosts} post)` : ''}.<br>
        Clicca sul bottone qui sotto per visualizzare l'anteprima di ogni post e approvarli (o richiedere modifiche).</p>

        <div style="text-align:center;margin:28px 0">
          <a href="${approvalUrl}" style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:13px 28px;border-radius:6px;font-weight:600;font-size:15px">
            Apri e approva i contenuti →
          </a>
        </div>

        <p style="font-size:13px;color:#6b7280;margin:18px 0 6px"><strong>Cosa puoi fare nella pagina di approvazione:</strong></p>
        <ul style="font-size:13px;color:#374151;padding-left:20px;margin:0 0 12px">
          <li>Vedere immagini e testo di ogni post in anteprima</li>
          <li>✓ <strong>Approvare</strong> i post che ti piacciono</li>
          <li>✏ <strong>Chiedere modifiche</strong> con un commento</li>
          <li>✗ <strong>Rifiutare</strong> i post non adatti</li>
        </ul>

        ${expiresStr ? `<p style="font-size:12px;color:#6b7280;background:#fef3c7;border-left:3px solid #d97706;padding:8px 12px;border-radius:4px;margin:14px 0"><strong>Il link scade il ${expiresStr}.</strong> Dopo questa data dovrà essere rigenerato.</p>` : ''}

        <p style="font-size:12px;color:#9ca3af;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:12px">
          Se il bottone non funziona, copia e incolla questo URL nel browser:<br>
          <code style="font-size:11px;word-break:break-all;background:#f3f4f6;padding:4px 6px;border-radius:3px;display:inline-block;margin-top:4px">${approvalUrl}</code>
        </p>

        <p style="margin-top:22px">Grazie!<br><strong>EMC Digital Solutions</strong></p>
      </div>
      <div style="text-align:center;font-size:11px;color:#9ca3af;padding:12px">
        <a href="https://www.emcdigitalsolutions.it" style="color:#9ca3af;text-decoration:none">www.emcdigitalsolutions.it</a>
      </div>
    </div>`;
}

module.exports = { sendNotification, notifyPublishFailed, notifyPublishPartial, notifyApprovalAction, notifyApprovalSummary, sendInsightsReport, sendApprovalLinkToClient };
