// Trim di un video: ritaglia il segmento [startSec, endSec] re-encodando
// con preset IG-safe (level 4.2, no B-frame, AAC 48kHz, mp42 brand).
//
// Re-encode invece di -c copy: garantisce precisione esatta del taglio
// (no keyframe-rounding) e specs IG-safe anche se il sorgente non lo era.
// Tempo di esecuzione: ~3-5s per video di pochi secondi.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function runProc(cmd, args, label = cmd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => reject(new Error(`${label}: spawn failed — ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.split('\n').slice(-15).join('\n');
      reject(new Error(`${label} exit ${code}\n${tail}`));
    });
  });
}

async function getDurationSec(filePath) {
  const { stdout } = await runProc('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    filePath
  ], 'ffprobe');
  const d = parseFloat(stdout.trim());
  if (isNaN(d) || d <= 0) throw new Error('Durata non leggibile per ' + path.basename(filePath));
  return d;
}

/**
 * Ritaglia un video tra startSec ed endSec.
 *
 * @param {object} opts
 * @param {string} opts.videoPath - input video assoluto
 * @param {number} opts.startSec
 * @param {number} opts.endSec
 * @param {string} opts.outputPath
 * @returns {Promise<{path:string, durationSec:number}>}
 */
async function trimVideo({ videoPath, startSec, endSec, outputPath }) {
  if (!fs.existsSync(videoPath)) throw new Error('Video non trovato: ' + videoPath);
  if (!outputPath) throw new Error('outputPath richiesto');

  const total = await getDurationSec(videoPath);
  const s = Math.max(0, Number(startSec) || 0);
  let e = Number(endSec);
  if (isNaN(e) || e <= s) throw new Error(`Trim non valido: start=${s}, end=${e}`);
  if (e > total) e = total;
  const newDur = e - s;
  if (newDur < 0.5) throw new Error('Trim troppo corto (<0.5s)');

  // Output seek (-ss/-to dopo -i): preciso al frame, lento di più ma su video
  // brevi è trascurabile. Re-encode con specs IG-safe consolidate (vedi
  // lib/video-slideshow.js — stessi flag).
  const args = [
    '-y',
    '-i', videoPath,
    '-ss', s.toFixed(3),
    '-to', e.toFixed(3),
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
    '-b:a', '96k',
    '-ac', '2',
    '-movflags', '+faststart',
    '-brand', 'mp42',
    outputPath
  ];

  await runProc('ffmpeg', args, 'video-trim');
  return { path: outputPath, durationSec: newDur };
}

module.exports = { trimVideo, getDurationSec };
