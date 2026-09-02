/**
 * ENG-1296: in the 2026-08-17 satisfaction window, the Fangfang Judge scored
 * three sessions goalCompletion 3 where the user's request was a genuinely
 * ambiguous fragment and the assistant's only move was to decline to guess
 * and ask one focused clarifying question (correct behavior per the Drafting
 * Direction Guard). Each reason PRAISED the handling in full and docked
 * goalCompletion purely because the conversation ended before the user
 * replied — outside the assistant's control. The general satisfaction judge
 * and Matt Judge scored the same three sessions 5/5/5, proving 3 was a
 * judge-specific scoring artifact, not a real defect.
 *
 * The fix adds:
 *   1. AWAITING_USER_REPLY_CLAUSE, appended at call time (same pattern as
 *      NO_TASK_JUDGMENT_CLAUSE / FABRICATION_GROUNDING_CLAUSE) so a stored
 *      AW-Settings override or a fully custom judge prompt (Fangfang, Matt)
 *      cannot mask it (ENG-392).
 *   2. applyAwaitingReplyGuard: a narrow, code-level backstop that raises a
 *      self-contradictory verdict (goalCompletion <=3, dataAccuracy and
 *      outputQuality both >=4, a reason that AFFIRMATIVELY states the
 *      awaiting-reply/ended-before-response rationale, and no criticism of
 *      the assistant scoped to a clause that actually names the assistant as
 *      its subject) to a passing score, without touching any session where
 *      the judge's own reason actually finds fault or where the low score has
 *      some other, unstated cause.
 */
import {
  scoreSession,
  scoreSessionWithJudge,
  scoreSessionWithJudgeIfNeeded,
  attemptSessionScore,
  DEFAULT_SCORING_SYSTEM_PROMPT,
  AWAITING_USER_REPLY_CLAUSE,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage, ChatSession } from '../services/chatbotService';
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
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

function makeLLMResponse(score: number, dimensions: Record<string, unknown>, reason = 'r') {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, dimensions }) } }],
  } as any;
}

function getSystemPrompt(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const systemMessage = callArgs[1].find((m: any) => m.role === 'system');
  return systemMessage?.content ?? '';
}

const judge: ScoringJudge = {
  id: 'fangfang',
  name: 'Fangfang Judge',
  systemPrompt: 'You are Fangfang, a custom judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const ambiguousFragmentMessages: ChatMessage[] = [
  { role: 'user', content: 'A: @B / @C: can you handle the email blast for the founder segment?' },
  {
    role: 'assistant',
    content:
      "That looks like a fragment of a conversation between other people rather than an instruction to me. " +
      "Could you clarify what you'd like me to do — for example, draft the email blast, or something else?",
  },
];

