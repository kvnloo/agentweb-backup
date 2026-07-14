/**
 * Wall-clock timeout for scheduled/verified runs (ENG-304).
 *
 * Scheduled runs execute through runVerifiedChat -> generateSessionResponse. Before this
 * fix that generation call had NO wall-clock timeout (only the interactive /generate path
 * did). When the underlying generation hung (stuck LLM stream / never-resolving upstream),
 * the whole scheduled run hung forever: no assistant message was ever produced, the
 * runScheduledChat catch/dead-man path never fired, so no error was persisted, no oncall
 * alert was sent, and the run was never requeued. Production sessions showed exactly this:
 * messageCount=2 (system + user only), null token accounting, and no `error` field.
 *
 * These tests pin that a hung generation now REJECTS after GENERATION_TIMEOUT_MS instead of
 * hanging forever, and that the orphaned worker run is cancelled (so it stops burning compute
 * and can't later write to the abandoned session).
 */
import { runVerifiedChat } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import * as sseProgress from '../utils/sseProgress';

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
    getSkillsForDisplay: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
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

// The default wall-clock timeout (matches GENERATION_TIMEOUT_MS default in the controller).
const GENERATION_TIMEOUT_MS = 600000;

describe('runVerifiedChat wall-clock timeout (ENG-304)', () => {
  const baseSession = {
    sessionId: 'session-1',
    userId: 'user-1',
    messages: [],
    llmModel: 'default-model',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockChatbotDb.getChatSession.mockResolvedValue(baseSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(baseSession as any);

    mockAgentModeService.getDefaultModel.mockResolvedValue('default-model');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('system prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');
    (mockAgentModeService as any).getSkillsForDisplay.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects a hung generation after the wall-clock timeout instead of hanging forever', async () => {
    // Generation never settles — simulates a stuck LLM stream / never-resolving upstream.
    mockWorkerService.runInWorker.mockReturnValue(new Promise(() => {}) as any);

    const promise = runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Produce the daily report.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 1,
    });

    // Assert it rejects (and swallow the rejection so it isn't reported as unhandled).
    const expectation = expect(promise).rejects.toThrow(/timed out/i);

    // Advance past the wall-clock timeout; the timeout promise wins the race and rejects.
    await jest.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS + 1000);

    await expectation;
  });

  it('cancels the orphaned worker run when the generation times out', async () => {
    const requestCancelSpy = jest.spyOn(sseProgress, 'requestCancel');
    mockWorkerService.runInWorker.mockReturnValue(new Promise(() => {}) as any);

    const promise = runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Produce the daily report.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 1,
    });
    const expectation = expect(promise).rejects.toThrow(/timed out/i);
    await jest.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS + 1000);
    await expectation;

    // Orphan cancellation mirrors the interactive path so the detached run stops.
    expect(requestCancelSpy).toHaveBeenCalledWith('session-1');
    expect(mockWorkerService.cancelSession).toHaveBeenCalledWith('session-1');
  });

  it('does NOT cancel or time out when the generation completes normally', async () => {
    const requestCancelSpy = jest.spyOn(sseProgress, 'requestCancel');
    mockWorkerService.runInWorker.mockResolvedValue({
      content: 'All done.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [{ role: 'assistant', content: 'All done.' }],
    } as any);

    const result = await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Produce the daily report.',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 1,
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('All done.');
    expect(requestCancelSpy).not.toHaveBeenCalled();
    expect(mockWorkerService.cancelSession).not.toHaveBeenCalled();
  });
});
