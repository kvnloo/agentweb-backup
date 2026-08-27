/**
 * ENG-1565 — service-level wiring for the model-reassess acknowledgement.
 * The pure-function contract is covered in utils/__tests__/modelReassessRequest.test.ts;
 * this proves the reconciler is actually wired into generateMarketingResponse's
 * finalize seam and reads the right "before" model from session history.
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

function makeSession(sessionId = 'test-session') {
  return { sessionId, messages: [], associatedSkills: null };
}

function mockDeps(overrides: { session?: any } = {}) {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(overrides.session ?? makeSession()),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };

  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
}

function makeTextResponse(text: string) {
  return {
    choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
  };
}

describe('AgentModeService - ENG-1565 model-reassess acknowledgement', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    jest.spyOn(agentModeService as any, 'generateSuggestedReplies').mockResolvedValue([]);
  });

  it('acknowledges the model did not change when the message asks to reassess with a new model', async () => {
    mockDeps();
    jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeTextResponse('Here is the report you asked for.'));

    const priorHistory = [
      { role: 'user', content: 'Generate a report.' },
      { role: 'assistant', content: 'Report ready.', llm: 'gemini-3.7-flash' },
    ] as any;

    const result = await agentModeService.generateMarketingResponse(
      'That looked off — please reassess using a new model.',
      priorHistory,
      'test-user',
      'gemini-3.7-flash', // same model as the prior turn
      'test-session',
    );

    expect(result.content).toContain('Here is the report you asked for.');
    expect(result.content).toContain("can't switch models from a chat message");
    expect(result.content).toContain('gemini-3.7-flash');
  });

  it('does NOT acknowledge when the message is not a model-change request (no false positive)', async () => {
    mockDeps();
    jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeTextResponse('Here is the report you asked for.'));

    const priorHistory = [
      { role: 'assistant', content: 'Report ready.', llm: 'gemini-3.7-flash' },
    ] as any;

    const result = await agentModeService.generateMarketingResponse(
      'Can you also check the CRM for new leads?',
      priorHistory,
      'test-user',
      'gemini-3.7-flash',
      'test-session',
    );

    expect(result.content).toBe('Here is the report you asked for.');
  });

  it('does NOT acknowledge when the model actually changed (e.g. picker flipped this turn)', async () => {
    mockDeps();
    jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeTextResponse('Here is the report you asked for.'));

    const priorHistory = [
      { role: 'assistant', content: 'Report ready.', llm: 'gemini-3.7-flash' },
    ] as any;

    const result = await agentModeService.generateMarketingResponse(
      'Please reassess using a new model.',
      priorHistory,
      'test-user',
      'anthropic.claude-opus-4-8', // different, valid model — the request WAS actioned via the picker
      'test-session',
    );

    expect(result.content).toBe('Here is the report you asked for.');
  });

  it('does NOT acknowledge when there is no prior model to compare against', async () => {
    mockDeps();
    jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeTextResponse('Here is the report you asked for.'));

    const result = await agentModeService.generateMarketingResponse(
      'Please reassess using a new model.',
      [] as any, // no prior history — nothing to compare against
      'test-user',
      'gemini-3.7-flash',
      'test-session',
    );

    expect(result.content).toBe('Here is the report you asked for.');
  });
});
