/**
 * ENG-2104 F3 — drives the REAL EmmaLoopBackend against the REAL agentModeService
 * singleton (only its dependencies and the one LLM call are stubbed), instead of
 * stubbing generateMarketingResponse like runBackend.test.ts does. This is the closest
 * check available to production behaviour, because nothing in production calls
 * EmmaLoopBackend yet (B4 does the cutover).
 */
import { agentModeService } from '../../agentModeService';
import { EmmaLoopBackend } from '../runBackend';
import { RunEmitter, type RunEvent } from '../../agentMode/streamEvents';

jest.mock('openai');
jest.mock('../../settingsService');
jest.mock('../../db');
jest.mock('../../chatbotService');
jest.mock('../../../utils/secretsManager');
jest.mock('../../skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

function mockDeps() {
  const chatbot = require('../../chatbotService');
  chatbot.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue({ sessionId: 's1', messages: [], associatedSkills: null }),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };
  require('../../settingsService').settingsService = { getSetting: jest.fn().mockResolvedValue(null) };
  const db = require('../../db');
  db.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'u1', isAdmin: false }) };
  db.accountMemoryDb = { getUserMemories: jest.fn().mockResolvedValue([]), getRecentMemories: jest.fn().mockResolvedValue([]) };
}

const llmResponse = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const params = () => ({
  messageContent: 'hello',
  sessionHistory: [{ role: 'user', content: 'hello' }] as any,
  userId: 'u1',
  llmModel: agentModeService.default_model,
  sessionId: 's1',
  mockMode: true,
});

describe('EmmaLoopBackend against the real agentModeService (ENG-2104 F3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeps();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('completed run: real result, legacy onProgress still fires, typed terminal events emitted', async () => {
    jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue(llmResponse('Done.'));
    const events: RunEvent[] = [];
    const onProgress = jest.fn();

    const result = await new EmmaLoopBackend().run(params() as any, {
      onProgress,
      socketEmit: jest.fn(),
      isCancelled: () => false,
      emitter: new RunEmitter('run-it-1', (e) => events.push(e)),
    });

    expect(result.content).toBe('Done.');
    expect(onProgress).toHaveBeenCalled();
    expect(events.map((e) => e.part)).toEqual([
      { type: 'attempt-finished', outcome: 'completed', toolCalls: 0 },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('cancelled run: the real loop stops, resolves normally, and is reported as cancelled', async () => {
    const llm = jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue(llmResponse('x'));
    const events: RunEvent[] = [];

    const result = await new EmmaLoopBackend().run(params() as any, {
      onProgress: jest.fn(),
      socketEmit: jest.fn(),
      isCancelled: () => true,
      emitter: new RunEmitter('run-it-2', (e) => events.push(e)),
    });

    expect(llm).not.toHaveBeenCalled();
    expect(result.content).toBe('Generation was stopped.');
    expect(events.map((e) => e.part)).toEqual([
      { type: 'attempt-finished', outcome: 'cancelled', toolCalls: 0 },
      { type: 'finish', reason: 'cancelled' },
    ]);
  });

  it('works unchanged without an emitter', async () => {
    jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue(llmResponse('Done.'));
    const result = await new EmmaLoopBackend().run(params() as any, {
      onProgress: jest.fn(),
      socketEmit: jest.fn(),
      isCancelled: () => false,
    });
    expect(result.content).toBe('Done.');
  });

  it('a throwing sink does not change the real run result', async () => {
    jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue(llmResponse('Done.'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await new EmmaLoopBackend().run(params() as any, {
      onProgress: jest.fn(),
      socketEmit: jest.fn(),
      isCancelled: () => false,
      emitter: new RunEmitter('run-it-3', () => { throw new Error('sink down'); }),
    });
    expect(result.content).toBe('Done.');
  });
});
