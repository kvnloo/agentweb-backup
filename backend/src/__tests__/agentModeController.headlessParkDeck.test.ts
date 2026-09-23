/**
 * runVerifiedChat headless park/auto-take on the NEW pendingApprovalDeck slot
 * (ENG-1635/1644, ask_user_question retirement).
 *
 * Mirrors agentModeController.headlessPark.test.ts exactly, one slot over:
 * ask_user_question and resolveCampaignObjectiveGate no longer write
 * session.pendingUserQuestion at all — they build a single-item
 * pendingApprovalDeck instead. resolveAwaitingUserQuestion must give the new
 * slot the SAME park/auto-take/parkedUnnotifiable/MAX_AUTO_TAKES guarantees
 * the legacy slot already has, and must NOT touch a genuine multi-item or
 * Meta-write deck (those stay out of scope — always require a live human).
 */
import { runVerifiedChat } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import {
  createApprovalDeck,
  appendApprovalDeckItem,
  finalizeApprovalDeck,
  type PendingApprovalDeck,
} from '../services/agentMode/core/approvalDeck';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionApprovalDeck: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getReportGenerationDefaultModel: jest.fn(),
    getImageGenerationDefaultModel: jest.fn(),
    getVideoGenerationDefaultModel: jest.fn(),
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendOncallAlert: jest.fn() },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {},
  taskDb: {},
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

function awaitingImmutableDeck(deckId = 'deck-objective-1'): PendingApprovalDeck {
  let deck = createApprovalDeck(deckId, '2026-07-21T00:00:00.000Z');
  deck = appendApprovalDeckItem(deck, {
    itemId: 'item-1',
    kind: 'meta_objective',
    question: 'Which Meta campaign objective? It cannot be changed after launch.',
    options: [
      { id: 'leads', label: 'Leads', consequence: 'Books demos.', recommended: true, why: '162 LEAD events fired.' },
      { id: 'traffic', label: 'Traffic', consequence: 'Cheap clicks, not leads.' },
    ],
    allowEmmaDecide: true,
    immutable: true,
  });
  return finalizeApprovalDeck(deck, '2026-07-21T00:00:01.000Z');
}

function awaitingReversibleDeck(deckId = 'deck-shortfall-1'): PendingApprovalDeck {
  let deck = createApprovalDeck(deckId, '2026-07-25T16:11:00.000Z');
  deck = appendApprovalDeckItem(deck, {
    itemId: 'item-1',
    kind: 'plan_choice',
    question: 'Only 30 of the requested 100 B2B ads were found. How should I proceed?',
    options: [
      { id: 'catalog-30', label: 'Catalog the 30 real ads', consequence: 'Saves the 30 genuine ads.', recommended: true, why: 'Preserves data integrity.' },
      { id: 'pad-b2c', label: 'Pad with B2C ads', consequence: 'Reaches 100 but pollutes the set.' },
    ],
    allowEmmaDecide: true,
  });
  return finalizeApprovalDeck(deck, '2026-07-25T16:11:01.000Z');
}

const baseSession = {
  sessionId: 'session-1',
  userId: 'user-1',
  messages: [],
  llmModel: 'default-model',
  sessionType: 'scheduled' as const,
};

function haltingWorkerResult() {
  return {
    content: 'Which objective should I optimize for?',
    toolCalls: [{ name: 'present_question_deck', result: { awaitingUserConfirmation: true } }],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
  } as any;
}

