/**
 * Test per lib/setup-status.js — checklist attivazione + scadenze token.
 */
const { computeSetupStatus, tokenExpiryWarnings } = require('../lib/setup-status');
const { groupStats } = require('../lib/analytics');

// Finto db better-sqlite3: risponde alle 2 prepare usate da computeSetupStatus
function fakeDb({ hasPlan = false, hasActiveSchedule = false } = {}) {
  return {
    prepare(sql) {
      return {
        get() {
          if (/FROM editorial_plans/.test(sql)) return hasPlan ? { id: 'p1' } : undefined;
          if (/FROM schedules/.test(sql)) return hasActiveSchedule ? { id: 's1' } : undefined;
          return undefined;
        }
      };
    }
  };
}

const bareClient = { id: 'c1' };
const fullClient = {
  id: 'c2',
  fb_page_id: '123', fb_system_user_token: 'tok', ig_user_id: '456',
  contact_email: 'x@y.it', logo_filename: 'logo.png', subscription_plan: 'Pro'
};

describe('computeSetupStatus', () => {
  test('cliente vuoto: 3 critici mancanti, non completo', () => {
    const s = computeSetupStatus(bareClient, fakeDb());
    expect(s.criticalMissing).toBe(3); // canali, piano, schedule
    expect(s.complete).toBe(false);
    expect(s.isPaying).toBe(false);
  });

  test('cliente completo: 0 critici, complete', () => {
    const s = computeSetupStatus(fullClient, fakeDb({ hasPlan: true, hasActiveSchedule: true }));
    expect(s.criticalMissing).toBe(0);
    expect(s.complete).toBe(true);
    expect(s.isPaying).toBe(true);
  });

  test('fb_page_id senza system token NON conta come canale', () => {
    const c = { id: 'c3', fb_page_id: '123' }; // manca il token
    const s = computeSetupStatus(c, fakeDb());
    expect(s.checks.find(x => x.key === 'channels').ok).toBe(false);
  });

  test('solo LinkedIn configurato conta come canale', () => {
    const c = { id: 'c4', linkedin_org_id: '99', linkedin_access_token: 'tok' };
    const s = computeSetupStatus(c, fakeDb());
    expect(s.checks.find(x => x.key === 'channels').ok).toBe(true);
  });

  test('pagante con setup incompleto → isPaying + criticalMissing > 0', () => {
    const c = { id: 'c5', subscription_plan: 'Social Basic' };
    const s = computeSetupStatus(c, fakeDb());
    expect(s.isPaying).toBe(true);
    expect(s.criticalMissing).toBeGreaterThan(0);
  });
});

describe('tokenExpiryWarnings', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const iso = (daysFromNow) => new Date(now + daysFromNow * 86400000).toISOString();

  test('LinkedIn in scadenza tra 10 giorni → warning', () => {
    const c = { linkedin_org_id: '1', linkedin_token_expires_at: iso(10) };
    const w = tokenExpiryWarnings(c, now);
    expect(w).toHaveLength(1);
    expect(w[0].channel).toBe('LinkedIn');
    expect(w[0].daysLeft).toBe(10);
    expect(w[0].expired).toBe(false);
  });

  test('LinkedIn a 30 giorni → nessun warning (soglia 14)', () => {
    const c = { linkedin_org_id: '1', linkedin_token_expires_at: iso(30) };
    expect(tokenExpiryWarnings(c, now)).toHaveLength(0);
  });

  test('token scaduto → expired true', () => {
    const c = { linkedin_org_id: '1', linkedin_token_expires_at: iso(-3) };
    const w = tokenExpiryWarnings(c, now);
    expect(w[0].expired).toBe(true);
  });

  test('TikTok refresh a 20 giorni → warning (soglia 30)', () => {
    const c = { tiktok_refresh_token: 'r', tiktok_refresh_expires_at: iso(20) };
    const w = tokenExpiryWarnings(c, now);
    expect(w).toHaveLength(1);
    expect(w[0].channel).toBe('TikTok');
  });

  test('date assenti o invalide → nessun warning, nessun crash', () => {
    expect(tokenExpiryWarnings({ linkedin_org_id: '1' }, now)).toHaveLength(0);
    expect(tokenExpiryWarnings({ linkedin_org_id: '1', linkedin_token_expires_at: 'boh' }, now)).toHaveLength(0);
  });
});

describe('analytics groupStats', () => {
  const rows = [
    { post_id: 'a', platform: 'fb', reach: 100, engagement: 10 },
    { post_id: 'a', platform: 'ig', reach: 200, engagement: 30 },
    { post_id: 'b', platform: 'fb', reach: 300, engagement: 20 },
  ];

  test('raggruppa per piattaforma con medie corrette', () => {
    const out = groupStats(rows, r => r.platform);
    const fb = out.find(o => o.key === 'fb');
    expect(fb.posts).toBe(2);
    expect(fb.avg_reach).toBe(200);   // (100+300)/2
    expect(fb.avg_engagement).toBe(15); // (10+20)/2
  });

  test('ordina per engagement medio decrescente', () => {
    const out = groupStats(rows, r => r.platform);
    expect(out[0].key).toBe('ig'); // 30 > 15
  });

  test('valori null esclusi dalle medie, chiavi null scartate', () => {
    const out = groupStats([
      { post_id: 'x', platform: 'fb', reach: null, engagement: 8 },
      { post_id: 'y', platform: null, reach: 50, engagement: 1 },
    ], r => r.platform);
    expect(out).toHaveLength(1);
    expect(out[0].avg_reach).toBe(null);
    expect(out[0].avg_engagement).toBe(8);
  });
});
