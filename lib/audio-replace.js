// Sostituisce la traccia audio di un video con un altro file audio,
// con trim opzionale dell'audio (per scegliere solo il ritornello, ecc.) e
// loop automatico se l'audio trimmato è più corto del video.
//
// La pipeline:
//   1) ffprobe per leggere durata del video
//   2) ffmpeg con -c:v copy (no re-encode video, veloce) e -c:a aac
//      preset IG-safe (48kHz, 96k, stereo)
//   3) -stream_loop -1 sull'input audio + -t <video_duration> in output
//      → l'audio si ripete finché il video finisce
//
// Output IG-safe: stessi flag di video-slideshow (mp42 brand, faststart).

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
 * Sostituisce la traccia audio del video con audioPath, opzionalmente trimmato
 * tra startSec ed endSec, loopato per coprire tutta la durata del video.
 *
 * @param {object} opts
 * @param {string} opts.videoPath  - input video (assoluto)
 * @param {string} opts.audioPath  - input audio (assoluto)
 * @param {number} [opts.startSec=0]
 * @param {number|null} [opts.endSec=null] - se null, fino a fine traccia
 * @param {string} opts.outputPath
 * @returns {Promise<{path:string, durationSec:number}>}
 */
async function replaceVideoAudio({ videoPath, audioPath, startSec = 0, endSec = null, outputPath }) {
  if (!fs.existsSync(videoPath)) throw new Error('Video non trovato: ' + videoPath);
  if (!fs.existsSync(audioPath)) throw new Error('Audio non trovato: ' + audioPath);
  if (!outputPath) throw new Error('outputPath richiesto');

  const videoDuration = await getDurationSec(videoPath);
  const audioDuration = await getDurationSec(audioPath);

  const s = Math.max(0, Number(startSec) || 0);
  let e = (endSec == null || endSec === '') ? audioDuration : Number(endSec);
  if (isNaN(e) || e <= s) throw new Error(`Trim non valido: start=${s}, end=${e}`);
  if (e > audioDuration) e = audioDuration;
  if (e - s < 0.1) throw new Error('Trim audio troppo corto (<0.1s)');

  // Trim + loop in un solo filter_complex:
  //   atrim=start=S:end=E   → ritaglia il segmento richiesto
  //   asetpts=PTS-STARTPTS  → reset timestamp a 0 (necessario dopo atrim)
  //   aloop=loop=-1:size=N  → loop infinito (N=2^31-1 sample = ~12 ore @ 48kHz)
  // Il -t a livello output tronca alla durata esatta del video.
  // -stream_loop è inaffidabile combinato con -ss/-to su file MP3/M4A.
  const filter = `[1:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS,aloop=loop=-1:size=2147483647[aout]`;

  const args = [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-filter_complex', filter,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-ar', '48000',
    '-b:a', '96k',
    '-ac', '2',
    '-t', videoDuration.toFixed(3),
    '-movflags', '+faststart',
    '-brand', 'mp42',
    outputPath
  ];

  await runProc('ffmpeg', args, 'audio-replace');
  return { path: outputPath, durationSec: videoDuration };
}

module.exports = { replaceVideoAudio, getDurationSec };
