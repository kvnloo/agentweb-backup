/**
 * runVerifiedChat headless park (ENG-396, AC #3, required half).
 *
 * A scheduled/headless run that hits a BLOCKING AskUserQuestion must NOT proceed
 * on a guess. When a turn leaves the session with an `awaiting` pendingUserQuestion,
 * runVerifiedChat stops immediately and returns a parked outcome (success:false,
 * parked:true) — it does not loop further attempts and does not report success.
 * A human answers later in an interactive session; the immutable consumer gate
 * (checkQuestionGate) remains the hard backstop for the write itself.
 *
 * Full-autonomy / delegated auto-take is deliberately NOT implemented here — that
 * waives the human protection on irreversible decisions and is a product-owner
 * (Harsha) call, tracked as a follow-up.
 */
import { runVerifiedChat } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { buildPendingUserQuestion, PendingUserQuestion } from '../services/agentMode/core/askUserQuestion';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
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

function awaitingQuestion(): PendingUserQuestion {
  return buildPendingUserQuestion({
    questionId: 'q-objective-1',
    question: 'Which Meta campaign objective? It cannot be changed after launch.',
    options: [
      { id: 'leads', label: 'Leads', consequence: 'Books demos.', recommended: true, why: '162 LEAD events fired.' },
      { id: 'traffic', label: 'Traffic', consequence: 'Cheap clicks, not leads.' },
    ],
    immutable: true,
    allowEmmaDecide: true,
    createdAt: '2026-07-21T00:00:00.000Z',
  });
}

const baseSession = {
  sessionId: 'session-1',
  userId: 'user-1',
  messages: [],
  llmModel: 'default-model',
  sessionType: 'scheduled' as const,
};

describe('runVerifiedChat — headless park on a blocking question (ENG-396)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('default-model');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('system prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    mockWorkerService.runInWorker.mockResolvedValue({
      content: 'Which objective should I optimize for?',
      toolCalls: [{ name: 'ask_user_question', result: { awaitingUserConfirmation: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);
  });

  it('parks (no guess) when the turn leaves an awaiting question — stops after one turn', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...baseSession,
      pendingUserQuestion: awaitingQuestion(),
    } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5, // plenty of room to loop — park must prevent that
      attachments: [],
    });

    expect((result as any).parked).toBe(true);
    expect(result.success).toBe(false);
    expect((result as any).pendingUserQuestion).toMatchObject({ questionId: 'q-objective-1', status: 'awaiting' });
    // Never proceeded on a guess: exactly one turn ran, no retry loop.
    expect(result.attempts).toBe(1);
    expect(mockWorkerService.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('does NOT park when the question has already been answered (status "answered")', async () => {
    const answered = { ...awaitingQuestion(), status: 'answered' as const, answer: { optionId: 'leads', delegated: false, answeredBy: 'user' as const, at: '2026-07-21T00:05:00.000Z' } };
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession, pendingUserQuestion: answered } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Continue.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 1,
      attachments: [],
    });

    expect((result as any).parked).toBeFalsy();
    expect(result.success).toBe(true);
  });

  it('does NOT park a normal run with no pending question', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(baseSession as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Just summarize my week.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 1,
      attachments: [],
    });

    expect((result as any).parked).toBeFalsy();
    expect(result.success).toBe(true);
  });
});
