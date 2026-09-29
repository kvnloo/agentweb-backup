/**
 * A revoked HubSpot refresh token must be recorded, not just thrown.
 *
 * GET /api/oauth/connected-accounts reports any account holding a `refresh_token` as
 * `active` / "Connected" — deliberately, so auto-renewing integrations don't surface a
 * 30-minute access-token expiry. Nothing in that check notices the token stopped
 * working, so a revoked grant renders as Connected indefinitely: one production portal
 * read "Active · Connected" for 97 days while every sync against it returned 401.
 *
 * The fix persists `needs_reconnect` when — and only when — HubSpot definitively
 * rejects the refresh. These tests pin both halves of that, because flagging a
 * transient outage would hard-fail a healthy connection and tell a paying customer
 * their integration is broken.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
  updateAccountConfig: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    redirectUri: 'http://localhost:3001/api/oauth/hubspot/callback',
    scopes: ['crm.objects.contacts.read'],
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
  }),
}));

import axios from 'axios';
import { HubSpotService } from '../services/hubspotService';
import {
  getAccountsByUserId,
  updateAccountTokens,
  updateAccountConfig,
} from '../services/connectedAccountsDb';

const mockAxiosPost = axios.post as jest.Mock;
const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
const mockUpdateAccountConfig = updateAccountConfig as jest.MockedFunction<typeof updateAccountConfig>;
const mockUpdateAccountTokens = updateAccountTokens as jest.MockedFunction<typeof updateAccountTokens>;

/** Expired access token + a refresh token => create() must take the refresh path. */
const expiredAccount = (overrides: Record<string, unknown> = {}) => ({
  platform: 'hubspot' as const,
  account_id: '245815183',
  account_name: 'argusoft.com',
  config: {
    account_type: 'oauth' as const,
    access_token: 'stale-access-token',
    refresh_token: 'revoked-refresh-token',
    token_expires_at: Date.now() - 60 * 60 * 1000,
    hub_id: 245815183,
    ...overrides,
  },
  created_at: '2026-06-23T14:04:54.476Z',
  updated_at: '2026-06-23T14:04:54.476Z',
  userId: 'user-1',
});

const BAD_REFRESH_BODY = { status: 'BAD_REFRESH_TOKEN' };

/** No default for `data`: passing undefined must mean "no body", not "the default body". */
const httpError = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

/** A response object with no `data` key at all, which is not the same as data: undefined. */
const httpErrorNoBody = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateAccountConfig.mockResolvedValue(undefined as never);
  mockUpdateAccountTokens.mockResolvedValue(undefined as never);
});

