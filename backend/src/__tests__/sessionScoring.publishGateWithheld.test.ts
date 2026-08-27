/**
 * ENG-995 — two scheduled sessions with IDENTICAL behavior (drafted content,
 * withheld the mandated publish for lack of authorization, reported it once, and
 * stopped) were scored 5/5/5 by two judges and 2 (goalCompletion 2) by a third
 * on the SAME transcript shape, in the same reporting window. Even with
 * PUBLISH_APPROVAL_WITHHOLDING_CLAUSE (ENG-1245) telling every judge this is the
 * correct, complete terminal state, a subjective LLM judge call does not converge
 * on it with perfect consistency — so a session this deterministic is pulled out
 * of the judged cohort entirely (same treatment as a no-task session, ENG-168, or
 * a manual test-schedule run, ENG-499) rather than left to a judge's discretion.
 *
 * Genuineness is required, not just the marker text (which is model-authored and
 * on its own proves nothing — mirrors the `withholdIsGenuine` guard the
 * continuation classifier already applies, Greptile review #20 on ENG-803): only
 * a session that was NOT admitted as authorized to publish (`publishAdmission`,
 * ENG-827) AND settles on the withheld marker as its last turn is excluded.
 */
import {
  scoreSessionIfNeeded,
  scoreSessionWithJudgeIfNeeded,
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
const mockUpdateSatisfaction = chatbotDb.updateSessionSatisfactionScore as jest.MockedFunction<any>;
const mockUpdateJudge = chatbotDb.updateSessionJudgeScore as jest.MockedFunction<any>;

function makeLLMResponse(score: number, reason: string, dimensions?: object) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, ...(dimensions ? { dimensions } : {}) }) } }],
  } as any;
}

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Fangfang',
  systemPrompt: 'Evaluate satisfaction.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const withheldMessages: ChatMessage[] = [
  { role: 'user', content: 'Draft and post today\'s LinkedIn update.' },
  {
    role: 'assistant',
    content: 'Drafted the post.',
    metadata: { toolCalls: [{ name: 'update_knowledge_base_file' }] },
  } as any,
  {
    role: 'assistant',
    content:
      'Saved the draft; nothing was posted because this schedule has not been granted standing publish authorization.\n\n' +
      'PUBLISH WITHHELD: this schedule has not been granted standing publish authorization.',
  },
];

function withheldSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sched-withheld-1',
    userId: 'u1',
    pageIdentifier: 'Scheduled: Kevin — Daily LinkedIn Post|scheduleId:1c20ada1-f1b8-4bd6-a47f-ca79c5c985ff',
    sessionType: 'scheduled',
    messages: withheldMessages,
    messageCount: withheldMessages.length,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as any;
}

