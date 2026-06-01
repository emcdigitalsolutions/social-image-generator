const {
  composeCaption,
  normalizeMentions,
  formatCtaLine,
  displayCtaTarget,
  MAX_MENTIONS
} = require('../lib/post-caption');

describe('normalizeMentions', () => {
  test('stringa separata da spazi → array @handle', () => {
    expect(normalizeMentions('@mario @negozio')).toEqual(['@mario', '@negozio']);
  });

  test('aggiunge @ se mancante', () => {
    expect(normalizeMentions('mario negozio')).toEqual(['@mario', '@negozio']);
  });

  test('separatori virgola e newline', () => {
    expect(normalizeMentions('@a, @b\n@c')).toEqual(['@a', '@b', '@c']);
  });

  test('dedup case-insensitive', () => {
    expect(normalizeMentions('@Mario @mario @MARIO')).toEqual(['@Mario']);
  });

  test('rimuove @ multipli iniziali', () => {
    expect(normalizeMentions('@@@mario')).toEqual(['@mario']);
  });

  test('mantiene punto e underscore, scarta altri caratteri', () => {
    expect(normalizeMentions('@mario.rossi_01 @nome!brand')).toEqual(['@mario.rossi_01', '@nomebrand']);
  });

  test('array in input', () => {
    expect(normalizeMentions(['mario', '@negozio'])).toEqual(['@mario', '@negozio']);
  });

  test('JSON array serializzato (dal DB)', () => {
    expect(normalizeMentions('["@mario","@negozio"]')).toEqual(['@mario', '@negozio']);
  });

  test('null/empty → array vuoto', () => {
    expect(normalizeMentions(null)).toEqual([]);
    expect(normalizeMentions('')).toEqual([]);
    expect(normalizeMentions('   ')).toEqual([]);
  });

  test('cap al massimo consentito', () => {
    const many = Array.from({ length: MAX_MENTIONS + 10 }, (_, i) => 'u' + i).join(' ');
    expect(normalizeMentions(many)).toHaveLength(MAX_MENTIONS);
  });
});

describe('displayCtaTarget / formatCtaLine', () => {
  test('tel: viene mostrato come numero nudo', () => {
    expect(displayCtaTarget('tel:+39 333 1234567')).toBe('+39 333 1234567');
  });

  test('url normale invariato', () => {
    expect(displayCtaTarget('https://sito.it/x')).toBe('https://sito.it/x');
  });

  test('label + url', () => {
    expect(formatCtaLine('Prenota ora', 'https://sito.it/p')).toBe('👉 Prenota ora: https://sito.it/p');
  });

  test('solo label', () => {
    expect(formatCtaLine('Scopri di più', '')).toBe('👉 Scopri di più');
  });

  test('solo url', () => {
    expect(formatCtaLine('', 'https://sito.it')).toBe('👉 https://sito.it');
  });

  test('niente → stringa vuota', () => {
    expect(formatCtaLine('', '')).toBe('');
  });
});

describe('composeCaption', () => {
  test('solo caption base → invariata (idempotente)', () => {
    expect(composeCaption({ caption: 'Ciao mondo' })).toBe('Ciao mondo');
  });

  test('caption + menzioni', () => {
    expect(composeCaption({ caption: 'Testo', mentions: '@a @b' }))
      .toBe('Testo\n\n@a @b');
  });

  test('caption + CTA (label + url)', () => {
    expect(composeCaption({ caption: 'Testo', cta_label: 'Prenota', cta_url: 'https://x.it' }))
      .toBe('Testo\n\n👉 Prenota: https://x.it');
  });

  test('caption + menzioni + CTA (ordine corretto)', () => {
    expect(composeCaption({
      caption: 'Testo',
      mentions: ['@a'],
      cta_label: 'Chiama',
      cta_url: 'tel:+390000'
    })).toBe('Testo\n\n@a\n\n👉 Chiama: +390000');
  });

  test('menzioni da JSON array (come salvate in DB)', () => {
    expect(composeCaption({ caption: 'Testo', mentions: '["@a","@b"]' }))
      .toBe('Testo\n\n@a @b');
  });

  test('caption vuota ma CTA presente', () => {
    expect(composeCaption({ caption: '', cta_label: 'Scopri di più' }))
      .toBe('👉 Scopri di più');
  });

  test('trim trailing della caption base prima di appendere', () => {
    expect(composeCaption({ caption: 'Testo  \n\n  ', mentions: '@a' }))
      .toBe('Testo\n\n@a');
  });

  test('post null → stringa vuota', () => {
    expect(composeCaption(null)).toBe('');
  });
});
