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
      expect(systemPrompt).toContain('modular skill system');
    });

    it('should provide guidance on file attachments', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('File Attachments');
    });

    it('should tell the agent describe_video handles YouTube URLs and transcripts', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('describe_video');
      expect(systemPrompt).toContain('YouTube');
      expect(systemPrompt).toContain('return_transcript');
    });

    it('should guard against claiming it cannot access or transcribe videos', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      // The capability-awareness guard must explicitly forbid under-claiming.
      expect(systemPrompt).toContain('Never tell the user you cannot watch, access, or transcribe');
    });

    it('should route a shared video/YouTube link to describe_video in the feature reference', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      // The "videos" feature-reference line must mention describe_video for
      // analysis/repurposing, not only generate_video for generation.
      const videoLineMatch = systemPrompt.match(/"videos".*$/m);
      expect(videoLineMatch).toBeTruthy();
      expect(videoLineMatch![0]).toContain('describe_video');
    });

    it('should include response formatting guidelines', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Format your responses in HTML5');
      expect(systemPrompt).toContain('<strong>');
      expect(systemPrompt).toContain('<ul>');
    });

    it('should emphasize proactive skill discovery', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Decision Framework');
    });

    it('should mention Emma as the AI assistant name', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Emma');
      expect(systemPrompt).toContain('AI-marketing CMO persona');
    });

    it('should include the drafting direction guard', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Drafting Direction Guard');
      expect(systemPrompt).toContain('who the message is FROM and who it is TO');
      expect(systemPrompt).toContain('explicit reply, draft, send, or message-writing requests');
    });

    it('should preserve explicit to/on behalf of drafting direction', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('"draft a reply to ftan on behalf of Ed and Sophie" means draft FROM Ed and Sophie TO ftan');
    });

    it('should ask for confirmation before ambiguous multi-party drafting', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('"I\'ll draft this FROM [sender] TO [recipient] - correct?"');
    });

    it('should not polish inbound text when the user asked for a reply', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Do not merely polish an inbound message when the user asked for a reply');
    });

    it('should not assume a drafting task from pasted third-party text alone', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('only pasted third-party message text');
      expect(systemPrompt).toContain('do not assume a drafting task');
    });
  });


  describe('HTML File vs HTML Template Tool Descriptions', () => {
    it('create_html_file should steer one-off emails/newsletters here, not to a template', () => {
      const tools = agentModeService.getAvailableTools();
      const createHtmlFile = tools.find(
        (tool: any) => tool.function?.name === 'create_html_file'
      );

      expect(createHtmlFile).toBeDefined();
      const desc = createHtmlFile?.function?.description || '';
      // Must explicitly cover the one-off email/newsletter case
      expect(desc.toLowerCase()).toContain('newsletter');
      expect(desc.toLowerCase()).toContain('email');
      // Must point reusable/saved templates elsewhere
      expect(desc).toContain('create_html_template');
    });

    it('create_html_template should be reserved for reusable, saved templates', () => {
      const tools = agentModeService.getAvailableTools();
      const createHtmlTemplate = tools.find(
        (tool: any) => tool.function?.name === 'create_html_template'
      );

      expect(createHtmlTemplate).toBeDefined();
      const desc = createHtmlTemplate?.function?.description || '';
      // Must convey reusable + saved-to-library intent
      expect(desc.toLowerCase()).toContain('reusable');
      expect(desc.toLowerCase()).toContain('templates library');
      // Must redirect one-off email/newsletter drafting to create_html_file
      expect(desc).toContain('create_html_file');
    });

    it('create_html_file should expose a document_type=email option for newsletters', () => {
      const tools = agentModeService.getAvailableTools();
      const createHtmlFile = tools.find(
        (tool: any) => tool.function?.name === 'create_html_file'
      );

      const docType = createHtmlFile?.function?.parameters?.properties?.document_type;
      expect(docType).toBeDefined();
      expect(docType?.enum).toEqual(expect.arrayContaining(['document', 'email']));
      // Description should tell the model to use email mode for newsletters
      expect((createHtmlFile?.function?.description || '').toLowerCase()).toContain('newsletter');
    });

    it('the two HTML tools should have distinct descriptions', () => {
      const tools = agentModeService.getAvailableTools();
      const createHtmlFile = tools.find(
        (tool: any) => tool.function?.name === 'create_html_file'
      );
      const createHtmlTemplate = tools.find(
        (tool: any) => tool.function?.name === 'create_html_template'
      );

      expect(createHtmlFile?.function?.description).not.toBe(
        createHtmlTemplate?.function?.description
      );
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
