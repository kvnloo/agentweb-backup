/**
 * ENG-1553 — regression coverage for check_account_tracking_health's tool registration.
 *
 * Applies the exact lesson from ENG-1552's real bug: a tool registered in mcpToolRegistry and
 * ADMIN_SKILL_TOOL_NAMES but missing from emma/tools.ts's adminToolNames bridge produces a
 * silent "Unknown tool" failure only visible in a real chat run. Verified all three points here
 * before ever live-testing.
 */

import { emmaToolRegistry } from '../emma/registry';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../emma/tools'; // side-effecting import: runs the bridge loop

describe('check_account_tracking_health is reachable from Emma chat, not just the MCP registry', () => {
  it('is registered in mcpToolRegistry', () => {
    expect(mcpToolRegistry.getTool('check_account_tracking_health')).toBeDefined();
  });

  it('is bridged into emmaToolRegistry', () => {
    const handler = emmaToolRegistry.getTool('check_account_tracking_health');
    expect(handler).toBeDefined();
    expect(handler?.name).toBe('check_account_tracking_health');
  });

  it('the bridged handler is the SAME execute function as the MCP-registered one, not a stub', () => {
    const mcpHandler = mcpToolRegistry.getTool('check_account_tracking_health');
    const emmaHandler = emmaToolRegistry.getTool('check_account_tracking_health');
    expect(emmaHandler?.execute).toBe(mcpHandler?.execute);
  });
});
