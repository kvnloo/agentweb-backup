/**
 * Agent Service Factory
 * 
 * Integration module that connects all the new modular services.
 * This provides a unified interface to the refactored architecture.
 */

import { toolRegistry, registerAllTools, allToolDefinitions } from '../../tools';
import { ToolSelector, createToolSelector } from '../../tools';
import { ToolExecutor, toolExecutor, createHandlers, getSpecialHandlers, allHandlerConfigs } from '../../tools';
import { llmClientFactory, promptTemplateService } from '../llm';

/**
 * Agent Configuration
 */
export interface AgentConfig {
  /** Default LLM model to use */
  defaultModel?: string;
  
  /** Maximum tool iterations */
  maxIterations?: number;
  
  /** Whether to enable mock mode */
  mockMode?: boolean;
  
  /** Whether to log verbose output */
  verbose?: boolean;
}

/**
 * Agent Service Factory
 * 
 * Creates and configures the agent with all necessary services.
 */
export class AgentServiceFactory {
  private initialized = false;
  private toolSelector: ToolSelector | null = null;
  
  /**
   * Initialize all services
   */
  async initialize(config: AgentConfig = {}): Promise<void> {
    if (this.initialized) {
      console.log('AgentServiceFactory: Already initialized');
      return;
    }

    console.log('AgentServiceFactory: Initializing...');

    // 1. Register all tool definitions
    console.log(`AgentServiceFactory: Registering ${allToolDefinitions.length} tool definitions...`);
    registerAllTools(toolRegistry);

    // 2. Create tool selector
    this.toolSelector = createToolSelector(toolRegistry);
    console.log('AgentServiceFactory: Tool selector created');

    // 3. Verify LLM client
    const models = llmClientFactory.getSupportedModels();
    console.log(`AgentServiceFactory: LLM client supports ${models.length} models: ${models.join(', ')}`);

    // 4. Verify prompt templates
    const templates = promptTemplateService.listTemplates();
    console.log(`AgentServiceFactory: ${templates.length} prompt templates available`);

    this.initialized = true;
    console.log('AgentServiceFactory: Initialization complete');
  }

  /**
   * Register tool handlers from agentModeService
   * Call this with the agentModeService instance to enable tool execution
   */
  registerToolHandlers(agentModeService: any): void {
    if (!agentModeService) {
      throw new Error('AgentServiceFactory: agentModeService is required');
    }

    console.log('AgentServiceFactory: Registering tool handlers...');

    // Register simple handlers from configs
    const simpleHandlers = createHandlers(agentModeService, allHandlerConfigs);
    toolExecutor.registerAll(simpleHandlers);
    console.log(`AgentServiceFactory: Registered ${simpleHandlers.length} simple handlers`);

    // Register special handlers (with custom logic)
    const specialHandlers = getSpecialHandlers(agentModeService);
    toolExecutor.registerAll(specialHandlers);
    console.log(`AgentServiceFactory: Registered ${specialHandlers.length} special handlers`);

    const totalHandlers = toolExecutor.getRegisteredTools().length;
    console.log(`AgentServiceFactory: Total handlers registered: ${totalHandlers}`);
  }

  /**
   * Get the tool selector
   */
  getToolSelector(): ToolSelector {
    if (!this.toolSelector) {
      throw new Error('AgentServiceFactory: Not initialized. Call initialize() first.');
    }
    return this.toolSelector;
  }

  /**
   * Get the tool executor
   */
  getToolExecutor(): ToolExecutor {
    return toolExecutor;
  }

  /**
   * Get available tools for a user message
   * Fetches actual user subscription from database via subscriptionService
   */
  async getToolsForMessage(
    message: string,
    userId: string,
    sessionHistory: Array<{ role: string; content: string }> = []
  ) {
    if (!this.toolSelector) {
      throw new Error('AgentServiceFactory: Not initialized. Call initialize() first.');
    }

    // Fetch actual subscription-based allowed function calls from database
    const { getAllowedFunctionCalls } = await import('../subscriptionService');
    const allowedFunctionCalls = await getAllowedFunctionCalls(userId);

    const selectedTools = this.toolSelector.selectTools({
      message,
      sessionHistory,
      includeDeprecated: false
    });

    // Filter tools based on actual subscription permissions
    const filteredTools = selectedTools.filter(tool => 
      allowedFunctionCalls.includes(tool.name)
    );

    // Convert to OpenAI format
    const openAITools = toolRegistry.toOpenAIFormatFiltered(filteredTools);
    
    // Calculate savings
    const allTools = toolRegistry.getAll();
    const savings = this.toolSelector.estimateTokenSavings(
      filteredTools.length,
      allTools.length
    );

    return {
      tools: openAITools,
      selectedCount: filteredTools.length,
      totalCount: allTools.length,
      savingsPercent: savings.savingsPercent,
      categories: [...new Set(filteredTools.map(t => t.category))]
    };
  }

  /**
   * Execute a tool
   */
  async executeTool(
    toolName: string,
    args: any,
    context: {
      userId: string;
      sessionId: string;
      llmModel: string;
      mockMode?: boolean;
    }
  ) {
    return toolExecutor.execute(toolName, args, {
      userId: context.userId,
      sessionId: context.sessionId,
      llmModel: context.llmModel,
      mockMode: context.mockMode || false
    });
  }

  /**
   * Get the system prompt for the agent
   */
  async getSystemPrompt(): Promise<string> {
    return promptTemplateService.getEmmaSystemPrompt();
  }

  /**
   * Get system prompt with context
   */
  async getSystemPromptWithContext(currentDate: string): Promise<string> {
    return promptTemplateService.getEmmaSystemPromptWithContext({
      currentDate
    });
  }

  /**
   * Make an LLM call
   */
  async callLLM(
    model: string,
    messages: any[],
    options?: {
      tools?: any[];
      tool_choice?: string;
      max_completion_tokens?: number;
      temperature?: number;
    }
  ) {
    return llmClientFactory.callLLM(model, messages, options);
  }

  /**
   * Get the default LLM model
   */
  async getDefaultModel(): Promise<string> {
    return llmClientFactory.getDefaultModel();
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reset the factory (for testing)
   */
  reset(): void {
    this.initialized = false;
    this.toolSelector = null;
    toolExecutor.clear();
    toolRegistry.clear();
  }
}

// Singleton instance
export const agentServiceFactory = new AgentServiceFactory();
