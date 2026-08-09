import {
  attemptSessionScore,
  scoreSessionIfNeeded,
  MAX_TRANSCRIPT_CHARS_FOR_SCORING,
  TRANSCRIPT_TRUNCATION_MARKER,
  scoringTimeoutMs,
  SCORING_TIMEOUT_BASE_MS,
  SCORING_TIMEOUT_MAX_MS,
} from '../services/sessionScoringService';
import { ChatMessage, chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
    resolveGenerationModel: (m: string) => ({ model: m, fellBack: false, requestedModel: m }),
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

const llmOk = () =>
  ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            score: 4,
            reason: 'ok',
            dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 },
          }),
        },
      },
    ],
  } as any);

/**
 * A completed, long scheduled run — the ENG-929 shape: many turns, each carrying
 * a sizeable assistant report, ending on a real assistant summary.
 */
function bigScheduledSession(turnChars: number, turns = 20) {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are an automated scheduled run.' } as any,
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `step ${i}` } as any);
    messages.push({ role: 'assistant', content: `report ${i} ${'x'.repeat(turnChars)}` } as any);
  }
  return {
    sessionId: 'big-1',
    userId: 'u1',
    sessionType: 'scheduled',
    pageIdentifier: 'Scheduled: Weekly Meta Creative Fatigue Report|scheduleId:abc',
    messageCount: messages.length,
    updatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    messages,
  } as any;
}

describe('ENG-929 — long transcripts must still be scorable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLM.mockResolvedValue(llmOk());
  });

  it('caps the transcript handed to the judge instead of sending an unbounded one (FAIL boundary)', async () => {
    const session = bigScheduledSession(5000, 30);

    await scoreSessionIfNeeded(session);

    expect(mockCallLLM).toHaveBeenCalled();
    const userTurn = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user');
    expect(userTurn.content.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS_FOR_SCORING + 2000);
    expect(userTurn.content).toContain(TRANSCRIPT_TRUNCATION_MARKER);
    // Head AND tail of the scored window are preserved — the final turn is what
    // goal completion is judged on, and the opening turns carry the request.
    // (The window itself is the last MAX_MESSAGES_FOR_SCORING messages.)
    expect(userTurn.content).toContain('report 6');
    expect(userTurn.content).toContain('report 29');
  });

  it('labels a score produced from a truncated transcript', async () => {
    const session = bigScheduledSession(5000, 30);

    const score = await scoreSessionIfNeeded(session);

    expect(score).toBeTruthy();
    expect((score as any).transcriptTruncated).toBe(true);
    expect(mockUpdateScore).toHaveBeenCalledWith(
      'big-1',
      expect.objectContaining({ transcriptTruncated: true })
    );
  });

  it('does not label or truncate a short transcript (SUCCESS path)', async () => {
    const session = bigScheduledSession(50, 3);

    const score = await scoreSessionIfNeeded(session);

    expect(score).toBeTruthy();
    expect((score as any).transcriptTruncated).toBeUndefined();
    const userTurn = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user');
    expect(userTurn.content).not.toContain(TRANSCRIPT_TRUNCATION_MARKER);
  });

  it('allows a bigger transcript more wall-clock than the 20s baseline, bounded by a ceiling', () => {
    expect(scoringTimeoutMs('')).toBe(SCORING_TIMEOUT_BASE_MS);
    expect(scoringTimeoutMs('x'.repeat(30000))).toBeGreaterThan(SCORING_TIMEOUT_BASE_MS);
    expect(scoringTimeoutMs('x'.repeat(10_000_000))).toBe(SCORING_TIMEOUT_MAX_MS);
  });

  it('reports a scorer failure as a failure instead of a silent null (FAIL path)', async () => {
    mockCallLLM.mockRejectedValue(new Error('Scoring LLM call timed out'));
    const session = bigScheduledSession(200, 5);

    await expect(attemptSessionScore(session)).rejects.toThrow('Scoring LLM call timed out');
  });
});

describe('ENG-929 — attemptSessionScore reports why a session was not scored', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLM.mockResolvedValue(llmOk());
  });

  it('reports in-flight for a turn-less session inside the grace window', async () => {
    const session = {
      sessionId: 'inflight-1',
      userId: 'u1',
      sessionType: 'scheduled',
      pageIdentifier: 'Scheduled: Daily Slack Check|scheduleId:abc',
      messageCount: 2,
      updatedAt: new Date().toISOString(),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Run the daily check.' },
      ],
    } as any;

    const attempt = await attemptSessionScore(session);

    expect(attempt.score).toBeNull();
    expect(attempt.skipReason).toBe('in-flight');
  });

  it('reports already-scored for an up-to-date score', async () => {
    const session = bigScheduledSession(50, 2);
    session.satisfactionScore = {
      score: 4,
      reason: 'r',
      evaluatedAt: '2026-01-01T00:00:00Z',
      evaluatedMessageIndex: session.messageCount,
      dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 },
    };

    const attempt = await attemptSessionScore(session);

    expect(attempt.score).toBeNull();
    expect(attempt.skipReason).toBe('already-scored');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('reports a scored outcome on the happy path', async () => {
    const attempt = await attemptSessionScore(bigScheduledSession(50, 2));

    expect(attempt.skipReason).toBeUndefined();
    expect(attempt.score).toEqual(expect.objectContaining({ score: 4 }));
  });
});
