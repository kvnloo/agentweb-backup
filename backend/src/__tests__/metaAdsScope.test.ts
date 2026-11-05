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
  META_ADS_ASSET_ACCESS_MESSAGE,
  META_ADS_NO_PAGES_MESSAGE,
  getMetaAdsScopeState,
  getMetaPagesAccessState,
  getMetaAdsNoPagesMessage,
  buildMetaAdsWrongPageMessage,
  getAccessiblePageIds,
  buildMetaAdsPageNotAccessibleMessage,
  hasMetaAdsReadScope,
  isMetaAdsScopeRefusal,
  buildMetaAdsScopeError,
  describeMetaAdsCapability,
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

  // ── Recorded revocation ──────────────────────────────────────────────────
  // When Meta authoritatively refuses a read we persist what we learned. For a
  // legacy record that means granted_scopes becomes [] — which on its own is
  // indistinguishable from "we never asked". `ads_scope_revoked_at` is what
  // makes the refusal explicit, so the next read fails at the pre-flight gate
  // instead of hitting Meta again with the same impossible request.

  it("returns 'missing' when a revocation was recorded, even with an empty granted_scopes", () => {
    const config = {
      ...baseConfig,
      granted_scopes: [],
      ads_scope_revoked_at: '2026-07-29T09:00:00.000Z',
    };
    expect(getMetaAdsScopeState(config)).toBe<MetaAdsScopeState>('missing');
  });

  it("returns 'missing' when a revocation was recorded and granted_scopes is absent", () => {
    const config = { ...baseConfig, ads_scope_revoked_at: '2026-07-29T09:00:00.000Z' };
    expect(getMetaAdsScopeState(config)).toBe<MetaAdsScopeState>('missing');
  });

  it("lets a fresh grant win over a stale revocation marker — re-consent recovers", () => {
    // If the user reconnects and Meta reports ads access, that is newer truth than
    // any previously recorded refusal. Recovery must not require manual cleanup.
    const config = {
      ...baseConfig,
      granted_scopes: ['ads_read'],
      ads_scope_revoked_at: '2026-07-29T09:00:00.000Z',
    };
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

/**
 * Greptile P1-2 ("Generic permission errors revoke Ads"), and it is the sharper
 * half of this module.
 *
 * A permission *classification* is not proof that Ads scopes are absent. Meta
 * labels a whole family of unrelated refusals with code 10 / 200-299 — missing
 * `business_management`, an ad account the user cannot see, a disabled asset.
 * If any of those were taken as evidence, the normalization path would strip the
 * stored Ads grant from a connection that genuinely has it, then refuse every
 * later request with re-consent guidance that cannot fix anything. That turns a
 * transient upstream error into a bricked customer connection.
 *
 * So the predicate demands that Meta *name an Ads scope*. A false negative
 * merely falls through to the pre-existing soft error path; a false positive
 * destroys working state. The asymmetry decides the design.
 */
describe('isMetaAdsScopeRefusal', () => {
  it('recognizes the exact production message from OPS-79', () => {
    const error = new Error(
      '(#200) Ad account owner has NOT granted ads_management or ads_read permission'
    );
    expect(isMetaAdsScopeRefusal(error)).toBe(true);
  });

  it('recognizes a nested axios-shaped Graph error that names ads_read', () => {
    const error: any = new Error('Request failed with status code 400');
    error.response = { data: { error: { code: 272, message: 'Requires ads_read' } } };
    expect(isMetaAdsScopeRefusal(error)).toBe(true);
  });

  it('recognizes the "Meta Permission Denied" string when it names an Ads scope', () => {
    expect(isMetaAdsScopeRefusal(new Error('Meta Permission Denied: ads_read required'))).toBe(true);
  });

  it('finds the Ads scope when it is only in the structuredError message', () => {
    const error: any = new Error('Request failed');
    error.structuredError = {
      code: 200,
      classification: 'PERMISSION_ERROR',
      message: '(#200) ads_management permission is required',
    };
    expect(isMetaAdsScopeRefusal(error)).toBe(true);
  });

  // ── The P1-2 guards ────────────────────────────────────────────────────────

  it('does NOT treat a generic PERMISSION_ERROR classification as an Ads refusal', () => {
    // metaService.handleError stamps this on every code 10 / 200-299. On its own
    // it says nothing about Ads scopes.
    const error: any = new Error('Something went wrong');
    error.structuredError = { code: 200, classification: 'PERMISSION_ERROR' };
    expect(isMetaAdsScopeRefusal(error)).toBe(false);
  });

  it('does NOT treat a business_management refusal as an Ads refusal', () => {
    // Real Meta error, real code 200, entirely unrelated capability.
    const error: any = new Error('(#200) Requires business_management permission');
    error.code = 200;
    expect(isMetaAdsScopeRefusal(error)).toBe(false);
  });

  it('does NOT treat a bare code 10 permission denial as an Ads refusal', () => {
    const error: any = new Error('Application does not have permission for this action');
    error.code = 10;
    expect(isMetaAdsScopeRefusal(error)).toBe(false);
  });

  it('does NOT treat an unrelated 200-299 code as an Ads refusal', () => {
    const error: any = new Error('(#272) Ad account is not accessible to this user');
    error.code = 272;
    expect(isMetaAdsScopeRefusal(error)).toBe(false);
  });

  it('does NOT treat an expired token (code 190) as a scope problem', () => {
    // Token expiry already has its own reconnect message and its own remedy;
    // misrouting it into the scope error would give the user the wrong fix.
    const error: any = new Error('Meta access token expired or invalid');
    error.code = 190;
    expect(isMetaAdsScopeRefusal(error)).toBe(false);
  });

  it('does NOT treat a validation error (code 100) as a scope problem', () => {
    // ENG-630 owns the `filtering must be an array` (#100) defect — it must not
    // be swallowed by this issue's re-consent messaging.
    const error: any = new Error('(#100) param filtering must be an array');
    error.code = 100;
    expect(isMetaAdsScopeRefusal(error)).toBe(false);
  });

  it('does NOT fire on a code-100 validation error that merely mentions ads_read', () => {
    // Naming the scope is necessary but not sufficient — a malformed-field error
    // that happens to reference the field must not revoke a grant.
    const error: any = new Error('(#100) Invalid parameter: ads_read is not a valid field here');
    error.code = 100;
    expect(isMetaAdsScopeRefusal(error)).toBe(false);
  });

  it('does NOT treat a rate limit as a scope problem', () => {
    expect(isMetaAdsScopeRefusal(new Error('Meta rate limit exceeded'))).toBe(false);
  });

  it('returns false for null/undefined/non-error input rather than throwing', () => {
    expect(isMetaAdsScopeRefusal(null)).toBe(false);
    expect(isMetaAdsScopeRefusal(undefined)).toBe(false);
    expect(isMetaAdsScopeRefusal('a string')).toBe(false);
  });

  it('returns false for an object carrying no readable text at all', () => {
    // An error-shaped object with nothing to inspect must not be guessed at.
    expect(isMetaAdsScopeRefusal({})).toBe(false);
    expect(isMetaAdsScopeRefusal({ response: {} })).toBe(false);
  });

  // ── Error-shape plumbing ───────────────────────────────────────────────────
  // Meta does not deliver errors in one shape. The Graph SDK, axios, and
  // metaService.handleError each nest the code and the human-readable text
  // differently, so both extraction helpers have to look in several places.
  // Each of these is a shape seen in the wild, not a synthetic permutation.

  describe('reads the Graph code wherever Meta put it', () => {
    it('finds the code on response.data.code', () => {
      const error: any = new Error('ads_read permission is required');
      error.response = { data: { code: 272 } };
      expect(isMetaAdsScopeRefusal(error)).toBe(true);
    });

    it('finds the code on a nested error object', () => {
      const error: any = new Error('ads_management not available');
      error.error = { code: 10 };
      expect(isMetaAdsScopeRefusal(error)).toBe(true);
    });

    it('ignores a non-numeric code rather than coercing it', () => {
      // A garbage code must not accidentally land inside the 200-299 band, and
      // must not mask the hard 190/100 exclusions either.
      const error: any = new Error('ads_read is not granted');
      error.code = 'PERMISSION_DENIED';
      expect(isMetaAdsScopeRefusal(error)).toBe(true); // falls back to text shape
    });

    it('still applies the 190 exclusion when the code is nested', () => {
      const error: any = new Error('ads_read permission lost — token expired');
      error.response = { data: { error: { code: 190 } } };
      expect(isMetaAdsScopeRefusal(error)).toBe(false);
    });
  });

  describe('reads the refusal text wherever Meta put it', () => {
    it('finds the Ads scope in structuredError.error_user_msg', () => {
      const error: any = new Error('Request failed');
      error.structuredError = {
        code: 200,
        error_user_msg: 'You have not granted ads_read for this ad account.',
      };
      expect(isMetaAdsScopeRefusal(error)).toBe(true);
    });

    it('finds the Ads scope in structuredError.error_user_title', () => {
      const error: any = new Error('Request failed');
      error.structuredError = { code: 200, error_user_title: 'ads_management required' };
      expect(isMetaAdsScopeRefusal(error)).toBe(true);
    });

    it('finds the Ads scope in response.data.message', () => {
      const error: any = new Error('Request failed with status code 400');
      error.response = { data: { message: '(#200) ads_read has not been granted' } };
      expect(isMetaAdsScopeRefusal(error)).toBe(true);
    });

    it('finds the Ads scope in a nested error.message', () => {
      const error: any = new Error('Request failed');
      error.error = { message: 'ads_management permission missing' };
      expect(isMetaAdsScopeRefusal(error)).toBe(true);
    });
  });

  describe('what makes a refusal "permission shaped"', () => {
    // The scope name is necessary; one of these signals is what makes it
    // sufficient. Each is exercised in isolation so none is load-bearing by accident.

    it('accepts code 10 when the message names an Ads scope', () => {
      const error: any = new Error('ads_read unavailable for this user');
      error.code = 10;
      expect(isMetaAdsScopeRefusal(error)).toBe(true);
    });

    it('accepts a PERMISSION_ERROR classification with no usable code', () => {
      const error: any = new Error('ads_read unavailable');
      error.structuredError = { classification: 'PERMISSION_ERROR' };
      expect(isMetaAdsScopeRefusal(error)).toBe(true);
    });

    it('accepts the bare "(#200)" prefix with no code field', () => {
      expect(isMetaAdsScopeRefusal(new Error('(#200) ads_read was refused'))).toBe(true);
    });

    it('accepts the word "permission" with no code field', () => {
      expect(isMetaAdsScopeRefusal(new Error('ads_management permission denied'))).toBe(true);
    });

    it('accepts "not granted" with no code field', () => {
      expect(isMetaAdsScopeRefusal(new Error('ads_read was not granted'))).toBe(true);
    });

    it('rejects a bare mention of an Ads scope with no refusal signal at all', () => {
      // Naming the scope is necessary but never sufficient on its own — this is
      // the branch that stops an incidental mention from revoking a grant.
      expect(isMetaAdsScopeRefusal(new Error('requested fields: ads_read, spend'))).toBe(false);
    });
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

/**
 * ENG-1158 — the same capability annotation has to reach the Settings UI, not
 * just the agent tool. Both surfaces now read this one helper, so a connection
 * can never be "degraded" to the model and "Connected" to its owner.
 */
describe('describeMetaAdsCapability', () => {
  const adAccount = (config: Record<string, unknown>) => ({
    platform: 'meta',
    account_id: '922903076601160',
    config: { account_type: 'ad_account', ...config },
  });

  it('says nothing about accounts on other platforms', () => {
    expect(
      describeMetaAdsCapability({
        platform: 'google_ads',
        config: { account_type: 'ad_account', granted_scopes: [] },
      })
    ).toEqual({});
  });

  it('says nothing about non-ads Meta connections (pages, instagram)', () => {
    expect(
      describeMetaAdsCapability({
        platform: 'meta',
        config: { account_type: 'instagram_business', granted_scopes: ['pages_show_list'] },
      })
    ).toEqual({});
  });

  it('reports an affirmative grant as capable, with no warning to cry wolf with', () => {
    expect(describeMetaAdsCapability(adAccount({ granted_scopes: ['ads_read'] }))).toEqual({
      ads_capable: true,
    });
  });

  it('reports an authoritatively missing grant as incapable, with the actionable message', () => {
    expect(
      describeMetaAdsCapability(adAccount({ granted_scopes: ['pages_show_list'] }))
    ).toEqual({ ads_capable: false, capability_warning: META_ADS_RECONSENT_MESSAGE });
  });

  it('treats a recorded revocation as authoritative even when the retained grant is empty', () => {
    // The production shape of account 922903076601160: granted_scopes narrowed to
    // [] by the detection path, with the refusal recorded alongside it.
    expect(
      describeMetaAdsCapability(
        adAccount({ granted_scopes: [], ads_scope_revoked_at: '2026-07-31T07:00:21.688Z' })
      )
    ).toEqual({ ads_capable: false, capability_warning: META_ADS_RECONSENT_MESSAGE });
  });

  it('stays silent on a legacy record we know nothing about', () => {
    expect(describeMetaAdsCapability(adAccount({}))).toEqual({});
  });

  it('reports the asset-tier message when the app grant is confirmed but the ad account refused', () => {
    // Account 922903076601160's actual production shape: the app-level scope is
    // confirmed present (verified live via debug_token), so reconnecting cannot
    // fix this — only the ad account owner granting asset access can.
    expect(
      describeMetaAdsCapability(
        adAccount({
          granted_scopes: [],
          ads_scope_revoked_at: '2026-07-31T07:00:21.688Z',
          ads_scope_tier: 'asset',
        })
      )
    ).toEqual({ ads_capable: false, capability_warning: META_ADS_ASSET_ACCESS_MESSAGE });
  });

  it('falls back to the OAuth-tier message when the tier could not be determined', () => {
    expect(
      describeMetaAdsCapability(
        adAccount({ granted_scopes: [], ads_scope_revoked_at: '2026-07-31T07:00:21.688Z' })
      )
    ).toEqual({ ads_capable: false, capability_warning: META_ADS_RECONSENT_MESSAGE });
  });

  it('reports declined required OAuth permissions as incapable even when an ads scope is present', () => {
    const result = describeMetaAdsCapability(
      adAccount({
        granted_scopes: ['ads_read'],
        declined_required_permissions: ['pages_read_engagement'],
      })
    );
    expect(result.ads_capable).toBe(false);
    expect(result.capability_warning).toContain('pages_read_engagement');
    expect(result.capability_warning).toContain('Edit access');
  });

  it('reports an OAuth health read failure as not healthy rather than capable', () => {
    const result = describeMetaAdsCapability(
      adAccount({
        granted_scopes: ['ads_read'],
        meta_oauth_health_error: 'Meta permissions endpoint timed out',
      })
    );
    expect(result.ads_capable).toBe(false);
    expect(result.capability_warning).toContain('could not be fully verified');
    expect(result.capability_warning).toContain('Meta permissions endpoint timed out');
  });

  it('tolerates a null/undefined account without throwing', () => {
    expect(describeMetaAdsCapability(null)).toEqual({});
    expect(describeMetaAdsCapability(undefined)).toEqual({});
  });
});

/**
 * ENG-2232 — Page access is a second, independent Meta grant. A connection can
 * have ads_read granted and still have zero accessible Facebook Pages, which
 * is fatal for every AD_CREATIVE (each one needs a page_id). Production case:
 * ad account 1209971551106961 reported `ads_capable: true` with PAGE LIST
 * returning 0 Pages both before and after the customer reconnected, so
 * `list_connected_accounts` never warned before 4 campaigns + 4 ad sets were
 * already built and approved.
 */
describe('getMetaPagesAccessState', () => {
  it("returns 'granted' when has_meta_pages is true", () => {
    expect(getMetaPagesAccessState({ has_meta_pages: true })).toBe<MetaAdsScopeState>('granted');
  });

  it("returns 'missing' when has_meta_pages is false", () => {
    expect(getMetaPagesAccessState({ has_meta_pages: false })).toBe<MetaAdsScopeState>('missing');
  });

  it("returns 'unknown' when has_meta_pages was never probed", () => {
    expect(getMetaPagesAccessState({})).toBe<MetaAdsScopeState>('unknown');
    expect(getMetaPagesAccessState(undefined)).toBe<MetaAdsScopeState>('unknown');
    expect(getMetaPagesAccessState(null)).toBe<MetaAdsScopeState>('unknown');
  });
});

describe('describeMetaAdsCapability — Page access (ENG-2232)', () => {
  const adAccount = (config: Record<string, unknown>) => ({
    platform: 'meta',
    account_id: '1209971551106961',
    config: { account_type: 'ad_account', ...config },
  });

  it('stays read-capable but create-incapable (ENG-2822) with the Page-specific warning when ads_read is granted but 0 Pages are accessible', () => {
    // The exact production shape: ads_read granted, has_meta_pages confirmed false.
    expect(
      describeMetaAdsCapability(adAccount({ granted_scopes: ['ads_read'], has_meta_pages: false }))
    ).toEqual({ ads_capable: true, can_create_ads: false, capability_warning: META_ADS_NO_PAGES_MESSAGE });
  });

  it('is create-incapable with the Page-specific warning even when the ads scope state is unknown', () => {
    // No granted_scopes on record at all, but the Page probe still ran and found none.
    expect(
      describeMetaAdsCapability(adAccount({ has_meta_pages: false }))
    ).toEqual({ ads_capable: false, can_create_ads: false, capability_warning: META_ADS_NO_PAGES_MESSAGE });
  });

  it('stays capable when ads_read is granted and Pages are confirmed accessible', () => {
    expect(
      describeMetaAdsCapability(adAccount({ granted_scopes: ['ads_read'], has_meta_pages: true }))
    ).toEqual({ ads_capable: true });
  });

  it('stays capable (no page warning) when the Page probe never ran — never crying wolf on a legacy record', () => {
    expect(
      describeMetaAdsCapability(adAccount({ granted_scopes: ['ads_read'] }))
    ).toEqual({ ads_capable: true });
  });

  it('prefers the OAuth re-consent message when BOTH the ads scope and Page access are missing', () => {
    // Reconnecting fixes the OAuth grant and lets the user pick Pages in the same flow —
    // one actionable message beats two competing ones.
    expect(
      describeMetaAdsCapability(
        adAccount({ granted_scopes: ['pages_show_list'], has_meta_pages: false })
      )
    ).toEqual({ ads_capable: false, capability_warning: META_ADS_RECONSENT_MESSAGE });
  });

  it('names the specific Page when has_meta_pages is false because of a wrong-Page mismatch, not zero Pages', () => {
    // This account DOES have Page access — just not to the Page its own ads use.
    // "no Facebook Pages are accessible" would be false here.
    const warning = describeMetaAdsCapability(
      adAccount({
        granted_scopes: ['ads_read'],
        has_meta_pages: false,
        existing_ads_page_id: '1010991085424542',
      })
    ).capability_warning;
    expect(warning).toContain('1010991085424542');
    expect(warning).not.toEqual(META_ADS_NO_PAGES_MESSAGE);
  });

  it('falls back to the generic zero-Pages message when existing_ads_page_id is absent', () => {
    expect(
      describeMetaAdsCapability(
        adAccount({ granted_scopes: ['ads_read'], has_meta_pages: false, existing_ads_page_id: undefined })
      )
    ).toEqual({ ads_capable: true, can_create_ads: false, capability_warning: META_ADS_NO_PAGES_MESSAGE });
  });
});

describe('getMetaAdsNoPagesMessage', () => {
  it('returns the generic message when no existing_ads_page_id is recorded', () => {
    expect(getMetaAdsNoPagesMessage({})).toBe(META_ADS_NO_PAGES_MESSAGE);
    expect(getMetaAdsNoPagesMessage(null)).toBe(META_ADS_NO_PAGES_MESSAGE);
    expect(getMetaAdsNoPagesMessage({ existing_ads_page_id: null })).toBe(META_ADS_NO_PAGES_MESSAGE);
  });

  it('returns the Page-specific message, naming the Page, when existing_ads_page_id is a string', () => {
    const message = getMetaAdsNoPagesMessage({ existing_ads_page_id: '1010991085424542' });
    expect(message).toBe(buildMetaAdsWrongPageMessage('1010991085424542'));
    expect(message).toContain('1010991085424542');
  });

  it('ignores a non-string existing_ads_page_id (defensive, shouldn\'t happen)', () => {
    expect(getMetaAdsNoPagesMessage({ existing_ads_page_id: 12345 })).toBe(META_ADS_NO_PAGES_MESSAGE);
  });
});

describe('getAccessiblePageIds', () => {
  it('returns undefined when never probed — must not be read as an empty, confirmed list', () => {
    expect(getAccessiblePageIds({})).toBeUndefined();
    expect(getAccessiblePageIds(null)).toBeUndefined();
    expect(getAccessiblePageIds(undefined)).toBeUndefined();
  });

  it('returns the probed ids', () => {
    expect(getAccessiblePageIds({ accessible_page_ids: ['1010991085424542', 'page_2'] })).toEqual([
      '1010991085424542',
      'page_2',
    ]);
  });

  it('returns [] (not undefined) when probed and confirmed empty', () => {
    expect(getAccessiblePageIds({ accessible_page_ids: [] })).toEqual([]);
  });

  it('filters out non-string entries defensively', () => {
    expect(getAccessiblePageIds({ accessible_page_ids: ['page_1', 42, null] })).toEqual(['page_1']);
  });

  it('treats a non-array value as never-probed', () => {
    expect(getAccessiblePageIds({ accessible_page_ids: 'page_1' })).toBeUndefined();
  });
});

describe('buildMetaAdsPageNotAccessibleMessage', () => {
  it('names the specific requested Page', () => {
    const message = buildMetaAdsPageNotAccessibleMessage('1010991085424542');
    expect(message).toContain('1010991085424542');
    expect(message).toContain('Choose Pages');
    expect(message).toContain('Advertiser');
  });
});

/**
 * ENG-1158 — the Facebook alias exists in older records; it must not be a
 * capability blind spot.
 */
describe('describeMetaAdsCapability — facebook alias', () => {
  it('annotates a legacy platform:"facebook" ad account the same way', () => {
    expect(
      describeMetaAdsCapability({
        platform: 'facebook',
        config: { account_type: 'ad_account', granted_scopes: ['ads_management'] },
      })
    ).toEqual({ ads_capable: true });
  });
});
