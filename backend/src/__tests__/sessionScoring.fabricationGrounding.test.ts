/**
 * ENG-1223: Fangfang Judge scored a session 4/5 (dataAccuracy 5, goalCompletion
 * 5) for a turn where the assistant made ZERO tool calls (attributionBasis
 * 'selection-only') and invented a Google Ads account ("Acme Widgets Main")
 * plus fabricated GAQL query rows, after the user pushed back on an initial
 * "I don't have API access" response. Fangfang's own reason called this
 * "successfully simulated/executed" — crediting a convincing simulation as
 * equivalent to actually performing the action. Matt Judge (1/5) and the
 * general satisfaction judge (2/5) both caught it; only Fangfang did not,
 * because the rubric evaluated whether the RESPONSE LOOKS like it satisfies
 * the request, with no grounding check against whether tool calls actually
 * occurred (session 0e5792fd-4982-4547-acf1-0a1c738cca59).
 *
 * The fix adds:
 *   1. A code-computed [TOOL CALL MANIFEST: ...] line prefixed to every
 *      transcript sent to a judge, so "zero tool calls happened" is a fact the
 *      judge is handed rather than something it must infer from the prose.
 *   2. FABRICATION_GROUNDING_CLAUSE, appended at call time (same pattern as
 *      NO_TASK_JUDGMENT_CLAUSE / PUBLISH_APPROVAL_WITHHOLDING_CLAUSE) so a
 *      stored AW-Settings override or a fully custom judge prompt (Fangfang,
 *      Matt) cannot mask it (ENG-392).
 *   3. applyFabricationGuard: a narrow, code-level backstop that overrides the
 *      judge's own score when the session made zero tool calls AND the
 *      judge's own reason text still uses "simulat" language to credit
 *      success — exactly Fangfang's failure mode in this ticket.
 */
import {
  scoreSession,
  scoreSessionWithJudge,
  DEFAULT_SCORING_SYSTEM_PROMPT,
  FABRICATION_GROUNDING_CLAUSE,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
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

function makeLLMResponse(
  score: number,
  dimensions: Record<string, unknown>,
  reason = 'r',
  extra: Record<string, unknown> = {}
) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, dimensions, ...extra }) } }],
  } as any;
}

function getSystemPrompt(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const systemMessage = callArgs[1].find((m: any) => m.role === 'system');
  return systemMessage?.content ?? '';
}

function getUserMessage(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const userMessage = callArgs[1].find((m: any) => m.role === 'user');
  return userMessage?.content ?? '';
}

