/**
 * ENG-2327 — the `enable_session_tracking` Emma tool is bridged from the MCP registry (like the
 * neighbouring landing-page tools), classified for the evaluation sandbox, and only ever reaches the
 * session-tracking route through the authenticated self-call.
 */
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));
jest.mock('../services/agentModeService', () => ({ agentModeService: new Proxy({}, { get: () => () => undefined }) }));

import { emmaToolRegistry } from '../emma/registry';
import { mcpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';
import { classifySandboxTool } from '../services/evaluationPolicy';
import '../emma/tools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

describe('enable_session_tracking in the Emma registry', () => {
  it('is registered with the same definition as its MCP twin', () => {
    const emma = emmaToolRegistry.getTool('enable_session_tracking');
    const mcp = mcpToolRegistry.getTool('enable_session_tracking');
    expect(emma).toBeDefined();
    expect(mcp).toBeDefined();
    expect(emma!.definition).toEqual(mcp!.definition);
    expect(emma!.definition.inputSchema).toMatchObject({ type: 'object', required: ['page_id'] });
  });

  it('dispatches through the REST self-call (so the route\'s edit authorization applies)', async () => {
    mockMcpFetch.mockResolvedValue({ success: true, listId: 'list_1' });
    await emmaToolRegistry.getTool('enable_session_tracking')!.execute({ page_id: 'p1' }, { userId: 'u1' });
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: '/api/landing-pages/v0/generated/p1/session-tracking',
    }));
  });

  it('is denied in the evaluation sandbox (it commits to a repo), class "publish"', () => {
    expect(classifySandboxTool('enable_session_tracking')).toBe('publish');
  });
});
