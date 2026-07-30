import { AgentModeService } from '../services/agentModeService';

// Mock all dependencies
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

function makeSession(sessionId = 'test-session') {
  return {
    sessionId,
    messages: [],
    associatedSkills: null,
  };
}

function mockDeps(overrides: { session?: any } = {}) {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(overrides.session ?? makeSession()),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = {
    getSetting: jest.fn().mockResolvedValue(null),
  };

  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
}

const GEMINI_MODEL = 'gemini-3.5-flash';

// A distinctive repeated search query so the leaked content is unmistakably
// identifiable when asserting it never reaches the user-facing response.
const LEAKED_QUERY = 'Searching for Washington State Legislature status agenda';

/**
 * ENG-737: the Gemini OpenAI-compat leak shape. The output-token limit cut the
 * turn off WHILE the model was still reasoning, so finish_reason is 'length',
 * `extra_content.google.thought_signature` is present (a thinking turn), and the
 * raw chain-of-thought leaked into `content` — here a leading `thought` part
 * marker followed by a degenerate loop of repeated search queries.
 */
function makeLeakedReasoningResponse() {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: `thought\n${LEAKED_QUERY}\n${LEAKED_QUERY}\n${LEAKED_QUERY}\n${LEAKED_QUERY}`,
          tool_calls: null,
          extra_content: { google: { thought_signature: 'CikBk9x2thoughtsig==' } },
        },
        finish_reason: 'length',
      },
    ],
    usage: { prompt_tokens: 5000, completion_tokens: 32000, total_tokens: 37000 },
  };
}

/**
 * The MARKERLESS continuation fragment (session d103071a fragment 31): a truncated
 * thinking turn with NO leading `thought` marker, but a degenerate repeated-query
 * loop. On its own this is not a leak; it is only suppressed because it directly
 * continues a just-suppressed marker leak (precededBySuppressedLeak wiring).
 */
function makeMarkerlessLoopResponse() {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: `*   Wait, let's look at the results:\n${LEAKED_QUERY}\n${LEAKED_QUERY}\n${LEAKED_QUERY}\n${LEAKED_QUERY}`,
          tool_calls: null,
          extra_content: { google: { thought_signature: 'CikBk9x2contsig==' } },
        },
        finish_reason: 'length',
      },
    ],
    usage: { prompt_tokens: 6000, completion_tokens: 32000, total_tokens: 38000 },
  };
}

/**
 * A LEGITIMATE truncated Gemini answer: finish_reason is 'length' and it is a
 * thinking turn (thought_signature present), but `content` is a real partial
 * answer with no reasoning-leak signature. This must NOT be suppressed — the
 * continuation loop legitimately keeps and stitches it together.
 */
function makeLegitTruncatedResponse() {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'The Washington State Legislature is currently in regular session. Key bills under consideration include',
          tool_calls: null,
          extra_content: { google: { thought_signature: 'CikBlegitsig==' } },
        },
        finish_reason: 'length',
      },
    ],
    usage: { prompt_tokens: 5000, completion_tokens: 32000, total_tokens: 37000 },
  };
}

