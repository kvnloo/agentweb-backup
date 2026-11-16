/**
 * Regression guard for the get_account_status in-app exposure miss (2026-06-14),
 * the same class of bug as #1851 (report_product_issues). get_account_status was
 * registered ONLY on the external mcpToolRegistry (mcp/server/apiTools.ts) and
 * never bridged to the in-app emmaToolRegistry nor added to the foundation tool
 * set. So the IN-APP Emma agent loop was never offered a self-status tool and
 * fell back to assess_client_health (an admin lookup that REQUIRES an email) —
 * the user-reported "Emma asked me for my email instead of reporting my own
 * account" bug.
 *
 * The tool's handler is correct (no-arg, self-resolving via /api/auth/me). The
 * defect was purely exposure/registration. This test pins both halves of the fix:
 *  (1) the bridge registers the handler onto emmaToolRegistry, and
 *  (2) it is in DEFAULT_FOUNDATION_TOOLS so the loop actually offers it.
 */

// ENG-1596: mocked so the new client_id-stripping tests below can inspect what
// the bridged tools' execute actually forwards, without making a real HTTP
// self-call. Every other test in this file only checks registration/schema,
// never execution, so this has no effect on them.
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn().mockResolvedValue({}),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

import '../emma/tools'; // triggers registration + the in-app bridge loop
import { emmaToolRegistry } from '../emma/registry';
import { mcpToolRegistry } from '../mcp/server/registry';
import { AgentModeService } from '../services/agentModeService';

describe('get_account_status in-app (AgentMode) exposure', () => {
  it('is bridged onto the in-app emmaToolRegistry (handler resolvable)', () => {
    const tool = emmaToolRegistry.getTool('get_account_status');
    expect(tool).toBeDefined();
  });

  it('is offered to every in-app session via DEFAULT_FOUNDATION_TOOLS', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('get_account_status');
  });

  it('remains a self tool (no email/client param leaks in; only the ENG-758 usage_month filter)', () => {
    const def = emmaToolRegistry.getTool('get_account_status')!.definition as any;
    const props = def.inputSchema?.properties ?? {};
    expect(Object.keys(props)).toEqual(['usage_month']);
    expect(def.inputSchema?.required ?? []).toHaveLength(0);
  });

  it('is still registered on the external mcpToolRegistry (no regression)', () => {
    expect(mcpToolRegistry.getTool('get_account_status')).toBeDefined();
  });

  // ENG-1596 (CodeRabbit, PR #2651): the schema hides client_id from the model,
  // but the bridge's execute must also refuse to honor one that slips through
  // anyway — for BOTH admin and non-admin in-app callers. Otherwise an admin's
  // own in-app chat could silently gain client scoping this bridge is supposed
  // to keep self-only.
  describe('client_id is stripped at the in-app bridge boundary (ENG-1596)', () => {
    const mcpFetchMock = jest.requireMock('../mcp/server/httpClient').mcpFetch as jest.Mock;

    beforeEach(() => {
      mcpFetchMock.mockClear();
      mcpFetchMock.mockResolvedValue({ email: 'caller@example.com' });
    });

    it('never forwards client_id for a non-admin in-app caller', async () => {
      const tool = emmaToolRegistry.getTool('get_account_status')!;
      await tool.execute({ client_id: 'someone-else@example.com' }, { userId: 'customer-1' });

      const call = mcpFetchMock.mock.calls[0][0];
      expect(call.context.overrideToken).toBeUndefined();
      expect(call.context.userId).toBe('customer-1');
    });

    it('never forwards client_id for an in-app caller who happens to be a real admin', async () => {
      const tool = emmaToolRegistry.getTool('get_account_status')!;
      await tool.execute({ client_id: 'someone-else@example.com' }, { userId: 'admin-1' });

      // No DB lookup at all — client_id was stripped before resolveClientScopedContext
      // ever saw it, so it never even reached the admin-check branch.
      const call = mcpFetchMock.mock.calls[0][0];
      expect(call.context.overrideToken).toBeUndefined();
      expect(call.context.userId).toBe('admin-1');
    });

    it('same protection applies to the list_scheduled_chats bridge', async () => {
      const tool = emmaToolRegistry.getTool('list_scheduled_chats')!;
      mcpFetchMock.mockResolvedValue([]);
      await tool.execute({ client_id: 'someone-else@example.com' }, { userId: 'admin-1' });

      const call = mcpFetchMock.mock.calls[0][0];
      expect(call.context.overrideToken).toBeUndefined();
      expect(call.context.userId).toBe('admin-1');
    });
  });
});
