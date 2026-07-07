import { isTransientLLMError } from '../utils/agentModeErrors';

// ─── 1. isTransientLLMError() ────────────────────────────────────────────────

describe('isTransientLLMError', () => {
  // FAIL tests — errors that should NOT be retried
  it('should return false for null/undefined', () => {
    expect(isTransientLLMError(null)).toBe(false);
    expect(isTransientLLMError(undefined)).toBe(false);
  });

  it('should return false for 400 Bad Request', () => {
    const error: any = new Error('Bad Request');
    error.status = 400;
    expect(isTransientLLMError(error)).toBe(false);
  });

  it('should return false for 401 Unauthorized', () => {
    const error: any = new Error('Unauthorized');
    error.status = 401;
    expect(isTransientLLMError(error)).toBe(false);
  });

  it('should return false for context limit errors', () => {
    expect(isTransientLLMError(new Error('prompt is too long: 204190 tokens > 200000 maximum'))).toBe(false);
    expect(isTransientLLMError(new Error('context length exceeded'))).toBe(false);
  });

  // SUCCESS tests — errors that SHOULD be retried
  it('should return true for 503 Service Unavailable', () => {
    const error: any = new Error('503 status code (no body)');
    error.status = 503;
    expect(isTransientLLMError(error)).toBe(true);
  });

  it('should return true for 429 rate limit', () => {
    const error: any = new Error('Rate limit exceeded');
    error.status = 429;
    expect(isTransientLLMError(error)).toBe(true);
  });

  it('should return true for timeout errors', () => {
    expect(isTransientLLMError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isTransientLLMError(new Error('socket hang up'))).toBe(true);
    expect(isTransientLLMError(new Error('ECONNRESET'))).toBe(true);
  });

  it('should return true for throttling errors', () => {
    expect(isTransientLLMError(new Error('ThrottlingException: Rate exceeded'))).toBe(true);
    expect(isTransientLLMError(new Error('Too many requests'))).toBe(true);
  });

  it('should return true for 502 Bad Gateway', () => {
    const error: any = new Error('Bad Gateway');
    error.status = 502;
    expect(isTransientLLMError(error)).toBe(true);
  });

  it('should detect status via error.code or error.response.status', () => {
    const errWithCode: any = new Error('server error');
    errWithCode.code = 503;
    expect(isTransientLLMError(errWithCode)).toBe(true);

    const errWithResponseStatus: any = new Error('bad gateway');
    errWithResponseStatus.response = { status: 502 };
    expect(isTransientLLMError(errWithResponseStatus)).toBe(true);
  });

  it('should handle string errors', () => {
    expect(isTransientLLMError('503 status code')).toBe(true);
    expect(isTransientLLMError('random error')).toBe(false);
  });

  it('should return true for 500 Internal Server Error (status code)', () => {
    const error: any = new Error('Internal Server Error');
    error.status = 500;
    expect(isTransientLLMError(error)).toBe(true);
  });

  it('should return true for "internal server error" message pattern', () => {
    expect(isTransientLLMError(new Error('InternalServerError: service unavailable'))).toBe(true);
    expect(isTransientLLMError(new Error('internal server error'))).toBe(true);
  });

  it('should return true for "500" in error message', () => {
    expect(isTransientLLMError(new Error('500 status code (no body)'))).toBe(true);
    expect(isTransientLLMError('500 error from upstream')).toBe(true);
  });
});

// ─── 2. callLLM() retry logic ────────────────────────────────────────────────

// We need to test callLLM retry without instantiating the full AgentModeService.
// Use prototype-level testing by extracting the retry-wrapped callLLM.

