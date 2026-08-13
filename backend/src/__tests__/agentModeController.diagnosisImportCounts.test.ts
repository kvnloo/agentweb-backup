import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { emailService } from '../services/emailService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import * as intakeService from '../services/intakeService';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionContextLimitReported: jest.fn().mockResolvedValue(undefined),
    createOrReuseInteractiveShare: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/intakeService', () => ({
  fileAutoIssue: jest.fn().mockResolvedValue({
    pageId: 'ENG-123',
    url: 'https://linear.app/issue/ENG-123',
    deduped: false,
    tracker: 'Linear',
  }),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null), // default: no diagnostic (fallback to generic)
  },
  AgentModeService: jest.fn(),
}));

const mockAgentModeService = jest.requireMock('../services/agentModeService').agentModeService;

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-03',
  }),
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: {
    delete: jest.fn(),
  },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;


/**
 * ENG-1174 wiring. The unit tests prove `collectLeadImportTotals` and
 * `stripUnfoundedEntityCounts` behave; they do NOT prove the controller invokes them
 * and persists the result. This drives `generateResponse` end to end with a
 * NON-timeout throw — the only class that still reaches the diagnosis agent, since
 * ENG-907 intercepts `isGenerationTimeout` before it — and asserts the transcript.
 *
 * Shaped after production session 39eb5663: three add_leads_to_list batches of 25,
 * 75 rows landed, which the live system reported as "the 3 leads".
 */
describe('AgentModeController — import row counts in the diagnosis message (ENG-1174)', () => {
  const sessionId = 'sess-eng-1174';
  const userId = 'user-eng-1174';

  const importResult = (created: number) => JSON.stringify({
    success: true,
    complete: true,
    attempted: created,
    reconciliation: {
      created, merged: 0, alreadyPresent: 0, duplicateInRequest: 0,
      anonymizedSkipped: 0, failed: 0, unprocessed: 0,
    },
  });

  /**
   * Must sort AFTER the turn start, which the handler captures as its own `Date.now()`
   * some time after this fixture is built. A small relative offset (`Date.now() + 1s`)
   * is a flake waiting to happen: one CI scheduling pause longer than the offset puts
   * these rows before the turn start, they are filtered out as an earlier turn's, and
   * the assertions fail for a reason that has nothing to do with the code under test.
   * A fixed far-future stamp is unconditionally inside the window.
   */
  const inThisTurn = () => '2099-01-01T00:00:00.000Z';

  const sessionWithImport = (messages?: any[]) => ({
    sessionId,
    userId,
    title: 'Import Lead List to CRM',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
    llmModel: 'anthropic.claude-opus-5',
    createdAt: '2026-08-11T13:23:23.137Z',
    updatedAt: '2026-08-11T13:51:07.513Z',
    // The CALL count — the number the production message wrongly printed.
    calledFunctions: { add_leads_to_list: 3, get_lead_lists: 1 },
    messages: messages ?? [
      { role: 'tool', name: 'add_leads_to_list', content: importResult(25), metadata: { timestamp: inThisTurn() } },
      { role: 'tool', name: 'add_leads_to_list', content: importResult(25), metadata: { timestamp: inThisTurn() } },
      { role: 'tool', name: 'add_leads_to_list', content: importResult(25), metadata: { timestamp: inThisTurn() } },
    ],
  });

  const driveTurn = async () => {
    const req = {
      user: { userId, email: 'test@example.com' },
      body: { sessionId, userMessage: 'Import this CSV into my CRM list', llmModel: 'anthropic.claude-opus-5', attachments: [] },
      method: 'POST',
      path: '/api/agent-mode/generate',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      on: jest.fn(),
    } as unknown as Request;
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;
    await agentModeController.generateResponse(req, res);
    return mockChatbotDb.addMessageToSession.mock.calls.find(
      (call) => (call[1] as any)?.metadata?.isErrorMessage === true,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWithImport() as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(sessionWithImport() as any);
    mockChatbotDb.createOrReuseInteractiveShare.mockResolvedValue('http://ishare.test/s');
    // A NON-timeout failure: the class that still reaches the diagnosis agent.
    mockGenerateMarketingResponseWorkerService.runInWorker.mockRejectedValue(
      new Error('Bedrock 500: internal server error'),
    );
  });

  it('strips the tool-call count the production message printed', async () => {
    mockAgentModeService.generateDiagnosticMessage.mockResolvedValue(
      'I have successfully added the 3 leads to your CRM list. Please retry the request.',
    );

    const errorCall = await driveTurn();

    expect(errorCall).toBeDefined();
    const content = (errorCall![1] as any).content as string;
    expect(content).not.toMatch(/\b3\s+leads\b/);
    expect(content).toMatch(/added the leads/i);
  });

  it('lets the true row count stand when it matches what the run wrote', async () => {
    mockAgentModeService.generateDiagnosticMessage.mockResolvedValue(
      'I added 75 leads to your CRM list before the run stopped.',
    );

    const errorCall = await driveTurn();
    expect((errorCall![1] as any).content).toMatch(/\b75\s+leads\b/);
  });

  it('passes the measured row total to the diagnosis agent', async () => {
    mockAgentModeService.generateDiagnosticMessage.mockResolvedValue('Something went wrong.');

    await driveTurn();

    const context = mockAgentModeService.generateDiagnosticMessage.mock.calls[0][0];
    expect(context.importTotalsSummary).toMatch(/75/);
    expect(context.importTotalsSummary).toMatch(/row/i);
    // The run-count ledger is still supplied alongside the row total — the two are
    // distinct inputs. Its VALUE is a per-turn delta (diffSucceededFunctions) and is
    // legitimately empty here, because this fixture returns the same calledFunctions
    // for the turn-start baseline and the end state. That delta is ENG-971's contract
    // and is covered by its own suite; what matters here is that both are passed.
    expect(context.succeededFunctions).toBeDefined();
  });

  it('says nothing about rows when the session carries no import results', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(sessionWithImport([]) as any);
    mockAgentModeService.generateDiagnosticMessage.mockResolvedValue('I added 75 leads.');

    const errorCall = await driveTurn();

    const context = mockAgentModeService.generateDiagnosticMessage.mock.calls[0][0];
    expect(context.importTotalsSummary).toBeNull();
    // Nothing provable, so the ENG-1173 strip applies to every quantity again.
    expect((errorCall![1] as any).content).not.toMatch(/\b75\s+leads\b/);
  });
});