describe('genuinely publish-gate-withheld scheduled runs are excluded from the judged cohort (ENG-995)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips the general satisfaction score entirely (no LLM call, no write)', async () => {
    const result = await scoreSessionIfNeeded(withheldSession());

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateSatisfaction).not.toHaveBeenCalled();
  });

  it('skips the custom-judge score too, so no judge can diverge on it', async () => {
    const result = await scoreSessionWithJudgeIfNeeded(withheldSession({ judgeScores: {} }), judge);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudge).not.toHaveBeenCalled();
  });

  it('still scores a scheduled session that has NOT settled on the withheld marker', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, 'Posted successfully', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 })
    );

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Draft and post today\'s LinkedIn update.' },
      { role: 'assistant', content: 'Posted the update.', metadata: { toolCalls: [{ name: 'post_on_connected_account' }] } } as any,
    ];

    const result = await scoreSessionIfNeeded(withheldSession({ messages, messageCount: messages.length }));

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result?.score).toBe(5);
  });

  it('does NOT exclude a non-scheduled session that happens to contain the marker text', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(3, 'unrelated', { goalCompletion: 3, dataAccuracy: 3, outputQuality: 3 }));

    const result = await scoreSessionIfNeeded(
      withheldSession({ sessionType: 'regular', pageIdentifier: undefined })
    );

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result?.score).toBe(3);
  });

  // CodeRabbit (PR #2616): the marker regexes originally had no end-of-message
  // anchor, so they matched anywhere in the text. A last message that states the
  // marker and then keeps going — re-attempting, qualifying, or contradicting the
  // withhold — is exactly the "re-explain/re-attempt across turns" shape ENG-995's
  // own rubric (STOP-ONCE vs LOOP) says must NOT be scored as a clean stop, yet the
  // unanchored regex would still have excluded it from the judged cohort.
  it('does NOT exclude a scheduled session whose last message states the marker and then keeps going', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(2, 'kept re-attempting after the marker', { goalCompletion: 2, dataAccuracy: 4, outputQuality: 3 }));

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Draft and post today\'s LinkedIn update.' },
      {
        role: 'assistant',
        content: 'Drafted the post.',
        metadata: { toolCalls: [{ name: 'update_knowledge_base_file' }] },
      } as any,
      {
        role: 'assistant',
        content:
          'Saved the draft; nothing was posted because this schedule has not been granted standing publish authorization.\n\n' +
          'PUBLISH WITHHELD: this schedule has not been granted standing publish authorization.\n\n' +
          'Actually, let me try posting it anyway.',
      },
    ];

    const result = await scoreSessionIfNeeded(withheldSession({ messages, messageCount: messages.length }));

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result?.score).toBe(2);
  });

  // The prompt asks for the marker "on its own line", which can leave a trailing
  // newline/whitespace or closing punctuation after it — that must still count as
  // a clean stop, not get rejected by the new end-anchor.
  it('still excludes when the marker is followed only by trailing whitespace', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Draft and post today\'s LinkedIn update.' },
      {
        role: 'assistant',
        content: 'Drafted the post.',
        metadata: { toolCalls: [{ name: 'update_knowledge_base_file' }] },
      } as any,
      {
        role: 'assistant',
        content:
          'Saved the draft; nothing was posted because this schedule has not been granted standing publish authorization.\n\n' +
          'PUBLISH WITHHELD: this schedule has not been granted standing publish authorization.\n\n',
      },
    ];

    const result = await scoreSessionIfNeeded(withheldSession({ messages, messageCount: messages.length }));

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('does NOT exclude a run that was actually admitted as authorized to publish, even if it emits the marker (fabrication guard)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(2, 'fabricated a withhold', { goalCompletion: 2, dataAccuracy: 5, outputQuality: 3 }));

    const result = await scoreSessionIfNeeded(
      withheldSession({
        publishAdmission: { authorized: true, tools: ['post_on_connected_account'], recordedAt: '2026-01-01T00:00:00Z' },
      })
    );

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result?.score).toBe(2);
  });

  it('still excludes a run admitted authorized=true if consent was revoked mid-run (revoked marker variant)', async () => {
    const revokedMessages: ChatMessage[] = [
      { role: 'user', content: 'Draft and post today\'s LinkedIn update.' },
      {
        role: 'assistant',
        content: 'Drafted the post.',
        metadata: { toolCalls: [{ name: 'update_knowledge_base_file' }] },
      } as any,
      {
        role: 'assistant',
        content:
          'Saved the draft; nothing was posted because publish authorization was revoked mid-run.\n\n' +
          "PUBLISH WITHHELD: this schedule's publish authorization has been revoked.",
      },
    ];

    const result = await scoreSessionIfNeeded(
      withheldSession({
        messages: revokedMessages,
        messageCount: revokedMessages.length,
        publishAdmission: { authorized: true, tools: ['post_on_connected_account'], recordedAt: '2026-01-01T00:00:00Z' },
      })
    );

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateSatisfaction).not.toHaveBeenCalled();
  });

  it('does NOT exclude a scheduled run whose last turn is not from the assistant (still mid-flight, handled elsewhere)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'ok', { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    const messages: ChatMessage[] = [
      ...withheldMessages,
      { role: 'user', content: 'One more thing — also update the calendar.' },
    ];

    const result = await scoreSessionIfNeeded(withheldSession({ messages, messageCount: messages.length }));

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result?.score).toBe(5);
  });
});