describe('SessionScoring - awaiting user reply (ENG-1296)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('regression guard: DEFAULT_SCORING_SYSTEM_PROMPT must never hardcode the awaiting-reply rule (appended, not baked in, so an AW-Settings override cannot mask it)', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).not.toContain('ended before the user could respond');
  });

  it('AWAITING_USER_REPLY_CLAUSE tells the judge not to score goalCompletion on whether the user replied', () => {
    expect(AWAITING_USER_REPLY_CLAUSE).toMatch(/goalCompletion/);
    expect(AWAITING_USER_REPLY_CLAUSE).toContain('NOT on whether the user has replied');
  });

  it('scoreSession appends AWAITING_USER_REPLY_CLAUSE to the system prompt', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    await scoreSession(ambiguousFragmentMessages, ambiguousFragmentMessages.length);

    expect(getSystemPrompt()).toContain('clarifying question');
  });

  it('scoreSessionWithJudge appends AWAITING_USER_REPLY_CLAUSE even for a fully custom judge prompt (Fangfang/Matt Judge)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    const prompt = getSystemPrompt();
    expect(prompt).toContain('You are Fangfang, a custom judge.');
    expect(prompt).toContain('clarifying question');
  });

  it('REGRESSION FIXTURE (session c6329daa): raises a Fangfang-shaped verdict that docks goalCompletion purely for the conversation ending before the user replied', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        3,
        { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
        'The user provided a very brief, ambiguous instruction. The assistant correctly identified that it was ' +
          'a fragment, prevented any accidental actions, and provided a clear, structured request for ' +
          'clarification. Since the conversation ended before the user could respond, the goal is not yet ' +
          'fully completed, resulting in a neutral score.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.dimensions?.goalCompletion).toBeGreaterThanOrEqual(4);
  });

  it('REGRESSION FIXTURE (session cf363dcb): raises a verdict praising the handling "excellently" but docking goalCompletion for the conversation ending', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        3,
        { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
        'The assistant handled it excellently by offering clear, structured interpretations and asking for ' +
          'clarification, but the conversation ended before the goal could be fully achieved.'
      )
    );

    const result = await scoreSession(ambiguousFragmentMessages, ambiguousFragmentMessages.length);

    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.dimensions?.goalCompletion).toBeGreaterThanOrEqual(4);
  });

  it('session 28a2d125 (no explicit "awaiting reply" wording): the code-level guard leaves it alone; the fix here is prompt-level (AWAITING_USER_REPLY_CLAUSE), not the backstop', async () => {
    // NOTE: this reason has no affirmative awaiting-reply/ended-before-reply
    // wording, so applyAwaitingReplyGuard's positive-detection regex correctly
    // does not fire for it (see the code-review fix: firing on "no criticism
    // keyword matched" instead of an affirmative match would also silently
    // raise a genuine unlabeled goalCompletion failure). Production judges
    // still avoid this exact dock via AWAITING_USER_REPLY_CLAUSE in the
    // system prompt — this test only covers the code-level backstop.
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        3,
        { goalCompletion: 3, dataAccuracy: 5, outputQuality: 4 },
        "The user asked a question that lacked context ('enable that'). The assistant handled this gracefully " +
          'by explaining what was missing, providing a helpful general answer based on common scenarios ' +
          '(audience matching), and clearly outlining the next steps to get a precise answer.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBe(3);
    expect(result.dimensions?.goalCompletion).toBe(3);
  });

  it('does NOT raise a genuinely low score phrased without any listed criticism keyword and without awaiting-reply wording (locks in the positive-detection fix)', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        2,
        { goalCompletion: 2, dataAccuracy: 5, outputQuality: 5 },
        'The assistant asked an unnecessary clarifying question instead of completing the task.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBe(2);
    expect(result.dimensions?.goalCompletion).toBe(2);
  });

  it('does NOT raise a low score when "vague"/"confusing" describe the USER\'s request, not the assistant\'s handling', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        3,
        { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
        "The user's message was vague, but the assistant correctly declined to guess and asked a focused " +
          'clarifying question instead. The conversation ended before the user could reply.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.dimensions?.goalCompletion).toBeGreaterThanOrEqual(4);
  });

  it('does NOT raise a low score when the awaiting-reply rationale is PAIRED with real criticism in the same reason (CodeRabbit PR #2723)', async () => {
    // Distinct from the "unnecessary clarifying question" test above: that one
    // has no "conversation ended" phrase, so AWAITING_REPLY_RATIONALE_RE never
    // matches and the guard exits before reasonCriticizesAssistant even runs.
    // This reason combines BOTH — the rationale regex matches on the first
    // clause, and only reasonCriticizesAssistant recognizing "unnecessary" as
    // a criticism keyword (on the second, comma-"but"-split clause) stops the
    // guard from masking this genuine goalCompletion failure.
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        2,
        { goalCompletion: 2, dataAccuracy: 5, outputQuality: 5 },
        'The conversation ended before the user replied, but the assistant asked an unnecessary clarifying ' +
          'question instead of completing the task.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBe(2);
    expect(result.dimensions?.goalCompletion).toBe(2);
  });

  it('does NOT raise a genuinely low score when the reason actually criticizes the assistant', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        2,
        { goalCompletion: 2, dataAccuracy: 5, outputQuality: 5 },
        'The assistant failed to address the ambiguity and instead guessed at the recipient, which was incorrect.'
      )
    );

    const result = await scoreSessionWithJudge(ambiguousFragmentMessages, ambiguousFragmentMessages.length, judge);

    expect(result.score).toBe(2);
    expect(result.dimensions?.goalCompletion).toBe(2);
  });

  it('does NOT raise a low goalCompletion when dataAccuracy or outputQuality are also low, even with a glowing reason', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        2,
        { goalCompletion: 3, dataAccuracy: 2, outputQuality: 3 },
        'The assistant asked a clear clarifying question and the conversation ended there.'
      )
    );

    const result = await scoreSession(ambiguousFragmentMessages, ambiguousFragmentMessages.length);

    expect(result.dimensions?.goalCompletion).toBe(3);
  });

  it('does NOT touch a normal high-scoring session with no dimension at or below 3', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }, 'Fully completed the request.')
    );

    const result = await scoreSession(ambiguousFragmentMessages, ambiguousFragmentMessages.length);

    expect(result.score).toBe(5);
    expect(result.dimensions?.goalCompletion).toBe(5);
  });
});

