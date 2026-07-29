import { DEFAULT_SCORING_SYSTEM_PROMPT, scoreSession } from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
    // ENG-744: scoring now validates a persisted model id against the registry
    // before calling. Pass-through keeps these fixtures' model expectations
    // exactly as they were while satisfying the real service's contract.
    resolveGenerationModel: (m: string) => ({ model: m, fellBack: false, requestedModel: m }),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSatisfactionScore: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

function makeLLMResponse(score: number, reason: string, dimensions?: object) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, ...(dimensions ? { dimensions } : {}) }) } }],
  } as any;
}

function getSystemPrompt(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const systemMessage = callArgs[1].find((m: any) => m.role === 'system');
  return systemMessage?.content ?? '';
}

function getConversationText(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const userMessage = callArgs[1].find((m: any) => m.role === 'user');
  return userMessage?.content ?? '';
}

// Session where report_product_issues was called (appears in serialized tool call list)
const messagesWithToolCall: ChatMessage[] = [
  { role: 'user', content: 'Please create a static ad with my logo composited on it.' },
  { role: 'assistant', content: 'Let me try to generate that image with your logo.' },
  { role: 'user', content: 'That did not work — the logo is missing.' },
  {
    role: 'assistant',
    content: 'I apologize for the issue. I have filed a bug report.',
    metadata: { toolCalls: [{ name: 'report_product_issues', arguments: { title: 'Logo compositing broken' } }] },
  } as any,
];

const messagesWithoutToolCall: ChatMessage[] = [
  { role: 'user', content: 'Please create a static ad with my logo composited on it.' },
  { role: 'assistant', content: 'Let me try to generate that image with your logo.' },
  { role: 'user', content: 'That did not work — the logo is missing.' },
  { role: 'assistant', content: 'I apologize for the issue. Let me try again.' },
];

describe('SessionScoring - bug reported during session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL tests: prompt must contain the bug-reported clause keyed to the tool name

  it('DEFAULT_SCORING_SYSTEM_PROMPT includes a bug-reported clause', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('Bug reported during session');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT keys detection on report_product_issues tool call', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('report_product_issues');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT instructs judge to score ≥ 4 when bug was reported', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('score ≥ 4');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT specifies the user will be contacted offline', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('contacted offline');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT still allows dimension scores to reflect friction', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('dimension scores');
  });

  // Brand / topic mismatch clause: flagging a mismatch is correct behavior, not a failure

  it('DEFAULT_SCORING_SYSTEM_PROMPT includes a brand/topic mismatch clause', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('Brand / topic mismatch');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT instructs judge not to penalize flagging a mismatch', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('Do NOT penalize the assistant for surfacing a brand/topic mismatch');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT mentions placeholders as acceptable output', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('[Brand Name]');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT only lowers mismatch score on repeated refusal after pushback', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('repeatedly refuses to produce ANY usable output');
  });

  // Draft/reply direction clause: sender/recipient confusion is an intent failure

  it('DEFAULT_SCORING_SYSTEM_PROMPT includes a draft/reply direction clause', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('Draft/reply direction');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT treats reversed sender and recipient as goal-completion failure', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('drafting in the opposite direction is a goal-completion failure');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT does not penalize one sender/recipient clarification', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('FROM X TO Y - correct?');
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('should not be penalized as excessive clarification');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT does not infer drafting from pasted third-party text alone', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('Do not infer a draft/reply task from a bare pasted third-party message');
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('do NOT score it as reversed sender/recipient direction');
  });

  // ENG-392: clarifying an ambiguous pasted message (per the Drafting Direction
  // Guard) is CORRECT behavior and must count as full goal completion — the
  // general judge previously penalized it as "asked for clarification instead
  // of drafting", diverging from the named judges that rewarded it.

  it('DEFAULT_SCORING_SYSTEM_PROMPT treats clarify-and-offer-options on a pasted message as full goal completion', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('Treat this clarify-and-offer-options response as full goal completion');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT does not penalize asking for clarification instead of drafting', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('do NOT lower goalCompletion or the overall score for "asking for clarification instead of drafting"');
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('failing to draft a suggested response');
  });

  it('DEFAULT_SCORING_SYSTEM_PROMPT only penalizes when a draft was already explicitly requested', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).toContain('Only penalize goalCompletion here if the user had ALREADY explicitly asked for a draft/reply');
  });

  // SUCCESS: verify the tool call appears in the serialized conversation and prompt passes through

  it('serialized conversation text includes report_product_issues in called tools line', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Bug reported via tool; user will be contacted', {
        goalCompletion: 4,
        dataAccuracy: 4,
        outputQuality: 3,
      })
    );

    await scoreSession(messagesWithToolCall, messagesWithToolCall.length);

    const conversationText = getConversationText();
    expect(conversationText).toContain('report_product_issues');
  });

  it('system prompt contains report_product_issues clause when passed to LLM', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Bug acknowledged and reported', {
        goalCompletion: 4,
        dataAccuracy: 4,
        outputQuality: 3,
      })
    );

    await scoreSession(messagesWithToolCall, messagesWithToolCall.length);

    const systemPrompt = getSystemPrompt();
    expect(systemPrompt).toContain('report_product_issues');
    expect(systemPrompt).toContain('contacted offline');
  });

  it('returns the score the judge produces (4) for a session where report_product_issues was called', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Bug acknowledged; treated as satisfied', {
        goalCompletion: 4,
        dataAccuracy: 4,
        outputQuality: 3,
      })
    );

    const result = await scoreSession(messagesWithToolCall, messagesWithToolCall.length);

    expect(result.score).toBe(4);
    expect(result.dimensions?.outputQuality).toBe(3);
  });

  it('does not modify scoring for sessions where report_product_issues was not called', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(2, 'Repeated failures, no bug report filed', {
        goalCompletion: 2,
        dataAccuracy: 3,
        outputQuality: 2,
      })
    );

    const result = await scoreSession(messagesWithoutToolCall, messagesWithoutToolCall.length);

    expect(result.score).toBe(2);
    expect(result.dimensions?.goalCompletion).toBe(2);
  });
});
