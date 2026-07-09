import {
  buildFathomOnboardingMemoryContent,
  ingestFathomOnboardingRecording,
  matchFathomOnboardingTarget,
} from '../services/fathomOnboardingIngestionService';

const baseContext = {
  companyName: 'Acme AI',
  primaryContactName: 'Jane Buyer',
  primaryContactEmail: 'jane@acme.ai',
  website: 'https://acme.ai',
  productCategory: 'AI sales assistant',
  icp: 'Seed-stage B2B SaaS founders',
  primaryGtmGoal: 'Book more qualified demos',
  relevantChannels: ['LinkedIn', 'email', 'landing pages'],
  winMetric: '10 qualified demos in 30 days',
  urgency: 'Start this month',
  setupBlockers: ['No outbound domain configured'],
  productFitNotes: ['Strong founder-led sales fit'],
  featureGapsOrRisks: ['Needs CRM import before launch'],
  suggestedFirstWinPath: 'Import CRM, launch founder-led LinkedIn follow-up, then test a dedicated landing page.',
  competitorsOrToolsMentioned: ['HubSpot'],
  budgetOrPricingSensitivity: 'Budget conscious',
  stakeholders: ['Jane Buyer'],
  trialOrPaymentStage: 'Prospect',
  followUpCommitments: ['Send onboarding plan'],
  confidenceByField: {
    companyName: 0.95,
    primaryContactEmail: 0.99,
  },
  sourceReferences: [
    { label: 'Fathom recording', url: 'https://fathom.video/calls/123?timestamp=60', timestampSeconds: 60 },
  ],
};

const makeDeps = (overrides: Record<string, any> = {}) => {
  const userDb = {
    getUserById: jest.fn(async (userId: string) => {
      if (userId === 'target-user') {
        return {
          userId,
          email: 'owner@acme.ai',
          emailDomain: 'acme.ai',
          orgId: 'org-1',
          fathomOnboardingIngestions: [],
        };
      }
      if (userId === 'review-owner') {
        return {
          userId,
          email: 'harsha@agentweb.pro',
          fathomOnboardingIngestions: [],
        };
      }
      return null;
    }),
    getUserByEmail: jest.fn(async (email: string) => (
      email === 'jane@acme.ai'
        ? { userId: 'target-user', email, emailDomain: 'acme.ai', orgId: 'org-1' }
        : null
    )),
    getUsersByEmailDomain: jest.fn(async (domain: string) => (
      domain === 'acme.ai'
        ? [{ userId: 'target-user', email: 'owner@acme.ai', emailDomain: domain, orgId: 'org-1' }]
        : []
    )),
    updateUser: jest.fn(async (_userId: string, updates: Record<string, any>) => updates),
  };

  return {
    userDb,
    crmDb: {
      findLeadsByEmail: jest.fn(async () => []),
    },
    accountMemoryDb: {
      addMemory: jest.fn(async (userId: string) => ({ userId, memoryId: 'mem-1' })),
    },
    orgMemoryDb: {
      addMemory: jest.fn(async (orgId: string) => ({ orgId, memoryId: 'org-mem-1' })),
    },
    llm: {
      generateJsonRobust: jest.fn(async () => baseContext),
    },
    now: jest.fn(() => '2026-07-08T20:00:00.000Z'),
    ...overrides,
  };
};

