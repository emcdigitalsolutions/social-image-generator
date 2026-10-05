const {
  toLittleText,
  planLinkedInContent,
  buildPostBody,
  apiVersionAgeMonths,
  publishToLinkedIn,
  verifyLinkedInConnection,
  linkedInPostUrl,
  LINKEDIN_API_VERSION
} = require('../lib/linkedin-publish');

// ─────────────── toLittleText ───────────────

describe('toLittleText', () => {
  test('escapa i caratteri riservati', () => {
    expect(toLittleText('Offerta (solo oggi) *50%* a_b ~x~ <ok> [x] {y} | \\'))
      .toBe('Offerta \\(solo oggi\\) \\*50%\\* a\\_b \\~x\\~ \\<ok\\> \\[x\\] \\{y\\} \\| \\\\');
  });

  test('hashtag → template cliccabile, anche con accenti', () => {
    expect(toLittleText('Ciao #Sicilia e #caffè!'))
      .toBe('Ciao {hashtag|\\#|Sicilia} e {hashtag|\\#|caffè}!');
  });

  test('hashtag in testa e su più righe', () => {
    expect(toLittleText('#uno\n#due')).toBe('{hashtag|\\#|uno}\n{hashtag|\\#|due}');
  });

  test('# non preceduto da separatore resta testo escapato', () => {
    expect(toLittleText('C# e prezzo#1')).toBe('C\\# e prezzo\\#1');
  });

  test('menzioni Instagram restano testo semplice', () => {
    expect(toLittleText('Grazie @mario.rossi')).toBe('Grazie \\@mario.rossi');
  });

  test('emoji e accenti intatti', () => {
    expect(toLittleText('Più qualità 🎉 perché sì')).toBe('Più qualità 🎉 perché sì');
  });

  test('vuoto/null → stringa vuota', () => {
    expect(toLittleText(null)).toBe('');
    expect(toLittleText('')).toBe('');
  });

  test('tronca oltre 3000 caratteri', () => {
    const out = toLittleText('a'.repeat(3500));
    expect(out.length).toBeLessThanOrEqual(3000);
    expect(out.endsWith('…')).toBe(true);
  });
});

// ─────────────── planLinkedInContent ───────────────

const img = n => ({ kind: 'image', url: `https://x/i${n}.jpg` });
const vid = n => ({ kind: 'video', url: `https://x/v${n}.mp4` });

describe('planLinkedInContent', () => {
  test('nessun media → testo', () => {
    expect(planLinkedInContent({ media_type: 'single_image' }, []).kind).toBe('text');
  });
  test('single_image → image', () => {
    const p = planLinkedInContent({ media_type: 'single_image' }, [img(1)]);
    expect(p).toMatchObject({ kind: 'image', items: [img(1)] });
  });
  test('carousel di foto → multiImage', () => {
    const p = planLinkedInContent({ media_type: 'carousel' }, [img(1), img(2), img(3)]);
    expect(p.kind).toBe('multiImage');
    expect(p.items).toHaveLength(3);
  });
  test('carousel > 20 foto → prime 20 + warning', () => {
    const many = Array.from({ length: 25 }, (_, i) => img(i));
    const p = planLinkedInContent({ media_type: 'carousel' }, many);
    expect(p.items).toHaveLength(20);
    expect(p.warnings.length).toBe(1);
  });
  test('carousel misto → solo foto + warning', () => {
    const p = planLinkedInContent({ media_type: 'carousel' }, [img(1), vid(1), img(2)]);
    expect(p.kind).toBe('multiImage');
    expect(p.items).toEqual([img(1), img(2)]);
    expect(p.warnings[0]).toMatch(/video esclusi/);
  });
  test('carousel con 1 foto → image', () => {
    expect(planLinkedInContent({ media_type: 'carousel' }, [img(1)]).kind).toBe('image');
  });
  test('reel → video', () => {
    expect(planLinkedInContent({ media_type: 'reel' }, [vid(1)])).toMatchObject({ kind: 'video', items: [vid(1)] });
  });
  test('video senza file video ma con foto → image', () => {
    expect(planLinkedInContent({ media_type: 'video' }, [img(1)]).kind).toBe('image');
  });
  test('story video → video', () => {
    expect(planLinkedInContent({ media_type: 'story' }, [vid(1)]).kind).toBe('video');
  });
  test('ignora media senza url', () => {
    expect(planLinkedInContent({ media_type: 'single_image' }, [{ kind: 'image' }]).kind).toBe('text');
  });
});

