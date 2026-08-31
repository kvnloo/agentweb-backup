/**
 * Unit tests for ensureAttioWebhook() — per-account webhook registration
 * (ENG-1380). Mirrors the Calendly per-account registration pattern, not
 * HubSpot's app-wide diffing loop: idempotent (no-ops if already
 * registered), persists webhook_id/webhook_signing_key on success, flags
 * needs_reconnect on a 403 (missing scope), never throws.
 */

const mockGetAccountById = jest.fn();
const mockUpdateAccountConfig = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountById: (...a: any[]) => mockGetAccountById(...a),
  updateAccountConfig: (...a: any[]) => mockUpdateAccountConfig(...a),
}));

const mockRegisterWebhook = jest.fn();
const mockAttioServiceCreate = jest.fn();
jest.mock('../services/attioService', () => ({
  AttioService: {
    create: (...a: any[]) => mockAttioServiceCreate(...a),
  },
}));

import { ensureAttioWebhook } from '../utils/attioWebhookSubscription';

const baseAccount = (overrides: Record<string, any> = {}) => ({
  platform: 'attio',
  account_id: 'acct-1',
  account_name: 'Test Workspace',
  config: {
    account_type: 'oauth',
    access_token: 'tok',
    token_expires_at: 9999999999999,
    workspace_id: 'ws-1',
    workspace_name: 'Test Workspace',
    ...overrides,
  },
});

const originalBackendUrl = process.env.BACKEND_URL;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BACKEND_URL = 'https://backend.example.com';
  mockUpdateAccountConfig.mockResolvedValue(undefined);
  mockAttioServiceCreate.mockResolvedValue({
    registerWebhook: (...a: any[]) => mockRegisterWebhook(...a),
  });
});

afterAll(() => {
  process.env.BACKEND_URL = originalBackendUrl;
});

describe('ensureAttioWebhook', () => {
  it('no-ops when the account is not found', async () => {
    mockGetAccountById.mockResolvedValue(null);
    await ensureAttioWebhook('user-1', 'acct-1');
    expect(mockAttioServiceCreate).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('no-ops when the account is not an attio account', async () => {
    mockGetAccountById.mockResolvedValue({ ...baseAccount(), platform: 'hubspot' });
    await ensureAttioWebhook('user-1', 'acct-1');
    expect(mockAttioServiceCreate).not.toHaveBeenCalled();
  });

  it('is idempotent — no-ops when webhook_id is already set', async () => {
    mockGetAccountById.mockResolvedValue(baseAccount({ webhook_id: 'wh_existing' }));
    await ensureAttioWebhook('user-1', 'acct-1');
    expect(mockAttioServiceCreate).not.toHaveBeenCalled();
    expect(mockRegisterWebhook).not.toHaveBeenCalled();
  });

  it('skips registration when BACKEND_URL is unset, rather than persisting an unusable localhost webhook', async () => {
    delete process.env.BACKEND_URL;
    mockGetAccountById.mockResolvedValue(baseAccount());
    await ensureAttioWebhook('user-1', 'acct-1');
    // Registering localhost would still persist webhook_id, and the
    // idempotency guard would then permanently no-op every later retry.
    expect(mockAttioServiceCreate).not.toHaveBeenCalled();
    expect(mockRegisterWebhook).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('registers a webhook and persists webhook_id + secret on success', async () => {
    mockGetAccountById.mockResolvedValue(baseAccount());
    mockRegisterWebhook.mockResolvedValue({ webhookId: 'wh_new', secret: 'sig_secret_abc' });

    await ensureAttioWebhook('user-1', 'acct-1');

    expect(mockAttioServiceCreate).toHaveBeenCalledWith('user-1', 'acct-1');
    expect(mockRegisterWebhook).toHaveBeenCalledWith(expect.stringContaining('/api/webhooks/attio'));
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith('user-1', 'attio', 'acct-1', {
      webhook_id: 'wh_new',
      webhook_signing_key: 'sig_secret_abc',
    });
  });

  it('does not persist anything when registerWebhook returns an unexpected shape', async () => {
    mockGetAccountById.mockResolvedValue(baseAccount());
    mockRegisterWebhook.mockResolvedValue({ webhookId: undefined, secret: undefined });

    await ensureAttioWebhook('user-1', 'acct-1');

    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  // Regression: without this guard, every config save re-attempted
  // registration for an already-flagged account and silently re-403'd
  // forever until the user reconnected (which clears the flag).
  it('does not retry registration once already flagged needs_reconnect', async () => {
    mockGetAccountById.mockResolvedValue(baseAccount({ needs_reconnect: true }));
    await ensureAttioWebhook('user-1', 'acct-1');
    expect(mockAttioServiceCreate).not.toHaveBeenCalled();
    expect(mockRegisterWebhook).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('flags needs_reconnect on a 403 (missing webhook:read-write scope)', async () => {
    mockGetAccountById.mockResolvedValue(baseAccount());
    mockRegisterWebhook.mockRejectedValue({ response: { status: 403, data: { message: 'insufficient scope' } } });

    await ensureAttioWebhook('user-1', 'acct-1');

    expect(mockUpdateAccountConfig).toHaveBeenCalledWith('user-1', 'attio', 'acct-1', { needs_reconnect: true });
  });

  it('never throws on an unexpected registration failure', async () => {
    mockGetAccountById.mockResolvedValue(baseAccount());
    mockRegisterWebhook.mockRejectedValue(new Error('network error'));

    await expect(ensureAttioWebhook('user-1', 'acct-1')).resolves.toBeUndefined();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });
});
