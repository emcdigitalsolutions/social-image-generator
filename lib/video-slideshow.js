// Genera un video slideshow Ken Burns da N immagini statiche tramite ffmpeg.
// Niente AI generativa video: anima immagini esistenti con zoom+pan + crossfade.
// Output: MP4 H.264 + AAC, dimensioni IG-safe (1080x1920 / 1080x1080 / 1920x1080).

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const RATIO_DIMS = {
  '1:1':  { w: 1080, h: 1080 },
  '4:5':  { w: 1080, h: 1350 },
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 }
};

const FPS = 30;

// Esegue ffmpeg, risolve con stdout/stderr aggregati. Rifiuta su exit != 0.
function runFfmpeg(args, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => reject(new Error(`${label}: spawn failed — ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stderr });
      // ffmpeg verbose va in stderr anche per success — tronchiamo per error message
      const tail = stderr.split('\n').slice(-15).join('\n');
      reject(new Error(`${label} exit ${code}\n${tail}`));
    });
  });
}

/**
 * Costruisce il filter_complex per Ken Burns + crossfade.
 *
 * Ogni clip: scale a 4x dimensione finale → zoompan con zoom progressivo (in/out
 * alternato per varietà). Il pattern di alternanza evita che tutte le clip
 * abbiano lo stesso movimento.
 *
 * Crossfade tra clip consecutive (xfade filter): durata 0.5s, offset =
 * (clipDuration - 0.5) per ogni transizione.
 */
function buildFilterComplex(numClips, clipDuration, w, h) {
  const totalFrames = clipDuration * FPS;
  const parts = [];

  for (let i = 0; i < numClips; i++) {
    // Pattern alternato: pari = zoom-in (1.0 → 1.3), dispari = zoom-out (1.3 → 1.0)
    const isZoomIn = (i % 2 === 0);
    // d = numero di frame totali del zoompan (durata clip in frames)
    // s = output size del filtro
    // Scaliamo prima a 4× per evitare jitter sub-pixel
    const scaleW = w * 4;
    const scaleH = h * 4;
    let zoomExpr;
    if (isZoomIn) {
      // Da 1.0 a 1.3: incremento lineare 0.3 / totalFrames per frame
      const incr = (0.3 / totalFrames).toFixed(6);
      zoomExpr = `min(zoom+${incr},1.3)`;
    } else {
      // Da 1.3 a 1.0: parto da 1.3 e decremento. zoompan parte sempre da 1.0,
      // quindi uso un trick: se zoom <= 1.001 (frame iniziale), set 1.3, poi decrement.
      const decr = (0.3 / totalFrames).toFixed(6);
      zoomExpr = `if(lte(zoom\\,1.001)\\,1.3\\,max(1.001\\,zoom-${decr}))`;
    }
    // Pan: leggero spostamento x/y per dare profondità (tipo dolly)
    const xExpr = isZoomIn ? `iw/2-(iw/zoom/2)` : `iw/2-(iw/zoom/2)+sin(on/${totalFrames}*PI)*30`;
    const yExpr = `ih/2-(ih/zoom/2)`;

    parts.push(
      `[${i}:v]scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,crop=${scaleW}:${scaleH},zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${FPS},setsar=1[v${i}]`
    );
  }

  // Concatenazione con crossfade. Se numClips=1 nessun xfade, output = v0.
  if (numClips === 1) {
    parts.push(`[v0]copy[outv]`);
    return parts.join(';');
  }

  // Cascata di xfade: v0+v1 → x1, x1+v2 → x2, ...
  const FADE_DUR = 0.5;
  let prev = 'v0';
  for (let i = 1; i < numClips; i++) {
    const out = (i === numClips - 1) ? 'outv' : `x${i}`;
    // offset = (i * clipDuration) - FADE_DUR per la i-esima transizione
    const offset = (i * clipDuration - FADE_DUR).toFixed(2);
    parts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${FADE_DUR}:offset=${offset}[${out}]`);
    prev = out;
  }

  return parts.join(';');
}

