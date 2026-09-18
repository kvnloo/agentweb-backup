/**
 * ENG-1165: blocked-by-external sessions must be excluded
 * from the satisfaction cohort as a neutral state — like the Slack-suggestion
 * exception — instead of being scored as agent failures.
 *
 * Three deterministic fixtures. Each MUST return score:null with skipReason
 * "blocked-external" after the fix. They FAIL before it (LLM is called and a
 * low goalCompletion score is persisted).
 */
import {
  attemptSessionScore,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

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

function lowScoreResponse() {
  return {
    choices: [{ message: { content: JSON.stringify({ score: 3, reason: 'goal not completed', dimensions: { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 } }) } }],
  } as any;
}

function base(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'eng-1165-red',
    userId: 'u1',
    pageIdentifier: 'portal-chat',
    sessionType: 'regular',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as any;
}

// 1. Visitor not signed in — assistant correctly refuses + explains.
const unsignedIn: ChatMessage[] = [
  { role: 'user', content: 'Review my LinkedIn profile' },
  { role: 'assistant', content: 'Please sign in first so I can access your profile data. Once signed in I can run the review.' },
];

// 2. Integration token revoked mid-task — assistant stops + gives reconnect fix.
const revokedToken: ChatMessage[] = [
  { role: 'user', content: 'Post this update to Meta Ads' },
  { role: 'assistant', content: 'Draft saved.', metadata: { toolCalls: [{ name: 'save_draft' }] } } as any,
  { role: 'assistant', content: 'Your Meta access token was revoked, so I stopped before making changes. Reconnect in Settings → Integrations (takes ~60 seconds), then say retry.' },
];

// 3. Upstream provider outage — assistant reports + files the product issue.
const upstreamOutage: ChatMessage[] = [
  { role: 'user', content: 'Search LinkedIn for CTOs at fintechs' },
  { role: 'assistant', content: 'Searched existing CRM leads instead.', metadata: { toolCalls: [{ name: 'search_crm_leads' }] } } as any,
  { role: 'assistant', content: 'LinkedIn search is currently down with an upstream outage, so I stopped that path, pivoted to your CRM leads and filed the outage as a product issue.', metadata: { toolCalls: [{ name: 'report_product_issues' }] } } as any,
];

const judge: ScoringJudge = {
  id: 'judge-1', name: 'J', systemPrompt: 'Evaluate.',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

describe('ENG-1165: blocked-by-external sessions are excluded, not scored', () => {
  beforeEach(() => { jest.clearAllMocks(); mockCallLLM.mockResolvedValue(lowScoreResponse()); });

  it('CONTROL (must pass before AND after): an ordinary task failure is still scored', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write a haiku about churn' },
      { role: 'assistant', content: 'Here is your haiku: churn churn churn.' },
    ];
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length }));
    expect(attempt.score).not.toBeNull();
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('FAIL-1: unsigned-in session is excluded as blocked-external', async () => {
    const attempt = await attemptSessionScore(base({ messages: unsignedIn, messageCount: unsignedIn.length }));
    expect(attempt.score).toBeNull();
    expect(attempt.skipReason).toBe('blocked-external');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('FAIL-2: revoked-token session is excluded as blocked-external', async () => {
    const attempt = await attemptSessionScore(base({ messages: revokedToken, messageCount: revokedToken.length }));
    expect(attempt.score).toBeNull();
    expect(attempt.skipReason).toBe('blocked-external');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('FAIL-3: upstream-outage session is excluded as blocked-external', async () => {
    const attempt = await attemptSessionScore(base({ messages: upstreamOutage, messageCount: upstreamOutage.length }));
    expect(attempt.score).toBeNull();
    expect(attempt.skipReason).toBe('blocked-external');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('FAIL-4: custom-judge path also excludes blocked-external (judges cannot diverge)', async () => {
    const { scoreSessionWithJudgeIfNeeded } = await import('../services/sessionScoringService');
    const result = await scoreSessionWithJudgeIfNeeded(
      base({ messages: unsignedIn, messageCount: unsignedIn.length, judgeScores: {} }), judge
    );
    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('FAIL-5: a pivot WITHOUT a named outage stays scorable (no silent cohort shrink)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search LinkedIn for CTOs at fintechs' },
      { role: 'assistant', content: 'No matches found, so I pivoted to your CRM leads and filed a note as a product issue.' },
    ];
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ score: 2, reason: 'no results', dimensions: { goalCompletion: 2, dataAccuracy: 4, outputQuality: 3 } }) } }],
    } as any);
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length }));
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(attempt.score).not.toBeNull();
  });

  it('FAIL-6: a block report followed by a user retry is NOT excluded (transcript continued)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Review my LinkedIn profile' },
      { role: 'assistant', content: 'Please sign in first so I can access your profile data.' },
      { role: 'user', content: 'I signed in, try again' },
    ];
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ score: 3, reason: 'goal not completed', dimensions: { goalCompletion: 3, dataAccuracy: 5, outputQuality: 5 } }) } }],
    } as any);
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length }));
    // Final turn is the user's retry, not the assistant's block report → the
    // exclusion does not fire; the session scores normally (proves the
    // final-turn anchor, not a transcript-wide substring match).
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(attempt.score).not.toBeNull();
    expect(attempt.skipReason).toBeUndefined();
  });

  it('a completed outage fallback ending in a bare "let me know" stays scorable (generic closing is not handling evidence)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search LinkedIn for CTOs at fintechs' },
      { role: 'assistant', content: 'LinkedIn search had an upstream outage. I already pulled an equivalent list another way — here it is. Let me know if you need anything else.' },
    ];
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ score: 4, reason: 'done via fallback', dimensions: { goalCompletion: 4, dataAccuracy: 5, outputQuality: 4 } }) } }],
    } as any);
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length }));
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(attempt.score).not.toBeNull();
    expect(attempt.skipReason).toBeUndefined();
  });

  it('a punt after a fully-specified request stays scorable (decline-to-guess without an ambiguous fragment is an agent failure)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Review my LinkedIn profile: https://linkedin.com/in/janedoe — give me the full breakdown.' },
      { role: 'assistant', content: 'I decline to guess at which sections you want. Could you clarify which parts of your profile you want reviewed?' },
    ];
    mockCallLLM.mockResolvedValue(lowScoreResponse());
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length }));
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(attempt.score).not.toBeNull();
    expect(attempt.skipReason).toBeUndefined();
  });

  it('a genuine ambiguous fragment with a decline-to-guess and focused question is excluded (ENG-1296 shape)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'post it' },
      { role: 'assistant', content: 'I decline to guess which channel you mean instead of guessing. Could you clarify which account should I post to?' },
    ];
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length }));
    expect(attempt.score).toBeNull();
    expect(attempt.skipReason).toBe('blocked-external');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('a complete request ("Write a haiku about winter") with a decline-to-guess stays scorable (positive fragment allowlist)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write a haiku about winter' },
      { role: 'assistant', content: 'I decline to guess which tone you want instead of guessing. Could you clarify what tone should I use?' },
    ];
    mockCallLLM.mockResolvedValue(lowScoreResponse());
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length }));
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(attempt.score).not.toBeNull();
    expect(attempt.skipReason).toBeUndefined();
  });

  it('a long generated incident-notice draft mentioning an outage stays scorable (not a terminal block report)', async () => {
    const longDraft = 'Service is currently down. '.padEnd(700, 'Details of the incident follow. ') +
      'Here is the customer notice draft you asked for: we apologize for the disruption. Next steps: our team will post updates hourly. Please review and approve.';
    expect(longDraft.length).toBeGreaterThan(600);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Draft an incident notice for the outage' },
      { role: 'assistant', content: longDraft },
    ];
    mockCallLLM.mockResolvedValue(lowScoreResponse());
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length }));
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(attempt.score).not.toBeNull();
    expect(attempt.skipReason).toBeUndefined();
  });

  it('an interactive approval-held publish with saved draft is excluded (account-level hold, non-scheduled)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Post this to LinkedIn now' },
      { role: 'assistant', content: 'Publishing requires approval before publishing under your account-level setting, so I saved the draft and will not publish until approved.' },
    ];
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length, sessionType: 'regular' }));
    expect(attempt.score).toBeNull();
    expect(attempt.skipReason).toBe('blocked-external');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('a scheduled run with approval-hold wording but no PUBLISH WITHHELD marker stays in the judged cohort', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Scheduled post' },
      { role: 'assistant', content: 'Publishing requires approval before publishing, so I saved the draft.' },
    ];
    mockCallLLM.mockResolvedValue(lowScoreResponse());
    const attempt = await attemptSessionScore(base({ messages, messageCount: messages.length, sessionType: 'scheduled' }));
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(attempt.score).not.toBeNull();
    expect(attempt.skipReason).toBeUndefined();
  });
});
