/**
 * ENG-1310 AC1 — "A remembered figure is never presented as a current measurement."
 *
 * ENG-1305's audit named the memory-injection wiring itself as one of four harness
 * mechanisms that make guessing the path of least resistance: agentModeService.ts
 * injected Account/Org memory under a header that literally called the content
 * "facts from previous sessions," with the staleness caution trailing a long list of
 * lines instead of bookending it. Ed's 08-12 session (9481f94e) restated a
 * save_memory'd GA4 figure ("416 form_starts → 91 submits") as current despite the
 * caution existing (ENG-305/1187) — this is the end-to-end proof the wiring fix
 * actually reaches the real conversation the model sees, not just the pure helper.
 */

import { AgentModeService } from '../services/agentModeService';
import { MEMORY_STALENESS_NOTE } from '../utils/memoryRanking';

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

const SAVED_MEMORY = {
  memoryId: 'mem-1',
  category: 'insight',
  content: 'GA4: 416 form_starts, 91 submits',
  createdAt: '2026-07-31T12:00:00.000Z',
  embedding: [],
};

function mockDeps(overrides: { memories?: any[]; orgId?: string | null } = {}) {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(makeSession()),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };

  const mockDb = require('../services/db');
  mockDb.userDb = {
    getUserById: jest.fn().mockResolvedValue({
      userId: 'test-user',
      isAdmin: false,
      memoryEnabled: true,
      orgId: overrides.orgId ?? null,
    }),
  };
  mockDb.accountMemoryDb = {
    getUserMemories: jest.fn().mockResolvedValue(overrides.memories ?? [SAVED_MEMORY]),
    setMemoryEmbedding: jest.fn().mockResolvedValue(undefined),
  };
  mockDb.orgMemoryDb = {
    getOrgMemories: jest.fn().mockResolvedValue([]),
    setMemoryEmbedding: jest.fn().mockResolvedValue(undefined),
  };
  mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue(null) };
}

function makeLLMResponse(text = 'Done.') {
  return {
    choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe('AgentModeService — memory injection wiring (ENG-1310 AC1)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  it('injects account memory bookended by the staleness caution, never headed "facts"', async () => {
    mockDeps();
    const callLLMSpy = jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue(makeLLMResponse());

    await agentModeService.generateMarketingResponse(
      "What's our form conversion?",
      [] as any,
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    const messagesArg = callLLMSpy.mock.calls[0][1] as any[];
    const memoryMsg = messagesArg.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('416 form_starts')
    );
    expect(memoryMsg).toBeDefined();
    // Never claims the notes are verified "facts" — that framing plus assistant-role
    // authorship is exactly what let a stale figure read as a live measurement.
    expect(memoryMsg.content).not.toMatch(/facts from previous sessions/i);
    expect(memoryMsg.content).toContain('Account Memory (unverified notes from previous sessions):');
    // The caution bookends the content — first and last thing the model reads.
    const firstNote = memoryMsg.content.indexOf(MEMORY_STALENESS_NOTE);
    const lastNote = memoryMsg.content.lastIndexOf(MEMORY_STALENESS_NOTE);
    expect(firstNote).toBe(0);
    expect(lastNote).toBeGreaterThan(firstNote);
    // Carries its saved date, so any later reference has a source to attribute (AC1).
    expect(memoryMsg.content).toContain('saved 2026-07-31');
  });

  it('injects no memory message when the account has none (no empty block)', async () => {
    mockDeps({ memories: [] });
    const callLLMSpy = jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue(makeLLMResponse());

    await agentModeService.generateMarketingResponse(
      'Hello',
      [] as any,
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    const messagesArg = callLLMSpy.mock.calls[0][1] as any[];
    // The base system prompt itself mentions "Account Memory" as a capability, so match
    // the actual INJECTED block specifically (its header), not the generic substring.
    const memoryMsg = messagesArg.find(
      (m: any) =>
        typeof m.content === 'string' &&
        m.content.includes('Account Memory (unverified notes from previous sessions):')
    );
    expect(memoryMsg).toBeUndefined();
  });
});
