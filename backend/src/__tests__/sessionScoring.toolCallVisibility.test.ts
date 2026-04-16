import { scoreSession } from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

function makeLLMResponse(score: number, reason: string) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason }) } }],
  } as any;
}

describe('SessionScoring - Tool Call Visibility for Judge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes [called tools: ...] when assistant message has only tool calls and no text content', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'tools were used'));

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Create a LinkedIn post using create_social_media_posts' },
      {
        role: 'assistant',
        content: '',
        metadata: {
          timestamp: '2026-01-01T00:00:00.000Z',
          toolCalls: [
            { id: 'tc1', name: 'search_web', arguments: { query: 'AI trends' } },
            { id: 'tc2', name: 'create_social_media_posts', arguments: { posts: [] } },
          ],
        },
      },
    ];

    await scoreSession(messages, 2);

    const userMessage = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user');
    expect(userMessage.content).toContain('[called tools: search_web, create_social_media_posts]');
    // Should NOT contain a bare "assistant: " with empty content
    expect(userMessage.content).not.toMatch(/^assistant: $/m);
  });

  it('includes tool result messages in the conversation text sent to judge', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'great'));

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search for something' },
      {
        role: 'assistant',
        content: '',
        metadata: {
          timestamp: '2026-01-01T00:00:00.000Z',
          toolCalls: [{ id: 'tc1', name: 'search_web', arguments: {} }],
        },
      },
      {
        role: 'tool',
        content: '{"results": "Found 10 relevant articles about AI"}',
        name: 'search_web',
        tool_call_id: 'tc1',
      } as any,
      { role: 'assistant', content: 'Here are the search results...' },
    ];

    await scoreSession(messages, 4);

    const userMessage = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user');
    expect(userMessage.content).toContain('tool result (search_web):');
    expect(userMessage.content).toContain('Found 10 relevant articles');
  });

  it('appends [called tools: ...] after text when assistant has both text and tool calls', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'ok'));

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do the task' },
      {
        role: 'assistant',
        content: 'I will search for that now.',
        metadata: {
          timestamp: '2026-01-01T00:00:00.000Z',
          toolCalls: [{ id: 'tc1', name: 'search_web', arguments: {} }],
        },
      },
    ];

    await scoreSession(messages, 2);

    const userMessage = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user');
    expect(userMessage.content).toContain('assistant: I will search for that now.');
    expect(userMessage.content).toContain('[called tools: search_web]');
  });

  it('skips completely empty assistant messages (no text, no tool calls)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(3, 'neutral'));

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: '' }, // no toolCalls, no text
      { role: 'assistant', content: 'Hi there!' },
    ];

    await scoreSession(messages, 3);

    const userMessage = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user');
    // Should only have one assistant line
    const assistantLines = userMessage.content.split('\n').filter((l: string) => l.startsWith('assistant:'));
    expect(assistantLines).toHaveLength(1);
    expect(assistantLines[0]).toBe('assistant: Hi there!');
  });

  it('truncates long tool result content to MAX_TOOL_CONTENT_FOR_SCORING chars', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, 'ok'));

    const longContent = 'x'.repeat(2000);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Get data' },
      {
        role: 'tool',
        content: longContent,
        name: 'some_tool',
        tool_call_id: 'tc1',
      } as any,
    ];

    await scoreSession(messages, 2);

    const userMessage = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user');
    // Tool result should be truncated with ellipsis
    expect(userMessage.content).toContain('tool result (some_tool):');
    expect(userMessage.content).toContain('…');
    expect(userMessage.content).not.toContain('x'.repeat(2000));
  });

  it('excludes system messages from the serialized transcript', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, 'great'));

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant. [SYSTEM CONTEXT]' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];

    await scoreSession(messages, 3);

    const userMessage = (mockCallLLM.mock.calls[0][1] as any[]).find((m) => m.role === 'user');
    expect(userMessage.content).not.toContain('SYSTEM CONTEXT');
    expect(userMessage.content).toContain('user: Hello');
    expect(userMessage.content).toContain('assistant: Hi!');
  });
});
