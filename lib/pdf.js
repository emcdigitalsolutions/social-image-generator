/**
 * pdf.js — generazione PDF lato server via Puppeteer (riusa il browser pool del renderer).
 * Per ora: PDF del piano editoriale (1 endpoint, 1 template).
 */
'use strict';

const path = require('path');
const fs = require('fs/promises');
const puppeteer = require('puppeteer-core');

let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none']
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

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
  const html = buildPlanHtml(client, plan);
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' }
    });
    return buffer;
  } finally {
    await page.close();
  }
}

module.exports = { renderPlanPdf, buildPlanHtml };
