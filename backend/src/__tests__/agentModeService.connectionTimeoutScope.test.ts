jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

import { AgentModeService } from '../services/agentModeService';

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  getS3ObjectAsString: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
}));

/**
 * ENG-1844 review: formatToolError's "External Service Unavailable" branch used to match
 * on the bare substrings 'Connection timeout' / 'service temporarily unavailable' with no
 * tool-name or errorClass gate — loose enough that ANY future tool error whose message
 * happened to contain either fragment would get "the external service is temporarily
 * unreachable... inform the user the service is currently unavailable" framing, regardless
 * of the real cause. That is the exact wrong-outage-framing bug class ENG-1844 fixes
 * elsewhere, at an ungated trigger site with zero prior test coverage.
 *
 * Both real origins (mcpClientService.ts, MCP-server connection failures) always emit the
 * FULL phrase "Connection timeout for {name}" (optionally with the circuit-breaker suffix
 * "(service temporarily unavailable — retrying in Ns)"). Tightened to match those complete,
 * hard-to-accidentally-reproduce phrases instead of the bare fragments.
 */
describe('formatToolError — External Service Unavailable branch scope (ENG-1844 review)', () => {
  let svc: AgentModeService;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    svc = new AgentModeService();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const format = (tool: string, message: string): string => (svc as any).formatToolError(tool, message);

  it('still fires for a real MCP connection timeout ("Connection timeout for X")', () => {
    const out = format('some_mcp_tool', 'Connection timeout for my-external-server');
    expect(out).toContain('⚠️ External Service Unavailable');
    expect(out).toMatch(/temporarily unreachable/i);
  });

  it('still fires for a real circuit-breaker-open message', () => {
    const out = format(
      'some_mcp_tool',
      'Connection timeout for my-external-server (service temporarily unavailable — retrying in 30s)'
    );
    expect(out).toContain('⚠️ External Service Unavailable');
  });

  // FAIL cases: an unrelated tool error that merely CONTAINS the bare fragment must not
  // be swept into "external service unreachable" framing.
  it('does not fire for an unrelated message that only contains the bare fragment "Connection timeout"', () => {
    const out = format('some_admin_tool', 'Admin connection test failed: Connection timeout');
    expect(out).not.toContain('⚠️ External Service Unavailable');
  });

  it('does not fire for an unrelated message that only contains the bare fragment "service temporarily unavailable"', () => {
    const out = format('generate_landing_page', 'API error (503): billing service temporarily unavailable, contact support');
    expect(out).not.toContain('⚠️ External Service Unavailable');
  });
});
