/**
 * pdf.js — generazione PDF lato server via Puppeteer (riusa il browser pool del renderer).
 * Per ora: PDF del piano editoriale (1 endpoint, 1 template).
 */
'use strict';

const { getBrowser } = require('./browser');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const TYPE_LABEL = {
  single_image: 'Singola immagine',
  carousel:     'Carousel',
  reel:         'Reel video',
  story:        'Storia (cliente)',
  video:        'Video'
};

function buildPlanHtml(client, plan) {
  const planData = plan.plan_data || {};
  const cats = planData.categories || [];
  const months = planData.months || [];
  const today = new Date().toLocaleDateString('it-IT');

  const catRows = cats.map(c =>
    `<tr><td><strong>${escapeHtml(c.code)}</strong></td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.frequency || '')}</td><td>${escapeHtml(c.description || '')}</td></tr>`
  ).join('');

  const monthSections = months.map(m => {
    const weekRows = (m.weeks || []).map(w => {
      const postRows = (w.posts || []).map(p => {
        const mt = TYPE_LABEL[p.media_type] || (p.media_type || 'single_image');
        return `
          <tr>
            <td>${escapeHtml(p.day || '')}${p.time ? ' · ' + escapeHtml(p.time) : ''}</td>
            <td><span class="cat">${escapeHtml(p.category || '')}</span></td>
            <td>${escapeHtml(p.sub_topic || '')}</td>
            <td><span class="mt mt-${escapeHtml(p.media_type || 'single_image')}">${escapeHtml(mt)}</span></td>
            <td class="notes">${escapeHtml(p.notes || '')}</td>
          </tr>`;
      }).join('');
      return `
        <h4>Settimana ${escapeHtml(String(w.week_number))}</h4>
        <table class="posts">
          <thead><tr><th>Quando</th><th>Cat.</th><th>Sub-topic</th><th>Tipo</th><th>Note</th></tr></thead>
          <tbody>${postRows}</tbody>
        </table>`;
    }).join('');
    return `
      <section class="month">
        <h2>Mese ${escapeHtml(String(m.month_number))}</h2>
        ${weekRows}
      </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><title>${escapeHtml(plan.title || 'Piano editoriale')}</title>
<style>
  @page { margin: 18mm 14mm; size: A4; }
  body { font-family: Inter, Helvetica, Arial, sans-serif; color: #111; font-size: 12px; line-height: 1.45; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #2563eb; color: #1e3a8a; page-break-before: auto; }
  h3 { font-size: 14px; margin: 18px 0 6px; }
  h4 { font-size: 12px; margin: 12px 0 4px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
  .header-meta { color: #6b7280; font-size: 11px; margin-bottom: 6px; }
  .intro { background: #eff6ff; border-left: 3px solid #2563eb; padding: 8px 12px; border-radius: 4px; font-size: 11px; color: #1e40af; margin: 14px 0 18px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f9fafb; font-weight: 600; font-size: 11px; }
  td.notes { color: #6b7280; font-size: 11px; }
  .cat { display: inline-block; background: #1e3a8a; color: white; font-weight: 700; padding: 1px 6px; border-radius: 3px; font-size: 10px; }
  .mt { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
  .mt-single_image { background: #e5e7eb; color: #374151; }
  .mt-carousel    { background: #fef3c7; color: #92400e; }
  .mt-reel        { background: #ede9fe; color: #5b21b6; }
  .mt-video       { background: #ede9fe; color: #5b21b6; }
  .mt-story       { background: #fce7f3; color: #9d174d; }
  .month { page-break-inside: avoid; }
  footer { margin-top: 30px; font-size: 10px; color: #9ca3af; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 8px; }
</style>
</head><body>
  <h1>${escapeHtml(plan.title || 'Piano editoriale')}</h1>
  <div class="header-meta">Cliente: <strong>${escapeHtml(client.display_name)}</strong> · Settore: ${escapeHtml(client.sector || '—')} · Generato il ${today}</div>
  <div class="intro">Questo documento contiene la pianificazione mensile dei contenuti social. Le voci marcate <em>Storia (cliente)</em> sono suggerimenti da pubblicare manualmente dal cliente direttamente dall'app Instagram/Facebook.</div>

  ${cats.length ? `<h3>Categorie di contenuto</h3>
  <table>
    <thead><tr><th style="width:60px">Cod.</th><th>Nome</th><th style="width:90px">Frequenza</th><th>Descrizione</th></tr></thead>
    <tbody>${catRows}</tbody>
  </table>` : ''}

  ${monthSections}

  <footer>EMC Digital Solutions — emcdigitalsolutions.it</footer>
</body></html>`;
}

async function renderPlanPdf(client, plan) {
  const t0 = Date.now();
  console.log('[pdf] start render plan', plan.id, 'client', client.id);
  const html = buildPlanHtml(client, plan);
  console.log('[pdf] html built, length', html.length);
  const b = await getBrowser();
  console.log('[pdf] browser ok, opening page');
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    console.log('[pdf] content set');
    // Non aspettiamo fonts.ready perché può bloccare se non ci sono font
    // esterni — il PDF usa font di sistema (Inter / Helvetica fallback).
    const raw = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' }
    });
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    console.log('[pdf] done in', Date.now() - t0, 'ms,', buffer.length, 'bytes');
    return buffer;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

// ─────────────────────── INSIGHTS REPORT ───────────────────────

function fmtIt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('it-IT');
}
function fmtDeltaPdf(n) {
  if (n == null) return '—';
  if (n > 0) return '+' + fmtIt(n);
  if (n < 0) return fmtIt(n);
  return '0';
}
function deltaColor(n) {
  if (n == null || n === 0) return '#6b7280';
  return n > 0 ? '#10b981' : '#dc2626';
}

