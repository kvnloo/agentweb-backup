import {
  buildFathomOnboardingMemoryContent,
  ingestFathomOnboardingRecording,
  matchFathomOnboardingTarget,
} from '../services/fathomOnboardingIngestionService';

const baseContext = {
  callClassification: 'prospect' as const,
  classificationConfidence: 0.92,
  classificationReason: 'The call is about evaluating AgentWeb for a GTM rollout.',
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
    createFathomDraftUser: jest.fn(async (input: Record<string, any>) => ({
      userId: input.userId,
      email: input.email,
      isActive: false,
      signupSource: 'fathom_auto_onboarding_draft',
      fathomDraftAccount: true,
      fathomDraftStatus: 'needs_review',
      roles: ['customer'],
      ...input,
    })),
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
      expect.objectContaining({ condition: expect.any(Object) }),
    );
  });

  it('uses the derived recording id to fetch Fathom text when only a recording URL is provided', async () => {
    const getRecordingSummary = jest.fn(async () => ({
      summary: {
        markdown_formatted: '## Summary\nAcme needs more qualified demos.',
      },
    }));
    const getTranscript = jest.fn(async () => [
      { speaker: { display_name: 'Jane' }, text: 'We need LinkedIn and email follow-up.' },
    ]);
    const FathomApiService = jest.fn().mockImplementation(() => ({ getRecordingSummary, getTranscript }));
    const deps = makeDeps({
      getFathomAccessToken: jest.fn(async () => 'fathom-token'),
      FathomApiService,
    });

    const result = await ingestFathomOnboardingRecording({
      recordingUrl: 'https://fathom.video/calls/123?timestamp=60',
      fathomUserId: 'review-owner',
      reviewOwnerUserId: 'review-owner',
    }, deps as any);

    expect(result.recordingId).toBe('123');
    expect(FathomApiService).toHaveBeenCalledWith('fathom-token');
    expect(getRecordingSummary).toHaveBeenCalledWith('123');
    expect(getTranscript).toHaveBeenCalledWith('123');
    expect((deps.llm.generateJsonRobust as jest.Mock).mock.calls[0][1]).toContain('Acme needs more qualified demos.');
    expect((deps.llm.generateJsonRobust as jest.Mock).mock.calls[0][1]).toContain('Jane: We need LinkedIn');
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
        createFathomDraftUser: jest.fn(),
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
      expect.objectContaining({ condition: expect.any(Object) }),
    );
  });

  it('ignores personal or internal calls instead of creating random users', async () => {
    const deps = makeDeps({
      userDb: {
        getUserById: jest.fn(async () => ({ userId: 'review-owner', email: 'harsha@agentweb.pro', fathomOnboardingIngestions: [] })),
        getUserByEmail: jest.fn(async () => null),
        getUsersByEmailDomain: jest.fn(async () => []),
        updateUser: jest.fn(async (_userId: string, updates: Record<string, any>) => updates),
        createFathomDraftUser: jest.fn(),
      },
    });

    const result = await ingestFathomOnboardingRecording({
      recordingId: 'friend-call-1',
      recordingUrl: 'https://fathom.video/calls/friend-call-1',
      reviewOwnerUserId: 'review-owner',
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      extractedContext: {
        ...baseContext,
        callClassification: 'personal',
        classificationConfidence: 0.96,
        classificationReason: 'Casual personal call, not a prospect or onboarding meeting.',
        companyName: 'Weekend Plans',
        primaryContactEmail: null,
        website: null,
      },
    }, deps as any);

    expect(result.automationState).toBe('ignored');
    expect(result.safetyFlags).toContain('non_actionable_call:personal');
    expect(result.targetUserId).toBeNull();
    expect(deps.userDb.createFathomDraftUser).not.toHaveBeenCalled();
    expect(deps.accountMemoryDb.addMemory).not.toHaveBeenCalled();
  });

  it('keeps low-confidence or poorly extracted calls review-only', async () => {
    const deps = makeDeps({
      userDb: {
        getUserById: jest.fn(async () => ({ userId: 'review-owner', email: 'harsha@agentweb.pro', fathomOnboardingIngestions: [] })),
        getUserByEmail: jest.fn(async () => null),
        getUsersByEmailDomain: jest.fn(async () => []),
        updateUser: jest.fn(async (_userId: string, updates: Record<string, any>) => updates),
        createFathomDraftUser: jest.fn(),
      },
    });

    const result = await ingestFathomOnboardingRecording({
      recordingId: 'bad-extract-1',
      recordingUrl: 'https://fathom.video/calls/bad-extract-1',
      reviewOwnerUserId: 'review-owner',
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      extractedContext: {
        ...baseContext,
        callClassification: 'prospect',
        classificationConfidence: 0.51,
        companyName: null,
        primaryContactEmail: null,
        primaryContactName: null,
        website: null,
      },
    }, deps as any);

    expect(result.automationState).toBe('review_only');
    expect(result.safetyFlags).toEqual(expect.arrayContaining([
      'low_classification_confidence',
      'missing_company_identity',
      'missing_primary_contact',
    ]));
    expect(deps.userDb.createFathomDraftUser).not.toHaveBeenCalled();
  });

  it('creates a disabled internal draft account for a high-confidence new prospect', async () => {
    const deps = makeDeps({
      userDb: {
        getUserById: jest.fn(async (userId: string) => ({
          userId,
          email: userId === 'fathom-draft-new-prospect-1' ? 'fathom+new-prospect-1@agentweb.internal' : 'harsha@agentweb.pro',
          isActive: false,
          fathomOnboardingIngestions: [],
        })),
        getUserByEmail: jest.fn(async () => null),
        getUsersByEmailDomain: jest.fn(async () => []),
        updateUser: jest.fn(async (_userId: string, updates: Record<string, any>) => updates),
        createFathomDraftUser: jest.fn(async (input: Record<string, any>) => ({
          userId: input.userId,
          email: input.email,
          isActive: false,
          signupSource: 'fathom_auto_onboarding_draft',
          fathomDraftAccount: true,
          fathomDraftStatus: 'needs_review',
        })),
      },
    });

    const result = await ingestFathomOnboardingRecording({
      recordingId: 'new-prospect-1',
      recordingUrl: 'https://fathom.video/calls/new-prospect-1',
      reviewOwnerUserId: 'review-owner',
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      extractedContext: {
        ...baseContext,
        primaryContactEmail: 'buyer@newco.com',
        website: 'https://newco.com',
        companyName: 'NewCo',
        featureRequestDrafts: ['Needs an onboarding summary review screen before account activation.'],
      },
    }, deps as any);

    expect(result.automationState).toBe('draft_account_created');
    expect(result.draftUserId).toBe('fathom-draft-new-prospect-1');
    expect(result.draftEmail).toBe('fathom+new-prospect-1@agentweb.internal');
    expect(result.status).toBe('needs_review');
    expect(result.memoryIds).toEqual([]);
    expect(result.featureRequestDrafts).toEqual(['Needs an onboarding summary review screen before account activation.']);
    expect(deps.userDb.createFathomDraftUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'fathom+new-prospect-1@agentweb.internal',
      userId: 'fathom-draft-new-prospect-1',
      reviewOwnerUserId: 'review-owner',
      sourceContactEmail: 'buyer@newco.com',
    }));
    expect(deps.accountMemoryDb.addMemory).not.toHaveBeenCalled();
  });

  it('reuses the deterministic draft account on duplicate webhook retries', async () => {
    const deps = makeDeps({
      userDb: {
        getUserById: jest.fn(async (userId: string) => ({
          userId,
          email: userId === 'fathom-draft-dupe-1' ? 'fathom+dupe-1@agentweb.internal' : 'harsha@agentweb.pro',
          fathomOnboardingIngestions: userId === 'fathom-draft-dupe-1'
            ? [{
              recordingId: 'dupe-1',
              recordingUrl: 'https://fathom.video/calls/dupe-1',
              status: 'needs_review',
              extractionState: 'auto_extracted',
              context: baseContext,
              automationState: 'draft_account_created',
              draftUserId: 'fathom-draft-dupe-1',
              draftEmail: 'fathom+dupe-1@agentweb.internal',
              memoryIds: [],
              orgMemoryIds: [],
              createdAt: '2026-07-08T19:00:00.000Z',
              updatedAt: '2026-07-08T19:00:00.000Z',
            }]
            : [],
        })),
        getUserByEmail: jest.fn(async (email: string) => (
          email === 'fathom+dupe-1@agentweb.internal'
            ? { userId: 'fathom-draft-dupe-1', email, isActive: false, fathomDraftAccount: true }
            : null
        )),
        getUsersByEmailDomain: jest.fn(async () => []),
        updateUser: jest.fn(async (_userId: string, updates: Record<string, any>) => updates),
        createFathomDraftUser: jest.fn(),
      },
    });

    const result = await ingestFathomOnboardingRecording({
      recordingId: 'dupe-1',
      recordingUrl: 'https://fathom.video/calls/dupe-1',
      reviewOwnerUserId: 'review-owner',
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      extractedContext: {
        ...baseContext,
        primaryContactEmail: 'buyer@dupe.com',
        website: 'https://dupe.com',
        companyName: 'Dupe Co',
      },
    }, deps as any);

    expect(result.draftUserId).toBe('fathom-draft-dupe-1');
    expect(deps.userDb.createFathomDraftUser).not.toHaveBeenCalled();
    const updatedLedger = deps.userDb.updateUser.mock.calls[0][1].fathomOnboardingIngestions;
    expect(updatedLedger).toHaveLength(1);
    expect(updatedLedger[0].createdAt).toBe('2026-07-08T19:00:00.000Z');
  });

  it('keeps a discarded entry discarded when the same recording is re-ingested unreviewed (Opslane 357)', async () => {
    const prior = {
      recordingId: 'disc-1',
      recordingUrl: 'https://fathom.video/calls/disc-1',
      status: 'discarded',
      extractionState: 'auto_extracted',
      context: baseContext,
      automationState: 'draft_account_created',
      draftUserId: 'fathom-draft-disc-1',
      draftEmail: 'fathom+disc-1@agentweb.internal',
      memoryIds: [],
      orgMemoryIds: [],
      createdAt: '2026-07-08T19:00:00.000Z',
      updatedAt: '2026-07-08T19:00:00.000Z',
    };
    const deps = makeDeps({
      userDb: {
        getUserById: jest.fn(async (userId: string) => ({
          userId,
          email: userId === 'fathom-draft-disc-1' ? 'fathom+disc-1@agentweb.internal' : 'harsha@agentweb.pro',
          fathomDraftStatus: userId === 'fathom-draft-disc-1' ? 'discarded' : undefined,
          isActive: false,
          fathomOnboardingIngestions: userId === 'fathom-draft-disc-1' ? [prior] : [],
        })),
        getUserByEmail: jest.fn(async (email: string) => (
          email === 'fathom+disc-1@agentweb.internal'
            ? { userId: 'fathom-draft-disc-1', email, isActive: false, fathomDraftAccount: true, fathomDraftStatus: 'discarded' }
            : null
        )),
        getUsersByEmailDomain: jest.fn(async () => []),
        updateUser: jest.fn(async (_userId: string, updates: Record<string, any>) => updates),
        createFathomDraftUser: jest.fn(),
      },
    });

    const result = await ingestFathomOnboardingRecording({
      recordingId: 'disc-1',
      recordingUrl: 'https://fathom.video/calls/disc-1',
      reviewOwnerUserId: 'review-owner',
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      extractedContext: { ...baseContext, primaryContactEmail: 'buyer@disc.com', website: 'https://disc.com', companyName: 'Disc Co' },
    }, deps as any);

    expect(result.status).toBe('discarded');
    const ledger = deps.userDb.updateUser.mock.calls[0][1].fathomOnboardingIngestions;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('discarded');
  });

  it('refuses a reviewed ingest of a discarded entry without writing memories (Opslane 962)', async () => {
    const prior = {
      recordingId: 'disc-2', status: 'discarded', extractionState: 'auto_extracted', context: baseContext,
      automationState: 'draft_account_created', draftUserId: 'fathom-draft-disc-2', memoryIds: [], orgMemoryIds: [],
      createdAt: '2026-07-08T19:00:00.000Z', updatedAt: '2026-07-08T19:00:00.000Z',
    };
    const deps = makeDeps({
      userDb: {
        getUserById: jest.fn(async (userId: string) => ({
          userId, email: 'fathom+disc-2@agentweb.internal', isActive: false, fathomDraftStatus: 'discarded',
          fathomOnboardingIngestions: [prior],
        })),
        getUserByEmail: jest.fn(async () => null),
        getUsersByEmailDomain: jest.fn(async () => []),
        updateUser: jest.fn(async (_u: string, updates: Record<string, any>) => updates),
        createFathomDraftUser: jest.fn(),
      },
    });
    await expect(ingestFathomOnboardingRecording({
      recordingId: 'disc-2', reviewOwnerUserId: 'review-owner', targetUserId: 'fathom-draft-disc-2',
      reviewed: true, meetingText: 'notes',
    } as any, deps as any)).rejects.toMatchObject({ statusCode: 409 });
    expect(deps.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    expect(deps.userDb.updateUser).not.toHaveBeenCalled();
  });

  it('re-reads and re-merges the ledger when a concurrent write lands between read and write (Opslane 422)', async () => {
    const stamp = '2026-07-08T19:00:00.000Z';
    const before = [{ recordingId: 'rv3-f', status: 'needs_review', context: baseContext, memoryIds: [], orgMemoryIds: [], createdAt: stamp, updatedAt: stamp }];
    const after = [
      { recordingId: 'rv3-h', status: 'needs_review', context: baseContext, memoryIds: [], orgMemoryIds: [], createdAt: stamp, updatedAt: stamp },
      { ...before[0], status: 'discarded', updatedAt: '2026-07-08T19:00:01.000Z' },
    ];
    let reads = 0;
    const updateUser = jest.fn(async (_userId: string, updates: Record<string, any>, options?: any) => {
      if (updateUser.mock.calls.length === 1) {
        expect(options?.condition?.values?.[':prevLedger']).toEqual(before);
        throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
      }
      return updates;
    });
    const deps = makeDeps({
      userDb: {
        getUserById: jest.fn(async (userId: string) => ({ userId, email: 'a@agentweb.pro', fathomOnboardingIngestions: (reads++ === 0) ? before : after })),
        getUserByEmail: jest.fn(async () => null),
        getUsersByEmailDomain: jest.fn(async () => []),
        updateUser,
        createFathomDraftUser: jest.fn(),
      },
    });

    await ingestFathomOnboardingRecording({
      recordingId: 'rv3-g', targetUserId: 'admin-1', reviewOwnerUserId: 'admin-1', reviewed: false, extractedContext: baseContext,
    }, deps as any);

    expect(updateUser).toHaveBeenCalledTimes(2);
    const ledger = updateUser.mock.calls[1][1].fathomOnboardingIngestions;
    expect(ledger.map((i: any) => i.recordingId).sort()).toEqual(['rv3-f', 'rv3-g', 'rv3-h']);
    expect(ledger.find((i: any) => i.recordingId === 'rv3-f').status).toBe('discarded');
  });

  it('deletes memories a losing concurrent reviewed ingest created when it adopts the winner ids (Opslane 443)', async () => {
    const stamp = '2026-07-08T19:00:00.000Z';
    const winner = [{ recordingId: 'dbl-1', status: 'reviewed', context: baseContext, memoryIds: ['mem-win'], orgMemoryIds: ['org-mem-win'], orgMemoryOrgId: 'org-1', createdAt: stamp, updatedAt: stamp }];
    let reads = 0;
    const updateUser = jest.fn(async (_u: string, updates: Record<string, any>) => {
      if (updateUser.mock.calls.length === 1) throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
      return updates;
    });
    const base = makeDeps();
    const deps = makeDeps({
      userDb: {
        ...base.userDb,
        getUserById: jest.fn(async (userId: string) => ({ userId, email: 'owner@acme.ai', orgId: 'org-1', fathomOnboardingIngestions: (userId === 'target-user' && reads++ > 0) ? winner : [] })),
        updateUser,
      },
      accountMemoryDb: { addMemory: jest.fn(async () => ({ memoryId: 'mem-lose' })), deleteMemory: jest.fn(async () => undefined) },
      orgMemoryDb: { addMemory: jest.fn(async () => ({ memoryId: 'org-mem-lose' })), deleteMemory: jest.fn(async () => undefined) },
    });

    const result = await ingestFathomOnboardingRecording({
      recordingId: 'dbl-1', targetUserId: 'target-user', reviewOwnerUserId: 'target-user', reviewed: true, extractedContext: baseContext,
    }, deps as any);

    expect(result.memoryIds).toEqual(['mem-win']);
    expect(result.orgMemoryIds).toEqual(['org-mem-win']);
    expect((deps.accountMemoryDb as any).deleteMemory).toHaveBeenCalledWith('target-user', 'mem-lose');
    expect((deps.orgMemoryDb as any).deleteMemory).toHaveBeenCalledWith('org-1', 'org-mem-lose');
  });

  it('deletes memories a refused approve wrote when a concurrent discard lands mid-retry (Opslane 1336)', async () => {
    const stamp = '2026-07-08T19:00:00.000Z';
    const pending = [{ recordingId: 'race-1', status: 'needs_review', context: baseContext, memoryIds: [], orgMemoryIds: [], createdAt: stamp, updatedAt: stamp }];
    const discarded = [{ ...pending[0], status: 'discarded' }];
    let reads = 0;
    const updateUser = jest.fn(async () => { throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }); });
    const base = makeDeps();
    const deps = makeDeps({
      userDb: {
        ...base.userDb,
        getUserById: jest.fn(async (userId: string) => ({ userId, email: 'owner@acme.ai', orgId: 'org-1', fathomOnboardingIngestions: (userId === 'target-user' && reads++ > 0) ? discarded : pending })),
        updateUser,
      },
      accountMemoryDb: { addMemory: jest.fn(async () => ({ memoryId: 'mem-race' })), deleteMemory: jest.fn(async () => undefined) },
      orgMemoryDb: { addMemory: jest.fn(async () => ({ memoryId: 'org-mem-race' })), deleteMemory: jest.fn(async () => undefined) },
    });

    await expect(ingestFathomOnboardingRecording({
      recordingId: 'race-1', targetUserId: 'target-user', reviewOwnerUserId: 'target-user', reviewed: true, extractedContext: baseContext,
    }, deps as any)).rejects.toMatchObject({ statusCode: 409 });

    expect((deps.accountMemoryDb as any).deleteMemory).toHaveBeenCalledWith('target-user', 'mem-race');
    expect((deps.orgMemoryDb as any).deleteMemory).toHaveBeenCalledWith('org-1', 'org-mem-race');
  });

  it('answers 409 and deletes its memories when ledger contention never clears (Opslane 1336 #3)', async () => {
    const stamp = '2026-07-08T19:00:00.000Z';
    const pending = [{ recordingId: 'burst-1', status: 'needs_review', context: baseContext, memoryIds: [], orgMemoryIds: [], createdAt: stamp, updatedAt: stamp }];
    const updateUser = jest.fn(async () => { throw Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }); });
    const base = makeDeps();
    const deps = makeDeps({
      userDb: {
        ...base.userDb,
        getUserById: jest.fn(async (userId: string) => ({ userId, email: 'owner@acme.ai', orgId: 'org-1', fathomOnboardingIngestions: pending })),
        updateUser,
      },
      accountMemoryDb: { addMemory: jest.fn(async () => ({ memoryId: 'mem-burst' })), deleteMemory: jest.fn(async () => undefined) },
      orgMemoryDb: { addMemory: jest.fn(async () => ({ memoryId: 'org-mem-burst' })), deleteMemory: jest.fn(async () => undefined) },
    });

    await expect(ingestFathomOnboardingRecording({
      recordingId: 'burst-1', targetUserId: 'target-user', reviewOwnerUserId: 'target-user', reviewed: true, extractedContext: baseContext,
    }, deps as any)).rejects.toMatchObject({ statusCode: 409 });

    expect(updateUser.mock.calls.length).toBeGreaterThan(5);
    expect((deps.accountMemoryDb as any).deleteMemory).toHaveBeenCalledWith('target-user', 'mem-burst');
    expect((deps.orgMemoryDb as any).deleteMemory).toHaveBeenCalledWith('org-1', 'org-mem-burst');
  });

  it('routes existing account matches to review without creating another user', async () => {
    const deps = makeDeps();

    const result = await ingestFathomOnboardingRecording({
      recordingId: 'existing-1',
      recordingUrl: 'https://fathom.video/calls/existing-1',
      reviewOwnerUserId: 'review-owner',
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      extractedContext: baseContext,
    }, deps as any);

    expect(result.automationState).toBe('matched_existing');
    expect(result.targetUserId).toBe('target-user');
    expect(deps.userDb.createFathomDraftUser).not.toHaveBeenCalled();
    expect(deps.accountMemoryDb.addMemory).not.toHaveBeenCalled();
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
      expect.objectContaining({ condition: expect.any(Object) }),
    );
  });

  it('preserves account memory in the ledger when org memory write fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      orgMemoryDb: {
        addMemory: jest.fn(async () => {
          throw new Error('org memory unavailable');
        }),
      },
    });

    const result = await ingestFathomOnboardingRecording({
      recordingId: '123',
      recordingUrl: 'https://fathom.video/calls/123',
      reviewOwnerUserId: 'review-owner',
      targetUserId: 'target-user',
      reviewed: true,
      extractedContext: baseContext,
    }, deps as any);

    expect(result.memoryIds).toEqual(['mem-1']);
    expect(result.orgMemoryIds).toEqual([]);
    expect(deps.userDb.updateUser).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({
        fathomOnboardingIngestions: [
          expect.objectContaining({
            recordingId: '123',
            memoryIds: ['mem-1'],
            orgMemoryIds: [],
          }),
        ],
      }),
      expect.objectContaining({ condition: expect.any(Object) }),
    );
    expect(warn).toHaveBeenCalledWith(
      '[FathomOnboarding] Failed to write org memory; preserving account memory ledger:',
      'org memory unavailable',
    );

    warn.mockRestore();
  });

  it('fills missing org memory on retry without duplicating account memory', async () => {
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
          orgMemoryIds: [],
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
    expect(result.orgMemoryIds).toEqual(['org-mem-1']);
    expect(deps.accountMemoryDb.addMemory).not.toHaveBeenCalled();
    expect(deps.orgMemoryDb.addMemory).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({ condition: expect.any(Object) }),
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
