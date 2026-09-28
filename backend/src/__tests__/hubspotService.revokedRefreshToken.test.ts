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

const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { status: 'BAD_REFRESH_TOKEN' } },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateAccountConfig.mockResolvedValue(undefined as never);
  mockUpdateAccountTokens.mockResolvedValue(undefined as never);
});

describe('HubSpot refresh-token revocation', () => {
  it('flags needs_reconnect when HubSpot rejects the refresh token with 400', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(400));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);

    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1',
      'hubspot',
      '245815183',
      { needs_reconnect: true }
    );
  });

  it('flags needs_reconnect on a 401 from the token endpoint', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(401));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'user-1',
      'hubspot',
      '245815183',
      { needs_reconnect: true }
    );
  });

  // The asymmetry that matters: persisting "dead" on a blip would break a live
  // integration and email a customer that it is broken. 5xx / network must not flag.
  it.each([
    ['a 500 from HubSpot', httpError(500)],
    ['a 503 from HubSpot', httpError(503)],
    ['a network error with no response', new Error('ECONNRESET')],
  ])('does NOT flag needs_reconnect on %s', async (_label, err) => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(err);

    await expect(HubSpotService.create('user-1')).rejects.toThrow();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('rethrows the original transient error rather than the reconnect message', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockRejectedValue(httpError(503));

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/status code 503/);
  });

  it('fails fast on an already-flagged account without calling HubSpot', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      expiredAccount({ needs_reconnect: true }),
    ] as never);

    await expect(HubSpotService.create('user-1')).rejects.toThrow(/needs to be reconnected/i);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('refreshes normally and flags nothing when HubSpot accepts the refresh token', async () => {
    mockGetAccountsByUserId.mockResolvedValue([expiredAccount()] as never);
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'fresh-token', refresh_token: 'rotated', expires_in: 1800 },
    });

    await expect(HubSpotService.create('user-1')).resolves.toBeInstanceOf(HubSpotService);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
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
