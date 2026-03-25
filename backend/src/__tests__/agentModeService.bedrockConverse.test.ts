import { AgentModeService } from '../services/agentModeService';

// Mock dependencies
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(),
      scan: jest.fn(), query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 'mock-url', Key: 'mock-key' }),
    }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockBedrockSend,
  })),
  ConverseCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

describe('AgentModeService - Bedrock Converse message conversion', () => {
  describe('convertToBedrockConverse', () => {
    it('should extract system messages into the system array', () => {
      const { system, messages } = AgentModeService.convertToBedrockConverse([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ]);

      expect(system).toEqual([{ text: 'You are a helpful assistant.' }]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: 'user', content: [{ text: 'Hello' }] });
    });

    it('should convert user and assistant messages', () => {
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ]);

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: 'user', content: [{ text: 'Hello' }] });
      expect(messages[1]).toEqual({ role: 'assistant', content: [{ text: 'Hi there!' }] });
      expect(messages[2]).toEqual({ role: 'user', content: [{ text: 'How are you?' }] });
    });

    it('should convert assistant messages with tool calls', () => {
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: 'Search for cats' },
        {
          role: 'assistant',
          content: 'Let me search for that.',
          tool_calls: [{
            id: 'call_1',
            function: { name: 'web_search', arguments: '{"query": "cats"}' },
          }],
        },
      ]);

      expect(messages).toHaveLength(2);
      expect(messages[1].content).toEqual([
        { text: 'Let me search for that.' },
        {
          toolUse: {
            toolUseId: 'call_1',
            name: 'web_search',
            input: { query: 'cats' },
          },
        },
      ]);
    });

    it('should convert tool results into user messages with toolResult blocks', () => {
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: 'Search' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{}' } }],
        },
        { role: 'tool', content: 'Result data', tool_call_id: 'call_1' },
      ]);

      expect(messages).toHaveLength(3);
      // Tool result should be a user message with toolResult block
      expect(messages[2].role).toBe('user');
      expect(messages[2].content[0]).toEqual({
        toolResult: {
          toolUseId: 'call_1',
          content: [{ text: 'Result data' }],
        },
      });
    });

    it('should merge consecutive same-role messages', () => {
      // Two consecutive tool results should be merged into one user message
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', function: { name: 'tool_a', arguments: '{}' } },
            { id: 'call_2', function: { name: 'tool_b', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'Result A', tool_call_id: 'call_1' },
        { role: 'tool', content: 'Result B', tool_call_id: 'call_2' },
      ]);

      // user, assistant, user (merged tool results)
      expect(messages).toHaveLength(3);
      expect(messages[2].role).toBe('user');
      expect(messages[2].content).toHaveLength(2);
      expect(messages[2].content[0].toolResult.toolUseId).toBe('call_1');
      expect(messages[2].content[1].toolResult.toolUseId).toBe('call_2');
    });

    it('should prepend user message if first message is not user role', () => {
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'assistant', content: 'Hello, I am an assistant.' },
      ]);

      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toEqual([{ text: '.' }]);
      expect(messages[1].role).toBe('assistant');
    });

    it('should handle array content (multimodal text)', () => {
      const { messages } = AgentModeService.convertToBedrockConverse([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this:' },
            { type: 'text', text: 'More context' },
          ],
        },
      ]);

      expect(messages[0].content).toEqual([
        { text: 'Look at this:' },
        { text: 'More context' },
      ]);
    });

    it('should handle image_url content with base64 data', () => {
      // Create a small 1x1 red PNG as base64
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const { messages } = AgentModeService.convertToBedrockConverse([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } },
          ],
        },
      ]);

      expect(messages[0].content).toHaveLength(2);
      expect(messages[0].content[0]).toEqual({ text: 'What is this?' });
      expect(messages[0].content[1].image).toBeDefined();
      expect(messages[0].content[1].image.format).toBe('png');
      expect(messages[0].content[1].image.source.bytes).toBeInstanceOf(Buffer);
    });

    it('should handle empty content gracefully', () => {
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: '' },
        { role: 'assistant', content: null },
      ]);

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toEqual([{ text: '' }]);
      expect(messages[1].content).toEqual([{ text: '' }]);
    });

    it('should handle malformed tool call arguments gracefully', () => {
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            function: { name: 'test', arguments: 'not-valid-json' },
          }],
        },
      ]);

      // Should fall back to { raw: ... } instead of throwing
      // Assistant with empty content '' has only the toolUse block
      const toolUseBlock = messages[1].content.find((b: any) => b.toolUse);
      expect(toolUseBlock.toolUse.input).toEqual({ raw: 'not-valid-json' });
    });

    it('should handle multiple system messages', () => {
      const { system } = AgentModeService.convertToBedrockConverse([
        { role: 'system', content: 'Part 1' },
        { role: 'system', content: 'Part 2' },
        { role: 'user', content: 'Hello' },
      ]);

      expect(system).toEqual([{ text: 'Part 1' }, { text: 'Part 2' }]);
    });
  });

  describe('Prompt caching markers', () => {
    let agentModeService: AgentModeService;

    beforeEach(() => {
      agentModeService = new AgentModeService();
      jest.clearAllMocks();
      process.env.AWS_REGION = 'us-west-2';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';

      // Return a valid Bedrock response
      mockBedrockSend.mockResolvedValue({
        output: { message: { role: 'assistant', content: [{ text: 'response' }] } },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 80,
          cacheWriteInputTokens: 0,
        },
        stopReason: 'end_turn',
      });
    });

    afterEach(() => {
      delete process.env.AWS_REGION;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    });

    it('should add cachePoint after system prompt', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [
          { role: 'system', content: 'System prompt here' },
          { role: 'user', content: 'Hello' },
        ]
      );

      expect(ConverseCommand).toHaveBeenCalled();
      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      // System array should have the text + cachePoint
      expect(input.system).toEqual([
        { text: 'System prompt here' },
        { cachePoint: { type: 'default' } },
      ]);
    });

    it('should add cachePoint before last message for conversation prefix caching', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [
          { role: 'system', content: 'System' },
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Second message' },
        ]
      );

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      // messages[1] (assistant) should have cachePoint appended (second-to-last)
      const secondToLast = input.messages[input.messages.length - 2];
      const lastBlock = secondToLast.content[secondToLast.content.length - 1];
      expect(lastBlock).toEqual({ cachePoint: { type: 'default' } });
    });

    it('should NOT add conversation cachePoint for short conversations (<=2 messages)', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [
          { role: 'system', content: 'System' },
          { role: 'user', content: 'Hello' },
        ]
      );

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      // Only 1 message (user), no cachePoint in messages
      for (const msg of input.messages) {
        for (const block of msg.content) {
          expect(block).not.toHaveProperty('cachePoint');
        }
      }
    });

    it('should include cache token counts in the response usage', async () => {
      const result = await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [
          { role: 'system', content: 'System' },
          { role: 'user', content: 'Hello' },
        ]
      );

      expect(result.usage.cache_read_input_tokens).toBe(80);
      expect(result.usage.cache_creation_input_tokens).toBe(0);
      expect(result.usage.prompt_tokens).toBe(100);
      expect(result.usage.completion_tokens).toBe(20);
    });

    it('should convert tools to Bedrock toolConfig format', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [
          { role: 'system', content: 'System' },
          { role: 'user', content: 'Search' },
        ],
        {
          tools: [{
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          }],
          tool_choice: 'auto',
        }
      );

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      expect(input.toolConfig).toEqual({
        tools: [{
          toolSpec: {
            name: 'web_search',
            description: 'Search the web',
            inputSchema: { json: { type: 'object', properties: { query: { type: 'string' } } } },
          },
        }],
      });
    });

    it('should extract tool calls from Bedrock response', async () => {
      mockBedrockSend.mockResolvedValue({
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Let me search for that.' },
              { toolUse: { toolUseId: 'tc_1', name: 'web_search', input: { query: 'cats' } } },
            ],
          },
        },
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'tool_use',
      });

      const result = await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [
          { role: 'system', content: 'System' },
          { role: 'user', content: 'Search for cats' },
        ]
      );

      expect(result.choices[0].message.content).toBe('Let me search for that.');
      expect(result.choices[0].message.tool_calls).toEqual([{
        id: 'tc_1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"cats"}' },
      }]);
      expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    it('should handle max_tokens stop reason', async () => {
      mockBedrockSend.mockResolvedValue({
        output: { message: { role: 'assistant', content: [{ text: 'truncated...' }] } },
        usage: { inputTokens: 100, outputTokens: 12384 },
        stopReason: 'max_tokens',
      });

      const result = await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [{ role: 'system', content: 'S' }, { role: 'user', content: 'Write a long essay' }]
      );

      expect(result.choices[0].finish_reason).toBe('length');
    });
  });
});