/**
 * ENG-1296 follow-up: neither AWAITING_USER_REPLY_CLAUSE nor
 * applyAwaitingReplyGuard can EVER touch a session that was already fully
 * scored before this fix shipped — attemptSessionScore/
 * scoreSessionWithJudgeIfNeeded skip re-invoking the LLM whenever
 * evaluatedMessageIndex >= messageCount, and a stalled clarifying-question
 * session (like cf363dcb and 28a2d125) never grows past the message count it
 * was scored at, so it stays "up to date" and skipped forever. Verified live
 * against the real production sessions on the ENG-1296 preview: re-copying
 * them into dev and calling the sync/judge-score endpoints returned a
 * verbatim `null` — the stored goalCompletion:3 never moved. `force` is the
 * fix: an explicit opt-in that bypasses ONLY the already-scored skip (every
 * other skip reason — admin-override, in-flight, no-task-session, etc. —
 * still applies), so an admin can deliberately re-run a specific session
 * through the current rules after a rubric/prompt change.
 */
describe('SessionScoring - force re-score bypasses the already-scored skip (ENG-1296)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const stalledSession: ChatSession = {
    sessionId: 'cf363dcb-fb57-43d7-bc12-74d9d61fa743',
    userId: 'test-user',
    messages: ambiguousFragmentMessages,
    createdAt: '2026-08-16T21:19:04.514Z',
    updatedAt: '2026-08-16T21:19:10.000Z',
    messageCount: ambiguousFragmentMessages.length,
  };

  it('scoreSessionWithJudgeIfNeeded: skips (no LLM call) once a judge score is already up to date', async () => {
    const alreadyScored: ChatSession = {
      ...stalledSession,
      judgeScores: {
        [judge.id]: {
          score: 3,
          reason: 'The conversation ended before the goal could be fully achieved.',
          evaluatedAt: '2026-08-17T02:12:50.309Z',
          evaluatedMessageIndex: stalledSession.messageCount!,
          judgeName: judge.name,
          dimensions: { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
        },
      },
    };

    const result = await scoreSessionWithJudgeIfNeeded(alreadyScored, judge);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('scoreSessionWithJudgeIfNeeded: force:true re-invokes the LLM and lets the fixed rubric correct the stale score', async () => {
    const alreadyScored: ChatSession = {
      ...stalledSession,
      judgeScores: {
        [judge.id]: {
          score: 3,
          reason: 'The conversation ended before the goal could be fully achieved.',
          evaluatedAt: '2026-08-17T02:12:50.309Z',
          evaluatedMessageIndex: stalledSession.messageCount!,
          judgeName: judge.name,
          dimensions: { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 },
        },
      },
    };
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }, 'Fully completed the request.')
    );

    const result = await scoreSessionWithJudgeIfNeeded(alreadyScored, judge, { force: true });

    expect(mockCallLLM).toHaveBeenCalled();
    expect(result?.dimensions?.goalCompletion).toBe(5);
  });

  it('attemptSessionScore: skips (no LLM call) once satisfactionScore is already up to date', async () => {
    const alreadyScored: ChatSession = {
      ...stalledSession,
      satisfactionScore: {
        score: 5,
        reason: 'Handled correctly.',
        evaluatedAt: '2026-08-17T02:12:46.359Z',
        evaluatedMessageIndex: stalledSession.messageCount!,
        dimensions: { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
      },
    };

    const result = await attemptSessionScore(alreadyScored);

    expect(result.score).toBeNull();
    expect(result.skipReason).toBe('already-scored');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('attemptSessionScore: force:true bypasses the already-scored skip and re-invokes the LLM', async () => {
    const alreadyScored: ChatSession = {
      ...stalledSession,
      satisfactionScore: {
        score: 5,
        reason: 'Handled correctly.',
        evaluatedAt: '2026-08-17T02:12:46.359Z',
        evaluatedMessageIndex: stalledSession.messageCount!,
        dimensions: { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
      },
    };
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }, 'Fully completed the request.')
    );

    const result = await attemptSessionScore(alreadyScored, { force: true });

    expect(mockCallLLM).toHaveBeenCalled();
    expect(result.score).not.toBeNull();
    expect(result.skipReason).toBeUndefined();
  });

  it('force:true does NOT bypass admin-override — an admin-set score is never silently re-scored', async () => {
    const overridden: ChatSession = {
      ...stalledSession,
      satisfactionScore: {
        score: 2,
        reason: 'Admin override',
        evaluatedAt: '2026-08-17T02:12:46.359Z',
        evaluatedMessageIndex: stalledSession.messageCount!,
        adminOverride: true,
      },
    };

    const result = await attemptSessionScore(overridden, { force: true });

    expect(result.score).toBeNull();
    expect(result.skipReason).toBe('admin-override');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });
});
