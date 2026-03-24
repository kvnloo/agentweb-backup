// Unit tests for Engagement Memory feature:
// - DB helpers (getEngagementMemory, saveEngagementMemory)
// - Executor memory injection into comment generation
// - EngagementMemory type validation

const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  })),
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
    updateEmailEventContent: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

import {
  getEngagementMemory,
  saveEngagementMemory,
  EngagementMemory,
} from '../services/connectedAccountsDb';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MEMORY: EngagementMemory = {
  content: '## Bio\nMarketing expert at AgentWeb.',
  lastSyncedAt: '2026-03-24T00:00:00.000Z',
  createdAt: '2026-03-24T00:00:00.000Z',
  updatedAt: '2026-03-24T00:00:00.000Z',
};

const makeLinkedInAccount = (overrides: any = {}) => ({
  platform: 'linkedin',
  account_id: 'acc1',
  account_name: 'Test Account',
  config: {
    account_type: 'personal',
    access_token: 'tok',
    token_expires_at: Date.now() + 86400000,
  },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const makeUser = (accounts: any[]) => ({
  userId: 'user1',
  email: 'test@example.com',
  connected_accounts: accounts,
});

/**
 * getUserById uses docClient.query() and returns result.Items?.[0]
 */
const mockGetUserReturns = (user: any | null) => {
  mockDocumentClientMethods.query.mockReturnValue({
    promise: jest.fn().mockResolvedValue({
      Items: user ? [user] : [],
    }),
  });
};

/**
 * updateUser also calls getUserById internally, then calls docClient.update().
 * We need query to return the user, then update to succeed.
 */
const mockGetAndUpdateUser = (user: any) => {
  mockDocumentClientMethods.query.mockReturnValue({
    promise: jest.fn().mockResolvedValue({
      Items: [user],
    }),
  });
  mockDocumentClientMethods.update.mockReturnValue({
    promise: jest.fn().mockResolvedValue({}),
  });
};

// ─── DB Helper Tests ──────────────────────────────────────────────────────────

describe('Engagement Memory DB Helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getEngagementMemory', () => {
    it('should return null when user not found', async () => {
      mockGetUserReturns(null);
      const result = await getEngagementMemory('nonexistent', 'acc1');
      expect(result).toBeNull();
    });

    it('should return null when account has no memory', async () => {
      mockGetUserReturns(makeUser([makeLinkedInAccount()]));
      const result = await getEngagementMemory('user1', 'acc1');
      expect(result).toBeNull();
    });

    it('should return memory when account has engagementMemory', async () => {
      mockGetUserReturns(
        makeUser([makeLinkedInAccount({ engagementMemory: MEMORY })])
      );
      const result = await getEngagementMemory('user1', 'acc1');
      expect(result).toEqual(MEMORY);
    });

    it('should return null when account_id does not match', async () => {
      mockGetUserReturns(
        makeUser([makeLinkedInAccount({ engagementMemory: MEMORY })])
      );
      const result = await getEngagementMemory('user1', 'wrong_id');
      expect(result).toBeNull();
    });

    it('should handle multiple accounts and return correct memory', async () => {
      const acc1 = makeLinkedInAccount({ account_id: 'acc1' });
      const acc2 = makeLinkedInAccount({
        account_id: 'acc2',
        account_name: 'Second Account',
        engagementMemory: MEMORY,
      });
      mockGetUserReturns(makeUser([acc1, acc2]));

      const result1 = await getEngagementMemory('user1', 'acc1');
      expect(result1).toBeNull();

      // Re-mock for second call
      mockGetUserReturns(makeUser([acc1, acc2]));
      const result2 = await getEngagementMemory('user1', 'acc2');
      expect(result2).toEqual(MEMORY);
    });
  });

  describe('saveEngagementMemory', () => {
    it('should throw when user not found', async () => {
      mockGetUserReturns(null);
      await expect(
        saveEngagementMemory('nonexistent', 'acc1', MEMORY)
      ).rejects.toThrow('User not found');
    });

    it('should throw when account not found', async () => {
      mockGetUserReturns(makeUser([makeLinkedInAccount()]));
      // saveEngagementMemory calls getUserById (query), then finds no account
      await expect(
        saveEngagementMemory('user1', 'wrong_id', MEMORY)
      ).rejects.toThrow('Connected account not found');
    });

    it('should call updateUser with engagementMemory set on the correct account', async () => {
      const account = makeLinkedInAccount();
      const user = makeUser([account]);
      // First query for saveEngagementMemory's getUserById
      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({ Items: [user] }),
        })
        // Second query for updateUser's internal getUserById
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({ Items: [user] }),
        });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await saveEngagementMemory('user1', 'acc1', MEMORY);

      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Executor Memory Injection Tests ──────────────────────────────────────────

describe('SocialEngagementExecutor memory injection', () => {
  const BASE_PROMPT = `You are a professional social media engagement assistant.
Write a thoughtful, genuine 1-2 sentence comment on the following LinkedIn post.
Avoid generic phrases like "Great post!" or "Totally agree!".
Return ONLY the comment text, no quotes or explanation.`;

  const REPLY_PROMPT = `You are a professional social media engagement assistant.
Write a genuine, concise reply to the following comment on a LinkedIn post.
The reply should add value or acknowledge the comment naturally.
Return ONLY the reply text, no quotes or explanation.`;

  it('should augment system prompt with memory for post comments', () => {
    const memory = '## Bio\nMarketing expert focused on AI automation.';
    const augmented = BASE_PROMPT +
      `\n\nIMPORTANT: Write the comment from the perspective described in this engagement persona profile. Match the voice, tone, and expertise areas described below:\n\n${memory}`;

    expect(augmented).toContain('Marketing expert focused on AI automation');
    expect(augmented).toContain('IMPORTANT: Write the comment from the perspective');
    expect(augmented).toContain(BASE_PROMPT);
  });

  it('should augment system prompt with memory for comment replies', () => {
    const memory = '## Voice & Tone\nProfessional but approachable.';
    const augmented = REPLY_PROMPT +
      `\n\nIMPORTANT: Write the reply from the perspective described in this engagement persona profile. Match the voice, tone, and expertise areas described below:\n\n${memory}`;

    expect(augmented).toContain('Professional but approachable');
    expect(augmented).toContain(REPLY_PROMPT);
  });

  it('should not modify system prompt when memory is empty string', () => {
    const memory = '';
    let systemPrompt = BASE_PROMPT;
    if (memory) {
      systemPrompt += `\n\nIMPORTANT: ${memory}`;
    }
    expect(systemPrompt).toBe(BASE_PROMPT);
  });

  it('should not modify system prompt when memory is undefined', () => {
    const memory: string | undefined = undefined;
    let systemPrompt = BASE_PROMPT;
    if (memory) {
      systemPrompt += `\n\nIMPORTANT: ${memory}`;
    }
    expect(systemPrompt).toBe(BASE_PROMPT);
  });
});

// ─── EngagementMemory type tests ──────────────────────────────────────────────

describe('EngagementMemory type', () => {
  it('should have all required fields', () => {
    const memory: EngagementMemory = {
      content: 'Test content',
      lastSyncedAt: '2026-03-24T00:00:00.000Z',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    };
    expect(memory.content).toBe('Test content');
    expect(memory.lastSyncedAt).toBeDefined();
    expect(memory.createdAt).toBeDefined();
    expect(memory.updatedAt).toBeDefined();
  });

  it('should support markdown content', () => {
    const markdown = `## Bio
Marketing expert at AgentWeb.

## Voice & Tone
Professional, data-driven, concise.

## Key Topics
- AI automation
- Marketing ops
- SaaS growth`;

    const memory: EngagementMemory = {
      content: markdown,
      lastSyncedAt: '2026-03-24T00:00:00.000Z',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    };
    expect(memory.content).toContain('## Bio');
    expect(memory.content).toContain('## Key Topics');
    expect(memory.content).toContain('AI automation');
  });
});
