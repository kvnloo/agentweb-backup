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

  it('remains a no-arg self tool (no email/client param leaks in)', () => {
    const def = emmaToolRegistry.getTool('get_account_status')!.definition as any;
    const props = def.inputSchema?.properties ?? {};
    expect(Object.keys(props)).toHaveLength(0);
    expect(def.inputSchema?.required ?? []).toHaveLength(0);
  });

  it('is still registered on the external mcpToolRegistry (no regression)', () => {
    expect(mcpToolRegistry.getTool('get_account_status')).toBeDefined();
  });
});