describe('HubSpot refresh-token revocation', () => {
  it('flags needs_reconnect when HubSpot rejects the refresh token with 400', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(400, BAD_REFRESH_BODY));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);

    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1',
      'hubspot',
      '245815183',
      { needs_reconnect: true }
    );
  });

  it('flags needs_reconnect on a 401 that names the refresh token', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(401, BAD_REFRESH_BODY));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1',
      'hubspot',
      '245815183',
      { needs_reconnect: true }
    );
  });

  /*
   * A 401 must NOT condemn the grant on its own — the same rule as a 400, for a sharper
   * reason. The refresh POST carries client_id/client_secret, and RFC 6749 §5.2 assigns
   * 401 to `invalid_client`: a statement about the SHARED credential from
   * getHubSpotConfig(), not about one customer's grant. This repo's own OAuth server
   * splits them exactly that way (mcp/oauth/oauthRoutes.ts). An ungated 401 means one
   * rotated clientSecret — or a bodiless 401 from a proxy — flags every HubSpot account
   * in the fleet dead at once.
   *
   * Measured against live HubSpot: a revoked refresh token answers 400, not 401, so
   * nothing real is lost by gating this arm.
   */
  it.each([
    // The REAL shape, measured against live HubSpot with a valid refresh token and a
    // wrong client_secret — not an invented constant. This is the fleet-wide scenario:
    // if this ever matched, one rotated secret would flag every HubSpot account dead.
    ['invalid_client — the measured rotated-secret response', { status: 'BAD_CLIENT_SECRET', error: 'invalid_client', message: 'authentication credentials not valid' }],
    ['BAD_CLIENT_CREDENTIALS (kept: a plausible sibling code)', { status: 'BAD_CLIENT_CREDENTIALS', message: 'authentication credentials not valid' }],
    ['an RFC 6749 invalid_client body', { error: 'invalid_client' }],
    ['an unrelated string body', 'Unauthorized'],
    ['a null body', null],
  ])('does NOT flag on a 401 from %s', async (_label, body) => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(401, body));

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('does NOT flag on a bodiless 401, e.g. from a proxy or WAF', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpErrorNoBody(401));

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  // The asymmetry that matters: persisting "dead" on a blip would break a live
  // integration and email a customer that it is broken. 5xx / network must not flag.
  it.each([
    ['a 500 from HubSpot', httpError(500, BAD_REFRESH_BODY)],
    ['a 503 from HubSpot', httpError(503, BAD_REFRESH_BODY)],
    ['a network error with no response', new Error('ECONNRESET')],
  ])('does NOT flag needs_reconnect on %s', async (_label, err) => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(err);

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('rethrows the original transient error rather than the reconnect message', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(503, BAD_REFRESH_BODY));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/status code 503/);
  });

  it('refreshes normally and flags nothing when HubSpot accepts the refresh token', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'fresh-token', refresh_token: 'rotated', expires_in: 1800 },
    });

    await expect(HubSpotService.create('user-1')).resolves.toBeInstanceOf(HubSpotService);
    // A successful refresh clears the flag rather than leaving it untouched, so a grant
    // that recovers stops reporting "Reconnect required" on its next use. What must NOT
    // happen is it being SET.
    expect(mockUpdateAccountConfig).not.toHaveBeenCalledWith(
      'user-1', 'hubspot', '245815183', { needs_reconnect: true });
    expect(mockUpdateAccountTokens).toHaveBeenCalledWith(
      'user-1',
      'hubspot',
      expect.objectContaining({ access_token: 'fresh-token', refresh_token: 'rotated' }),
      '245815183'
    );
  });

  it('does not touch the refresh endpoint at all while the access token is still valid', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      expiredAccount({ token_expires_at: Date.now() + 60 * 60 * 1000 }),
    ] as never);

    await expect(HubSpotService.create('user-1')).resolves.toBeInstanceOf(HubSpotService);
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });
});

/*
 * A 400 alone must NOT condemn the grant.
 *
 * HubSpot's token endpoint answers 400 for client-side failures generally — a wrong
 * client_id/secret, a malformed body, an unsupported grant_type — not only for a dead
 * refresh token. The first version of this code flagged on the status alone, which meant
 * one rotated clientSecret in getHubSpotConfig() would mark EVERY HubSpot account in the
 * fleet dead in a single sweep: syncs stopped (externalCrmSyncService), scheduled runs
 * withheld (scheduledRunAccountGate), and every customer told to reconnect a working
 * integration. These cases pin the body check that prevents it.
 */
