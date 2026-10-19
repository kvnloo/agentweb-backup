import { scoreSession, scoreSessionWithJudge, ScoringJudge } from '../services/sessionScoringService';
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
  settingsService: { getSetting: jest.fn().mockResolvedValue(null) },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

type LlmResult = Awaited<ReturnType<typeof agentModeService.callLLM>>;
const llmWith = (content: string): LlmResult => ({ choices: [{ message: { content } }] } as unknown as LlmResult);

const promptTextOf = () => (mockCallLLM.mock.calls[0][1][1] as { content: string }).content;

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'You are a test judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/**
 * A tool-calls-only assistant turn carries content: undefined, not an empty string. Reproduced
 * directly against real production AW-ChatMessages data (2026-10-09): JSON.stringify(undefined)
 * returns the actual undefined value, not the string "undefined", so .trim()/.length on it threw
 * a TypeError in ~29% of a real replay sample.
 */
describe('serializeMessagesForScoring: content is undefined, not an empty string', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLM.mockResolvedValue(llmWith(JSON.stringify({ score: 4, reason: 'fine' })));
  });

  it('scoreSessionWithJudge: an assistant tool-calls-only turn with content undefined does not throw', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do the thing.' },
      { role: 'assistant', content: undefined as any, metadata: { toolCalls: [{ name: 'search_web' }] } as any },
    ];

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(4);
    expect(promptTextOf()).toContain('assistant: [called tools: search_web]');
    expect(promptTextOf()).not.toContain('undefined');
    // content undefined must read as empty text, not as the JSON string "" (two quote characters).
    expect(promptTextOf()).not.toContain('""');
  });

  it('scoreSession: the same tool-calls-only shape does not throw on the general scorer', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do the thing.' },
      { role: 'assistant', content: undefined as any, metadata: { toolCalls: [{ name: 'search_web' }] } as any },
    ];

    const result = await scoreSession(messages, messages.length);

    expect(result.score).toBe(4);
    expect(promptTextOf()).toContain('assistant: [called tools: search_web]');
    expect(promptTextOf()).not.toContain('""');
  });

  it('an assistant turn with content undefined and no tool calls is skipped, not rendered as "undefined"', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do the thing.' },
      { role: 'assistant', content: undefined as any },
      { role: 'assistant', content: 'Done.' },
    ];

    await scoreSessionWithJudge(messages, messages.length, judge);

    expect(promptTextOf()).not.toContain('undefined');
    expect(promptTextOf()).not.toContain('""');
    // a genuinely empty assistant turn is skipped, exactly like content: ""
    expect(promptTextOf()).not.toMatch(/assistant:\s*\n/);
    expect(promptTextOf()).toContain('assistant: Done.');
  });

  it('a user message with content undefined renders as empty text, not the string "undefined"', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: undefined as any },
      { role: 'assistant', content: 'Done.' },
    ];

    await scoreSessionWithJudge(messages, messages.length, judge);

    expect(promptTextOf()).toContain('user: \n');
    expect(promptTextOf()).not.toContain('undefined');
  });

  it('a tool message with content undefined does not throw on raw.length', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do the thing.' },
      { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'search_web' }] } as any },
      { role: 'tool', content: undefined as any, name: 'search_web' } as any,
      { role: 'assistant', content: 'Done.' },
    ];

    const result = await scoreSessionWithJudge(messages, messages.length, judge);

    expect(result.score).toBe(4);
    expect(promptTextOf()).toContain('tool result (search_web): ');
    expect(promptTextOf()).not.toContain('""');
  });

  it('a null content behaves the same as undefined (regression: JSON.stringify(null) is "null", not empty)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: null as any },
      { role: 'assistant', content: 'Done.' },
    ];

    await scoreSessionWithJudge(messages, messages.length, judge);

    expect(promptTextOf()).toContain('user: \n');
    expect(promptTextOf()).not.toContain('null');
  });

  it('non-string, non-null content (content blocks, objects) is still JSON-stringified exactly as before', async () => {
    const blocks = [{ type: 'text', text: 'hi' }];
    const messages: ChatMessage[] = [
      { role: 'user', content: blocks as any },
      { role: 'assistant', content: { note: 'structured' } as any },
      { role: 'tool', content: { ok: true } as any, name: 'search_web' } as any,
    ];

    await scoreSessionWithJudge(messages, messages.length, judge);

    expect(promptTextOf()).toContain(`user: ${JSON.stringify(blocks)}`);
    expect(promptTextOf()).toContain('assistant: {"note":"structured"}');
    expect(promptTextOf()).toContain('tool result (search_web): {"ok":true}');
  });

  it('an empty-string assistant turn and an undefined one render identically (both skipped)', async () => {
    const withEmpty: ChatMessage[] = [
      { role: 'user', content: 'Go.' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'Done.' },
    ];
    const withUndefined: ChatMessage[] = [
      { role: 'user', content: 'Go.' },
      { role: 'assistant', content: undefined as any },
      { role: 'assistant', content: 'Done.' },
    ];

    await scoreSessionWithJudge(withEmpty, withEmpty.length, judge);
    const emptyPrompt = promptTextOf();
    mockCallLLM.mockClear();
    mockCallLLM.mockResolvedValue(llmWith(JSON.stringify({ score: 4, reason: 'fine' })));
    await scoreSessionWithJudge(withUndefined, withUndefined.length, judge);

    expect(promptTextOf()).toBe(emptyPrompt);
  });

  it('string content still works exactly as before (no regression)', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    await scoreSessionWithJudge(messages, messages.length, judge);

    expect(promptTextOf()).toContain('user: Hello');
    expect(promptTextOf()).toContain('assistant: Hi there');
  });
});
