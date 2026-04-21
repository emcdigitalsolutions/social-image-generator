const { parsePostsPerMonth } = require('../lib/ai-provider');

describe('parsePostsPerMonth', () => {
  test('estrae 12 da "12 post/mese (3 a settimana) — consigliato"', () => {
    const resp = { 'Quanti post al mese vorresti?': '12 post/mese (3 a settimana) — consigliato' };
    expect(parsePostsPerMonth(resp)).toBe(12);
  });

  test('estrae 8 dalla prima cifra trovata', () => {
    const resp = { 'Quanti post al mese vorresti?': '8 post al mese' };
    expect(parsePostsPerMonth(resp)).toBe(8);
  });

  test('accetta la domanda con capitalizzazione diversa', () => {
    const resp = { 'QUANTI POST AL MESE vorresti?': '16 post' };
    expect(parsePostsPerMonth(resp)).toBe(16);
  });

  test('accetta risposta come array (prima occorrenza numerica)', () => {
    const resp = { 'Quanti post al mese ti servono?': ['20 post/mese'] };
    expect(parsePostsPerMonth(resp)).toBe(20);
  });

  test('restituisce null se la domanda non è presente', () => {
    const resp = { 'Che settore?': 'ristorazione' };
    expect(parsePostsPerMonth(resp)).toBeNull();
  });

  test('restituisce null se la risposta non contiene cifre', () => {
    const resp = { 'Quanti post al mese?': 'tanti, direi' };
    expect(parsePostsPerMonth(resp)).toBeNull();
  });

  test('restituisce null se responses è null o undefined', () => {
    expect(parsePostsPerMonth(null)).toBeNull();
    expect(parsePostsPerMonth(undefined)).toBeNull();
  });

  test('restituisce null se responses non è un oggetto', () => {
    expect(parsePostsPerMonth('string')).toBeNull();
    expect(parsePostsPerMonth(42)).toBeNull();
  });

  test('estrae la PRIMA cifra se la risposta ne contiene multiple', () => {
    const resp = { 'Quanti post al mese?': '12 post (3 a settimana)' };
    expect(parsePostsPerMonth(resp)).toBe(12);
  });

  test('non confonde cifre di altre domande', () => {
    const resp = {
      'Che anno fondazione?': '1999',
      'Quanti post al mese?': '8'
    };
    expect(parsePostsPerMonth(resp)).toBe(8);
  });
});