describe('fathomOnboardingIngestionService', () => {
  it('extracts structured onboarding context with the required minimum fields', async () => {
    const deps = makeDeps();

    const result = await ingestFathomOnboardingRecording({
      recordingId: '123',
      recordingUrl: 'https://fathom.video/calls/123',
      reviewOwnerUserId: 'review-owner',
      transcriptText: 'Jane at Acme AI needs more qualified demos from LinkedIn and email.',
    }, deps as any);

    expect(deps.llm.generateJsonRobust).toHaveBeenCalledTimes(1);
    expect(result.context.companyName).toBe('Acme AI');
    expect(result.context.primaryContactEmail).toBe('jane@acme.ai');
    expect(result.context.relevantChannels).toEqual(['LinkedIn', 'email', 'landing pages']);
    expect(result.context.sourceReferences?.[0].url).toContain('fathom.video');
  });

  it('derives the canonical recording id from a Fathom calls URL instead of storing the URL as the id', async () => {
    const deps = makeDeps();

    const result = await ingestFathomOnboardingRecording({
      recordingUrl: 'https://fathom.video/calls/123?timestamp=60',
      reviewOwnerUserId: 'review-owner',
      extractedContext: baseContext,
    }, deps as any);

    expect(result.recordingId).toBe('123');
    expect(deps.userDb.updateUser).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({
        fathomOnboardingIngestions: [
          expect.objectContaining({
            recordingId: '123',
            recordingUrl: 'https://fathom.video/calls/123?timestamp=60',
          }),
        ],
      }),
    );
  });

  it('matches cautiously by exact contact email before domain', async () => {
    const deps = makeDeps();

    const match = await matchFathomOnboardingTarget(baseContext, deps as any);

    expect(match).toEqual({
      status: 'matched',
      confidence: 'high',
      reason: 'exact_email',
      userId: 'target-user',
      lead: null,
    });
    expect(deps.userDb.getUserByEmail).toHaveBeenCalledWith('jane@acme.ai');
    expect(deps.userDb.getUsersByEmailDomain).not.toHaveBeenCalled();
  });

  it('lands ambiguous recordings in review instead of creating or writing account memory', async () => {
    const deps = makeDeps({
      userDb: {
        getUserById: jest.fn(async () => ({ userId: 'review-owner', email: 'harsha@agentweb.pro' })),
        getUserByEmail: jest.fn(async () => null),
        getUsersByEmailDomain: jest.fn(async () => []),
        updateUser: jest.fn(async (_userId: string, updates: Record<string, any>) => updates),
      },
    });

    const result = await ingestFathomOnboardingRecording({
      recordingId: 'ambiguous-1',
      recordingUrl: 'https://fathom.video/calls/ambiguous-1',
      reviewOwnerUserId: 'review-owner',
      extractedContext: { ...baseContext, primaryContactEmail: '', website: '', companyName: 'Ambiguous Co' },
    }, deps as any);

    expect(result.status).toBe('needs_review');
    expect(result.target.userId).toBeNull();
    expect(deps.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    expect(deps.userDb.updateUser).toHaveBeenCalledWith(
      'review-owner',
      expect.objectContaining({
        fathomOnboardingIngestions: [
          expect.objectContaining({ recordingId: 'ambiguous-1', status: 'needs_review' }),
        ],
      }),
    );
  });

  it('persists reviewed context to account and org memory and keeps auto-extracted vs reviewed state visible', async () => {
    const deps = makeDeps();

    const result = await ingestFathomOnboardingRecording({
      recordingId: '123',
      recordingUrl: 'https://fathom.video/calls/123',
      reviewOwnerUserId: 'review-owner',
      targetUserId: 'target-user',
      reviewed: true,
      extractedContext: baseContext,
    }, deps as any);

    expect(result.status).toBe('reviewed');
    expect(deps.accountMemoryDb.addMemory).toHaveBeenCalledWith(
      'target-user',
      'insight',
      expect.stringContaining('Fathom-derived onboarding context'),
      undefined,
      undefined,
    );
    expect(deps.orgMemoryDb.addMemory).toHaveBeenCalledWith(
      'org-1',
      'insight',
      expect.stringContaining('Acme AI'),
      'review-owner',
      undefined,
    );
    expect(deps.userDb.updateUser).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({
        fathomOnboardingIngestions: [
          expect.objectContaining({
            extractionState: 'human_reviewed',
            memoryIds: ['mem-1'],
            orgMemoryIds: ['org-mem-1'],
          }),
        ],
      }),
    );
  });

  it('reprocessing the same recording updates the ledger instead of duplicating memory entries', async () => {
    const deps = makeDeps();
    deps.userDb.getUserById.mockImplementation(async (userId: string): Promise<any> => ({
      userId,
      email: userId === 'target-user' ? 'owner@acme.ai' : 'harsha@agentweb.pro',
      emailDomain: userId === 'target-user' ? 'acme.ai' : 'agentweb.pro',
      orgId: userId === 'target-user' ? 'org-1' : undefined,
      fathomOnboardingIngestions: userId === 'target-user'
        ? [{
          recordingId: '123',
          recordingUrl: 'https://fathom.video/calls/123',
          status: 'reviewed',
          extractionState: 'human_reviewed',
          context: baseContext,
          memoryIds: ['mem-existing'],
          orgMemoryIds: ['org-existing'],
          createdAt: '2026-07-08T19:00:00.000Z',
          updatedAt: '2026-07-08T19:00:00.000Z',
        }]
        : [],
    }));

    const result = await ingestFathomOnboardingRecording({
      recordingId: '123',
      recordingUrl: 'https://fathom.video/calls/123',
      reviewOwnerUserId: 'review-owner',
      targetUserId: 'target-user',
      reviewed: true,
      extractedContext: baseContext,
    }, deps as any);

    expect(result.memoryIds).toEqual(['mem-existing']);
    expect(deps.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    const updatedLedger = deps.userDb.updateUser.mock.calls[0][1].fathomOnboardingIngestions;
    expect(updatedLedger).toHaveLength(1);
    expect(updatedLedger[0].createdAt).toBe('2026-07-08T19:00:00.000Z');
    expect(updatedLedger[0].updatedAt).toBe('2026-07-08T20:00:00.000Z');
  });

  it('folds legacy URL-keyed ledger entries into the canonical recording id when the same recording is reprocessed', async () => {
    const deps = makeDeps();
    deps.userDb.getUserById.mockImplementation(async (userId: string): Promise<any> => ({
      userId,
      email: userId === 'target-user' ? 'owner@acme.ai' : 'harsha@agentweb.pro',
      emailDomain: userId === 'target-user' ? 'acme.ai' : 'agentweb.pro',
      orgId: userId === 'target-user' ? 'org-1' : undefined,
      fathomOnboardingIngestions: userId === 'target-user'
        ? [{
          recordingId: 'https://fathom.video/calls/123',
          recordingUrl: 'https://fathom.video/calls/123',
          status: 'reviewed',
          extractionState: 'human_reviewed',
          context: baseContext,
          memoryIds: ['mem-existing'],
          orgMemoryIds: ['org-existing'],
          createdAt: '2026-07-08T19:00:00.000Z',
          updatedAt: '2026-07-08T19:00:00.000Z',
        }]
        : [],
    }));

    const result = await ingestFathomOnboardingRecording({
      recordingId: '123',
      recordingUrl: 'https://fathom.video/calls/123',
      reviewOwnerUserId: 'review-owner',
      targetUserId: 'target-user',
      reviewed: true,
      extractedContext: baseContext,
    }, deps as any);

    expect(result.memoryIds).toEqual(['mem-existing']);
    expect(deps.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    const updatedLedger = deps.userDb.updateUser.mock.calls[0][1].fathomOnboardingIngestions;
    expect(updatedLedger).toHaveLength(1);
    expect(updatedLedger[0]).toMatchObject({
      recordingId: '123',
      recordingUrl: 'https://fathom.video/calls/123',
      memoryIds: ['mem-existing'],
      orgMemoryIds: ['org-existing'],
    });
  });

  it('removes the stale review-owner queue entry when an ambiguous recording is promoted to a target user', async () => {
    const deps = makeDeps();
    deps.userDb.getUserById.mockImplementation(async (userId: string): Promise<any> => ({
      userId,
      email: userId === 'target-user' ? 'owner@acme.ai' : 'harsha@agentweb.pro',
      emailDomain: userId === 'target-user' ? 'acme.ai' : 'agentweb.pro',
      orgId: userId === 'target-user' ? 'org-1' : undefined,
      fathomOnboardingIngestions: userId === 'review-owner'
        ? [
          {
            recordingId: '123',
            recordingUrl: 'https://fathom.video/calls/123',
            status: 'needs_review',
            extractionState: 'auto_extracted',
            context: baseContext,
            memoryIds: [],
            orgMemoryIds: [],
            createdAt: '2026-07-08T19:00:00.000Z',
            updatedAt: '2026-07-08T19:00:00.000Z',
          },
          {
            recordingId: 'keep-me',
            recordingUrl: 'https://fathom.video/calls/keep-me',
            status: 'needs_review',
            extractionState: 'auto_extracted',
            context: baseContext,
            memoryIds: [],
            orgMemoryIds: [],
            createdAt: '2026-07-08T19:10:00.000Z',
            updatedAt: '2026-07-08T19:10:00.000Z',
          },
        ]
        : [],
    }));

    const result = await ingestFathomOnboardingRecording({
      recordingId: '123',
      recordingUrl: 'https://fathom.video/calls/123',
      reviewOwnerUserId: 'review-owner',
      targetUserId: 'target-user',
      reviewed: true,
      extractedContext: baseContext,
    }, deps as any);

    expect(result.status).toBe('reviewed');
    expect(deps.userDb.updateUser).toHaveBeenNthCalledWith(
      1,
      'target-user',
      expect.objectContaining({
        fathomOnboardingIngestions: [
          expect.objectContaining({
            recordingId: '123',
            status: 'reviewed',
          }),
        ],
      }),
    );
    expect(deps.userDb.updateUser).toHaveBeenNthCalledWith(
      2,
      'review-owner',
      expect.objectContaining({
        fathomOnboardingIngestions: [
          expect.objectContaining({
            recordingId: 'keep-me',
            status: 'needs_review',
          }),
        ],
      }),
    );
  });

  it('rejects empty source input before calling the LLM or storing an all-null context', async () => {
    const deps = makeDeps();

    await expect(ingestFathomOnboardingRecording({
      recordingId: 'missing-source',
      reviewOwnerUserId: 'review-owner',
    }, deps as any)).rejects.toThrow(/meetingText, transcriptText, extractedContext/);

    expect(deps.llm.generateJsonRobust).not.toHaveBeenCalled();
    expect(deps.userDb.updateUser).not.toHaveBeenCalled();
  });

  it('formats bounded memory content with source link and setup blockers', () => {
    const content = buildFathomOnboardingMemoryContent(baseContext, {
      recordingUrl: 'https://fathom.video/calls/123',
    });

    expect(content).toContain('Fathom-derived onboarding context');
    expect(content).toContain('Source: https://fathom.video/calls/123');
    expect(content).toContain('Setup blockers: No outbound domain configured');
    expect(content.length).toBeLessThanOrEqual(2000);
  });
});