describe('a 400 only counts when the body says the refresh token is bad', () => {
  it.each([
    ['a bad client secret (measured shape)', { status: 'BAD_CLIENT_SECRET', error: 'invalid_client' }],
    ['a malformed request', { status: 'BAD_REQUEST', message: 'missing grant_type' }],
    ['a null body', null],
    ['an unrelated string body', 'Bad Request'],
  ])('does NOT flag needs_reconnect on a 400 from %s', async (_label, body) => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(400, body));

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  /*
   * MISMATCH_REFRESH_TOKEN_CLIENT is NOT hypothetical and NOT a second-guess of HubSpot.
   * It has been recorded in this repo since b97814ea4 (2026-06-26) —
   * externalCrmSyncService.ts:571 and externalCrmSync.service.test.ts:1104-1120 — as a
   * HubSpot 400 whose stated user-facing fix is "reconnect HubSpot". Matching only
   * BAD_REFRESH_TOKEN let that account report "Active · Connected" forever while a green
   * suite claimed revocation handling worked.
   *
   * The bare-message form is covered too: that commit shows the error reaching callers as
   * a plain message with the response body already lost.
   */
  it.each([
    ['BAD_REFRESH_TOKEN', { status: 'BAD_REFRESH_TOKEN' }],
    ['invalid_grant', { error: 'invalid_grant', error_description: 'refresh token expired' }],
    ['MISMATCH_REFRESH_TOKEN_CLIENT', { status: 'MISMATCH_REFRESH_TOKEN_CLIENT', message: 'refresh token was not issued to this client' }],
    ['the bare mismatch message', 'refresh token was not issued to this client'],
  ])('DOES flag on a 400 carrying %s', async (_label, body) => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(400, body));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1', 'hubspot', '245815183', { needs_reconnect: true });
  });

  it('does NOT flag on a 400 whose response carries no body at all', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpErrorNoBody(400));

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  /*
   * The boundary is 4xx vs 5xx, NOT 400/401 vs the rest.
   *
   * The previous version of this test asserted that a body reading BAD_REFRESH_TOKEN
   * must be IGNORED when it arrives as a 403 — it pinned a false negative in place. A
   * review said so; the status allow-list was kept anyway; and production then returned
   * a 403 for a genuinely unusable grant within minutes of the deploy. The status never
   * had a vote worth casting: the body is the discriminator.
   */
  it.each([[400], [401], [403], [404], [429]])(
    'DOES flag on a %i whose body names the refresh token', async (status) => {
      mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
      mockAxiosPost.mockRejectedValue(httpError(status, BAD_REFRESH_BODY));

      await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);
      expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
        'user-1', 'hubspot', '245815183', { needs_reconnect: true });
    });

  it.each([[500], [502], [503], [504]])(
    'does NOT flag on a %i even when the body names the refresh token — that is HubSpot failing, not the grant',
    async (status) => {
      mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
      mockAxiosPost.mockRejectedValue(httpError(status, BAD_REFRESH_BODY));

      await expect(HubSpotService.create('user-1')).rejects.toThrow();
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

  /*
   * The exact production response, byte-for-byte, from portal 245815183 on 2026-09-28.
   * This grant holds 19 legacy scopes while the app requests crm.objects.*; scopes are
   * fixed at grant time, so no refresh will ever succeed and only re-auth clears it.
   * It is the real cause of the 97-day "Active · Connected", and the shipped 400/401
   * gate did not catch it.
   */
  it('flags the MEASURED production 403 BAD_SCOPES', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(403, {
      status: 'BAD_SCOPES',
      message: 'missing or invalid scopes',
      correlationId: '01a0e8c7-03f9-7bae-836e-32f7555b0000',
    }));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1', 'hubspot', '245815183', { needs_reconnect: true });
  });

  it('still does NOT flag a 403 whose body says nothing about the grant', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(403, { status: 'RATE_LIMIT', message: 'slow down' }));

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });
});

/*
 * The flag must be an open door, not a one-way one.
 *
 * An earlier version short-circuited create() on needs_reconnect, so no refresh could ever
 * run and only a manual re-OAuth cleared it — meaning a single false positive bricked a
 * working integration for good. twitterService clears its flag on a successful refresh for
 * exactly this reason.
 */
