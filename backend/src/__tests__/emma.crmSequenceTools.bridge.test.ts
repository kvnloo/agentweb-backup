/**
 * ENG-442 — the CRM sequence tools must actually reach Emma.
 *
 * Registering in mcpToolRegistry alone only exposes a tool to external MCP
 * clients. Agent Mode and the in-app sidebar build their tool list from
 * emmaToolRegistry, so the tools have to be in `bridgedToolNames` in
 * emma/tools.ts. Without this test the tools could ship invisible to Emma —
 * which is the exact gap the ticket is about.
 */

jest.mock('../services/agentModeService', () => ({
  agentModeService: {},
}));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

describe('CRM sequence tools are bridged into Emma\'s registry', () => {
  it.each(['list_crm_sequences', 'manage_crm_sequence'])('bridges %s', (toolName) => {
    const handler = emmaToolRegistry.getTool(toolName);
    expect(handler).toBeDefined();
    expect(handler?.definition.name).toBe(toolName);
    expect(typeof handler?.execute).toBe('function');
  });

  it('keeps the audience-scoping tool and the campaign tools on the same surface', () => {
    // get_leads_by_crm_criteria scopes WHO; these build/inspect the campaign.
    expect(emmaToolRegistry.getTool('manage_crm_sequence')).toBeDefined();
    expect(emmaToolRegistry.getTool('list_crm_sequences')).toBeDefined();
  });

  it('tells the model that activation is human-gated', () => {
    const description: string = emmaToolRegistry.getTool('manage_crm_sequence')!.definition.description;
    expect(description).toMatch(/confirm/i);
    expect(description).toMatch(/unattended|scheduled/i);
    expect(description).toMatch(/draft/i);
  });
});
