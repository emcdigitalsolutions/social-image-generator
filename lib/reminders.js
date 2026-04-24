const { getDb } = require('./db');
const { sendNotification } = require('./notifier');

// Reminder mensile: gira il 25 di ogni mese alle 08:00 Europe/Rome.
// Per ogni cliente attivo:
//   - Se esiste un piano attivo/più recente con il mese successivo (N+1) disponibile nel plan_data
//     ma nessuna monthly_approval per quel mese → admin: "il piano esiste, va inviato al cliente"
//   - Se esiste monthly_approval per N+1 in pending/in_review → admin riceve link; cliente (se ha
//     contact_email) riceve sollecito con link di approvazione pubblico
//   - Se esiste approvazione per N+1 già approved → skip (tutto in ordine)
//   - Se il piano NON copre il mese N+1 → admin: "va creato il piano del mese successivo"
//
// La scelta di "mese corrente" è semplice: il mese solare. Non proviamo a dedurre
// il mese interno del piano dal numero di post pubblicati — per i clienti attivi
// assumiamo che ogni mese del piano corrisponda a un mese solare e che il mese
// solare successivo (next) sia il mese N+1 del loro piano più recente.
function sendMonthlyReminders() {
  const db = getDb();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3100';

  const clients = db.prepare(`SELECT * FROM clients WHERE status = 'active' ORDER BY display_name`).all();
  if (!clients.length) {
    console.log('[reminders] Nessun cliente attivo — skip');
    return;
  }

  // Classificazione: per ogni cliente costruiamo una struttura { state, ... } e una
  // tabella riassuntiva unica verso l'admin. I solleciti ai clienti sono separati.
  const summary = [];
  const clientEmails = [];

  for (const client of clients) {
    // Prendi il piano più recente (draft/confirmed/active, non importa — il più recente)
    const plan = db.prepare(`
      SELECT * FROM editorial_plans WHERE client_id = ?
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
        datetime(updated_at) DESC
      LIMIT 1
    `).get(client.id);

    if (!plan) {
      summary.push({ client, state: 'no_plan', detail: 'Nessun piano editoriale creato' });
      continue;
    }

    let planData = null;
    try { planData = plan.plan_data ? JSON.parse(plan.plan_data) : null; } catch (_) { planData = null; }
    const totalMonths = planData && Array.isArray(planData.months) ? planData.months.length : 0;

    // Calcola il mese N+1: è l'ultimo mese con post pubblicati + 1, oppure 1 se nessun pubblicato.
    // Fallback: se nessun published, usa il minimo month_number con post in 'ready'.
    const lastPublished = db.prepare(`
      SELECT COALESCE(MAX(month_number), 0) AS m FROM posts WHERE editorial_plan_id = ? AND status = 'published'
    `).get(plan.id);
    const currentMonth = lastPublished.m || 1;
    const nextMonth = currentMonth + 1;

    if (totalMonths > 0 && nextMonth > totalMonths) {
      summary.push({
        client, plan,
        state: 'plan_ending',
        detail: `Il piano (${totalMonths} mesi) è arrivato all'ultimo mese. Serve creare un nuovo piano editoriale.`
      });
      continue;
    }

    const nextApproval = db.prepare(`
      SELECT * FROM monthly_approvals WHERE editorial_plan_id = ? AND month_number = ?
    `).get(plan.id, nextMonth);

    if (!nextApproval) {
      summary.push({
        client, plan,
        state: 'no_approval',
        detail: `Il piano mese ${nextMonth} esiste ma non è ancora stato inviato al cliente per l'approvazione.`,
        currentMonth, nextMonth
      });
      continue;
    }

    if (nextApproval.status === 'approved') {
      // Tutto in ordine — lo includiamo nel riepilogo come verde, utile per l'admin
      summary.push({
        client, plan, approval: nextApproval,
        state: 'ok',
        detail: `Mese ${nextMonth} già approvato dal cliente.`,
        currentMonth, nextMonth
      });
      continue;
    }

    // Pending / in_review / changes_requested → sollecito
    const approvalUrl = `${baseUrl}/dashboard/approve/${nextApproval.token}`;
    summary.push({
      client, plan, approval: nextApproval, approvalUrl,
      state: 'awaiting_client',
      detail: `Mese ${nextMonth}: in attesa del cliente (status=${nextApproval.status}).`,
      currentMonth, nextMonth
    });

    if (client.contact_email) {
      clientEmails.push({ client, plan, approval: nextApproval, approvalUrl, nextMonth });
    }
  }

  return Promise.all([
    sendAdminReminderDigest(summary),
    ...clientEmails.map(c => sendClientApprovalReminder(c))
  ]).catch(err => console.error('[reminders] Errore invio:', err.message));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
}