/**
 * Crea un video slideshow Ken Burns dalle immagini fornite.
 *
 * @param {string[]} imagePaths - paths assoluti alle immagini (almeno 1)
 * @param {object}   opts
 * @param {string}   opts.aspectRatio - '1:1' | '4:5' | '9:16' | '16:9' (default '9:16')
 * @param {number}   opts.clipDuration - secondi per immagine (default 4)
 * @param {string}   opts.outputPath - path di destinazione MP4
 * @param {string?}  opts.audioPath - path audio (mp3/m4a) opzionale
 * @returns {Promise<{path: string, durationSec: number}>}
 */
async function createSlideshow(imagePaths, opts) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error('imagePaths deve contenere almeno 1 immagine');
  }
  for (const p of imagePaths) {
    if (!fs.existsSync(p)) throw new Error('Immagine non trovata: ' + p);
  }

  const aspectRatio = opts.aspectRatio || '9:16';
  const dims = RATIO_DIMS[aspectRatio] || RATIO_DIMS['9:16'];
  const clipDuration = Math.max(2, Math.min(8, parseInt(opts.clipDuration, 10) || 4));
  const outputPath = opts.outputPath;
  if (!outputPath) throw new Error('outputPath richiesto');

  const numClips = imagePaths.length;
  // Durata totale: numClips * clipDuration - (numClips-1) * fadeDuration
  const FADE_DUR = 0.5;
  const totalDuration = numClips * clipDuration - (numClips - 1) * FADE_DUR;

  const args = [];

  // ── INPUTS ────────────────────────────────────────────────────
  // Tutte le immagini come loop di clipDuration secondi
  for (const img of imagePaths) {
    args.push('-loop', '1', '-t', String(clipDuration), '-i', img);
  }
  // Audio: file utente (loopato indefinitamente per coprire tutta la durata
  // video — evita -shortest che taglierebbe il video se l'audio è più breve)
  // oppure traccia silenzio AAC-compat (IG rifiuta video senza traccia audio).
  let audioInputIdx;
  if (opts.audioPath && fs.existsSync(opts.audioPath)) {
    args.push('-stream_loop', '-1', '-i', opts.audioPath);
    audioInputIdx = numClips;
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    audioInputIdx = numClips;
  }

  // ── FILTER COMPLEX (video Ken Burns + crossfade) ──────────────
  const filterComplex = buildFilterComplex(numClips, clipDuration, dims.w, dims.h);
  args.push('-filter_complex', filterComplex);

  // ── MAPPING ───────────────────────────────────────────────────
  args.push('-map', '[outv]');
  args.push('-map', `${audioInputIdx}:a`);

  // ── CODEC VIDEO — preset IG-safe ──────────────────────────────
  // Errore IG 2207076 spesso = profilo H.264 non standard. Forziamo high@4.0
  // (compatibile con tutti i decoder mobile + desktop). Color tags BT.709
  // sono richiesti da Meta per evitare flagging "non-standard color space".
  // GOP fisso (keyint=2 sec @ 30fps = 60 frames, scenecut disabilitato) →
  // playback predicibile, no salti su decoder Meta.
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-profile:v', 'high',
    '-level', '4.0',
    '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-x264-params', 'keyint=60:min-keyint=60:scenecut=0',
    '-movflags', '+faststart',
    '-r', String(FPS)
  );

  // ── CODEC AUDIO — AAC LC stereo 44.1kHz (IG-safe) ─────────────
  args.push(
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2'
  );

  // Durata totale del video output (taglia anche l'audio loopato)
  args.push('-t', String(totalDuration.toFixed(2)));
  args.push('-y', outputPath);

  await runFfmpeg(args, 'slideshow');

  return { path: outputPath, durationSec: totalDuration, width: dims.w, height: dims.h };
}

module.exports = { createSlideshow, RATIO_DIMS };
