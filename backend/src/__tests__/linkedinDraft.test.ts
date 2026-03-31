/**
 * Unit tests for LinkedIn "save as draft" feature
 * Tests that createPost() correctly uses lifecycleState: 'DRAFT' vs 'PUBLISHED'
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

// --- Adapter-layer tests ---
// Mock linkedInService so we can inspect what args the adapter passes through.

jest.mock('../services/linkedInService', () => ({
  linkedInService: {
    createPost: jest.fn(),
    uploadImageFromUrl: jest.fn(),
    refreshAccessToken: jest.fn(),
  },
  LinkedInService: jest.fn(),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn(),
  getAccountById: jest.fn(),
}));

jest.mock('../services/linkedInPostsDb', () => ({
  createPost: jest.fn(),
}));

jest.mock('../config/integrations', () => ({
  getLinkedInConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
  }),
}));

import { linkedInService } from '../services/linkedInService';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';

const mockLinkedInService = linkedInService as jest.Mocked<typeof linkedInService>;

function makeAccount(accountType: 'personal' | 'company_page'): ConnectedAccount {
  return {
    account_id: 'urn:li:person:test123',
    account_name: 'Test User',
    platform: 'linkedin',
    config: {
      account_type: accountType,
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      token_expires_at: Date.now() + 3600 * 1000,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as ConnectedAccount;
}

describe('LinkedIn draft feature — LinkedInAdapter', () => {
  let adapter: LinkedInAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new LinkedInAdapter();
    mockLinkedInService.createPost.mockResolvedValue('urn:li:share:test456');
  });

  it('passes saveAsDraft: true to linkedInService.createPost', async () => {
    const account = makeAccount('personal');

    await adapter.createPost(account, 'My draft post', undefined, 'user-1', true);

    expect(mockLinkedInService.createPost).toHaveBeenCalledWith(
      'test-token',
      'urn:li:person:test123',
      'My draft post',
      undefined,
      true
    );
  });

  it('passes no saveAsDraft arg when not specified (publish by default)', async () => {
    const account = makeAccount('personal');

    await adapter.createPost(account, 'My published post', undefined, 'user-1');

    const callArgs = mockLinkedInService.createPost.mock.calls[0];
    // 5th arg should be falsy (undefined or false)
    expect(callArgs[4]).toBeFalsy();
  });

  it('returns draft-specific success message for personal account', async () => {
    const account = makeAccount('personal');

    const result = await adapter.createPost(account, 'My draft', undefined, 'user-1', true);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/draft/i);
    expect(result.postUrl).toContain('linkedin.com');
  });

  it('returns draft-specific success message for company page account', async () => {
    const account = makeAccount('company_page');

    const result = await adapter.createPost(account, 'Company draft', undefined, 'user-1', true);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/draft/i);
  });

  it('does NOT store draft in DB for personal account', async () => {
    const account = makeAccount('personal');
    const { createPost: storePost } = await import('../services/linkedInPostsDb');

    await adapter.createPost(account, 'My draft', undefined, 'user-1', true);

    expect(storePost).not.toHaveBeenCalled();
  });

  it('stores published post in DB as normal for personal account', async () => {
    const account = makeAccount('personal');
    const { createPost: storePost } = await import('../services/linkedInPostsDb');

    await adapter.createPost(account, 'Published post', undefined, 'user-1', false);

    expect(storePost).toHaveBeenCalled();
  });
});

// --- Service-layer tests ---
// Test linkedInService.createPost() directly using a mock axios client.

describe('LinkedIn draft feature — LinkedInService.createPost lifecycleState', () => {
  let mockAxiosPost: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosPost = jest.fn().mockResolvedValue({
      headers: { 'x-restli-id': 'urn:li:share:999' },
      data: {},
    });

    // Replace the axios client on the singleton
    (linkedInService as any).client = { post: mockAxiosPost, get: jest.fn() };
  });

  it('sends lifecycleState DRAFT when saveAsDraft is true', async () => {
    // Import the real LinkedInService class (mocked constructor, but we test the singleton)
    const { LinkedInService } = jest.requireActual('../services/linkedInService') as any;
    const svc = new LinkedInService();
    (svc as any).client = { post: mockAxiosPost, get: jest.fn() };

    await svc.createPost('token', 'urn:li:person:abc', 'Hello draft', undefined, true);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      '/rest/posts',
      expect.objectContaining({ lifecycleState: 'DRAFT' }),
      expect.anything()
    );
  });

  it('sends lifecycleState PUBLISHED when saveAsDraft is false', async () => {
    const { LinkedInService } = jest.requireActual('../services/linkedInService') as any;
    const svc = new LinkedInService();
    (svc as any).client = { post: mockAxiosPost, get: jest.fn() };

    await svc.createPost('token', 'urn:li:person:abc', 'Hello published', undefined, false);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      '/rest/posts',
      expect.objectContaining({ lifecycleState: 'PUBLISHED' }),
      expect.anything()
    );
  });

  it('defaults to lifecycleState PUBLISHED when saveAsDraft is omitted', async () => {
    const { LinkedInService } = jest.requireActual('../services/linkedInService') as any;
    const svc = new LinkedInService();
    (svc as any).client = { post: mockAxiosPost, get: jest.fn() };

    await svc.createPost('token', 'urn:li:person:abc', 'Hello default');

    expect(mockAxiosPost).toHaveBeenCalledWith(
      '/rest/posts',
      expect.objectContaining({ lifecycleState: 'PUBLISHED' }),
      expect.anything()
    );
  });
});
