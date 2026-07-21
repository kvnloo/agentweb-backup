import { AgentModeService, AGENT_MODE_MAX_OUTPUT_TOKENS } from '../services/agentModeService';

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
      // Bedrock rejects { text: '' } for assistant messages — fallback uses '...'
      expect(messages[1].content).toEqual([{ text: '...' }]);
    });

    it('should handle tool_calls stored as a JSON string (legacy/corrupt data)', () => {
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          tool_calls: JSON.stringify([{
            id: 'call_1',
            function: { name: 'test_tool', arguments: '{"key":"value"}' },
          }]),
        },
      ]);

      // Should parse the string and emit a toolUse block rather than crashing
      const toolUseBlock = messages[1].content.find((b: any) => b.toolUse);
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock.toolUse.name).toBe('test_tool');
      expect(toolUseBlock.toolUse.input).toEqual({ key: 'value' });
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

    it('should include screenshot image for a single screenshot tool message', () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: 'Take a screenshot' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call_1', function: { name: 'playwright_browser_take_screenshot', arguments: '{}' } }],
        },
        {
          role: 'tool', tool_call_id: 'call_1',
          content: [
            { type: 'text', text: 'Screenshot captured.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } },
          ],
        },
      ]);

      const toolResultMsg = messages.find((m: any) => m.role === 'user' && m.content[0]?.toolResult);
      const toolResultContent = toolResultMsg.content[0].toolResult.content;
      expect(toolResultContent[0]).toEqual({ text: 'Screenshot captured.' });
      // Single screenshot — image should be included
      expect(toolResultContent[1]).toHaveProperty('image');
      expect(toolResultContent[1].image.format).toBe('png');
    });

    it('should prune images from all but the last screenshot tool message', () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const makeScreenshotMsg = (id: string) => [
        { role: 'user', content: 'Take screenshot' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id, function: { name: 'playwright_browser_take_screenshot', arguments: '{}' } }],
        },
        {
          role: 'tool', tool_call_id: id,
          content: [
            { type: 'text', text: `Screenshot ${id}` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } },
          ],
        },
      ];

      const { messages } = AgentModeService.convertToBedrockConverse([
        ...makeScreenshotMsg('s1'),
        ...makeScreenshotMsg('s2'),
        ...makeScreenshotMsg('s3'),
      ]);

      // Collect all toolResult blocks
      const toolResults: any[] = [];
      for (const m of messages) {
        if (m.role !== 'user') continue;
        for (const block of m.content) {
          if (block.toolResult) toolResults.push(block.toolResult);
        }
      }

      expect(toolResults).toHaveLength(3);

      // First two screenshots: image replaced with placeholder text
      const s1Content = toolResults[0].content;
      expect(s1Content.some((c: any) => c.image)).toBe(false);
      expect(s1Content.some((c: any) => c.text?.includes('[Screenshot captured'))).toBe(true);

      const s2Content = toolResults[1].content;
      expect(s2Content.some((c: any) => c.image)).toBe(false);
      expect(s2Content.some((c: any) => c.text?.includes('[Screenshot captured'))).toBe(true);

      // Last screenshot: image should be present
      const s3Content = toolResults[2].content;
      expect(s3Content.some((c: any) => c.image)).toBe(true);
    });

    it('should keep non-screenshot tool messages unaffected by screenshot pruning', () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const { messages } = AgentModeService.convertToBedrockConverse([
        { role: 'user', content: 'Do stuff' },
        {
          role: 'assistant', content: '',
          tool_calls: [
            { id: 's1', function: { name: 'playwright_browser_take_screenshot', arguments: '{}' } },
            { id: 'n1', function: { name: 'playwright_browser_navigate', arguments: '{"url":"https://example.com"}' } },
          ],
        },
        {
          role: 'tool', tool_call_id: 's1',
          content: [
            { type: 'text', text: 'Screenshot taken.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } },
          ],
        },
        { role: 'tool', tool_call_id: 'n1', content: 'Navigation complete' },
      ]);

      const toolResults: any[] = [];
      for (const m of messages) {
        if (m.role !== 'user') continue;
        for (const block of m.content) {
          if (block.toolResult) toolResults.push(block.toolResult);
        }
      }

      // s1 is the LAST screenshot (only one) — image should be kept
      const s1Content = toolResults[0].content;
      expect(s1Content.some((c: any) => c.image)).toBe(true);

      // n1 is a regular string tool result — unaffected
      const n1Content = toolResults[1].content;
      expect(n1Content).toEqual([{ text: 'Navigation complete' }]);
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

    it('should request an output-token budget large enough for big tool-call arguments (ENG-403)', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [{ role: 'system', content: 'S' }, { role: 'user', content: 'Create an on-brand HTML one-pager' }]
      );

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      // A ~30-40K char content_draft is ~10-13K output tokens; the old 12384 cap
      // truncated the create_html_file tool call, dropping content_draft and
      // triggering a "Missing required argument content_draft" validation loop.
      expect(input.inferenceConfig.maxTokens).toBe(AGENT_MODE_MAX_OUTPUT_TOKENS);
      expect(AGENT_MODE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(32000);
    });

    it('should honor an explicit max_completion_tokens override', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [{ role: 'system', content: 'S' }, { role: 'user', content: 'Hi' }],
        { max_completion_tokens: 2000 }
      );

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      expect(input.inferenceConfig.maxTokens).toBe(2000);
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

    it('should NOT surface a max_tokens-truncated tool call as a completed tool_calls finish (ENG-403)', async () => {
      // A create_html_file call whose large content_draft was cut off mid-argument:
      // Converse returns a toolUse block but stopReason='max_tokens'. Surfacing this
      // as finish_reason='tool_calls' sends an incomplete/invalid tool call to schema
      // validation, which drops the required content_draft and loops with
      // "Missing required argument content_draft". It must instead be reported as a
      // truncation (finish_reason='length', no tool_calls) so the main loop's
      // max-tokens continuation path handles it.
      mockBedrockSend.mockResolvedValue({
        output: {
          message: {
            role: 'assistant',
            content: [
              { toolUse: { toolUseId: 'tc_html', name: 'create_html_file', input: { title: 'One Pager' } } },
            ],
          },
        },
        usage: { inputTokens: 100, outputTokens: 32000 },
        stopReason: 'max_tokens',
      });

      const result = await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [{ role: 'system', content: 'S' }, { role: 'user', content: 'Create an on-brand HTML one-pager' }]
      );

      expect(result.choices[0].finish_reason).toBe('length');
      expect(result.choices[0].message.tool_calls).toBeFalsy();
    });
  });

  describe('sanitizeSchemaForBedrock', () => {
    it('should pass through simple schemas unchanged', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      };
      const result = AgentModeService.sanitizeSchemaForBedrock(schema);
      expect(result).toEqual(schema);
    });

    it('should strip $schema and $ref/$defs', () => {
      const schema = {
        type: 'object',
        '$schema': 'http://json-schema.org/draft-07/schema#',
        properties: { query: { type: 'string' } },
        required: ['query'],
      };
      const result = AgentModeService.sanitizeSchemaForBedrock(schema);
      expect(result['$schema']).toBeUndefined();
      expect(result.properties.query).toEqual({ type: 'string' });
    });

    it('should flatten anyOf with all-const branches to enum', () => {
      const schema = {
        type: 'object',
        properties: {
          units: {
            anyOf: [
              { type: 'string', const: 'metric' },
              { type: 'string', const: 'imperial' },
            ],
            description: 'Measurement units',
          },
        },
      };
      const result = AgentModeService.sanitizeSchemaForBedrock(schema);
      expect(result.properties.units).toEqual({ type: 'string', enum: ['metric', 'imperial'], description: 'Measurement units' });
    });

    it('should convert anyOf with const+open string branch to plain string type', () => {
      const schema = {
        type: 'object',
        properties: {
          freshness: {
            anyOf: [
              { type: 'string', const: 'pd' },
              { type: 'string', const: 'pw' },
              { type: 'string' },
            ],
          },
        },
      };
      const result = AgentModeService.sanitizeSchemaForBedrock(schema);
      expect(result.properties.freshness).toEqual({ type: 'string' });
    });

    it('should drop anyOf when it cannot be safely converted', () => {
      const schema = {
        type: 'object',
        properties: {
          mixed: {
            anyOf: [{ type: 'string' }, { type: 'number' }],
            description: 'Either string or number',
          },
        },
      };
      const result = AgentModeService.sanitizeSchemaForBedrock(schema);
      expect(result.properties.mixed.anyOf).toBeUndefined();
      expect(result.properties.mixed.description).toBe('Either string or number');
    });

    it('should handle legacy MCP search schemas without throwing', () => {
      const legacySearchSchema = {
        type: 'object',
        '$schema': 'http://json-schema.org/draft-07/schema#',
        properties: {
          query: { type: 'string', maxLength: 400, description: 'Search query' },
          units: {
            anyOf: [{ type: 'string', const: 'metric' }, { type: 'string', const: 'imperial' }],
            description: 'Measurement units',
          },
          freshness: {
            type: 'string',
            enum: ['pd', 'pw', 'pm', 'py', 'YYYY-MM-DDtoYYYY-MM-DD'],
          },
          result_filter: {
            type: 'array',
            items: { type: 'string', enum: ['web', 'news', 'query'] },
          },
        },
        required: ['query'],
      };
      const result = AgentModeService.sanitizeSchemaForBedrock(legacySearchSchema);
      expect(result['$schema']).toBeUndefined();
      expect(result.properties.units).toEqual({ type: 'string', enum: ['metric', 'imperial'], description: 'Measurement units' });
      expect(result.properties.query.maxLength).toBe(400);
      expect(result.required).toEqual(['query']);
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain('anyOf');
      expect(resultStr).not.toContain('$schema');
      expect(resultStr).not.toContain('"const"');
    });

    it('should handle null/undefined input gracefully', () => {
      expect(AgentModeService.sanitizeSchemaForBedrock(null)).toBeNull();
      expect(AgentModeService.sanitizeSchemaForBedrock(undefined)).toBeUndefined();
    });
  });
});