describe('a flagged account heals itself when the grant works again', () => {
  it('still attempts the refresh instead of short-circuiting', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount({ needs_reconnect: true })] as never);
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'fresh', refresh_token: 'rotated', expires_in: 1800 },
    });

    await expect(HubSpotService.create('user-1')).resolves.toBeInstanceOf(HubSpotService);
    expect(mockAxiosPost).toHaveBeenCalled();
  });

  /*
   * The clear is guarded on the flag having been set, mirroring twitterService.forceRefresh.
   * Unconditional, it would write on EVERY refresh — every 30 minutes per HubSpot customer,
   * that being the access-token lifetime — and updateAccountConfig is a consistent read plus
   * a CAS write of the whole connected_accounts attribute. That doubles the write rate on
   * the attribute and raises the odds a concurrent updateAccountTokens loses its CAS twice
   * and fails closed with ConnectedAccountChanged.
   */
  it('does NOT write the config at all when refreshing an unflagged account', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'fresh', refresh_token: 'rotated', expires_in: 1800 },
    });

    await HubSpotService.create('user-1');
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    expect(mockUpdateAccountTokens).toHaveBeenCalled();
  });

  it('clears needs_reconnect once the refresh succeeds', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount({ needs_reconnect: true })] as never);
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'fresh', refresh_token: 'rotated', expires_in: 1800 },
    });

    await HubSpotService.create('user-1');
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1', 'hubspot', '245815183', { needs_reconnect: false });
  });

  it('leaves it flagged when the grant is still genuinely dead', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount({ needs_reconnect: true })] as never);
    mockAxiosPost.mockRejectedValue(httpError(400, { status: 'BAD_REFRESH_TOKEN' }));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1', 'hubspot', '245815183', { needs_reconnect: true });
    expect(mockUpdateAccountConfig).not.toHaveBeenCalledWith(
      'user-1', 'hubspot', '245815183', { needs_reconnect: false });
  });
});

/*
 * Credentials must never reach the log.
 *
 * Axios attaches the OUTGOING request to the error as `config.data`, and for the token
 * endpoint that body is
 *   grant_type=refresh_token&refresh_token=…&client_id=…&client_secret=…
 * so a bare `console.error(msg, refreshErr)` writes the app's HubSpot client secret and
 * the customer's refresh token into the application log. The first version of this code
 * did exactly that, and it was caught only because a live env2 run printed the secret to
 * a terminal. These cases pin the redaction on both the flagged and unflagged paths.
 */
describe('refresh-failure logging never carries credentials', () => {
  const SECRET = 'test-client-secret-DO-NOT-LOG';
  const REFRESH = 'na1-super-secret-refresh-token';

  /** The shape axios really produces: the request body hangs off `config`. */
  const axiosLikeError = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      config: {
        url: 'https://api.hubapi.com/oauth/v1/token',
        data: `grant_type=refresh_token&refresh_token=${REFRESH}&client_id=cid&client_secret=${SECRET}`,
      },
      response: { status, data },
    });

  let errSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); });

  const logged = () => [...errSpy.mock.calls, ...warnSpy.mock.calls]
    .flat()
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' | ');

  it('does not log the client secret or refresh token when flagging a revocation', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(axiosLikeError(400, BAD_REFRESH_BODY));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);

    const out = logged();
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(REFRESH);
    expect(out).not.toContain('client_secret');
    // and it still says something useful
    expect(out).toMatch(/status=400/);
  });

  it('does not log credentials on a transient failure either', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(axiosLikeError(503, 'upstream unavailable'));

    await expect(HubSpotService.create('user-1')).rejects.toThrow();

    const out = logged();
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(REFRESH);
    expect(out).toMatch(/status=503/);
  });

  it('caps an oversized body so a proxy HTML page cannot flood the log', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(axiosLikeError(502, '<html>' + 'x'.repeat(5000) + '</html>'));

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(logged()).toContain('truncated');
  });
});

/*
 * The mid-operation refresh path (token(), reached when a token expires DURING an
 * operation) threads `wasFlagged` just like create() does — and a review found that half
 * unpinned: zeroing it there left every test green. `doRefresh` also defaults the
 * parameter to `false`, the non-healing value, so an unverified call site silently stops
 * clearing the flag.
 */
describe('the mid-operation refresh path heals too', () => {
  const freshThenExpiring = (overrides: Record<string, unknown> = {}) => ({
    ...expiredAccount(overrides),
    config: {
      ...expiredAccount(overrides).config,
      // Valid when create() reads it, so create() returns WITHOUT refreshing; the
      // instance then refreshes mid-operation on first use.
      token_expires_at: Date.now() + 60 * 60 * 1000,
      ...overrides,
    },
  });

  it('clears needs_reconnect when the mid-operation refresh succeeds', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      freshThenExpiring({ needs_reconnect: true, token_expires_at: Date.now() - 1000 }),
    ] as never);
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'fresh', refresh_token: 'rotated', expires_in: 1800 },
    });

    await HubSpotService.create('user-1');

    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1', 'hubspot', '245815183', { needs_reconnect: false });
  });
});