// Mocks must use paths relative to the source file being imported, not the test file
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: jest.fn(), createChatSession: jest.fn(), addMessageToSession: jest.fn(), updateSession: jest.fn(), getSessionMessages: jest.fn() },
  ChatMessage: jest.fn(),
  searchPlatformKnowledgeBase: jest.fn(),
}));
jest.mock('../services/db', () => ({ taskDb: {}, taskTemplateDb: {} }));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn(), getGCSPPrivateKey: jest.fn() }));
jest.mock('../mcp/client/toolRegistry', () => ({ ToolRegistry: jest.fn().mockImplementation(() => ({ register: jest.fn(), getTool: jest.fn(), getTools: jest.fn().mockReturnValue([]) })) }));
jest.mock('../mcp/client/mcpClientService', () => ({ McpClientService: jest.fn().mockImplementation(() => ({ initialize: jest.fn(), discoverToolsForUser: jest.fn(), getTools: jest.fn().mockReturnValue([]) })) }));
jest.mock('../services/skillService', () => ({ skillService: {} }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn(), resolveSkillsToToolNames: jest.fn(), filterFunctionCalls: jest.fn() }));
jest.mock('../services/metaService', () => ({ metaService: {}, MetaService: jest.fn() }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));
jest.mock('../services/clickupService', () => ({ getAccessToken: jest.fn(), getWorkspaces: jest.fn(), listDocs: jest.fn(), readDocContent: jest.fn() }));

