/**
 * AgentModeServiceV2
 * 
 * Refactored version of AgentModeService that uses the new modular architecture:
 * - ToolRegistry & ToolSelector for intent-based tool loading
 * - ToolExecutor for strategy-based tool execution
 * - LLMClientFactory for unified LLM access
 * - PromptTemplateService for modular prompts
 * 
 * This is a drop-in replacement for AgentModeService.
 * If any bugs are found, you can switch back to the original.
 */

import { ChatMessage, chatbotDb } from './chatbotService';

// Import new modular services
import {
  toolRegistry,
  ToolSelector,
  createToolSelector,
  toolExecutor,
  registerAllTools,
  allToolDefinitions,
  createHandlers,
  getSpecialHandlers,
  allHandlerConfigs,
  ToolContext,
  serviceRegistry,
  createServiceProvider
} from '../tools';

import {
  llmClientFactory,
  promptTemplateService,
  LLMCallOptions
} from './llm';

// Import services for registration
import { fileService } from './core/FileService';

import { webSearchService } from './research/WebSearchService';
import { knowledgeBaseService } from './research/KnowledgeBaseService';
import { deepResearchService } from './research/DeepResearchService';
import { brandService } from './crm/BrandService';
import { marketStrategyService } from './crm/MarketStrategyService';
import { leadService } from './crm/LeadService';
import { blogService, imageService, videoService, socialMediaService } from './content';
import { gtmService } from './gtm';
import { analyticsService } from './analytics';
import { automationService } from './automation';
import { bookService } from './books';
import { templateService } from './templates';

/**
 * AgentModeServiceV2 - uses new modular architecture
 */
export class AgentModeServiceV2 {
  private initialized = false;
  private toolSelector: ToolSelector | null = null;
  private legacyService: any = null; // Reference to original for delegation

  /**
   * Initialize the service
   */
  async initialize(legacyAgentModeService?: any): Promise<void> {
    if (this.initialized) return;

    console.log('AgentModeServiceV2: Initializing...');

    // Store reference to legacy service for methods we haven't migrated yet
    this.legacyService = legacyAgentModeService;

    // 1. Register all tool definitions
    console.log(`AgentModeServiceV2: Registering ${allToolDefinitions.length} tools...`);
    registerAllTools(toolRegistry);

    // 2. Create tool selector
    this.toolSelector = createToolSelector(toolRegistry);

    // 3. Register tool handlers
    // 3. Register tool handlers
    if (legacyAgentModeService) {
      // Register legacy service with service registry
      serviceRegistry.registerLegacy(legacyAgentModeService);

      // Register migrated services
      serviceRegistry.register(fileService.serviceName, fileService);
      serviceRegistry.register(webSearchService.serviceName, webSearchService);
      serviceRegistry.register(knowledgeBaseService.serviceName, knowledgeBaseService);
      serviceRegistry.register(deepResearchService.serviceName, deepResearchService);
      serviceRegistry.register(brandService.serviceName, brandService);
      serviceRegistry.register(marketStrategyService.serviceName, marketStrategyService);
      serviceRegistry.register(leadService.serviceName, leadService);
      serviceRegistry.register(blogService.serviceName, blogService);
      serviceRegistry.register(imageService.serviceName, imageService);
      serviceRegistry.register(videoService.serviceName, videoService);
      serviceRegistry.register(socialMediaService.serviceName, socialMediaService);
      serviceRegistry.register(gtmService.serviceName, gtmService);
      serviceRegistry.register(analyticsService.serviceName, analyticsService);
      serviceRegistry.register(automationService.serviceName, automationService);
      serviceRegistry.register(bookService.serviceName, bookService);
      serviceRegistry.register(templateService.serviceName, templateService);
      
      // Create service provider wrapper
      const serviceProvider = createServiceProvider(serviceRegistry);
      
      // Create and register handlers using the provider
      const simpleHandlers = createHandlers(serviceProvider, allHandlerConfigs);
      toolExecutor.registerAll(simpleHandlers);
      
      const specialHandlers = getSpecialHandlers(legacyAgentModeService);
      toolExecutor.registerAll(specialHandlers);
      
      console.log(`AgentModeServiceV2: Registered ${toolExecutor.getRegisteredTools().length} handlers`);
    }

    this.initialized = true;
    console.log('AgentModeServiceV2: Ready');
  }

  /**
   * Get supported LLM models
   */
  async getSupportedModels(): Promise<string[]> {
    return llmClientFactory.getSupportedModels();
  }

  /**
   * Get default model
   */
  async getDefaultModel(): Promise<string> {
    return llmClientFactory.getDefaultModel();
  }

