/**
 * ENG-2663 — a FreshTokenRejectedError thrown by the adapter must reach the model as a
 * retryable result (declared class rate_limit), never as the "reconnect" auth result,
 * through every real LinkedIn write handler.
 */
jest.mock('unipile-node-sdk', () => ({ UnipileClient: jest.fn().mockImplementation(() => ({})) }), { virtual: true });

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountsByUserIdIncludingOrgShared: jest.fn(),
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  getAccountById: jest.fn(),
  getAccountByIdConsistent: jest.fn(),
  isTokenValid: jest.fn(),
  SOCIAL_POSTING_PLATFORMS: ['twitter', 'linkedin', 'instagram', 'youtube'],
}));
jest.mock('../services/socialPlatformService', () => ({
  socialPlatformService: { getAdapter: jest.fn() },
}));

import { AgentModeService } from '../services/agentModeService';
import {
  getAccountById,
  getAccountByIdConsistent,
  getAccountsWithOwnerIncludingOrgShared,
} from '../services/connectedAccountsDb';
import { socialPlatformService } from '../services/socialPlatformService';
import { FreshTokenRejectedError } from '../services/adapters/linkedInAdapter';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { retryabilityLine } from '../services/agentMode/core/errorRetryability';

const ACCOUNT = {
  account_id: 'urn:li:person:abc123',
  account_name: 'Test User',
  platform: 'linkedin',
  config: { account_type: 'personal', access_token: 't', token_expires_at: Date.now() + 3600000 },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('ENG-2663 FreshTokenRejectedError through the real LinkedIn handlers', () => {
  let service: AgentModeService;
  const adapter = {
    createPost: jest.fn(),
    createRepost: jest.fn(),
    createComment: jest.fn(),
    createReaction: jest.fn(),
    getComments: jest.fn().mockResolvedValue([]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    service = new AgentModeService();
    (socialPlatformService.getAdapter as jest.Mock).mockReturnValue(adapter);
    (getAccountById as jest.Mock).mockResolvedValue(ACCOUNT);
    (getAccountByIdConsistent as jest.Mock).mockResolvedValue(ACCOUNT);
    (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([ACCOUNT]);
    adapter.getComments.mockResolvedValue([]);
  });

  const expectRetryableNotReconnect = (result: any) => {
    expect(result.success).toBe(false);
    expect(result.errorClass).toBe('rate_limit');
    expect(result.message).not.toMatch(/Account token expired|reconnect the account/i);
    const cls = classifyToolErrorClass(toolResultError(result)!);
    expect(cls).toBe('rate_limit');
    expect(retryabilityLine(cls)).toMatch(/^\[Retryable: yes/);
  };

  it('post_on_connected_account', async () => {
    adapter.createPost.mockRejectedValue(new FreshTokenRejectedError());
    expectRetryableNotReconnect(await service.postOnConnectedAccount('user-1', ACCOUNT.account_id, 'hello'));
  });

  it('linkedin repost', async () => {
    adapter.createRepost.mockRejectedValue(new FreshTokenRejectedError());
    expectRetryableNotReconnect(await service.linkedinRepost('user-1', ACCOUNT.account_id, 'urn:li:share:1'));
  });

  it('linkedin comment', async () => {
    adapter.createComment.mockRejectedValue(new FreshTokenRejectedError());
    expectRetryableNotReconnect(await service.commentOnLinkedInPost('user-1', ACCOUNT.account_id, 'urn:li:share:1', 'nice'));
  });

  it('linkedin react', async () => {
    adapter.createReaction.mockRejectedValue(new FreshTokenRejectedError());
    expectRetryableNotReconnect(await service.reactToLinkedInPost('user-1', ACCOUNT.account_id, 'urn:li:share:1', 'LIKE'));
  });

  it('repost and comment report an adapter-side consent stop as a failure, not success', async () => {
    adapter.createRepost.mockResolvedValue({ success: false, message: 'consent withdrawn' });
    adapter.createComment.mockResolvedValue({ success: false, message: 'consent withdrawn' });

    const repost: any = await service.linkedinRepost('user-1', ACCOUNT.account_id, 'urn:li:share:1');
    const comment: any = await service.commentOnLinkedInPost('user-1', ACCOUNT.account_id, 'urn:li:share:1', 'nice');

    expect(repost).toEqual({ success: false, message: 'consent withdrawn' });
    expect(comment).toEqual({ success: false, message: 'consent withdrawn' });
  });

  it('a genuine reconnect error still gets the auth treatment', async () => {
    adapter.createPost.mockRejectedValue(Object.assign(new Error('LinkedIn access token expired. Please reconnect your account.'), { code: 401 }));
    const result: any = await service.postOnConnectedAccount('user-1', ACCOUNT.account_id, 'hello');
    expect(result.message).toMatch(/Account token expired/);
    expect(result.errorClass).toBeUndefined();
    expect(classifyToolErrorClass(toolResultError(result)!)).toBe('auth');
  });
});
