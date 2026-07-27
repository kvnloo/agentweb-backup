import '../emma/tools';
import { mcpToolRegistry } from '../mcp/server/registry';
import { agentModeService } from '../services/agentModeService';

describe('manage_linear_governance_label exposure', () => {
  it('is exposed through the external MCP registry', () => {
    expect(mcpToolRegistry.getTool('manage_linear_governance_label')).toBeDefined();
    expect(mcpToolRegistry.getToolDefinitions().map(definition => definition.name))
      .toContain('manage_linear_governance_label');
  });

  it('is classified as an admin-only Emma tool', () => {
    expect(agentModeService.getAdminToolNames()).toContain('manage_linear_governance_label');
  });

  it('does not expose create, delete, workspace, team, or credentials arguments', () => {
    const schema = mcpToolRegistry.getTool('manage_linear_governance_label')!
      .definition.inputSchema as any;
    expect(schema.required).toEqual(['label_name', 'reason']);
    expect(Object.keys(schema.properties)).toEqual([
      'label_name',
      'name',
      'description',
      'color',
      'reason',
      'dry_run',
    ]);
  });
});
