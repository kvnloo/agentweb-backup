/**
 * ENG-1118: say which page a DOM read came from.
 *
 * The reporter's real damage was an evaluate() that "silently returns the wrong site's
 * DOM ... easily mistaken for 'no results found'". Per-session isolation removes the
 * hijack that caused it, but evaluate() results still carry no page context at all —
 * Playwright MCP reports the URL for navigate and run_code, not for evaluate — so a page
 * that moved for any other reason (a redirect chain, a JS navigation) is still read blind.
 *
 * The cover is provenance, not a gate: attach the URL the DOM was read from. It cannot
 * false-fail on the legitimate redirects this workload depends on, and a best-effort
 * lookup that fails leaves the result exactly as it was.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockCallTool = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockListTools = jest.fn().mockResolvedValue({
  tools: [
    { name: 'browser_evaluate', description: 'Evaluate JS', inputSchema: { type: 'object', properties: {} } },
    { name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
    { name: 'some_other_tool', description: 'Non-browser', inputSchema: { type: 'object', properties: {} } },
  ],
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
  SSEClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));
jest.mock('../utils/crypto', () => ({
  decryptPassword: jest.fn().mockImplementation((val) => ({ password: val, userId: 'test' })),
}));
jest.mock('../mcp/client/mcp_config', () => ({ internalMcpServers: {} }));
jest.mock('axios', () => {
  const m = jest.fn();
  (m as any).isAxiosError = jest.fn().mockReturnValue(false);
  return m;
});

import { McpClientService } from '../mcp/client/mcpClientService';
import { internalMcpServers } from '../mcp/client/mcp_config';

const CONTEXT = { userId: 'user1', sessionId: 'sess1', llmModel: 'gpt-4' };

function text(value: string) {
  return { content: [{ type: 'text', text: value }], isError: false };
}

async function buildService(): Promise<McpClientService> {
  (internalMcpServers as any)['playwright-server'] = {
    transport: 'sse',
    url: 'http://localhost:3100/sse',
    isInternal: false,
  };
  const svc = new McpClientService();
  await svc.initialize();
  return svc;
}

function tool(svc: McpClientService, name: string) {
  return (svc as any).mcpTools.find((t: any) => t.definition.function.name === name);
}

describe('Browser DOM-read provenance (ENG-1118)', () => {
  let service: McpClientService;

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const key of Object.keys(internalMcpServers)) delete (internalMcpServers as any)[key];
    service = await buildService();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  it('appends the page a DOM read came from', async () => {
    mockCallTool
      .mockResolvedValueOnce(text('### Result\n"[]"'))
      .mockResolvedValueOnce(text('"https://www.gao.gov/reports-testimonies"'));

    const result = await tool(service, 'browser_evaluate').execute({ function: '() => []' }, CONTEXT);

    expect(result.content).toContain('### Result');
    expect(result.content).toContain('Page URL: https://www.gao.gov/reports-testimonies');
  });

  it('reads the URL from the same client that produced the DOM', async () => {
    mockCallTool
      .mockResolvedValueOnce(text('### Result\n"[]"'))
      .mockResolvedValueOnce(text('"https://example.com/"'));

    await tool(service, 'browser_evaluate').execute({ function: '() => []' }, CONTEXT);

    expect(mockCallTool).toHaveBeenCalledTimes(2);
    expect(mockCallTool.mock.calls[1][0]).toEqual(
      expect.objectContaining({ name: 'browser_evaluate' })
    );
  });

  it('leaves the result untouched when the page cannot be read', async () => {
    mockCallTool
      .mockResolvedValueOnce(text('### Result\n"[]"'))
      .mockRejectedValueOnce(new Error('target closed'));

    const result = await tool(service, 'browser_evaluate').execute({ function: '() => []' }, CONTEXT);

    expect(result.content).toBe('### Result\n"[]"');
  });

  it('does not annotate tools that already report their page', async () => {
    mockCallTool.mockResolvedValue(text('### Page\n- Page URL: https://example.com/'));

    await tool(service, 'browser_navigate').execute({ url: 'https://example.com' }, CONTEXT);

    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('does not annotate non-browser tools', async () => {
    mockCallTool.mockResolvedValue(text('{"ok":true}'));

    await tool(service, 'some_other_tool').execute({}, CONTEXT);

    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('does not double-annotate a result that already names its page', async () => {
    mockCallTool.mockResolvedValue(text('### Result\n"[]"\n### Page\n- Page URL: https://example.com/'));

    const result = await tool(service, 'browser_evaluate').execute({ function: '() => []' }, CONTEXT);

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(result.content.match(/Page URL:/g)).toHaveLength(1);
  });
});
