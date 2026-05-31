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

  // Banda KPI di sintesi del periodo. Reach totale = somma del reach mostrato
  // per piattaforma (coerente col resto del report). Engagement rate =
  // interazioni totali / reach totale.
  const kpiSummary = kpis ? (() => {
    const totalReach = (summary.fb ? summary.fb.reach_total || 0 : 0) + (summary.ig ? summary.ig.reach_total || 0 : 0);
    const totalInteractions = kpis.total_interactions || 0;
    const engRate = totalReach > 0 ? (totalInteractions / totalReach * 100) : null;
    const engRateLabel = engRate != null ? engRate.toFixed(1).replace('.', ',') + '%' : 'n/d';
    return `
    <div class="kpi-summary">
      <div class="ks-cell"><div class="ks-lbl">Post pubblicati</div><div class="ks-val">${fmtIt(kpis.post_count || 0)}</div></div>
      <div class="ks-cell"><div class="ks-lbl">Interazioni totali</div><div class="ks-val">${fmtIt(totalInteractions)}</div></div>
      <div class="ks-cell"><div class="ks-lbl">Reach totale</div><div class="ks-val">${fmtIt(totalReach)}</div></div>
      <div class="ks-cell"><div class="ks-lbl">Engagement rate</div><div class="ks-val">${engRateLabel}</div></div>
    </div>`;
  })() : '';

  const fbCard = summary.fb ? `
    <div class="kpi-block">
      <div class="kpi-platform fb">FACEBOOK</div>
      <table class="kpi-grid"><tr>
        <td><div class="lbl">Follower</div>
          <div class="val">${fmtIt(summary.fb.followers_now)}</div>
          <div class="dlt" style="color:${deltaColor(summary.fb.followers_delta)}">${fmtDeltaPdf(summary.fb.followers_delta)} nel periodo</div>
        </td>
        <td><div class="lbl">Persone raggiunte</div>
          <div class="val">${fmtIt(summary.fb.reach_total)}</div>
          <div class="dlt">somma giornaliera</div>
        </td>
        <td><div class="lbl">Visualizzazioni profilo</div>
          <div class="val">${fmtIt(summary.fb.profile_views_total || 0)}</div>
        </td>
      </tr></table>
    </div>` : '';

  const igCard = summary.ig ? `
    <div class="kpi-block">
      <div class="kpi-platform ig">INSTAGRAM</div>
      <table class="kpi-grid"><tr>
        <td><div class="lbl">Follower</div>
          <div class="val">${fmtIt(summary.ig.followers_now)}</div>
          <div class="dlt" style="color:${deltaColor(summary.ig.followers_delta)}">${fmtDeltaPdf(summary.ig.followers_delta)} nel periodo</div>
        </td>
        <td><div class="lbl">Persone raggiunte</div>
          <div class="val">${fmtIt(summary.ig.reach_total)}</div>
          <div class="dlt">somma giornaliera</div>
        </td>
        <td><div class="lbl">Visite al profilo</div>
          <div class="val">${fmtIt(summary.ig.profile_views_total || 0)}</div>
        </td>
      </tr></table>
    </div>` : '';

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

  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><title>Report ${escapeHtml(client.display_name)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  @page { margin: 16mm 12mm; size: A4; }
  body { font-family: Inter, Helvetica, Arial, sans-serif; color: #111; font-size: 12px; line-height: 1.4; margin: 0; }
  .cover { padding: 0 0 18px; border-bottom: 3px solid #2563eb; margin-bottom: 22px; }
  .cover h1 { font-size: 26px; margin: 0 0 4px; color: #0f1e4a; }
  .cover .sub { color: #6b7280; font-size: 13px; }
  .cover .pill { display: inline-block; background: #2563eb; color: white; padding: 3px 10px; border-radius: 14px; font-size: 11px; font-weight: 600; margin-top: 8px; }
  h2 { font-size: 15px; margin: 24px 0 10px; color: #1e3a8a; border-left: 3px solid #2563eb; padding-left: 8px; }
  .kpi-block { margin-bottom: 16px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; }
  .kpi-platform { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; color: white; margin-bottom: 8px; letter-spacing: 0.5px; }
  .kpi-platform.fb { background: #1877f2; }
  .kpi-platform.ig { background: #e4405f; }
  .kpi-grid { width: 100%; border-collapse: collapse; }
  .kpi-grid td { padding: 4px 8px; vertical-align: top; width: 33%; border: 0; }
  .kpi-grid .lbl { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .kpi-grid .val { font-size: 22px; font-weight: 700; color: #111; margin-top: 2px; letter-spacing: -0.4px; }
  .kpi-grid .dlt { font-size: 10px; color: #6b7280; margin-top: 2px; }
  .chart-wrap { width: 100%; height: 220px; margin-bottom: 12px; }
  table.top { width: 100%; border-collapse: collapse; }
  table.top th, table.top td { border: 1px solid #e5e7eb; padding: 6px 8px; font-size: 11px; vertical-align: middle; }
  table.top th { background: #f9fafb; font-weight: 600; text-align: left; font-size: 10px; }
  table.top td.rank { background: #2563eb; color: white; font-weight: 700; text-align: center; width: 26px; }
  table.top td.num { text-align: right; font-weight: 600; }
  .mt { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-weight: 600; }
  .mt-single_image { background: #e5e7eb; color: #374151; }
  .mt-carousel    { background: #fef3c7; color: #92400e; }
  .mt-reel        { background: #ede9fe; color: #5b21b6; }
  .mt-video       { background: #ede9fe; color: #5b21b6; }
  .mt-story       { background: #fce7f3; color: #9d174d; }
  .empty { text-align: center; padding: 24px; color: #9ca3af; font-style: italic; }
  footer { margin-top: 30px; font-size: 9px; color: #9ca3af; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 8px; }
  .intro { background: #eff6ff; border-left: 3px solid #2563eb; padding: 8px 12px; border-radius: 4px; font-size: 11px; color: #1e40af; margin: 0 0 18px; }
  .kpi-summary { display: flex; gap: 10px; margin: 0 0 8px; }
  .kpi-summary .ks-cell { flex: 1; background: #0f1e4a; color: #fff; border-radius: 8px; padding: 12px 14px; }
  .kpi-summary .ks-lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.82; font-weight: 600; }
  .kpi-summary .ks-val { font-size: 23px; font-weight: 700; margin-top: 4px; letter-spacing: -0.5px; }
</style>
</head><body>
  <div class="cover">
    <h1>Report performance social</h1>
    <div class="sub">${escapeHtml(client.display_name)}${client.location ? ' · ' + escapeHtml(client.location) : ''}</div>
    <div class="pill">${escapeHtml(periodLabel)}</div>
    <div class="sub" style="margin-top:6px">Generato il ${today}</div>
  </div>

  <div class="intro">Questo documento riassume i risultati delle attività social del periodo indicato: crescita follower, persone raggiunte e contenuti più performanti. I dati sono aggiornati quotidianamente dalle piattaforme Meta.</div>

  ${noData ? '<div class="empty">Nessun dato ancora disponibile. Il report sarà completo dal prossimo periodo.</div>' : ''}

  ${!noData && kpiSummary ? `<h2>In sintesi</h2>${kpiSummary}` : ''}

  <h2>Andamento periodo</h2>
  ${fbCard}
  ${igCard}

  ${history && history.length ? `
    <h2>Crescita follower</h2>
    <div class="chart-wrap"><canvas id="ch-followers"></canvas></div>

    <h2>Reach giornaliero</h2>
    <div class="chart-wrap"><canvas id="ch-reach"></canvas></div>
  ` : ''}

  <h2>Top 5 post per engagement</h2>
  ${topRows ? `<table class="top">
    <thead><tr><th>#</th><th>Contenuto</th><th>Tipo</th><th>Pubblicato</th><th>Interazioni</th><th>Reach</th></tr></thead>
    <tbody>${topRows}</tbody>
  </table>` : '<div class="empty">Nessun post pubblicato nel periodo.</div>'}

  <footer>Report fornito da EMC Digital Solutions — emcdigitalsolutions.it</footer>

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
    // Aspetta che Chart.js abbia disegnato i grafici
    await page.waitForFunction(() => window._chartsReady === true, { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
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