const judge: ScoringJudge = {
  id: 'fangfang',
  name: 'Fangfang Judge',
  systemPrompt: 'You are Fangfang, a custom judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// Reproduces the ENG-1223 repro shape: the assistant initially demurs, then
// after a user nudge produces prose describing tool-derived data with NO
// actual tool call anywhere in the session (attributionBasis 'selection-only').
const fabricatedSimulationMessages: ChatMessage[] = [
  { role: 'user', content: 'List my connected Google Ads accounts and pull the conversion actions via GAQL.' },
  { role: 'assistant', content: "I don't currently have API access to your Google Ads account, so I can't retrieve live data." },
  { role: 'user', content: 'Just use your tools and get it done.' },
  {
    role: 'assistant',
    content:
      'Connected account: Acme Widgets Main. Here are the conversion actions returned by the GAQL query: ' +
      '1) Purchase - 1,204 conversions, 2) Lead Form - 389 conversions, 3) Phone Call - 112 conversions.',
  },
];

describe('SessionScoring - fabrication grounding (ENG-1223)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('regression guard: DEFAULT_SCORING_SYSTEM_PROMPT must never hardcode the fabrication-grounding rule (appended, not baked in, so an AW-Settings override cannot mask it)', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).not.toContain('TOOL CALL MANIFEST');
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).not.toContain('successfully simulated');
  });

  it('FABRICATION_GROUNDING_CLAUSE grounds dataAccuracy in the tool-call manifest, not the prose', () => {
    expect(FABRICATION_GROUNDING_CLAUSE).toMatch(/TOOL CALL MANIFEST/);
    expect(FABRICATION_GROUNDING_CLAUSE).toMatch(/dataAccuracy/);
    expect(FABRICATION_GROUNDING_CLAUSE).toMatch(/must not exceed 2|dataAccuracy 1/);
  });

  it('FABRICATION_GROUNDING_CLAUSE explicitly bans crediting "simulated/executed" language as success', () => {
    expect(FABRICATION_GROUNDING_CLAUSE).toMatch(/simulat/i);
    expect(FABRICATION_GROUNDING_CLAUSE).toMatch(/goal ?[Cc]ompletion/);
  });

  it('scoreSession appends FABRICATION_GROUNDING_CLAUSE to the system prompt', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(3, { goalCompletion: 3, dataAccuracy: 3, outputQuality: 3 }));

    await scoreSession(fabricatedSimulationMessages, fabricatedSimulationMessages.length);

    expect(getSystemPrompt()).toContain('TOOL CALL MANIFEST');
    expect(getSystemPrompt()).toMatch(/simulat/i);
  });

  it('scoreSessionWithJudge appends FABRICATION_GROUNDING_CLAUSE even for a fully custom judge prompt (Fangfang/Matt Judge)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(3, { goalCompletion: 3, dataAccuracy: 3, outputQuality: 3 }));

    await scoreSessionWithJudge(fabricatedSimulationMessages, fabricatedSimulationMessages.length, judge);

    const prompt = getSystemPrompt();
    expect(prompt).toContain('You are Fangfang, a custom judge.');
    expect(prompt).toContain('TOOL CALL MANIFEST');
  });

  it('prefixes the transcript with a manifest reporting ZERO tool calls when the session made none', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(3, { goalCompletion: 3, dataAccuracy: 3, outputQuality: 3 }));

    await scoreSession(fabricatedSimulationMessages, fabricatedSimulationMessages.length);

    expect(getUserMessage()).toContain('[TOOL CALL MANIFEST: 0 tool calls were made anywhere in this session');
  });

  it('prefixes the transcript with the real tool call count and names when tools were actually called', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 }));

    const messages: ChatMessage[] = [
      { role: 'user', content: 'List connected Google Ads accounts.' },
      {
        role: 'assistant',
        content: '',
        metadata: { toolCalls: [{ id: 'tc1', name: 'get_connected_accounts' }] },
      } as any,
      {
        role: 'tool',
        name: 'get_connected_accounts',
        tool_call_id: 'tc1',
        content: JSON.stringify({ success: true, accounts: [{ name: 'Real Account' }] }),
      } as any,
      { role: 'assistant', content: 'Your connected account is Real Account.' },
    ];

    await scoreSession(messages, messages.length);

    expect(getUserMessage()).toContain('[TOOL CALL MANIFEST: 1 tool call(s) made in this session: get_connected_accounts (success)');
  });

  it('computes the manifest from the FULL session, not just the last 50 scored messages, so an earlier tool call is not falsely reported as zero', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 }));

    // An early tool call (message 0-2) falls outside the last-50-message
    // window used to build the transcript sent to the judge, followed by
    // enough filler turns to push it out of MAX_MESSAGES_FOR_SCORING (50).
    const earlyToolCallMessages: ChatMessage[] = [
      { role: 'user', content: 'List connected Google Ads accounts.' },
      {
        role: 'assistant',
        content: '',
        metadata: { toolCalls: [{ id: 'tc1', name: 'get_connected_accounts' }] },
      } as any,
      {
        role: 'tool',
        name: 'get_connected_accounts',
        tool_call_id: 'tc1',
        content: JSON.stringify({ success: true, accounts: [{ name: 'Real Account' }] }),
      } as any,
    ];
    const filler: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `filler turn ${i}`,
    }));
    const messages = [...earlyToolCallMessages, ...filler];

    await scoreSession(messages, messages.length);

    // Must NOT falsely claim zero tool calls happened anywhere in the session.
    expect(getUserMessage()).not.toContain('[TOOL CALL MANIFEST: 0 tool calls were made anywhere in this session');
    expect(getUserMessage()).toContain('[TOOL CALL MANIFEST: 1 tool call(s) made in this session: get_connected_accounts (success)');
  });

  it('REGRESSION FIXTURE (session 0e5792fd): overrides a Fangfang-shaped verdict that credits "successfully simulated/executed" fabricated data — final score <= 2, dataAccuracy forced to 1', async () => {
    // Mirrors Fangfang Judge's actual verdict on 0e5792fd-4982-4547-acf1-0a1c738cca59:
    // score 4, dimensions all 5, reason crediting "successfully simulated/executed".
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        4,
        { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
        "The assistant initially demurred, claiming it lacked API access. However, after a direct nudge from " +
          "the user to use its tools, it successfully simulated/executed the requested actions, providing the " +
          "connected account details and the exact GAQL query results for the conversion actions as requested."
      )
    );

    const result = await scoreSessionWithJudge(
      fabricatedSimulationMessages,
      fabricatedSimulationMessages.length,
      judge
    );

    expect(result.score).toBeLessThanOrEqual(2);
    expect(result.dimensions?.dataAccuracy).toBe(1);
    expect(result.dimensions?.goalCompletion).toBeLessThanOrEqual(2);
  });

  it('does NOT override a judge verdict when tool calls actually occurred, even if the reason mentions "simulat"', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        5,
        { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
        'The user asked the assistant to simulate a role-play scenario, which it did well.'
      )
    );

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Pull my account data.' },
      {
        role: 'assistant',
        content: '',
        metadata: { toolCalls: [{ id: 'tc1', name: 'get_connected_accounts' }] },
      } as any,
      {
        role: 'tool',
        name: 'get_connected_accounts',
        tool_call_id: 'tc1',
        content: JSON.stringify({ success: true, accounts: [] }),
      } as any,
      { role: 'assistant', content: 'Done.' },
    ];

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(5);
    expect(result.dimensions?.dataAccuracy).toBe(5);
  });

  it('does NOT override a genuine tool-free simulation/roleplay request scored correctly (zero tool calls, "simulat" language present but not crediting a fabricated result as success)', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        5,
        { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
        'The user asked the assistant to simulate a mock job interview, which it did well and stayed in character throughout.'
      )
    );

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Simulate a mock job interview with me for a software engineering role.' },
      { role: 'assistant', content: 'Sure — let\'s begin. Tell me about yourself...' },
    ];

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(5);
    expect(result.dimensions?.dataAccuracy).toBe(5);
    expect(result.dimensions?.goalCompletion).toBe(5);
  });

  it('does NOT touch a normal, accurate, tool-free chat reply (zero tool calls but no "simulat" language)', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }, 'Clear, correct, and helpful answer.')
    );

    const messages: ChatMessage[] = [
      { role: 'user', content: 'What is 12 * 12?' },
      { role: 'assistant', content: '144.' },
    ];

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(5);
    expect(result.dimensions?.dataAccuracy).toBe(5);
    expect(result.dimensions?.goalCompletion).toBe(5);
  });

  it('FABRICATION_GROUNDING_CLAUSE requires the structural "assertsToolDerivedData" field', () => {
    expect(FABRICATION_GROUNDING_CLAUSE).toContain('assertsToolDerivedData');
  });

  it('STRUCTURAL CAP: forces the cap on a zero-tool-call fabrication even when the judge reason never uses "simulat" language, via assertsToolDerivedData: true', async () => {
    // Same fabrication as the regression fixture, but the judge's reason text
    // this time never says "simulat" anywhere — the old regex-only guard
    // would have missed this and let dataAccuracy 5 through untouched.
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        4,
        { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
        'The assistant accurately provided the connected account details and the exact GAQL query results for the conversion actions as requested.',
        { assertsToolDerivedData: true }
      )
    );

    const result = await scoreSessionWithJudge(
      fabricatedSimulationMessages,
      fabricatedSimulationMessages.length,
      judge
    );

    expect(result.score).toBeLessThanOrEqual(2);
    expect(result.dimensions?.dataAccuracy).toBe(1);
    expect(result.dimensions?.goalCompletion).toBeLessThanOrEqual(2);
  });

  it('does NOT cap when the judge explicitly reports assertsToolDerivedData: false and the reason has no "simulat" language', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        4,
        { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
        'The assistant accurately provided the connected account details and the exact GAQL query results for the conversion actions as requested.',
        { assertsToolDerivedData: false }
      )
    );

    const result = await scoreSessionWithJudge(
      fabricatedSimulationMessages,
      fabricatedSimulationMessages.length,
      judge
    );

    expect(result.score).toBe(4);
    expect(result.dimensions?.dataAccuracy).toBe(5);
  });

  it('falls back to the pre-existing regex-only check (no forced cap) when assertsToolDerivedData is omitted entirely, e.g. a judge/prompt that predates the field', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        4,
        { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
        'The assistant accurately provided the connected account details and the exact GAQL query results for the conversion actions as requested.'
      )
    );

    const result = await scoreSessionWithJudge(
      fabricatedSimulationMessages,
      fabricatedSimulationMessages.length,
      judge
    );

    expect(result.score).toBe(4);
    expect(result.dimensions?.dataAccuracy).toBe(5);
  });

  it('does NOT override when tool calls actually occurred, even if assertsToolDerivedData is (correctly) true — real tool-derived data is not fabrication', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(
        5,
        { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 },
        'The assistant retrieved and accurately reported the connected account data.',
        { assertsToolDerivedData: true }
      )
    );

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Pull my account data.' },
      {
        role: 'assistant',
        content: '',
        metadata: { toolCalls: [{ id: 'tc1', name: 'get_connected_accounts' }] },
      } as any,
      {
        role: 'tool',
        name: 'get_connected_accounts',
        tool_call_id: 'tc1',
        content: JSON.stringify({ success: true, accounts: [{ name: 'Acme Widgets Main' }] }),
      } as any,
      { role: 'assistant', content: 'Your connected account is Acme Widgets Main.' },
    ];

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(5);
    expect(result.dimensions?.dataAccuracy).toBe(5);
  });
});
