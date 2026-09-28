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
    ['invalid_client (a bad shared clientSecret)', { status: 'BAD_CLIENT_CREDENTIALS', message: 'authentication credentials not valid' }],
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
    ['a bad client secret', { status: 'BAD_CLIENT_CREDENTIALS', message: 'authentication credentials not valid' }],
    ['a malformed request', { status: 'BAD_REQUEST', message: 'missing grant_type' }],
    ['a null body', null],
    ['an unrelated string body', 'Bad Request'],
  ])('does NOT flag needs_reconnect on a 400 from %s', async (_label, body) => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(400, body));

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['BAD_REFRESH_TOKEN', { status: 'BAD_REFRESH_TOKEN' }],
    ['invalid_grant', { error: 'invalid_grant', error_description: 'refresh token expired' }],
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

  // Statuses either side of the 400/401 pair, so the boundary itself is pinned.
  it.each([[403], [404], [429]])('does NOT flag on a %i', async (status) => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(status, BAD_REFRESH_BODY));

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