describe('callLLM retry logic', () => {
  let AgentModeService: any;

  beforeAll(async () => {
    const mod = await import('../services/agentModeService');
    AgentModeService = mod.AgentModeService;
  });

  it('should retry on transient 503 error and succeed on third attempt', async () => {
    const service = new AgentModeService();
    // Mock sleep so tests don't wait for real delays
    service.sleep = jest.fn().mockResolvedValue(undefined);

    service.llmModels = {
      'test-model': {
        client: {
          chat: {
            completions: {
              create: jest.fn()
                .mockRejectedValueOnce(Object.assign(new Error('503 status code (no body)'), { status: 503 }))
                .mockRejectedValueOnce(Object.assign(new Error('503 status code (no body)'), { status: 503 }))
                .mockResolvedValueOnce({ choices: [{ message: { content: 'ok' } }] }),
            },
          },
        },
        supportsTemperature: true,
      },
    };

    const result = await service.callLLM('test-model', [{ role: 'user', content: 'hello' }]);
    expect(result.choices[0].message.content).toBe('ok');
    expect(service.llmModels['test-model'].client.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(service.sleep).toHaveBeenCalledTimes(2);
  });

  it('should NOT retry on non-transient 400 error', async () => {
    const service = new AgentModeService();
    service.sleep = jest.fn().mockResolvedValue(undefined);

    service.llmModels = {
      'test-model': {
        client: {
          chat: {
            completions: {
              create: jest.fn()
                .mockRejectedValueOnce(Object.assign(new Error('Bad Request'), { status: 400 })),
            },
          },
        },
        supportsTemperature: true,
      },
    };

    await expect(service.callLLM('test-model', [{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Bad Request');
    expect(service.llmModels['test-model'].client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(service.sleep).not.toHaveBeenCalled();
  });

  it('should throw after max retries exhausted', async () => {
    const service = new AgentModeService();
    service.sleep = jest.fn().mockResolvedValue(undefined);

    service.llmModels = {
      'test-model': {
        client: {
          chat: {
            completions: {
              create: jest.fn()
                .mockRejectedValue(Object.assign(new Error('503 status code (no body)'), { status: 503 })),
            },
          },
        },
        supportsTemperature: true,
      },
    };

    await expect(service.callLLM('test-model', [{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('503 status code');
    expect(service.llmModels['test-model'].client.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(service.sleep).toHaveBeenCalledTimes(2);
  });
});

// ─── 3. trimToolMessagesForContext() ─────────────────────────────────────────

describe('trimToolMessagesForContext', () => {
  let AgentModeService: any;

  beforeAll(async () => {
    const mod = await import('../services/agentModeService');
    AgentModeService = mod.AgentModeService;
  });

  it('should truncate old large tool result messages', () => {
    const service = new AgentModeService();
    const largeContent = 'x'.repeat(10000);
    const messages: any[] = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Search for articles' },
      // Old tool call — large content, should be truncated
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', function: { name: 'search_web' } }] },
      { role: 'tool', tool_call_id: 'tc1', name: 'search_web', content: largeContent },
      { role: 'assistant', content: 'Here are the results' },
      // 3 recent tool calls to push tc1 outside the preserve window
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc2', function: { name: 'read_file' } }] },
      { role: 'tool', tool_call_id: 'tc2', name: 'read_file', content: 'file content' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc3', function: { name: 'update_html' } }] },
      { role: 'tool', tool_call_id: 'tc3', name: 'update_html', content: 'updated' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc4', function: { name: 'publish' } }] },
      { role: 'tool', tool_call_id: 'tc4', name: 'publish', content: 'Published successfully' },
    ];

    const trimmed = service.trimToolMessagesForContext(messages);

    // Old large tool result (tc1 at index 3) should be summarized
    expect(trimmed[3].content.length).toBeLessThan(10000);
    expect(trimmed[3].content).toMatch(/^\[Tool: search_web/);

    // Recent tool results should be preserved
    expect(trimmed[6].content).toBe('file content');
    expect(trimmed[8].content).toBe('updated');
    expect(trimmed[10].content).toBe('Published successfully');
  });

  it('should preserve the most recent tool results at full size', () => {
    const service = new AgentModeService();
    const largeContent = 'y'.repeat(10000);
    // Create messages where the last 3 tool results are large — they should be preserved
    const messages: any[] = [
      { role: 'system', content: 'system' },
    ];

    // Add 5 tool call rounds — first 2 old, last 3 recent
    for (let i = 0; i < 5; i++) {
      messages.push(
        { role: 'assistant', content: null, tool_calls: [{ id: `tc${i}`, function: { name: `tool${i}` } }] },
        { role: 'tool', tool_call_id: `tc${i}`, name: `tool${i}`, content: largeContent },
      );
    }

    const trimmed = service.trimToolMessagesForContext(messages);

    // First 2 tool results should be summarized (old)
    expect(trimmed[2].content.length).toBeLessThan(10000); // tc0
    expect(trimmed[2].content).toMatch(/^\[Tool: tool0/);
    expect(trimmed[4].content.length).toBeLessThan(10000); // tc1
    expect(trimmed[4].content).toMatch(/^\[Tool: tool1/);

    // Last 3 tool results should be preserved
    expect(trimmed[6].content).toBe(largeContent); // tc2
    expect(trimmed[8].content).toBe(largeContent); // tc3
    expect(trimmed[10].content).toBe(largeContent); // tc4
  });

  it('should not mutate the original messages array', () => {
    const service = new AgentModeService();
    const largeContent = 'z'.repeat(10000);
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', function: { name: 'search' } }] },
      { role: 'tool', tool_call_id: 'tc1', name: 'search', content: largeContent },
      // Add recent messages so tc1 is "old"
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc2', function: { name: 't2' } }] },
      { role: 'tool', tool_call_id: 'tc2', name: 't2', content: 'small' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc3', function: { name: 't3' } }] },
      { role: 'tool', tool_call_id: 'tc3', name: 't3', content: 'small' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc4', function: { name: 't4' } }] },
      { role: 'tool', tool_call_id: 'tc4', name: 't4', content: 'small' },
    ];

    service.trimToolMessagesForContext(messages);

    // Original should be unchanged
    expect(messages[2].content).toBe(largeContent);
  });

  it('should leave non-tool messages untouched', () => {
    const service = new AgentModeService();
    const longUserMsg = 'u'.repeat(20000);
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: longUserMsg },
      { role: 'assistant', content: 'response' },
    ];

    const trimmed = service.trimToolMessagesForContext(messages);

    expect(trimmed[0].content).toBe('system prompt');
    expect(trimmed[1].content).toBe(longUserMsg);
    expect(trimmed[2].content).toBe('response');
  });

  it('should trim large content_draft in old create_blog_article assistant messages', () => {
    const service = new AgentModeService();
    const largeDraft = 'x'.repeat(5000);
    const messages: any[] = [
      { role: 'system', content: 'system' },
      // Old assistant message with large content_draft
      {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'tc1',
          function: {
            name: 'create_blog_article',
            arguments: JSON.stringify({ title_draft: 'My Blog', content_draft: largeDraft })
          }
        }]
      },
      { role: 'tool', tool_call_id: 'tc1', name: 'create_blog_article', content: JSON.stringify({ success: true, htmlUrl: 'https://s3/blog.html' }) },
      // 3 more recent tool calls to push tc1 outside the preserve window
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc2', function: { name: 'search_web', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc2', name: 'search_web', content: 'results' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc3', function: { name: 'search_web', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc3', name: 'search_web', content: 'results2' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc4', function: { name: 'search_web', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc4', name: 'search_web', content: 'results3' },
    ];

    const trimmed = service.trimToolMessagesForContext(messages);

    // The old assistant message's content_draft should be truncated
    const oldAssistantMsg = trimmed[1];
    expect(oldAssistantMsg.role).toBe('assistant');
    const args = JSON.parse(oldAssistantMsg.tool_calls[0].function.arguments);
    expect(args.content_draft.length).toBeLessThan(5000);
    expect(args.content_draft).toContain('[…trimmed]');
    // title_draft should be unchanged (not in trim list)
    expect(args.title_draft).toBe('My Blog');
  });

  it('should not trim create_blog_article args in recent assistant messages', () => {
    const service = new AgentModeService();
    const largeDraft = 'x'.repeat(5000);
    const messages: any[] = [
      { role: 'system', content: 'system' },
      {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'tc1',
          function: {
            name: 'create_blog_article',
            arguments: JSON.stringify({ title_draft: 'My Blog', content_draft: largeDraft })
          }
        }]
      },
      // Only 1 tool result — stays in the recent preserve window
      { role: 'tool', tool_call_id: 'tc1', name: 'create_blog_article', content: JSON.stringify({ success: true }) },
    ];

    const trimmed = service.trimToolMessagesForContext(messages);

    // Only 1 tool result total, so recentToPreserve (3) covers it — no trimming
    const assistantMsg = trimmed[1];
    const args = JSON.parse(assistantMsg.tool_calls[0].function.arguments);
    expect(args.content_draft).toBe(largeDraft);
  });
});

// ─── 4. Worker uncaught error requestId ──────────────────────────────────────

describe('Worker uncaught error requestId', () => {
  it('should include requestId in uncaught exception handler', async () => {
    // We test the worker by reading its source and verifying it tracks requestId
    // Since the worker runs as a child process, we test the module-level variable pattern
    const fs = await import('fs');
    const workerSource = fs.readFileSync(
      require.resolve('../workers/generateMarketingResponseWorker'),
      'utf-8'
    );

    // The worker should have a module-level variable to track current requestId
    expect(workerSource).toMatch(/let\s+currentRequestId/);

    // The uncaughtException handler should reference requestId
    expect(workerSource).toMatch(/uncaughtException[\s\S]*?requestId.*currentRequestId/);

    // The unhandledRejection handler should reference requestId
    expect(workerSource).toMatch(/unhandledRejection[\s\S]*?requestId.*currentRequestId/);

    // The message handler should set currentRequestId when processing starts
    expect(workerSource).toMatch(/currentRequestId\s*=\s*requestId/);
  });

  it('should wire installWorkerSignalGuards() at module load (ENG-202)', async () => {
    // The signal guards (ignore process-group SIGTERM/SIGINT) must be installed
    // when the worker module loads, not merely imported — accidental removal of
    // the call would silently reintroduce the mid-run crash on instance teardown.
    const fs = await import('fs');
    const workerSource = fs.readFileSync(
      require.resolve('../workers/generateMarketingResponseWorker'),
      'utf-8'
    );

    // The guards helper must be imported...
    expect(workerSource).toMatch(/installWorkerSignalGuards/);
    // ...and actually invoked at module load (not just referenced in a comment).
    expect(workerSource).toMatch(/installWorkerSignalGuards\(\)/);
  });
});
