/**
 * ENG-830 (completion pass): close the four residual gaps left by the first fix.
 *
 *  A. A no-task session that CRASHED must still be flagged as a failed run —
 *     the exclusion must not swallow reliability failures.
 *  B. The Slack sender-name strip must handle every real display name (digits,
 *     parentheses, long/short names), not just 1-4 plain alphabetic words.
 *  C. Novel zero-task phrasings the static phrase list cannot enumerate are
 *     caught by the judge itself via `taskRequested:false` — and the signal
 *     fails OPEN so a missing/garbled field never silently drops a session.
 *  D. A session that was already scored BEFORE the exclusion existed has its
 *     stale score retracted, so historical cohorts self-heal.
 */

const mockUpdateSessionSatisfactionScore = jest.fn().mockResolvedValue({});
const mockClearSessionSatisfactionScore = jest.fn().mockResolvedValue(true);
const mockUpdateSessionJudgeScore = jest.fn().mockResolvedValue({});
const mockClearSessionJudgeScore = jest.fn().mockResolvedValue(true);
const mockUpdateSessionError = jest.fn().mockResolvedValue({});
const mockAddMessageToSession = jest.fn().mockResolvedValue({});
const mockCallLLM = jest.fn();
const mockGetSetting = jest.fn().mockResolvedValue(null);

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSatisfactionScore: (...a: any[]) => mockUpdateSessionSatisfactionScore(...a),
    clearSessionSatisfactionScore: (...a: any[]) => mockClearSessionSatisfactionScore(...a),
    updateSessionJudgeScore: (...a: any[]) => mockUpdateSessionJudgeScore(...a),
    clearSessionJudgeScore: (...a: any[]) => mockClearSessionJudgeScore(...a),
    updateSessionError: (...a: any[]) => mockUpdateSessionError(...a),
    addMessageToSession: (...a: any[]) => mockAddMessageToSession(...a),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: (...a: any[]) => mockCallLLM(...a),
    resolveGenerationModel: (m: string) => ({ model: m, fellBack: false }),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: any[]) => mockGetSetting(...a) },
}));

import {
  isNoTaskSession,
  scoreSessionIfNeeded,
  scoreSessionWithJudgeIfNeeded,
  NO_TASK_JUDGMENT_CLAUSE,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage, ChatSession } from '../services/chatbotService';

const u = (content: string): ChatMessage => ({ role: 'user', content } as any);
const a = (content: string): ChatMessage => ({ role: 'assistant', content } as any);

const JUDGE: ScoringJudge = {
  id: 'judge_1',
  name: 'Fangfang Judge',
  systemPrompt: 'You are a judge. Respond with ONLY valid JSON.',
  createdAt: '',
  updatedAt: '',
};

/** LLM reply helper. */
const llmReply = (obj: any) => ({
  choices: [{ message: { content: JSON.stringify(obj) } }],
});

const FULL_SCORE = {
  score: 4,
  reason: 'ok',
  dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 },
};

// Well past IN_FLIGHT_GRACE_MS (60 min) — a fixture sitting exactly ON the
// boundary flips between "in-flight" and "failed" on millisecond drift.
const STALE_AGE_MS = 3 * 60 * 60 * 1000;

const baseSession = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    sessionId: 's1',
    userId: 'u1',
    createdAt: new Date(Date.now() - STALE_AGE_MS).toISOString(),
    updatedAt: new Date(Date.now() - STALE_AGE_MS).toISOString(),
    ...over,
  } as any);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSetting.mockResolvedValue(null);
  mockCallLLM.mockResolvedValue(llmReply(FULL_SCORE));
  // Retraction writes to production data and is gated behind the data-plane
  // approval flag; enable it for the retraction tests specifically.
  process.env.SCORING_RETRACT_STALE_SCORES = 'true';
});

afterEach(() => {
  delete process.env.SCORING_RETRACT_STALE_SCORES;
});

