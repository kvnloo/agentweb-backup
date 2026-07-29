/**
 * Unit tests for the Meta Ads scope capability helpers (ENG-629).
 *
 * Context: OPS-79 fired twice in 24h — the scheduled Meta Ads report on account
 * 922903076601160 failed with "(#200) ... has NOT granted ads_management or
 * ads_read permission", but `list_connected_accounts` reported the account as
 * connected + active and the run produced a report with no data rather than a
 * loud, actionable failure.
 *
 * The subtlety these tests pin: `routes/metaAuth.ts` historically persisted the
 * scopes we *requested* (`flowCfg.scopes`) rather than the ones Meta actually
 * *granted*. So `BaseOAuthConfig.scopes` always contains ads_read/ads_management
 * for a marketing connection and is worthless as a capability signal. Only
 * `granted_scopes` (populated from debug_token) is trustworthy — and when it is
 * absent we must report 'unknown', never a confident 'granted'.
 */
import {
  META_ADS_READ_SCOPES,
  META_ADS_RECONSENT_MESSAGE,
  getMetaAdsScopeState,
  hasMetaAdsReadScope,
  isMetaAdsPermissionError,
  buildMetaAdsScopeError,
  MetaAdsScopeState,
} from '../utils/metaAdsScope';

const baseConfig = {
  account_type: 'ad_account' as const,
  ad_account_id: '922903076601160',
  access_token: 'EAA-super-secret-token',
  token_expires_at: Date.now() + 3600_000,
};

describe('META_ADS_READ_SCOPES', () => {
  it('names both scopes Meta accepts for reading ads data', () => {
    expect([...META_ADS_READ_SCOPES].sort()).toEqual(['ads_management', 'ads_read']);
  });
});

describe('getMetaAdsScopeState', () => {
  it("returns 'granted' when granted_scopes contains ads_read", () => {
    const config = { ...baseConfig, granted_scopes: ['ads_read', 'pages_show_list'] };
    expect(getMetaAdsScopeState(config)).toBe<MetaAdsScopeState>('granted');
  });

  it("returns 'granted' when granted_scopes contains only ads_management", () => {
    // ads_management is a superset of ads_read for our read paths.
    const config = { ...baseConfig, granted_scopes: ['ads_management'] };
    expect(getMetaAdsScopeState(config)).toBe<MetaAdsScopeState>('granted');
  });

  it("returns 'missing' when granted_scopes is populated but has no ads scope", () => {
    // This is the OPS-79 shape once metaAuth records real grants: the user
    // consented to pages but declined ads.
    const config = {
      ...baseConfig,
      granted_scopes: ['pages_show_list', 'pages_read_engagement', 'public_profile'],
    };
    expect(getMetaAdsScopeState(config)).toBe<MetaAdsScopeState>('missing');
  });

  it("returns 'unknown' when granted_scopes is absent, even though legacy scopes claims ads access", () => {
    // THE CORE REGRESSION GUARD. Legacy records carry the *requested* scopes in
    // `scopes`, so trusting that field would report 'granted' for exactly the
    // account that is failing in production. It must degrade to 'unknown'.
    const config = {
      ...baseConfig,
      scopes: ['ads_management', 'ads_read', 'pages_show_list'],
    };
    expect(getMetaAdsScopeState(config)).toBe<MetaAdsScopeState>('unknown');
  });

  it("returns 'unknown' when granted_scopes is an empty array", () => {
    const config = { ...baseConfig, granted_scopes: [] };
    expect(getMetaAdsScopeState(config)).toBe<MetaAdsScopeState>('unknown');
  });

  it("returns 'unknown' for a null/undefined config rather than throwing", () => {
    expect(getMetaAdsScopeState(undefined)).toBe<MetaAdsScopeState>('unknown');
    expect(getMetaAdsScopeState(null)).toBe<MetaAdsScopeState>('unknown');
  });

  it('ignores non-string entries in granted_scopes without throwing', () => {
    const config = { ...baseConfig, granted_scopes: [null, 42, 'ads_read'] as any };
    expect(getMetaAdsScopeState(config)).toBe<MetaAdsScopeState>('granted');
  });
});

describe('hasMetaAdsReadScope', () => {
  it('is true only for an authoritative grant', () => {
    expect(hasMetaAdsReadScope({ ...baseConfig, granted_scopes: ['ads_read'] })).toBe(true);
  });

  it('is false when authoritatively missing', () => {
    expect(hasMetaAdsReadScope({ ...baseConfig, granted_scopes: ['pages_show_list'] })).toBe(false);
  });

  it('is false when unknown — absence of proof is not proof of capability', () => {
    expect(hasMetaAdsReadScope({ ...baseConfig, scopes: ['ads_read'] })).toBe(false);
  });
});

