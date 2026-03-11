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

// get_visual_context is registered in BOTH registries:
//   - emmaToolRegistry: used by Emma chatbot (customer portal)
//   - mcpToolRegistry:  used by MCP protocol clients
// Both registrations are intentional — verify each independently.

describe('get_visual_context — emmaToolRegistry', () => {
  let registry: any;

  beforeAll(async () => {
    const mod = await import('../emma/registry');
    registry = mod.emmaToolRegistry;
    // Load tools (registers all tools including get_visual_context)
    await import('../emma/tools');
  });

  it('is registered in emmaToolRegistry', () => {
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

describe('get_visual_context — mcpToolRegistry', () => {
  let mcpRegistry: any;

  beforeAll(async () => {
    // emma/tools.ts registers get_visual_context into the mcpToolRegistry singleton
    // exported from mcp/server/registry.ts. Import that singleton after loading tools.
    await import('../emma/tools'); // ensure tools module has run and registered
    const mod = await import('../mcp/server/registry');
    mcpRegistry = mod.mcpToolRegistry;
  });

  it('is registered in mcpToolRegistry', () => {
    const tool = mcpRegistry.getTool('get_visual_context');
    expect(tool).toBeDefined();
  });

  it('returns needs_screenshot: true from mcpToolRegistry', async () => {
    const tool = mcpRegistry.getTool('get_visual_context');
    const result = await tool.execute({ reason: 'Layout check' });
    expect(result.needs_screenshot).toBe(true);
  });
});