// ─────────────── buildPostBody / varie ───────────────

describe('buildPostBody', () => {
  test('post pubblico nel feed, content solo se presente', () => {
    const b = buildPostBody('urn:li:organization:1', 'ciao', null);
    expect(b).toMatchObject({ author: 'urn:li:organization:1', commentary: 'ciao', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' });
    expect(b.distribution.feedDistribution).toBe('MAIN_FEED');
    expect(b.content).toBeUndefined();
    expect(buildPostBody('u', 'c', { media: { id: 'x' } }).content).toEqual({ media: { id: 'x' } });
  });
});

describe('versione API', () => {
  test('versione di default valida e recente (formato YYYYMM)', () => {
    expect(LINKEDIN_API_VERSION).toMatch(/^\d{6}$/);
    expect(Number(LINKEDIN_API_VERSION)).toBeGreaterThanOrEqual(202609);
  });
  test('apiVersionAgeMonths', () => {
    expect(apiVersionAgeMonths('202609', new Date(2026, 9, 5))).toBe(1);
    expect(apiVersionAgeMonths('202403', new Date(2026, 9, 5))).toBe(31);
  });
});

test('linkedInPostUrl', () => {
  expect(linkedInPostUrl('urn:li:share:123')).toBe('https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123/');
  expect(linkedInPostUrl(null)).toBeNull();
});

// ─────────────── Integrazione con fetch simulato ───────────────

/**
 * Router di fetch finto: registra le chiamate e risponde in base a metodo+URL.
 * routes: array di [predicate(method,url,opts) , responder(opts) → {status, json?, text?, headers?}]
 */
function mockFetch(routes) {
  const calls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, opts });
    const route = routes.find(([pred]) => pred(method, url, opts));
    if (!route) throw new Error('fetch non previsto: ' + method + ' ' + url);
    const r = route[1](opts, url);
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const text = r.text !== undefined ? r.text : (r.json !== undefined ? JSON.stringify(r.json) : '');
    return {
      status: r.status || 200,
      ok: (r.status || 200) < 400,
      headers: { get: k => headers.get(k.toLowerCase()) || null },
      text: async () => text,
      arrayBuffer: async () => (r.buffer || Buffer.from('BIN')).buffer.slice(0)
    };
  });
  return calls;
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const client = { linkedin_org_id: '2414183', linkedin_access_token: 'tok' };
const is = (m, frag) => (method, url) => method === m && url.includes(frag);
const created = () => ({ status: 201, headers: { 'x-restli-id': 'urn:li:share:999' } });

