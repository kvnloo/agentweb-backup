import {
  scoreSessionIfNeeded,
  scoreSessionWithJudgeIfNeeded,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage, chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSatisfactionScore: jest.fn().mockResolvedValue({}),
    updateSessionJudgeScore: jest.fn().mockResolvedValue({}),
    addMessageToSession: jest.fn().mockResolvedValue({}),
    updateSessionError: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;
const mockUpdateScore = chatbotDb.updateSessionSatisfactionScore as jest.Mock;
const mockUpdateJudgeScore = chatbotDb.updateSessionJudgeScore as jest.Mock;
const mockAddMessage = chatbotDb.addMessageToSession as jest.Mock;
const mockUpdateError = chatbotDb.updateSessionError as jest.Mock;

function makeLLMResponse(score: number, reason: string, dimensions?: object) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, ...(dimensions ? { dimensions } : {}) }) } }],
  } as any;
}

// Timestamps relative to "now" so the in-flight vs. crashed (stale) distinction
// is exercised regardless of when the test runs. The grace window is 60 minutes.
const isoMinutesAgo = (mins: number) => new Date(Date.now() - mins * 60 * 1000).toISOString();
const RECENT = () => isoMinutesAgo(2); // well within the 60-min grace window
const STALE = () => isoMinutesAgo(90); // comfortably past the grace window

const testJudge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'Rate this conversation.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// A scheduled "Daily Satisfaction Score Report" session captured mid-run, while it
// is itself executing the get_chat_history(sync=true) tool. The assistant response
// has NOT been persisted yet, so the session only contains the system + injected
// user prompt. This is the exact state that previously scored 1/5.
const turnlessMessages: ChatMessage[] = [
  { role: 'system', content: 'You are an automated scheduled run.' } as any,
  { role: 'user', content: 'Generate the daily satisfaction score report.' },
];

describe('SessionScoring - in-flight sessions (no assistant turn, recently updated)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scoreSessionIfNeeded returns null for a recently-updated turn-less session', async () => {
    const session = {
      sessionId: 'in-flight-1',
      userId: 'u1',
      pageIdentifier: 'Scheduled: Daily Satisfaction Score Report|scheduleId:abc',
      sessionType: 'scheduled',
      messages: turnlessMessages,
      messageCount: turnlessMessages.length,
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateScore).not.toHaveBeenCalled();
  });

  it('scoreSessionWithJudgeIfNeeded returns null for a recently-updated turn-less session', async () => {
    const session = {
      sessionId: 'in-flight-2',
      userId: 'u1',
      pageIdentifier: 'Scheduled: Daily Satisfaction Score Report|scheduleId:abc',
      sessionType: 'scheduled',
      messages: turnlessMessages,
      messageCount: turnlessMessages.length,
      judgeScores: {},
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionWithJudgeIfNeeded(session, testJudge);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudgeScore).not.toHaveBeenCalled();
  });

  it('does not score a recent session whose only assistant message is empty (no content, no tool calls)', async () => {
    const session = {
      sessionId: 'in-flight-3',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: '' } as any,
      ],
      messageCount: 2,
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });
});

describe('SessionScoring - failed runs (no assistant turn, stale)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scoreSessionIfNeeded scores a stale turn-less session 1/5 as a failed run without calling the LLM', async () => {
    const session = {
      sessionId: 'crashed-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: turnlessMessages,
      messageCount: turnlessMessages.length,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(1);
    expect(result?.reason).toMatch(/crashed or timed out|failed run/i);
    expect(result?.dimensions).toEqual({ goalCompletion: 1, dataAccuracy: 1, outputQuality: 1 });
    // No transcript to evaluate — must not invoke the judge LLM
    expect(mockCallLLM).not.toHaveBeenCalled();
    // ...but the failure must be persisted so it surfaces in reporting
    expect(mockUpdateScore).toHaveBeenCalledTimes(1);
  });

  it('scoreSessionWithJudgeIfNeeded scores a stale turn-less session 1/5 as a failed run', async () => {
    const session = {
      sessionId: 'crashed-2',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: turnlessMessages,
      messageCount: turnlessMessages.length,
      judgeScores: {},
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionWithJudgeIfNeeded(session, testJudge);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(1);
    expect(result?.dimensions).toEqual({ goalCompletion: 1, dataAccuracy: 1, outputQuality: 1 });
    expect(result?.judgeName).toBe('Test Judge');
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudgeScore).toHaveBeenCalledTimes(1);
  });

  it('treats a turn-less session with a missing updatedAt as a failed run', async () => {
    const session = {
      sessionId: 'crashed-3',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: turnlessMessages,
      messageCount: turnlessMessages.length,
      createdAt: RECENT(),
      // updatedAt intentionally omitted
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(1);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });
});

