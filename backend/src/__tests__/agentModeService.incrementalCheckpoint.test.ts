import { AgentModeService } from '../services/agentModeService';

// ENG-473: verify generateMarketingResponse checkpoints settled turns to the session
// as the run progresses (persistIncrementally), so a hard process kill leaves a visible
// partial transcript instead of a silent zero-output session.

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

function mockDeps(addMessagesImpl?: jest.Mock) {
  const mockChatbotService = require('../services/chatbotService');
  const addMessagesToSession = addMessagesImpl ?? jest.fn().mockResolvedValue(undefined);
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue({ sessionId: 'test-session', messages: [], associatedSkills: null }),
    addMessagesToSession,
    incrementCalledFunctions: jest.fn().mockResolvedValue(undefined),
    incrementFailedFunctions: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };

  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };

  return { addMessagesToSession };
}

/** Truncated (finish_reason=length) response → forces a max-tokens continuation, i.e. a 2nd iteration. */
function truncatedResponse(text: string) {
  return {
    choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Final response → loop exits. */
function finalResponse(text: string) {
  return {
    choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe('AgentModeService - incremental checkpoint persistence (ENG-473)', () => {
  let svc: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AgentModeService();
  });

  function drive(persistIncrementally: boolean, addMessagesImpl?: jest.Mock) {
    const { addMessagesToSession } = mockDeps(addMessagesImpl);
    let call = 0;
    jest.spyOn(svc as any, 'callLLM').mockImplementation(async () => {
      call++;
      // Iteration 1 truncates (settled once iteration 2 begins); iteration 2 finishes.
      return call === 1 ? truncatedResponse('partial answer') : finalResponse('final answer');
    });
    return {
      addMessagesToSession,
      run: () =>
        svc.generateMarketingResponse(
          'Draft the campaign',
          [],
          'test-user',
          svc.default_model,
          'test-session',
          false,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          false,
          persistIncrementally
        ),
    };
  }

  it('persists the settled prior turn mid-run and reports persistedResponseCount', async () => {
    const { addMessagesToSession, run } = drive(true);

    const result = await run();

    // The iteration-1 assistant message was checkpointed at the top of iteration 2.
    expect(addMessagesToSession).toHaveBeenCalledTimes(1);
    const [, checkpointed] = addMessagesToSession.mock.calls[0];
    expect(checkpointed.map((m: any) => m.content)).toEqual(['partial answer']);
    // The final turn is NOT checkpointed — it stays for the controller's final batch.
    expect(result.persistedResponseCount).toBe(1);
    expect(result.responseMessages.map((m: any) => m.content)).toEqual(['partial answer', 'final answer']);
  });

  it('does NOT checkpoint when persistIncrementally is off (default behavior preserved)', async () => {
    const { addMessagesToSession, run } = drive(false);

    const result = await run();

    expect(addMessagesToSession).not.toHaveBeenCalled();
    expect(result.persistedResponseCount).toBe(0);
    expect(result.responseMessages.map((m: any) => m.content)).toEqual(['partial answer', 'final answer']);
  });

  it('a checkpoint persistence failure never aborts the run; cursor stays 0 for the final batch', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('DynamoDB throttled'));
    const { run } = drive(true, failing);

    // Must not throw — checkpointing is best-effort.
    const result = await run();

    expect(failing).toHaveBeenCalled();
    // Cursor never advanced past the failed write, so the controller's final batch
    // persists the whole tail (no gap, no duplicate).
    expect(result.persistedResponseCount).toBe(0);
    expect(result.responseMessages.map((m: any) => m.content)).toEqual(['partial answer', 'final answer']);
  });

  // ── Error path: no token double-count ──────────────────────────────────────
  // A run that THROWS after a checkpoint must NOT re-report the checkpointed
  // message as partial usage — addMessagesToSession already counted its tokens.
  function driveThenThrow(persistIncrementally: boolean) {
    const { addMessagesToSession } = mockDeps();
    let call = 0;
    jest.spyOn(svc as any, 'callLLM').mockImplementation(async () => {
      call++;
      if (call === 1) return truncatedResponse('turn 1 with usage'); // settles at top of iter 2
      throw new Error('LLM exploded'); // non-transient → propagates to the catch
    });
    return {
      addMessagesToSession,
      run: () =>
        svc.generateMarketingResponse(
          'go', [], 'u', svc.default_model, 'test-session',
          false, undefined, undefined, false, undefined, undefined, undefined, false,
          persistIncrementally
        ),
    };
  }

  it('error after a checkpoint: partialUsageMessages excludes the already-persisted prefix', async () => {
    const { addMessagesToSession, run } = driveThenThrow(true);

    let err: any;
    try { await run(); } catch (e) { err = e; }

    expect(err).toBeDefined();
    // The settled turn-1 message was checkpointed (tokens already counted there)...
    expect(addMessagesToSession).toHaveBeenCalledTimes(1);
    expect(addMessagesToSession.mock.calls[0][1].map((m: any) => m.content)).toEqual(['turn 1 with usage']);
    // ...so it is NOT re-reported for token tracking on the error path (no double-count).
    expect(err.partialUsageMessages).toBeUndefined();
  });

  it('CONTRAST — without checkpointing, the same error DOES report the message as partial usage', async () => {
    const { addMessagesToSession, run } = driveThenThrow(false);

    let err: any;
    try { await run(); } catch (e) { err = e; }

    expect(err).toBeDefined();
    expect(addMessagesToSession).not.toHaveBeenCalled();
    // Nothing was checkpointed, so the usage-bearing turn-1 message is the partial usage.
    expect(err.partialUsageMessages).toHaveLength(1);
    expect(err.partialUsageMessages[0].content).toBe('turn 1 with usage');
  });

  // ── Cancel/Stop ───────────────────────────────────────────────────────────
  it('cancel mid-run keeps the checkpointed prior turn and drops the in-flight turn', async () => {
    const { addMessagesToSession } = mockDeps();
    jest.spyOn(svc as any, 'callLLM').mockImplementation(async () => truncatedResponse('a turn'));
    // Stop as soon as the first checkpoint has been written.
    const isCancelled = () => addMessagesToSession.mock.calls.length > 0;

    const result = await svc.generateMarketingResponse(
      'go', [], 'u', svc.default_model, 'test-session',
      false, undefined, undefined, false, isCancelled, undefined, undefined, false,
      true
    );

    expect(result.cancelled).toBe(true);
    // The completed prior turn was checkpointed and stays (real work, not a ghost)...
    expect(addMessagesToSession).toHaveBeenCalledTimes(1);
    expect(result.persistedResponseCount).toBe(1);
    // ...while the in-flight turn the user stopped was never persisted by a checkpoint.
    expect(addMessagesToSession.mock.calls[0][1]).toHaveLength(1);
  });
});