  /**
   * Call LLM with the new factory
   */
  async callLLM(model: string, messages: any[], options?: LLMCallOptions) {
    return llmClientFactory.callLLM(model, messages, options);
  }

  /**
   * Get system prompt
   */
  async getMarketingSystemPrompt(): Promise<string> {
    return promptTemplateService.getEmmaSystemPrompt();
  }

  /**
   * Get welcome message
   */
  async getWelcomeMessage(): Promise<string> {
    const { promptBuilder } = await import('./llm');
    return promptBuilder.getWelcomeMessage();
  }

  /**
   * Get conversation starters
   */
  async getConversationStarters(): Promise<string[]> {
    const { promptBuilder } = await import('./llm');
    return promptBuilder.getConversationStarters();
  }

  /**
   * Get available tools - uses ToolSelector for intent-based loading with DB subscription
   */
  async getAvailableTools(
    message: string = '',
    userId: string,
    sessionHistory: Array<{ role: string; content: string }> = []
  ) {
    if (!this.toolSelector) {
      throw new Error('AgentModeServiceV2: Not initialized');
    }

    const selectedTools = await this.toolSelector.selectToolsForUser({
      message,
      userId,
      sessionHistory,
      includeDeprecated: false
    });

    // Convert to OpenAI format
    return toolRegistry.toOpenAIFormatFiltered(selectedTools);
  }

  /**
   * Get filtered tools with token savings info
   */
  async getFilteredToolsWithStats(
    message: string,
    userId: string,
    sessionHistory: Array<{ role: string; content: string }> = []
  ) {
    if (!this.toolSelector) {
      throw new Error('AgentModeServiceV2: Not initialized');
    }

    const selectedTools = await this.toolSelector.selectToolsForUser({
      message,
      userId,
      sessionHistory
    });

    const allTools = toolRegistry.getAll();
    const savings = this.toolSelector.estimateTokenSavings(
      selectedTools.length,
      allTools.length
    );

    return {
      tools: toolRegistry.toOpenAIFormatFiltered(selectedTools),
      selectedCount: selectedTools.length,
      totalCount: allTools.length,
      savingsPercent: savings.savingsPercent,
      categories: [...new Set(selectedTools.map(t => t.category))]
    };
  }

  /**
   * Execute a tool - uses ToolExecutor with strategy pattern
   */
  async executeTool(
    toolName: string,
    args: any,
    userId: string,
    sessionId: string,
    llmModel: string,
    mockMode: boolean = false
  ): Promise<any> {
    const context: ToolContext = {
      userId,
      sessionId,
      llmModel,
      mockMode
    };

    try {
      const result = await toolExecutor.execute(toolName, args, context);
      return result.data;
    } catch (error: any) {
      console.error(`AgentModeServiceV2: Tool execution failed for ${toolName}:`, error);
      
      // For unknown tools, try legacy service
      if (error.name === 'ToolNotFoundError' && this.legacyService) {
        console.log(`AgentModeServiceV2: Falling back to legacy for ${toolName}`);
        return this.legacyService.executeTool(toolName, args, userId, sessionId, llmModel, mockMode);
      }
      
      throw error;
    }
  }