describe('publishToLinkedIn (fetch simulato)', () => {
  test('immagine singola: initializeUpload → PUT → stato → post con media', async () => {
    let n = 0;
    const calls = mockFetch([
      [is('POST', '/images?action=initializeUpload'), () => ({ json: { value: { uploadUrl: 'https://up/img' + (++n), image: 'urn:li:image:I' + n } } })],
      [is('GET', 'https://x/'), () => ({ buffer: Buffer.from('JPEGDATA') })],
      [is('PUT', 'https://up/'), () => ({ status: 201 })],
      [is('GET', '/images/'), () => ({ json: { status: 'AVAILABLE' } })],
      [is('POST', '/rest/posts'), created]
    ]);
    const urn = await publishToLinkedIn(client, { id: 'p1', media_type: 'single_image', caption: 'Ciao (test) #emc' }, [img(1)]);
    expect(urn).toBe('urn:li:share:999');

    const post = calls.find(c => c.url.endsWith('/rest/posts'));
    expect(post.opts.headers['LinkedIn-Version']).toBe(LINKEDIN_API_VERSION);
    expect(post.opts.headers['Authorization']).toBe('Bearer tok');
    const body = JSON.parse(post.opts.body);
    expect(body.author).toBe('urn:li:organization:2414183');
    expect(body.commentary).toBe('Ciao \\(test\\) {hashtag|\\#|emc}');
    expect(body.content).toEqual({ media: { id: 'urn:li:image:I1' } });
    const init = JSON.parse(calls[0].opts.body);
    expect(init.initializeUploadRequest.owner).toBe('urn:li:organization:2414183');
  });

  test('carousel: un upload per immagine → multiImage nell\'ordine', async () => {
    let n = 0;
    const calls = mockFetch([
      [is('POST', '/images?action=initializeUpload'), () => ({ json: { value: { uploadUrl: 'https://up/img' + (++n), image: 'urn:li:image:I' + n } } })],
      [is('GET', 'https://x/'), () => ({})],
      [is('PUT', 'https://up/'), () => ({ status: 201 })],
      [is('GET', '/images/'), () => ({ json: { status: 'AVAILABLE' } })],
      [is('POST', '/rest/posts'), created]
    ]);
    await publishToLinkedIn(client, { media_type: 'carousel', caption: 'x' }, [img(1), img(2), img(3)]);
    const body = JSON.parse(calls.find(c => c.url.endsWith('/rest/posts')).opts.body);
    expect(body.content.multiImage.images).toEqual([
      { id: 'urn:li:image:I1' }, { id: 'urn:li:image:I2' }, { id: 'urn:li:image:I3' }
    ]);
  });

  test('video: upload multipart con ETag → finalize → AVAILABLE → post', async () => {
    const size = 10 * 1024 * 1024; // 10MB → 3 parti da 4MB
    const video = Buffer.alloc(size, 1);
    const part = 4194304;
    const instructions = [0, 1, 2].map(i => ({
      uploadUrl: 'https://up/v' + i, firstByte: i * part, lastByte: Math.min((i + 1) * part, size) - 1
    }));
    const putSizes = [];
    const calls = mockFetch([
      [is('GET', 'https://x/v'), () => ({ buffer: video })],
      [is('POST', '/videos?action=initializeUpload'), () => ({ json: { value: { video: 'urn:li:video:V1', uploadInstructions: instructions, uploadToken: 'T' } } })],
      [is('PUT', 'https://up/v'), (opts, url) => { putSizes.push(opts.body.length); return { status: 200, headers: { etag: '"etag-' + url.slice(-1) + '"' } }; }],
      [is('POST', '/videos?action=finalizeUpload'), () => ({ status: 200 })],
      [is('GET', '/videos/'), () => ({ json: { status: 'AVAILABLE' } })],
      [is('POST', '/rest/posts'), created]
    ]);
    await publishToLinkedIn(client, { media_type: 'reel', caption: 'Reel' }, [vid(1)]);

    const init = JSON.parse(calls.find(c => c.url.includes('initializeUpload')).opts.body);
    expect(init.initializeUploadRequest.fileSizeBytes).toBe(size);
    expect(putSizes).toEqual([part, part, size - 2 * part]);
    const fin = JSON.parse(calls.find(c => c.url.includes('finalizeUpload')).opts.body);
    expect(fin.finalizeUploadRequest).toEqual({ video: 'urn:li:video:V1', uploadToken: 'T', uploadedPartIds: ['etag-0', 'etag-1', 'etag-2'] });
    const body = JSON.parse(calls.find(c => c.url.endsWith('/rest/posts')).opts.body);
    expect(body.content).toEqual({ media: { id: 'urn:li:video:V1' } });
  });

  test('video PROCESSING_FAILED → errore chiaro, nessun post creato', async () => {
    const calls = mockFetch([
      [is('GET', 'https://x/v'), () => ({ buffer: Buffer.alloc(100) })],
      [is('POST', '/videos?action=initializeUpload'), () => ({ json: { value: { video: 'urn:li:video:V', uploadInstructions: [{ uploadUrl: 'https://up/v0', firstByte: 0, lastByte: 99 }] } } })],
      [is('PUT', 'https://up/'), () => ({ headers: { etag: 'e' } })],
      [is('POST', 'finalizeUpload'), () => ({})],
      [is('GET', '/videos/'), () => ({ json: { status: 'PROCESSING_FAILED', processingFailureReason: 'codec' } })]
    ]);
    await expect(publishToLinkedIn(client, { media_type: 'video' }, [vid(1)])).rejects.toThrow(/elaborazione videos fallita \(codec\)/);
    expect(calls.some(c => c.url.endsWith('/rest/posts'))).toBe(false);
  });

  test('senza media → post solo testo', async () => {
    const calls = mockFetch([[is('POST', '/rest/posts'), created]]);
    await publishToLinkedIn(client, { caption: 'Solo testo' }, []);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].opts.body).content).toBeUndefined();
  });

  test('401 → messaggio "token scaduto"', async () => {
    mockFetch([[is('POST', '/rest/posts'), () => ({ status: 401, json: { message: 'Invalid access token' } })]]);
    await expect(publishToLinkedIn(client, { caption: 'x' }, [])).rejects.toThrow(/HTTP 401.*token scaduto o revocato/);
  });

  test('versione dismessa → messaggio esplicito', async () => {
    mockFetch([[is('POST', '/rest/posts'), () => ({ status: 426, json: { code: 'NONEXISTENT_VERSION', message: 'Requested version 20240300 is not active' } })]]);
    await expect(publishToLinkedIn(client, { caption: 'x' }, [])).rejects.toThrow(/aggiorna LINKEDIN_API_VERSION/);
  });

  test('org id non numerico → errore prima di chiamare LinkedIn', async () => {
    const calls = mockFetch([]);
    await expect(publishToLinkedIn({ ...client, linkedin_org_id: 'emc-digital' }, { caption: 'x' }, [])).rejects.toThrow(/ID numerico/);
    expect(calls).toHaveLength(0);
  });

  test('credenziali mancanti', async () => {
    await expect(publishToLinkedIn({ linkedin_access_token: 't' }, {}, [])).rejects.toThrow(/linkedin_org_id mancante/);
    await expect(publishToLinkedIn({ linkedin_org_id: '1' }, {}, [])).rejects.toThrow(/linkedin_access_token mancante/);
  });
});

