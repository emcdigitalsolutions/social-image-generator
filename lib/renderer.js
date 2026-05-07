const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getBrowser, closeBrowser } = require('./browser');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'images');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const VIEWPORT = { width: 1080, height: 1080, deviceScaleFactor: 1 };

// Branding folder per cliente: public/images/<clientId>/branding/
// Sotto il volume Coolify persistente (a differenza di assets/ e templates/
// che vengono ricreati a ogni deploy del container).
function brandingDir(clientId) {
  return path.join(PUBLIC_DIR, clientId, 'branding');
}

// Client branding defaults — used when brand fields are not passed in data
const CLIENT_DEFAULTS = {
  fratellidirosa: {
    brand_name: 'Fratelli Di Rosa',
    website: 'fratellidirosa.it',
    tagline: 'Agenzia Funebre — Ravanusa',
    logo: 'logo-dr.svg',
  },
  emcdigitalsolutions: {
    brand_name: 'EMC Digital Solutions',
    website: 'emcdigitalsolutions.it',
    tagline: 'Digital Solutions',
    logo: 'logo-emc.svg',
  },
};

// Risolvi i defaults del cliente: DB ha precedenza (l'utente carica logo
// e brand info dall'UI), CLIENT_DEFAULTS hardcoded sono solo fallback per
// campi mancanti dal DB. Prima la logica era invertita → loghi caricati
// dall'UI venivano ignorati per i clienti hardcoded come emcdigitalsolutions.
function getClientDefaults(clientId) {
  const hard = CLIENT_DEFAULTS[clientId] || {};
  let dbVals = {};
  try {
    const { getDb } = require('./db');
    const db = getDb();
    const client = db.prepare('SELECT brand_name, display_name, website, tagline, logo_filename FROM clients WHERE id = ?').get(clientId);
    if (client) {
      dbVals = {
        brand_name: client.brand_name || client.display_name || undefined,
        website:    client.website || undefined,
        tagline:    client.tagline || undefined,
        logo:       client.logo_filename || undefined
      };
    }
  } catch { /* DB not available */ }
  // Merge: DB > hardcoded. Filtra undefined per non sovrascrivere hardcoded
  // con campi mancanti.
  const merged = { ...hard };
  for (const [k, v] of Object.entries(dbVals)) {
    if (v !== undefined && v !== null && v !== '') merged[k] = v;
  }
  if (!merged.brand_name) merged.brand_name = clientId;
  return merged;
}

// Browser pool ora gestito in lib/browser.js — singleton condiviso anche con lib/pdf.js

async function loadTemplate(templateName, client) {
  const htmlPath = path.join(TEMPLATES_DIR, `${templateName}.html`);
  const cssPath = path.join(TEMPLATES_DIR, 'base.css');

  const [html, baseCss] = await Promise.all([
    fs.readFile(htmlPath, 'utf-8'),
    fs.readFile(cssPath, 'utf-8'),
  ]);

  // Tema CSS del cliente: prima cerca in branding/ runtime (caricato dall'UI),
  // poi fallback su templates/themes/<client>.css per i preset hardcoded.
  let themeCss = '';
  const runtimeThemePath = path.join(brandingDir(client), `${client}.css`);
  const presetThemePath = path.join(TEMPLATES_DIR, 'themes', `${client}.css`);
  try {
    themeCss = await fs.readFile(runtimeThemePath, 'utf-8');
  } catch {
    try {
      themeCss = await fs.readFile(presetThemePath, 'utf-8');
    } catch { /* nessun tema — usa solo base */ }
  }

  const combinedCss = baseCss + '\n' + themeCss;
  return html.replace('/* {{BASE_CSS}} */', combinedCss);
}

function injectData(html, data) {
  let result = html;
  for (const [key, value] of Object.entries(data)) {
    const placeholder = `{{${key.toUpperCase()}}}`;
    result = result.replaceAll(placeholder, value || '');
  }
  return result;
}

async function renderImage(templateName, client, data) {
  // Merge client defaults with passed data (passed data wins)
  const defaults = getClientDefaults(client);
  const mergedData = { ...defaults, ...data };

  const html = await loadTemplate(templateName, client);
  const finalHtml = injectData(html, mergedData);

  // Load logo SVG: prima cerca in branding/ runtime del cliente (caricato
  // dall'UI), fallback su assets/ per i preset hardcoded (CLIENT_DEFAULTS).
  const logoFile = defaults.logo || '';
  let logoSvg = '';
  if (logoFile) {
    const runtimeLogoPath = path.join(brandingDir(client), logoFile);
    const presetLogoPath = path.join(ASSETS_DIR, logoFile);
    try {
      logoSvg = await fs.readFile(runtimeLogoPath, 'utf-8');
    } catch {
      try {
        logoSvg = await fs.readFile(presetLogoPath, 'utf-8');
      } catch { /* logo optional */ }
    }
  }
  const htmlWithLogo = finalHtml.replaceAll('{{LOGO_SVG}}', logoSvg);

  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setViewport(VIEWPORT);
    await page.setContent(htmlWithLogo, {
      waitUntil: 'networkidle0',
      timeout: 15000,
    });

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);

    // Wait a bit for any CSS transitions/animations to settle
    await new Promise(r => setTimeout(r, 300));

    const filename = `${uuidv4()}.png`;
    const clientDir = path.join(PUBLIC_DIR, client);
    await fs.mkdir(clientDir, { recursive: true });
    const filePath = path.join(clientDir, filename);

    await page.screenshot({
      path: filePath,
      type: 'png',
      omitBackground: false,
    });

    return { filename, filePath };
  } finally {
    await page.close();
  }
}

module.exports = { renderImage, closeBrowser };