describe('runVerifiedChat — headless park on the deck-of-one slot (ENG-1635/1644)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    (mockChatbotDb as any).updateSessionApprovalDeck = jest.fn().mockResolvedValue(undefined as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('default-model');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('system prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(haltingWorkerResult());
  });

  it('parks (no guess) on an awaiting immutable deck-of-one — stops after one turn', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...baseSession,
      pendingApprovalDeck: awaitingImmutableDeck(),
    } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      parkNotifiable: true,
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5,
      attachments: [],
    });

    expect((result as any).parked).toBe(true);
    expect(result.success).toBe(false);
    expect((result as any).pendingUserQuestion).toBeUndefined();
    expect((result as any).pendingApprovalDeck).toMatchObject({ deckId: 'deck-objective-1', status: 'awaiting' });
    expect(result.attempts).toBe(1);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('does NOT park when the deck has already been answered (status "answered")', async () => {
    const awaiting = awaitingImmutableDeck();
    const answered: PendingApprovalDeck = {
      ...awaiting,
      status: 'answered',
      answers: [{ itemId: 'item-1', verdict: 'leads', answeredBy: 'user', at: '2026-07-21T00:05:00.000Z' }],
    };
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession, pendingApprovalDeck: answered } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      parkNotifiable: true,
      startingMessage: 'Continue.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 1,
      attachments: [],
    });

    expect((result as any).parked).toBeFalsy();
    expect(result.success).toBe(true);
  });

  it('does NOT touch a genuine multi-item deck — out of scope, never parks/auto-takes it', async () => {
    let deck = createApprovalDeck('deck-multi-1', '2026-07-21T00:00:00.000Z');
    deck = appendApprovalDeckItem(deck, {
      itemId: 'item-1',
      kind: 'plan_choice',
      question: 'What daily budget?',
      options: [
        { id: '50', label: '$50/day', consequence: 'Conservative.', recommended: true, why: 'Safe start.' },
        { id: '100', label: '$100/day', consequence: 'Faster learning.' },
      ],
    });
    deck = appendApprovalDeckItem(deck, {
      itemId: 'item-2',
      kind: 'plan_choice',
      question: 'What target audience?',
      options: [
        { id: 'broad', label: 'Broad', consequence: 'Wider reach.', recommended: true, why: 'More data.' },
        { id: 'narrow', label: 'Narrow', consequence: 'Tighter targeting.' },
      ],
    });
    const multiDeck = finalizeApprovalDeck(deck, '2026-07-21T00:00:01.000Z');
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession, pendingApprovalDeck: multiDeck } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      parkNotifiable: true,
      startingMessage: 'Plan my campaign.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 1,
      attachments: [],
    });

    expect((result as any).parked).toBeFalsy();
    expect((result as any).parkedUnnotifiable).toBeFalsy();
    expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
  });

  it('does NOT touch a Meta-write deck-of-one — out of scope, never parks/auto-takes it', async () => {
    let deck = createApprovalDeck('deck-write-1', '2026-07-21T00:00:00.000Z');
    deck = appendApprovalDeckItem(deck, {
      itemId: 'item-1',
      kind: 'meta_write',
      question: 'Create campaign "Test"',
      allowFreeText: true,
      metaWriteManifestDigest: 'digest-1',
      metaWriteDispatch: { entity_type: 'CAMPAIGN', action: 'CREATE', account_id: '123', params: {} },
    });
    const writeDeck = finalizeApprovalDeck(deck, '2026-07-21T00:00:01.000Z');
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession, pendingApprovalDeck: writeDeck } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      parkNotifiable: true,
      startingMessage: 'Launch it.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 1,
      attachments: [],
    });

    expect((result as any).parked).toBeFalsy();
    expect((result as any).parkedUnnotifiable).toBeFalsy();
    expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
  });
});

