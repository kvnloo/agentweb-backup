/**
 * ENG-1552 follow-up — regression test for a real bug found live-testing on prod.
 *
 * `monitor_lead_volume` (ENG-1551) was registered in `mcpToolRegistry` (apiTools.ts) and in
 * `ADMIN_SKILL_TOOL_NAMES` (agentModeService.ts — controls session-level access grant) but was
 * missing from `adminToolNames` (emma/tools.ts) — the list that actually bridges MCP-registered
 * admin tools into Emma's in-app chat tool loop. The result: the route worked (verified directly
 * via curl), the tool was "grantable," but a real Emma chat session calling it got
 * `Unknown tool: monitor_lead_volume` — caught only by running an actual scheduled-chat test on
 * prod, not by any of the unit tests for the pieces individually.
 *
 * This asserts the bridge specifically resolves `monitor_lead_volume` — not a blanket
 * "every admin tool list must be identical" check, since `ADMIN_SKILL_TOOL_NAMES` and
 * `adminToolNames` already have a small pre-existing, presumably deliberate asymmetry
 * (`inspect_orphaned_org_join_requests` / `list_predefined_work_plans`) this test isn't
 * confident enough to assert away.
 */

import { emmaToolRegistry } from '../emma/registry';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../emma/tools'; // side-effecting import: runs the bridge loop that registers admin tools

describe('monitor_lead_volume is reachable from Emma chat, not just the MCP registry', () => {
  it('is registered in mcpToolRegistry (the source the bridge reads from)', () => {
    expect(mcpToolRegistry.getTool('monitor_lead_volume')).toBeDefined();
  });

  it('is bridged into emmaToolRegistry — the actual gap this regression guards', () => {
    const handler = emmaToolRegistry.getTool('monitor_lead_volume');
    expect(handler).toBeDefined();
    expect(handler?.name).toBe('monitor_lead_volume');
  });

  it('the bridged handler is the SAME execute function as the MCP-registered one, not a stub', () => {
    const mcpHandler = mcpToolRegistry.getTool('monitor_lead_volume');
    const emmaHandler = emmaToolRegistry.getTool('monitor_lead_volume');
    expect(emmaHandler?.execute).toBe(mcpHandler?.execute);
  });
});
