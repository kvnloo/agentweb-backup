/**
 * ENG-2113 approval cards on the Claude plan route. The plan route turns the halts of one turn into the session's approval deck with
 * AgentModeService.stageApprovalDeckForPlanTurn. These tests pin that it is the SAME deck the chat loop builds (they run the real loop and the seam on the
 * same tool results and compare), and that every case where the loop writes no deck, loses the slot race, or fails, the plan route behaves the same.
 */

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { settingsService } from '../services/settingsService';

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../services/db', () => ({
  ...jest.requireActual('../services/db'),
  taskTemplateDb: {
    getAllTemplates: jest.fn().mockResolvedValue([]),
    getPublishedTemplates: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../utils/secretsManager');

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
  },
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: { update: jest.fn() },
}));

const DISPATCH = { entity_type: 'AD_SET', action: 'CREATE', account_id: '1916400978974090', campaign_id: '6992830887577' };
const SIGNATURE = 'AD_SET:CREATE:1916400978974090:6992830887577::';

const toolCall = (id: string) => ({
  id,
  type: 'function',
  function: { name: 'call_meta_marketing_api', arguments: JSON.stringify({ ...DISPATCH, params: { name: `Ad set ${id}`, daily_budget: 10000 } }) },
});

/** The minimal result a Meta write preview leaves in the ledger: the same shape the chat loop partitions. */
function writeHalt(n: number, over: Record<string, unknown> = {}) {
  return {
    success: true,
    requiresConfirmation: true,
    awaitingUserConfirmation: true,
    confirmationPrompt: `Create a NEW ad set "Ad set ${n}"...`,
    summary: `Create a NEW ad set "Ad set ${n}"...`,
    target: { campaign: 'Holiday Gift Guide Promo 2026' },
    metaWriteManifestDigest: `digest-${n}`,
    metaWriteDispatch: { ...DISPATCH, params: { name: `Ad set ${n}`, daily_budget: 10000 } },
    ...over,
  };
}

const questionHalt = (q = 'Which audience first?') => ({
  success: true,
  awaitingUserConfirmation: true,
  questionDeckPayload: [
    {
      question: q,
      options: [
        { id: 'a', label: 'Leads', consequence: 'Focus on leads', recommended: true, why: 'Best fit' },
        { id: 'b', label: 'Sales', consequence: 'Focus on sales' },
      ],
    },
  ],
});

const imageEditHalt = () => ({ success: true, awaitingUserConfirmation: true, confirmationPrompt: 'Edit this image? Reply yes to confirm.', summary: 'Edit this image' });

const strip = (deck: any) => {
  const { deckId, createdAt, finalizedAt, ...rest } = deck;
  return rest;
};

