const { buildAuthorizeUrl, AUTHORIZE_URL, DEFAULT_SCOPE } = require('../lib/tiktok-oauth');

describe('buildAuthorizeUrl', () => {
  test('costruisce URL authorize con tutti i parametri', () => {
    const url = buildAuthorizeUrl({
      clientKey: 'awxyz',
      redirectUri: 'https://media.emc.it/dashboard/tiktok/callback',
      state: 'signed.jwt.state'
    });
    expect(url.startsWith(AUTHORIZE_URL + '?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('client_key')).toBe('awxyz');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('https://media.emc.it/dashboard/tiktok/callback');
    expect(q.get('state')).toBe('signed.jwt.state');
    expect(q.get('scope')).toBe(DEFAULT_SCOPE);
  });

  test('scope override', () => {
    const url = buildAuthorizeUrl({ clientKey: 'k', redirectUri: 'https://x/cb', state: 's', scope: 'video.publish' });
    expect(new URL(url).searchParams.get('scope')).toBe('video.publish');
  });

  test('redirect_uri e state vengono url-encoded correttamente', () => {
    const url = buildAuthorizeUrl({ clientKey: 'k', redirectUri: 'https://x.it/cb?a=b', state: 'a/b+c' });
    const q = new URL(url).searchParams;
    expect(q.get('redirect_uri')).toBe('https://x.it/cb?a=b');
    expect(q.get('state')).toBe('a/b+c');
  });
});
