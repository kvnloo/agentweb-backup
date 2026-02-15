import { mcpToolRegistry } from '../mcp/server/registry';
import { agentModeService } from '../services/agentModeService';

// Setup: Import the tools registration to ensure install_skills is registered
import '../mcp/server/tools';

// Mock agentModeService
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn(),
  },
}));

// Mock other dependencies
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');
jest.mock('../services/chatbotService');
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));

describe('MCP Tool - install_skills', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be registered in mcpToolRegistry', () => {
    const tool = mcpToolRegistry.getTool('install_skills');
    expect(tool).toBeDefined();
  });

  it('should have correct tool definition structure', () => {
    const tool = mcpToolRegistry.getTool('install_skills');
    
    expect(tool?.definition).toBeDefined();
    expect(tool?.definition.name).toBe('install_skills');
    expect(tool?.definition.description).toContain('Install');
    expect(tool?.definition.inputSchema).toBeDefined();
  });

  it('should require skillIds parameter', () => {
    const tool = mcpToolRegistry.getTool('install_skills');
    const schema = tool?.definition.inputSchema;

    expect(schema?.required).toContain('skillIds');
    expect(schema?.properties?.skillIds).toBeDefined();
    expect(schema?.properties?.skillIds.type).toBe('array');
  });

  it('should require userId and sessionId in context', async () => {
    const tool = mcpToolRegistry.getTool('install_skills');

    // Test with missing userId
    await expect(
      tool?.execute({ skillIds: ['skill-1'] }, { sessionId: 'session-1' })
    ).rejects.toThrow('Missing user or session context');

    // Test with missing sessionId
    await expect(
      tool?.execute({ skillIds: ['skill-1'] }, { userId: 'user-1' })
    ).rejects.toThrow('Missing user or session context');
  });

  it('should throw error if context missing', async () => {
    const tool = mcpToolRegistry.getTool('install_skills');

    await expect(
      tool?.execute({ skillIds: ['skill-1'] }, {})
    ).rejects.toThrow('Missing user or session context');

    await expect(
      tool?.execute({ skillIds: ['skill-1'] }, undefined)
    ).rejects.toThrow();
  });

  it('should call agentModeService.installSkills with correct arguments', async () => {
    const tool = mcpToolRegistry.getTool('install_skills');
    
    const mockResult = {
      success: true,
      message: 'Successfully installed 1 skill(s).',
      installedSkills: ['Test Skill'],
    };
    (agentModeService.installSkills as jest.Mock).mockResolvedValue(mockResult);

    const context = { userId: 'user-123', sessionId: 'session-456' };
    const args = { skillIds: ['skill-1', 'skill-2'] };

    await tool?.execute(args, context);

    expect(agentModeService.installSkills).toHaveBeenCalledWith(
      ['skill-1', 'skill-2'],
      'user-123',
      'session-456'
    );
  });

  it('should return success with installed skill names', async () => {
    const tool = mcpToolRegistry.getTool('install_skills');
    
    const mockResult = {
      success: true,
      message: 'Successfully installed 2 skill(s).',
      installedSkills: ['Content Creation', 'Analytics'],
    };
    (agentModeService.installSkills as jest.Mock).mockResolvedValue(mockResult);

    const result = await tool?.execute(
      { skillIds: ['skill-1', 'skill-2'] },
      { userId: 'user-123', sessionId: 'session-456' }
    );

    expect(result).toEqual(mockResult);
    expect(result.success).toBe(true);
    expect(result.installedSkills).toContain('Content Creation');
    expect(result.installedSkills).toContain('Analytics');
  });

  it('should return error message for invalid skill IDs', async () => {
    const tool = mcpToolRegistry.getTool('install_skills');
    
    const mockResult = {
      message: 'No valid skills found for the provided IDs.',
    };
    (agentModeService.installSkills as jest.Mock).mockResolvedValue(mockResult);

    const result = await tool?.execute(
      { skillIds: ['invalid-skill'] },
      { userId: 'user-123', sessionId: 'session-456' }
    );

    expect(result.message).toContain('No valid skills found');
  });

  it('should return validation error for empty skillIds array', async () => {
    const tool = mcpToolRegistry.getTool('install_skills');

    const result = await tool?.execute(
      { skillIds: [] },
      { userId: 'user-123', sessionId: 'session-456' }
    );

    // Should return early with validation message, not call installSkills
    expect(agentModeService.installSkills).not.toHaveBeenCalled();
    expect(result.message).toContain('skillIds must be a non-empty array');
  });

  it('should return validation error for non-array skillIds', async () => {
    const tool = mcpToolRegistry.getTool('install_skills');

    const result = await tool?.execute(
      { skillIds: 'not-an-array' },
      { userId: 'user-123', sessionId: 'session-456' }
    );

    // Should return early with validation message, not call installSkills
    expect(agentModeService.installSkills).not.toHaveBeenCalled();
    expect(result.message).toContain('skillIds must be a non-empty array');
  });

  it('should propagate service errors', async () => {
    const tool = mcpToolRegistry.getTool('install_skills');
    
    (agentModeService.installSkills as jest.Mock).mockRejectedValue(
      new Error('Service unavailable')
    );

    await expect(
      tool?.execute(
        { skillIds: ['skill-1'] },
        { userId: 'user-123', sessionId: 'session-456' }
      )
    ).rejects.toThrow('Service unavailable');
  });
});