describe('SessionScoring - sessions with an assistant turn score normally', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scores a session once an assistant text response is present', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'completed', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const session = {
      sessionId: 'completed-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: 'Here is the report: ...' },
      ],
      messageCount: 2,
      // Even if stale, a session WITH an assistant turn is scored on its content
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(5);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockUpdateScore).toHaveBeenCalledTimes(1);
  });

  // This shape (ends in tool result, RECENT) is mid-loop — must be deferred, not scored.
  // The previous test name was wrong; this is now a negative test for the fix.
  it('defers (returns null) a recent session ending in a tool result — mid-loop, not settled', async () => {
    const session = {
      sessionId: 'mid-loop-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'get_chat_history' }] } } as any,
        { role: 'tool', content: 'sessions: [...]' } as any,
      ],
      messageCount: 3,
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateScore).not.toHaveBeenCalled();
  });

  it('defers a recent session whose last message is a pure tool-call assistant turn (no text)', async () => {
    const session = {
      sessionId: 'mid-loop-2',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'get_chat_history' }] } } as any,
      ],
      messageCount: 2,
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('scores a stale session ending in a tool result (never skipped forever)', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(2, 'partial run', { goalCompletion: 2, dataAccuracy: 2, outputQuality: 2 })
    );

    const session = {
      sessionId: 'mid-loop-stale-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'get_chat_history' }] } } as any,
        { role: 'tool', content: 'sessions: [...]' } as any,
      ],
      messageCount: 3,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(2);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockUpdateScore).toHaveBeenCalledTimes(1);
  });

  it('scores a settled session: assistant text + aggregated toolCalls (completed scheduled run shape)', async () => {
    // Mirrors the real prod session shape: final assistant message has BOTH
    // natural-language report text AND an aggregated toolCalls array.
    // This must NOT be deferred — it is fully settled.
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'report delivered', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const session = {
      sessionId: 'settled-with-toolcalls-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Generate the daily satisfaction score report.' },
        { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'get_chat_history' }] } } as any,
        { role: 'tool', content: 'sessions: [...]' } as any,
        {
          role: 'assistant',
          content: 'Here is the daily satisfaction score report...',
          metadata: { toolCalls: [{ name: 'get_chat_history' }, { name: 'send_email' }] },
        } as any,
      ],
      messageCount: 4,
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(5);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockUpdateScore).toHaveBeenCalledTimes(1);
  });

  it('judge path: defers a recent mid-loop session', async () => {
    const session = {
      sessionId: 'mid-loop-judge-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'get_chat_history' }] } } as any,
        { role: 'tool', content: 'sessions: [...]' } as any,
      ],
      messageCount: 3,
      judgeScores: {},
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionWithJudgeIfNeeded(session, testJudge);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudgeScore).not.toHaveBeenCalled();
  });

  it('judge scoring proceeds once an assistant turn is present', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'good run'));

    const session = {
      sessionId: 'completed-3',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: 'Report generated.' },
      ],
      messageCount: 2,
      judgeScores: {},
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionWithJudgeIfNeeded(session, testJudge);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(5);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockUpdateJudgeScore).toHaveBeenCalledTimes(1);
  });

  it('defers a recent session ending in a trailing user message', async () => {
    const session = {
      sessionId: 'mid-loop-trailing-user-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: 'Report generated.' },
        { role: 'user', content: 'Thanks!' },
      ],
      messageCount: 3,
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateScore).not.toHaveBeenCalled();
  });

  it('judge path: stale mid-loop session is scored, not skipped forever', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(2, 'partial run', { goalCompletion: 2, dataAccuracy: 2, outputQuality: 2 })
    );

    const session = {
      sessionId: 'mid-loop-judge-stale-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: [
        { role: 'user', content: 'Run the report.' },
        { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'get_chat_history' }] } } as any,
        { role: 'tool', content: 'sessions: [...]' } as any,
      ],
      messageCount: 3,
      judgeScores: {},
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionWithJudgeIfNeeded(session, testJudge);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(2);
    expect(result?.judgeName).toBe('Test Judge');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockUpdateJudgeScore).toHaveBeenCalledTimes(1);
  });
});