function buildInsightsReportHtml(client, periodLabel, summary, history, topPosts, kpis) {
  const today = new Date().toLocaleDateString('it-IT');

  // ── Banda KPI di sintesi, ciascuna con una spiegazione per il cliente ──
  const kpiSummary = kpis ? (() => {
    const totalReach = (summary.fb ? summary.fb.reach_total || 0 : 0) + (summary.ig ? summary.ig.reach_total || 0 : 0);
    const totalInteractions = kpis.total_interactions || 0;
    const engRate = totalReach > 0 ? (totalInteractions / totalReach * 100) : null;
    const engRateLabel = engRate != null ? engRate.toFixed(1).replace('.', ',') + '%' : 'n/d';
    const cell = (label, value, hint) =>
      `<div class="ks-cell"><div class="ks-lbl">${label}</div><div class="ks-val">${value}</div><div class="ks-hint">${hint}</div></div>`;
    return `
    <div class="kpi-summary">
      ${cell('Post pubblicati', fmtIt(kpis.post_count || 0), 'Contenuti pubblicati sui tuoi canali nel periodo.')}
      ${cell('Interazioni totali', fmtIt(totalInteractions), 'Somma di “mi piace”, commenti, condivisioni e salvataggi.')}
      ${cell('Reach totale', fmtIt(totalReach), 'Persone diverse che hanno visto i contenuti (Facebook + Instagram).')}
      ${cell('Engagement rate', engRateLabel, 'Quota di persone raggiunte che ha interagito. Più alto = più coinvolgimento.')}
    </div>`;
  })() : '';

  // ── Card per piattaforma: ogni metrica ha una breve spiegazione ──
  const platformCard = (data, kind, label, profileLabel, profileHint) => data ? `
    <div class="kpi-block">
      <div class="kpi-platform ${kind}">${label}</div>
      <table class="kpi-grid"><tr>
        <td><div class="lbl">Follower</div>
          <div class="val">${fmtIt(data.followers_now)}</div>
          <div class="dlt" style="color:${deltaColor(data.followers_delta)}">${fmtDeltaPdf(data.followers_delta)} nel periodo</div>
          <div class="hint">Persone che seguono ${kind === 'fb' ? 'la pagina' : 'il profilo'}. Il valore colorato è la crescita nel periodo.</div>
        </td>
        <td><div class="lbl">Persone raggiunte</div>
          <div class="val">${fmtIt(data.reach_total)}</div>
          <div class="dlt">somma del periodo</div>
          <div class="hint">Quante persone hanno visto almeno un contenuto.</div>
        </td>
        <td><div class="lbl">${profileLabel}</div>
          <div class="val">${fmtIt(data.profile_views_total || 0)}</div>
          <div class="dlt">&nbsp;</div>
          <div class="hint">${profileHint}</div>
        </td>
      </tr></table>
    </div>` : '';

  const fbCard = platformCard(summary.fb, 'fb', 'FACEBOOK', 'Visualizzazioni profilo', 'Quante volte è stata aperta la pagina.');
  const igCard = platformCard(summary.ig, 'ig', 'INSTAGRAM', 'Visite al profilo', 'Quante volte è stato aperto il profilo.');

  const topRows = (topPosts || []).slice(0, 5).map((p, i) => {
    const eng = (p.ig_engagement || 0) + (p.fb_engagement || 0);
    const reach = (p.ig_reach || 0) + (p.fb_reach || 0);
    const date = p.published_at ? new Date(p.published_at).toLocaleDateString('it-IT') : '';
    const type = TYPE_LABEL[p.media_type] || p.media_type || 'Singola';
    return `<tr>
      <td class="rank">${i + 1}</td>
      <td>${escapeHtml((p.sub_topic || 'Post').substring(0, 90))}</td>
      <td><span class="mt mt-${escapeHtml(p.media_type || 'single_image')}">${escapeHtml(type)}</span></td>
      <td>${escapeHtml(date)}</td>
      <td class="num">${fmtIt(eng)}</td>
      <td class="num">${fmtIt(reach)}</td>
    </tr>`;
  }).join('');

  // Dati grafici JSON (Chart.js li userà inline nella pagina)
  const fbHist = (history || []).filter(h => h.platform === 'fb');
  const igHist = (history || []).filter(h => h.platform === 'ig');
  const chartData = {
    labels: [...new Set(history.map(h => h.date))].sort(),
    fbFans: fbHist.map(h => ({ x: h.date, y: h.fans })),
    igFollowers: igHist.map(h => ({ x: h.date, y: h.followers })),
    fbReach: fbHist.map(h => ({ x: h.date, y: h.reach })),
    igReach: igHist.map(h => ({ x: h.date, y: h.reach }))
  };

  const noData = !summary.fb && !summary.ig;

  // Logo EMC inline (3 barre chevron + testo) — gradienti adattati a navy/oro
  const emcLogo = (barId, txtId, w, h) => `
    <svg width="${w}" height="${h}" viewBox="0 0 109 50">
      <defs>
        <linearGradient id="${barId}" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3b5bb5"/><stop offset="100%" stop-color="#c9a96e"/></linearGradient>
        <linearGradient id="${txtId}" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#1e3a8a"/><stop offset="55%" stop-color="#6b7fb0"/><stop offset="100%" stop-color="#c9a96e"/></linearGradient>
      </defs>
      <rect x="5" y="10" width="30" height="6" rx="2" fill="url(#${barId})"/>
      <rect x="5" y="22" width="20" height="6" rx="2" fill="url(#${barId})"/>
      <rect x="5" y="34" width="30" height="6" rx="2" fill="url(#${barId})"/>
      <text x="48" y="34" font-family="Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="3" fill="url(#${txtId})">EMC</text>
    </svg>`;

  const icon = (paths) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const icPhone = icon('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>');
  const icMail  = icon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>');
  const icWeb   = icon('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>');
  const icIg    = icon('<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/>');
  const icCal   = icon('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>');

  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><title>Report ${escapeHtml(client.display_name)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #1a2238; --ink-soft: #3a4256; --muted: #707a90; --line: #e7e3d8;
    --navy: #14224a; --navy-deep: #0c1733; --gold: #c9a96e; --gold-dk: #a6864c;
    --cream: #faf8f2; --fb: #1877f2; --ig: #e4405f;
    --f-display: 'Fraunces', Georgia, serif;
    --f-body: 'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  @page { margin: 15mm 13mm; size: A4; }
  * { box-sizing: border-box; }
  body { font-family: var(--f-body); color: var(--ink-soft); font-size: 11.5px; line-height: 1.55; margin: 0; -webkit-font-smoothing: antialiased; }
  h1,h2,h3 { font-family: var(--f-display); color: var(--ink); font-weight: 600; line-height: 1.15; letter-spacing: -0.01em; }
  .eyebrow { font-size: 10px; font-weight: 600; letter-spacing: 3px; text-transform: uppercase; }

  /* Cover */
  .cover { background: linear-gradient(135deg, var(--navy-deep) 0%, var(--navy) 55%, #1e3a8a 100%); color: var(--cream); border-radius: 12px; padding: 26px 30px 30px; position: relative; overflow: hidden; margin-bottom: 22px; }
  .cover::after { content:""; position:absolute; top:-90px; right:-70px; width:280px; height:280px; border-radius:50%; background: radial-gradient(circle, rgba(201,169,110,.20), transparent 70%); }
  .cover-top { display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:18px; border-bottom:1px solid rgba(255,255,255,.14); margin-bottom:22px; position:relative; z-index:1; }
  .cover-top .meta { text-align:right; font-size:9.5px; letter-spacing:1.4px; text-transform:uppercase; line-height:1.9; color:rgba(255,255,255,.62); }
  .cover-top .meta strong { color: var(--gold); font-weight:600; }
  .cover-body { position:relative; z-index:1; }
  .cover-body .eyebrow { color: var(--gold); margin-bottom: 6px; }
  .cover-body h1 { font-size: 36px; color: var(--cream); margin: 0 0 6px; }
  .cover-body h1 em { font-style: italic; color: var(--gold); font-weight: 500; }
  .cover-body .who { font-size: 13.5px; color: rgba(255,255,255,.88); font-weight: 500; }

  .intro { color: var(--ink-soft); font-size: 11.5px; margin: 0 0 8px; }
  .intro em { font-family: var(--f-display); font-style: italic; color: var(--gold-dk); }
  .legend-note { background: var(--cream); border: 1px solid var(--line); border-left: 3px solid var(--gold); border-radius: 6px; padding: 9px 13px; font-size: 10.5px; color: var(--muted); margin: 0 0 20px; }
  .legend-note strong { color: var(--ink); }

  /* Section header numerato */
  .section-h { display:flex; align-items:baseline; gap:12px; margin: 26px 0 14px; border-bottom:1px solid var(--line); padding-bottom:9px; page-break-after: avoid; }
  .section-h .num { font-family: var(--f-display); font-style: italic; font-size: 17px; color: var(--gold-dk); font-weight: 500; }
  .section-h h2 { margin:0; font-size: 19px; color: var(--ink); }
  .section-h .h-hint { margin-left:auto; font-size:10px; color: var(--muted); font-style: italic; align-self:center; max-width: 46%; text-align:right; }
  .keep-together { page-break-inside: avoid; }

  /* KPI sintesi */
  .kpi-summary { display:flex; gap:11px; margin: 0 0 6px; page-break-inside: avoid; }
  .kpi-summary .ks-cell { flex:1; background:#fff; border:1px solid var(--line); border-top:3px solid var(--gold); border-radius:9px; padding:12px 13px; }
  .kpi-summary .ks-lbl { font-size:9px; text-transform:uppercase; letter-spacing:0.5px; color: var(--gold-dk); font-weight:700; }
  .kpi-summary .ks-val { font-family: var(--f-display); font-size:27px; font-weight:600; color: var(--ink); margin:3px 0 5px; letter-spacing:-0.5px; }
  .kpi-summary .ks-hint { font-size:8.8px; color: var(--muted); line-height:1.4; }

  /* Card piattaforma */
  .kpi-block { margin-bottom: 12px; border:1px solid var(--line); border-radius:9px; padding:14px 16px; background:#fff; page-break-inside: avoid; }
  .kpi-platform { display:inline-block; padding:3px 10px; border-radius:5px; font-size:9.5px; font-weight:700; color:#fff; margin-bottom:10px; letter-spacing:0.6px; }
  .kpi-platform.fb { background: var(--fb); }
  .kpi-platform.ig { background: var(--ig); }
  .kpi-grid { width:100%; border-collapse:collapse; }
  .kpi-grid td { padding:2px 10px 2px 0; vertical-align:top; width:33.3%; border:0; }
  .kpi-grid .lbl { font-size:9.5px; color: var(--muted); text-transform:uppercase; letter-spacing:0.4px; font-weight:600; }
  .kpi-grid .val { font-family: var(--f-display); font-size:24px; font-weight:600; color: var(--ink); margin-top:2px; letter-spacing:-0.4px; }
  .kpi-grid .dlt { font-size:9.5px; color: var(--muted); margin-top:1px; font-weight:600; }
  .kpi-grid .hint { font-size:8.8px; color: var(--muted); margin-top:5px; line-height:1.4; }

  /* Grafici */
  .charts-row { display:flex; gap:20px; align-items:flex-start; page-break-inside: avoid; }
  .charts-row .chart-col { flex:1; min-width:0; }
  .chart-cap { font-size:9.5px; color: var(--muted); margin: 2px 0 6px; line-height:1.4; }
  .chart-wrap { width:100%; height:auto; }

  /* Top post */
  table.top { width:100%; border-collapse:collapse; }
  table.top th, table.top td { border:1px solid var(--line); padding:7px 9px; font-size:10.5px; vertical-align:middle; }
  table.top th { background: var(--cream); font-weight:700; text-align:left; font-size:9px; text-transform:uppercase; letter-spacing:0.4px; color: var(--ink); }
  table.top td.rank { background: var(--navy); color:#fff; font-weight:700; text-align:center; width:26px; font-family: var(--f-display); }
  table.top td.num { text-align:right; font-weight:700; color: var(--ink); }
  .mt { display:inline-block; padding:2px 7px; border-radius:4px; font-size:8.5px; font-weight:600; }
  .mt-single_image { background:#eef0f3; color:#374151; }
  .mt-carousel { background:#fef3c7; color:#92400e; }
  .mt-reel, .mt-video { background:#ede9fe; color:#5b21b6; }
  .mt-story { background:#fce7f3; color:#9d174d; }
  .empty { text-align:center; padding:22px; color:#9ca3af; font-style:italic; }

  /* Footer firma */
  .doc-footer { margin-top: 32px; padding-top: 22px; border-top:1px solid var(--line); text-align:center; page-break-inside: avoid; }
  .doc-footer .motto { font-family: var(--f-display); font-style:italic; font-size:15px; color: var(--ink); max-width: 460px; margin: 0 auto 18px; line-height:1.4; }
  .sign-card { display:inline-block; border:1px solid var(--line); border-radius:10px; padding:16px 26px; background: var(--cream); }
  .sign-name { font-family: var(--f-display); font-size:15px; font-weight:600; color: var(--ink); margin-top:4px; }
  .sign-role { font-size:9.5px; color: var(--gold-dk); text-transform:uppercase; letter-spacing:1.5px; font-weight:600; margin-top:2px; }
  .sign-contacts { display:flex; flex-wrap:wrap; justify-content:center; gap:6px 16px; margin-top:12px; font-size:10px; color: var(--ink-soft); }
  .sign-contacts a { color: var(--ink-soft); text-decoration:none; display:inline-flex; align-items:center; gap:5px; }
  .sign-contacts svg { color: var(--gold-dk); }
  .credit { margin-top:14px; font-size:8.5px; color: var(--muted); letter-spacing:0.5px; }
</style>
</head><body>
  <div class="cover">
    <div class="cover-top">
      ${emcLogo('emcBarCov', 'emcTxtCov', 150, 69)}
      <div class="meta">
        Report performance<br>
        <strong>${escapeHtml(periodLabel)}</strong><br>
        Generato il ${today}
      </div>
    </div>
    <div class="cover-body">
      <div class="eyebrow">Performance Social</div>
      <h1>Il tuo <em>report</em> social</h1>
      <div class="who">${escapeHtml(client.display_name)}${client.location ? ' · ' + escapeHtml(client.location) : ''}</div>
    </div>
  </div>

  <p class="intro">Questo report raccoglie i risultati delle attività sui tuoi canali social nel periodo <strong>${escapeHtml(periodLabel)}</strong>: <em>crescita della community, persone raggiunte e contenuti che hanno funzionato meglio</em>. I dati sono aggiornati quotidianamente dalle piattaforme Meta.</p>
  <div class="legend-note"><strong>Come leggere questo report:</strong> sotto ogni numero trovi una breve spiegazione di cosa rappresenta. In sintesi: il <strong>reach</strong> è quante persone hanno visto i contenuti, le <strong>interazioni</strong> sono le azioni che hanno compiuto (mi piace, commenti, condivisioni, salvataggi) e l'<strong>engagement rate</strong> misura quanto i contenuti coinvolgono chi li vede.</div>

  ${noData ? '<div class="empty">Nessun dato ancora disponibile. Il report sarà completo dal prossimo periodo.</div>' : ''}

  ${!noData && kpiSummary ? `<div class="section-h"><span class="num">01</span><h2>In sintesi</h2><span class="h-hint">Il colpo d'occhio sul periodo</span></div>${kpiSummary}` : ''}

  ${!noData ? `<div class="keep-together"><div class="section-h"><span class="num">02</span><h2>Andamento per canale</h2><span class="h-hint">I numeri di Facebook e Instagram</span></div>${fbCard}${igCard}</div>` : ''}

  ${history && history.length ? `
    <div class="section-h"><span class="num">03</span><h2>Tendenze del periodo</h2></div>
    <div class="charts-row">
      <div class="chart-col">
        <h3 style="font-size:13px;margin:0 0 1px">Crescita follower</h3>
        <div class="chart-cap">Andamento dei follower giorno per giorno: mostra se la community sta crescendo.</div>
        <div class="chart-wrap"><canvas id="ch-followers" width="330" height="240"></canvas></div>
      </div>
      <div class="chart-col">
        <h3 style="font-size:13px;margin:0 0 1px">Reach giornaliero</h3>
        <div class="chart-cap">Persone raggiunte ogni giorno: i picchi coincidono con i post che hanno funzionato meglio.</div>
        <div class="chart-wrap"><canvas id="ch-reach" width="330" height="240"></canvas></div>
      </div>
    </div>
  ` : ''}

  <div class="section-h"><span class="num">04</span><h2>I contenuti migliori</h2><span class="h-hint">I 5 post con più interazioni</span></div>
  ${topRows ? `<table class="top">
    <thead><tr><th>#</th><th>Contenuto</th><th>Tipo</th><th>Pubblicato</th><th>Interazioni</th><th>Reach</th></tr></thead>
    <tbody>${topRows}</tbody>
  </table>` : '<div class="empty">Nessun post pubblicato nel periodo.</div>'}

  <div class="doc-footer">
    <p class="motto">I numeri raccontano una storia di crescita: continuiamo a scriverla insieme, un contenuto alla volta.</p>
    <div class="sign-card">
      ${emcLogo('emcBarFoot', 'emcTxtFoot', 70, 32)}
      <div class="sign-name">EMC Digital Solutions</div>
      <div class="sign-role">Digital · Web · Social</div>
      <div class="sign-contacts">
        <a href="tel:+393294348075">${icPhone}+39 329 4348075</a>
        <a href="mailto:info@emcdigitalsolutions.it">${icMail}info@emcdigitalsolutions.it</a>
        <a href="https://www.emcdigitalsolutions.it">${icWeb}www.emcdigitalsolutions.it</a>
        <a href="https://instagram.com/emcdigitalsolutions">${icIg}@emcdigitalsolutions</a>
        <a href="https://calendly.com/emcdigitalsolution/30min">${icCal}Prenota una consulenza</a>
      </div>
    </div>
    <div class="credit">Report riservato a ${escapeHtml(client.display_name)} · © ${new Date().getFullYear()} EMC Digital Solutions</div>
  </div>

<script>
  const D = ${JSON.stringify(chartData)};
  function buildSeries(arr) { return arr.filter(p => p.y != null); }
  if (D.labels.length) {
    const fOpt = { responsive: false, animation: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } }, scales: { x: { type: 'category', grid: { display: false }, ticks: { font: { size: 9 } } }, y: { ticks: { font: { size: 9 } } } } };
    const fOptDualY = {
      ...fOpt,
      scales: {
        ...fOpt.scales,
        y:  { position: 'left',  beginAtZero: false, grid: { color: 'rgba(24,119,242,0.08)' }, ticks: { color: '#1877f2', font: { size: 9 } } },
        y1: { position: 'right', beginAtZero: false, grid: { display: false },                ticks: { color: '#e4405f', font: { size: 9 } } }
      }
    };
    new Chart(document.getElementById('ch-followers'), {
      type: 'line',
      data: { datasets: [
        { label: 'Facebook',  data: buildSeries(D.fbFans),       borderColor: '#1877f2', backgroundColor: '#1877f2', fill: false, tension: 0, spanGaps: true, pointRadius: 3, borderWidth: 2, yAxisID: 'y' },
        { label: 'Instagram', data: buildSeries(D.igFollowers),  borderColor: '#e4405f', backgroundColor: '#e4405f', fill: false, tension: 0, spanGaps: true, pointRadius: 3, borderWidth: 2, yAxisID: 'y1' }
      ]},
      options: fOptDualY
    });
    new Chart(document.getElementById('ch-reach'), {
      type: 'bar',
      data: { datasets: [
        { label: 'Facebook',  data: buildSeries(D.fbReach), backgroundColor: 'rgba(24,119,242,0.7)' },
        { label: 'Instagram', data: buildSeries(D.igReach), backgroundColor: 'rgba(228,64,95,0.7)' }
      ]},
      options: { ...fOpt, scales: { ...fOpt.scales, y: { ...fOpt.scales.y, beginAtZero: true } } }
    });
    window._chartsReady = true;
  } else {
    window._chartsReady = true;
  }
</script>
</body></html>`;
}

async function renderInsightsReportPdf(client, periodLabel, summary, history, topPosts, kpis) {
  const t0 = Date.now();
  console.log('[pdf-insights] start', client.id, periodLabel);
  const html = buildInsightsReportHtml(client, periodLabel, summary, history, topPosts, kpis);
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 25000 });
    // Aspetta il caricamento dei web font (Fraunces/Inter) per un rendering nitido
    await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready.then(() => {}) : null).catch(() => {});
    // Aspetta che Chart.js abbia disegnato i grafici
    await page.waitForFunction(() => window._chartsReady === true, { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    const raw = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' }
    });
    // Puppeteer >=21 ritorna Uint8Array invece di Buffer: Express lo serializza
    // come JSON {"0":37,...}. Forziamo Buffer.from per ottenere binary corretto.
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    console.log('[pdf-insights] done in', Date.now() - t0, 'ms,', buffer.length, 'bytes');
    return buffer;
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

module.exports = { renderPlanPdf, buildPlanHtml, renderInsightsReportPdf, buildInsightsReportHtml };
