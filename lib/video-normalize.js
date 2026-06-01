/**
 * video-normalize.js — analisi + normalizzazione video per pubblicazione Meta.
 *
 * Problema: i video caricati dall'utente (spesso iPhone HEVC in container .mov,
 * oppure 4K, 10-bit, audio non-AAC) vengono rifiutati da Meta al publish con
 * errori generici. Finora l'admin doveva ri-encodare a mano con HandBrake.
 *
 * Soluzione: in fase di upload facciamo `ffprobe` (istantaneo) per leggere le
 * proprietà reali del video. Se NON è conforme alle specifiche Meta, lo
 * ri-encodiamo automaticamente verso un profilo H.264/AAC IG-safe — gli STESSI
 * flag già provati in produzione da lib/video-trim.js. Se è già conforme, lo
 * lasciamo intatto (fast path, nessun re-encode).
 *
 * Non forziamo l'aspect ratio: preserviamo le proporzioni del sorgente
 * (eventuale crop/letterbox resta una scelta dell'utente via crop/trim tool).
 * Ci limitiamo a: ridurre dentro 1920px lato lungo, arrotondare a dimensioni
 * pari, e correggere codec/container/audio/pixel-format/level.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Lato lungo massimo: oltre questo ridimensioniamo (preservando l'AR).
const MAX_DIM = 1920;
// Level H.264 massimo accettato (4.2 → ffprobe lo riporta come 42).
const LEVEL_MAX = 42;
// Profili H.264 accettati da Meta (no High 10 / 4:2:2 / 4:4:4 a 10-bit).
const OK_PROFILES = new Set(['Constrained Baseline', 'Baseline', 'Main', 'High']);
// Pixel format accettato (8-bit 4:2:0 limited-range).
const OK_PIX_FMT = new Set(['yuv420p']);

function runProc(cmd, args, label = cmd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => {
      const e = new Error(`${label}: spawn fallito — ${err.message}`);
      e.code = err.code; // ENOENT se ffmpeg/ffprobe non installati
      reject(e);
    });
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.split('\n').slice(-15).join('\n');
      reject(new Error(`${label} exit ${code}\n${tail}`));
    });
  });
}

/**
 * Legge le proprietà reali del video via ffprobe.
 * @returns {Promise<object>} probe normalizzato
 */
async function probeVideo(filePath) {
  const { stdout } = await runProc('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], 'ffprobe');

  const data = JSON.parse(stdout);
  const streams = data.streams || [];
  const v = streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');
  if (!v) throw new Error('Nessuna traccia video trovata nel file');

  const duration = parseFloat((data.format && data.format.duration) || v.duration || 0) || 0;

  // fps da r_frame_rate "30000/1001" → 29.97
  let fps = null;
  if (v.r_frame_rate && v.r_frame_rate.includes('/')) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }

  return {
    container: (data.format && data.format.format_name) || '',
    duration,
    width: v.width || 0,
    height: v.height || 0,
    vcodec: v.codec_name || '',
    pix_fmt: v.pix_fmt || '',
    profile: v.profile || '',
    level: typeof v.level === 'number' ? v.level : null,
    fps,
    acodec: a ? (a.codec_name || '') : null,
    asample_rate: a ? parseInt(a.sample_rate, 10) || null : null
  };
}

/**
 * Analizza un probe rispetto alle specifiche Meta. Funzione PURA (testabile).
 * @param {object} probe - output di probeVideo
 * @returns {{conforming:boolean, needsReencode:boolean, issues:string[], warnings:string[]}}
 */
function analyzeVideoForMeta(probe) {
  const issues = [];   // problemi che richiedono re-encode
  const warnings = []; // info non bloccanti

  if (probe.vcodec && probe.vcodec !== 'h264') {
    issues.push(`codec video "${probe.vcodec}" non supportato (richiesto H.264)`);
  }
  if (probe.pix_fmt && !OK_PIX_FMT.has(probe.pix_fmt)) {
    issues.push(`pixel format "${probe.pix_fmt}" non supportato (richiesto yuv420p 8-bit)`);
  }
  if (probe.profile && !OK_PROFILES.has(probe.profile)) {
    issues.push(`profilo H.264 "${probe.profile}" non supportato`);
  }
  if (typeof probe.level === 'number' && probe.level > 0 && probe.level > LEVEL_MAX) {
    issues.push(`level ${(probe.level / 10).toFixed(1)} troppo alto (max 4.2)`);
  }
  if (probe.acodec && probe.acodec !== 'aac') {
    issues.push(`audio "${probe.acodec}" non supportato (richiesto AAC)`);
  }
  if (probe.width && probe.height && (probe.width % 2 !== 0 || probe.height % 2 !== 0)) {
    issues.push(`dimensioni dispari ${probe.width}x${probe.height} (Meta richiede pari)`);
  }
  if ((probe.width && probe.width > MAX_DIM) || (probe.height && probe.height > MAX_DIM)) {
    issues.push(`risoluzione ${probe.width}x${probe.height} oltre ${MAX_DIM}px (verrà ridotta)`);
  }
  const container = (probe.container || '').toLowerCase();
  if (container && !/mp4|mov|m4a|3gp|quicktime|isom/.test(container)) {
    issues.push(`container "${probe.container}" non supportato (richiesto MP4/MOV)`);
  }

  // Warning informativi (non innescano re-encode)
  if (probe.duration && probe.duration > 90) {
    warnings.push(`durata ${Math.round(probe.duration)}s: oltre i 90s i Reel possono essere rifiutati o tagliati`);
  }
  if (probe.acodec === null) {
    warnings.push('nessuna traccia audio: alcuni Reel preferiscono un audio (anche silenzioso)');
  }

  return {
    conforming: issues.length === 0,
    needsReencode: issues.length > 0,
    issues,
    warnings
  };
}