describe('isMetaAdsPermissionError', () => {
  it('recognizes the exact production message from OPS-79', () => {
    const error = new Error(
      '(#200) Ad account owner has NOT granted ads_management or ads_read permission'
    );
    expect(isMetaAdsPermissionError(error)).toBe(true);
  });

  it('recognizes a structuredError classified PERMISSION_ERROR by metaService.handleError', () => {
    const error: any = new Error('Something went wrong');
    error.structuredError = { code: 200, classification: 'PERMISSION_ERROR' };
    expect(isMetaAdsPermissionError(error)).toBe(true);
  });

  it('recognizes Graph error code 10 (permission denied)', () => {
    const error: any = new Error('Application does not have permission for this action');
    error.code = 10;
    expect(isMetaAdsPermissionError(error)).toBe(true);
  });

  it('recognizes a nested axios-shaped Graph error with code in the 200-299 band', () => {
    const error: any = new Error('Request failed with status code 400');
    error.response = { data: { error: { code: 272, message: 'Requires ads_read' } } };
    expect(isMetaAdsPermissionError(error)).toBe(true);
  });

  it('recognizes the "Meta Permission Denied" string thrown on a 403', () => {
    expect(isMetaAdsPermissionError(new Error('Meta Permission Denied: ads_read required'))).toBe(true);
  });

  it('does NOT treat an expired token (code 190) as a scope problem', () => {
    // Token expiry already has its own reconnect message and its own remedy;
    // misrouting it into the scope error would give the user the wrong fix.
    const error: any = new Error('Meta access token expired or invalid');
    error.code = 190;
    expect(isMetaAdsPermissionError(error)).toBe(false);
  });

  it('does NOT treat a validation error (code 100) as a scope problem', () => {
    // ENG-630 owns the `filtering must be an array` (#100) defect — it must not
    // be swallowed by this issue's re-consent messaging.
    const error: any = new Error('(#100) param filtering must be an array');
    error.code = 100;
    expect(isMetaAdsPermissionError(error)).toBe(false);
  });

  it('does NOT treat a rate limit as a scope problem', () => {
    expect(isMetaAdsPermissionError(new Error('Meta rate limit exceeded'))).toBe(false);
  });

  it('returns false for null/undefined/non-error input rather than throwing', () => {
    expect(isMetaAdsPermissionError(null)).toBe(false);
    expect(isMetaAdsPermissionError(undefined)).toBe(false);
    expect(isMetaAdsPermissionError('a string')).toBe(false);
  });
});

describe('buildMetaAdsScopeError', () => {
  it('names the missing capability and directs the owner to re-consent', () => {
    const err = buildMetaAdsScopeError();
    expect(err.message).toContain('ads_read');
    expect(err.message).toContain('ads_management');
    expect(err.message.toLowerCase()).toMatch(/reconnect|re-consent/);
  });

  it('states plainly that no data was retrieved, so a run cannot imply success', () => {
    // AC3: a scheduled run must never read as "metrics retrieved".
    expect(buildMetaAdsScopeError().message.toLowerCase()).toContain('no ');
    expect(buildMetaAdsScopeError().message).toBe(META_ADS_RECONSENT_MESSAGE);
  });

  it('is flagged isMetaAuthError so it throws instead of degrading to a soft empty result', () => {
    const err = buildMetaAdsScopeError() as any;
    expect(err.isMetaAuthError).toBe(true);
    expect(err.isMetaAdsScopeError).toBe(true);
  });

  it('never leaks the access token or fbtrace_id from the upstream error', () => {
    const upstream: any = new Error(
      '(#200) not granted ads_read; access_token=EAA-super-secret-token fbtrace_id=AbCdEf123'
    );
    const err = buildMetaAdsScopeError({ cause: upstream });
    expect(err.message).not.toContain('EAA-super-secret-token');
    expect(err.message).not.toContain('AbCdEf123');
    expect(err.message).not.toContain('access_token');
  });

  it('produces one stable message regardless of which upstream error triggered it', () => {
    // "one actionable error" (AC2) — not a family of near-duplicates.
    const a = buildMetaAdsScopeError({ cause: new Error('(#200) nope') });
    const b = buildMetaAdsScopeError({ cause: new Error('Meta Permission Denied: x') });
    expect(a.message).toBe(b.message);
  });

  it('optionally names the account so a multi-account user knows which to fix', () => {
    const err = buildMetaAdsScopeError({ accountLabel: 'act_922903076601160' });
    expect(err.message).toContain('act_922903076601160');
  });
});
