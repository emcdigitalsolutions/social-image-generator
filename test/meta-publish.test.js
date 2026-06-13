const {
  isTransientMeta,
  matchRecentFbPost,
  TRANSIENT_META_CODES,
  withRetry
} = require('../lib/meta-publish');

describe('isTransientMeta', () => {
  test('riconosce i codici transitori noti', () => {
    for (const code of TRANSIENT_META_CODES) {
      expect(isTransientMeta({ metaCode: code })).toBe(true);
    }
  });

  test('code stringa numerica → transitorio', () => {
    expect(isTransientMeta({ metaCode: '2' })).toBe(true);
  });

  test('code non transitorio (es. 10 permessi) → false', () => {
    expect(isTransientMeta({ metaCode: 10 })).toBe(false);
    expect(isTransientMeta({ metaCode: 190 })).toBe(false); // token scaduto
  });

  test('errore senza metaCode (timeout/network) → false', () => {
    expect(isTransientMeta(new Error('Timeout 60000ms'))).toBe(false);
    expect(isTransientMeta(null)).toBe(false);
    expect(isTransientMeta(undefined)).toBe(false);
  });
});

describe('matchRecentFbPost', () => {
  const now = Date.parse('2026-06-13T08:00:30.000Z');
  const within = 5 * 60 * 1000;

  test('trova il post con caption combaciante creato nella finestra', () => {
    const items = [
      { id: 'PAGE_1', message: 'Ciao mondo', created_time: '2026-06-13T08:00:10+0000' },
      { id: 'PAGE_2', message: 'Altro post', created_time: '2026-06-13T07:00:00+0000' }
    ];
    expect(matchRecentFbPost(items, 'Ciao mondo', now, within)).toBe('PAGE_1');
  });

  test('ignora post fuori dalla finestra temporale', () => {
    const items = [
      { id: 'OLD', message: 'Ciao mondo', created_time: '2026-06-13T07:50:00+0000' }
    ];
    expect(matchRecentFbPost(items, 'Ciao mondo', now, within)).toBeNull();
  });

  test('match robusto agli spazi multipli / a capo', () => {
    const items = [
      { id: 'P', message: 'Linea uno\n\nLinea  due', created_time: '2026-06-13T08:00:05+0000' }
    ];
    expect(matchRecentFbPost(items, 'Linea uno Linea due', now, within)).toBe('P');
  });

  test('caption vuota → null (non disambiguabile in sicurezza)', () => {
    const items = [{ id: 'X', message: '', created_time: '2026-06-13T08:00:05+0000' }];
    expect(matchRecentFbPost(items, '', now, within)).toBeNull();
    expect(matchRecentFbPost(items, '   ', now, within)).toBeNull();
  });

  test('nessun match → null; input vuoto → null', () => {
    expect(matchRecentFbPost([], 'Ciao', now, within)).toBeNull();
    expect(matchRecentFbPost(null, 'Ciao', now, within)).toBeNull();
    expect(matchRecentFbPost([{ id: 'A', message: 'Diverso', created_time: '2026-06-13T08:00:05+0000' }], 'Ciao', now, within)).toBeNull();
  });
});

describe('withRetry', () => {
  test('ritorna subito al primo successo', async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls++; return 'ok'; }, { attempts: 3, baseDelayMs: 1 });
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  test('ritenta sugli errori transitori e poi riesce', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 2) { const e = new Error('transient'); e.metaCode = 2; throw e; }
      return 'ok';
    }, { attempts: 3, baseDelayMs: 1 });
    expect(r).toBe('ok');
    expect(calls).toBe(2);
  });

  test('NON ritenta su errori non transitori', async () => {
    let calls = 0;
    const e = new Error('perm'); e.metaCode = 10;
    await expect(withRetry(async () => { calls++; throw e; }, { attempts: 3, baseDelayMs: 1 }))
      .rejects.toThrow('perm');
    expect(calls).toBe(1);
  });

  test('esaurisce i tentativi e rilancia l\'ultimo errore', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++; const e = new Error('still transient'); e.metaCode = 2; throw e;
    }, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow('still transient');
    expect(calls).toBe(3);
  });
});