describe('verifyLinkedInConnection (fetch simulato)', () => {
  const acl = elements => [is('GET', '/organizationAcls'), () => ({ json: { elements } })];
  const orgName = [is('GET', '/organizations/'), (o, url) => ({ json: { localizedName: 'Page ' + url.split('/').pop(), vanityName: 'v' } })];

  test('ok: org configurata con ruolo ADMINISTRATOR', async () => {
    mockFetch([acl([{ role: 'ADMINISTRATOR', organization: 'urn:li:organization:111', state: 'APPROVED' }]), orgName]);
    const r = await verifyLinkedInConnection('tok', '111');
    expect(r.ok).toBe(true);
    expect(r.tokenValid).toBe(true);
    expect(r.target).toMatchObject({ id: '111', name: 'Page 111', canPost: true });
  });

  test('supporta anche il campo organizationTarget', async () => {
    mockFetch([acl([{ role: 'CONTENT_ADMINISTRATOR', organizationTarget: 'urn:li:organization:222' }]), orgName]);
    expect((await verifyLinkedInConnection('tok', '222')).ok).toBe(true);
  });

  test('org non tra quelle del token', async () => {
    mockFetch([acl([{ role: 'ADMINISTRATOR', organization: 'urn:li:organization:111' }]), orgName]);
    const r = await verifyLinkedInConnection('tok', '999');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/non ha ruoli sulla Page 999/);
    expect(r.pages).toHaveLength(1);
  });

  test('ruolo che non può pubblicare (ANALYST)', async () => {
    mockFetch([acl([{ role: 'ANALYST', organization: 'urn:li:organization:111' }]), orgName]);
    const r = await verifyLinkedInConnection('tok', '111');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/non sufficiente/);
  });

  test('senza org id: elenca le Pagine', async () => {
    mockFetch([acl([
      { role: 'ADMINISTRATOR', organization: 'urn:li:organization:1' },
      { role: 'ANALYST', organization: 'urn:li:organization:2' }
    ]), orgName]);
    const r = await verifyLinkedInConnection('tok', '');
    expect(r.ok).toBe(false);
    expect(r.pages.map(p => [p.id, p.canPost])).toEqual([['1', true], ['2', false]]);
    expect(r.message).toMatch(/Scegli la Page/);
  });

  test('401 → token non valido', async () => {
    mockFetch([[is('GET', '/organizationAcls'), () => ({ status: 401, json: {} })]]);
    const r = await verifyLinkedInConnection('tok', '1');
    expect(r).toMatchObject({ ok: false, tokenValid: false });
  });

  test('403 → token valido ma senza scope admin', async () => {
    mockFetch([[is('GET', '/organizationAcls'), () => ({ status: 403, json: {} })]]);
    const r = await verifyLinkedInConnection('tok', '1');
    expect(r).toMatchObject({ ok: false, tokenValid: true });
    expect(r.message).toMatch(/rw_organization_admin/);
  });

  test('token mancante', async () => {
    expect((await verifyLinkedInConnection('', '1')).message).toMatch(/mancante/);
  });
});
