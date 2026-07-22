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

  it('parks when the blocking question is first emitted during a completion-gate CONTINUATION turn', async () => {
    // Regression: the original park guarded ONLY the main LLM call. A question
    // first emitted during a completion-gate continuation turn slipped past it
    // and the run returned success. Both call sites now share one handler, so a
    // question raised on the continuation turn must park just the same.
    let workerCalls = 0;
    mockWorkerService.runInWorker.mockImplementation(async () => {
      workerCalls++;
      if (workerCalls === 1) {
        // Main turn: admits unfinished work, no question yet → gate continues.
        return {
          content: 'Event 1 done. I did not complete Step 3 for Events 2 and 3.',
          toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [],
        } as any;
      }
      // Continuation turn: NOW emits the blocking question.
      return {
        content: 'Which objective should I optimize for?',
        toolCalls: [{ name: 'ask_user_question', result: { awaitingUserConfirmation: true } }],
        knowledgeBaseQueries: [], sources: [], responseMessages: [],
      } as any;
    });
    // The session reflects the awaiting question only AFTER the continuation turn.
    mockChatbotDb.getChatSession.mockImplementation(async () => ({
      ...baseSession,
      pendingUserQuestion: workerCalls >= 2 ? awaitingQuestion() : undefined,
    } as any));

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'For each of the 3 events, research and report on every guest.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5, // room to loop — park must stop it on the continuation turn
      attachments: [],
      completionGate: true,
    });

    expect((result as any).parked).toBe(true);
    expect(result.success).toBe(false);
    expect((result as any).pendingUserQuestion).toMatchObject({ questionId: 'q-objective-1', status: 'awaiting' });
    // Parked ON the continuation turn: main turn + one continuation = 2 worker
    // calls, and it did NOT loop further or return success on the unanswered question.
    expect(workerCalls).toBe(2);
  });
});

describe('runVerifiedChat — full-autonomy auto-take (ENG-396 Version B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    (mockChatbotDb as any).updateSessionAskUserQuestion = jest.fn().mockResolvedValue(undefined as any);
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

  it('with fullAutonomy, AUTO-TAKES the recommended option (even immutable) and continues instead of parking', async () => {
    // First read returns the awaiting immutable question; after the auto-take
    // persists an answer, subsequent reads return the answered question so the
    // run proceeds and completes rather than re-asking forever.
    let persisted = awaitingQuestion();
    (mockChatbotDb as any).updateSessionAskUserQuestion = jest.fn(async (_sid: string, q: any) => { persisted = q; });
    mockChatbotDb.getChatSession.mockImplementation(async () => ({ ...baseSession, pendingUserQuestion: persisted } as any));

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5,
      attachments: [],
      fullAutonomy: true,
    });

    // Did not park — it auto-answered and carried on.
    expect((result as any).parked).toBeFalsy();
    // The auto-take recorded a delegation answer on the RECOMMENDED option.
    expect((mockChatbotDb as any).updateSessionAskUserQuestion).toHaveBeenCalled();
    expect(persisted.status).toBe('answered');
    expect(persisted.answer).toMatchObject({ optionId: 'leads', delegated: true, answeredBy: 'delegation' });
    expect(persisted.answer?.rationale).toContain('162 LEAD events');
    // A history breadcrumb was written so Emma resumes without re-asking.
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ metadata: expect.objectContaining({ autoDelegatedAnswer: true }) }),
    );
    // It ran more than one turn (continued after the auto-take).
    expect(mockWorkerService.runInWorker.mock.calls.length).toBeGreaterThan(1);
  });

  it('without fullAutonomy, still PARKS (default safe behavior) even though a toggle exists', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({ ...baseSession, pendingUserQuestion: awaitingQuestion() } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 5,
      attachments: [],
      fullAutonomy: false,
    });

    expect((result as any).parked).toBe(true);
    expect((mockChatbotDb as any).updateSessionAskUserQuestion).not.toHaveBeenCalled();
  });

  it('bounds auto-takes: a model that keeps re-asking eventually parks instead of looping forever', async () => {
    // Every read returns a fresh awaiting question (a new id each time) — simulating
    // a model that re-asks after every auto-take. The run must not loop to maxAttempts.
    let n = 0;
    (mockChatbotDb as any).updateSessionAskUserQuestion = jest.fn().mockResolvedValue(undefined);
    mockChatbotDb.getChatSession.mockImplementation(async () => {
      n++;
      return { ...baseSession, pendingUserQuestion: { ...awaitingQuestion(), questionId: `q-${n}` } } as any;
    });

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Build and launch my Meta campaigns.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 20,
      attachments: [],
      fullAutonomy: true,
    });

    // After the bounded number of auto-takes it parks rather than running to maxAttempts.
    expect((result as any).parked).toBe(true);
    expect((mockChatbotDb as any).updateSessionAskUserQuestion.mock.calls.length).toBe(3); // MAX_AUTO_TAKES
    expect(mockWorkerService.runInWorker.mock.calls.length).toBeLessThan(20);
  });
});
