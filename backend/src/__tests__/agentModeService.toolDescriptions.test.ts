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

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - Tool Descriptions', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('Web Automation Task Tool Descriptions', () => {
    it('should clearly indicate create_task_from_template creates web automation tasks', () => {
      const tools = agentModeService.getAvailableTools();
      const createTaskFromTemplate = tools.find(
        (tool: any) => tool.function?.name === 'create_task_from_template'
      );

      expect(createTaskFromTemplate).toBeDefined();
      expect(createTaskFromTemplate?.function?.description).toContain('web automation task');
      expect(createTaskFromTemplate?.function?.description).toBe(
        'Create a web automation task using a specific template with the provided parameters'
      );
    });

    it('should clearly indicate create_task_from_prompt creates web automation tasks', () => {
      const tools = agentModeService.getAvailableTools();
      const createTaskFromPrompt = tools.find(
        (tool: any) => tool.function?.name === 'create_task_from_prompt'
      );

      expect(createTaskFromPrompt).toBeDefined();
      expect(createTaskFromPrompt?.function?.description).toContain('web automation task');
      expect(createTaskFromPrompt?.function?.description).toBe(
        'Create a web automation task using a raw prompt when no suitable template is available'
      );
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
  });

  describe('System Prompt - Web Automation Clarification', () => {
    it('should clarify that task creation tools are for web automation only', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      // System prompt should explicitly state web automation limitation
      expect(systemPrompt).toContain('Web Automation Tasks Only');
      expect(systemPrompt).toContain('ONLY for web automation tasks');
    });

    it('should specify what web automation tasks involve', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      // Should mention browser interaction as a key characteristic
      expect(systemPrompt).toContain('browser interaction');
    });

    it('should clarify what task creation tools cannot do', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      // Should explicitly state limitations
      expect(systemPrompt).toContain('cannot run generic tasks');
    });

    it('should mention both tools in the web automation context', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      // Find the section about web automation tasks
      const webAutomationSection = systemPrompt.match(
        /Web Automation Tasks Only.*?create_task_from_template.*?create_task_from_prompt/s
      );

      expect(webAutomationSection).not.toBeNull();
      expect(webAutomationSection![0]).toContain('create_task_from_template');
      expect(webAutomationSection![0]).toContain('create_task_from_prompt');
    });

    it('should provide examples of web automation tasks', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      // Should include concrete examples
      const hasExamples = 
        systemPrompt.includes('logging into websites') ||
        systemPrompt.includes('scraping data') ||
        systemPrompt.includes('filling forms');

      expect(hasExamples).toBe(true);
    });

    it('should emphasize web automation in template descriptions', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      // The fallback method description should also mention web automation
      expect(systemPrompt).toContain('web automation marketing tasks');
      expect(systemPrompt).toContain('web automation task with a raw prompt');
    });
  });
});

