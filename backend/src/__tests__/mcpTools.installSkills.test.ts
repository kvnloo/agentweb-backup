import { mcpToolRegistry } from '../mcp/server/registry';

// Setup: Import apiTools to populate the registry
import '../mcp/server/apiTools';

// Mock dependencies
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');
jest.mock('../services/chatbotService');

describe('MCP Tool - install_skills / list_available_skills (removed)', () => {
  it('should NOT be registered — internal-only, not exposed to external MCP clients', () => {
    expect(mcpToolRegistry.getTool('install_skills')).toBeUndefined();
    expect(mcpToolRegistry.getTool('list_available_skills')).toBeUndefined();
  });
});
