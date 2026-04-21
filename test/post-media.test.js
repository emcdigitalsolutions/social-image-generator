const { classifyExt, IMAGE_EXTS, VIDEO_EXTS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MAX_CAROUSEL_ITEMS } = require('../lib/post-media');

describe('classifyExt', () => {
  test('riconosce .jpg come immagine', () => {
    expect(classifyExt('foto.jpg')).toEqual({ kind: 'image', ext: '.jpg' });
  });

  test('riconosce .jpeg come immagine', () => {
    expect(classifyExt('foto.jpeg')).toEqual({ kind: 'image', ext: '.jpeg' });
  });

  test('riconosce .png come immagine', () => {
    expect(classifyExt('logo.PNG')).toEqual({ kind: 'image', ext: '.png' });
  });

  test('riconosce .webp come immagine', () => {
    expect(classifyExt('graphic.webp')).toEqual({ kind: 'image', ext: '.webp' });
  });

  test('riconosce .mp4 come video', () => {
    expect(classifyExt('reel.mp4')).toEqual({ kind: 'video', ext: '.mp4' });
  });

  test('riconosce .mov come video', () => {
    expect(classifyExt('video.MOV')).toEqual({ kind: 'video', ext: '.mov' });
  });

  test('restituisce null per formati non supportati', () => {
    expect(classifyExt('archivio.zip')).toBeNull();
    expect(classifyExt('documento.pdf')).toBeNull();
    expect(classifyExt('audio.mp3')).toBeNull();
    expect(classifyExt('video.avi')).toBeNull();
    expect(classifyExt('video.mkv')).toBeNull();
    expect(classifyExt('video.webm')).toBeNull();
  });

  test('fallback su mimetype quando estensione manca', () => {
    expect(classifyExt('blob', 'image/jpeg')).toEqual({ kind: 'image', ext: '.jpg' });
    expect(classifyExt('blob', 'image/png')).toEqual({ kind: 'image', ext: '.png' });
    expect(classifyExt('blob', 'image/webp')).toEqual({ kind: 'image', ext: '.webp' });
    expect(classifyExt('blob', 'video/mp4')).toEqual({ kind: 'video', ext: '.mp4' });
    expect(classifyExt('blob', 'video/quicktime')).toEqual({ kind: 'video', ext: '.mov' });
  });

  test('null se né estensione né mimetype riconoscibili', () => {
    expect(classifyExt('file.xyz', 'application/octet-stream')).toBeNull();
    expect(classifyExt('noext')).toBeNull();
  });

  test('case-insensitive sulle estensioni', () => {
    expect(classifyExt('FOTO.JPG').kind).toBe('image');
    expect(classifyExt('Video.Mp4').kind).toBe('video');
  });
});

describe('set e costanti esportate', () => {
  test('IMAGE_EXTS contiene i formati immagine attesi', () => {
    expect(IMAGE_EXTS.has('.jpg')).toBe(true);
    expect(IMAGE_EXTS.has('.jpeg')).toBe(true);
    expect(IMAGE_EXTS.has('.png')).toBe(true);
    expect(IMAGE_EXTS.has('.webp')).toBe(true);
  });

  test('VIDEO_EXTS contiene i formati video attesi', () => {
    expect(VIDEO_EXTS.has('.mp4')).toBe(true);
    expect(VIDEO_EXTS.has('.mov')).toBe(true);
  });

  test('limiti dimensioni sono coerenti con vincoli Meta', () => {
    expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_VIDEO_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_CAROUSEL_ITEMS).toBe(10);
  });
});
