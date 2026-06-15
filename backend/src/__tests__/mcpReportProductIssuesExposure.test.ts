/**
 * Regression guard for the #1851 miss (2026-06-13): report_product_issues was
 * enriched on emmaToolRegistry (in-app Emma) but never registered on
 * mcpToolRegistry — the registry the EXTERNAL claude.ai connector
 * (api.agentweb.pro/mcp) actually serves. So MCP-native bug reporting from
 * Claude Code was unreachable. This test asserts the tool is exposed on the
 * EXTERNAL surface with the enriched schema.
 */

import '../emma/tools'; // triggers registration + the external bridge
import { mcpToolRegistry } from '../mcp/server/registry';

describe('report_product_issues external MCP exposure', () => {
  it('is registered on the external mcpToolRegistry', () => {
    const tool = mcpToolRegistry.getTool('report_product_issues');
    expect(tool).toBeDefined();
  });

  it('appears in the externally-visible tool definitions (not internal-only)', () => {
    const names = mcpToolRegistry.getToolDefinitions().map((d: any) => d.name);
    expect(names).toContain('report_product_issues');
  });

  it('carries the enriched schema (attachment_urls + run_id) on the external surface', () => {
    const def = mcpToolRegistry.getTool('report_product_issues')!.definition as any;
    const issueProps = def.inputSchema.properties.issues.items.properties;
    expect(issueProps.attachment_urls).toBeDefined();
    expect(issueProps.run_id).toBeDefined();
  });
});