/** Normal, complete text response (finish_reason=stop). */
function makeTextResponse(text: string) {
  return {
    choices: [
      {
        message: { role: 'assistant', content: text, tool_calls: null },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
  };
}

describe('AgentModeService - Gemini reasoning-leak suppression (ENG-737)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    // Suppress suggested-reply generation so it doesn't add extra callLLM calls
    jest.spyOn(agentModeService as any, 'generateSuggestedReplies').mockResolvedValue([]);
  });

  it('suppresses a leaked chain-of-thought fragment and delivers only the real synthesized answer', async () => {
    mockDeps();

    const REAL_ANSWER = 'The Washington State Legislature is in regular session; the 2026 agenda is now available.';
    jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeLeakedReasoningResponse()) // iter 1: truncated leak (finish_reason=length)
      .mockResolvedValueOnce(makeTextResponse(REAL_ANSWER)); // iter 2: continuation delivers the real answer

    const result = await agentModeService.generateMarketingResponse(
      'What is the status and agenda of the Washington State Legislature?',
      [],
      'test-user',
      GEMINI_MODEL,
      'test-session'
    );

    // The leaked reasoning must never reach the user-facing response.
    expect(result.content).toBe(REAL_ANSWER);
    expect(result.content).not.toContain(LEAKED_QUERY);
    expect(result.content.toLowerCase()).not.toMatch(/^thought/);

    // The persisted transcript must have the leaked assistant turn blanked.
    const assistantMsgs = (result.responseMessages as any[]).filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[0].content).toBe(''); // leak suppressed
    expect(assistantMsgs[1].content).toBe(REAL_ANSWER);
    // No persisted assistant message anywhere carries the leaked query.
    for (const m of assistantMsgs) {
      expect(typeof m.content === 'string' ? m.content : '').not.toContain(LEAKED_QUERY);
    }
  });

  it('suppresses a MARKERLESS continuation fragment that follows a suppressed marker leak', async () => {
    mockDeps();

    const REAL_ANSWER = 'The Washington State Legislature is in regular session; here is the 2026 agenda.';
    jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeLeakedReasoningResponse()) // iter 1: marker leak (finish_reason=length) -> suppressed
      .mockResolvedValueOnce(makeMarkerlessLoopResponse())  // iter 2: markerless loop continuation -> suppressed via chain state
      .mockResolvedValueOnce(makeTextResponse(REAL_ANSWER)); // iter 3: real answer

    const result = await agentModeService.generateMarketingResponse(
      'What is the status and agenda of the Washington State Legislature?',
      [],
      'test-user',
      GEMINI_MODEL,
      'test-session'
    );

    expect(result.content).toBe(REAL_ANSWER);
    // Neither the marker leak nor the markerless continuation may reach the user.
    expect(result.content).not.toContain(LEAKED_QUERY);
    const assistantMsgs = (result.responseMessages as any[]).filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(3);
    expect(assistantMsgs[0].content).toBe(''); // marker leak suppressed
    expect(assistantMsgs[1].content).toBe(''); // markerless continuation suppressed
    expect(assistantMsgs[2].content).toBe(REAL_ANSWER);
    for (const m of assistantMsgs) {
      expect(typeof m.content === 'string' ? m.content : '').not.toContain(LEAKED_QUERY);
    }
  });

  it('does NOT suppress a legitimate truncated Gemini answer (negative case)', async () => {
    mockDeps();

    const COMPLETED_ANSWER =
      'The Washington State Legislature is currently in regular session. Key bills under consideration include HB 1234 on housing.';
    jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeLegitTruncatedResponse()) // iter 1: legit truncated partial (finish_reason=length)
      .mockResolvedValueOnce(makeTextResponse(COMPLETED_ANSWER)); // iter 2: continuation completes the answer

    const result = await agentModeService.generateMarketingResponse(
      'What is the status and agenda of the Washington State Legislature?',
      [],
      'test-user',
      GEMINI_MODEL,
      'test-session'
    );

    const assistantMsgs = (result.responseMessages as any[]).filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    // The legit truncated fragment is kept verbatim — NOT blanked by the leak guard.
    expect(assistantMsgs[0].content).toContain('currently in regular session');
    expect(result.content).toBe(COMPLETED_ANSWER);
  });

  it('backfills a neutral message when the leak ladder is exhausted with no real content (ENG-737 anti-silent-failure)', async () => {
    mockDeps();

    // Every turn is a truncated leak: iter 1-3 consume the max-tokens continuation
    // budget, iter 4 falls through to the final break with content still empty and
    // no tool calls (so the empty-synthesis nudge can't fire). Without the backfill
    // this would deliver a silent zero-output response.
    jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue(makeLeakedReasoningResponse());

    const result = await agentModeService.generateMarketingResponse(
      'What is the status and agenda of the Washington State Legislature?',
      [],
      'test-user',
      GEMINI_MODEL,
      'test-session'
    );

    // The user must never receive an empty response.
    expect(result.content).not.toBe('');
    expect(result.content).toContain('reached the maximum number of processing steps');
    // And the leaked reasoning must not appear in the backfilled message.
    expect(result.content).not.toContain(LEAKED_QUERY);
  });
});
