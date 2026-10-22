/**
 * ENG-669 PR-C: a turn the AgentWeb Model routed carries, on each assistant message, the SELECTION (`llmSelected`) and
 * the table rule that chose the model, beside the concrete `llm` that ran ("AgentWeb Model · via <llm>"). The routed
 * model is called alone: no fallback models are handed to the gateway, so its failure is the turn's visible error.
 */
import { AgentModeService } from '../services/agentModeService';
import type { MessageModelRouting } from '../services/agentMode/agentWebModelRouter';

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

const ROUTED = 'gemini-3.5-flash';
const ROUTING: MessageModelRouting = { llmSelected: 'agentweb-model', llmRoutingReason: 'chat task: table default', llmRoutingTableVersion: 't1' };

function mockDeps() {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue({ sessionId: 'test-session', messages: [], associatedSkills: null, llmModel: 'agentweb-model' }),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };
  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };
  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
}

describe('AgentModeService - ENG-669 AgentWeb Model stamp', () => {
  let service: AgentModeService;
  let callLLM: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeps();
    service = new AgentModeService();
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);
    callLLM = jest.spyOn(service as any, 'callLLM').mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'Done.', tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
  });

  const run = (modelRouting?: MessageModelRouting) => service.generateMarketingResponse(
    'summarise the leads', [] as any, 'test-user', ROUTED, 'test-session',
    false, undefined, undefined, false, undefined, undefined, undefined, false, false, undefined, undefined, undefined, false, undefined,
    modelRouting,
  );

  it('stamps the selection and the routing reason beside the concrete llm', async () => {
    const result = await run(ROUTING);
    const assistant = result.responseMessages.find((m: any) => m.role === 'assistant');
    expect(assistant).toMatchObject({ llm: ROUTED, ...ROUTING });
  });

  it('calls only the routed model, with no fallback models', async () => {
    await run(ROUTING);
    expect(callLLM).toHaveBeenCalled();
    for (const [model, , options] of callLLM.mock.calls) {
      expect(model).toBe(ROUTED);
      expect(options?.fallbackModels).toBeUndefined();
    }
  });

  it('stamps nothing extra on a turn that was not routed', async () => {
    const result = await run(undefined);
    const assistant = result.responseMessages.find((m: any) => m.role === 'assistant');
    expect(assistant.llm).toBe(ROUTED);
    expect(assistant).not.toHaveProperty('llmSelected');
    expect(assistant).not.toHaveProperty('llmRoutingReason');
  });
});
