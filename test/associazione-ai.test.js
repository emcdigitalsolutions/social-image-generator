const { getQuestionnaireConfig, getSectorKeys } = require('../lib/questionnaire-config');
const { parsePostsPerMonth } = require('../lib/ai-provider');
const { targetPlatforms, lengthRule } = require('../lib/platform-target');

describe('questionario associazione_ai', () => {
  const cfg = getQuestionnaireConfig('associazione_ai');
  const domande = cfg.sections.flatMap(s => s.domande);

  test('settore elencato', () => {
    expect(getSectorKeys().map(s => s.key)).toContain('associazione_ai');
  });

  test('sezioni dedicate, niente domande da attività locale', () => {
    expect(cfg.sections).toHaveLength(9);
    const testo = JSON.stringify(cfg);
    expect(testo).not.toMatch(/dialetto|volantini|Meta Ads|solo il mio comune/i);
    expect(testo).toMatch(/LinkedIn/);
  });

  test('titoli unici (le risposte sono salvate per titolo)', () => {
    const titoli = domande.map(d => d.titolo);
    expect(new Set(titoli).size).toBe(titoli.length);
  });

  test('ogni scelta ha opzioni; categorie risolte dal settore', () => {
    for (const d of domande.filter(d => d.tipo === 'choice' || d.tipo === 'checkbox')) {
      expect(Array.isArray(d.opzioni) && d.opzioni.length > 1).toBe(true);
      expect(d.options_from_sector).toBeUndefined();
    }
    const temi = domande.find(d => d.titolo === 'Quali tipi di contenuto ti interessano di più?');
    expect(temi.opzioni).toContain('Riassunti degli articoli della rivista');
  });

  test('domande chiave presenti', () => {
    const t = domande.map(d => d.titolo).join('\n');
    expect(t).toMatch(/Link alla rivista online/);
    expect(t).toMatch(/Quali profili LinkedIn dobbiamo gestire/);
    expect(t).toMatch(/consenso a essere citati/);
    expect(t).toMatch(/Chi approva i riassunti/);
  });

  test('"Quanti post al mese vorresti?" compatibile con parsePostsPerMonth', () => {
    const q = domande.find(d => d.titolo === 'Quanti post al mese vorresti?');
    expect(parsePostsPerMonth({ [q.titolo]: q.opzioni[1] })).toBe(8);
  });

  test('config restituita è una copia (nessuna mutazione condivisa)', () => {
    getQuestionnaireConfig('associazione_ai').sections[0].domande.length = 0;
    expect(getQuestionnaireConfig('associazione_ai').sections[0].domande.length).toBeGreaterThan(0);
  });

  test('gli altri settori restano invariati (10 sezioni con universali)', () => {
    const t = getQuestionnaireConfig('turismo');
    expect(t.sections).toHaveLength(10);
    expect(JSON.stringify(t)).toMatch(/dialetto/);
  });
});

describe('platform-target', () => {
  test('settore associazione_ai → solo LinkedIn', () => {
    expect(targetPlatforms({ sector: 'associazione_ai' })).toMatchObject({ label: 'LinkedIn', linkedinOnly: true });
    expect(lengthRule({ sector: 'associazione_ai' })).toMatch(/80-150 parole/);
  });
  test('solo Page LinkedIn configurata → LinkedIn', () => {
    expect(targetPlatforms({ linkedin_org_id: '1' }).label).toBe('LinkedIn');
  });
  test('Meta + LinkedIn', () => {
    expect(targetPlatforms({ fb_page_id: '1', linkedin_org_id: '2' }).label).toBe('Facebook, Instagram e LinkedIn');
  });
  test('default invariato: Facebook/Instagram, 40-70 parole', () => {
    expect(targetPlatforms({}).label).toBe('Facebook/Instagram');
    expect(lengthRule({})).toMatch(/40-70 parole/);
  });
});