/*
 * Redaction has to happen at the SOURCE, not at each log line.
 *
 * The first attempt sanitised the two console calls inside hubspotService and a review
 * showed that was not enough: the same AxiosError is rethrown to callers and logged whole
 * elsewhere — routes/hubspotAuth.ts on a failed code exchange, and routes/crmSync.ts,
 * whose `err.response?.data || err` falls through to the raw error when a network failure
 * leaves no response. The console spies in the suite above could never have caught those,
 * because they only watch calls made inside HubSpotService.
 *
 * So these assert on the ERROR OBJECT that escapes, which is what every downstream logger
 * actually receives.
 */
describe('the error that escapes carries no credentials', () => {
  const SECRET = 'escaping-client-secret';
  const REFRESH = 'na1-escaping-refresh-token';
  const withConfig = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      config: {
        url: 'https://api.hubapi.com/oauth/v1/token',
        data: `grant_type=refresh_token&refresh_token=${REFRESH}&client_id=cid&client_secret=${SECRET}`,
        headers: { Authorization: `Bearer ${REFRESH}` },
      },
      response: { status, data },
    });

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('scrubs the rethrown transient error, which callers log whole', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    const err = withConfig(503, 'upstream unavailable');
    mockAxiosPost.mockRejectedValue(err);

    // The transient path rethrows the ORIGINAL error — that object is what
    // routes/crmSync.ts prints when there is no response body to prefer.
    await expect(HubSpotService.create('user-1')).rejects.toThrow(/503/);

    const dumped = JSON.stringify({ msg: (err as any).message, config: (err as any).config });
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain(REFRESH);
  });

  it('scrubs the error even when the refresh is classified as a revocation', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    const err = withConfig(400, BAD_REFRESH_BODY);
    mockAxiosPost.mockRejectedValue(err);

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);

    const dumped = JSON.stringify({ config: (err as any).config });
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain(REFRESH);
  });

  it('keeps the response body, so the diagnostic survives redaction', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    const err = withConfig(400, { status: 'BAD_REFRESH_TOKEN', correlationId: 'corr-123' });
    mockAxiosPost.mockRejectedValue(err);

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    // Redaction must not cost the only signal that would ever reveal a wrong classifier.
    expect(JSON.stringify((err as any).response.data)).toContain('corr-123');
  });
});

/*
 * The invariant the marketing pre-flight in agentModeService rests on.
 *
 * That guard reads `svc.accountId` to know whether an OAuth grant or a pasted
 * private-app key served a call. `_portalId` sits one line below `_accountId` in the
 * same class and is the plausible wrong answer — and returning it would be SILENT in
 * production too, because /connect writes `account_id: String(hubInfo.hub_id)` and
 * `config.hub_id` from the same value, so the two agree on every row that flow creates.
 * They diverge only on a migrated or hand-made row: exactly the kind nobody tests with.
 *
 * The diagnostic suite cannot pin this — it mocks hubspotService wholesale. This suite
 * loads the real class, so it is the only place the invariant can be held.
 */
describe('accountId distinguishes the OAuth path from the pasted-token path', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('create() sets accountId to the ACCOUNT id, not the portal id', async () => {
    mockGetAccountsByUserId.mockResolvedValue([{
      ...expiredAccount(),
      account_id: 'acct-999',
      // Deliberately different from account_id so returning _portalId would be caught.
      config: { ...expiredAccount().config, hub_id: 111222, token_expires_at: Date.now() + 3600_000 },
    }] as never);

    const svc = await HubSpotService.create('user-1');
    expect(svc.accountId).toBe('acct-999');
    expect(svc.accountId).not.toBe(svc.portalId);
  });

  it('fromToken() leaves accountId undefined — that is how the fallback is recognised', () => {
    expect(HubSpotService.fromToken('pat-na1-some-key').accountId).toBeUndefined();
  });
});
