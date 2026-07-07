import {
  scoreSessionsWithinBudget,
  SYNC_SCORING_BUDGET_MS,
} from '../services/sessionScoringService';
import { ChatSession, chatbotDb } from '../services/chatbotService';
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

// A configured scoring judge (the multi-judge slow path from the bug report).
function makeJudge(id: string) {
  return {
    id,
    name: `Judge ${id}`,
    systemPrompt: 'Rate this conversation.',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeLLMResponse(score: number, reason: string) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            score,
            reason,
            dimensions: { goalCompletion: score, dataAccuracy: score, outputQuality: score },
          }),
        },
      },
    ],
  } as any;
}

// A settled, scoreable session (has a real assistant turn, no existing score).
function makeScoreableSession(id: string): ChatSession {
  return {
    sessionId: id,
    userId: 'u1',
    sessionType: 'regular',
    messages: [
      { role: 'user', content: 'Do the thing.' },
      { role: 'assistant', content: 'Done.' },
    ],
    messageCount: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  } as any;
}

// A deterministic fake clock: each call advances by `stepMs`.
function fakeClock(stepMs: number, start = 0) {
  let t = start;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

describe('scoreSessionsWithinBudget (ENG-190 — degrade gracefully instead of aborting)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'good'));
  });

  it('scores every session and reports complete=true when the batch fits the budget', async () => {
    const sessions = ['a', 'b', 'c'].map(makeScoreableSession);

    const summary = await scoreSessionsWithinBudget(sessions, [], {
      budgetMs: 10_000,
      now: fakeClock(1), // trivial elapsed time — never exceeds budget
    });

    expect(summary).toEqual({ processedCount: 3, totalCount: 3, complete: true });
    expect(mockCallLLM).toHaveBeenCalledTimes(3);
    expect(mockUpdateScore).toHaveBeenCalledTimes(3);
  });

  it('stops early with complete=false and partial results when the budget is exhausted', async () => {
    const sessions = ['a', 'b', 'c', 'd'].map(makeScoreableSession);

    // Clock: deadline = 0 + 120 = 120. Session tops observe 50, 100, 150...
    // → sessions a,b scored (50,100 < 120); c stops (150 >= 120).
    const summary = await scoreSessionsWithinBudget(sessions, [], {
      budgetMs: 120,
      now: fakeClock(50),
    });

    expect(summary.complete).toBe(false);
    expect(summary.processedCount).toBe(2);
    expect(summary.totalCount).toBe(4);
    // Only the two sessions that fit the budget were actually scored.
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  it('does not abort the whole batch when one session throws — it logs and continues', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const sessions = ['a', 'b', 'c'].map(makeScoreableSession);

    // First session's LLM call rejects; the rest succeed.
    mockCallLLM
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(makeLLMResponse(4, 'ok'));

    const summary = await scoreSessionsWithinBudget(sessions, [], {
      budgetMs: 10_000,
      now: fakeClock(1),
    });

    expect(summary).toEqual({ processedCount: 3, totalCount: 3, complete: true });
    // All three attempted; two persisted (the failing one did not).
    expect(mockCallLLM).toHaveBeenCalledTimes(3);
    expect(mockUpdateScore).toHaveBeenCalledTimes(2);
  });

  it('is idempotent/resumable: already-scored sessions are skipped without an LLM call', async () => {
    const alreadyScored = makeScoreableSession('scored');
    (alreadyScored as any).satisfactionScore = {
      score: 5,
      reason: 'prev',
      evaluatedAt: '2026-07-01T00:00:00.000Z',
      evaluatedMessageIndex: 2,
      dimensions: { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
    };
    const fresh = makeScoreableSession('fresh');

    const summary = await scoreSessionsWithinBudget([alreadyScored, fresh], [], {
      budgetMs: 10_000,
      now: fakeClock(1),
    });

    expect(summary).toEqual({ processedCount: 2, totalCount: 2, complete: true });
    // Only the un-scored session hit the LLM.
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('re-checks the deadline between judges and stops mid-judge-list when the budget is exhausted', async () => {
    const session = makeScoreableSession('a');
    const judges = [makeJudge('j1'), makeJudge('j2')];

    // Clock advances 50ms per read. deadline = 0 + 120 = 120.
    // Reads: init(0); session-a check(50<120 ok); j1 check(100<120 ok);
    // j2 check(150>=120 → stop before scoring j2, before processedCount++).
    const summary = await scoreSessionsWithinBudget([session], judges, {
      budgetMs: 120,
      now: fakeClock(50),
    });

    expect(summary.complete).toBe(false);
    expect(summary.processedCount).toBe(0);
    expect(summary.totalCount).toBe(1);
    // Default score (1) + first judge (1) ran; the second judge was never called.
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(mockUpdateJudgeScore).toHaveBeenCalledTimes(1);
    expect(mockUpdateJudgeScore).toHaveBeenCalledWith('a', 'j1', expect.anything());
  });

  it('isolates a judge that throws — it logs and continues to the remaining judges', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const session = makeScoreableSession('a');
    const judges = [makeJudge('j1'), makeJudge('j2')];

    // Calls in order: default score (ok), judge j1 (throws), judge j2 (ok).
    mockCallLLM
      .mockResolvedValueOnce(makeLLMResponse(5, 'good'))
      .mockRejectedValueOnce(new Error('judge boom'))
      .mockResolvedValue(makeLLMResponse(4, 'ok'));

    const summary = await scoreSessionsWithinBudget([session], judges, {
      budgetMs: 10_000,
      now: fakeClock(1),
    });

    expect(summary).toEqual({ processedCount: 1, totalCount: 1, complete: true });
    // All three LLM calls attempted despite the middle one throwing.
    expect(mockCallLLM).toHaveBeenCalledTimes(3);
    // Only the surviving judge persisted a score; the throwing one did not abort the batch.
    expect(mockUpdateJudgeScore).toHaveBeenCalledTimes(1);
    expect(mockUpdateJudgeScore).toHaveBeenCalledWith('a', 'j2', expect.anything());
  });

  it('exposes a default budget well under the 5-minute request timeout', () => {
    expect(SYNC_SCORING_BUDGET_MS).toBeLessThan(5 * 60 * 1000);
    expect(SYNC_SCORING_BUDGET_MS).toBeGreaterThan(0);
  });
});
