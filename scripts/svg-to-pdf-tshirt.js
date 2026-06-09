// Genera PNG trasparenti @300 DPI dai 2 SVG bordeaux di terredimiele/tshirt.
// (PNG non supporta CMYK — colorspace RGBA. Per CMYK usare PDF/TIFF.)

'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const TSHIRT_DIR = 'C:\\workspace\\terredimiele\\tshirt';

const DPI = 300;
const MM_TO_PX = (mm) => Math.round((mm / 25.4) * DPI);

const JOBS = [
  { in: 'tshirt-fronte-90mm-bordeaux.svg', base: 'tshirt-fronte-90mm-bordeaux', widthMm: 90,  heightMm: 82  },
  { in: 'tshirt-retro-250mm-bordeaux.svg', base: 'tshirt-retro-250mm-bordeaux', widthMm: 250, heightMm: 125 }
];

function buildHtml(svgInline, widthCss, heightCss) {
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,800;1,400;1,700;1,800&family=DM+Sans:wght@400;700;800&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { width: ${widthCss}; height: ${heightCss}; }
  svg { display: block; width: ${widthCss}; height: ${heightCss}; }
</style>
</head>
<body>
${svgInline}
</body>
</html>`;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none']
  });

  try {
    for (const job of JOBS) {
      const inPath = path.join(TSHIRT_DIR, job.in);
      const svgInline = fs.readFileSync(inPath, 'utf8')
        .replace(/<\?xml[^?]*\?>\s*/i, '')
        .replace(/<!--[\s\S]*?-->/g, '');

      const wpx = MM_TO_PX(job.widthMm);
      const hpx = MM_TO_PX(job.heightMm);
      const html = buildHtml(svgInline, `${wpx}px`, `${hpx}px`);
      const page = await browser.newPage();
      await page.setViewport({ width: wpx, height: hpx, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.evaluateHandle('document.fonts.ready');

      const pngPath = path.join(TSHIRT_DIR, `${job.base}.png`);
      await page.screenshot({
        path: pngPath,
        type: 'png',
        omitBackground: true,
        clip: { x: 0, y: 0, width: wpx, height: hpx }
      });
      await page.close();

      const s = fs.statSync(pngPath);
      console.log(`[PNG] ${job.base}.png  ${s.size} bytes  (${wpx}×${hpx} px @${DPI} DPI)`);
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