describe('SessionScoring - surfacing silent dead runs (ENG-473)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // A regular (non-scheduled) interactive run whose owning process died mid-run
  // (OOM/SIGKILL). Only the system + user prompt were persisted; no assistant
  // reply, no tokens. Previously left as a silent dead chat with no explanation.
  const regularTurnless: ChatMessage[] = [
    { role: 'system', content: 'You are EMMA.' } as any,
    { role: 'user', content: 'Draft a Meta lead-gen campaign.' },
  ];

  it('leaves a user-facing retry note + diagnostic error on a stale regular dead run', async () => {
    const session = {
      sessionId: 'dead-regular-1',
      userId: 'u1',
      sessionType: 'regular',
      pageIdentifier: 'agent-mode',
      messages: [...regularTurnless],
      messageCount: regularTurnless.length,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    // Still scored as a deterministic failed run (no LLM call).
    expect(result?.score).toBe(1);
    expect(mockCallLLM).not.toHaveBeenCalled();

    // Silent dead session becomes visible: one user-facing assistant note...
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    const [sid, msg] = mockAddMessage.mock.calls[0];
    expect(sid).toBe('dead-regular-1');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toMatch(/didn't finish|send your message again|retry/i);
    expect(msg.metadata.isRunFailureNotice).toBe(true);
    expect(msg.metadata.isErrorMessage).toBe(true);

    // ...and a diagnostic error field, mirroring the scheduled reconciler.
    expect(mockUpdateError).toHaveBeenCalledTimes(1);
    expect(mockUpdateError.mock.calls[0][0]).toBe('dead-regular-1');
    // The persisted reason must be the FAILED_RUN_REASON diagnostic, not a placeholder.
    expect(mockUpdateError.mock.calls[0][1]).toMatch(/crashed or timed out|failed run/i);
  });

  it('does NOT surface a note while the turn-less run is still in-flight (recent)', async () => {
    const session = {
      sessionId: 'inflight-regular-1',
      userId: 'u1',
      sessionType: 'regular',
      messages: [...regularTurnless],
      messageCount: regularTurnless.length,
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockUpdateError).not.toHaveBeenCalled();
  });

  it('is idempotent — never double-adds the note when one is already present', async () => {
    const nowIso = new Date().toISOString();
    const session = {
      sessionId: 'dead-regular-2',
      userId: 'u1',
      sessionType: 'regular',
      messages: [
        ...regularTurnless,
        {
          role: 'assistant',
          content: "This run didn't finish — please retry.",
          metadata: { isErrorMessage: true, isRunFailureNotice: true, timestamp: nowIso },
        } as any,
      ],
      messageCount: 3,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    // The pre-existing notice must NOT count as a real assistant turn: the run is
    // still classified as a deterministic failed run (no LLM), and no duplicate
    // note or error write is issued.
    expect(result?.score).toBe(1);
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockUpdateError).not.toHaveBeenCalled();
  });

  it('swallows a persistence failure while surfacing the note — scoring still succeeds', async () => {
    // The annotation is best-effort: if addMessageToSession (or updateSessionError)
    // rejects, the failure must be logged and NOT propagated — the session is still
    // scored 1/5 and that score is still persisted.
    mockAddMessage.mockRejectedValueOnce(new Error('boom'));
    mockUpdateError.mockRejectedValueOnce(new Error('boom'));
    const session = {
      sessionId: 'dead-regular-persist-fail-1',
      userId: 'u1',
      sessionType: 'regular',
      messages: [...regularTurnless],
      messageCount: regularTurnless.length,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    // Persistence failure is swallowed, not propagated.
    expect(result?.score).toBe(1);
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateScore).toHaveBeenCalledTimes(1);
  });

  it('does NOT surface a note on a healthy run that produced a real assistant reply', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'great', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );
    const session = {
      sessionId: 'healthy-1',
      userId: 'u1',
      sessionType: 'regular',
      messages: [
        ...regularTurnless,
        { role: 'assistant', content: 'Here is your campaign draft.' } as any,
      ],
      messageCount: 3,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    await scoreSessionIfNeeded(session);

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockUpdateError).not.toHaveBeenCalled();
  });
});
