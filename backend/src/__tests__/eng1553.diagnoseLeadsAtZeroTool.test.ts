/**
 * ENG-1553 — regression coverage for diagnose_leads_at_zero's tool registration.
 * Same pattern as eng1552/eng1553's other bridge tests.
 */

import { emmaToolRegistry } from '../emma/registry';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../emma/tools';

describe('diagnose_leads_at_zero is reachable from Emma chat, not just the MCP registry', () => {
  it('is registered in mcpToolRegistry', () => {
    expect(mcpToolRegistry.getTool('diagnose_leads_at_zero')).toBeDefined();
  });

  it('is bridged into emmaToolRegistry', () => {
    const handler = emmaToolRegistry.getTool('diagnose_leads_at_zero');
    expect(handler).toBeDefined();
    expect(handler?.name).toBe('diagnose_leads_at_zero');
  });

  it('the bridged handler is the SAME execute function as the MCP-registered one, not a stub', () => {
    const mcpHandler = mcpToolRegistry.getTool('diagnose_leads_at_zero');
    const emmaHandler = emmaToolRegistry.getTool('diagnose_leads_at_zero');
    expect(emmaHandler?.execute).toBe(mcpHandler?.execute);
  });
});
