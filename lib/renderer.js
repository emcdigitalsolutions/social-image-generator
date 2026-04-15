const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'images');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const VIEWPORT = { width: 1080, height: 1080, deviceScaleFactor: 1 };

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

let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;

  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  });

  browser.on('disconnected', () => { browser = null; });
  return browser;
}

async function loadTemplate(templateName) {
  const htmlPath = path.join(TEMPLATES_DIR, `${templateName}.html`);
  const cssPath = path.join(TEMPLATES_DIR, 'base.css');

  const [html, css] = await Promise.all([
    fs.readFile(htmlPath, 'utf-8'),
    fs.readFile(cssPath, 'utf-8'),
  ]);

  return html.replace('/* {{BASE_CSS}} */', css);
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
  const defaults = CLIENT_DEFAULTS[client] || {};
  const mergedData = { ...defaults, ...data };

  const html = await loadTemplate(templateName);
  const finalHtml = injectData(html, mergedData);

  // Load logo SVG and inject
  const logoFile = defaults.logo || 'logo-dr.svg';
  const logoPath = path.join(ASSETS_DIR, logoFile);
  let logoSvg = '';
  try {
    logoSvg = await fs.readFile(logoPath, 'utf-8');
  } catch { /* logo optional */ }
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

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

module.exports = { renderImage, closeBrowser };
