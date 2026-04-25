/**
 * Tests for browser tool retry logic in McpClientService.
 * Verifies that playwright_* / browser_* tools are retried up to BROWSER_TOOL_MAX_RETRIES
 * times on transient errors, while non-browser tools fail fast.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockCallTool = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockListTools = jest.fn().mockResolvedValue({
  tools: [
    {
      name: 'browser_navigate',
      description: 'Navigate to URL',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } }
    },
    {
      name: 'some_other_tool',
      description: 'Non-browser tool',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
});

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null,
  })),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

jest.mock('../utils/crypto', () => ({
  decryptPassword: jest.fn().mockImplementation((val) => ({ password: val, userId: 'test' })),
}));

jest.mock('../mcp/client/mcp_config', () => ({
  internalMcpServers: {},
}));

jest.mock('axios', () => {
  const m = jest.fn();
  (m as any).isAxiosError = jest.fn().mockReturnValue(false);
  return m;
});

import { McpClientService } from '../mcp/client/mcpClientService';
import { internalMcpServers } from '../mcp/client/mcp_config';

const CONTEXT = { userId: 'user1', sessionId: 'sess1', llmModel: 'gpt-4' };

async function buildServiceWithTools(): Promise<McpClientService> {
  (internalMcpServers as any)['playwright-server'] = {
    transport: 'sse',
    url: 'http://localhost:3100/sse',
    isInternal: false,
  };
  const svc = new McpClientService();
  await svc.initialize();
  return svc;
}

function getBrowserTool(svc: McpClientService) {
  // Config-file servers have no prefix applied
  return (svc as any).mcpTools.find((t: any) => t.definition.function.name === 'browser_navigate');
}

function getNonBrowserTool(svc: McpClientService) {
  return (svc as any).mcpTools.find((t: any) => t.definition.function.name === 'some_other_tool');
}

describe('McpClientService - browser tool retry logic', () => {
  let service: McpClientService;
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const key of Object.keys(internalMcpServers)) delete (internalMcpServers as any)[key];

    // Make sleep() resolve immediately so tests don't take 2s per retry
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
      fn();
      return 0 as any;
    });

    service = await buildServiceWithTools();
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('succeeds on first attempt without retrying', async () => {
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });
    const tool = getBrowserTool(service);
    const result = await tool.execute({ url: 'https://example.com' }, CONTEXT);
    expect(result.content).toBe('ok');
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('retries browser tool on connection error and succeeds on second attempt', async () => {
    mockCallTool
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue({ content: [{ type: 'text', text: 'recovered' }], isError: false });

    const tool = getBrowserTool(service);
    const result = await tool.execute({ url: 'https://example.com' }, CONTEXT);
    expect(result.content).toBe('recovered');
    expect(mockCallTool).toHaveBeenCalledTimes(2);
  });

  it('retries browser tool on result.isError and succeeds on second attempt', async () => {
    mockCallTool
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Tool error: page crashed' }], isError: true })
      .mockResolvedValue({ content: [{ type: 'text', text: 'success' }], isError: false });

    const tool = getBrowserTool(service);
    const result = await tool.execute({ url: 'https://example.com' }, CONTEXT);
    expect(result.content).toBe('success');
    expect(mockCallTool).toHaveBeenCalledTimes(2);
  });

  it('exhausts all retries and throws after 3 total attempts (BROWSER_TOOL_MAX_RETRIES=2)', async () => {
    mockCallTool.mockRejectedValue(new Error('econnreset'));

    const tool = getBrowserTool(service);
    await expect(tool.execute({ url: 'https://example.com' }, CONTEXT)).rejects.toThrow('econnreset');
    // 1 initial + 2 retries = 3 total
    expect(mockCallTool).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry non-browser tools — fails immediately on first error', async () => {
    mockCallTool.mockRejectedValue(new Error('socket hang up'));

    const tool = getNonBrowserTool(service);
    await expect(tool.execute({}, CONTEXT)).rejects.toThrow('socket hang up');
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('succeeds on third attempt (last allowed retry)', async () => {
    mockCallTool
      .mockRejectedValueOnce(new Error('etimedout'))
      .mockRejectedValueOnce(new Error('etimedout'))
      .mockResolvedValue({ content: [{ type: 'text', text: 'finally' }], isError: false });

    const tool = getBrowserTool(service);
    const result = await tool.execute({ url: 'https://example.com' }, CONTEXT);
    expect(result.content).toBe('finally');
    expect(mockCallTool).toHaveBeenCalledTimes(3);
  });
});
