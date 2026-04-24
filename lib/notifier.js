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
function sendViaGoogleScript(gasUrl, subject, html, smtpConfig) {
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
      message: html
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

async function sendNotification(subject, html) {
  // 1) Preferisci Google Apps Script se configurato (HTTPS, sempre raggiungibile)
  const gasUrl = getGoogleScriptUrl();
  if (gasUrl) {
    try {
      await sendViaGoogleScript(gasUrl, subject, html, getSmtpConfig());
      console.log(`[notifier] Email inviata via Google Script: ${subject}`);
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
    await t.sendMail({
      from: `"Social Image Generator" <${config.user}>`,
      to: getRecipient(),
      subject,
      html
    });
    console.log(`[notifier] Email inviata via SMTP: ${subject}`);
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
function notifyApprovalSummary(approval, plan, client, posts, counts, finalStatus) {
  const clientName = client.display_name || client.id || 'Sconosciuto';
  const statusLabel = finalStatus === 'approved' ? 'APPROVATO COMPLETAMENTE'
    : finalStatus === 'changes_requested' ? 'MODIFICHE RICHIESTE'
    : 'RIVISTO';
  const statusColor = finalStatus === 'approved' ? '#16a34a'
    : finalStatus === 'changes_requested' ? '#d97706' : '#374151';
  const subject = `[RIEPILOGO ${statusLabel}] ${clientName} — Mese ${approval.month_number}`;

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
  const html = `
    <h2 style="color:${statusColor};margin:0 0 8px">Riepilogo approvazioni — ${esc(clientName)}</h2>
    <p style="margin:0 0 16px;color:#374151">Il cliente <strong>${esc(clientName)}</strong> ha completato la revisione del piano editoriale per il <strong>mese ${approval.month_number}</strong>.</p>
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
    </table>
    <p style="margin-top:20px;font-size:13px;color:#666">
      <a href="${process.env.BASE_URL || 'http://localhost:3100'}/dashboard/clients/${client.id}/plan/${plan.id}">Apri il piano nel dashboard</a>
    </p>`;
  return sendNotification(subject, html);
}

module.exports = { sendNotification, notifyPublishFailed, notifyPublishPartial, notifyApprovalAction, notifyApprovalSummary };
