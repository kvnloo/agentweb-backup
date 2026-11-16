/**
 * ENG-1205 AC3/AC4 — service-level wiring for the named-model acknowledgement.
 *
 * The pure contract lives in utils/__tests__/modelMentionRequest.test.ts; this
 * proves the reconciler is actually wired into generateMarketingResponse's
 * finalize seam, reads the session owner's entitlement for the copy branch, and
 * does not stack with the ENG-1565 acknowledgement it sits next to.
 */

import { AgentModeService } from '../services/agentModeService';

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

const FLASH_LITE = 'gemini-3.1-flash-lite';
const OPUS_5 = 'anthropic.claude-opus-5';
const REPLY = 'Here are the 107 leads, sorted by revenue.';

function mockDeps({ isAdmin = false, policyDecision = undefined }: { isAdmin?: boolean; policyDecision?: any } = {}) {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue({
      sessionId: 'test-session',
      messages: [],
      associatedSkills: null,
      ...(policyDecision ? { llmUsagePolicyDecision: policyDecision } : {}),
    }),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };

  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
}

function makeTextResponse(text: string) {
  return {
    choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
  };
}

describe('AgentModeService - ENG-1205 named-model acknowledgement', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AGENT_MODEL_MENTION_ACK;
    agentModeService = new AgentModeService();
    jest.spyOn(agentModeService as any, 'generateSuggestedReplies').mockResolvedValue([]);
  });

  const run = (messageContent: string, llmModel: string, history: any[] = []) => {
    jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValueOnce(makeTextResponse(REPLY));
    return agentModeService.generateMarketingResponse(
      messageContent, history as any, 'test-user', llmModel, 'test-session',
    );
  };

  it('answers the ENG-1205 production message instead of dropping it silently', async () => {
    // Session d5898ffd, 2026-08-14: the user asked for Opus 5 at message 71 and
    // the next nine turns still ran on Flash Lite, with no reply of any kind.
    mockDeps({ isAdmin: false });
    const result = await run(
      'Use Opus 5 model, and make sure you sort all of the 107 leads by revenue',
      FLASH_LITE,
    );

    expect(result.content).toContain(REPLY);
    expect(result.content).toContain('Claude Opus 5');
    expect(result.content).toContain('Gemini 3.1 Flash Lite');
    // ENG-2028: flipped. Opus is selectable by non-admins now (no name-based
    // deny), so this is the picker-guidance branch, not the entitlement branch.
    expect(result.content).toMatch(/can't change models from a chat message/i);
    expect(result.content).not.toMatch(/can't be selected on your account|not available/i);
  });

  it('tells an entitled user how to actually switch, rather than that it is unavailable', async () => {
    mockDeps({ isAdmin: true });
    const result = await run('please use Opus 5 for this one', FLASH_LITE);

    expect(result.content).toMatch(/can't change models from a chat message/i);
    expect(result.content).not.toMatch(/can't be selected on your account/i);
    expect(result.content).toContain('Claude Opus 5');
  });

  it('stays silent when the turn already ran on the model that was named', async () => {
    mockDeps();
    const result = await run('use gemini 3.1 flash lite for this', FLASH_LITE);
    expect(result.content).toBe(REPLY);
  });

  it('stays silent when the message names no model (no false positive)', async () => {
    mockDeps();
    const result = await run('Can you also check the CRM for new leads?', FLASH_LITE);
    expect(result.content).toBe(REPLY);
  });

  it('appends exactly one note when the message trips both detectors', async () => {
    // "a different model" is ENG-1565's trigger and "Opus 5" is this one's. The
    // specific note wins; two stacked notes saying the same thing is worse.
    mockDeps({ isAdmin: true });
    const history = [{ role: 'assistant', content: 'Earlier reply.', llm: FLASH_LITE }];
    const result = await run(
      'switch to a different model, use Opus 5 please',
      FLASH_LITE,
      history,
    );

    expect(result.content.match(/Note:/g)).toHaveLength(1);
    expect(result.content).toContain('Claude Opus 5');
    expect(result.content).not.toMatch(/can't switch models from a chat message/i);
  });

  it('leaves the ENG-1565 acknowledgement working when this one is switched off', async () => {
    process.env.AGENT_MODEL_MENTION_ACK = 'false';
    mockDeps();
    const history = [{ role: 'assistant', content: 'Earlier reply.', llm: FLASH_LITE }];
    const result = await run('please reassess using a new model', FLASH_LITE, history);

    expect(result.content).toMatch(/can't switch models from a chat message/i);
  });

  it('is switched off entirely by AGENT_MODEL_MENTION_ACK=false', async () => {
    process.env.AGENT_MODEL_MENTION_ACK = 'false';
    mockDeps();
    const result = await run('use Opus 5 please', FLASH_LITE);
    expect(result.content).toBe(REPLY);
  });

  /**
   * ENG-1205 — the correction must reach the PERSISTED message, or it vanishes
   * on reload and the badge is left disagreeing with the picker for no stated
   * reason. Stamped beside `llm`, the per-message provenance seam from ENG-892.
   */
  describe('per-message correction stamp', () => {
    const CORRECTED = {
      requestedModel: OPUS_5,
      effectiveModel: FLASH_LITE,
      modelSelection: 'corrected',
      modelSelectionReason: 'requested_model_unavailable_using_default',
    };

    it('stamps the correction on the assistant message the turn produced', async () => {
      mockDeps({ policyDecision: CORRECTED });
      const result = await run('summarise the leads', FLASH_LITE);

      const assistant = result.responseMessages.find((m: any) => m.role === 'assistant');
      expect(assistant.llm).toBe(FLASH_LITE);
      expect(assistant.modelCorrection).toEqual({
        requestedModel: OPUS_5,
        effectiveModel: FLASH_LITE,
      });
    });

    it('stamps nothing when the request was honored', async () => {
      mockDeps({
        policyDecision: { requestedModel: FLASH_LITE, effectiveModel: FLASH_LITE, modelSelection: 'honored' },
      });
      const result = await run('summarise the leads', FLASH_LITE);

      const assistant = result.responseMessages.find((m: any) => m.role === 'assistant');
      expect(assistant.llm).toBe(FLASH_LITE);
      expect(assistant.modelCorrection).toBeUndefined();
    });

    it('stamps nothing when the session decision describes a different turn', async () => {
      // The slot is overwritten every turn; a resumed run must not borrow it.
      mockDeps({ policyDecision: CORRECTED });
      const result = await run('summarise the leads', 'gemini-3.5-flash');

      const assistant = result.responseMessages.find((m: any) => m.role === 'assistant');
      expect(assistant.modelCorrection).toBeUndefined();
    });

    it('stamps nothing when the session carries no decision at all', async () => {
      mockDeps();
      const result = await run('summarise the leads', FLASH_LITE);

      const assistant = result.responseMessages.find((m: any) => m.role === 'assistant');
      expect(assistant.modelCorrection).toBeUndefined();
    });
  });
});
