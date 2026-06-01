const { analyzeVideoForMeta, buildReencodeArgs, MAX_DIM, LEVEL_MAX } = require('../lib/video-normalize');

// Probe "ideale": H.264 high, yuv420p, level 4.0, AAC, 1080x1920, mp4.
function conformingProbe(overrides = {}) {
  return Object.assign({
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: 12,
    width: 1080,
    height: 1920,
    vcodec: 'h264',
    pix_fmt: 'yuv420p',
    profile: 'High',
    level: 40,
    fps: 30,
    acodec: 'aac',
    asample_rate: 48000
  }, overrides);
}

describe('analyzeVideoForMeta — conformità', () => {
  test('video già conforme: nessun re-encode', () => {
    const a = analyzeVideoForMeta(conformingProbe());
    expect(a.conforming).toBe(true);
    expect(a.needsReencode).toBe(false);
    expect(a.issues).toHaveLength(0);
  });

  test('HEVC (hevc) → re-encode', () => {
    const a = analyzeVideoForMeta(conformingProbe({ vcodec: 'hevc' }));
    expect(a.needsReencode).toBe(true);
    expect(a.issues.join(' ')).toMatch(/H\.264/);
  });

  test('pixel format 10-bit (yuv420p10le) → re-encode', () => {
    const a = analyzeVideoForMeta(conformingProbe({ pix_fmt: 'yuv420p10le' }));
    expect(a.needsReencode).toBe(true);
    expect(a.issues.join(' ')).toMatch(/pixel format/);
  });

  test('pixel format full-range (yuvj420p) → re-encode', () => {
    const a = analyzeVideoForMeta(conformingProbe({ pix_fmt: 'yuvj420p' }));
    expect(a.needsReencode).toBe(true);
  });

  test('profilo High 4:2:2 → re-encode', () => {
    const a = analyzeVideoForMeta(conformingProbe({ profile: 'High 4:2:2' }));
    expect(a.needsReencode).toBe(true);
    expect(a.issues.join(' ')).toMatch(/profilo/);
  });

  test('level oltre 4.2 (es. 5.1 = 51) → re-encode', () => {
    const a = analyzeVideoForMeta(conformingProbe({ level: 51 }));
    expect(a.needsReencode).toBe(true);
    expect(a.issues.join(' ')).toMatch(/level/);
  });

  test('level 4.2 (42) esatto → conforme', () => {
    const a = analyzeVideoForMeta(conformingProbe({ level: LEVEL_MAX }));
    expect(a.needsReencode).toBe(false);
  });

  test('audio non-AAC (mp3) → re-encode', () => {
    const a = analyzeVideoForMeta(conformingProbe({ acodec: 'mp3' }));
    expect(a.needsReencode).toBe(true);
    expect(a.issues.join(' ')).toMatch(/AAC/);
  });

  test('nessun audio → conforme ma warning', () => {
    const a = analyzeVideoForMeta(conformingProbe({ acodec: null }));
    expect(a.needsReencode).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/audio/);
  });

  test('dimensioni dispari → re-encode', () => {
    const a = analyzeVideoForMeta(conformingProbe({ width: 1081, height: 1920 }));
    expect(a.needsReencode).toBe(true);
    expect(a.issues.join(' ')).toMatch(/dispari/);
  });

  test('risoluzione 4K → re-encode (ridotta)', () => {
    const a = analyzeVideoForMeta(conformingProbe({ width: 2160, height: 3840 }));
    expect(a.needsReencode).toBe(true);
    expect(a.issues.join(' ')).toMatch(new RegExp(String(MAX_DIM)));
  });

  test('durata >90s → conforme ma warning', () => {
    const a = analyzeVideoForMeta(conformingProbe({ duration: 120 }));
    expect(a.needsReencode).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/90s/);
  });

  test('caso reale iPhone (hevc + mov + audio aac) → re-encode per il codec', () => {
    const a = analyzeVideoForMeta(conformingProbe({ vcodec: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le' }));
    expect(a.needsReencode).toBe(true);
    expect(a.issues.length).toBeGreaterThanOrEqual(2);
  });

  test('più problemi cumulati', () => {
    const a = analyzeVideoForMeta(conformingProbe({ vcodec: 'vp9', acodec: 'opus', width: 3840, height: 2160 }));
    expect(a.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('buildReencodeArgs', () => {
  test('produce flag IG-safe chiave', () => {
    const args = buildReencodeArgs('/in.mov', '/out.mov');
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args).toContain('+faststart');
    // -bf 0 (no B-frame) e level 4.2
    expect(args).toContain('-bf');
    expect(args[args.indexOf('-bf') + 1]).toBe('0');
    expect(args).toContain('4.2');
    // audio AAC 48kHz
    expect(args).toContain('aac');
    expect(args).toContain('48000');
    // input e output ai posti giusti
    expect(args[args.indexOf('-i') + 1]).toBe('/in.mov');
    expect(args[args.length - 1]).toBe('/out.mov');
  });

  test('scale filter preserva AR e arrotonda a pari', () => {
    const args = buildReencodeArgs('/in.mp4', '/out.mp4');
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toMatch(/force_original_aspect_ratio=decrease/);
    expect(vf).toMatch(/trunc\(iw\/2\)\*2/);
  });
});