/**
 * Costruisce gli argomenti ffmpeg per il re-encode IG-safe.
 * Stessi flag di lib/video-trim.js (provati in produzione) + scale ratio-safe.
 */
function buildReencodeArgs(inputPath, outputPath) {
  // 1° scale: riduci dentro il box 1920x1920 preservando l'AR (solo se più grande).
  // 2° scale: arrotonda a dimensioni pari. Le virgole dentro min() sono escapate
  // con backslash perché nella filtergraph la virgola separa i filtri.
  const vf = "scale=w='min(iw\\,1920)':h='min(ih\\,1920)':force_original_aspect_ratio=decrease,scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'";

  return [
    '-y',
    '-i', inputPath,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-profile:v', 'high',
    '-level', '4.2',
    '-pix_fmt', 'yuv420p',
    '-bf', '0',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-color_range', 'tv',
    '-x264-params', 'keyint=60:min-keyint=60:scenecut=0',
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-ar', '48000',
    '-b:a', '128k',
    '-ac', '2',
    '-movflags', '+faststart',
    '-brand', 'mp42',
    outputPath
  ];
}

/**
 * Normalizza un video per Meta SE non conforme. Idempotente: su un file già
 * conforme non fa nulla (fast path).
 *
 * @param {string} filePath - video da normalizzare (verrà sovrascritto se re-encodato)
 * @returns {Promise<object>} {
 *   changed, conforming, issues, warnings,
 *   width, height, durationSec,   // dal file finale
 *   probe                          // probe iniziale
 * }
 */
async function normalizeVideoForMeta(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('Video non trovato: ' + filePath);

  let probe;
  try {
    probe = await probeVideo(filePath);
  } catch (err) {
    // ffprobe assente (ENOENT) o file illeggibile: non blocchiamo l'upload.
    return {
      changed: false,
      conforming: null,
      issues: [],
      warnings: [],
      width: null,
      height: null,
      durationSec: null,
      probe: null,
      error: err.message
    };
  }

  const analysis = analyzeVideoForMeta(probe);

  if (!analysis.needsReencode) {
    return {
      changed: false,
      conforming: true,
      issues: [],
      warnings: analysis.warnings,
      width: probe.width || null,
      height: probe.height || null,
      durationSec: probe.duration || null,
      probe
    };
  }

  // Re-encode verso file temporaneo nella stessa cartella, poi rimpiazza.
  const ext = path.extname(filePath) || '.mp4';
  const tmpOut = filePath.replace(new RegExp(`${ext.replace('.', '\\.')}$`), '') + '.norm' + ext;
  try {
    await runProc('ffmpeg', buildReencodeArgs(filePath, tmpOut), 'video-normalize');
  } catch (err) {
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (_) {}
    // Re-encode fallito: teniamo l'originale, segnaliamo come warning.
    return {
      changed: false,
      conforming: false,
      issues: analysis.issues,
      warnings: analysis.warnings,
      width: probe.width || null,
      height: probe.height || null,
      durationSec: probe.duration || null,
      probe,
      error: 'Re-encode fallito: ' + err.message
    };
  }

  // Sostituisci l'originale col file normalizzato
  fs.renameSync(tmpOut, filePath);

  // Re-probe per dimensioni/durata finali
  let finalProbe = probe;
  try { finalProbe = await probeVideo(filePath); } catch (_) { /* usa probe iniziale */ }

  return {
    changed: true,
    conforming: true,
    issues: analysis.issues,
    warnings: analysis.warnings,
    width: finalProbe.width || null,
    height: finalProbe.height || null,
    durationSec: finalProbe.duration || null,
    probe
  };
}

module.exports = {
  probeVideo,
  analyzeVideoForMeta,
  normalizeVideoForMeta,
  buildReencodeArgs,
  MAX_DIM,
  LEVEL_MAX
};
