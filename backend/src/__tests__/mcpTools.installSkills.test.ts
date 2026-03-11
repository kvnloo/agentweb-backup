import { mcpToolRegistry } from '../mcp/server/registry';

// Setup: Import apiTools to populate the registry
import '../mcp/server/apiTools';

// Mock dependencies
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');
jest.mock('../services/chatbotService');

describe('MCP Tool - install_skills / list_available_skills (internal)', () => {
  it('should be registered but hidden from external MCP clients', () => {
    // Registered in the registry (available to Emma internally)
    expect(mcpToolRegistry.getTool('install_skills')).toBeDefined();
    expect(mcpToolRegistry.getTool('list_available_skills')).toBeDefined();

    // But NOT exposed to external MCP clients
    const externalNames = mcpToolRegistry.getToolDefinitions().map((d: any) => d.name);
    expect(externalNames).not.toContain('install_skills');
    expect(externalNames).not.toContain('list_available_skills');
  });
});