describe('ENG-2113 approval cards: the plan route stages the SAME deck Emma\'s chat loop builds', () => {
  let service: AgentModeService;

  function mockSession(lastFailedMetaWrite: { signature: string; error: string; count: number; at: string } | null = null) {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'sess-1',
      userId: 'user-1',
      messages: [],
      workPlan: null,
      ...(lastFailedMetaWrite ? { lastFailedMetaWrite } : {}),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockSession();
    (chatbotDb.addMessageToSession as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.incrementCalledFunctions as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.incrementFailedFunctions as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.updateSessionApprovalDeck as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.updateSessionLastFailedMetaWrite as jest.Mock) = jest.fn().mockResolvedValue({});
    (settingsService.getSetting as jest.Mock) = jest.fn().mockResolvedValue(null);
    service = new AgentModeService();
  });

  async function runChatLoop(calls: any[], results: any[]) {
    jest.spyOn(service as any, 'callLLM').mockImplementation(async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: calls }, finish_reason: 'tool_calls' }] }));
    const exec = jest.spyOn(service as any, 'executeTool');
    results.forEach((r) => exec.mockResolvedValueOnce(r));
    return service.generateMarketingResponse('do it', [], 'user-1', service.default_model, 'sess-1');
  }

  const savedDecks = () => (chatbotDb.updateSessionApprovalDeck as jest.Mock).mock.calls;

  it('PARITY: one Meta write — same deck, same write options, same visible prompt as the chat loop', async () => {
    const loop = await runChatLoop([toolCall('t1')], [writeHalt(1)]);
    expect(savedDecks()).toHaveLength(1);
    const [, loopDeck, loopOpts] = savedDecks()[0];
    jest.clearAllMocks();
    mockSession();
    (chatbotDb.updateSessionApprovalDeck as jest.Mock).mockResolvedValue({});

    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [writeHalt(1)]);
    expect(staged.kind).toBe('deck');
    if (staged.kind !== 'deck') return;
    const [sessionId, planDeck, planOpts] = savedDecks()[0];
    expect(sessionId).toBe('sess-1');
    expect(planOpts).toEqual(loopOpts);
    expect(planOpts).toEqual({ failIfAwaitingExists: true });
    expect(strip(planDeck)).toEqual(strip(loopDeck));
    expect(staged.deck).toBe(planDeck);
    expect(staged.prompt).toBe(loop.content);
  });

  it('PARITY: three sibling Meta writes become ONE three-item deck, in call order, each with its own digest', async () => {
    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [writeHalt(1), writeHalt(2), writeHalt(3)]);
    expect(staged.kind).toBe('deck');
    if (staged.kind !== 'deck') return;
    expect(savedDecks()).toHaveLength(1);
    expect(staged.deck.status).toBe('awaiting');
    expect(staged.deck.items.map((i: any) => i.kind)).toEqual(['meta_write', 'meta_write', 'meta_write']);
    expect(staged.deck.items.map((i: any) => i.metaWriteManifestDigest)).toEqual(['digest-1', 'digest-2', 'digest-3']);
    // the chat loop's deck for the same three results is identical (modulo ids and times)
    jest.clearAllMocks();
    mockSession();
    (chatbotDb.updateSessionApprovalDeck as jest.Mock).mockResolvedValue({});
    await runChatLoop([toolCall('t1'), toolCall('t2'), toolCall('t3')], [writeHalt(1), writeHalt(2), writeHalt(3)]);
    expect(strip(savedDecks()[0][1])).toEqual(strip(staged.deck));
  });

  it('PARITY: a question deck (present_question_deck) is built by the same builder', async () => {
    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [questionHalt()]);
    expect(staged.kind).toBe('deck');
    if (staged.kind !== 'deck') return;
    expect(staged.deck.items[0]).toMatchObject({ kind: 'plan_choice', question: 'Which audience first?' });
    jest.clearAllMocks();
    mockSession();
    (chatbotDb.updateSessionApprovalDeck as jest.Mock).mockResolvedValue({});
    const loop = await runChatLoop([{ id: 'q1', type: 'function', function: { name: 'present_question_deck', arguments: '{}' } }], [questionHalt()]);
    expect(strip(savedDecks()[0][1])).toEqual(strip(staged.deck));
    expect(staged.prompt).toBe(loop.content);
  });

  it('a write and a question in one message: the write deck wins and the question is kept on it to be re-asked (as in the loop)', async () => {
    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [questionHalt('Later question?'), writeHalt(1)]);
    expect(staged.kind).toBe('deck');
    if (staged.kind !== 'deck') return;
    expect(staged.deck.items.map((i: any) => i.kind)).toEqual(['meta_write']);
    expect(staged.deck.droppedQuestionDeckPayload?.map((q: any) => q.question)).toEqual(['Later question?']);
  });

  it('a halt kind that has no deck (image edit) writes NO deck and answers with the plain confirmation prompt', async () => {
    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [imageEditHalt()]);
    expect(staged).toEqual({ kind: 'text', prompt: 'Edit this image? Reply yes to confirm.' });
    expect(savedDecks()).toHaveLength(0);
  });

  it('a write next to a no-deck halt writes NO deck (the loop\'s rule): nothing becomes approvable by a card', async () => {
    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [writeHalt(1), imageEditHalt()]);
    expect(staged.kind).toBe('text');
    expect(savedDecks()).toHaveLength(0);
  });

  it('a lost slot race (another deck or a pending work-plan request holds the slot) answers with the plain prompt and returns NO deck', async () => {
    (chatbotDb.updateSessionApprovalDeck as jest.Mock).mockResolvedValue(null);
    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [writeHalt(1)]);
    expect(staged.kind).toBe('text');
    expect(savedDecks()).toHaveLength(1);
    expect(savedDecks()[0][2]).toEqual({ failIfAwaitingExists: true });
  });

  it('a database failure on the write rejects (the caller ends the turn with its fixed note); nothing is returned as a deck', async () => {
    (chatbotDb.updateSessionApprovalDeck as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    await expect(service.stageApprovalDeckForPlanTurn('sess-1', [writeHalt(1)])).rejects.toThrow('dynamo down');
  });

  it('an older answered deck whose run is stuck is resumed BEFORE the new deck overwrites the slot', async () => {
    const order: string[] = [];
    jest.spyOn(service as any, 'resumeStuckApprovalDeckWorkflowRun').mockImplementation(async () => void order.push('resume'));
    (chatbotDb.updateSessionApprovalDeck as jest.Mock).mockImplementation(async () => (order.push('write'), {}));
    await service.stageApprovalDeckForPlanTurn('sess-1', [writeHalt(1)]);
    expect(order).toEqual(['resume', 'write']);
  });

  it('the retry-backstop note reaches the card of a target that already failed twice (annotation only, never a block)', async () => {
    mockSession({ signature: SIGNATURE, error: 'Budget too low.', count: 2, at: '2026-09-18T16:16:50.200Z' });
    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [writeHalt(1)]);
    expect(staged.kind).toBe('deck');
    if (staged.kind !== 'deck') return;
    expect(staged.deck.items[0].question).toContain('already failed 2 time(s) in a row');
    expect(staged.deck.items[0].question).toContain('Ad set 1');
  });

  it('no halts: nothing to stage, nothing written', async () => {
    expect(await service.stageApprovalDeckForPlanTurn('sess-1', [])).toEqual({ kind: 'none' });
    expect(savedDecks()).toHaveLength(0);
  });

  it('a result that merely says "requires confirmation" without the halt flag is not a halt (nothing written)', async () => {
    const staged = await service.stageApprovalDeckForPlanTurn('sess-1', [{ success: true, requiresConfirmation: true, metaWriteManifestDigest: 'd', metaWriteDispatch: DISPATCH }]);
    expect(staged).toEqual({ kind: 'none' });
    expect(savedDecks()).toHaveLength(0);
  });
});