describe('runVerifiedChat — full-autonomy auto-take on the deck-of-one slot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    (mockChatbotDb as any).updateSessionApprovalDeck = jest.fn().mockResolvedValue(undefined as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('default-model');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('system prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(haltingWorkerResult());
  });

  it('with fullAutonomy, AUTO-TAKES the recommended option (even immutable) and continues instead of parking', async () => {
    let persisted: PendingApprovalDeck = awaitingImmutableDeck();
    (mockChatbotDb as any).updateSessionApprovalDeck = jest.fn(async (_sid: string, d: any) => { persisted = d; return { pendingApprovalDeck: d }; });
    mockChatbotDb.getChatSession.mockImplementation(async () => ({ ...baseSession, pendingApprovalDeck: persisted } as any));

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      parkNotifiable: true,
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5,
      attachments: [],
      fullAutonomy: true,
    });

    expect((result as any).parked).toBeFalsy();
    expect((mockChatbotDb as any).updateSessionApprovalDeck).toHaveBeenCalled();
    expect(persisted.status).toBe('answered');
    expect(persisted.answers).toMatchObject([{ itemId: 'item-1', verdict: 'leads', answeredBy: 'delegation' }]);
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ metadata: expect.objectContaining({ autoDelegatedAnswer: true, pendingApprovalDeckId: 'deck-objective-1' }) }),
    );
    expect(mockWorkerService.runInWorker.mock.calls.length).toBeGreaterThan(1);
  });

  it('without fullAutonomy, still PARKS an immutable deck-of-one (default safe behavior)', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession, pendingApprovalDeck: awaitingImmutableDeck() } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      parkNotifiable: true,
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5,
      attachments: [],
      fullAutonomy: false,
    });

    expect((result as any).parked).toBe(true);
    expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
  });

  it('without fullAutonomy, AUTO-TAKES a REVERSIBLE (non-immutable) deck-of-one and continues', async () => {
    let persisted: PendingApprovalDeck = awaitingReversibleDeck();
    (mockChatbotDb as any).updateSessionApprovalDeck = jest.fn(async (_sid: string, d: any) => { persisted = d; return { pendingApprovalDeck: d }; });
    mockChatbotDb.getChatSession.mockImplementation(async () => ({ ...baseSession, pendingApprovalDeck: persisted } as any));

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      parkNotifiable: true,
      startingMessage: 'Refresh the B2B Meta ads intelligence.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5,
      attachments: [],
      fullAutonomy: false,
    });

    expect((result as any).parked).toBeFalsy();
    expect((mockChatbotDb as any).updateSessionApprovalDeck).toHaveBeenCalled();
    expect(persisted.status).toBe('answered');
    expect(persisted.answers).toMatchObject([{ itemId: 'item-1', verdict: 'catalog-30', answeredBy: 'delegation' }]);
    expect(mockWorkerService.runInWorker.mock.calls.length).toBeGreaterThan(1);
  });

  it('bounds auto-takes: a model that keeps re-asking a fresh deck eventually parks instead of looping forever', async () => {
    let n = 0;
    (mockChatbotDb as any).updateSessionApprovalDeck = jest.fn().mockResolvedValue(undefined);
    mockChatbotDb.getChatSession.mockImplementation(async () => {
      n++;
      return { ...baseSession, pendingApprovalDeck: awaitingImmutableDeck(`deck-${n}`) } as any;
    });

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      parkNotifiable: true,
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 20,
      attachments: [],
      fullAutonomy: true,
    });

    expect((result as any).parked).toBe(true);
    expect((mockChatbotDb as any).updateSessionApprovalDeck.mock.calls.length).toBe(3); // MAX_AUTO_TAKES, shared bound
    expect(mockWorkerService.runInWorker.mock.calls.length).toBeLessThan(20);
  });
});

describe('runVerifiedChat — unnotifiable park on the deck-of-one slot (ENG-636)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    (mockChatbotDb as any).updateSessionApprovalDeck = jest.fn().mockResolvedValue(undefined as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('default-model');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('system prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue(haltingWorkerResult());
  });

  it('default (no parkNotifiable): an immutable deck-of-one FAILS explicitly, not a park into a void', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...baseSession,
      pendingApprovalDeck: awaitingImmutableDeck(),
    } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5,
      attachments: [],
    });

    expect(result.success).toBe(false);
    expect((result as any).parkedUnnotifiable).toBe(true);
    expect((result as any).parked).toBeFalsy();
    expect((result as any).pendingApprovalDeck).toBeUndefined();
    expect((mockChatbotDb as any).updateSessionApprovalDeck).not.toHaveBeenCalled();
    expect(result.attempts).toBe(1);
  });
});
