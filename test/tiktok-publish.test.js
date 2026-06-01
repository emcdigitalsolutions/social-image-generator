const {
  resolvePrivacy,
  buildVideoInitBody,
  buildPhotoInitBody,
  clampTitle,
  MAX_TITLE_LEN,
  DEFAULT_PRIVACY
} = require('../lib/tiktok-publish');

describe('resolvePrivacy', () => {
  test('usa la privacy desiderata se è tra le opzioni', () => {
    const r = resolvePrivacy('PUBLIC_TO_EVERYONE', ['PUBLIC_TO_EVERYONE', 'SELF_ONLY']);
    expect(r).toEqual({ level: 'PUBLIC_TO_EVERYONE', fellback: false });
  });

  test('ricade su PUBLIC_TO_EVERYONE se la desiderata non è disponibile', () => {
    const r = resolvePrivacy('MUTUAL_FOLLOW_FRIENDS', ['PUBLIC_TO_EVERYONE', 'SELF_ONLY']);
    expect(r).toEqual({ level: 'PUBLIC_TO_EVERYONE', fellback: true });
  });

  test('app non auditata: solo SELF_ONLY disponibile → fallback', () => {
    const r = resolvePrivacy('PUBLIC_TO_EVERYONE', ['SELF_ONLY']);
    expect(r).toEqual({ level: 'SELF_ONLY', fellback: true });
  });

  test('default quando desiderata è null', () => {
    const r = resolvePrivacy(null, ['PUBLIC_TO_EVERYONE']);
    expect(r.level).toBe(DEFAULT_PRIVACY);
    expect(r.fellback).toBe(false);
  });

  test('nessuna opzione nota → tenta la desiderata', () => {
    const r = resolvePrivacy('SELF_ONLY', []);
    expect(r).toEqual({ level: 'SELF_ONLY', fellback: false });
  });
});

describe('clampTitle', () => {
  test('trim degli spazi', () => {
    expect(clampTitle('  ciao  ')).toBe('ciao');
  });
  test('tronca oltre il limite', () => {
    const long = 'x'.repeat(MAX_TITLE_LEN + 50);
    expect(clampTitle(long)).toHaveLength(MAX_TITLE_LEN);
  });
  test('null → stringa vuota', () => {
    expect(clampTitle(null)).toBe('');
  });
});

describe('buildVideoInitBody', () => {
  test('PULL_FROM_URL con privacy e flag interazioni dal creator', () => {
    const body = buildVideoInitBody({
      caption: 'Test #reel',
      privacy: 'PUBLIC_TO_EVERYONE',
      videoUrl: 'https://media.emc.it/v.mp4',
      creator: { comment_disabled: true, duet_disabled: false, stitch_disabled: true }
    });
    expect(body.source_info).toEqual({ source: 'PULL_FROM_URL', video_url: 'https://media.emc.it/v.mp4' });
    expect(body.post_info.title).toBe('Test #reel');
    expect(body.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    expect(body.post_info.disable_comment).toBe(true);
    expect(body.post_info.disable_duet).toBe(false);
    expect(body.post_info.disable_stitch).toBe(true);
  });

  test('flag interazioni default false se creator non li specifica', () => {
    const body = buildVideoInitBody({ caption: 'x', privacy: 'SELF_ONLY', videoUrl: 'u' });
    expect(body.post_info.disable_comment).toBe(false);
    expect(body.post_info.disable_duet).toBe(false);
    expect(body.post_info.disable_stitch).toBe(false);
  });
});

describe('buildPhotoInitBody', () => {
  test('PHOTO Direct Post con array di immagini e cover index', () => {
    const body = buildPhotoInitBody({
      caption: 'Foto carosello',
      privacy: 'PUBLIC_TO_EVERYONE',
      photoUrls: ['https://m/1.jpg', 'https://m/2.jpg'],
      coverIndex: 1,
      creator: { comment_disabled: false }
    });
    expect(body.media_type).toBe('PHOTO');
    expect(body.post_mode).toBe('DIRECT_POST');
    expect(body.source_info.source).toBe('PULL_FROM_URL');
    expect(body.source_info.photo_images).toHaveLength(2);
    expect(body.source_info.photo_cover_index).toBe(1);
    expect(body.post_info.title).toBe('Foto carosello');
    expect(body.post_info.description).toBe('Foto carosello');
    expect(body.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
  });
});