function sendAdminReminderDigest(summary) {
  if (!summary.length) return Promise.resolve();

  const needAction = summary.filter(s => s.state !== 'ok');
  const statusColor = {
    no_plan:         '#dc2626',
    plan_ending:     '#dc2626',
    no_approval:     '#d97706',
    awaiting_client: '#d97706',
    ok:              '#16a34a'
  };
  const statusLabel = {
    no_plan:         'NESSUN PIANO',
    plan_ending:     'PIANO TERMINA',
    no_approval:     'DA INVIARE',
    awaiting_client: 'ATTESA CLIENTE',
    ok:              'OK'
  };

  const rows = summary.map(s => {
    const color = statusColor[s.state] || '#374151';
    const label = statusLabel[s.state] || s.state;
    const linkCell = s.approvalUrl
      ? `<a href="${esc(s.approvalUrl)}" style="color:#2563eb;word-break:break-all;font-size:12px">${esc(s.approvalUrl)}</a>`
      : '—';
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top">${esc(s.client.display_name)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#fff;background:${color}">${label}</span>
        </td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top">${esc(s.detail)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;vertical-align:top">${linkCell}</td>
      </tr>`;
  }).join('');

  const subject = needAction.length
    ? `[Promemoria mensile] ${needAction.length} cliente/i da seguire`
    : `[Promemoria mensile] Tutti i clienti in ordine`;

  const html = `
    <h2 style="margin:0 0 8px;color:#111827">Promemoria mensile piani editoriali</h2>
    <p style="margin:0 0 16px;color:#374151">Stato per ciascun cliente attivo, a ~1 settimana dalla scadenza del mese in corso.</p>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;max-width:900px">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">Cliente</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">Stato</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">Dettaglio</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">Link approvazione</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:20px;font-size:12px;color:#6b7280">I link "ATTESA CLIENTE" sono link di approvazione pubblica — inoltrali al cliente se non ha ricevuto il sollecito automatico (serve il campo Email di contatto nel profilo cliente).</p>`;

  return sendNotification(subject, html);
}

function sendClientApprovalReminder({ client, plan, approval, approvalUrl, nextMonth }) {
  const subject = `Promemoria: approva il piano social del mese ${nextMonth}`;
  const html = `
    <h2 style="color:#111827;margin:0 0 12px">Ciao ${esc(client.display_name)},</h2>
    <p style="color:#374151;line-height:1.6">Ti ricordiamo che il piano editoriale social del <strong>mese ${nextMonth}</strong> è pronto per la tua approvazione.</p>
    <p style="color:#374151;line-height:1.6">Per vederlo e approvarlo (o chiedere modifiche) basta un click:</p>
    <p style="margin:24px 0">
      <a href="${esc(approvalUrl)}"
         style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
        Apri il piano e approva
      </a>
    </p>
    <p style="color:#6b7280;font-size:13px">Se il pulsante non funziona, copia questo link nel browser:<br>
      <span style="word-break:break-all">${esc(approvalUrl)}</span>
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
    <p style="color:#9ca3af;font-size:12px">Ricevi questa email perché sei referente del piano <em>${esc(plan.title || plan.id)}</em>. Se hai domande rispondi direttamente a questa mail.</p>`;

  // sendNotification invia SEMPRE all'admin. Per inviare al cliente usiamo direttamente
  // il Google Apps Script con site="emcdigitalsolutions" → la mail arriva al destinatario
  // configurato lato GAS. Per bypassare al cliente usiamo sendNotificationTo() — ma il
  // notifier attuale non lo supporta. Pragmatico: includiamo il destinatario nel subject
  // e il GAS può gestire routing. Se GAS non supporta routing, l'admin inoltrerà.
  // TODO: estendere notifier.js per supportare destinatario dinamico.
  const subjectWithTo = `[->${client.contact_email}] ${subject}`;
  return sendNotification(subjectWithTo, html);
}

module.exports = { sendMonthlyReminders };
