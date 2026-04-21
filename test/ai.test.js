const { toUnicodeBold, toUnicodeItalic, mdToSocialUnicode } = require('../lib/ai');

describe('toUnicodeBold', () => {
  test('converte lettere minuscole e maiuscole in grassetto Unicode', () => {
    const out = toUnicodeBold('Abc');
    expect(out).toBe('𝗔𝗯𝗰');
  });

  test('converte numeri in grassetto Unicode', () => {
    expect(toUnicodeBold('24/7')).toBe('𝟮𝟰/𝟳');
  });

  test('lascia invariato punteggiatura e spazi', () => {
    expect(toUnicodeBold('Ok!')).toBe('𝗢𝗸!');
  });

  test('lascia invariati caratteri accentati (non nel range ASCII)', () => {
    const out = toUnicodeBold('È così');
    expect(out).toContain('È');
    expect(out).toContain('ì');
  });
});

describe('toUnicodeItalic', () => {
  test('converte lettere in corsivo Unicode', () => {
    expect(toUnicodeItalic('Hello')).toBe('𝘏𝘦𝘭𝘭𝘰');
  });

  test('non tocca i numeri (italic Unicode non include cifre)', () => {
    expect(toUnicodeItalic('abc123')).toBe('𝘢𝘣𝘤123');
  });
});

describe('mdToSocialUnicode', () => {
  test('converte **grassetto** markdown in Unicode bold', () => {
    expect(mdToSocialUnicode('Ciao **mondo**')).toBe('Ciao 𝗺𝗼𝗻𝗱𝗼');
  });

  test('converte __bold__ markdown in Unicode bold', () => {
    expect(mdToSocialUnicode('__forte__')).toBe('𝗳𝗼𝗿𝘁𝗲');
  });

  test('converte *corsivo* markdown in Unicode italic', () => {
    expect(mdToSocialUnicode('frase *in corsivo* qui')).toBe('frase 𝘪𝘯 𝘤𝘰𝘳𝘴𝘪𝘷𝘰 qui');
  });

  test('converte titoli # in bold (senza #)', () => {
    expect(mdToSocialUnicode('# Titolo')).toBe('𝗧𝗶𝘁𝗼𝗹𝗼');
  });

  test('converte bullet list "- item" in "• item"', () => {
    const md = '- primo\n- secondo';
    const out = mdToSocialUnicode(md);
    expect(out).toBe('• primo\n• secondo');
  });

  test('converte bullet list "* item" in "• item"', () => {
    const md = '* primo\n* secondo';
    expect(mdToSocialUnicode(md)).toBe('• primo\n• secondo');
  });

  test('non confonde asterisco di bullet con corsivo', () => {
    const md = '* voce';
    const out = mdToSocialUnicode(md);
    expect(out).toBe('• voce');
    expect(out).not.toContain('𝘃');
  });

  test('combinazione bold + italic nello stesso testo', () => {
    const md = 'Sono **forte** e *sottile*';
    const out = mdToSocialUnicode(md);
    expect(out).toContain('𝗳𝗼𝗿𝘁𝗲');
    expect(out).toContain('𝘴𝘰𝘵𝘵𝘪𝘭𝘦');
  });

  test('stringa vuota o null passa invariata', () => {
    expect(mdToSocialUnicode('')).toBe('');
    expect(mdToSocialUnicode(null)).toBeNull();
    expect(mdToSocialUnicode(undefined)).toBeUndefined();
  });

  test('testo senza markdown resta invariato', () => {
    const plain = 'Un post senza nulla di speciale. Buona giornata!';
    expect(mdToSocialUnicode(plain)).toBe(plain);
  });

  test('hashtag con testo semplice non vengono alterati', () => {
    const md = 'Un post\n\n#FratelliDiRosa #Ravanusa';
    const out = mdToSocialUnicode(md);
    expect(out).toContain('#FratelliDiRosa');
    expect(out).toContain('#Ravanusa');
  });

  test('asterisco isolato (non delimitatore) non causa conversione', () => {
    expect(mdToSocialUnicode('prezzo * quantità')).toBe('prezzo * quantità');
  });
});
