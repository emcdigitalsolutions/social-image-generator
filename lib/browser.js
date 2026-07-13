/**
 * browser.js — singleton browser Puppeteer condiviso tra renderer (immagini)
 * e pdf (export piano editoriale). Avere DUE istanze Chromium nello stesso
 * container Docker piccolo causa contesa di memoria / hang dell'avvio del
 * secondo browser → unifichiamo qui.
 */
'use strict';

const puppeteer = require('puppeteer-core');

let browser = null;
let launching = null; // promise di un launch in corso (evita race)

async function getBrowser() {
  if (browser && browser.connected) return browser;
  if (launching) return launching;

  launching = puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/local/bin/chrome-cft',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none'
    ]
  }).then(b => {
    b.on('disconnected', () => { browser = null; });
    browser = b;
    launching = null;
    return b;
  }).catch(err => {
    launching = null;
    throw err;
  });

  return launching;
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
  }
}

module.exports = { getBrowser, closeBrowser };
