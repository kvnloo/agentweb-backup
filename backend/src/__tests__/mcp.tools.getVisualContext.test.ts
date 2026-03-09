/**
 * Tests for the get_visual_context MCP tool
 */

// Minimal mocks to allow mcp/server/tools.ts to load without real AWS/OpenAI deps
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));
jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/db', () => ({ taskDb: {} }));

describe('get_visual_context MCP tool', () => {
  let registry: any;

  beforeAll(async () => {
    const mod = await import('../mcp/server/registry');
    registry = mod.mcpToolRegistry;
    // Load tools (registers all tools including get_visual_context)
    await import('../mcp/server/tools');
  });

  it('is registered in the tool registry', () => {
    const tool = registry.getTool('get_visual_context');
    expect(tool).toBeDefined();
  });

  it('has correct name and description', () => {
    const tool = registry.getTool('get_visual_context');
    expect(tool.definition.name).toBe('get_visual_context');
    expect(tool.definition.description).toContain('screenshot');
  });

  it('returns needs_screenshot: true when executed', async () => {
    const tool = registry.getTool('get_visual_context');
    const result = await tool.execute({ reason: 'Check page colors' });

    expect(result.needs_screenshot).toBe(true);
  });

  it('includes the provided reason in the result', async () => {
    const tool = registry.getTool('get_visual_context');
    const result = await tool.execute({ reason: 'Verify button placement' });

    expect(result.reason).toBe('Verify button placement');
  });

  it('uses default reason when no args provided', async () => {
    const tool = registry.getTool('get_visual_context');
    const result = await tool.execute({});

    expect(result.reason).toBe('Visual context requested');
    expect(result.needs_screenshot).toBe(true);
  });

  it('inputSchema allows empty required array (reason is optional)', () => {
    const tool = registry.getTool('get_visual_context');
    const required = tool.definition.inputSchema.required;
    expect(Array.isArray(required)).toBe(true);
    expect(required).toHaveLength(0);
  });
});