// ---------------------------------------------------------------- A. crash wins
describe('ENG-830 A — a crashed no-task session is still flagged as a failed run', () => {
  const crashed = (pageIdentifier?: string) =>
    baseSession({
      messages: [u('Adam Cai: wait')] as any, // no assistant turn at all
      messageCount: 1,
      pageIdentifier,
    });

  it('scores a stale turn-less no-task session as a failed run instead of excluding it', async () => {
    const session = crashed('slack-triggered');
    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
    // and it surfaces the failure to the user rather than staying a silent dead chat
    expect(mockUpdateSessionError).toHaveBeenCalled();
    expect(mockAddMessageToSession).toHaveBeenCalled();
  });

  it('flags the failed run on the custom-judge path too', async () => {
    const result = await scoreSessionWithJudgeIfNeeded(crashed('slack-triggered'), JUDGE);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
  });

  it('still excludes the no-task session once a real assistant turn exists', async () => {
    const session = baseSession({
      messages: [u('Adam Cai: wait'), a('Standing by 👍')] as any,
      messageCount: 2,
      pageIdentifier: 'slack-triggered',
    });
    expect(await scoreSessionIfNeeded(session)).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------- B. robust prefix strip
describe('ENG-830 B — Slack sender-name strip covers every real display name', () => {
  it.each([
    'Fangfang Tan: Hi',
    'Adam Cai: hi',
    'Adam2 Cai: hi',                       // digits in the name
    'Fangfang Tan (Marketing): hi',        // parenthesised team suffix
    'Maria de la Cruz-Hernandez Jr.: hi',  // 5+ words, punctuation
    'adam: hi',                            // lowercase single word
    'A: hi',                               // single letter
    '田中 太郎: hi',                        // non-latin script
  ])('treats %j as a no-task Slack turn', (text) => {
    expect(isNoTaskSession([u(text), a('Hello!')], 'slack-triggered')).toBe(true);
  });

  it('still scores a Slack turn that carries a real request after the prefix', () => {
    expect(
      isNoTaskSession([u('Fangfang Tan: Can you draft a LinkedIn post?')], 'slack-triggered')
    ).toBe(false);
  });

  it('does not strip a colon that belongs to the user text itself', () => {
    // first colon separates the display name; the rest of the text is preserved
    expect(
      isNoTaskSession([u('Adam Cai: Write a post about: our new pricing')], 'slack-triggered')
    ).toBe(false);
  });

  it('never strips on a non-Slack session, so a labelled instruction stays scorable', () => {
    for (const pid of [undefined, 'dashboard', 'emma-sidebar']) {
      expect(isNoTaskSession([u('Reply to this: Hi')], pid)).toBe(false);
      expect(isNoTaskSession([u('Note: ok')], pid)).toBe(false);
    }
  });
});

// --------------------------------------------------- C. LLM backstop, fail-open
describe('ENG-830 C — judge-reported taskRequested:false is the backstop', () => {
  const novel = () =>
    baseSession({
      // phrasing no static list can enumerate
      messages: [u('hey, just checking in on things'), a('Hi! Nothing pending.')] as any,
      messageCount: 2,
    });

  it('appends the taskRequested clause to the system prompt even when a DB override is set', async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === 'default-scoring-prompt' ? { settingValue: 'CUSTOM PROD PROMPT' } : null
    );
    await scoreSessionIfNeeded(novel());

    const systemPrompt = mockCallLLM.mock.calls[0][1][0].content;
    expect(systemPrompt).toContain('CUSTOM PROD PROMPT');
    expect(systemPrompt).toContain(NO_TASK_JUDGMENT_CLAUSE);
  });

  it('excludes the session (no score persisted) when the judge reports taskRequested:false', async () => {
    mockCallLLM.mockResolvedValue(llmReply({ ...FULL_SCORE, score: 3, taskRequested: false }));

    expect(await scoreSessionIfNeeded(novel())).toBeNull();
    expect(mockUpdateSessionSatisfactionScore).not.toHaveBeenCalled();
  });

  it('applies the same backstop on the custom-judge path, aligning the judges', async () => {
    mockCallLLM.mockResolvedValue(llmReply({ ...FULL_SCORE, score: 3, taskRequested: false }));

    expect(await scoreSessionWithJudgeIfNeeded(novel(), JUDGE)).toBeNull();
    expect(mockUpdateSessionJudgeScore).not.toHaveBeenCalled();

    const judgePrompt = mockCallLLM.mock.calls[0][1][0].content;
    expect(judgePrompt).toContain(JUDGE.systemPrompt);
    expect(judgePrompt).toContain(NO_TASK_JUDGMENT_CLAUSE);
  });

  it.each([
    ['field absent', FULL_SCORE],
    ['taskRequested true', { ...FULL_SCORE, taskRequested: true }],
    ['garbled value', { ...FULL_SCORE, taskRequested: 'maybe' }],
    ['null value', { ...FULL_SCORE, taskRequested: null }],
  ])('fails OPEN and still scores when the signal is unusable (%s)', async (_l, payload) => {
    mockCallLLM.mockResolvedValue(llmReply(payload));

    const result = await scoreSessionIfNeeded(novel());
    expect(result).not.toBeNull();
    expect(mockUpdateSessionSatisfactionScore).toHaveBeenCalled();
  });
});

// ------------------------------------------------------- D. retract stale score
describe('ENG-830 D — stale scores on no-task sessions are retracted', () => {
  const alreadyScored = () =>
    baseSession({
      messages: [u('Fangfang Tan: Hi'), a('Emma here — how can I help?')] as any,
      messageCount: 2,
      pageIdentifier: 'slack-bot',
      satisfactionScore: {
        score: 3,
        reason: 'only a greeting',
        evaluatedAt: '2026-08-01T14:01:01.212Z',
        evaluatedMessageIndex: 2,
        dimensions: { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
      } as any,
      judgeScores: {
        judge_1: {
          score: 3,
          reason: 'no task',
          evaluatedAt: '2026-08-01T14:01:01.212Z',
          evaluatedMessageIndex: 2,
          judgeName: 'Fangfang Judge',
          dimensions: { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
        },
      } as any,
    });

  it('clears a persisted satisfaction score so the session leaves the ≤3 cohort', async () => {
    const session = alreadyScored();
    const original = session.satisfactionScore;
    expect(await scoreSessionIfNeeded(session)).toBeNull();

    // archived, not dropped — the retraction stays reversible
    expect(mockClearSessionSatisfactionScore).toHaveBeenCalledWith('s1', original);
    expect(session.satisfactionScore).toBeUndefined(); // in-memory copy too
    expect(mockCallLLM).not.toHaveBeenCalled();        // no LLM spend to retract
  });

  it('clears a persisted judge score as well', async () => {
    const session = alreadyScored();
    const original = session.judgeScores!.judge_1;
    expect(await scoreSessionWithJudgeIfNeeded(session, JUDGE)).toBeNull();

    expect(mockClearSessionJudgeScore).toHaveBeenCalledWith('s1', 'judge_1', original);
    expect(session.judgeScores?.judge_1).toBeUndefined();
  });

  it('writes NOTHING to production while the data-plane flag is off, but still excludes', async () => {
    delete process.env.SCORING_RETRACT_STALE_SCORES;
    const session = alreadyScored();

    // the session is still kept out of the cohort — only the cleanup is gated
    expect(await scoreSessionIfNeeded(session)).toBeNull();
    expect(await scoreSessionWithJudgeIfNeeded(session, JUDGE)).toBeNull();

    expect(mockClearSessionSatisfactionScore).not.toHaveBeenCalled();
    expect(mockClearSessionJudgeScore).not.toHaveBeenCalled();
    expect(mockUpdateSessionSatisfactionScore).not.toHaveBeenCalled();
    expect(session.satisfactionScore).toBeDefined(); // untouched
  });

  it('the flag is read per call, so flipping it takes effect without a restart', async () => {
    delete process.env.SCORING_RETRACT_STALE_SCORES;
    expect(await scoreSessionIfNeeded(alreadyScored())).toBeNull();
    expect(mockClearSessionSatisfactionScore).not.toHaveBeenCalled();

    process.env.SCORING_RETRACT_STALE_SCORES = 'true';
    expect(await scoreSessionIfNeeded(alreadyScored())).toBeNull();
    expect(mockClearSessionSatisfactionScore).toHaveBeenCalled();
  });

  it('is idempotent — a session with nothing to retract issues no write', async () => {
    const session = baseSession({
      messages: [u('Fangfang Tan: Hi'), a('Hello!')] as any,
      messageCount: 2,
      pageIdentifier: 'slack-bot',
    });
    expect(await scoreSessionIfNeeded(session)).toBeNull();
    expect(mockClearSessionSatisfactionScore).not.toHaveBeenCalled();
  });

  it('never retracts a score an admin has overridden', async () => {
    const session = alreadyScored();
    (session.satisfactionScore as any).adminOverride = true;

    expect(await scoreSessionIfNeeded(session)).toBeNull();
    expect(mockClearSessionSatisfactionScore).not.toHaveBeenCalled();
    expect(session.satisfactionScore).toBeDefined();
  });

  it('retracts the stale score of a session the judge later deems task-free', async () => {
    // static list does not match, but the judge reports taskRequested:false
    mockCallLLM.mockResolvedValue(llmReply({ ...FULL_SCORE, taskRequested: false }));
    const session = baseSession({
      messages: [u('hey, just checking in'), a('Nothing pending!')] as any,
      messageCount: 2,
      satisfactionScore: {
        score: 3,
        reason: 'stale',
        evaluatedAt: '2026-08-01T00:00:00.000Z',
        evaluatedMessageIndex: 1, // out of date -> re-evaluated
        dimensions: { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
      } as any,
    });

    expect(await scoreSessionIfNeeded(session)).toBeNull();
    expect(mockClearSessionSatisfactionScore).toHaveBeenCalledWith('s1', expect.anything());
    expect(mockUpdateSessionSatisfactionScore).not.toHaveBeenCalled();
  });

  it('keeps the in-memory score when the retraction lost the race to a re-score', async () => {
    // The conditional write refused: something replaced the score between the
    // read and the write, so the row still HAS a score and the copy we hand
    // back to the caller must say so.
    mockClearSessionSatisfactionScore.mockResolvedValueOnce(false);
    const session = alreadyScored();

    expect(await scoreSessionIfNeeded(session)).toBeNull();
    expect(session.satisfactionScore).toBeDefined();
  });

  it('keeps the in-memory judge score when that retraction lost the race', async () => {
    mockClearSessionJudgeScore.mockResolvedValueOnce(false);
    const session = alreadyScored();

    expect(await scoreSessionWithJudgeIfNeeded(session, JUDGE)).toBeNull();
    expect(session.judgeScores?.judge_1).toBeDefined();
  });

  it('a retraction failure never breaks the scoring sweep', async () => {
    mockClearSessionSatisfactionScore.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(scoreSessionIfNeeded(alreadyScored())).resolves.toBeNull();
  });
});
