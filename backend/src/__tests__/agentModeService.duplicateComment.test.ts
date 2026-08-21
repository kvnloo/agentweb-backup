/**
 * Tests for duplicate LinkedIn comment prevention (Option 3: check existing comments before posting)
 * Verifies that commentOnLinkedInPost skips posting when the actor already has a comment on the post.
 */

jest.mock('unipile-node-sdk', () => ({ UnipileClient: jest.fn().mockImplementation(() => ({})) }), { virtual: true });
jest.mock('../utils/secretsManager', () => ({
  getJwtSecret: jest.fn().mockResolvedValue('test-jwt-secret'),
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'test-key' }),
}));
jest.mock('../services/db', () => ({
  crmDb: {},
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
}));

const mockGetAccountById = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountById: (...args: any[]) => mockGetAccountById(...args),
  getAccountByIdConsistent: (...args: any[]) => mockGetAccountById(...args),
}));

const mockCreateComment = jest.fn();
const mockGetComments = jest.fn();
jest.mock('../services/socialPlatformService', () => ({
  socialPlatformService: {
    getAdapter: jest.fn().mockReturnValue({
      createComment: (...args: any[]) => mockCreateComment(...args),
      getComments: (...args: any[]) => mockGetComments(...args),
    }),
  },
}));

import { AgentModeService } from '../services/agentModeService';

const ACTOR_URN = 'urn:li:person:abc123';
const POST_URN = 'urn:li:ugcPost:987654321';
const ACCOUNT = {
  id: 'acc-1',
  account_id: ACTOR_URN,
  platform: 'linkedin',
  account_name: 'Test User',
};

describe('AgentModeService - duplicate LinkedIn comment prevention', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    mockGetAccountById.mockResolvedValue(ACCOUNT);
  });

  it('posts comment when actor has no existing comment on the post', async () => {
    mockGetComments.mockResolvedValue([
      { commentUrn: 'urn:li:comment:1', actorUrn: 'urn:li:person:other', text: 'other comment', createdAt: 0 },
    ]);
    mockCreateComment.mockResolvedValue({ success: true, message: 'Comment posted', postId: 'urn:li:comment:new', postUrl: 'https://linkedin.com/post' });

    const result = await service.commentOnLinkedInPost('user-1', 'acc-1', POST_URN, 'My great comment');

    expect(mockGetComments).toHaveBeenCalledTimes(1);
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.already_commented).toBeUndefined();
  });

  it('skips posting and returns already_commented=true when actor already commented on the post', async () => {
    mockGetComments.mockResolvedValue([
      { commentUrn: 'urn:li:comment:existing', actorUrn: ACTOR_URN, text: 'already posted', createdAt: 1000 },
    ]);

    const result = await service.commentOnLinkedInPost('user-1', 'acc-1', POST_URN, 'Duplicate comment');

    expect(mockGetComments).toHaveBeenCalledTimes(1);
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.already_commented).toBe(true);
    expect(result.message).toMatch(/already commented/i);
  });

  it('proceeds with posting when getComments fails (fail-open)', async () => {
    mockGetComments.mockRejectedValue(new Error('LinkedIn API timeout'));
    mockCreateComment.mockResolvedValue({ success: true, message: 'Comment posted', postId: 'urn:li:comment:new', postUrl: 'https://linkedin.com/post' });

    const result = await service.commentOnLinkedInPost('user-1', 'acc-1', POST_URN, 'Fallback comment');

    expect(mockGetComments).toHaveBeenCalledTimes(1);
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.already_commented).toBeUndefined();
  });

  it('returns error when account is not found', async () => {
    mockGetAccountById.mockResolvedValue(null);

    const result = await service.commentOnLinkedInPost('user-1', 'acc-missing', POST_URN, 'Some comment');

    expect(mockGetComments).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it('returns error when comment_text is empty', async () => {
    const result = await service.commentOnLinkedInPost('user-1', 'acc-1', POST_URN, '   ');

    expect(mockGetComments).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/comment_text is required/i);
  });
});
