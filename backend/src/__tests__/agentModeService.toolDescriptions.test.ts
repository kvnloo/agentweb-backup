import { AgentModeService } from '../services/agentModeService';

// Mock the dependencies
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk');

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

describe('AgentModeService - Tool Descriptions', () => {
  let agentModeService: AgentModeService;

  beforeEach(async () => {
    agentModeService = new AgentModeService();
    await agentModeService.initialize();
    jest.clearAllMocks();
  });

  describe('Web Automation Task Tool Descriptions', () => {
    it('should clearly indicate create_task_from_template creates web automation tasks', () => {
      const tools = agentModeService.getAvailableTools();
      const createTaskFromTemplate = tools.find(
        (tool: any) => tool.function?.name === 'create_task_from_template'
      );

      expect(createTaskFromTemplate).toBeDefined();
      expect(createTaskFromTemplate?.function?.description).toContain('[DEPRECATED]');
      expect(createTaskFromTemplate?.function?.description).toContain('web automation task');
      expect(createTaskFromTemplate?.function?.description).toContain('browser_* Playwright tools');
    });

    it('should clearly indicate create_task_from_prompt creates web automation tasks', () => {
      const tools = agentModeService.getAvailableTools();
      const createTaskFromPrompt = tools.find(
        (tool: any) => tool.function?.name === 'create_task_from_prompt'
      );

      expect(createTaskFromPrompt).toBeDefined();
      expect(createTaskFromPrompt?.function?.description).toContain('[DEPRECATED]');
      expect(createTaskFromPrompt?.function?.description).toContain('Web automation via agent engine is being phased out');
    });

    it('should have distinct descriptions for template vs prompt task creation', () => {
      const tools = agentModeService.getAvailableTools();
      
      const createTaskFromTemplate = tools.find(
        (tool: any) => tool.function?.name === 'create_task_from_template'
      );
      const createTaskFromPrompt = tools.find(
        (tool: any) => tool.function?.name === 'create_task_from_prompt'
      );

      expect(createTaskFromTemplate?.function?.description).not.toBe(
        createTaskFromPrompt?.function?.description
      );

      // Template-based should mention "template"
      expect(createTaskFromTemplate?.function?.description).toContain('template');
      
      // Prompt-based should mention "raw prompt" and "no suitable template"
      expect(createTaskFromPrompt?.function?.description).toContain('raw prompt');
      expect(createTaskFromPrompt?.function?.description).toContain('no suitable template');
    });

    it('should have consistent "web automation task" terminology across related tools', () => {
      const tools = agentModeService.getAvailableTools();
      
      const webAutomationTools = [
        'create_task_from_template',
        'create_task_from_prompt'
      ];

      for (const toolName of webAutomationTools) {
        const tool = tools.find((t: any) => t.function?.name === toolName);
        expect(tool?.function?.description).toContain('web automation task');
      }
    });
  });

  describe('Tool Definition Structure', () => {
    it('should have properly structured tool definitions', () => {
      const tools = agentModeService.getAvailableTools();
      
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);

      // Verify each tool has the required structure
      tools.forEach((tool: any) => {
        expect(tool).toHaveProperty('type');
        expect(tool.type).toBe('function');
        expect(tool).toHaveProperty('function');
        expect(tool.function).toHaveProperty('name');
        expect(tool.function).toHaveProperty('description');
        expect(tool.function).toHaveProperty('parameters');
        
        // Description should be a non-empty string
        expect(typeof tool.function.description).toBe('string');
        expect(tool.function.description.length).toBeGreaterThan(0);
      });
    });

    it('should include both task creation tools in available tools', () => {
      const tools = agentModeService.getAvailableTools();
      const toolNames = tools.map((tool: any) => tool.function?.name);

      expect(toolNames).toContain('create_task_from_template');
      expect(toolNames).toContain('create_task_from_prompt');
    });

    it('should include describe_video in available tools', () => {
      const tools = agentModeService.getAvailableTools();
      const describeVideo = tools.find(
        (tool: any) => tool.function?.name === 'describe_video'
      );

      expect(describeVideo).toBeDefined();
      expect(describeVideo?.function?.parameters?.required).toContain('video_file_url');
    });
  });

  describe('System Prompt - Skill-Based Approach', () => {
    it('should mention skill installation workflow', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('install_skills');
    });

    it('should explain the skills approach for expanding capabilities', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('skill');
      expect(systemPrompt).toContain('dynamic skill set');
    });

    it('should provide guidance on file attachments', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Handling File Attachments');
      expect(systemPrompt).toContain('markdown links');
    });

    it('should include response formatting guidelines', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Format your responses in HTML5');
      expect(systemPrompt).toContain('<strong>');
      expect(systemPrompt).toContain('<ul>');
    });

    it('should emphasize proactive skill discovery', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      // The new prompt uses the Analyze-Install-Execute protocol instead of just saying "be proactive"
      expect(systemPrompt).toContain('Analyze-Install-Execute');
    });

    it('should mention Emma as the AI assistant name', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Emma');
      expect(systemPrompt).toContain('AI-powered marketing assistant');
    });
  });


  describe('Market Strategy Tool Descriptions', () => {
    it('should have update_market_strategy tool with buyerPersonas field in ICP description', () => {
      const tools = agentModeService.getAvailableTools();
      const updateMarketStrategy = tools.find(
        (tool: any) => tool.function?.name === 'update_market_strategy'
      );

      expect(updateMarketStrategy).toBeDefined();
      
      // Check that the tool description mentions buyer personas
      const icpProperty = updateMarketStrategy?.function?.parameters?.properties?.icp;
      expect(icpProperty).toBeDefined();
      expect(icpProperty?.items?.properties).toHaveProperty('buyerPersonas');
      expect(icpProperty?.items?.properties?.buyerPersonas).toBeDefined();
      expect(icpProperty?.items?.properties?.buyerPersonas?.type).toBe('array');
      expect(icpProperty?.items?.properties?.buyerPersonas?.description).toContain('buyer personas');
    });

    it('should have read_market_strategy tool available', () => {
      const tools = agentModeService.getAvailableTools();
      const readMarketStrategy = tools.find(
        (tool: any) => tool.function?.name === 'read_market_strategy'
      );

      expect(readMarketStrategy).toBeDefined();
      expect(readMarketStrategy?.function?.description).toContain('market strategy');
    });
  });
});