  /**
   * Generate marketing response - main orchestration method
   * Uses new modular architecture
   */
  async generateMarketingResponse(
    messageContent: string,
    sessionHistory: ChatMessage[],
    userId: string,
    llmModel: string,
    sessionId: string,
    mockMode: boolean = false,
    onProgress?: (progress: { iteration: number; status: string; toolCalls?: any[]; pendingTools?: string[] }) => void
  ): Promise<{ content: string; toolCalls: any[]; knowledgeBaseQueries: string[]; sources: string[]; responseMessages: any[] }> {
    try {
      // 1. Get system prompt
      const systemPrompt = await this.getMarketingSystemPrompt();
      const currentDate = new Date().toISOString().split('T')[0];

      // 2. Get available templates (from legacy for now)
      let templatesContext = '';
      if (this.legacyService) {
        const templates = await this.legacyService.getAvailableTemplates();
        templatesContext = this.legacyService.buildTemplatesContext(templates);
      }

      // 3. Get filtered tools based on intent (NEW: intent-based selection with DB-driven permissions)
      if (!this.toolSelector) {
        throw new Error('AgentModeServiceV2: Not initialized');
      }

      // Use userId for DB-driven subscription lookup
      const selectedTools = await this.toolSelector.selectToolsForUser({
        message: messageContent,
        userId: userId,
        sessionHistory: sessionHistory.map(m => ({ role: m.role, content: m.content }))
      });
      
      // Convert to OpenAI format for the LLM
      const filteredTools = toolRegistry.toOpenAIFormatFiltered(selectedTools);
      
      const allTools = toolRegistry.getAll();
      const savingsPercent = this.toolSelector.estimateTokenSavings(
        selectedTools.length,
        allTools.length
      ).savingsPercent;

      console.log(`AgentModeServiceV2: Using ${filteredTools.length} tools (${savingsPercent}% token savings)`);

      // 4. Build context messages (delegate to legacy if available)
      let marketingMessages: any[] = [];
      if (this.legacyService) {
        const session = await chatbotDb.getChatSession(sessionId);
        const currentTaskStatuses = this.legacyService.getCurrentTaskStatusesInSession(sessionHistory);
        marketingMessages = this.legacyService.buildMarketingContext(
          messageContent, sessionHistory, currentTaskStatuses, session?.workPlan
        );
      } else {
        // Simple fallback
        marketingMessages = sessionHistory.map(m => ({
          role: m.role,
          content: m.content
        }));
        marketingMessages.push({ role: 'user', content: messageContent });
      }

      // 5. Build messages
      const messages: any[] = [
        { role: 'system', content: `${systemPrompt}\n\nCurrent date: ${currentDate}` },
        ...(templatesContext ? [{ role: 'assistant', content: templatesContext }] : []),
        ...marketingMessages
      ];

      let content = '';
      const toolCalls: any[] = [];
      const knowledgeBaseQueries: string[] = [];
      const sources: string[] = [];
      const initialMessageCount = messages.length;

      // 6. Main LLM loop
      const maxIterations = 20;
      let iteration = 0;

      while (iteration < maxIterations) {
        iteration++;

        if (onProgress) {
          onProgress({
            iteration,
            status: `Processing (iteration ${iteration})...`,
            pendingTools: toolCalls.filter(tc => tc.status === 'pending').map(tc => tc.name)
          });
        }

        // Make LLM call
        const response = await this.callLLM(llmModel, messages, {
          tools: filteredTools.length > 0 ? filteredTools : undefined,
          tool_choice: filteredTools.length > 0 ? 'auto' : undefined,
          max_completion_tokens: 12384,
          temperature: 0.1
        });

        const choice = response.choices[0];
        const message = choice.message;

        // Add assistant message to history
        messages.push(message);

        // Handle content
        if (message.content) {
          content = message.content;
        }

        // Check for tool calls
        if (!message.tool_calls || message.tool_calls.length === 0) {
          // No more tool calls, we're done
          break;
        }

        // Execute tool calls
        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name;
          let args: any = {};

          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch (e) {
            console.error('Failed to parse tool arguments:', e);
          }

          // Track knowledge base queries
          if (functionName === 'search_knowledge_base' && args.query) {
            knowledgeBaseQueries.push(args.query);
          }

          // Execute tool
          let toolResult: any;
          try {
            toolResult = await this.executeTool(
              functionName, args, userId, sessionId, llmModel, mockMode
            );
          } catch (error: any) {
            toolResult = { error: error.message, success: false };
          }

          // Extract minimal result if needed
          const minimalResult = this.extractMinimalToolResult(toolResult, functionName);

          // Add tool result to messages
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: typeof minimalResult === 'string' 
              ? minimalResult 
              : JSON.stringify(minimalResult)
          });

          // Track tool calls
          toolCalls.push({
            id: toolCall.id,
            name: functionName,
            arguments: args,
            result: minimalResult,
            status: 'completed'
          });
        }
      }

      // Get response messages (after initial context)
      const responseMessages = messages.slice(initialMessageCount);

      return {
        content,
        toolCalls,
        knowledgeBaseQueries,
        sources,
        responseMessages
      };

    } catch (error: any) {
      console.error('AgentModeServiceV2: Error in generateMarketingResponse:', error);
      
      // Fallback to legacy service if available
      if (this.legacyService) {
        console.log('AgentModeServiceV2: Falling back to legacy service');
        return this.legacyService.generateMarketingResponse(
          messageContent, sessionHistory, userId, llmModel, sessionId, mockMode, onProgress
        );
      }
      
      throw error;
    }
  }

  /**
   * Extract minimal tool result to reduce token usage
   */
  private extractMinimalToolResult(result: any, toolName: string): any {
    // Delegate to legacy if available for full compatibility
    if (this.legacyService?.extractMinimalToolResult) {
      return this.legacyService.extractMinimalToolResult(result, toolName);
    }

    // Simple fallback
    if (typeof result === 'string') return result;
    if (!result) return 'No result';
    
    const str = JSON.stringify(result);
    if (str.length > 5000) {
      return str.substring(0, 5000) + '... (truncated)';
    }
    return result;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Export singleton
export const agentModeServiceV2 = new AgentModeServiceV2();
