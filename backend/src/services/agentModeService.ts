import axios from 'axios';
import OpenAI from 'openai';
import { google } from 'googleapis';
import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import { chatbotDb, ChatMessage, searchPlatformKnowledgeBase } from './chatbotService';
import { getAccessToken as getClickUpAccessToken, getWorkspaces as getClickUpWorkspaces, listDocs as listClickUpDocs, readDocContent as readClickUpDocContent } from './clickupService';
import { taskDb, taskTemplateDb } from './db';
import { settingsService } from './settingsService';
import { getSecret, getGCSPPrivateKey } from '../utils/secretsManager';
import { createWriteStream, promises as fs, default as fsSync } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { ToolRegistry } from '../mcp/client/toolRegistry';
import { McpClientService } from '../mcp/client/mcpClientService';
import { skillService } from './skillService';
import { getAllowedSkills, resolveSkillsToToolNames, filterFunctionCalls } from './subscriptionService';

// Constant for the virtual "other skills" identifier
const OTHER_SKILLS_VIRTUAL_ID = '__other_skills__';
import { metaService, MetaService, MetaAdsCampaignParams, MetaAdsAdSetParams, MetaAdsAdCreativeParams, MetaAdsAdParams } from './metaService';
import { uploadFileToS3 } from '../utils/s3Utils';

type MetaApiResult = {
  success: boolean;
  message: string;
  error?: string;
  details?: any;
  [key: string]: any;
};

import {
  ALLOWED_NODE_TYPES,
  AllowedNodeType,
  ALLOWED_INSIGHTS_FIELDS,
  ALLOWED_INSIGHTS_BREAKDOWNS,
  ALLOWED_ACTION_BREAKDOWNS,
  ALLOWED_DATE_PRESETS,
  META_OBJ_GOAL_MAP,
  META_GOAL_BILLING_MAP,
  META_GOAL_BID_STRATEGY_MAP
} from '../utils/metaConstants';

// Initialize Azure OpenAI client for direct chat completion (same as blog.ts)
// Used for updateEmailDraftForLead to match generateBlogContent pattern
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { "api-version": process.env.AZURE_OPENAI_API_VERSION },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
});

// Type declaration for pdf-parse module
interface PDFData {
  text: string;
  numpages: number;
  numrender: number;
  info: any;
  metadata: any;
  version: string;
}

// Type for LLM model configuration
interface LLMModelConfig {
  client: OpenAI | null; // null for lazy-loaded clients (e.g., Gemini)
  supportsTemperature: boolean;
}

// Type for LLM call options
interface LLMCallOptions {
  tools?: any[] | null;
  tool_choice?: 'auto' | 'none' | any | null;
  max_completion_tokens?: number | null;
  temperature?: number | null;
  response_format?: { type: 'text' | 'json_object' } | null;
}


export class AgentModeService {
  private fileContentCache: Map<string, { file_url: string; file_name: string; file_size: number }> = new Map();
  private toolRegistry: ToolRegistry;
  private mcpClientService: McpClientService;
  private static toolsRegistered: boolean = false;
  default_model: string = process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2';
  private defaultModelSettingName = 'agent_mode_default_model';

  constructor() {
    this.toolRegistry = new ToolRegistry();
    this.mcpClientService = new McpClientService();
  }

  public async initialize() {
    await this.registerTools();
    if (process.env.IS_MCP_SERVER !== 'true') {
      await this.initializeMcp();
    } else {
      console.log('AgentMode: Skipping MCP initialization in server mode');
    }
  }

  public async shutdown() {
    try {
      if ((AgentModeService as any).mcpInitialized) {
        console.log('AgentMode: Shutting down MCP clients...');
        await this.mcpClientService.shutdown();
        (AgentModeService as any).mcpInitialized = false;
        console.log('AgentMode: MCP clients shut down successfully');
      }
    } catch (error) {
      console.error('AgentMode: Error during shutdown:', error);
    }
  }

  public async initializeMcp() {
    if ((AgentModeService as any).mcpInitialized) {
      console.log('[MCP-DEBUG] MCP already initialized, skipping');
      return;
    }
    (AgentModeService as any).mcpInitialized = true;

    try {
      console.log('[MCP-DEBUG] Initializing MCP client service...');
      await this.mcpClientService.initialize();
      const mcpTools = this.mcpClientService.getTools();
      for (const tool of mcpTools) {
        this.toolRegistry.register(tool);
      }
      console.log(`[MCP-DEBUG] Registered ${mcpTools.length} tools from MCP servers`);
    } catch (error) {
      console.error('AgentMode: Error initializing MCP:', error);
      (AgentModeService as any).mcpInitialized = false;
    }
  }

  /**
   * Refresh MCP tools - reconnect to all MCP servers and update tool registry
   * Call this when MCP server configurations change (add/update/delete)
   */
  public async refreshMcpTools(): Promise<void> {
    console.log('AgentMode: Refreshing MCP tools...');
    
    // Clear existing MCP tools from registry
    const existingTools = this.mcpClientService.getTools();
    for (const tool of existingTools) {
      this.toolRegistry.unregister(tool.name);
    }
    
    // Refresh the MCP client service
    await this.mcpClientService.refresh();
    
    // Re-register tools
    const mcpTools = this.mcpClientService.getTools();
    for (const tool of mcpTools) {
      this.toolRegistry.register(tool);
    }
    
    console.log(`AgentMode: Refreshed ${mcpTools.length} MCP tools`);
  }

  private async registerTools() {
    // 1. Ensure server tools are loaded into the global mcpToolRegistry (only needs to happen once)
    if (!AgentModeService.toolsRegistered) {
      try {
        // Import the registry and the tools definitions (for side effects)
        // Dynamic import to avoid circular dependencies
        await import('../mcp/server/registry');
        await import('../mcp/server/tools');
        
        AgentModeService.toolsRegistered = true;
      } catch (error) {
         console.error('AgentMode: Error loading server tools:', error);
      }
    }

    // 2. Register tools from the global mcpToolRegistry into THIS instance's toolRegistry check
    try {
       const { mcpToolRegistry } = await import('../mcp/server/registry');
       const toolNames = mcpToolRegistry.getToolNames();
      
      for (const name of toolNames) {
        const toolHandler = mcpToolRegistry.getTool(name);
        if (toolHandler) {
          // Wrap MCP definition in OpenAI definition format
          const mcpDef = toolHandler.definition;
          const openAiDef = {
            type: "function",
            function: {
              name: mcpDef.name,
              description: mcpDef.description,
              parameters: mcpDef.inputSchema
            }
          };

          this.toolRegistry.register({
            name: toolHandler.name,
            definition: openAiDef,
            execute: toolHandler.execute
          });
        }
      }
    } catch (error) {
       console.error('AgentMode: Error registering tools to instance:', error);
    }
  }

  async getDefaultModel(): Promise<string> {
    const fallbackModel = this.default_model;
    try {
      const setting = await settingsService.getSetting(this.defaultModelSettingName);
      const configuredModel = setting?.settingValue?.trim();
      if (configuredModel) {
        if (this.llmModels[configuredModel]) {
          return configuredModel;
        }
        console.warn(`AgentMode: Unsupported default model "${configuredModel}" in settings; using fallback.`);
      }
    } catch (error) {
      console.error('AgentMode: Error getting default model setting:', error);
    }
    return fallbackModel;
  }

  async getReportsModel(): Promise<string> {
    const fallbackModel = this.default_model;
    try {
      const setting = await settingsService.getSetting('agent_mode_reports_model');
      const configuredModel = setting?.settingValue?.trim();
      if (configuredModel) {
        if (this.llmModels[configuredModel]) {
          return configuredModel;
        }
        console.warn(`AgentMode: Unsupported reports model "${configuredModel}" in settings; using fallback.`);
      }
    } catch (error) {
      console.error('AgentMode: Error getting reports model setting:', error);
    }
    return fallbackModel;
  }

  // Helper method to create Azure OpenAI client for a specific deployment
  private getAzureOpenAIClient(deploymentName: string): OpenAI {
    return new OpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deploymentName}`,
      defaultQuery: {
        "api-version": process.env.AZURE_OPENAI_API_VERSION_AGENT_MODE || process.env.AZURE_OPENAI_API_VERSION || "2025-01-01-preview",
      },
      defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
    });
  }

  private gemini_client: OpenAI | null = null;
  private gemini_client_promise: Promise<OpenAI> | null = null;

  // Helper method to get Gemini client (lazy-loaded from secrets manager)
  public async getGeminiClient(): Promise<OpenAI> {
    // Return cached client if available
    if (this.gemini_client) {
      return this.gemini_client;
    }

    // If already initializing, wait for that promise
    if (this.gemini_client_promise) {
      return this.gemini_client_promise;
    }

    // Initialize client
    this.gemini_client_promise = (async () => {
      try {
        let geminiApiKey = process.env.GEMINI_API_KEY;

        if (!geminiApiKey) {
          const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
          const geminiSecretName = `${environment}/AgentWeb/GeminiAPIKey`;
          geminiApiKey = await getSecret(geminiSecretName);
        }

        if (!geminiApiKey || !geminiApiKey.trim()) {
          throw new Error('Gemini API key is empty or not found in env/secrets');
        }

        this.gemini_client = new OpenAI({
          apiKey: geminiApiKey.trim(),
          baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        });

        return this.gemini_client;
      } catch (error) {
        console.error('Error initializing Gemini client:', error);
        this.gemini_client_promise = null; // Reset promise on error
        throw error;
      }
    })();

    return this.gemini_client_promise;
  }

  public async getBedrockClient(modelId: string): Promise<any> {
    // Create a wrapper that implements OpenAI-compatible interface for Bedrock
    const { ChatBedrockConverse } = await import('@langchain/aws');
    const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
    const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = await import('@langchain/core/messages');

    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
    const bedrockClient = new BedrockRuntimeClient({
      region,
      credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      } : undefined,
    });

    // Map certain model IDs to their corresponding inference profile ARNs
    // Note: Newer Claude models require using inference profiles for cross-region access
    const inferenceProfileMap: Record<string, string> = {
      'anthropic.claude-sonnet-4-5-20250929-v1:0': 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'anthropic.claude-sonnet-4-6': 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
      'anthropic.claude-opus-4-6-v1': 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-opus-4-6-v1',
    };
    const actualModelId = inferenceProfileMap[modelId] || modelId;

    // Create OpenAI-compatible wrapper
    return {
      chat: {
        completions: {
          create: async (params: any) => {
            // Create chat instance with current parameters
            const chatBedrock = new ChatBedrockConverse({
              model: actualModelId,
              region,
              client: bedrockClient,
              temperature: params.temperature !== undefined ? params.temperature : 0.1,
              maxTokens: params.max_completion_tokens || undefined,
            });

            // Convert OpenAI format to LangChain Message objects
            const messages = params.messages.map((msg: any) => {
              if (msg.role === 'system') {
                return new SystemMessage(msg.content);
              } else if (msg.role === 'user') {
                return new HumanMessage(msg.content);
              } else if (msg.role === 'assistant') {
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                  // Handle assistant message with tool calls
                  return new AIMessage({
                    content: msg.content || '',
                    tool_calls: msg.tool_calls.map((tc: any) => ({
                      id: tc.id,
                      name: tc.function.name,
                      args: JSON.parse(tc.function.arguments),
                    })),
                  });
                }
                return new AIMessage(msg.content || '');
              } else if (msg.role === 'tool') {
                // Handle tool response messages
                return new ToolMessage({
                  content: msg.content,
                  tool_call_id: msg.tool_call_id,
                });
              }
              return new HumanMessage(String(msg.content || ''));
            });

            // Bind tools if provided
            let modelToInvoke: any = chatBedrock;
            if (params.tools && params.tools.length > 0) {
              // Tools are in OpenAI format: { type: 'function', function: { name, description, parameters } }
              // LangChain's bindTools accepts this format
              try {
                modelToInvoke = chatBedrock.bindTools(params.tools);
              } catch (error: any) {
                console.error('AgentMode: Error binding tools to Bedrock:', error.message);
                // If bindTools fails, try to invoke without tools
                console.warn('AgentMode: Falling back to invocation without tools');
                modelToInvoke = chatBedrock;
              }
            }

            // Invoke the model
            const response: any = await modelToInvoke.invoke(messages);

            // Extract tool calls if present
            let toolCalls = null;
            if (response.tool_calls && response.tool_calls.length > 0) {
              toolCalls = response.tool_calls.map((tc: any, index: number) => ({
                id: tc.id || `call_${Date.now()}_${index}`,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.args),
                },
              }));
            }

            // Extract usage information
            const usage = response.response_metadata?.usage || response.usage_metadata || {};
            const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
            const outputTokens = usage.output_tokens || usage.completion_tokens || 0;

            // Extract text content - handle both string and array formats (Anthropic returns array)
            let messageContent: string = '';
            if (typeof response.content === 'string') {
              messageContent = response.content;
            } else if (Array.isArray(response.content)) {
              // Anthropic/Bedrock format: [{type: "text", text: "..."}, ...]
              messageContent = response.content
                .map((item: any) => item?.text || '')
                .filter(Boolean)
                .join('\n');
            }

            // Convert response to OpenAI format
            return {
              id: `bedrock-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: messageContent,
                  tool_calls: toolCalls,
                },
                finish_reason: toolCalls ? 'tool_calls' : 'stop',
              }],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              },
            };
          },
        },
      },
    };
  }

  private llmModels: Record<string, LLMModelConfig> = {
    // List openai models - create client dynamically for each deployment
    'gpt-5-chat-2': { client: this.getAzureOpenAIClient('gpt-5-chat-2'), supportsTemperature: true },
    'gpt-5.2-chat': { client: this.getAzureOpenAIClient('gpt-5.2-chat'), supportsTemperature: false },
    // List gemini models - client will be lazy-loaded
    'gemini-3-pro-preview': { client: null, supportsTemperature: true },
    'gemini-3-flash-preview': { client: null, supportsTemperature: true },
    'gemini-3.1-pro-preview': { client: null, supportsTemperature: true },
    // List Claude models via AWS Bedrock - client will be lazy-loaded
    'anthropic.claude-sonnet-4-5-20250929-v1:0': { client: null, supportsTemperature: true },
    'anthropic.claude-sonnet-4-6': { client: null, supportsTemperature: true },
    'anthropic.claude-opus-4-6-v1': { client: null, supportsTemperature: true },
  };

  async getSupportedModels() {
    return Object.keys(this.llmModels);
  }

  async getReportsModelOptions(): Promise<string[]> {
    return Object.keys(this.llmModels).filter(m => m.startsWith('anthropic.'));
  }
  /**
   * Make an LLM call with the specified model and parameters
   * @param model - The model to use (e.g., 'gpt-5.1', 'gemini-3-pro-preview')
   * @param messages - Array of chat messages
   * @param options - Optional parameters for the LLM call
   * @returns The LLM response
   */


  async callLLM(
    model: string,
    messages: any[],
    options?: LLMCallOptions
  ) {

    // Validate that the model exists
    if (!this.llmModels[model]) {
      const availableModels = Object.keys(this.llmModels).join(', ');
      throw new Error(`Invalid model '${model}'. Available models: ${availableModels}`);
    }

    // Extract options with defaults
    const {
      tools = null,
      tool_choice = null,
      max_completion_tokens = null,
      temperature = null,
      response_format = { type: "text" }
    } = options || {};

    const params: any = {
      model: model,
      messages: messages,
      response_format: response_format || { type: "text" },
    };

    // Only add tools and tool_choice if tools are provided
    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = tool_choice || 'auto';
    }

    // Only add max_completion_tokens if specified
    if (max_completion_tokens) {
      params.max_completion_tokens = max_completion_tokens;
    }

    // Only add temperature if model supports it and value is provided
    if (this.llmModels[model].supportsTemperature && temperature !== null) {
      params.temperature = temperature;
    }

    // Get the client - lazy-load Gemini or Bedrock client if needed
    let client = this.llmModels[model].client;
    if (!client) {
      if (model === 'gemini-3-pro-preview' || model === 'gemini-3-flash-preview' || model === 'gemini-3.1-pro-preview') {
        client = await this.getGeminiClient();
        // Update the cached client for future use
        this.llmModels[model].client = client;
      } else if (model.startsWith('anthropic.')) {
        // Lazy-load Bedrock client for Claude models
        client = await this.getBedrockClient(model);
        // Update the cached client for future use
        this.llmModels[model].client = client;
      } else {
        throw new Error(`Client not initialized for model: ${model}`);
      }
    }

    if (!client) {
      throw new Error(`Failed to initialize client for model: ${model}`);
    }

    const res = await client.chat.completions.create(params);
    return res;
  }

  // Generate AI response for marketing conversation
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
      // 1. Initial Data Fetching (Pre-Loop) - Parallel fetch for performance
      let [
        currentSession,
        userAllowedSkillIds,
        publishedSkills,
        baseSystemPrompt
      ] = await Promise.all([
        chatbotDb.getChatSession(sessionId),
        getAllowedSkills(userId),
        skillService.getPublishedSkills(),
        this.getMarketingSystemPrompt()
      ]);

      const workPlan = currentSession?.workPlan;
      const currentTaskStatuses = this.getCurrentTaskStatusesInSession(sessionHistory);

      // 2. Initialize Context Variables
      // Legacy sessions (created before skills system) have associatedSkills === undefined/null.
      // New sessions have associatedSkills initialized as [] and enforce skill-first flow.
      const rawAssociatedSkills = currentSession?.associatedSkills;
      const isLegacySession = rawAssociatedSkills === undefined || rawAssociatedSkills === null;
      let associatedSkills: any[] = [];
      const sessionAssociatedSkillIds: string[] = Array.isArray(rawAssociatedSkills) ? rawAssociatedSkills : [];
      if (sessionAssociatedSkillIds.length) {
        associatedSkills = await skillService.getSkillsByIds(sessionAssociatedSkillIds);
      }

      // Build initial skill context
      let { allowedToolNames, installedSkillContextMsg } = this.buildSkillContext(associatedSkills, userAllowedSkillIds, publishedSkills, sessionAssociatedSkillIds);

      // 3. Build Initial Messages
      const marketingMessages = this.buildMarketingContext(messageContent, sessionHistory, currentTaskStatuses, workPlan);

      // Build the "Available Skills" message (excluding already-associated skills, filtered by subscription)
      let availableSkillContextMsg = this.buildAvailableSkillsMessage(publishedSkills, sessionAssociatedSkillIds, userAllowedSkillIds);

      const today = new Date().toISOString().split('T')[0];
      const messages: any[] = [
        { role: 'system', content: `${baseSystemPrompt}\nCurrent date: ${today}` }
      ];
      // Use helper to inject installed skills and templates
      this.updateConversationContext(messages, installedSkillContextMsg, availableSkillContextMsg);

      messages.push(...marketingMessages);

      let content = '';
      const toolCalls: any[] = [];
      const knowledgeBaseQueries: string[] = [];
      const sources: string[] = [];
      const iterationTimings: { iteration: number; llmDurationMs: number; toolNames: string[] }[] = [];

      // Remember initial message count to slice response messages later
      let initialMessageCount = messages.length;

      // Single loop for LLM calls and tool execution
      let maxIterations = 20; // Prevent infinite loops
      let iteration = 0;
      let responseMessage: any = null;
      let skillsUpdated = false;
      let filteredToolsCache: any[] | null = null; // Cache for filtered tools

      while (iteration < maxIterations) {
        iteration++;

        // 4. Refresh Context if Skills Changed
        if (skillsUpdated) {
            try {
                // Refresh session and skills
                currentSession = await chatbotDb.getChatSession(sessionId);
                const updatedAssociatedSkillIds = currentSession?.associatedSkills || [];
                
                if (updatedAssociatedSkillIds.length) {
                  associatedSkills = await skillService.getSkillsByIds(updatedAssociatedSkillIds);
                } else {
                  associatedSkills = [];
                }
                
                // Re-build context using helper
                const skillContext = this.buildSkillContext(associatedSkills, userAllowedSkillIds, publishedSkills, updatedAssociatedSkillIds);
                allowedToolNames = skillContext.allowedToolNames;
                installedSkillContextMsg = skillContext.installedSkillContextMsg;

                // Rebuild available skills (excluding newly associated ones, filtered by subscription)
                availableSkillContextMsg = this.buildAvailableSkillsMessage(publishedSkills, updatedAssociatedSkillIds, userAllowedSkillIds);

                // Update messages using helper — track length change to keep initialMessageCount accurate
                const preUpdateLen = messages.length;
                this.updateConversationContext(messages, installedSkillContextMsg, availableSkillContextMsg);
                const delta = messages.length - preUpdateLen;
                if (delta !== 0) {
                  initialMessageCount += delta;
                }

                // Invalidate tools cache
                filteredToolsCache = null;
                skillsUpdated = false;
            } catch (error) {
                console.error('Error refreshing skill context:', error);
            }
        }

        if (onProgress) {
          onProgress({
            iteration,
            status: 'thinking',
            toolCalls: iteration === 1 ? [] : toolCalls.slice()
          });
        }

        // 5. Get Tools (Cached)
        // Legacy sessions (pre-skills): skip skill filtering, return all subscription-allowed tools.
        // New sessions: use skill-based filtering. When no skills are installed, only install_skills
        // is in allowedToolNames, forcing the LLM to install a skill first.
        if (!filteredToolsCache) {
             // Discover tools from MCP servers that require per-user secrets (e.g. ClickUp).
             // These servers can't list tools during startup (no user context), so we
             // discover them here once per session and register into the tool registry.
             try {
               const discovered = await this.mcpClientService.discoverToolsForUser(userId, sessionId);
               if (discovered > 0) {
                 const newTools = this.mcpClientService.getTools();
                 for (const tool of newTools) {
                   if (!this.toolRegistry.getTool(tool.name)) {
                     this.toolRegistry.register(tool);
                   }
                 }
                 console.log(`[MCP-DISCOVER] Registered tools from ${discovered} per-user MCP server(s) for user ${userId}`);
               }
             } catch (e) {
               console.warn('[MCP-DISCOVER] Error discovering per-user MCP tools:', (e as Error).message);
             }

             const skillFilter = isLegacySession ? undefined : allowedToolNames;
             filteredToolsCache = await this.getFilteredTools(userId, skillFilter, userAllowedSkillIds);
        }

        // Make LLM call
        const llmStart = Date.now();
        const response: any = await this.callLLM(llmModel, messages, {
          tools: filteredToolsCache,
          tool_choice: 'auto',
          max_completion_tokens: 12384,
          temperature: 0.1
        });
        const llmDurationMs = Date.now() - llmStart;

        // Yield control back to event loop after LLM call to allow health checks and other requests
        // This prevents blocking the main thread during long-running generateResponse operations
        await new Promise(resolve => setImmediate(resolve));
        responseMessage = response.choices[0].message;

        // Record per-iteration timing for metadata
        const toolNamesList = responseMessage.tool_calls?.map((tc: any) => tc.function.name) || [];
        iterationTimings.push({ iteration, llmDurationMs, toolNames: toolNamesList });

        // Extract content - handle both string and array formats (Claude returns array)
        let responseContent = '';
        if (typeof responseMessage.content === 'string') {
          responseContent = responseMessage.content;
        } else if (Array.isArray(responseMessage.content)) {
          // Claude format: [{type: "text", text: "..."}, ...]
          responseContent = responseMessage.content
            .map((item: any) => item?.text || '')
            .filter(Boolean)
            .join('\n');
        } else if (responseMessage.content && typeof responseMessage.content === 'object') {
          responseContent = (responseMessage.content as any).text || '';
        }

        // Update content with LLM's response
        if (responseContent) {
          content = responseContent;
        }

        // Add LLM model to the response message
        responseMessage.llm = llmModel;

        // Append the model's message to conversation before handling tool calls
        (messages as any[]).push(responseMessage);

        // If no tool calls, break the loop
        if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
          // Send progress update: final response ready
          if (onProgress) {
            onProgress({
              iteration,
              status: 'complete',
              toolCalls: toolCalls.slice()
            });
          }
          break;
        }

        // Send progress update: executing tools
        // Include the names of tools that are about to be executed
        const pendingToolNames = responseMessage.tool_calls?.map((tc: any) => tc.function.name) || [];
        if (onProgress) {
          onProgress({
            iteration,
            status: 'executing_tools',
            toolCalls: toolCalls.slice(),
            pendingTools: pendingToolNames
          });
        }

        // Execute tool calls in parallel for performance
        // When the LLM returns multiple tool_calls in one response, they are independent
        // and can run concurrently instead of sequentially.
        const pendingCounterUpdates: Record<string, number> = {};
        const failedCounterUpdates: Record<string, number> = {};

        // Phase 1: Validate and prepare tool calls (synchronous)
        const preparedCalls: Array<{ toolCall: any; functionArgs: any }> = [];

        for (const toolCall of responseMessage.tool_calls) {
          try {
            const functionArgs = JSON.parse(toolCall.function.arguments);

            // Enforce skill-based tool access: reject calls to tools not in allowedToolNames.
            // LLMs may hallucinate tool calls from conversation history even when the tool
            // isn't in the current tools list. Return an error so the LLM learns to install skills first.
            // Only enforce when:
            //   1. The skills system is active (published skills exist), AND
            //   2. The session was created with the skills system (has associatedSkills).
            // Sessions created before the skills implementation have no associatedSkills
            // and should retain access to all tools for backward compatibility.
            if (publishedSkills.length > 0 && sessionAssociatedSkillIds.length > 0 && !allowedToolNames.has(toolCall.function.name)) {
              const errorMsg = `Tool "${toolCall.function.name}" is not available. You must install the required skill first using install_skills.`;
              (messages as any[]).push({
                tool_call_id: toolCall.id,
                role: 'tool',
                name: toolCall.function.name,
                content: JSON.stringify({ error: errorMsg }),
                metadata: { timestamp: new Date().toISOString() }
              });
              continue;
            }

            // Check if we need to refresh skills for next iteration
            if (toolCall.function.name === 'install_skills') {
                skillsUpdated = true;
            }

            preparedCalls.push({ toolCall, functionArgs });
          } catch (error) {
            // JSON parse failure — append error message for LLM
            console.error(`AgentMode: Tool argument parse error for ${toolCall.function.name}:`, error);
            const errMsg = error instanceof Error ? error.message : String(error);
            const errorContent = this.formatToolError(toolCall.function.name, `Failed to parse arguments: ${errMsg}`);
            (messages as any[]).push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: errorContent,
              metadata: { timestamp: new Date().toISOString() }
            });
          }
        }

        // Phase 2: Execute all prepared tools in parallel
        const toolPromises = preparedCalls.map(async ({ toolCall, functionArgs }) => {
          const toolStart = Date.now();
          try {
            const result = await this.executeTool(llmModel, toolCall.function.name, functionArgs, userId, sessionId, mockMode);
            const toolDuration = Date.now() - toolStart;
            return { status: 'success' as const, toolCall, functionArgs, result, duration: toolDuration };
          } catch (error) {
            const toolDuration = Date.now() - toolStart;
            return { status: 'error' as const, toolCall, functionArgs, error, duration: toolDuration };
          }
        });

        const toolResults = await Promise.all(toolPromises);

        // Phase 3: Process results in original order — append to messages, toolCalls, counters
        for (const toolResult of toolResults) {
          if (toolResult.status === 'success') {
            const { toolCall, functionArgs, result, duration } = toolResult;
            const minimalResult = this.extractMinimalToolResult(result, toolCall.function.name);

            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: functionArgs,
              result: minimalResult,
              duration
            });

            pendingCounterUpdates[toolCall.function.name] =
              (pendingCounterUpdates[toolCall.function.name] || 0) + 1;

            const toolContent = result.formattedContent || (typeof result === 'string' ? result : JSON.stringify(result));
            (messages as any[]).push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: toolContent,
              metadata: { timestamp: new Date().toISOString() }
            });
          } else {
            const { toolCall, functionArgs, error, duration } = toolResult;
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: functionArgs || toolCall.function.arguments,
              error: error instanceof Error ? error.message : 'Unknown error',
              duration
            });

            failedCounterUpdates[toolCall.function.name] =
              (failedCounterUpdates[toolCall.function.name] || 0) + 1;

            const errMsg = error instanceof Error ? error.message : String(error);
            const errorContent = this.formatToolError(toolCall.function.name, errMsg);
            messages.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: errorContent,
              metadata: { timestamp: new Date().toISOString() }
            });
          }
        }

        // Send progress update after all tools complete
        if (onProgress) {
          onProgress({
            iteration,
            status: 'tool_executed',
            toolCalls: toolCalls.slice(),
            pendingTools: []
          });
        }

        // Update failed function counters (batched)
        if (Object.keys(failedCounterUpdates).length > 0) {
          try {
            await chatbotDb.incrementFailedFunctions(sessionId, failedCounterUpdates);
          } catch (counterError) {
            console.error('AgentMode: Failed to update failed function call counter:', counterError);
          }
        }

        // Batch update function call counters after processing all tools in this iteration
        if (Object.keys(pendingCounterUpdates).length > 0) {
          try {
            await chatbotDb.incrementCalledFunctions(sessionId, pendingCounterUpdates);
          } catch (counterError) {
            console.error('AgentMode: Failed to batch update function call counters:', counterError);
            // Don't fail the whole iteration if counter update fails
          }
        }

        // Do not append an assistant message; tool messages above are sufficient for model continuation
      }

      if (iteration >= maxIterations) {
        console.warn('AgentMode: Reached maximum tool execution iterations');
      }

      // Attach timing metadata and tool calls to the last assistant message
      if (messages.length > 0) {
        const lastAssistantIdx = messages.length - 1 - [...messages].reverse().findIndex((m: any) => m.role === 'assistant');
        if (lastAssistantIdx < messages.length) {
          const lastMessage = messages[lastAssistantIdx];
          lastMessage.metadata = {
            ...lastMessage.metadata,
            timestamp: new Date().toISOString(),
            iterationTimings,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          };
        }
      }
      // Filter out user messages from responseMessages since the controller already saved
      // the user message before calling this function. Only return assistant/tool messages.
      const responseMessages = messages.slice(initialMessageCount).filter(
        (msg: any) => msg.role !== 'user'
      );
      
      return {
        content,
        toolCalls,
        knowledgeBaseQueries,
        sources,
        responseMessages
      };
    } catch (error: any) {
      console.error('AgentMode: Response generation failed:', error);

      // Handle Azure OpenAI content filtering errors specifically
      if (error?.code === 'content_filter' || error?.error?.code === 'ResponsibleAIPolicyViolation') {
        throw new Error('I apologize, but I cannot respond to that request as it may violate content policies. Please try rephrasing your question or asking about something else.');
      }

      // Handle other OpenAI API errors
      if (error?.status === 400) {
        throw new Error('I encountered an issue processing your request. Please try rephrasing your question.');
      }

      // Handle rate limiting
      if (error?.status === 429) {
        throw new Error('I\'m currently experiencing high demand. Please wait a moment and try again.');
      }

      // Generic error fallback
      throw new Error('I apologize, but I encountered an error processing your request. Please try again.');
    }
  }



  private updateConversationContext(
    messages: any[],
    installedSkillContextMsg: string,
    availableSkillContextMsg: string
  ) {
    // Helper to safely check if content starts with a prefix (handles both string and Anthropic array format)
    const contentStartsWith = (content: any, prefix: string): boolean => {
      if (typeof content === 'string') {
        return content.startsWith(prefix);
      }
      // Handle Anthropic's array content format: [{type: "text", text: "..."}]
      if (Array.isArray(content) && content.length > 0) {
        const firstBlock = content[0];
        if (firstBlock && firstBlock.type === 'text' && typeof firstBlock.text === 'string') {
          return firstBlock.text.startsWith(prefix);
        }
      }
      return false;
    };

    // 1. Handle Available Skills Message
    // Remove existing message first
    const availableSkillIdx = messages.findIndex(m => m.role === 'assistant' && contentStartsWith(m.content, 'Available Skills:'));
    if (availableSkillIdx !== -1) {
      messages.splice(availableSkillIdx, 1);
    }
    // Insert updated message if available
    if (availableSkillContextMsg) {
      messages.splice(1, 0, { role: 'assistant', content: availableSkillContextMsg });
    }

    // 2. Handle Installed Skills Message
    // Remove existing message first
    const installedIdx = messages.findIndex(m => m.role === 'assistant' && contentStartsWith(m.content, 'Installed Skills:'));
    if (installedIdx !== -1) {
      messages.splice(installedIdx, 1);
    }

    // Insert new message if available
    if (installedSkillContextMsg) {
      // Find optimal insertion point: after "Available Skills" or System Prompt
      const availableSkillMsgIndex = messages.findIndex(m => m.role === 'assistant' && contentStartsWith(m.content, 'Available Skills:'));
      let insertIndex = 1; // Default after system (assuming system is at 0)
      if (availableSkillMsgIndex !== -1) {
        insertIndex = availableSkillMsgIndex + 1;
      }

      messages.splice(insertIndex, 0, { role: 'assistant', content: installedSkillContextMsg });
    }
  }

  async getMarketingSystemPrompt(): Promise<string> {
    // Try to get custom system prompt from settings
    try {
      const setting = await settingsService.getSetting('agent_mode_system_prompt');
      if (setting && setting.settingValue) {
        return setting.settingValue;
      }
    } catch (error) {
      console.error('Error getting custom system prompt:', error);
    }

    // Fallback to default system prompt
    return `
      You are Emma, an AI-powered marketing assistant from AgentWeb. You help users execute marketing campaigns through natural conversation.

      ## Your Approach: The "Analyze-Install-Execute" Protocol
      You have a dynamic skill set. To fulfill **ANY** user request, you must strictly follow this workflow:

      ### 1. ANALYZE (Think Through the Complete Task)
      Before doing anything, break down the user's request into ALL the individual actions/tools you will need:
      - What data do you need to read? (e.g., brand guidelines, market strategy)
      - What content do you need to create? (e.g., blog articles, work plans)
      - What actions do you need to perform? (e.g., publishing, analytics)

      ### 2. IDENTIFY ALL REQUIRED SKILLS
      Look at the Available Skills list and identify EVERY skill that contains tools you need:
      - Match each required action to a skill by checking the Tools list
      - For complex tasks, you will typically need 2-4 skills
      - Example: "read brand guidelines and create a blog" requires:
        - Brand Strategy & Market Research (has read_brand_guidelines)
        - Content Intelligence & Authoring (has create_blog_article)

      ### 3. INSTALL ALL SKILLS AT ONCE
      Use \`install_skills\` with an array containing ALL the skill IDs you identified:
      - Do NOT install skills one at a time
      - Do NOT start executing until all required skills are installed
      - Example: install_skills(["workflow-skill-id", "brand-skill-id", "content-skill-id"])


      ### 4. EXECUTE
      Once all skills are installed and tools are available:
      - Use the tools to fulfill the user's request
      - Do not ask for permission to use installed tools
      - Complete the entire workflow

      ## Critical Rules
      * **Complete Task Analysis First**: Always analyze the ENTIRE task before installing any skills
      * **Batch Skill Installation**: Install ALL required skills in a single install_skills call
      * **Check Tool Availability**: Before installing, verify if you already have the tool from a previously installed skill
      * **No Generic Tools Default**: You do not have generic tools like web_search or image_generation initially. If you need them and they are missing, install them.

      ## Your Approach: The "Analyze-Install-Execute" Protocol
      You have a dynamic skill set. To fulfill **ANY** user request, you must strictly follow this workflow:
      ### 1. ANALYZE (Think Through the Complete Task)
      Before doing anything, break down the user's request into ALL the individual actions/tools you will need:
      - What data do you need to read? (e.g., brand guidelines, market strategy)
      - What content do you need to create? (e.g., blog articles, work plans)
      - What actions do you need to perform? (e.g., publishing, analytics)

      ### 2. IDENTIFY ALL REQUIRED SKILLS
      Look at the Available Skills list and identify EVERY skill that contains tools you need:
      - Match each required action to a skill by checking the Tools list
      - For complex tasks, you will typically need 2-4 skills
      - Example: "read brand guidelines and create a blog" requires:
      - Brand Strategy & Market Research (has read_brand_guidelines)
      - Content Intelligence & Authoring (has create_blog_article)

      ### 3. INSTALL ALL SKILLS AT ONCE
      Use \`install_skills\` with an array containing ALL the skill IDs you identified:
      - Do NOT install skills one at a time
      - Do NOT start executing until all required skills are installed
      - Example: install_skills(["workflow-skill-id", "brand-skill-id", "content-skill-id"])

## Task Creation Approach
- **IMPORTANT**: Always confirm with the user before creating any task, as tasks can take a few minutes to complete
- **Confirmation required**: Explain what the task will do and get explicit approval before proceeding
- **Web Automation Tasks Only**: The 'create_task_from_template' and 'create_task_from_prompt' tools are ONLY for web automation tasks that require browser interaction (e.g., logging into websites, scraping data, filling forms). These tools cannot run generic tasks that don't involve web browsing.
- **Primary Method**: Use the 'create_task_from_template' tool with a specific template_id and parameters_json string
- Use the 'list_task_templates' tool to discover available templates and find the most appropriate one based on the user's request
- Extract the required parameters from the user's message and pass them as a JSON string where keys are parameter names and values are the actual values
- Example: {"site_url": "example.com", "business_area": "e-commerce"}
- Templates provide structured, proven approaches to common web automation marketing tasks
- **Fallback Method**: If no suitable template is available, use 'create_task_from_prompt' to create a web automation task with a raw prompt
- The 'create_task_from_prompt' tool allows you to create custom web automation tasks with specific instructions when templates don't fit
 - **Image Generation**: Use 'generate_image' for creating and revising images. This provides real-time (~30s) image generation. [DEPRECATED: 'create_image_task_from_prompt' is deprecated - use 'generate_image' instead]
 - **Image Editing Tips**: When using 'generate_image' with inputImages, you can include multiple image URLs to create combined images. **IMPORTANT: When adding a logo to an image, ALWAYS use the dedicated 'logo_image' parameter instead of putting the logo URL in inputImages.** The 'logo_image' parameter ensures the logo is reproduced with absolute precision in text, shape, and color. Use 'inputImages' for non-logo reference images (backgrounds, base images to edit). For example, to add a logo to an existing image: put the base image URL in inputImages and the logo URL in logo_image. This is critical for maintaining logo fidelity.
 - **Video Generation**: Use 'generate_video' for creating videos. This provides real-time video generation using Veo 3.1. You can optionally provide start and end frames for interpolation between two images. The generated video will be saved and returned as an S3 URL.
 - **Blog Articles**: When creating blog articles, prefer using the 'create_blog_article' tool. It generates the article content, creates a high-quality hero image via imageService, formats the article into clean HTML, uploads it to S3, and returns the final HTML URL. Avoid ad-hoc content + image flows when this tool fits the request.
   - **When to use deep_research:true**: Set 'deep_research: true' when the user explicitly asks for "deep research", "comprehensive research", "well-researched article", or mentions topics that require authoritative sources (e.g., market trends, industry analysis, scientific topics, historical events). This performs Gemini Deep Research first (takes several minutes) and embeds research images. Default to 'deep_research: false' for standard blog articles. 
- **Meta Ads Campaigns and Metrics**:
- Use 'list_meta_ads_campaigns' to show users their available Meta ad campaigns before fetching detailed metrics
- Use 'get_meta_ads_metrics' to fetch and analyze Meta ad performance data for selected campaigns
- **Required parameter**: 'campaign_ids' (array of campaign IDs) is mandatory for 'get_meta_ads_metrics'
- **Recommended workflow**: First call 'list_meta_ads_campaigns' to show available campaigns with their IDs, then let the user choose campaigns to analyze, and call 'get_meta_ads_metrics' with the selected campaign_ids array for accurate filtering
- When metrics data is loaded, provide contextual analysis based on the conversation history and user's business goals
- Don't just repeat the numbers - provide meaningful insights, strategic recommendations, and actionable next steps
- Consider the user's industry, business stage, and previous conversation context when analyzing performance
- Compare metrics against industry benchmarks and identify specific optimization opportunities
- If a user asks about a specific ad that doesn't appear in the metrics data, explain that the ad may be disabled, paused, or have no activity in the selected timeframe
- **Important**: You cannot pull metrics for individual ads by name - the metrics function returns all active ads in the timeframe. If a user asks for specific ad metrics, explain that you can only analyze the ads that appear in the current data set
- **Web Search**: Use 'search_web' proactively to gather information from the internet before asking users for clarification
- **Automatic and fast**: Web search does NOT require user confirmation - use it automatically to improve your responses
- **When to search**: Before asking users for more details, search for market data, industry trends, competitor information, or other information available on the internet
- **Search first, ask second**: Use web search to gather background information and context from the internet before requesting additional details from users
- **Search topics include**: Market trends, industry benchmarks, competitor analysis, news, regulatory information, technology updates, or any information from the internet that would help provide better recommendations
- **Search strategy**: Use specific, targeted search queries to find the most relevant information
- **Integration**: Incorporate search results into your analysis and recommendations to provide data-driven insights
- **Search result presentation**: Always provide a tailored summary of search results that directly answers the user's question
- **Synthesize findings**: Analyze and synthesize search results to provide actionable insights relevant to the user's specific needs
- **Knowledge Base Search**: Use 'search_knowledge_base' to find information stored in the knowledge base. The knowledge base contains private knowledge (user-specific), public knowledge (shared by all users and the platform), Google Drive shared folders, and ClickUp docs. This is complementary to web search - use knowledge base for stored information and web search for information from the internet
- **When to use knowledge base**: Search the knowledge base when you need stored information that may have been added manually by users or captured from past work
- **Knowledge base vs web search**: Use knowledge base search for stored information (private or public), and web search for information from the internet

      ## Credentials & Account IDs (CRITICAL)
      - **META ADS**: You are FORBIDDEN from guessing Ad Account IDs (e.g., "act_123456").
      - The **VERY FIRST STEP** for any Meta Ads task is calling \`list_connected_accounts(platform="meta")\`.
      - Present the resulting IDs and Names to the user and ask them to select one.
      - If \`list_connected_accounts\` returns no results, you MUST tell the user to connect their account in the portal settings.
      - **DO NOT** use placeholder strings like "act_placeholder" or "placeholder". If you do not have a real ID, you cannot use the marketing tools.

## Social Media Posting (Connected Accounts)
When posting to connected social media accounts using 'post_on_connected_account':
- **CRITICAL: Always include the COMPLETE, FULL post content** in the content parameter. Never truncate, abbreviate, summarize, or omit any part of the text.
- Include ALL paragraphs, line breaks, hashtags, emojis, mentions, and formatting exactly as approved by the user.
- Do NOT use placeholders like "...", "[rest of content]", or any truncation indicators.
- If the user approved a multi-paragraph post, include every single paragraph in full.
- The content parameter must be an exact copy of what was shown to and approved by the user.

### LinkedIn Post Formatting (CRITICAL)
LinkedIn does NOT support markdown rendering. When creating or posting LinkedIn content, NEVER use markdown syntax:
- No **bold** or *italic* markers — they appear as raw asterisks
- No - or * bullet lists — use unicode bullets (•) or em dashes (—) instead
- No [text](url) links — paste full URLs directly (LinkedIn auto-links them)
- No # headings — use UPPERCASE, emojis, or line breaks for structure
- Use blank lines between paragraphs for readability
- Use emojis strategically for visual emphasis and section breaks
This applies to BOTH 'create_social_media_posts' and 'post_on_connected_account' when the platform is LinkedIn.

## "whitepapers" / "research reports" / "executive summaries"

For whitepapers, research reports, or executive summaries (target: 8-12 pages):

**Step 1 - Deep Research**: Call 'perform_deep_research' with depth="detailed" (3-5 pages) or "comprehensive" (5-10 pages). This returns research_url (S3 URL).

**Step 2 - Generate Charts**: Call 'perform_data_analysis' with:
  - file_urls: [research_url from Step 1]
  - analysis_instruction: "Analyze the research data and generate 3-4 chart images that visualize key findings and data points."
Save the chart image URLs from the response.

**Step 3 - Create White Paper**: Call 'create_book' with type="whitepaper", title, description, and author. This returns a book_id.

**Step 4 - Create Outline**: Call 'create_book_outline' with EXACTLY 5-6 sections maximum (NOT more):
      1. Executive Summary (length="short", ~1 page)
      2. Introduction/Background (length="short", ~1 page)
      3. Key Findings (length="medium", ~2 pages)
      4. Analysis/Discussion (length="long", ~3 pages)
      5. Conclusion & Recommendations (length="short", ~1 page)
      6. References (length="short")

      Do NOT create chapters within sections. Do NOT create more than 6 sections.
 **Step 5 - Generate Content**: For EACH section, call 'generate_book_content' with:
      - book_id, section_id
      - research_url: Pass the S3 URL from Step 1 (the function will fetch research content automatically)
      - content_description: Brief section-specific instructions. **IMPORTANT**: If this section should include charts from Step 2, add to content_description: "Include the following chart image: ![Chart Title](chart_url_from_step_2)" for each relevant chart.
      - length: Use "short" for Executive Summary & Conclusion (~1 page), "medium" for Introduction & Key Findings (~2 pages), "long" for Analysis only (~3 pages)
      - imagine: false (stick to research facts, don't invent details)

## Task Execution
- When you create tasks, they will show execution status in the UI (pending, running, completed, failed)
- The tool call results will include the current status of any running tasks
- You can reference the status information provided in the tool call results
- If a user asks about task status, use the current status from the tool call results

## Communication Style
- Be helpful, professional, and conversational
- **Research before asking**: Use web search to gather current information before asking users for clarification
- **Proactive information gathering**: Search for market data, trends, and context to provide more informed recommendations
- **Data-driven approach**: Base your advice on current, real-world data rather than general knowledge
- Ask clarifying questions only after you've searched for available information
- **Web search is automatic**: Use web search proactively without asking for permission - it's fast and helps provide better answers
- **Task confirmation required**: Always explain what a task will do and ask for confirmation before creating it (tasks take time to complete)
- **Example confirmation**: "I'd like to create a market research task that will analyze your competitors and industry trends. This task may take a few minutes to complete. Would you like me to proceed?"
- Provide clear explanations of what you're doing and what information you've found
- Keep responses concise but informative
- Always confirm task creation and provide relevant details
- When using templates, explain which template was selected and why
- When analyzing metrics data, provide insights and recommendations rather than just repeating the numbers
- Focus on actionable insights and strategic guidance based on current data and conversation context
- If a user asks about a specific ad that doesn't appear in the metrics data, simply explain that the ad may be disabled, paused, or have no activity in the selected timeframe
- **Never offer to pull metrics for individual ads by name** - you can only analyze the ads that appear in the current metrics data set

## Work Plan Capabilities
You can create and manage multi-step work plans using these tools:
- **create_work_plan**: Create a structured plan with a title and numbered steps. Each step can include optional requiredFunctionCalls to enforce validation. **CRITICAL: Always check your context messages for an existing work plan before creating a new one. If a work plan already exists (you'll see a message starting with "⚠️ IMPORTANT: A WORK PLAN ALREADY EXISTS"), DO NOT create a new plan - use modify_work_plan instead.**
- **modify_work_plan**: Add new steps or modify existing step details (does not change status). Can also add or modify requiredFunctionCalls for steps. Use this when a work plan already exists and you need to make changes.
- **set_work_plan_status**: Update step status (pending/completed/skipped) with optional notes. **IMPORTANT**: If a step has requiredFunctionCalls defined, you MUST have called those functions before marking it as completed, or you'll get an error.

Work plans help organize complex multi-step projects like client onboarding, campaign planning, or content creation workflows. The current work plan status (if any) is automatically provided in your context. **If you see a work plan in your context, you MUST continue working with that existing plan - never create a duplicate.**

## GTM Plan Capabilities
You can read and create Go-To-Market (GTM) plans using these tools:
- **list_gtm_plans**: List all GTM plans for the user. Returns plan IDs, titles, descriptions, phase counts, and creation dates.
- **read_gtm_plan**: Read a specific GTM plan by its plan ID. Returns complete plan details including all phases and work items with their statuses, durations, completion times, and DRI (Directly Responsible Individual) email addresses at plan, phase, and item levels.
- **create_gtm_plan**: Create a new GTM plan with a title, optional description, optional DRI (Directly Responsible Individual) email at plan level, and optional phases with work items. You can create a complete plan structure in one call by including phases (each with title, description, duration, optional DRI) and work items (each with title, optional description, optional duration, optional DRI) within each phase. DRI can be specified at the plan level, phase level, or work item level. Returns the created plan with its unique identifier.

**IMPORTANT RESTRICTIONS:**
- **You CANNOT modify existing GTM plans** - You can only read existing plans and create new ones.
- **You CANNOT update work item statuses** - You cannot mark work items as completed, skipped, or pending.
- **You CANNOT add phases or work items to existing plans** - You cannot modify the structure of an existing GTM plan.
- **To modify plans**: Users must go to the /gtm-plan page in the customer portal to manually add phases, work items, update statuses, and make other changes.

Use GTM plans to understand the user's go-to-market strategy and provide context-aware assistance. When a user asks about their GTM plan, use read_gtm_plan to get the current state and provide insights based on the plan structure and progress. When creating a GTM plan, you can include the complete structure with phases and work items in a single call.

## Lead Lists Management
You can manage lead lists and add leads to them using these tools:
- **get_lead_lists**: Get all lead lists for the user. Returns list IDs, names, descriptions, lead counts, and creation dates. Use this to see what lead lists exist before adding leads or creating new lists.
- **create_lead_list**: Create a new lead list with a name and optional description. Returns the created list with its ID. Use this when the user wants to organize leads into a new list.
- **add_leads_to_list**: Add one or more leads to an existing lead list. Each lead is a flexible object that can contain any fields you want to store. Common fields include: email (used for deduplication and merging), firstName, lastName, phone, company, title, notes, linkedin, and any custom fields. You can use any field names that make sense for your data. If a lead with the same email already exists, it will be merged with the new data. Returns counts of new and merged leads, plus any errors. **IMPORTANT**: Always use get_lead_lists first to get the correct list_id before adding leads.

**Best Practices for Lead Lists:**
- When a user wants to add leads, first check if a suitable list exists using get_lead_lists
- If no appropriate list exists, offer to create one using create_lead_list
- When adding leads, use field names that make sense for the data you're storing - you're not limited to predefined fields
- The email field (if provided) is used for deduplication and merging - leads with the same email will be merged with existing records
- Include as much information as possible to make the leads more valuable
- You can use any field names - standard fields (email, firstName, lastName, phone, company, title, notes, linkedin) are recognized, and all other fields will be stored as custom fields
- Always confirm the list_id with the user or use get_lead_lists to find the correct one before adding leads

### Required Function Calls
You can specify required function calls for any step to ensure proper validation:
- Add requiredFunctionCalls array when creating or modifying steps
- Example: \`requiredFunctionCalls: ["create_blog_article", "generate_image"]\`
- When marking a step as completed, the system will validate that all required functions were actually called
- If any required functions are missing, you'll get an error message listing what's missing
- This ensures you don't skip important work before marking steps complete

### Client Onboarding Workflow
When a user requests client onboarding or says "onboard new client" or similar:
1. **Ask for website URL**: Request their business website URL first
2. **Create the work plan**: Use create_work_plan with title "Client Onboarding" and these steps with required function calls:
   - Step 1: Analyze website and business (requiredFunctionCalls: ["search_web"])
   - Step 2: Create/update brand guidelines (requiredFunctionCalls: ["update_brand_guidelines"])
   - Step 3: Create/update marketing strategy (requiredFunctionCalls: ["update_marketing_strategy"])
   - Step 4: Generate 3 blog articles (requiredFunctionCalls: ["create_blog_article"])
   - Step 5: Generate social media posts (requiredFunctionCalls: ["generate_image"])

      ## Handling File Attachments
      When users attach files, you see them as markdown links: \`[filename](url)\`.
      Analyze these files when relevant to the user's request. If you need specialized tools to process them (like data analysis), ensure the corresponding skill is installed first.

      ## Response Formatting
      Format your responses in HTML5 for direct rendering. Use:
      - <strong> for important points
      - <em> for emphasis
      - <code> for technical terms and commands
      - <ul> and <li> for lists
      - <pre> for code blocks
      - <a href="url" target="_blank"> for links
      - <table> for structured data

      Important formatting rules:
      1. Use minimal spacing - no extra blank lines
      2. Keep lists compact with minimal spacing
      3. Use single line breaks between list items
      4. Keep responses concise and well-structured
      5. Always include target="_blank" for links
      6. Use proper HTML5 semantic elements
      7. The chat window has a fixed width of 384px. Format your responses to fit within this constraint

      Use the available tools to create tasks in the agent-engine when complex work is required. Guide users through marketing flows naturally through conversation.`;
  }

  async getWelcomeMessage(): Promise<string> {
    // Try to get custom welcome message from settings
    try {
      const setting = await settingsService.getSetting('agent_mode_welcome_message');
      if (setting && setting.settingValue) {
        return setting.settingValue;
      }
    } catch (error) {
      console.error('Error getting custom welcome message:', error);
    }

    // Fallback to default welcome message
    return "I'm Emma, your team's new CMO 😎. I'll help you research, build, deploy, and measure Meta campaign insights in a blink of an eye.<br><br><strong>To get started, can you share your website URL?</strong>";
  }

  async getConversationStarters(): Promise<string[]> {
    // Try to get custom conversation starters from settings
    try {
      const setting = await settingsService.getSetting('agent_mode_conversation_starters');
      if (setting && setting.settingValue) {
        return JSON.parse(setting.settingValue);
      }
    } catch (error) {
      console.error('Error getting custom conversation starters:', error);
    }

    // Fallback to default conversation starters
    return [
      "Formulate marketing strategy for my product",
      "Create social media content calendar",
      "Develop my personal brand on Linkedin or x.com",
      "Create automated newsletter for my company"
    ];
  }

  private getStatusMessage(toolName: string, status: string): string {
    const statusEmoji: Record<string, string> = {
      'pending': '⏳',
      'running': '🔄',
      'completed': '✅',
      'failed': '❌'
    };
    const emoji = statusEmoji[status] || '⏳';

    const toolDescriptions: Record<string, string> = {
      'create_task_from_template': 'template-based task',
      'create_task_from_prompt': 'custom prompt task',
      'create_image_task_from_prompt': 'image generation task',
      'list_meta_ads_campaigns': 'Meta ads campaigns list',
      'get_meta_ads_metrics': 'Meta ads metrics analysis',
      'search_web': 'web search',
      'create_revision': 'task revision',
      'save_file': 'file save'
    };

    const toolDescription = toolDescriptions[toolName] || 'task';

    switch (status) {
      case 'pending':
        return `${emoji} **${toolDescription}** is queued and will start shortly.`;
      case 'running':
        return `${emoji} **${toolDescription}** is currently running. This may take a few minutes.`;
      case 'completed':
        return `${emoji} **${toolDescription}** has completed successfully!`;
      case 'failed':
        return `${emoji} **${toolDescription}** failed to complete. Please check the task details for more information.`;
      default:
        return `${emoji} **${toolDescription}** status: ${status}`;
    }
  }

  private buildMarketingContext(messageContent: string, sessionHistory: ChatMessage[], currentTaskStatuses: any[] = [], workPlan?: any): any[] {
    // Build structured messages preserving roles (assume the first is system) and including tool messages
    const messages: any[] = [];
    
    // Filter out the last user message if it matches current messageContent
    // This prevents duplication when sessionHistory already includes current message
    const filteredHistory = sessionHistory.filter((msg, index) => {
      // If this is the last message and it matches current content, skip it
      if (index === sessionHistory.length - 1 && 
          msg.role === 'user' && 
          msg.content === messageContent) {
        return false;
      }
      return true;
    });

    // Determine slice starting at the 10th most recent user message over full history
    let userCount = 0;
    let startIdx = 1; // Assume the first message is the system message
    for (let i = filteredHistory.length - 1; i >= 0; i--) {
      if (filteredHistory[i].role === 'user') {
        userCount++;
        if (userCount === 10) {
          startIdx = i;
          break;
        }
      }
    }
    const sliced = filteredHistory.slice(startIdx);



    // Copy all sliced messages as-is
    for (const msg of sliced) {
      let content = msg.content;

      // For user messages with attachments, reconstruct content to include attachment URLs
      // This matches how generateSessionResponse processes attachments (lines 495-502 in agentModeController)
      if (msg.role === 'user' && (msg as any).metadata?.attachments?.length > 0) {
        const attachments = (msg as any).metadata.attachments;
        const attachmentUrls = attachments.map((attachment: any) => {
          return `[${attachment.filename || 'Attachment'}](${attachment.url})`;
        }).join('\n');
        // Ensure content is a string before concatenating
        let contentStr = '';
        if (Array.isArray(content)) {
          contentStr = content.map((item: any) => item?.text || '').filter(Boolean).join('\n');
        } else if (typeof content === 'object' && content !== null) {
          contentStr = (content as any).text || JSON.stringify(content);
        } else {
          contentStr = String(content);
        }
        content = `${contentStr}\n\n**Attached Files:**\n${attachmentUrls}`;
      }

      const messageObj: any = { role: msg.role, content: content };

      // Add optional properties based on message type
      if ((msg as any).name) {
        messageObj.name = (msg as any).name;
      }
      if ((msg as any).tool_call_id) {
        messageObj.tool_call_id = (msg as any).tool_call_id;
      }
      if ((msg as any).tool_calls) {
        messageObj.tool_calls = (msg as any).tool_calls;
      }

      // Ensure content is never null or undefined and normalize format
      if (messageObj.content == null || messageObj.content === null || messageObj.content === undefined) {
        messageObj.content = '';
      } else if (Array.isArray(messageObj.content)) {
        // Handle Claude array format
        messageObj.content = messageObj.content
          .map((item: any) => item?.text || '')
          .filter(Boolean)
          .join('\n');
      } else if (typeof messageObj.content === 'object') {
        // Handle object format
        messageObj.content = (messageObj.content as any).text || JSON.stringify(messageObj.content);
      } else {
        messageObj.content = String(messageObj.content);
      }
      messages.push(messageObj);
    }

    // Insert current task statuses as an assistant message before the final user message
    const statusEmoji: Record<string, string> = {
      pending: '⏳',
      running: '🔄',
      completed: '✅',
      failed: '❌'
    };
    let statusesContent = '';
    if (currentTaskStatuses && currentTaskStatuses.length > 0) {
      statusesContent += 'Current Task Statuses:\n';
      currentTaskStatuses.forEach(task => {
        const emoji = statusEmoji[task.status] || '⏳';
        statusesContent += `${emoji} ${task.taskName} (${task.status}) - Task ID: ${task.taskId}, Execution ID: ${task.executionId}\n`;
      });
    } else {
      statusesContent = '📋 **Task Status**: No tasks have been run in this session yet.';
    }
    messages.push({ role: 'assistant', content: statusesContent });

    // Insert work plan status as an assistant message if exists
    if (workPlan) {
      const statusIcons = {
        completed: '✓',
        pending: '○',
        skipped: '⊘'
      };
      let workPlanContent = `⚠️ IMPORTANT: A WORK PLAN ALREADY EXISTS FOR THIS SESSION ⚠️\n\n`;
      workPlanContent += `[Current Active Work Plan: "${workPlan.title}"]\n\n`;
      workPlanContent += `You MUST continue working with this existing plan. DO NOT create a new work plan. Use modify_work_plan if you need to add or change steps.\n\n`;

      // If autocomplete is enabled, add instruction to auto-complete steps
      if (workPlan.autocomplete) {
        workPlanContent += `⚠️ AUTOCOMPLETE MODE: After performing the work of a step, DO NOT ask the user whether you should complete the step. Simply call set_work_plan_status to complete the step.\n\n`;
      }

      workPlan.steps.forEach((step: any) => {
        const icon = statusIcons[step.status as keyof typeof statusIcons];
        workPlanContent += `${step.stepCount}. ${icon} ${step.title} (${step.status})\n`;

        // Include step description if available
        if (step.description) {
          workPlanContent += `   Description: ${step.description}\n`;
        }

        // Include required function calls if available
        if (step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0) {
          workPlanContent += `   Required Functions: ${step.requiredFunctionCalls.join(', ')}\n`;
        }

        workPlanContent += '\n';
      });

      console.log('workPlanContent', workPlanContent);

      messages.push({ role: 'assistant', content: workPlanContent.trim() });
    }

    // Append the current user message at the end
    messages.push({ role: 'user', content: messageContent });

    return messages;
  }

  public async listSkills(userId: string, sessionId: string): Promise<any> {
    try {
      const publishedSkills = await skillService.getPublishedSkills();
      
      if (!publishedSkills.length)
        return { message: "No skills available in the library." };

      const session = await chatbotDb.getChatSession(sessionId);
      const currentAssociated = session?.associatedSkills || [];
      const associatedSkillIds = new Set(currentAssociated);
      
      const availableSkills = publishedSkills.filter(s => !associatedSkillIds.has(s.skillId));

      if (!availableSkills.length)
        return { message: "All available skills are already installed." };

      return {
        message: `Found ${availableSkills.length} available skill(s).`,
        skills: availableSkills.map(s => ({
          id: s.skillId,
          name: s.name,
          description: s.description
        }))
      };
    } catch (error) {
      console.error('AgentMode: Error in listSkills:', error);
      return { message: "An error occurred while listing skills." };
    }
  }

  // Tools that are always available without installing a skill.
  // install_skills is the skill installer itself; the rest are general-purpose primitives
  // (search, read, plan, save) that most conversations need regardless of domain.
  private static readonly FOUNDATION_TOOLS = new Set([
    'install_skills',
    'search_web',
    'read_file_content',
    'read_page_source',
    'search_knowledge_base',
    'list_knowledge_base_files',
    'read_knowledge_base_files',
    'create_work_plan',
    'modify_work_plan',
    'set_work_plan_status',
    'save_file',
    'describe_image',
  ]);

  // Subset of foundation tools that must execute for real in mock/benchmark mode
  // because they modify session state (no external side effects).
  private static readonly MOCK_BYPASS_TOOLS = new Set(['install_skills']);

  /**
   * Get tools that are not associated with any published skill.
   * Excludes foundation tools (always available without a skill).
   */
  private getUnassociatedTools(publishedSkills: any[]): { name: string; description: string }[] {
    // Collect all tool names used by any published skill
    const associatedToolNames = new Set<string>();
    publishedSkills.forEach(skill => {
      skill.toolNames?.forEach((t: string) => associatedToolNames.add(t));
    });

    // Get all registered tools and find those not in any skill
    const allTools = this.toolRegistry.getAllTools();

    return allTools
      .filter(tool => !associatedToolNames.has(tool.name) && !AgentModeService.FOUNDATION_TOOLS.has(tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.definition?.function?.description || ''
      }));
  }

  /**
   * Get tool names not associated with any published skill (excludes infrastructure tools).
   * Public version of getUnassociatedTools for use by subscriptionService.resolveSkillsToToolNames.
   */
  public getUnassociatedToolNames(publishedSkills: any[]): string[] {
    return this.getUnassociatedTools(publishedSkills).map(t => t.name);
  }

  /**
   * Get the set of foundation tool names (always available, not assignable to skills).
   */
  public getFoundationToolNames(): Set<string> {
    return AgentModeService.FOUNDATION_TOOLS;
  }

  /**
   * Build the "Available Skills" context message, excluding skills already associated with the session.
   * Only shows skills the user's subscription allows.
   */
  private buildAvailableSkillsMessage(publishedSkills: any[], associatedSkillIds: string[], userAllowedSkillIds: string[] = ["*"]): string {
    const associatedSet = new Set(associatedSkillIds);
    const isWildcard = userAllowedSkillIds.includes("*");
    const allowedSet = new Set(userAllowedSkillIds);
    const skillEntries: string[] = [];

    // Add published skills that are NOT already associated AND are allowed by subscription
    publishedSkills.forEach(s => {
      if (!associatedSet.has(s.skillId) && (isWildcard || allowedSet.has(s.skillId))) {
        skillEntries.push(`${s.skillId}- ${s.name}: ${s.description}: Tools: ${s.toolNames?.join(', ')}`);
      }
    });

    // Add virtual other_skills if allowed, there are unassociated tools, AND it's not already installed
    if (!associatedSet.has(OTHER_SKILLS_VIRTUAL_ID) && (isWildcard || allowedSet.has(OTHER_SKILLS_VIRTUAL_ID))) {
      const unassociatedTools = this.getUnassociatedTools(publishedSkills);

      if (unassociatedTools.length > 0) {
        const otherToolsDescription = unassociatedTools
          .map(t => `${t.name}: ${t.description}`)
          .join(', ');
        skillEntries.push(`${OTHER_SKILLS_VIRTUAL_ID}- other_skills: ${otherToolsDescription}`);
      }
    }

    if (skillEntries.length === 0) return '';
    return `Available Skills:\n${skillEntries.join('\n')}`;
  }

  /**
   * Get skills with installed status for UI display, filtered by user's subscription.
   */
  public async getSkillsForDisplay(associatedSkillIds: string[], userId?: string): Promise<{ skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[]> {
    const [publishedSkills, userAllowedSkillIds] = await Promise.all([
      skillService.getPublishedSkills(),
      userId ? getAllowedSkills(userId) : Promise.resolve(["*"] as string[])
    ]);
    const installedIds = new Set(associatedSkillIds);
    const isWildcard = userAllowedSkillIds.includes("*");
    const allowedSet = new Set(userAllowedSkillIds);

    const skills: { skillId: string; name: string; description: string; installed: boolean; toolNames: string[] }[] = publishedSkills
      .filter(s => isWildcard || allowedSet.has(s.skillId))
      .map(s => ({
        skillId: s.skillId,
        name: s.name,
        description: s.description,
        installed: installedIds.has(s.skillId),
        toolNames: s.toolNames || []
      }));

    // Add virtual other_skills entry if allowed and there are unassociated tools
    if (isWildcard || allowedSet.has(OTHER_SKILLS_VIRTUAL_ID)) {
      const unassociatedTools = this.getUnassociatedTools(publishedSkills);
      if (unassociatedTools.length > 0) {
        skills.push({
          skillId: OTHER_SKILLS_VIRTUAL_ID,
          name: 'Other Skills',
          description: 'Tools not associated with any specific skill',
          installed: installedIds.has(OTHER_SKILLS_VIRTUAL_ID),
          toolNames: unassociatedTools.map(t => t.name)
        });
      }
    }

    return skills;
  }

  public async installSkills(skillIds: string[], userId: string, sessionId: string): Promise<any> {
    try {
        const [publishedSkills, userAllowedSkillIds] = await Promise.all([
          skillService.getPublishedSkills(),
          getAllowedSkills(userId)
        ]);

        const isWildcard = userAllowedSkillIds.includes("*");
        const allowedSkillSet = new Set(userAllowedSkillIds);

        // Filter valid IDs: exists in published skills OR is the virtual other_skills ID
        // AND is allowed by user's subscription
        const validSkillIds = skillIds.filter(id =>
          (id === OTHER_SKILLS_VIRTUAL_ID || publishedSkills.some(s => s.skillId === id)) &&
          (isWildcard || allowedSkillSet.has(id))
        );

        const rejectedSkillIds = skillIds.filter(id => !validSkillIds.includes(id));

        const installedNames: string[] = [];

        if (validSkillIds.length > 0) {
          await chatbotDb.addAssociatedSkills(sessionId, validSkillIds);

          // Get names for response
          validSkillIds.forEach(id => {
            if (id === OTHER_SKILLS_VIRTUAL_ID) {
              installedNames.push('other_skills');
            } else {
              const skill = publishedSkills.find(s => s.skillId === id);
              if (skill) installedNames.push(skill.name);
            }
          });
        }

        if (!installedNames.length) {
          if (rejectedSkillIds.length > 0) {
            return { message: "The requested skills are not available with your current subscription." };
          }
          return { message: "No valid skills found for the provided IDs." };
        }

        const result: any = {
          success: true,
          message: `Successfully installed ${installedNames.length} skill(s).`,
          installedSkills: installedNames
        };

        if (rejectedSkillIds.length > 0) {
          result.message += ` ${rejectedSkillIds.length} skill(s) were not available with your subscription.`;
        }

        return result;
    } catch (error) {
        console.error('AgentMode: Error in installSkills:', error);
        return { message: "An error occurred while installing skills." };
    }
  }

  private buildSkillContext(
    associatedSkills: any[],
    userAllowedSkillIds: string[],
    publishedSkills: any[],
    sessionAssociatedSkillIds: string[] = []
  ): { allowedToolNames: Set<string>; installedSkillContextMsg: string } {
    const allowedToolNames = new Set<string>(AgentModeService.FOUNDATION_TOOLS);

    const isWildcard = userAllowedSkillIds.includes("*");
    const allowedSkillSet = new Set(userAllowedSkillIds);

    if (associatedSkills.length) {
      associatedSkills.forEach(s => {
        // Check if the skill itself is allowed by subscription (skill-level gating)
        if (isWildcard || allowedSkillSet.has(s.skillId)) {
          if (s.toolNames) {
            s.toolNames.forEach((t: string) => {
              allowedToolNames.add(t);
            });
          }
        }
      });
    }

    // Handle virtual other_skills (gated by subscription)
    if (sessionAssociatedSkillIds.includes(OTHER_SKILLS_VIRTUAL_ID) && (isWildcard || allowedSkillSet.has(OTHER_SKILLS_VIRTUAL_ID))) {
      const unassociatedTools = this.getUnassociatedTools(publishedSkills);
      unassociatedTools.forEach(t => allowedToolNames.add(t.name));
    }

    let installedSkillContextMsg = '';
    if (associatedSkills.length) {
      const context = associatedSkills.map(s => `${s.skillId}- ${s.name}: ${s.description} ${s.systemPrompt || ''}`).join('\n');
      installedSkillContextMsg = `Installed Skills:\n${context}`;
    }

    return { allowedToolNames, installedSkillContextMsg };
  }

  // Get all available tools (raw definitions)
  public getAvailableTools(): any[] {
    return this.toolRegistry.getAllTools().map(t => t.definition);
  }

  // Get filtered tools based on user's subscription type AND session state
  // optimized to accept precomputedAllowedNames to avoid redundant DB lookups when possible
  public async getFilteredTools(
    userId: string,
    precomputedAllowedSkillToolNames?: Set<string>,
    precomputedAllowedSkillIds?: string[]  // Skill IDs from subscription, to avoid duplicate getAllowedSkills call
  ): Promise<any[]> {
    try {

      // 1. Get all internal tool objects (flat structure with .name)
      const allInternalTools = this.toolRegistry.getAllTools();

      // 2. Apply skill-based filtering if a skill filter is provided.
      // Pre-skills sessions pass undefined to get all tools for backward compatibility.
      const contextAwareTools = precomputedAllowedSkillToolNames
        ? allInternalTools.filter(tool => precomputedAllowedSkillToolNames.has(tool.name))
        : allInternalTools;

      // 3. Map back to wire-format definitions for the LLM
      const definitions = contextAwareTools.map(t => t.definition);

      // 4. Apply Subscription Filtering
      // Resolve skill IDs to tool names for the subscription filter step
      const skillIds = precomputedAllowedSkillIds || await getAllowedSkills(userId);
      const allowedFunctionCalls = await resolveSkillsToToolNames(skillIds);

      // Foundation tools must always bypass subscription filtering — they are
      // core primitives (work plan, search, save) needed by every session.
      if (!allowedFunctionCalls.includes('*')) {
        AgentModeService.FOUNDATION_TOOLS.forEach(name => {
          if (!allowedFunctionCalls.includes(name)) {
            allowedFunctionCalls.push(name);
          }
        });
      }

      // Add all session-associated tools to the allowed list to bypass subscription filtering
      // (skills already installed in the session should remain usable)
      if (precomputedAllowedSkillToolNames && !allowedFunctionCalls.includes('*')) {
        precomputedAllowedSkillToolNames.forEach(name => {
          if (!allowedFunctionCalls.includes(name)) {
            allowedFunctionCalls.push(name);
          }
        });
      }

      return filterFunctionCalls(definitions, allowedFunctionCalls);
    } catch (error) {
      console.error('Error filtering tools:', error);
      // Fallback: return only install_skills to be safe, or empty array
      // DO NOT return all tools on error as it's a security risk
      const installSkillsTool = this.toolRegistry.getTool('install_skills');
      return installSkillsTool ? [installSkillsTool.definition] : [];
    }
  }

  // Extract only the necessary data for the frontend to reduce storage size
  private extractMinimalToolResult(result: any, toolName: string): any {
    // For task creation tools, only keep the essential fields for TaskExecutionStatus
    if (toolName === 'create_task_from_template' || toolName === 'create_task_from_prompt' || toolName === 'create_image_task_from_prompt' || toolName === 'create_revision') {
      // Handle case where result is wrapped in {content: "JSON string", raw: {...}}
      let actualResult = result;
      if (result.content && typeof result.content === 'string') {
        try {
          actualResult = JSON.parse(result.content);
        } catch (e) {
          console.error(`AgentMode: Failed to parse task creation result.content as JSON:`, e);
        }
      }
      return {
        taskId: actualResult.taskId,
        executionId: actualResult.executionId,
        status: actualResult.status || 'pending',
        message: actualResult.message || 'Task created'
      };
    }

    // For image generation, return the essential fields
    if (toolName === 'generate_image') {
      // Handle case where result is wrapped in {content: "JSON string", raw: {...}}
      let actualResult = result;
      if (result.content && typeof result.content === 'string') {
        try {
          actualResult = JSON.parse(result.content);
        } catch (e) {
          console.error(`AgentMode: Failed to parse generate_image result.content as JSON:`, e);
        }
      }
      return {
        success: actualResult.success,
        message: actualResult.message,
        imageUrl: actualResult.imageUrl,
        filename: actualResult.filename
      };
    }

    // For video generation, return the essential fields
    if (toolName === 'generate_video') {
      // Handle case where result is wrapped in {content: "JSON string", raw: {...}}
      let actualResult = result;
      if (result.content && typeof result.content === 'string') {
        try {
          actualResult = JSON.parse(result.content);
        } catch (e) {
          console.error(`AgentMode: Failed to parse generate_video result.content as JSON:`, e);
        }
      }
      return {
        success: actualResult.success,
        message: actualResult.message,
        videoUrl: actualResult.videoUrl,
        filename: actualResult.filename
      };
    }

    if (toolName === 'describe_video') {
      // Handle case where result is wrapped in {content: "JSON string", raw: {...}}
      let actualResult = result;
      if (result.content && typeof result.content === 'string') {
        try {
          actualResult = JSON.parse(result.content);
        } catch (e) {
          console.error(`AgentMode: Failed to parse describe_video result.content as JSON:`, e);
        }
      }
      return {
        success: actualResult.success,
        description: actualResult.description,
        videoUrl: actualResult.videoUrl
      };
    }

    // For HTML file updates, return the essential fields
    if (toolName === 'update_html_file') {
      // Handle case where result is wrapped in {content: "JSON string", raw: {...}}
      let actualResult = result;
      if (result.content && typeof result.content === 'string') {
        try {
          actualResult = JSON.parse(result.content);
        } catch (e) {
          console.error(`AgentMode: Failed to parse update_html_file result.content as JSON:`, e);
        }
      }

      const extracted: any = {
        success: actualResult.success,
        message: actualResult.message,
        s3_url: actualResult.s3_url,
        versioned_filename: actualResult.versioned_filename
      };
      // If the operation failed, include error details
      if (!actualResult.success && actualResult.error) {
        extracted.error = actualResult.error;
      }
      if (actualResult.suggestion) {
        extracted.suggestion = actualResult.suggestion;
      }
      return extracted;
    }

    // For other tools, return empty object to minimize storage
    return {};
  }

  private getMockToolResult(toolName: string, args: any): any {
    // Return realistic mock data for different tool types
    switch (toolName) {
      case 'list_task_templates':
        return {
          success: true,
          message: 'Found 2 template(s)',
          templates_by_category: {
            'SEO': [
              { template_id: 'mock-template-1', name: 'SEO Analysis', description: 'Analyze website SEO', category: 'SEO', parameters: ['site_url'] }
            ],
            'Research': [
              { template_id: 'mock-template-2', name: 'Competitor Research', description: 'Research competitors', category: 'Research', parameters: ['competitor_url'] }
            ]
          },
          totalTemplates: 2
        };

      case 'create_task_from_template':
        return {
          success: true,
          taskId: `mock-task-${Date.now()}`,
          executionId: `mock-execution-${Date.now()}`,
          message: `Mock task created from template ${args.template_id}`,
          status: 'pending'
        };

      case 'create_task_from_prompt':
        return {
          success: true,
          taskId: `mock-task-${Date.now()}`,
          executionId: `mock-execution-${Date.now()}`,
          message: `Mock task created: ${args.task_name}`,
          status: 'pending'
        };

      case 'create_image_task_from_prompt':
        return {
          success: true,
          taskId: `mock-image-task-${Date.now()}`,
          executionId: `mock-execution-${Date.now()}`,
          message: `Mock image task created: ${args.task_name}`,
          status: 'pending'
        };

      case 'generate_image':
        return {
          success: true,
          message: `Mock image "${args.filename}" generated successfully!`,
          imageUrl: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`,
          filename: args.filename
        };

      case 'generate_video':
        return {
          success: true,
          message: `Mock video "${args.filename}" generated successfully!`,
          videoUrl: `https://mock-s3-bucket.s3.amazonaws.com/mock-video-${Date.now()}.mp4`,
          filename: args.filename
        };

      case 'remove_c2pa_from_image':
        return {
          success: true,
          message: `✅ C2PA metadata removed successfully! Image uploaded to S3.`,
          imageUrl: `https://mock-s3-bucket.s3.amazonaws.com/${args.filename || `image_no_c2pa_${Date.now()}.png`}`,
          filename: args.filename || `image_no_c2pa_${Date.now()}.png`,
          originalUrl: args.image_url
        };

      case 'list_meta_ads_campaigns':
        return {
          success: true,
          message: 'Found 3 campaign(s)',
          campaigns: [
            {
              id: '120208234567890123',
              name: 'Holiday Campaign 2023',
              status: 'ACTIVE',
              objective: 'OUTCOME_LEADS'
            },
            {
              id: '120208234567890124',
              name: 'Brand Awareness Campaign',
              status: 'ACTIVE',
              objective: 'OUTCOME_AWARENESS'
            },
            {
              id: '120208234567890125',
              name: 'Retargeting Campaign',
              status: 'PAUSED',
              objective: 'OUTCOME_SALES'
            }
          ],
          totalCount: 3
        };

      case 'get_meta_ads_metrics':
        const normalizedCampaignIds = Array.isArray(args.campaign_ids)
          ? args.campaign_ids
          : (typeof args.campaign_ids === 'string' && args.campaign_ids.trim())
            ? [args.campaign_ids.trim()]
            : (typeof args.campaign_id === 'string' && args.campaign_id.trim())
              ? [args.campaign_id.trim()]
              : [];

        if (normalizedCampaignIds.length === 0) {
          return {
            success: false,
            message: 'campaign_ids is required and must contain at least one campaign ID.',
            error: 'Invalid campaign_ids'
          };
        }

        // Calculate attribution window based on timeframe
        const timeframe = args.timeframe || '7d';
        const now = new Date();
        const endDate = new Date(now);
        let startDate = new Date(now);
        let days = 7;

        // Parse timeframe - only valid values are 7d, 14d, 30d, 90d
        switch (timeframe) {
          case '7d':
            days = 7;
            startDate.setDate(now.getDate() - 7);
            break;
          case '14d':
            days = 14;
            startDate.setDate(now.getDate() - 14);
            break;
          case '30d':
            days = 30;
            startDate.setDate(now.getDate() - 30);
            break;
          case '90d':
            days = 90;
            startDate.setDate(now.getDate() - 90);
            break;
          default:
            // Fallback to 7d if invalid timeframe provided
            days = 7;
            startDate.setDate(now.getDate() - 7);
            break;
        }

        // Format dates as YYYY-MM-DD
        const formatDate = (date: Date) => date.toISOString().split('T')[0];

        return {
          success: true,
          timeframe: args.timeframe || '7d',
          attributionWindow: {
            start: formatDate(startDate),
            end: formatDate(endDate),
            days: days
          },
          campaignSummary: {
            totalCampaigns: 3,
            totalSpend: 1250.75,
            totalImpressions: 125000,
            totalClicks: 4500,
            averageCtr: 3.6,
            averageCpc: 0.28,
            totalWebsiteLeads: 23,
            averageCostPerWebsiteLead: 54.38
          },
          formattedContent: `📊 **Meta Ads Performance Data**\n\n**Attribution Window:** ${formatDate(startDate)} to ${formatDate(endDate)} (${days} days)\n\n**📈 Campaign Summary**\n- Total Campaigns: 3\n- Total Spend: $1250.75\n- Impressions: 125,000\n- Clicks: 4,500\n- CTR: 3.60%\n- CPC: $0.28\n- Website Leads: 23\n\n**📥 Detailed Data Files**\n1. **Ad-Level Data**\n   📥 [Download CSV](https://s3.amazonaws.com/mock-bucket/mock-file.csv)\n2. **Demographics Breakdown**\n   📥 [Download CSV](https://s3.amazonaws.com/mock-bucket/mock-file.csv)\n3. **Placement Breakdown**\n   📥 [Download CSV](https://s3.amazonaws.com/mock-bucket/mock-file.csv)\n4. **Device Breakdown**\n   📥 [Download CSV](https://s3.amazonaws.com/mock-bucket/mock-file.csv)\n`
        };

      case 'search_web':
        return {
          success: true,
          results: [
            {
              title: `Mock search result for "${args.query}"`,
              url: 'https://example.com/mock-result-1',
              snippet: 'This is a mock search result snippet that would contain relevant information.'
            },
            {
              title: `Another mock result for "${args.query}"`,
              url: 'https://example.com/mock-result-2',
              snippet: 'Another mock search result with different information.'
            }
          ]
        };

      case 'search_knowledge_base':
        return {
          success: true,
          message: `Found 2 mock knowledge base results for "${args.query}"`,
          query: args.query,
          results: [
            {
              content: `This is a mock knowledge base result for "${args.query}". It contains information that was previously stored from a task execution.`,
              source: 'public-knowledge-base'
            },
            {
              content: `Another mock knowledge base result for "${args.query}". This information comes from a private knowledge base entry.`,
              source: 'private-knowledge-base'
            }
          ],
          totalResults: 2
        };

      case 'list_knowledge_base_files':
        return {
          success: true,
          message: 'Found 1 mock knowledge base with files',
          knowledge_bases: [
            {
              identifier: 'mock-task-1',
              name: 'Mock Knowledge Base',
              type: 'private',
              updatedAt: new Date().toISOString(),
              files: [
                { fileName: 'knowledge-base.txt', fileSize: 1024, url: 'https://example.com/knowledge-base.txt' },
                { fileName: 'uploaded-guide.pdf', fileSize: 2048, url: 'https://example.com/uploaded-guide.pdf' }
              ]
            }
          ],
          totalKnowledgeBases: 1,
          totalFiles: 2
        };

      case 'list_gtm_plans':
        return {
          success: true,
          message: 'Found 2 mock GTM plan(s)',
          plans: [
            {
              planId: 'mock-plan-1',
              title: 'Mock Q1 2024 Launch Plan',
              description: 'Mock GTM plan for testing',
              phaseCount: 3,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              planId: 'mock-plan-2',
              title: 'Mock Product Launch Plan',
              description: 'Another mock GTM plan',
              phaseCount: 2,
              createdAt: new Date(Date.now() - 86400000).toISOString(),
              updatedAt: new Date(Date.now() - 86400000).toISOString()
            }
          ],
          totalPlans: 2
        };

      case 'read_knowledge_base_files':
        return {
          success: true,
          message: 'Successfully read knowledge base files',
          files: (args.files || []).map((f: any, idx: number) => ({
            kb_identifier: f.kb_identifier || `mock-task-${idx + 1}`,
            file_name: f.file_name || 'knowledge-base.txt',
            size: 1024,
            type: 'private',
            updatedAt: new Date().toISOString(),
            content: `This is mock content for knowledge base "${f.kb_identifier}" and file "${f.file_name}".`
          }))
        };
      case 'read_gtm_plan':
        return {
          success: true,
          message: `Successfully read GTM plan "Mock Q1 2024 Launch Plan"`,
          exists: true,
          plan: {
            planId: args.plan_id || 'mock-plan-1',
            title: 'Mock Q1 2024 Launch Plan',
            description: 'Mock GTM plan for testing',
            phases: [
              {
                id: 'phase-1',
                title: 'Pre-Launch',
                description: 'Pre-launch activities',
                duration: 30,
                status: 'in_progress',
                workItems: [
                  {
                    id: 'item-1',
                    title: 'Create landing page',
                    description: 'Design and develop landing page',
                    duration: 5,
                    status: 'completed',
                    completedAt: new Date(Date.now() - 86400000).toISOString()
                  }
                ]
              }
            ],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          formattedContent: `GTM Plan: Mock Q1 2024 Launch Plan\nDescription: Mock GTM plan for testing\nCreated: ${new Date().toISOString()}\n\nPhases (1):\n\nPhase 1: Pre-Launch\n  Description: Pre-launch activities\n  Duration: 30 day(s)\n  Status: in_progress\n  Work Items (1):\n    1. Create landing page [completed] - 5 day(s) - Completed: ${new Date(Date.now() - 86400000).toISOString()}\n       Design and develop landing page\n\n`
        };
      case 'get_lead_lists':
        return {
          success: true,
          message: 'Found 2 mock lead list(s)',
          lists: [
            {
              listId: 'mock-list-1',
              name: 'Mock Sales Leads',
              description: 'Mock description',
              leadCount: 10,
              createdAt: new Date().toISOString()
            },
            {
              listId: 'mock-list-2',
              name: 'Mock Marketing Leads',
              description: 'Mock description',
              leadCount: 5,
              createdAt: new Date().toISOString()
            }
          ],
          totalLists: 2
        };
      case 'create_lead_list':
        return {
          success: true,
          message: `Mock lead list "${args.name}" created successfully`,
          list: {
            listId: `mock-list-${Date.now()}`,
            name: args.name,
            description: args.description || '',
            leadCount: 0,
            createdAt: new Date().toISOString()
          }
        };
      case 'add_leads_to_list':
        const mockNewCount = Math.floor((args.leads?.length || 0) * 0.7);
        const mockMergedCount = (args.leads?.length || 0) - mockNewCount;
        return {
          success: true,
          message: `Successfully processed: ${mockNewCount} new lead(s) created, ${mockMergedCount} lead(s) merged.`,
          successCount: args.leads?.length || 0,
          newCount: mockNewCount,
          mergedCount: mockMergedCount,
          errorCount: 0,
          errors: []
        };
      case 'create_gtm_plan':
        const mockPhases = args.phases || [
          {
            id: 'mock-phase-1',
            title: 'Pre-Launch',
            description: 'Pre-launch activities',
            duration: 30,
            status: 'in_progress',
            workItems: [
              {
                id: 'mock-item-1',
                title: 'Create landing page',
                description: 'Design and develop landing page',
                duration: 5,
                status: 'pending'
              }
            ]
          }
        ];
        return {
          success: true,
          message: `GTM plan "${args.title || 'Mock Plan'}" created successfully with ${mockPhases.length} phase(s)`,
          plan: {
            planId: `mock-plan-${Date.now()}`,
            title: args.title || 'Mock Plan',
            description: args.description || '',
            phaseCount: mockPhases.length,
            phases: mockPhases,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        };
      case 'list_books':
        return {
          success: true,
          message: 'Found 2 book(s)',
          books: [
            {
              book_id: 'mock-book-1',
              title: 'Mock Marketing Guide',
              description: 'A comprehensive guide to marketing strategies',
              type: 'book',
              author: 'John Doe',
              status: 'published',
              published_at: new Date(Date.now() - 86400000).toISOString(),
              created_at: new Date(Date.now() - 172800000).toISOString(),
              updated_at: new Date(Date.now() - 86400000).toISOString(),
              tags: ['marketing', 'strategy'],
              has_sections: true
            },
            {
              book_id: 'mock-book-2',
              title: 'Mock White Paper: AI Trends',
              description: 'An analysis of current AI trends in business',
              type: 'whitepaper',
              author: 'Jane Smith',
              status: 'draft',
              published_at: null,
              created_at: new Date(Date.now() - 86400000).toISOString(),
              updated_at: new Date(Date.now() - 3600000).toISOString(),
              tags: ['AI', 'technology'],
              has_sections: false
            }
          ],
          totalBooks: 2
        };
      case 'get_book_details':
        return {
          success: true,
          message: 'Book details retrieved successfully',
          book: {
            book_id: args.book_id || 'mock-book-1',
            title: 'Mock Marketing Guide',
            description: 'A comprehensive guide to marketing strategies',
            type: 'book',
            author: 'John Doe',
            language: 'English',
            genre: 'Business',
            status: 'published',
            published_at: new Date(Date.now() - 86400000).toISOString(),
            created_at: new Date(Date.now() - 172800000).toISOString(),
            updated_at: new Date(Date.now() - 86400000).toISOString(),
            tags: ['marketing', 'strategy'],
            cover_image_url: null,
            characters: [
              {
                name: 'John Smith',
                description: 'A marketing expert with 20 years of experience'
              },
              {
                name: 'Sarah Johnson',
                description: 'A young entrepreneur starting her first business'
              }
            ],
            outline: [
              {
                section_id: 'mock-section-1',
                title: 'Introduction',
                description: 'Introduction to marketing',
                order: 1,
                has_content: true,
                chapters: [
                  {
                    chapter_id: 'mock-chapter-1',
                    title: 'What is Marketing?',
                    description: 'Basic concepts',
                    order: 1,
                    has_content: true
                  }
                ]
              }
            ]
          }
        };
      case 'get_book_content':
        const mockContent = args.chapter_id
          ? `# ${args.chapter_id ? 'Chapter' : 'Section'} Content\n\nThis is mock ${args.chapter_id ? 'chapter' : 'section'} content for testing purposes.\n\nIt contains markdown formatted text that can be used to demonstrate the content retrieval functionality.`
          : `# Section Content\n\nThis is mock section content for section ${args.section_id}.\n\n## Overview\n\nThis section provides an overview of the topic.\n\n## Key Points\n\n- Point 1\n- Point 2\n- Point 3`;
        const mockContentHash = createHash('sha256').update(mockContent).digest('hex');
        return {
          success: true,
          message: args.chapter_id ? 'Chapter content retrieved successfully' : 'Section content retrieved successfully',
          content: mockContent,
          content_hash: mockContentHash,
          content_type: args.chapter_id ? 'chapter' : 'section',
          section_id: args.section_id || 'mock-section-1',
          chapter_id: args.chapter_id || null,
          has_content: true
        };

      case 'update_book_content':
        // Mock validation for update_book_content (always partial replacement)
        let mockBookReplacementInstructions = [];
        try {
          if (args.replacement_json) {
            mockBookReplacementInstructions = JSON.parse(args.replacement_json);
          }
        } catch (error) {
          return {
            success: false,
            message: 'Invalid JSON in replacement_json',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }

        if (mockBookReplacementInstructions.length === 0) {
          return {
            success: false,
            message: 'At least one replacement instruction is required'
          };
        }

        // Validate mock instructions (always partial replacement)
        for (let i = 0; i < mockBookReplacementInstructions.length; i++) {
          const instruction = mockBookReplacementInstructions[i];
          if (instruction.new_content === undefined || instruction.expected_count === undefined) {
            return {
              success: false,
              message: `Missing required fields in replacement instruction ${i + 1}: new_content and expected_count are required`
            };
          }

          if (!instruction.old_content) {
            return {
              success: false,
              message: `Replacement instruction ${i + 1} missing old_content. old_content is required for partial replacements`
            };
          }
        }

        return {
          success: true,
          message: `Content updated successfully with ${mockBookReplacementInstructions.length} replacement(s)`,
          content_type: args.chapter_id ? 'chapter' : 'section',
          section_id: args.section_id || 'mock-section-1',
          chapter_id: args.chapter_id || null,
          replacements: mockBookReplacementInstructions.map((inst: any, idx: number) => ({
            index: idx + 1,
            old_content: inst.old_content,
            new_content: inst.new_content,
            expected_count: inst.expected_count,
            actual_count: inst.expected_count,
            success: true
          })),
          updated_content_length: 1000
        };

      case 'generate_book_content':
        const mockLength = args.length || 'medium';
        const mockWordCounts: Record<string, number> = {
          short: 1500,
          medium: 2500,
          long: 3500
        };
        return {
          success: true,
          message: `${args.chapter_id ? 'Chapter' : 'Section'} content generated successfully (mock)`,
          content_type: args.chapter_id ? 'chapter' : 'section',
          section_id: args.section_id || 'mock-section-1',
          chapter_id: args.chapter_id || null,
          content_length: mockWordCounts[mockLength] * 5, // Approximate chars
          word_count: mockWordCounts[mockLength],
          target_word_range: mockLength === 'short' ? '1000-2000' : mockLength === 'medium' ? '2000-3000' : '3000-4000',
          content_preview: `# Generated Content\n\nThis is mock generated content for ${args.content_description || 'the specified section/chapter'}. The content would be ${mockLength} length (${mockWordCounts[mockLength]} words)...`
        };

      case 'create_book':
        return {
          success: true,
          message: 'Book created successfully',
          book: {
            book_id: 'mock-book-new',
            title: args.title || 'Mock Book',
            description: args.description || 'Mock description',
            type: args.type || 'book',
            author: args.author || 'Mock Author',
            language: args.language || 'English',
            genre: args.type === 'book' ? (args.genre || 'Other') : undefined,
            tags: args.tags || [],
            status: 'draft',
            sections: []
          }
        };

      case 'create_book_outline':
        let mockOutline = [];
        try {
          if (args.outline_json) {
            mockOutline = JSON.parse(args.outline_json);
          }
        } catch (error) {
          return {
            success: false,
            message: 'Invalid JSON in outline_json',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
        const totalChapters = mockOutline.reduce((sum: number, section: any) =>
          sum + (section.chapters?.length || 0), 0
        );
        return {
          success: true,
          message: `Outline created successfully with ${mockOutline.length} section(s) and ${totalChapters} chapter(s)`,
          book_id: args.book_id || 'mock-book-1',
          sections_count: mockOutline.length,
          total_chapters: totalChapters
        };
      case 'add_characters':
        let mockCharacters = [];
        try {
          if (args.characters_json) {
            mockCharacters = JSON.parse(args.characters_json);
          }
        } catch (error) {
          return {
            success: false,
            message: 'Invalid JSON in characters_json',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
        return {
          success: true,
          message: `Added ${mockCharacters.length} character(s) to book`,
          book_id: args.book_id || 'mock-book-1',
          characters_added: mockCharacters.length,
          characters: mockCharacters
        };

      case 'read_brand_guidelines':
        return {
          success: true,
          exists: true,
          brandData: {
            brandName: 'Mock Brand',
            tagline: 'Mock tagline for testing',
            primaryColor: '#FF6B6B',
            toneOfVoice: 'Professional and friendly'
          },
          brandAssets: []
        };

      case 'update_brand_guidelines':
        return {
          success: true,
          message: 'Mock brand guidelines updated successfully'
        };

      case 'read_market_strategy':
        return {
          success: true,
          exists: true,
          businessOverview: 'Mock business overview for testing purposes',
          competitors: [
            { name: 'Mock Competitor 1', description: 'A mock competitor description' }
          ],
          icp: [
            { title: 'Mock ICP', description: 'Mock ideal customer profile', valueProposition: 'Mock value prop', buyerPersonas: ['Mock persona 1', 'Mock persona 2'] }
          ]
        };

      case 'update_market_strategy':
        return {
          success: true,
          message: 'Mock market strategy updated successfully'
        };

      case 'create_revision':
        return {
          success: true,
          message: 'Mock revision created successfully',
          taskId: `mock-task-${Date.now()}`,
          executionId: `mock-execution-${Date.now()}`,
          status: 'pending',
          assetType: 'report',
          targetFile: 'mock-report.html'
        };

      case 'create_social_media_posts':
        return {
          success: true,
          message: `Successfully created ${args.posts?.length || 0} social media post(s)`,
          htmlUrl: `https://agentweb-files.s3.us-east-1.amazonaws.com/mock-social-media-posts-${Date.now()}.html`,
          postsCount: args.posts?.length || 0
        };

      case 'perform_deep_research':
        const mockMarkdownContent = `# ${args.topic}\n\n## Executive Summary\n\nThis is a comprehensive research report on "${args.topic}".`;
        const mockS3Url = `https://agentweb-files.s3.us-east-1.amazonaws.com/files/${Date.now()}-research-${args.topic.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}.md`;
        return {
          success: true,
          message: `Deep research completed successfully. Generated ${mockMarkdownContent.split(/\s+/).length} words of content.`,
          data: {
            research_url: mockS3Url,
            title: args.topic,
            summary: `Comprehensive research on "${args.topic}" covering market analysis, implementation strategies, and key recommendations.`,
            key_findings: [
              `Important insight about ${args.topic}`,
              'Market trends and analysis',
              'Implementation considerations',
              'ROI and business impact',
              'Future outlook and recommendations'
            ],
            word_count: mockMarkdownContent.split(/\s+/).length,
            research_depth: args.depth || 'detailed',
            topic: args.topic
          }
        };

      case 'save_file':
        return {
          success: true,
          message: `File "${args.file_name}" has been saved successfully.`,
          file_url: `https://agentweb-files.s3.us-east-1.amazonaws.com/files/${Date.now()}-${args.file_name}`,
          file_name: args.file_name,
          file_size: args.file_content.length
        };

      case 'read_file_content':
        return {
          success: true,
          content: `Mock file content for ${args.file_url}. This would be the actual content of the file in a real scenario.`,
          filename: 'mock-file.txt'
        };

      case 'read_page_source':
        return {
          success: true,
          content: `Mock page source for ${args.url}. This would be the actual HTML source of the webpage in a real scenario.`,
          file_type: 'html',
          file_url: args.url
        };

      case 'describe_image':
        return {
          success: true,
          description: `Mock image analysis for ${args.image_url}${args.prompt ? ` with custom prompt: "${args.prompt}"` : ''}. This would contain detailed visual analysis including colors, composition, text content, and marketing elements in a real scenario.`,
          imageUrl: args.image_url
        };

      case 'describe_video':
        return {
          success: true,
          description: `Mock video analysis for ${args.video_file_url}${args.prompt ? ` with custom prompt: "${args.prompt}"` : ''}. This would contain a detailed summary of the video content in a real scenario.`,
          videoUrl: args.video_file_url
        };

      case 'perform_data_analysis':
        return {
          success: true,
          message: 'Mock data analysis completed successfully',
          analysis: `**Analysis:** Mock analysis results for ${args.file_urls?.length || 0} file(s).\n\nAnalysis task: ${args.analysis_instruction}\n\n**Code Executed:**\n\`\`\`python\n# Mock analysis code\nimport pandas as pd\nimport numpy as np\n\n# Analyze the data\nprint("Data analysis completed")\n\`\`\`\n\n**Code Output:**\n\`\`\`\nData analysis completed\nMock results would appear here in a real scenario.\n\`\`\``,
          codeExecuted: true
        };

      case 'list_html_templates':
        return {
          success: true,
          email_templates: [
            {
              template_name: 'welcome_email',
              subject: 'Welcome to {{company_name}}!',
              variables: ['company_name', 'user_name'],
              arrayVariables: ['features_n'],
              created_at: '2024-01-15T10:00:00Z',
              updated_at: '2024-01-15T10:00:00Z'
            },
            {
              template_name: 'newsletter',
              subject: 'Weekly Update: {{news_title}}',
              variables: ['news_title', 'company_name'],
              arrayVariables: ['news_n_category', 'links_n'],
              created_at: '2024-01-20T14:30:00Z',
              updated_at: '2024-01-20T14:30:00Z'
            }
          ]
        };

      case 'create_html_from_template':
        // Mock validation - check if required variables are provided
        const mockTemplate = {
          variables: ['title', 'company_name'],
          arrayVariables: ['features_n']
        };

        // Parse JSON strings for mock validation
        let mockVariableValues = {};
        let mockArrayVariableValues = {};

        try {
          if (args.variable_values_json) {
            mockVariableValues = JSON.parse(args.variable_values_json);
          }
        } catch (error) {
          return {
            success: false,
            message: 'Invalid JSON in variable_values_json',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }

        try {
          if (args.array_variable_values_json) {
            mockArrayVariableValues = JSON.parse(args.array_variable_values_json);
          }
        } catch (error) {
          return {
            success: false,
            message: 'Invalid JSON in array_variable_values_json',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }

        const missingVars = mockTemplate.variables.filter(v => !(v in mockVariableValues));
        const missingArrayVars = mockTemplate.arrayVariables.filter(v => !(v in mockArrayVariableValues));

        if (missingVars.length > 0 || missingArrayVars.length > 0) {
          return {
            success: false,
            message: 'Variable validation failed',
            errors: [
              ...(missingVars.length > 0 ? [`Missing required variables: ${missingVars.join(', ')}`] : []),
              ...(missingArrayVars.length > 0 ? [`Missing required array variables: ${missingArrayVars.join(', ')}`] : [])
            ],
            template_variables: mockTemplate.variables,
            template_array_variables: mockTemplate.arrayVariables
          };
        }

        return {
          success: true,
          s3_url: `https://mock-s3-bucket.s3.amazonaws.com/html_${args.template_name}_${Date.now()}.html`,
          subject: `Mock subject with variables substituted for ${args.template_name}`,
          template_name: args.template_name,
          filename: `html_${args.template_name}_${Date.now()}.html`,
          message: 'Mock HTML generated using LLM variable substitution'
        };

      case 'update_html_file':
        // Mock validation for update_html_file
        try {
          const instructions = JSON.parse(args.replacement_json);

          // Validate that it's an array
          if (!Array.isArray(instructions)) {
            return {
              success: false,
              message: 'replacement_json must be an array of replacement instructions'
            };
          }

          if (instructions.length === 0) {
            return {
              success: false,
              message: 'At least one replacement instruction is required'
            };
          }

          // Validate each instruction based on update_type
          for (let i = 0; i < instructions.length; i++) {
            const instruction = instructions[i];

            if (!instruction.new_content || instruction.expected_count === undefined) {
              return {
                success: false,
                message: `Missing required fields in replacement instruction ${i + 1}: new_content and expected_count are required`
              };
            }

            if (args.update_type === 'full') {
              // For full replacement, require old_content_hash
              if (!instruction.old_content_hash) {
                return {
                  success: false,
                  message: `Replacement instruction ${i + 1} missing old_content_hash. For update_type="full", old_content_hash is required`
                };
              }
              if (instruction.old_content !== undefined) {
                return {
                  success: false,
                  message: `Replacement instruction ${i + 1} should not have old_content when update_type="full". Use old_content_hash instead`
                };
              }
            } else if (args.update_type === 'part') {
              // For part replacement, require old_content
              if (!instruction.old_content) {
                return {
                  success: false,
                  message: `Replacement instruction ${i + 1} missing old_content. For update_type="part", old_content is required`
                };
              }
              if (instruction.old_content_hash !== undefined) {
                return {
                  success: false,
                  message: `Replacement instruction ${i + 1} should not have old_content_hash when update_type="part". Use old_content instead`
                };
              }
            }
          }

          // Mock successful replacement
          const replacementResults = instructions.map((instruction, index) => {
            const result: any = {
              index: index + 1,
              new_content: instruction.new_content,
              expected_count: instruction.expected_count,
              actual_count: instruction.expected_count, // Mock: assume count matches
              success: true
            };

            if (args.update_type === 'full') {
              result.old_content_hash = instruction.old_content_hash;
            } else {
              result.old_content = instruction.old_content;
            }

            return result;
          });

          // Mock versioned filename
          const mockVersionedFilename = `updated_file_v2.html`;

          return {
            success: true,
            s3_url: `https://mock-s3-bucket.s3.amazonaws.com/${mockVersionedFilename}`,
            message: `File updated successfully with ${replacementResults.length} replacements`,
            method: 'mixed_replacement',
            replacements: replacementResults,
            versioned_filename: mockVersionedFilename
          };
        } catch (error) {
          return {
            success: false,
            message: 'Invalid JSON in replacement_json',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }

      case 'create_html_file':
        // Mock validation
        if (!args.title) {
          return {
            success: false,
            message: 'title is required'
          };
        }
        if (!args.content_draft) {
          return {
            success: false,
            message: 'content_draft is required'
          };
        }
        return {
          success: true,
          s3_url: `https://mock-s3-bucket.s3.amazonaws.com/html_${Date.now()}_${args.title.replace(/[^a-z0-9]/gi, '_').substring(0, 50)}.html`,
          filename: `html_${Date.now()}_${args.title.replace(/[^a-z0-9]/gi, '_').substring(0, 50)}.html`,
          title: args.title,
          message: 'Mock HTML file created successfully'
        };

      default:
        return {
          success: true,
          message: `Mock result for unknown tool: ${toolName}`,
          data: args
        };
    }
  }

  public async executeTool(llmModel: string, toolName: string, args: any, userId: string, sessionId: string, mockMode: boolean = false): Promise<any> {
    // In mock mode, only session-state tools (install_skills) execute for real
    // because they modify DynamoDB session state with no external side effects
    // and are required for the skill-gated tool flow to work during benchmark tests.
    if (mockMode && !AgentModeService.MOCK_BYPASS_TOOLS.has(toolName)) {
      return this.getMockToolResult(toolName, args);
    }

    try {
      return await this.toolRegistry.execute(toolName, args, {
        userId,
        sessionId,
        llmModel,
        service: this,
      });

      // // If result is already MCP-wrapped (from external MCP tools via mcpClientService),
      // // pass it through unchanged. External tools return { content: string, raw: { content: [...] } }
      // if (result && typeof result.content === 'string' && result.raw) {
      //   return result;
      // }

      // // Simulate MCP wrapping for internal tools to maintain consistent
      // // response format with external MCP tools
      // const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      // return {
      //   content: resultStr,
      //   raw: {
      //     content: [{ type: 'text', text: resultStr }]
      //   }
      // };
    } catch (error) {
      console.error(`AgentMode: Error executing tool ${toolName}:`, error);
      throw error;
    }
  }

  public async describeImage(llmModel: string, imageUrl: string, prompt?: string): Promise<any> {
    try {
      if (!imageUrl) {
        return {
          success: false,
          message: 'No image URL provided'
        };
      }
      if (!llmModel) {
        llmModel = await this.getDefaultModel();
      }
      // Use custom prompt or default
      const analysisPrompt = prompt || 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.';

      // Create messages for vision API
      const messages = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: analysisPrompt
            },
            {
              type: 'image_url' as const,
              image_url: { url: imageUrl }
            }
          ]
        }
      ];

      // Call OpenAI Vision API using the same model as agent mode
      const response = await this.callLLM(llmModel, messages, {
        max_completion_tokens: 2000
      });

      const description = response.choices[0]?.message?.content || 'Unable to analyze image';

      return {
        success: true,
        description: description,
        imageUrl: imageUrl
      };

    } catch (error) {
      console.error('AgentMode: Error describing image:', error);
      return {
        success: false,
        message: 'Failed to analyze image. Please check that the URL is accessible and contains a valid image.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async describeVideo(videoFileUrl: string, prompt?: string): Promise<any> {
    let tempDirPath: string | null = null;
    let uploadedFileName: string | null = null;
    let aiClient: any = null;

    try {
      if (!videoFileUrl) {
        return {
          success: false,
          message: 'No video URL provided'
        };
      }

      const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
      const geminiSecretName = `${environment}/AgentWeb/GeminiAPIKey`;
      const geminiApiKey = await getSecret(geminiSecretName);

      if (!geminiApiKey || !geminiApiKey.trim()) {
        return {
          success: false,
          message: 'Gemini API key is empty'
        };
      }

      const { GoogleGenAI } = await import('@google/genai');
      aiClient = new GoogleGenAI({ apiKey: geminiApiKey.trim() });

      const modelName = 'gemini-3-flash-preview';
      const analysisPrompt = prompt || 'Please describe this video in detail. Focus on key events, visual elements, and any spoken content.';
      const url = new URL(videoFileUrl);
      const hostname = (url.hostname || '').toLowerCase();
      const isYoutube = hostname.includes('youtube.com') || hostname.includes('youtu.be');

      let contents: any;

      if (isYoutube) {
        contents = [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri: videoFileUrl
                }
              },
              { text: analysisPrompt }
            ]
          }
        ];
      } else {
        const maxSizeMb = parseInt(process.env.MAX_DOWNLOADED_VIDEO_SIZE_MB || '100', 10);
        const maxSizeBytes = maxSizeMb * 1024 * 1024;

        const response = await axios.get(videoFileUrl, { responseType: 'stream' });
        const responseStream = response.data as Readable;
        const contentLengthHeader = response.headers['content-length'];
        const declaredSize = contentLengthHeader ? parseInt(contentLengthHeader.toString(), 10) : 0;
        if (declaredSize && declaredSize > maxSizeBytes) {
          return {
            success: false,
            message: `Video file too large for analysis: ${Math.round(declaredSize / (1024 * 1024))} MB exceeds limit of ${maxSizeMb} MB`
          };
        }

        const contentTypeHeader = (response.headers['content-type'] || '').toString();
        const urlExtension = path.extname(url.pathname).toLowerCase();
        const mimeTypeMap: Record<string, string> = {
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.webm': 'video/webm',
          '.ogg': 'video/ogg',
          '.m4v': 'video/x-m4v',
          '.avi': 'video/x-msvideo'
        };
        const fallbackMimeType = mimeTypeMap[urlExtension] || 'video/mp4';
        const mimeType = contentTypeHeader.startsWith('video/') ? contentTypeHeader : fallbackMimeType;

        tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agentweb-video-'));
        const fileExtension = urlExtension || '.mp4';
        const tempFilePath = path.join(tempDirPath, `video${fileExtension}`);

        const writer = createWriteStream(tempFilePath);
        let downloadedBytes = 0;
        await new Promise<void>((resolve, reject) => {
          responseStream.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (downloadedBytes > maxSizeBytes) {
              responseStream.destroy(new Error('Video file too large'));
            }
          });
          responseStream.on('error', reject);
          writer.on('error', reject);
          writer.on('finish', resolve);
          responseStream.pipe(writer);
        });

        if (downloadedBytes === 0) {
          return {
            success: false,
            message: 'Downloaded video file is empty'
          };
        }

        if (downloadedBytes > maxSizeBytes) {
          return {
            success: false,
            message: `Video file too large for analysis: ${Math.round(downloadedBytes / (1024 * 1024))} MB exceeds limit of ${maxSizeMb} MB`
          };
        }

        const uploadResponse = await aiClient.files.upload({
          file: tempFilePath,
          config: { mimeType }
        });

        const fileUri = uploadResponse.uri || uploadResponse.file?.uri;
        const uploadedMime = uploadResponse.mimeType || uploadResponse.file?.mimeType || mimeType;
        uploadedFileName = uploadResponse.name || uploadResponse.file?.name || fileUri || null;

        if (!fileUri) {
          return {
            success: false,
            message: 'Failed to upload video to Gemini Files API'
          };
        }

        if (uploadedFileName) {
          await this.waitForGeminiFileActive(aiClient, uploadedFileName);
        }

        contents = [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri,
                  mimeType: uploadedMime
                }
              },
              { text: analysisPrompt }
            ]
          }
        ];
      }

      const response = await aiClient.models.generateContent({
        model: modelName,
        contents
      });

      const description = response.text;

      if (!description) {
        return {
          success: false,
          message: 'No description returned from Gemini'
        };
      }

      return {
        success: true,
        description,
        videoUrl: videoFileUrl
      };
    } catch (error) {
      console.error('AgentMode: Error describing video:', error);
      return {
        success: false,
        message: 'Failed to analyze video. Please check that the URL is accessible and contains a valid video.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      if (aiClient && uploadedFileName) {
        try {
          await aiClient.files.delete({ name: uploadedFileName });
        } catch (cleanupError) {
          try {
            await (aiClient.files as any).delete(uploadedFileName);
          } catch (fallbackError) {
            console.warn('AgentMode: Failed to delete uploaded Gemini file:', fallbackError);
          }
        }
      }

      if (tempDirPath) {
        try {
          await fs.rm(tempDirPath, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn('AgentMode: Failed to clean up temp video file:', cleanupError);
        }
      }
    }
  }

  public async waitForGeminiFileActive(aiClient: any, fileName: string): Promise<void> {
    const maxAttempts = 30;
    const delayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        let fileInfo: any;
        try {
          fileInfo = await aiClient.files.get({ name: fileName });
        } catch {
          fileInfo = await aiClient.files.get(fileName);
        }

        const state = fileInfo?.state || fileInfo?.file?.state;
        if (state === 'ACTIVE') {
          return;
        }

        if (state === 'FAILED') {
          throw new Error('Gemini file processing failed');
        }
      } catch (error) {
        if (attempt === maxAttempts) {
          throw error;
        }
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  public async performDataAnalysis(fileUrls: string[], analysisInstruction: string, userId: string): Promise<any> {
    try {
      const urlsToProcess = Array.isArray(fileUrls) ? fileUrls.filter(url => !!url) : [];

      if (!analysisInstruction) {
        return {
          success: false,
          message: 'Analysis instruction is required'
        };
      }

      // Get Gemini API key from Secrets Manager
      const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
      const geminiSecretName = environment === 'prod'
        ? 'prod/AgentWeb/GeminiAPIKey'
        : 'dev/AgentWeb/GeminiAPIKey';
      let geminiApiKey: string;
      try {
        geminiApiKey = await getSecret(geminiSecretName);
      } catch (error) {
        console.error('AgentMode: Failed to retrieve Gemini API key from Secrets Manager:', error);
        return {
          success: false,
          message: 'Failed to retrieve Gemini API key from Secrets Manager'
        };
      }

      geminiApiKey = geminiApiKey.trim();
      if (!geminiApiKey) {
        return {
          success: false,
          message: 'Gemini API key is empty'
        };
      }

      // Initialize Google Generative AI client
      const genAI = new GoogleGenerativeAI(geminiApiKey);

      // Get the model name from environment or use default
      const modelName = process.env.DATA_ANALYSIS_LLM_NAME || 'gemini-2.5-flash';

      // Get file size limit from environment or use default (50MB)
      const maxTotalSize = parseInt(process.env.DATA_ANALYSIS_FILE_SIZE || '52428800'); // 50MB in bytes

      // Prepare file data for analysis
      const fileParts: any[] = [];
      let totalSize = 0;

      for (const fileUrl of urlsToProcess) {
        try {
          // Download the file
          const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
          });

          // Check file size
          const fileData = response.data as ArrayBuffer;
          totalSize += fileData.byteLength;
          if (totalSize > maxTotalSize) {
            return {
              success: false,
              message: `Total file size (${totalSize} bytes) exceeds the ${maxTotalSize} bytes limit. Please reduce the number or size of files.`
            };
          }

          // Determine MIME type from URL or response headers
          const contentType = response.headers['content-type'];
          const url = fileUrl.toLowerCase();

          let mimeType = 'text/plain';
          if (contentType) {
            mimeType = contentType;
          } else if (url.includes('.csv')) {
            mimeType = 'text/csv';
          } else if (url.includes('.json')) {
            mimeType = 'application/json';
          } else if (url.includes('.jsonl')) {
            mimeType = 'application/jsonl';
          } else if (url.includes('.xml')) {
            mimeType = 'application/xml';
          } else if (url.includes('.yaml') || url.includes('.yml')) {
            mimeType = 'application/x-yaml';
          } else if (url.includes('.html') || url.includes('.htm')) {
            mimeType = 'text/html';
          } else if (url.includes('.md')) {
            mimeType = 'text/markdown';
          } else if (url.includes('.py')) {
            mimeType = 'text/x-python';
          } else if (url.includes('.js')) {
            mimeType = 'text/javascript';
          } else if (url.includes('.ts')) {
            mimeType = 'text/typescript';
          }

          // Upload file to Gemini
          const base64Content = Buffer.from(fileData).toString('base64');

          fileParts.push({
            inline_data: {
              data: base64Content,
              mime_type: mimeType
            }
          });

        } catch (error) {
          console.error(`Error processing file ${fileUrl}:`, error);
          return {
            success: false,
            message: `Failed to download or process file: ${fileUrl}`,
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      }

      // Prepare content parts
      const parts: any[] = [];

      // Add file parts
      fileParts.forEach(part => parts.push(part));

      // Add text part with analysis instruction so the model knows how to proceed with or without files
      parts.push({
        text: `Please perform the following analysis task. ${urlsToProcess.length > 0 ? 'Use the attached files as primary data sources and incorporate any structured data included in the instruction text.' : 'No external files are attached; treat the information in the instruction as the complete dataset for this task.'}\n\n${analysisInstruction}\n\nUse Python code execution to analyze the data and provide detailed insights. Do not ask questions as the user is not present.`
      });

      // Call Gemini API directly via REST to enable code execution
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const apiResponse = await axios.post(apiUrl,
        {
          tools: [{ code_execution: {} }],
          contents: [
            {
              parts: parts
            }
          ]
        },
        {
          headers: {
            'x-goog-api-key': geminiApiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      // Extract and format the response
      const candidates = (apiResponse.data as any).candidates;

      if (!candidates || candidates.length === 0) {
        return {
          success: false,
          message: 'No response received from Gemini API'
        };
      }

      const resultParts: string[] = [];
      let codeExecuted = false;

      // Extract parts from response
      const responseParts = candidates[0].content.parts || [];

      for (const part of responseParts) {
        if (part.text) {
          resultParts.push(`**Analysis:** ${part.text}`);
        }
        // Handle inline data (images/charts from code execution) (handle both camelCase and snake_case)
        if ((part as any).inlineData && (part as any).inlineData.data) {
          try {
            const imageData = (part as any).inlineData.data;
            const mimeType = (part as any).inlineData.mimeType || 'image/png';

            // Convert base64 string to Buffer for S3 upload
            const imageBuffer = Buffer.from(imageData, 'base64');

            // Upload image to S3
            const { uploadFileToS3 } = await import('../utils/s3Utils');
            const imageFilename = `analysis_chart_${Date.now()}.png`;
            const uploadResult = await uploadFileToS3(
              imageBuffer,
              imageFilename,
              userId,
              mimeType
            );

            if (uploadResult.success && uploadResult.url) {
              resultParts.push(`**Chart/Image Generated:**\n![Analysis Result](${uploadResult.url})`);
            }
          } catch (error) {
            console.error('Error uploading inline data to S3:', error);
            resultParts.push(`**Chart/Image Generated:** (Failed to upload to S3)`);
          }
        } else if ((part as any).inline_data && (part as any).inline_data.data) {
          // Handle snake_case format
          try {
            const imageData = (part as any).inline_data.data;
            const mimeType = (part as any).inline_data.mimeType || (part as any).inline_data.mime_type || 'image/png';

            // Convert base64 string to Buffer for S3 upload
            const imageBuffer = Buffer.from(imageData, 'base64');

            // Upload image to S3
            const { uploadFileToS3 } = await import('../utils/s3Utils');
            const imageFilename = `analysis_chart_${Date.now()}.png`;
            const uploadResult = await uploadFileToS3(
              imageBuffer,
              imageFilename,
              userId,
              mimeType
            );

            if (uploadResult.success && uploadResult.url) {
              resultParts.push(`**Chart/Image Generated:**\n![Analysis Result](${uploadResult.url})`);
            }
          } catch (error) {
            console.error('Error uploading inline_data (snake_case) to S3:', error);
            resultParts.push(`**Chart/Image Generated:** (Failed to upload to S3)`);
          }
        }
      }

      if (resultParts.length === 0) {
        return {
          success: false,
          message: 'No analysis results received from Gemini'
        };
      }

      // Combine all results
      const analysisResult = resultParts.join('\n\n');

      return {
        success: true,
        message: 'Data analysis completed successfully',
        analysis: analysisResult,
        codeExecuted: codeExecuted,
        formattedContent: analysisResult
      };

    } catch (error) {
      console.error('AgentMode: Error performing data analysis:', error);
      return {
        success: false,
        message: 'Failed to perform data analysis. Please check that the file URLs are accessible.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async getPreviousTaskResults(userId: string, sessionId: string): Promise<string> {
    try {
      // Get the current conversation to find previous task executions
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || !session.messages) {
        return '';
      }

      // Extract task IDs from previous tool calls in this conversation
      const taskIds = new Set<string>();
      session.messages.forEach((message: ChatMessage) => {
        if (message.metadata?.toolCalls) {
          message.metadata.toolCalls.forEach((toolCall: any) => {
            if (toolCall.name === 'create_task_from_template' || toolCall.name === 'create_task_from_prompt' || toolCall.name === 'create_image_task_from_prompt' || toolCall.name === 'create_revision') {
              if (toolCall.result?.taskId) {
                taskIds.add(toolCall.result.taskId);
              }
            }
          });
        }
      });

      if (taskIds.size === 0) {
        return '';
      }

      // Get executions for each specific task
      const completedExecutions: any[] = [];

      for (const taskId of taskIds) {
        const taskExecutions = await taskDb.getTaskExecutions(taskId);
        if (taskExecutions && taskExecutions.length > 0) {
          // Find the latest completed execution with HTML results
          const latestCompleted = taskExecutions
            .filter(execution =>
              execution.status === 'completed' &&
              execution.result_files &&
              execution.result_files.length > 0
            )
            .sort((a, b) => new Date(b.createdAt || b.startTime).getTime() - new Date(a.createdAt || a.startTime).getTime())[0];

          if (latestCompleted) {
            // Fetch task details to get the task name
            const task = await taskDb.getTaskById(taskId);
            if (task) {
              latestCompleted.taskName = task.name;
            }
            completedExecutions.push(latestCompleted);
          }
        }
      }

      if (completedExecutions.length === 0) {
        return '';
      }

      // Build context with HTML result URLs
      let context = '\n\n## Previous Task Results\n';
      context += 'The following are results from your previous completed tasks that you can reference:\n\n';

      completedExecutions.forEach(execution => {
        const htmlFiles = execution.result_files.filter((file: any) =>
          file.is_html || file.view_type === 'html' || file.filename.toLowerCase().endsWith('.html')
        );

        if (htmlFiles.length > 0) {
          context += `**Task ${execution.taskId}** (${execution.taskName || 'Unknown Task'}):\n`;
          htmlFiles.forEach((file: any) => {
            context += `- Result: ${file.url}\n`;
          });
          context += '\n';
        }
      });

      return context;
    } catch (error) {
      console.error('Error fetching previous task results:', error);
      return '';
    }
  }

  // Read current user's brand guidelines
  public async readBrandGuidelines(userId: string): Promise<any> {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          exists: false,
          error: 'User not found'
        };
      }

      const brand = user.brandGuidelines;
      if (!brand) {
        return {
          success: true,
          exists: false,
          message: 'No brand guidelines found',
          brandData: {},
          attachments: []
        };
      }

      // Format the brand guidelines for LLM consumption
      const formattedContent = this.formatBrandGuidelines({
        exists: true,
        brandData: brand.brandData || {},
        attachments: brand.attachments || []
      });

      // Return structured response similar to web_search
      return {
        success: true,
        message: `Brand guidelines retrieved successfully`,
        exists: true,
        brandData: brand.brandData || {},
        attachments: brand.attachments || [],
        createdAt: brand.createdAt,
        updatedAt: brand.updatedAt,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error reading brand guidelines:', error);
      return {
        success: false,
        message: 'Failed to read brand guidelines',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Get CRM sender emails configuration
  public async getCrmSenders(userId: string): Promise<{
    success: boolean;
    senders: Array<{ id: string; email: string; fromName: string; notes?: string }>;
    defaultSenderId: string | null;
    error?: string;
  }> {
    try {
      const { settingsService } = await import('./settingsService');
      const settingName = `crm_sender_emails_${userId}`;
      const setting = await settingsService.getSetting(settingName);

      if (!setting) {
        return {
          success: true,
          senders: [],
          defaultSenderId: null
        };
      }

      const config = JSON.parse(setting.settingValue);
      return {
        success: true,
        senders: config.senders || [],
        defaultSenderId: config.defaultSenderId || null
      };
    } catch (error) {
      console.error('AgentMode: Error getting CRM senders:', error);
      return {
        success: false,
        senders: [],
        defaultSenderId: null,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Get sender information for a lead (from lead record, list default, or account default sender)
  public async getSenderForLead(
    userId: string,
    leadSelectedSenderId?: string | null,
    listSenderId?: string | null
  ): Promise<{
    fromName: string;
    notes?: string;
  } | null> {
    try {
      const sendersResult = await this.getCrmSenders(userId);
      if (!sendersResult.success || sendersResult.senders.length === 0) {
        return null;
      }

      // Find the sender saved on the lead record, or list default, or account default, or use the first one
      let sender = null;
      if (leadSelectedSenderId) {
        sender = sendersResult.senders.find((s) => s.id === leadSelectedSenderId);
      }
      if (!sender && listSenderId) {
        sender = sendersResult.senders.find((s) => s.id === listSenderId);
      }
      if (!sender) {
        const defaultSenderId = sendersResult.defaultSenderId;
        sender = defaultSenderId
          ? sendersResult.senders.find((s) => s.id === defaultSenderId)
          : sendersResult.senders[0];
      }

      if (sender) {
        return {
          fromName: sender.fromName,
          notes: sender.notes
        };
      }

      return null;
    } catch (error) {
      console.error('AgentMode: Error getting sender for lead:', error);
      return null;
    }
  }

  // Read current user's market strategy
  public async readMarketStrategy(userId: string): Promise<any> {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          exists: false,
          error: 'User not found'
        };
      }

      const marketStrategy = user.marketStrategy;
      if (!marketStrategy) {
        return {
          success: true,
          exists: false,
          message: 'No market strategy found',
          marketData: {
            businessOverview: '',
            competitors: [],
            icp: []
          }
        };
      }

      // Format the market strategy for LLM consumption
      const formattedContent = this.formatMarketStrategy({
        exists: true,
        marketData: marketStrategy
      });

      // Return structured response similar to readBrandGuidelines
      return {
        success: true,
        message: `Market strategy retrieved successfully`,
        exists: true,
        marketData: marketStrategy,
        createdAt: marketStrategy.createdAt,
        updatedAt: marketStrategy.updatedAt,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error reading market strategy:', error);
      return {
        success: false,
        message: 'Failed to read market strategy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update user's market strategy
  public async updateMarketStrategy(updateData: any, userId: string): Promise<any> {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // Get existing market strategy
      const existingMarketStrategy = user.marketStrategy;

      // Extract market strategy fields from updateData
      const { businessOverview, competitors, icp, ...otherFields } = updateData;

      // Merge competitors by name - preserve existing entries, update or add new ones
      let mergedCompetitors = [...(existingMarketStrategy?.competitors || [])];
      if (competitors !== undefined && Array.isArray(competitors)) {
        competitors.forEach(newCompetitor => {
          const existingIndex = mergedCompetitors.findIndex(existing =>
            existing.name === newCompetitor.name
          );
          if (existingIndex >= 0) {
            // Update existing competitor
            mergedCompetitors[existingIndex] = {
              ...mergedCompetitors[existingIndex],
              ...newCompetitor
            };
          } else {
            // Add new competitor
            mergedCompetitors.push(newCompetitor);
          }
        });
      }

      // Merge ICPs by title - preserve existing entries, update or add new ones
      let mergedICP = [...(existingMarketStrategy?.icp || [])];
      if (icp !== undefined && Array.isArray(icp)) {
        icp.forEach(newICP => {
          const existingIndex = mergedICP.findIndex(existing =>
            existing.title === newICP.title
          );
          if (existingIndex >= 0) {
            // Update existing ICP
            mergedICP[existingIndex] = {
              ...mergedICP[existingIndex],
              ...newICP
            };
          } else {
            // Add new ICP
            mergedICP.push(newICP);
          }
        });
      }

      // Prepare market strategy data - merge with existing if available
      const marketStrategyData = {
        businessOverview: businessOverview !== undefined ? businessOverview : (existingMarketStrategy?.businessOverview || ''),
        competitors: mergedCompetitors,
        icp: mergedICP,
        createdAt: existingMarketStrategy?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Update user record with market strategy data
      await userDb.updateUser(userId, {
        marketStrategy: marketStrategyData
      });

      // Track what was updated vs added
      const updatedEntries: string[] = [];
      const addedEntries: string[] = [];

      if (competitors !== undefined && Array.isArray(competitors)) {
        competitors.forEach(competitor => {
          const wasExisting = existingMarketStrategy?.competitors?.some((existing: any) =>
            existing.name === competitor.name
          );
          if (wasExisting) {
            updatedEntries.push(`Competitor: ${competitor.name}`);
          } else {
            addedEntries.push(`Competitor: ${competitor.name}`);
          }
        });
      }

      if (icp !== undefined && Array.isArray(icp)) {
        icp.forEach(profile => {
          const wasExisting = existingMarketStrategy?.icp?.some((existing: any) =>
            existing.title === profile.title
          );
          if (wasExisting) {
            updatedEntries.push(`ICP: ${profile.title}`);
          } else {
            addedEntries.push(`ICP: ${profile.title}`);
          }
        });
      }

      // Format the update result for LLM consumption
      const formattedContent = this.formatMarketStrategyUpdate({
        success: true,
        message: 'Market strategy updated successfully',
        marketData: marketStrategyData,
        updatedFields: Object.keys(updateData).filter(key => updateData[key] !== undefined),
        updatedEntries,
        addedEntries,
        totalCompetitors: mergedCompetitors.length,
        totalICPs: mergedICP.length
      });

      return {
        success: true,
        message: 'Market strategy updated successfully',
        marketData: marketStrategyData,
        updatedFields: Object.keys(updateData).filter(key => updateData[key] !== undefined),
        updatedEntries,
        addedEntries,
        totalCompetitors: mergedCompetitors.length,
        totalICPs: mergedICP.length,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error updating market strategy:', error);
      return {
        success: false,
        message: 'Failed to update market strategy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // List all GTM plans for user
  public async listGTMPlans(userId: string): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb
        .query({
          TableName: TABLE_NAME,
          IndexName: "UserIdIndex",
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: {
            ":userId": userId,
          },
          ScanIndexForward: false, // Sort by createdAt descending (newest first)
        })
        .promise();

      const plans = result.Items || [];

      return {
        success: true,
        message: `Found ${plans.length} GTM plan(s)`,
        plans: plans.map((plan: any) => ({
          planId: plan.planId,
          title: plan.title,
          description: plan.description || '',
          phaseCount: plan.phases?.length || 0,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        })),
        totalPlans: plans.length
      };
    } catch (error) {
      console.error('AgentMode: Error listing GTM plans:', error);
      return {
        success: false,
        message: 'Failed to list GTM plans',
        error: error instanceof Error ? error.message : 'Unknown error',
        plans: [],
        totalPlans: 0
      };
    }
  }

  // Read a specific GTM plan
  public async readGTMPlan(planId: string, userId: string): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb
        .get({
          TableName: TABLE_NAME,
          Key: {
            planId: planId,
          },
        })
        .promise();

      if (!result.Item) {
        return {
          success: false,
          message: 'GTM plan not found',
          exists: false,
          error: 'GTM plan not found'
        };
      }

      // Verify the plan belongs to the user
      if (result.Item.userId !== userId) {
        return {
          success: false,
          message: 'Access denied',
          exists: false,
          error: 'Access denied'
        };
      }

      const plan = result.Item;

      // Calculate plan status based on phases
      const hasPhases = plan.phases && plan.phases.length > 0;
      const allPhasesCompleted = hasPhases && plan.phases.every(
        (phase: any) => phase.status === "completed"
      );
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      // Format the plan for LLM consumption
      let formattedContent = `GTM Plan: ${plan.title}\n`;
      if (plan.description) {
        formattedContent += `Description: ${plan.description}\n`;
      }
      if (plan.dri) {
        formattedContent += `DRI (Plan Level): ${plan.dri}\n`;
      }
      formattedContent += `Status: ${planStatus}\n`;
      formattedContent += `Created: ${plan.createdAt}\n`;
      formattedContent += `Updated: ${plan.updatedAt}\n`;
      if (planStatus === "completed" && plan.completedAt) {
        formattedContent += `Completed: ${plan.completedAt}\n`;
      }
      formattedContent += `\n`;
      formattedContent += `Phases (${plan.phases?.length || 0}):\n\n`;

      if (plan.phases && plan.phases.length > 0) {
        plan.phases.forEach((phase: any, index: number) => {
          formattedContent += `Phase ${index + 1}: ${phase.title}\n`;
          if (phase.description) {
            formattedContent += `  Description: ${phase.description}\n`;
          }
          if (phase.dri) {
            formattedContent += `  DRI: ${phase.dri}\n`;
          }
          formattedContent += `  Duration: ${phase.duration} day(s)\n`;
          formattedContent += `  Status: ${phase.status}\n`;
          formattedContent += `  Work Items (${phase.workItems?.length || 0}):\n`;

          if (phase.workItems && phase.workItems.length > 0) {
            phase.workItems.forEach((item: any, itemIndex: number) => {
              formattedContent += `    ${itemIndex + 1}. ${item.title} [${item.status}]`;
              if (item.duration !== undefined) {
                formattedContent += ` - ${item.duration} day(s)`;
              }
              if (item.dri) {
                formattedContent += ` - DRI: ${item.dri}`;
              }
              if (item.completedAt) {
                formattedContent += ` - Completed: ${item.completedAt}`;
              }
              formattedContent += `\n`;
              if (item.description) {
                formattedContent += `       ${item.description}\n`;
              }
              if (item.note) {
                formattedContent += `       Note: ${item.note}\n`;
              }
            });
          }
          formattedContent += `\n`;
        });
      } else {
        formattedContent += `No phases yet.\n`;
      }

      return {
        success: true,
        message: `GTM plan "${plan.title}" retrieved successfully`,
        exists: true,
        plan: plan,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error reading GTM plan:', error);
      return {
        success: false,
        message: 'Failed to read GTM plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Create a new GTM plan
  public async createGTMPlan(title: string, description: string, dri: string | undefined, phases: any[], userId: string, sessionId: string): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      // Determine default DRI based on delegate access
      let defaultDri: string | undefined;

      // Get session to check for delegateInfo
      const session = await chatbotDb.getChatSession(sessionId);
      if (session?.delegateInfo?.isDelegated && session.delegateInfo.adminEmail) {
        // For delegated access, use admin's email as default DRI
        defaultDri = session.delegateInfo.adminEmail;
      } else {
        // For regular access, look up user email from database
        const { userDb } = await import('./db');
        const user = await userDb.getUserById(userId);
        defaultDri = user?.email;
      }

      const planId = `plan-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      const now = new Date().toISOString();

      // Process phases and work items
      const processedPhases = (phases || []).map((phase: any, phaseIndex: number) => {
        const phaseId = `phase-${Date.now()}-${phaseIndex}-${Math.random().toString(36).substring(2, 11)}`;

        // Process work items for this phase
        const processedWorkItems = (phase.workItems || []).map((item: any, itemIndex: number) => ({
          id: `workitem-${Date.now()}-${phaseIndex}-${itemIndex}-${Math.random().toString(36).substring(2, 11)}`,
          title: item.title,
          description: item.description || "",
          duration: item.duration !== undefined ? item.duration : undefined,
          dri: item.dri || undefined, // DRI at work item level
          status: "pending" as const,
        }));

        // Determine phase status based on work items
        const hasWorkItems = processedWorkItems.length > 0;
        const allItemsDone = hasWorkItems && processedWorkItems.every(
          (item: any) => item.status === "completed" || item.status === "skipped"
        );

        return {
          id: phaseId,
          title: phase.title,
          description: phase.description || "",
          duration: phase.duration || 1,
          dri: phase.dri || undefined, // DRI at phase level
          status: allItemsDone ? "completed" : "in_progress" as const,
          workItems: processedWorkItems,
        };
      });

      // Calculate plan status based on phases
      const hasPhases = processedPhases && processedPhases.length > 0;
      const allPhasesCompleted = hasPhases && processedPhases.every(
        (phase: any) => phase.status === "completed"
      );
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      const newPlan = {
        planId,
        userId,
        title,
        description: description || "",
        dri: dri || defaultDri || undefined, // DRI defaults to admin email (if delegated) or user email
        status: planStatus,
        phases: processedPhases,
        createdAt: now,
        updatedAt: now,
      };

      const params = {
        TableName: TABLE_NAME,
        Item: newPlan,
      };

      await dynamodb.put(params).promise();

      return {
        success: true,
        message: `GTM plan "${title}" created successfully with ${processedPhases.length} phase(s)`,
        plan: {
          planId: newPlan.planId,
          title: newPlan.title,
          description: newPlan.description,
          phaseCount: processedPhases.length,
          phases: processedPhases,
          createdAt: newPlan.createdAt,
          updatedAt: newPlan.updatedAt,
        }
      };
    } catch (error) {
      console.error('AgentMode: Error creating GTM plan:', error);
      return {
        success: false,
        message: 'Failed to create GTM plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update a GTM plan (title, description, dri, dueDate)
  public async updateGTMPlan(planId: string, updates: { title?: string; description?: string; dri?: string; dueDate?: string }, userId: string): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

      if (!result.Item) {
        return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
      }

      if (result.Item.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Access denied' };
      }

      const updateExpressions: string[] = [];
      const expressionAttributeNames: { [key: string]: string } = {};
      const expressionAttributeValues: { [key: string]: any } = {};

      if (updates.title !== undefined) {
        updateExpressions.push("#title = :title");
        expressionAttributeNames["#title"] = "title";
        expressionAttributeValues[":title"] = updates.title;
      }

      if (updates.description !== undefined) {
        updateExpressions.push("#description = :description");
        expressionAttributeNames["#description"] = "description";
        expressionAttributeValues[":description"] = updates.description;
      }

      if (updates.dri !== undefined) {
        updateExpressions.push("#dri = :dri");
        expressionAttributeNames["#dri"] = "dri";
        expressionAttributeValues[":dri"] = updates.dri || null;
      }

      if (updates.dueDate !== undefined) {
        updateExpressions.push("#dueDate = :dueDate");
        expressionAttributeNames["#dueDate"] = "dueDate";
        expressionAttributeValues[":dueDate"] = updates.dueDate && updates.dueDate.trim() !== "" ? updates.dueDate.trim() : null;
      }

      if (updateExpressions.length === 0) {
        return { success: false, message: 'No fields to update', error: 'No fields to update' };
      }

      updateExpressions.push("#updatedAt = :updatedAt");
      expressionAttributeNames["#updatedAt"] = "updatedAt";
      expressionAttributeValues[":updatedAt"] = new Date().toISOString();

      const updateResult = await dynamodb.update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }).promise();

      return {
        success: true,
        message: 'GTM plan updated successfully',
        plan: updateResult.Attributes,
      };
    } catch (error) {
      console.error('AgentMode: Error updating GTM plan:', error);
      return { success: false, message: 'Failed to update GTM plan', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Add a phase to a GTM plan
  public async addGTMPhase(planId: string, phaseData: { title: string; description?: string; dri?: string; dueDate?: string; workItems?: any[] }, userId: string): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

      if (!result.Item) {
        return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
      }

      if (result.Item.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Access denied' };
      }

      const plan = result.Item;
      const phases = plan.phases || [];

      const phaseId = `phase-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

      // Process work items if provided
      const processedWorkItems = (phaseData.workItems || []).map((item: any, itemIndex: number) => ({
        id: `item-${Date.now()}-${itemIndex}-${Math.random().toString(36).substring(2, 11)}`,
        title: item.title,
        description: item.description || null,
        dri: item.dri || null,
        status: "pending",
        notes: null,
        dueDate: item.due_date && item.due_date.trim() !== "" ? item.due_date.trim() : null,
      }));

      const newPhase = {
        id: phaseId,
        title: phaseData.title,
        description: phaseData.description || null,
        dri: phaseData.dri || null,
        status: "in_progress" as const,
        workItems: processedWorkItems,
        dueDate: phaseData.dueDate && phaseData.dueDate.trim() !== "" ? phaseData.dueDate.trim() : null,
      };

      phases.push(newPhase);

      // Recalculate plan status
      const hasPhases = phases.length > 0;
      const allPhasesCompleted = hasPhases && phases.every((p: any) => p.status === "completed");
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      const updateExpressions: string[] = ["#phases = :phases", "#status = :status", "#updatedAt = :updatedAt"];
      const expressionAttributeNames: { [key: string]: string } = { "#phases": "phases", "#status": "status", "#updatedAt": "updatedAt" };
      const expressionAttributeValues: { [key: string]: any } = { ":phases": phases, ":status": planStatus, ":updatedAt": new Date().toISOString() };

      if (plan.status === "completed" && planStatus !== "completed") {
        updateExpressions.push("#completedAt = :completedAt");
        expressionAttributeNames["#completedAt"] = "completedAt";
        expressionAttributeValues[":completedAt"] = null;
      }

      const updateResult = await dynamodb.update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }).promise();

      return {
        success: true,
        message: `Phase "${phaseData.title}" added successfully with ${processedWorkItems.length} work item(s)`,
        plan: updateResult.Attributes,
        phaseId,
      };
    } catch (error) {
      console.error('AgentMode: Error adding GTM phase:', error);
      return { success: false, message: 'Failed to add phase', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Add work items to a phase
  public async addGTMWorkItems(planId: string, phaseId: string, workItems: any[], userId: string): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

      if (!result.Item) {
        return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
      }

      if (result.Item.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Access denied' };
      }

      const plan = result.Item;
      const phases = plan.phases || [];
      const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);

      if (phaseIndex === -1) {
        return { success: false, message: 'Phase not found', error: 'Phase not found' };
      }

      const phase = phases[phaseIndex];
      const existingWorkItems = phase.workItems || [];

      const newWorkItems = workItems.map((item: any, itemIndex: number) => ({
        id: `item-${Date.now()}-${itemIndex}-${Math.random().toString(36).substring(2, 11)}`,
        title: item.title,
        description: item.description || null,
        dri: item.dri || null,
        status: "pending",
        notes: null,
        dueDate: item.due_date && item.due_date.trim() !== "" ? item.due_date.trim() : null,
      }));

      existingWorkItems.push(...newWorkItems);

      // Recalculate phase status
      const hasWorkItems = existingWorkItems.length > 0;
      const allItemsDone = hasWorkItems && existingWorkItems.every(
        (item: any) => item.status === "completed" || item.status === "skipped"
      );

      phases[phaseIndex] = {
        ...phase,
        workItems: existingWorkItems,
        status: allItemsDone ? "completed" : "in_progress",
      };

      // Recalculate plan status
      const hasPhases = phases.length > 0;
      const allPhasesCompleted = hasPhases && phases.every((p: any) => p.status === "completed");
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      const updateExpressions: string[] = ["#phases = :phases", "#status = :status", "#updatedAt = :updatedAt"];
      const expressionAttributeNames: { [key: string]: string } = { "#phases": "phases", "#status": "status", "#updatedAt": "updatedAt" };
      const expressionAttributeValues: { [key: string]: any } = { ":phases": phases, ":status": planStatus, ":updatedAt": new Date().toISOString() };

      if (plan.status === "completed" && planStatus !== "completed") {
        updateExpressions.push("#completedAt = :completedAt");
        expressionAttributeNames["#completedAt"] = "completedAt";
        expressionAttributeValues[":completedAt"] = null;
      }

      const updateResult = await dynamodb.update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }).promise();

      return {
        success: true,
        message: `${newWorkItems.length} work item(s) added to phase "${phase.title}"`,
        plan: updateResult.Attributes,
        addedItems: newWorkItems.map((item: any) => ({ id: item.id, title: item.title })),
      };
    } catch (error) {
      console.error('AgentMode: Error adding GTM work items:', error);
      return { success: false, message: 'Failed to add work items', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Update a work item in a GTM plan
  public async updateGTMWorkItem(
    planId: string,
    phaseId: string,
    workItemId: string,
    updates: { status?: string; notes?: string; dri?: string; title?: string; description?: string; dueDate?: string },
    notifications: { notifyUser?: boolean; notifyItemPoc?: boolean; notifyPhasePoc?: boolean; notifyPlanPoc?: boolean; message?: string },
    userId: string
  ): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

      if (!result.Item) {
        return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
      }

      if (result.Item.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Access denied' };
      }

      const plan = result.Item;
      const phases = plan.phases || [];
      const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);

      if (phaseIndex === -1) {
        return { success: false, message: 'Phase not found', error: 'Phase not found' };
      }

      const phase = phases[phaseIndex];
      const workItems = phase.workItems || [];
      const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);

      if (workItemIndex === -1) {
        return { success: false, message: 'Work item not found', error: 'Work item not found' };
      }

      const originalItem = workItems[workItemIndex];
      const changes: any = {};

      // Build updated work item
      const updatedWorkItem = {
        ...originalItem,
        ...(updates.status !== undefined && { status: updates.status }),
        ...(updates.notes !== undefined && { notes: updates.notes || null }),
        ...(updates.dri !== undefined && { dri: updates.dri || null }),
        ...(updates.title !== undefined && { title: updates.title }),
        ...(updates.description !== undefined && { description: updates.description || null }),
        ...(updates.dueDate !== undefined && { dueDate: updates.dueDate && updates.dueDate.trim() !== "" ? updates.dueDate.trim() : null }),
        ...(updates.status === "completed" && originalItem.status !== "completed" && { completedAt: new Date().toISOString() }),
        ...(updates.status !== undefined && updates.status !== "completed" && originalItem.status === "completed" && { completedAt: null }),
      };

      // Track changes for notifications
      if (updates.status !== undefined && updates.status !== originalItem.status) {
        changes.status = updates.status;
      }
      if (updates.notes !== undefined && updates.notes !== originalItem.notes) {
        changes.notes = updates.notes || null;
      }
      if (updates.dri !== undefined && updates.dri !== originalItem.dri) {
        changes.dri = updates.dri || null;
      }
      if (updates.dueDate !== undefined) {
        const newDueDate = updates.dueDate && updates.dueDate.trim() !== "" ? updates.dueDate.trim() : null;
        const oldDueDate = originalItem.dueDate || null;
        if (newDueDate !== oldDueDate) {
          changes.dueDate = newDueDate;
        }
      }

      workItems[workItemIndex] = updatedWorkItem;

      // Recalculate phase status
      const hasWorkItems = workItems.length > 0;
      const allItemsDone = hasWorkItems && workItems.every(
        (item: any) => item.status === "completed" || item.status === "skipped"
      );
      phases[phaseIndex] = { ...phase, workItems, status: allItemsDone ? "completed" : "in_progress" };

      // Recalculate plan status
      const hasPhases = phases.length > 0;
      const allPhasesCompleted = hasPhases && phases.every((p: any) => p.status === "completed");
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      const wasCompleted = plan.status === "completed";
      const isNowCompleted = planStatus === "completed";
      const justCompleted = !wasCompleted && isNowCompleted;

      const updateExpressions: string[] = ["#phases = :phases", "#status = :status", "#updatedAt = :updatedAt"];
      const expressionAttributeNames: { [key: string]: string } = { "#phases": "phases", "#status": "status", "#updatedAt": "updatedAt" };
      const expressionAttributeValues: { [key: string]: any } = { ":phases": phases, ":status": planStatus, ":updatedAt": new Date().toISOString() };

      if (justCompleted) {
        updateExpressions.push("#completedAt = :completedAt");
        expressionAttributeNames["#completedAt"] = "completedAt";
        expressionAttributeValues[":completedAt"] = new Date().toISOString();
      } else if (wasCompleted && !isNowCompleted) {
        updateExpressions.push("#completedAt = :completedAt");
        expressionAttributeNames["#completedAt"] = "completedAt";
        expressionAttributeValues[":completedAt"] = null;
      }

      const updateResult = await dynamodb.update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }).promise();

      // Handle notifications if requested
      if (notifications && (notifications.notifyUser || notifications.notifyItemPoc || notifications.notifyPhasePoc || notifications.notifyPlanPoc)) {
        try {
          const { sendGTMPlanUpdateNotifications } = await import('./gtmPlanNotificationService');
          const updatedPlan = updateResult.Attributes as any;
          if (updatedPlan) {
            await sendGTMPlanUpdateNotifications(updatedPlan, phaseId, workItemId, changes, notifications);
          }
        } catch (notificationError: any) {
          console.error("Error sending GTM work item notifications:", notificationError);
        }
      }

      return {
        success: true,
        message: 'Work item updated successfully',
        plan: updateResult.Attributes,
      };
    } catch (error) {
      console.error('AgentMode: Error updating GTM work item:', error);
      return { success: false, message: 'Failed to update work item', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Update a phase in a GTM plan
  public async updateGTMPhase(planId: string, phaseId: string, updates: { title?: string; description?: string; dri?: string; dueDate?: string }, userId: string): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

      if (!result.Item) {
        return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
      }

      if (result.Item.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Access denied' };
      }

      const plan = result.Item;
      const phases = plan.phases || [];
      const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);

      if (phaseIndex === -1) {
        return { success: false, message: 'Phase not found', error: 'Phase not found' };
      }

      const phase = phases[phaseIndex];

      if (updates.title !== undefined) phase.title = updates.title;
      if (updates.description !== undefined) phase.description = updates.description || null;
      if (updates.dri !== undefined) phase.dri = updates.dri || null;
      if (updates.dueDate !== undefined) phase.dueDate = updates.dueDate && updates.dueDate.trim() !== "" ? updates.dueDate.trim() : null;

      phases[phaseIndex] = phase;

      const updateResult = await dynamodb.update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: "SET #phases = :phases, #updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#phases": "phases", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
        ReturnValues: "ALL_NEW",
      }).promise();

      return {
        success: true,
        message: `Phase "${phase.title}" updated successfully`,
        plan: updateResult.Attributes,
      };
    } catch (error) {
      console.error('AgentMode: Error updating GTM phase:', error);
      return { success: false, message: 'Failed to update phase', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Delete a GTM plan, phase, or work item
  public async deleteGTMItems(planId: string, phaseId?: string, workItemId?: string, userId?: string): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

      if (!result.Item) {
        return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
      }

      if (result.Item.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Access denied' };
      }

      const plan = result.Item;

      // Delete entire plan
      if (!phaseId) {
        await dynamodb.delete({ TableName: TABLE_NAME, Key: { planId } }).promise();
        return { success: true, message: `GTM plan "${plan.title}" deleted successfully` };
      }

      const phases = plan.phases || [];
      const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);

      if (phaseIndex === -1) {
        return { success: false, message: 'Phase not found', error: 'Phase not found' };
      }

      // Delete work item from phase
      if (workItemId) {
        const phase = phases[phaseIndex];
        const workItems = phase.workItems || [];
        const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);

        if (workItemIndex === -1) {
          return { success: false, message: 'Work item not found', error: 'Work item not found' };
        }

        const deletedItem = workItems[workItemIndex];
        workItems.splice(workItemIndex, 1);
        phases[phaseIndex] = { ...phase, workItems };

        await dynamodb.update({
          TableName: TABLE_NAME,
          Key: { planId },
          UpdateExpression: "SET phases = :phases, updatedAt = :updatedAt",
          ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
        }).promise();

        return { success: true, message: `Work item "${deletedItem.title}" deleted successfully` };
      }

      // Delete phase
      const deletedPhase = phases[phaseIndex];
      phases.splice(phaseIndex, 1);

      await dynamodb.update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: "SET phases = :phases, updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
      }).promise();

      return { success: true, message: `Phase "${deletedPhase.title}" deleted successfully` };
    } catch (error) {
      console.error('AgentMode: Error deleting GTM items:', error);
      return { success: false, message: 'Failed to delete GTM items', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Get GTM common items catalog
  public async getGTMCommonItems(): Promise<any> {
    try {
      const setting = await settingsService.getSetting("gtm_common_items");
      const categories = setting?.settingValue ? JSON.parse(setting.settingValue) : [];
      return { success: true, message: `Found ${categories.length} category(ies)`, categories };
    } catch (error) {
      console.error('AgentMode: Error fetching GTM common items:', error);
      return { success: false, message: 'Failed to fetch GTM common items', error: error instanceof Error ? error.message : 'Unknown error', categories: [] };
    }
  }

  // Add common items to a GTM plan phase
  public async addGTMCommonItems(planId: string, items: { title: string; description?: string }[], targetPhaseId?: string, newPhaseName?: string, userId?: string): Promise<any> {
    try {
      if (!items || items.length === 0) {
        return { success: false, message: 'Items array must be non-empty', error: 'Items array must be non-empty' };
      }

      if (!targetPhaseId && !newPhaseName) {
        return { success: false, message: 'Either target_phase_id or new_phase_name is required', error: 'Either target_phase_id or new_phase_name is required' };
      }

      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

      if (!result.Item) {
        return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
      }

      if (result.Item.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Access denied' };
      }

      const plan = result.Item;
      const phases = plan.phases || [];

      const newWorkItems = items.map((item: { title: string; description?: string }) => ({
        id: `item-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        title: item.title.trim(),
        description: item.description?.trim() || null,
        dri: null,
        status: "pending",
        notes: null,
        dueDate: null,
      }));

      if (targetPhaseId) {
        const phaseIndex = phases.findIndex((p: any) => p.id === targetPhaseId);
        if (phaseIndex === -1) {
          return { success: false, message: 'Target phase not found', error: 'Target phase not found' };
        }

        const targetPhase = phases[phaseIndex];
        const workItems = targetPhase.workItems || [];
        workItems.push(...newWorkItems);

        const hasWorkItems = workItems.length > 0;
        const allItemsDone = hasWorkItems && workItems.every(
          (item: any) => item.status === "completed" || item.status === "skipped"
        );

        phases[phaseIndex] = { ...targetPhase, workItems, status: allItemsDone ? "completed" : "in_progress" };
      } else if (newPhaseName) {
        const phaseId = `phase-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        phases.push({
          id: phaseId,
          title: newPhaseName.trim(),
          description: null,
          dri: null,
          status: "in_progress",
          workItems: newWorkItems,
          dueDate: null,
        });
      }

      // Recalculate plan status
      const hasPhases = phases.length > 0;
      const allPhasesCompleted = hasPhases && phases.every((p: any) => p.status === "completed");
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      const updateExpressions: string[] = ["#phases = :phases", "#status = :status", "#updatedAt = :updatedAt"];
      const expressionAttributeNames: { [key: string]: string } = { "#phases": "phases", "#status": "status", "#updatedAt": "updatedAt" };
      const expressionAttributeValues: { [key: string]: any } = { ":phases": phases, ":status": planStatus, ":updatedAt": new Date().toISOString() };

      if (plan.status === "completed" && planStatus !== "completed") {
        updateExpressions.push("#completedAt = :completedAt");
        expressionAttributeNames["#completedAt"] = "completedAt";
        expressionAttributeValues[":completedAt"] = null;
      }

      const updateResult = await dynamodb.update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }).promise();

      return {
        success: true,
        message: `${items.length} common item(s) added successfully`,
        plan: updateResult.Attributes,
      };
    } catch (error) {
      console.error('AgentMode: Error adding GTM common items:', error);
      return { success: false, message: 'Failed to add common items', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // Send GTM status report
  public async sendGTMStatusReport(
    planId: string,
    phaseId: string | undefined,
    notifications: { notifyUser?: boolean; notifyPlanPoc?: boolean; notifyPhasePoc?: boolean; notifyPhasePocs?: boolean; message?: string },
    userId: string
  ): Promise<any> {
    try {
      const { DynamoDB } = await import('aws-sdk');
      const dynamodb = new DynamoDB.DocumentClient({
        region: process.env.AWS_REGION || "us-west-2",
        ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
      });

      const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
      const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

      const result = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();

      if (!result.Item) {
        return { success: false, message: 'GTM plan not found', error: 'GTM plan not found' };
      }

      if (result.Item.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'Access denied' };
      }

      const plan = result.Item;

      if (phaseId) {
        // Phase-level report
        const phase = plan.phases?.find((p: any) => p.id === phaseId);
        if (!phase) {
          return { success: false, message: 'Phase not found', error: 'Phase not found' };
        }

        const { sendPhaseStatusReport } = await import('./gtmPlanNotificationService');
        await sendPhaseStatusReport(plan as any, phaseId, notifications, process.env.CUSTOMER_FRONTEND_URL);

        return { success: true, message: `Phase status report for "${phase.title}" sent successfully` };
      } else {
        // Plan-level report
        const { sendPlanStatusReport } = await import('./gtmPlanNotificationService');
        await sendPlanStatusReport(plan as any, notifications, process.env.CUSTOMER_FRONTEND_URL);

        return { success: true, message: `Plan status report for "${plan.title}" sent successfully` };
      }
    } catch (error) {
      console.error('AgentMode: Error sending GTM status report:', error);
      return { success: false, message: 'Failed to send status report', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async getLeadLists(userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');
      const lists = await crmDb.getLeadListsByUserId(userId);

      return {
        success: true,
        message: `Found ${lists.length} lead list(s)`,
        lists: lists.map((list: any) => ({
          listId: list.listId,
          name: list.name,
          description: list.description || '',
          leadCount: list.leadCount || 0,
          createdAt: list.createdAt
        })),
        totalLists: lists.length
      };
    } catch (error) {
      console.error('AgentMode: Error listing lead lists:', error);
      return {
        success: false,
        message: 'Failed to list lead lists',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async createLeadList(name: string, description: string, userId: string, listType?: 'sales' | 'customers'): Promise<any> {
    try {
      const { crmDb } = await import('./db');
      const list = await crmDb.createLeadList(userId, name, description, undefined, undefined, undefined, undefined, undefined, undefined, listType);

      return {
        success: true,
        message: `Lead list "${name}" created successfully`,
        list: {
          listId: list.listId,
          name: list.name,
          description: list.description || '',
          leadCount: list.leadCount || 0,
          createdAt: list.createdAt
        }
      };
    } catch (error) {
      console.error('AgentMode: Error creating lead list:', error);
      return {
        success: false,
        message: 'Failed to create lead list',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async addLeadsToList(listId: string, leads: any[], userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return {
          success: false,
          message: 'Lead list not found',
          error: 'The specified lead list does not exist'
        };
      }

      if (list.userId !== userId) {
        return {
          success: false,
          message: 'Access denied',
          error: 'You do not have permission to add leads to this list'
        };
      }

      // Convert leads array to the format expected by batchCreateLeads
      // Extract standard fields and put everything else in customFields
      const standardFields = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'status', 'dealValue', 'dealCurrency'];
      const formattedLeads = leads.map((lead: any) => {
        const formatted: any = {};
        const customFields: Record<string, any> = {};

        // Extract standard fields if they exist
        standardFields.forEach(field => {
          if (lead[field] !== undefined) {
            formatted[field] = lead[field];
          }
        });

        // Put all other fields into customFields
        Object.keys(lead).forEach(key => {
          if (!standardFields.includes(key)) {
            customFields[key] = lead[key];
          }
        });

        if (Object.keys(customFields).length > 0) {
          formatted.customFields = customFields;
        }

        return formatted;
      });

      const result = await crmDb.batchCreateLeads(listId, formattedLeads);

      const messageParts: string[] = [];
      if (result.newCount > 0) {
        messageParts.push(`${result.newCount} new lead(s) created`);
      }
      if (result.mergedCount > 0) {
        messageParts.push(`${result.mergedCount} lead(s) merged`);
      }
      if (result.errorCount > 0) {
        messageParts.push(`${result.errorCount} lead(s) failed`);
      }

      return {
        success: result.successCount > 0,
        message: messageParts.length > 0
          ? `Successfully processed: ${messageParts.join(', ')}.`
          : 'No leads were processed.',
        successCount: result.successCount,
        newCount: result.newCount || 0,
        mergedCount: result.mergedCount || 0,
        errorCount: result.errorCount,
        errors: result.errors.length > 0 ? result.errors : undefined
      };
    } catch (error) {
      console.error('AgentMode: Error adding leads to list:', error);
      return {
        success: false,
        message: 'Failed to add leads to list',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async getLeads(listId: string, userId: string, options: {
    search?: string;
    icpOnly?: boolean;
    engagedOnly?: boolean;
    status?: string;
    limit?: number;
  } = {}): Promise<any> {
    try {
      const { crmDb } = await import('./db');
      const limit = Math.min(Math.max(options.limit || 20, 1), 50);

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      const searchQuery = (options.search || '').trim().toLowerCase();
      const matchingLeads: any[] = [];
      let cursor: any = undefined;

      // Use flag indexes for efficiency when filtering by ICP or engaged
      const useIcpIndex = options.icpOnly && !options.engagedOnly;
      const useEngagedIndex = options.engagedOnly && !options.icpOnly;

      while (matchingLeads.length < limit) {
        const pageSize = 200;
        let pageResult: any;

        if (useIcpIndex) {
          pageResult = await crmDb.getLeadsByICPFlag(listId, 1, pageSize, cursor);
        } else if (useEngagedIndex) {
          pageResult = await crmDb.getLeadsByEngagedFlag(listId, 1, pageSize, cursor);
        } else {
          pageResult = await crmDb.getLeadsByListId(listId, pageSize, cursor);
        }

        const leads = pageResult.items || [];

        for (const lead of leads) {
          if (matchingLeads.length >= limit) break;

          // Apply ICP filter (if using general index)
          if (options.icpOnly && !useIcpIndex && !lead.icpMatch?.isMatch) continue;
          // Apply engaged filter (if using general index)
          if (options.engagedOnly && !useEngagedIndex && !lead.isEngaged) continue;
          // Apply both filters when using ICP index but also need engaged
          if (options.icpOnly && options.engagedOnly && useIcpIndex && !lead.isEngaged) continue;
          if (options.icpOnly && options.engagedOnly && useEngagedIndex && !lead.icpMatch?.isMatch) continue;
          // Apply status filter
          if (options.status && (lead.status || null) !== options.status) continue;

          // Apply text search
          if (searchQuery) {
            const fields = [
              lead.email, lead.firstName, lead.lastName,
              `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
              lead.company, lead.phone, lead.title, lead.notes, lead.linkedin
            ];
            const standardMatch = fields.some((v: any) => String(v || '').toLowerCase().includes(searchQuery));
            if (!standardMatch) {
              const customFields = lead.customFields && typeof lead.customFields === 'object' ? lead.customFields : {};
              const customMatch = Object.values(customFields).some((v: any) => String(v || '').toLowerCase().includes(searchQuery))
                || Object.keys(customFields).some((k: string) => k.toLowerCase().includes(searchQuery));
              if (!customMatch) continue;
            }
          }

          matchingLeads.push(lead);
        }

        cursor = pageResult.lastEvaluatedKey;
        if (!cursor) break;
      }

      return {
        success: true,
        message: `Found ${matchingLeads.length} lead(s)`,
        leads: matchingLeads.map((lead: any) => ({
          leadId: lead.leadId,
          email: lead.email || '',
          firstName: lead.firstName || '',
          lastName: lead.lastName || '',
          company: lead.company || '',
          title: lead.title || '',
          status: lead.status || null,
          dealValue: lead.dealValue ?? null,
          dealCurrency: lead.dealCurrency || 'USD',
          icpMatch: lead.icpMatch?.isMatch || false,
          icpScore: lead.icpMatch?.score || null,
          engagementCount: lead.engagementCount || 0,
          isEngaged: lead.isEngaged || false
        })),
        matchCount: matchingLeads.length,
        listName: list.name
      };
    } catch (error) {
      console.error('AgentMode: Error getting leads:', error);
      return { success: false, message: 'Failed to get leads', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async searchLeads(listId: string, filters: Array<{ field: string; operator: string; value?: any }>, userId: string, limit?: number): Promise<any> {
    try {
      const { crmDb } = await import('./db');
      const effectiveLimit = Math.min(Math.max(limit || 20, 1), 50);

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      if (!filters || filters.length === 0) {
        return { success: false, message: 'At least one filter is required', error: 'Provide at least one filter criterion' };
      }

      const standardFields = ['email', 'firstName', 'lastName', 'company', 'title', 'phone', 'notes', 'linkedin', 'status', 'dealValue', 'dealCurrency'];
      const matchingLeads: any[] = [];
      let cursor: any = undefined;

      while (matchingLeads.length < effectiveLimit) {
        const pageResult = await crmDb.getLeadsByListId(listId, 200, cursor);
        const leads = pageResult.items || [];

        for (const lead of leads) {
          if (matchingLeads.length >= effectiveLimit) break;

          const allMatch = filters.every((filter: any) => {
            const { field, operator, value } = filter;

            // Resolve the field value
            let fieldValue: any;
            if (field === 'icpScore') {
              fieldValue = lead.icpMatch?.score;
            } else if (field === 'icpMatch') {
              fieldValue = lead.icpMatch?.isMatch;
            } else if (field === 'engagementCount') {
              fieldValue = lead.engagementCount;
            } else if (standardFields.includes(field)) {
              fieldValue = lead[field];
            } else {
              // Custom field
              fieldValue = lead.customFields?.[field];
            }

            // Evaluate operator
            switch (operator) {
              case 'is_empty':
                return fieldValue === null || fieldValue === undefined || fieldValue === '';
              case 'is_not_empty':
                return fieldValue !== null && fieldValue !== undefined && fieldValue !== '';
              case 'equals':
                if (typeof fieldValue === 'boolean') return fieldValue === value;
                return String(fieldValue || '').toLowerCase() === String(value || '').toLowerCase();
              case 'not_equals':
                return String(fieldValue || '').toLowerCase() !== String(value || '').toLowerCase();
              case 'contains':
                return String(fieldValue || '').toLowerCase().includes(String(value || '').toLowerCase());
              case 'starts_with':
                return String(fieldValue || '').toLowerCase().startsWith(String(value || '').toLowerCase());
              case 'greater_than':
                return Number(fieldValue) > Number(value);
              case 'less_than':
                return Number(fieldValue) < Number(value);
              default:
                return false;
            }
          });

          if (allMatch) {
            matchingLeads.push(lead);
          }
        }

        cursor = pageResult.lastEvaluatedKey;
        if (!cursor) break;
      }

      return {
        success: true,
        message: `Found ${matchingLeads.length} matching lead(s)`,
        leads: matchingLeads.map((lead: any) => ({
          leadId: lead.leadId,
          email: lead.email || '',
          firstName: lead.firstName || '',
          lastName: lead.lastName || '',
          company: lead.company || '',
          title: lead.title || '',
          icpMatch: lead.icpMatch?.isMatch || false,
          icpScore: lead.icpMatch?.score || null,
          engagementCount: lead.engagementCount || 0,
          isEngaged: lead.isEngaged || false,
          customFields: lead.customFields || {}
        })),
        matchCount: matchingLeads.length,
        listName: list.name
      };
    } catch (error) {
      console.error('AgentMode: Error searching leads:', error);
      return { success: false, message: 'Failed to search leads', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async getLeadDetails(listId: string, leadId: string, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }

      // Get engagement count and recent engagements
      const [engagementCount, engagementsResult] = await Promise.all([
        crmDb.getLeadEngagementCount(listId, leadId, userId),
        crmDb.getLeadEngagements(listId, leadId, userId)
      ]);
      const engagements = engagementsResult.engagements || [];

      // Truncate HTML email drafts to text preview
      let emailDraftPreview = null;
      if (lead.emailDraft) {
        const draft = lead.emailDraft;
        emailDraftPreview = {
          subject: draft.subject || '',
          format: draft.format || 'text',
          contentPreview: draft.htmlContent
            ? draft.htmlContent.replace(/<[^>]*>/g, '').substring(0, 200) + (draft.htmlContent.length > 200 ? '...' : '')
            : (draft.textContent || '').substring(0, 200) + ((draft.textContent || '').length > 200 ? '...' : ''),
          hasFullContent: true
        };
      }

      return {
        success: true,
        message: `Lead details for ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
        lead: {
          leadId: lead.leadId,
          email: lead.email || '',
          firstName: lead.firstName || '',
          lastName: lead.lastName || '',
          company: lead.company || '',
          title: lead.title || '',
          phone: lead.phone || '',
          notes: lead.notes || '',
          linkedin: lead.linkedin || '',
          customFields: lead.customFields || {},
          icpMatch: lead.icpMatch || null,
          isEngaged: lead.isEngaged || false,
          emailDraft: emailDraftPreview,
          messageDraft: lead.messageDraft || null,
          selectedSenderId: lead.selectedSenderId || null,
          createdAt: lead.createdAt,
          updatedAt: lead.updatedAt
        },
        engagementSummary: {
          total: engagementCount.total,
          last7Days: engagementCount.last7Days,
          totalAllMessages: engagementCount.totalAllMessages
        },
        recentEngagements: engagements.slice(0, 10).map((eng: any) => ({
          eventType: eng.eventType,
          createdAt: eng.createdAt,
          eventData: eng.eventData || {},
          // Truncate email content for preview
          emailContentPreview: eng.emailContent
            ? eng.emailContent.replace(/<[^>]*>/g, '').substring(0, 150) + '...'
            : undefined
        })),
        listName: list.name
      };
    } catch (error) {
      console.error('AgentMode: Error getting lead details:', error);
      return { success: false, message: 'Failed to get lead details', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async updateLead(listId: string, leadId: string, updates: Record<string, any>, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to modify leads in this list' };
      }

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }

      if (!updates || Object.keys(updates).length === 0) {
        return { success: false, message: 'No updates provided', error: 'Provide at least one field to update' };
      }

      // Separate standard fields from custom fields
      const standardFields = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'status', 'dealValue', 'dealCurrency'];
      const dbUpdates: any = {};
      const customFieldUpdates: Record<string, any> = {};

      Object.entries(updates).forEach(([key, value]) => {
        if (standardFields.includes(key)) {
          dbUpdates[key] = value;
        } else {
          customFieldUpdates[key] = value;
        }
      });

      // Merge custom fields with existing ones
      if (Object.keys(customFieldUpdates).length > 0) {
        dbUpdates.customFields = {
          ...(lead.customFields || {}),
          ...customFieldUpdates
        };
      }

      // Auto-create status change engagement if status changed
      if (dbUpdates.status !== undefined && (lead.status || null) !== dbUpdates.status) {
        await crmDb.addLeadEngagement(listId, leadId, {
          eventType: 'status.changed',
          eventData: {
            from: lead.status || null,
            to: dbUpdates.status,
            dealValue: dbUpdates.dealValue ?? lead.dealValue ?? null,
            dealCurrency: dbUpdates.dealCurrency ?? lead.dealCurrency ?? 'USD',
          },
          createdAt: new Date().toISOString(),
        });
      }

      await crmDb.updateLead(listId, leadId, dbUpdates);

      return {
        success: true,
        message: `Lead updated successfully (${Object.keys(updates).join(', ')})`,
        updatedFields: Object.keys(updates)
      };
    } catch (error) {
      console.error('AgentMode: Error updating lead:', error);
      return { success: false, message: 'Failed to update lead', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async deleteLeads(listId: string, leadIds: string[], userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to delete leads from this list' };
      }

      if (!leadIds || leadIds.length === 0) {
        return { success: false, message: 'No lead IDs provided', error: 'Provide at least one lead ID to delete' };
      }

      if (leadIds.length > 100) {
        return { success: false, message: 'Too many leads', error: 'Maximum 100 leads can be deleted per call' };
      }

      let successCount = 0;
      let failCount = 0;
      const errors: string[] = [];

      // Delete sequentially to avoid lead count race conditions
      for (const id of leadIds) {
        try {
          await crmDb.deleteLead(listId, id);
          successCount++;
        } catch (err) {
          failCount++;
          errors.push(`Failed to delete lead ${id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      return {
        success: successCount > 0,
        message: `Deleted ${successCount} lead(s)${failCount > 0 ? `, ${failCount} failed` : ''}`,
        successCount,
        failCount,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      console.error('AgentMode: Error deleting leads:', error);
      return { success: false, message: 'Failed to delete leads', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async updateLeadList(listId: string, updates: {
    name?: string;
    description?: string;
    icpsOnly?: boolean;
    engagedOnly?: boolean;
    autoDraftEnabled?: boolean;
    autoDraftInstruction?: string;
    statusConfig?: Array<{ value: string; label: string; color: string; type: 'active' | 'won' | 'lost' | 'churned' }>;
    listType?: 'sales' | 'customers';
  }, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to modify this list' };
      }

      // Filter out undefined values
      const filteredUpdates: any = {};
      if (updates.name !== undefined) {
        if (!updates.name.trim()) {
          return { success: false, message: 'Invalid name', error: 'List name cannot be empty' };
        }
        filteredUpdates.name = updates.name;
      }
      if (updates.description !== undefined) filteredUpdates.description = updates.description;
      if (updates.icpsOnly !== undefined) filteredUpdates.icpsOnly = updates.icpsOnly;
      if (updates.engagedOnly !== undefined) filteredUpdates.engagedOnly = updates.engagedOnly;
      if (updates.autoDraftEnabled !== undefined) filteredUpdates.autoDraftEnabled = updates.autoDraftEnabled;
      if (updates.autoDraftInstruction !== undefined) filteredUpdates.autoDraftInstruction = updates.autoDraftInstruction;
      if (updates.statusConfig !== undefined) filteredUpdates.statusConfig = updates.statusConfig;
      if (updates.listType !== undefined) {
        if (list.listType) {
          return { success: false, message: 'List type already set', error: 'listType is already set and cannot be changed' };
        }
        filteredUpdates.listType = updates.listType;
      }

      if (Object.keys(filteredUpdates).length === 0) {
        return { success: false, message: 'No updates provided', error: 'Provide at least one field to update' };
      }

      await crmDb.updateLeadList(listId, filteredUpdates);

      return {
        success: true,
        message: `Lead list "${updates.name || list.name}" updated successfully`,
        updatedFields: Object.keys(filteredUpdates)
      };
    } catch (error) {
      console.error('AgentMode: Error updating lead list:', error);
      return { success: false, message: 'Failed to update lead list', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async updateLeadStatus(
    listId: string,
    leadId: string,
    status: string,
    userId: string,
    dealValue?: number | null,
    dealCurrency?: string,
    notes?: string
  ): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to modify leads in this list' };
      }

      // Fetch current lead
      const existingLead = await crmDb.getLeadById(listId, leadId);
      if (!existingLead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist' };
      }

      const previousStatus = existingLead.status || null;
      const updates: any = { status };
      if (dealValue !== undefined) updates.dealValue = dealValue;
      if (dealCurrency !== undefined) updates.dealCurrency = dealCurrency;

      await crmDb.updateLead(listId, leadId, updates);

      // Auto-create status change engagement
      if (previousStatus !== status) {
        await crmDb.addLeadEngagement(listId, leadId, {
          eventType: 'status.changed',
          eventData: {
            from: previousStatus,
            to: status,
            dealValue: dealValue ?? existingLead.dealValue ?? null,
            dealCurrency: dealCurrency ?? existingLead.dealCurrency ?? 'USD',
            ...(notes ? { notes } : {}),
          },
          createdAt: new Date().toISOString(),
        });
      }

      const leadName = [existingLead.firstName, existingLead.lastName].filter(Boolean).join(' ') || existingLead.email || leadId;
      return {
        success: true,
        message: `Status for "${leadName}" updated from "${previousStatus || 'unset'}" to "${status}"`,
        previousStatus,
        newStatus: status,
        leadName,
      };
    } catch (error) {
      console.error('AgentMode: Error updating lead status:', error);
      return { success: false, message: 'Failed to update lead status', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async getLeadListStatuses(listId: string, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to view this list' };
      }

      const defaultStatuses = [
        { value: 'new', label: 'New', color: 'gray', type: 'active' },
        { value: 'contacted', label: 'Contacted', color: 'blue', type: 'active' },
        { value: 'qualified', label: 'Qualified', color: 'indigo', type: 'active' },
        { value: 'proposal_sent', label: 'Proposal Sent', color: 'purple', type: 'active' },
        { value: 'negotiating', label: 'Negotiating', color: 'yellow', type: 'active' },
        { value: 'won', label: 'Won', color: 'green', type: 'won' },
        { value: 'lost', label: 'Lost', color: 'red', type: 'lost' },
        { value: 'churned', label: 'Churned', color: 'orange', type: 'churned' },
      ];

      return {
        success: true,
        statuses: list.statusConfig || defaultStatuses,
        listName: list.name,
      };
    } catch (error) {
      console.error('AgentMode: Error getting lead list statuses:', error);
      return { success: false, message: 'Failed to get lead list statuses', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async configureLeadStatuses(
    listId: string,
    statusConfig: Array<{ value: string; label: string; color: string; type: 'active' | 'won' | 'lost' | 'churned' }>,
    userId: string
  ): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to modify this list' };
      }

      // Validate statusConfig entries
      for (const entry of statusConfig) {
        if (!entry.value || !entry.label || !entry.color || !entry.type) {
          return { success: false, message: 'Invalid status config', error: 'Each status entry must have value, label, color, and type' };
        }
        if (!['active', 'won', 'lost', 'churned'].includes(entry.type)) {
          return { success: false, message: 'Invalid status type', error: `Status type must be one of: active, won, lost, churned. Got: "${entry.type}"` };
        }
      }

      // Check for duplicate values
      const values = statusConfig.map(s => s.value);
      const uniqueValues = new Set(values);
      if (values.length !== uniqueValues.size) {
        return { success: false, message: 'Duplicate status values', error: 'Each status value must be unique' };
      }

      await crmDb.updateLeadList(listId, { statusConfig });

      return {
        success: true,
        message: `Status configuration updated for list "${list.name}" with ${statusConfig.length} statuses`,
        statuses: statusConfig,
      };
    } catch (error) {
      console.error('AgentMode: Error configuring lead statuses:', error);
      return { success: false, message: 'Failed to configure lead statuses', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async deleteLeadList(listId: string, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to delete this list' };
      }

      const listName = list.name;
      const leadCount = list.leadCount || 0;

      await crmDb.deleteLeadList(listId);

      return {
        success: true,
        message: `Lead list "${listName}" and its ${leadCount} lead(s) have been permanently deleted`,
        deletedListName: listName,
        deletedLeadCount: leadCount
      };
    } catch (error) {
      console.error('AgentMode: Error deleting lead list:', error);
      return { success: false, message: 'Failed to delete lead list', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async getLeadEngagements(listId: string, leadId: string, userId: string, limit?: number): Promise<any> {
    try {
      const { crmDb } = await import('./db');
      const effectiveLimit = Math.min(Math.max(limit || 20, 1), 100);

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }

      const [engagementCount, engagementsResult] = await Promise.all([
        crmDb.getLeadEngagementCount(listId, leadId, userId),
        crmDb.getLeadEngagements(listId, leadId, userId)
      ]);
      const engagements = engagementsResult.engagements || [];

      const limitedEngagements = engagements.slice(0, effectiveLimit);

      return {
        success: true,
        message: `Found ${limitedEngagements.length} engagement(s) for ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
        engagementSummary: {
          total: engagementCount.total,
          last7Days: engagementCount.last7Days,
          totalAllMessages: engagementCount.totalAllMessages
        },
        engagements: limitedEngagements.map((eng: any) => ({
          eventId: eng.eventId,
          eventType: eng.eventType,
          createdAt: eng.createdAt,
          eventData: eng.eventData || {},
          // Truncate HTML email content to text preview
          emailContentPreview: eng.emailContent
            ? eng.emailContent.replace(/<[^>]*>/g, '').substring(0, 200) + (eng.emailContent.length > 200 ? '...' : '')
            : undefined
        })),
        leadName: `${lead.firstName || ''} ${lead.lastName || ''}`.trim()
      };
    } catch (error) {
      console.error('AgentMode: Error getting lead engagements:', error);
      return { success: false, message: 'Failed to get lead engagements', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async addLeadEngagement(
    listId: string, leadId: string, eventType: string,
    userId: string, eventData?: any, eventDate?: string
  ): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Validate event type
      if (!eventType.startsWith('custom.')) {
        return { success: false, message: 'Invalid event type', error: 'Event type must start with "custom." prefix (e.g., "custom.phone_call", "custom.meeting")' };
      }

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to modify leads in this list' };
      }

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }

      await crmDb.addLeadEngagement(listId, leadId, {
        eventType,
        eventData: eventData || {},
        createdAt: eventDate || new Date().toISOString()
      });

      return {
        success: true,
        message: `Engagement "${eventType}" recorded for ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
        eventType,
        leadName: `${lead.firstName || ''} ${lead.lastName || ''}`.trim()
      };
    } catch (error) {
      console.error('AgentMode: Error adding lead engagement:', error);
      return { success: false, message: 'Failed to add lead engagement', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async sendEmailToLead(listId: string, leadId: string, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      if (list.userId !== userId) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to send emails from this list' };
      }

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }

      if (!lead.email) {
        return { success: false, message: 'No email address', error: 'This lead does not have an email address' };
      }

      if (!lead.emailDraft) {
        return { success: false, message: 'No email draft', error: 'This lead does not have an email draft. Use update_email_draft_for_lead to create one first.' };
      }

      const draft = lead.emailDraft;
      if (!draft.subject) {
        return { success: false, message: 'Incomplete draft', error: 'The email draft is missing a subject line' };
      }

      if (!draft.htmlContent && !draft.textContent) {
        return { success: false, message: 'Incomplete draft', error: 'The email draft has no content' };
      }

      // Resolve sender: lead → list → account default → first available
      const sendersResult = await this.getCrmSenders(userId);
      if (!sendersResult.success || sendersResult.senders.length === 0) {
        return { success: false, message: 'No senders configured', error: 'No CRM sender emails are configured. Please set up a sender email in CRM settings first.' };
      }

      let sender = null;
      if (lead.selectedSenderId) {
        sender = sendersResult.senders.find((s: any) => s.id === lead.selectedSenderId);
      }
      if (!sender && list.listSenderId) {
        sender = sendersResult.senders.find((s: any) => s.id === list.listSenderId);
      }
      if (!sender) {
        const defaultSenderId = sendersResult.defaultSenderId;
        sender = defaultSenderId
          ? sendersResult.senders.find((s: any) => s.id === defaultSenderId)
          : sendersResult.senders[0];
      }

      if (!sender) {
        return { success: false, message: 'No valid sender', error: 'Could not resolve a valid sender email' };
      }

      // Send via Resend
      const { resendService } = await import('./resendService');
      const from = `${sender.fromName} <${sender.email}>`;
      const result = await resendService.sendEmail({
        from,
        to: lead.email,
        subject: draft.subject,
        html: draft.htmlContent,
        text: draft.textContent
      });

      if (!result) {
        return { success: false, message: 'Email send failed', error: 'Failed to send email via Resend' };
      }

      // Clear the draft after successful send
      await crmDb.updateLead(listId, leadId, { emailDraft: null });

      return {
        success: true,
        message: `Email sent successfully to ${lead.email}`,
        emailId: result.id,
        to: lead.email,
        from: sender.email,
        subject: draft.subject
      };
    } catch (error) {
      console.error('AgentMode: Error sending email to lead:', error);
      return { success: false, message: 'Failed to send email', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  public async sendForReview(
    subject: string,
    sessionId: string,
    userId: string,
    contentUrl?: string,
    contentHtml?: string
  ): Promise<{ success: boolean; message: string; to?: string }> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session?.resultEndpointMetadata) {
        return { success: false, message: 'No result endpoint metadata found on session' };
      }

      const metadata = session.resultEndpointMetadata;
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      const reviewerEmail = metadata.reviewerEmail || (metadata as any).testEmail;

      // Store content references and subject on session metadata for the review page
      const updatedMetadata = {
        ...metadata,
        contentUrl: contentUrl || metadata.contentUrl,
        contentHtml: contentHtml || metadata.contentHtml,
        contentSubject: subject,
      };
      await chatbotDb.updateSessionResultEndpointMetadata(sessionId, updatedMetadata);

      const reviewUrl = `${customerFrontendUrl}/review/${sessionId}`;

      // --- skipReview mode: auto-send to lead, CC reviewer ---
      if (metadata.skipReview && metadata.leadEmail) {
        const { resendService: resendSvc } = await import('./resendService');
        const { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } = await import('../config');

        // Collect assets from session messages to send the latest one
        const messages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
        let latestAssetUrl: string | undefined;
        for (const msg of messages) {
          if (msg.role === 'tool' && msg.content && msg.name) {
            let result: any;
            try { result = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content; } catch { continue; }
            if (!result || result.success === false) continue;
            if (result.s3_url) latestAssetUrl = result.s3_url;
            if (result.imageUrl) latestAssetUrl = result.imageUrl;
            if (result.videoUrl) latestAssetUrl = result.videoUrl;
          }
        }

        const assetUrl = contentUrl || latestAssetUrl;
        const resultLabel = metadata.resultTitle || metadata.resultName || 'your report';
        const replyToAddr = reviewerEmail || RESEND_SYSTEM_EMAIL;

        // Build asset block
        let assetBlock = '';
        if (assetUrl) {
          if (assetUrl.match(/\.(png|jpg|jpeg|gif|webp)$/i) || assetUrl.includes('image')) {
            assetBlock = `<p style="text-align: center;"><img src="${assetUrl}" alt="${resultLabel}" style="max-width: 100%; border-radius: 8px;" /></p>`;
          } else if (assetUrl.match(/\.(mp4|webm|mov)$/i) || assetUrl.includes('video')) {
            assetBlock = `<div style="text-align: center; margin: 20px 0;"><a href="${assetUrl}" style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Watch Video</a></div>`;
          } else {
            assetBlock = `<div style="text-align: center; margin: 20px 0;"><a href="${assetUrl}" style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">View Your Result</a></div>`;
          }
        }

        // Formal email to lead, CC reviewer
        const leadEmailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
              <p style="color: #666; margin: 5px 0;">${resultLabel}</p>
            </div>
            <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
              <h2 style="color: #1B2549; margin-top: 0;">Your ${resultLabel} is Ready!</h2>
              <p style="color: #333; line-height: 1.6;">We're excited to send you the requested ${resultLabel}. Our team has prepared this content specifically for you.</p>
              ${assetBlock}
              <p style="color: #333; line-height: 1.6; margin-top: 20px;">
                If you have any questions or would like to request changes, simply reply to this email or reach out to us at
                <a href="mailto:${replyToAddr}" style="color: #643B7E; text-decoration: none;">${replyToAddr}</a>
                and we'll be happy to assist.
              </p>
            </div>
            <div style="text-align: center; color: #666; font-size: 12px;">
              <p>Powered by <a href="https://agentweb.pro" style="color: #643B7E; text-decoration: none;">AgentWeb</a></p>
            </div>
          </div>`;

        const leadSubject = metadata.contentSubject || `Your ${resultLabel} is ready`;
        await resendSvc.sendEmail({
          from: `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`,
          to: metadata.leadEmail,
          subject: leadSubject,
          html: leadEmailHtml,
          cc: reviewerEmail,
          replyTo: replyToAddr,
        });

        // Record in send history
        const sendHistoryEntry = {
          assetUrl: assetUrl || '__auto_sent__',
          recipientEmail: metadata.leadEmail,
          customMessage: 'Auto-sent (no review required)',
          sentAt: new Date().toISOString(),
        };
        await chatbotDb.updateSessionResultEndpointMetadata(sessionId, {
          ...updatedMetadata,
          sendHistory: [...(updatedMetadata.sendHistory || []), sendHistoryEntry],
        });

        return { success: true, message: `Result sent to ${metadata.leadEmail} (reviewer ${reviewerEmail} CC'd)`, to: metadata.leadEmail };
      }

      // --- Standard review mode: send review email to reviewer ---
      const { emailService: emailSvc } = await import('./emailService');
      let contentSection = '';
      if (contentUrl) {
        contentSection = `<p><a href="${contentUrl}" style="color: #1976d2;">View Generated Content</a></p>`;
      }
      if (contentHtml) {
        contentSection += `<div style="margin: 16px 0; padding: 16px; border: 1px solid #e0e0e0; border-radius: 8px; background: #fafafa;">${contentHtml}</div>`;
      }

      const argsEntries = Object.entries(metadata.args || {});
      const paramsSummary = argsEntries.length > 0
        ? `<table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
            <tr style="background: #f5f5f5;"><th style="text-align: left; padding: 8px; border: 1px solid #e0e0e0;">Parameter</th><th style="text-align: left; padding: 8px; border: 1px solid #e0e0e0;">Value</th></tr>
            ${argsEntries.map(([k, v]) => `<tr><td style="padding: 8px; border: 1px solid #e0e0e0;">${k}</td><td style="padding: 8px; border: 1px solid #e0e0e0;">${v}</td></tr>`).join('')}
          </table>`
        : '';

      const reviewHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
          <div style="background: #1976d2; color: white; padding: 12px 20px; border-radius: 8px 8px 0 0; font-weight: bold;">
            Review: ${subject}
          </div>
          <div style="padding: 20px; border: 1px solid #e0e0e0; border-top: none;">
            <p style="color: #666;">A new result has been generated for "<strong>${metadata.resultTitle || metadata.resultName}</strong>". Please review the content below.</p>
            ${contentSection}
            ${paramsSummary ? `<h3 style="margin-top: 20px; color: #333;">Parameters</h3>${paramsSummary}` : ''}
            ${metadata.leadEmail ? `<p><strong>Lead email:</strong> ${metadata.leadEmail}</p>` : ''}
            <div style="margin-top: 24px; text-align: center;">
              <a href="${reviewUrl}" style="display: inline-block; background: #1976d2; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 16px;">Review & Send Result</a>
            </div>
          </div>
        </div>`;

      await emailSvc.sendEmail(reviewerEmail, `Review: ${subject}`, `Review result for ${metadata.resultTitle || metadata.resultName}`, reviewHtml);
      return { success: true, message: `Review email sent to ${reviewerEmail}`, to: reviewerEmail };

    } catch (error) {
      console.error('AgentMode: Error sending for review:', error);
      return { success: false, message: 'Failed to send for review', error: error instanceof Error ? error.message : 'Unknown error' } as any;
    }
  }

  public async updateEmailDraftForLead(listId: string, leadId: string, instruction: string, sessionId: string, userId: string, emailFormat?: 'text' | 'html'): Promise<any> {
    try {
      const { crmDb } = await import('./db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return {
          success: false,
          message: 'Lead list not found',
          error: 'The specified lead list does not exist'
        };
      }

      if (list.userId !== userId) {
        return {
          success: false,
          message: 'Access denied',
          error: 'You do not have permission to access this lead list'
        };
      }

      // Get the lead
      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return {
          success: false,
          message: 'Lead not found',
          error: 'The specified lead does not exist'
        };
      }

      // Get engagement history
      const engagementsResult = await crmDb.getLeadEngagements(listId, leadId, userId);
      const engagements = engagementsResult.engagements || [];

      // Get brand guidelines
      const brandGuidelines = await this.readBrandGuidelines(userId);

      // Get market strategy
      const marketStrategy = await this.readMarketStrategy(userId);

      // Get sender information (from lead record, or default sender from CRM configuration)
      const leadSelectedSenderId = (lead as any).selectedSenderId;
      const senderInfo = await this.getSenderForLead(userId, leadSelectedSenderId, list?.listSenderId);

      // Get existing draft if it exists
      const existingDraft = (lead as any).emailDraft;

      // Get email draft format: use provided parameter, or lead's preference, or default to 'text'
      const emailDraftFormat = emailFormat || (lead as any).emailDraftFormat || 'text';

      // Build the prompt for LLM
      let emailPrompt = `You are an expert email marketing strategist. Create a personalized email draft for a lead based on the following information:

## Lead Information:
- Name: ${lead.firstName || ''} ${lead.lastName || ''}`.trim();

      if (lead.company) {
        emailPrompt += `\n- Company: ${lead.company}`;
      }
      if (lead.title) {
        emailPrompt += `\n- Title: ${lead.title}`;
      }
      if (lead.email) {
        emailPrompt += `\n- Email: ${lead.email}`;
      }
      if (lead.notes) {
        emailPrompt += `\n- Notes: ${lead.notes}`;
      }
      if (lead.customFields && Object.keys(lead.customFields).length > 0) {
        emailPrompt += `\n- Custom Fields: ${JSON.stringify(lead.customFields, null, 2)}`;
      }

      // Add engagement history
      if (engagements.length > 0) {
        emailPrompt += `\n\n## Engagement History:`;
        engagements.slice(0, 10).forEach((eng: any, index: number) => {
          emailPrompt += `\n${index + 1}. ${eng.eventType} - ${eng.createdAt}`;
          if (eng.eventData?.subject) {
            emailPrompt += ` (Subject: ${eng.eventData.subject})`;
          }

          // Include email content if available (first 1k characters)
          if (eng.emailContent) {
            let contentPreview = '';
            // Prefer text content, fall back to HTML
            if (eng.emailContent.text) {
              contentPreview = eng.emailContent.text.substring(0, 1000);
            } else if (eng.emailContent.html) {
              // Strip HTML tags for preview, then take first 1k characters
              const textFromHtml = eng.emailContent.html
                .replace(/<[^>]*>/g, ' ') // Remove HTML tags
                .replace(/\s+/g, ' ') // Normalize whitespace
                .trim();
              contentPreview = textFromHtml.substring(0, 1000);
            }

            if (contentPreview) {
              const truncated = contentPreview.length >= 1000 ? contentPreview + '...' : contentPreview;
              emailPrompt += `\n   Email Content (first 1k characters):\n   ${truncated}`;
            }
          }
        });
      } else {
        emailPrompt += `\n\n## Engagement History: No previous engagements`;
      }

      // Add brand guidelines
      if (brandGuidelines.exists) {
        emailPrompt += `\n\n## Brand Guidelines:\n${brandGuidelines.formattedContent || JSON.stringify(brandGuidelines.brandData, null, 2)}`;
      } else {
        emailPrompt += `\n\n## Brand Guidelines: Not configured`;
      }

      // Add market strategy
      if (marketStrategy.exists) {
        emailPrompt += `\n\n## Market Strategy:\n${marketStrategy.formattedContent || JSON.stringify(marketStrategy.marketData, null, 2)}`;
      } else {
        emailPrompt += `\n\n## Market Strategy: Not configured`;
      }

      // Add sender information
      if (senderInfo) {
        emailPrompt += `\n\n## Sender Information:
- From Name: ${senderInfo.fromName}`;
        if (senderInfo.notes) {
          emailPrompt += `\n- Notes: ${senderInfo.notes}`;
        }
        emailPrompt += `\n\nUse this sender information to create an appropriate email signature. The signature should match the sender's name.`;
        if (senderInfo.notes) {
          emailPrompt += ` If the notes contain a meeting schedule link or other relevant information, consider including it in the email where appropriate.`;
        }
      } else {
        emailPrompt += `\n\n## Sender Information: Not configured (use a generic professional signature)`;
      }

      // Add existing draft if it exists
      if (existingDraft) {
        const existingContent = emailDraftFormat === 'text'
          ? (existingDraft.textContent || existingDraft.htmlContent || '')
          : (existingDraft.htmlContent || existingDraft.textContent || '');
        emailPrompt += `\n\n## Existing Email Draft (to refine/update):\nSubject: ${existingDraft.subject}\nContent:\n${existingContent}`;
      }

      // Add instruction
      emailPrompt += `\n\n## Instruction:\n${instruction}`;

      const contentType = emailDraftFormat === 'text' ? 'plain text' : 'HTML';
      emailPrompt += `\n\n## Requirements:
1. Create a professional, personalized email that aligns with the brand guidelines and market strategy
2. Use the lead's information to personalize the email (use their name, company, etc.)
3. Consider the engagement history to make the email contextually relevant
4. The email should be appropriate for the instruction provided
5. Subject line should be compelling and personalized (50-60 characters ideal)
6. Email content should be well-formatted, professional, and email-friendly (${contentType} format)
7. Include a clear call-to-action
8. Include an appropriate email signature at the end using the sender information provided (if available)
9. If updating an existing draft, improve it based on the instruction while maintaining the core message
${emailDraftFormat === 'text' ? '10. Use plain text format only - no HTML tags, no formatting markup. Use line breaks and simple text formatting.' : '10. Use HTML format with proper email-friendly HTML tags and styling.'}

Format the response as JSON with this structure:
${emailDraftFormat === 'text'
          ? `{
  "subject": "Email subject line (personalized, 50-60 characters)",
  "textContent": "Complete plain text email body (no HTML, use line breaks for paragraphs)"
}`
          : `{
  "subject": "Email subject line (personalized, 50-60 characters)",
  "htmlContent": "Complete HTML email body (well-formatted, professional, email-friendly HTML)"
}`}`;

      // Call LLM to generate email using direct chat completion (same as generateBlogContent)
      const completion = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
        messages: [
          {
            role: "system",
            content: emailDraftFormat === 'text'
              ? "You are an expert email marketing strategist. Create personalized, professional plain text emails that align with brand guidelines and market strategy. Always respond with valid JSON containing subject and textContent fields. Use plain text only - no HTML tags or formatting markup."
              : "You are an expert email marketing strategist. Create personalized, professional emails that align with brand guidelines and market strategy. Always respond with valid JSON containing subject and htmlContent fields.",
          },
          { role: "user", content: emailPrompt },
        ],
        temperature: 0.8,
        max_tokens: 3000,
        response_format: { type: 'json_object' }
      });

      const responseContent = completion.choices[0].message.content;
      if (!responseContent) {
        throw new Error('No content generated from LLM');
      }

      // Parse the JSON response
      let emailData;
      try {
        const cleanedContent = responseContent.replace(/```json\s*|\s*```/g, '').trim();
        emailData = JSON.parse(cleanedContent);
      } catch (parseError) {
        console.error('AgentMode: Error parsing email draft JSON:', parseError);
        throw new Error('Failed to parse email draft response');
      }

      // Validate required fields based on format
      if (emailDraftFormat === 'text') {
        if (!emailData.subject || !emailData.textContent) {
          throw new Error('LLM response missing required fields (subject, textContent)');
        }
      } else {
        if (!emailData.subject || !emailData.htmlContent) {
          throw new Error('LLM response missing required fields (subject, htmlContent)');
        }
      }

      // Save draft to lead record with sessionId
      const now = new Date().toISOString();
      const emailDraft: any = {
        subject: emailData.subject,
        createdAt: existingDraft?.createdAt || now,
        updatedAt: now,
        sessionId: sessionId
      };

      if (emailDraftFormat === 'text') {
        emailDraft.textContent = emailData.textContent;
      } else {
        emailDraft.htmlContent = emailData.htmlContent;
      }

      // Create message draft for LinkedIn/Facebook/other platforms
      const messagePrompt = `Based on the email draft you just created, now create a shorter message version suitable for LinkedIn, Facebook, or other messaging platforms.

## Email Draft Created:
Subject: ${emailData.subject}
Content: ${emailDraftFormat === 'text' ? emailData.textContent : emailData.htmlContent}

## Requirements for Message Draft:
1. Keep it concise and conversational (150-300 characters ideal, max 500)
2. Maintain the core message and call-to-action from the email
3. Make it platform-agnostic (works for LinkedIn, Facebook, Twitter DMs, etc.)
4. Use a friendly, professional tone
5. Include personalization (use lead's name if appropriate)
6. No need for subject line or signature
7. Focus on the key value proposition and CTA

Format the response as JSON with this structure:
{
  "content": "The complete message content (concise, 150-500 characters)"
}`;

      // Call LLM to generate message draft
      const messageCompletion = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
        messages: [
          {
            role: "system",
            content: "You are an expert at crafting concise, engaging messages for social platforms like LinkedIn, Facebook, and Twitter. Create personalized, platform-agnostic messages that drive engagement. Always respond with valid JSON containing a content field.",
          },
          { role: "user", content: messagePrompt },
        ],
        temperature: 0.8,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      });

      const messageResponseContent = messageCompletion.choices[0].message.content;
      if (!messageResponseContent) {
        throw new Error('No message content generated from LLM');
      }

      // Parse the JSON response
      let messageData;
      try {
        const cleanedMessageContent = messageResponseContent.replace(/```json\s*|\s*```/g, '').trim();
        messageData = JSON.parse(cleanedMessageContent);
      } catch (parseError) {
        console.error('AgentMode: Error parsing message draft JSON:', parseError);
        // Continue with email draft only if message draft fails
        messageData = null;
      }

      // Create message draft object if we got valid data
      let messageDraft = null;
      if (messageData && messageData.content) {
        const now = new Date().toISOString();
        messageDraft = {
          content: messageData.content,
          createdAt: now,
          updatedAt: now,
          sessionId: sessionId
        };
      }

      // Update lead with both email draft and message draft
      await crmDb.updateLead(listId, leadId, {
        emailDraft: emailDraft,
        emailDraftFormat: emailDraftFormat,
        ...(messageDraft && { messageDraft: messageDraft })
      });

      return {
        success: true,
        message: existingDraft
          ? 'Email and message drafts updated successfully'
          : 'Email and message drafts created successfully',
        data: {
          email: emailDraftFormat === 'text'
            ? {
              subject: emailData.subject,
              textContent: emailData.textContent
            }
            : {
              subject: emailData.subject,
              htmlContent: emailData.htmlContent
            },
          message: messageDraft ? { content: messageDraft.content } : null
        }
      };
    } catch (error) {
      console.error('AgentMode: Error updating email draft for lead:', error);
      return {
        success: false,
        message: 'Failed to create/update email draft',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update user's brand guidelines (supports both brandData and attachments)
  public async updateBrandGuidelines(updateData: any, userId: string): Promise<any> {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // Get existing brand guidelines
      let existingBrand = user.brandGuidelines;

      // If no existing brand guidelines, create a new structure
      if (!existingBrand) {
        // Create initial brand guidelines structure
        const initialBrandGuidelines = {
          brandData: {
            brandName: "",
            tagline: "",
            primaryColor: "",
            primaryColorEnd: "",
            secondaryColor: "",
            fontFamily: "",
            toneOfVoice: "",
            keyMessages: [],
            brandValues: [],
            targetAudience: "",
            brandPersonality: "",
            isGradient: false,
            founders: [],
          },
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Update the user with initial brand guidelines
        await userDb.updateUser(userId, {
          brandGuidelines: initialBrandGuidelines
        });

        // Use the initial structure as the base for updates
        existingBrand = initialBrandGuidelines;
      }

      // Extract brandData and brandAssets from updateData
      const { brandData, brandAssets, ...otherFields } = updateData;

      // Merge with existing brandData - only update provided fields
      const updatedBrandData = {
        ...existingBrand.brandData,
        ...brandData
      } as any;

      // Special merge logic for founder profiles (merge by normalized founder name)
      if (brandData && Array.isArray((brandData as any).founders)) {
        const normalize = (name: any) =>
          typeof name === 'string' ? name.trim().toLowerCase() : '';

        const existingFounders: any[] = Array.isArray((existingBrand.brandData as any)?.founders)
          ? (existingBrand.brandData as any).founders
          : [];
        const incomingFounders: any[] = (brandData as any).founders || [];

        const mergedFounders: any[] = [...existingFounders];
        for (const newFounder of incomingFounders) {
          if (!newFounder || !newFounder.name) continue;
          const key = normalize(newFounder.name);
          if (!key) continue;

          const idx = mergedFounders.findIndex(
            f => f && normalize(f.name) === key
          );
          if (idx >= 0) {
            // Replace the entire object for that founder name
            mergedFounders[idx] = newFounder;
          } else {
            // Append as new founder
            mergedFounders.push(newFounder);
          }
        }

        // Assign the merged array back
        updatedBrandData.founders = mergedFounders;
      }

      // Reject SVG files for logo/secondaryLogo assets
      if (brandAssets !== undefined) {
        const assetsToCheck = Array.isArray(brandAssets) ? brandAssets : [brandAssets];
        for (const asset of assetsToCheck) {
          if (asset && (asset.type === 'logo' || asset.type === 'secondaryLogo')) {
            const url = (asset.url || '').toLowerCase();
            const filename = (asset.filename || '').toLowerCase();
            if (url.endsWith('.svg') || filename.endsWith('.svg') || url.includes('.svg?')) {
              return {
                success: false,
                message: `SVG files are not supported for ${asset.type === 'logo' ? 'primary' : 'secondary'} logo. Please convert your SVG to PNG or another raster format before uploading.`,
                error: 'SVG format not allowed for logo uploads'
              };
            }
          }
        }
      }

      // Handle brandAssets update - merge by type to preserve existing assets
      let updatedAttachments = [...(existingBrand.attachments || [])];
      const updatedAssets: any[] = []; // Track which assets were actually updated

      if (brandAssets !== undefined) {
        if (Array.isArray(brandAssets)) {
          // Merge by type: replace assets of the same type, keep others
          brandAssets.forEach(newAsset => {
            const existingIndex = updatedAttachments.findIndex(existing => existing.type === newAsset.type);
            if (existingIndex >= 0) {
              // Replace existing asset of the same type
              updatedAttachments[existingIndex] = newAsset;
              updatedAssets.push(newAsset); // Track as updated
            } else {
              // Add new asset type
              updatedAttachments.push(newAsset);
              updatedAssets.push(newAsset); // Track as added
            }
          });
        } else if (typeof brandAssets === 'object' && brandAssets !== null) {
          // Single asset - merge by type
          const existingIndex = updatedAttachments.findIndex(existing => existing.type === brandAssets.type);
          if (existingIndex >= 0) {
            // Replace existing asset of the same type
            updatedAttachments[existingIndex] = brandAssets;
            updatedAssets.push(brandAssets); // Track as updated
          } else {
            // Add new asset type
            updatedAttachments.push(brandAssets);
            updatedAssets.push(brandAssets); // Track as added
          }
        }
      }

      // Update the user's brand guidelines
      await userDb.updateUser(userId, {
        brandGuidelines: {
          ...existingBrand,
          brandData: updatedBrandData,
          attachments: updatedAttachments,
          updatedAt: new Date().toISOString()
        }
      });

      const updatedFields = [];
      if (brandData) updatedFields.push(...Object.keys(brandData));
      if (brandAssets !== undefined) updatedFields.push('brandAssets');
      updatedFields.push(...Object.keys(otherFields));

      // Format the update result for LLM consumption
      const formattedContent = this.formatBrandGuidelinesUpdate({
        success: true,
        message: 'Brand guidelines updated successfully',
        updatedFields,
        brandData: updatedBrandData,
        attachments: updatedAttachments,
        updatedAssets: updatedAssets
      });

      return {
        success: true,
        message: 'Brand guidelines updated successfully',
        updatedFields,
        brandData: updatedBrandData,
        attachments: updatedAttachments,
        updatedAssets: updatedAssets, // Only the assets that were actually updated
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error updating brand guidelines:', error);
      return {
        success: false,
        message: 'Failed to update brand guidelines',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Update knowledge base content for a task
   * Used by update_knowledge_base tool
   */
  public async updateKnowledgeBase(
    taskId: string,
    content: string,
    mode: 'replace' | 'append',
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log(`[updateKnowledgeBase] taskId=${taskId}, mode=${mode}, userId=${userId}`);

      // 1. Input validation
      if (!content || content.trim().length === 0) {
        return {
          success: false,
          message: 'Content cannot be empty',
          error: 'Invalid input: empty content'
        };
      }

      const MAX_KB_SIZE = 10 * 1024 * 1024; // 10MB
      const contentSize = Buffer.byteLength(content, 'utf8');
      if (contentSize > MAX_KB_SIZE) {
        return {
          success: false,
          message: `Content too large (${Math.round(contentSize / 1024 / 1024)}MB). Maximum size is 10MB.`,
          error: 'Content exceeds size limit'
        };
      }

      if (!taskId || taskId.trim().length === 0) {
        return {
          success: false,
          message: 'Task ID is required',
          error: 'Invalid input: missing taskId'
        };
      }

      // 2. Get task and check authorization
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        return {
          success: false,
          message: 'Task not found',
          error: 'Task not found'
        };
      }

      if (task.userId !== userId) {
        return {
          success: false,
          message: 'Not authorized to modify this task',
          error: 'Unauthorized'
        };
      }

      // 3. Initialize GCS
      const privateKey = await getGCSPPrivateKey();
      const storage = new Storage({
        projectId: process.env.GCS_PROJECT_ID,
        credentials: {
          client_email: process.env.GCS_CLIENT_EMAIL,
          private_key: privateKey
        }
      });

      // 4. Determine bucket based on knowledgeBaseType
      const knowledgeBaseType = task.knowledgeBaseType || 'private';
      const bucketName = knowledgeBaseType === 'public'
        ? (process.env.KNOWLEDGE_BASE_BUCKET || 'agentweb-knowledge-base-dev')
        : (process.env.PRIVATE_KNOWLEDGE_BASE_BUCKET || 'agentweb-knowledge-base-private-dev');

      const bucket = storage.bucket(bucketName);
      const filePath = `tasks/${taskId}/knowledge-base.txt`;
      const file = bucket.file(filePath);

      // 5. Handle append mode - read existing content
      let finalContent = content;
      if (mode === 'append') {
        try {
          const [existingContent] = await file.download();
          finalContent = existingContent.toString() + '\n\n' + content;
        } catch (error: any) {
          // Only treat 404 as "file not found" - re-throw all other errors
          const errorMessage = error.message?.toLowerCase() || '';
          const isNotFound = error.code === 404 ||
                            errorMessage.includes('no such object') ||
                            errorMessage.includes('not found') ||
                            errorMessage.includes('does not exist');

          if (isNotFound) {
            console.log(`[updateKnowledgeBase] No existing KB file for task ${taskId}, creating new`);
          } else {
            // Re-throw permission errors, network errors, etc.
            console.error(`[updateKnowledgeBase] Error downloading existing KB file:`, error);
            throw error;
          }
        }
      }

      // 6. Save content to GCS
      await file.save(finalContent, {
        contentType: 'text/plain',
        metadata: {
          taskId,
          userId,
          updatedAt: new Date().toISOString()
        }
      });

      // 7. Get signed URL (expires 03-01-2500 like other KB operations)
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: '03-01-2500'
      });

      // 8. Update task metadata in DynamoDB
      await taskDb.updateTask(taskId, {
        knowledgeBaseSize: Buffer.byteLength(finalContent, 'utf8'),
        knowledgeBase: url,
        knowledgeBaseUpdatedAt: new Date().toISOString()
      });

      return {
        success: true,
        message: `Knowledge base ${mode === 'append' ? 'updated' : 'replaced'} successfully`,
        updatedSize: Buffer.byteLength(finalContent, 'utf8'),
        updatedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('[updateKnowledgeBase] Error:', error);
      return {
        success: false,
        message: 'Failed to update knowledge base',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private getCurrentTaskStatusesInSession(sessionHistory: ChatMessage[]): any[] {
    try {
      const taskStatuses: any[] = [];

      // Extract task statuses from session history
      sessionHistory.forEach(message => {
        if (message.metadata?.toolCalls) {
          message.metadata.toolCalls.forEach((toolCall: any) => {
            // Check if this is a task creation tool call
            if ((toolCall.name === 'create_task_from_template' || toolCall.name === 'create_task_from_prompt' || toolCall.name === 'create_image_task_from_prompt' || toolCall.name === 'create_revision') && toolCall.result) {
              const result = toolCall.result;
              if (result.taskId && result.executionId) {
                taskStatuses.push({
                  taskId: result.taskId,
                  executionId: result.executionId,
                  taskName: result.taskName || `Task ${result.taskId}`,
                  status: result.status || 'pending',
                  createdAt: new Date().toISOString()
                });
              }
            }
          });
        }
      });

      // Remove duplicates and return unique task statuses
      const uniqueTaskStatuses = new Map();
      taskStatuses.forEach(task => {
        const key = `${task.taskId}-${task.executionId}`;
        if (!uniqueTaskStatuses.has(key)) {
          uniqueTaskStatuses.set(key, task);
        }
      });

      return Array.from(uniqueTaskStatuses.values());
    } catch (error) {
      console.error('AgentMode: Error getting task statuses from session:', error);
      return [];
    }
  }

  public async getCurrentTaskStatuses(userId: string): Promise<any[]> {
    try {
      // Get recent task executions for this user
      const allExecutions = await taskDb.getAllTaskExecutionsByUserId(userId);
      // Get the 10 most recent executions
      const recentExecutions = (allExecutions || [])
        .sort((a, b) => new Date(b.createdAt || b.startTime).getTime() - new Date(a.createdAt || a.startTime).getTime())
        .slice(0, 10);

      return recentExecutions.map(execution => ({
        taskId: execution.taskId,
        executionId: execution.executionId,
        status: execution.status,
        taskName: execution.taskName || 'Unknown Task',
        createdAt: execution.createdAt || execution.startTime
      }));
    } catch (error) {
      console.error('Error fetching current task statuses:', error);
      return [];
    }
  }

  // Get available templates
  public async getAvailableTemplates(): Promise<any[]> {
    try {
      const templates = await taskTemplateDb.getPublishedTemplates();
      return templates
        .filter(template => {
          // Only include templates with valid categories
          const category = template.category;
          return category && category.trim() !== '';
        })
        .map(template => ({
          templateId: template.templateId,
          name: template.name,
          description: template.description,
          category: template.category,
          parameters: template.parameters || [],
          promptTemplate: template.prompt,
          isDeepResearch: template.isDeepResearch,
          isComplexTask: template.isComplexTask,
          outputAsJson: template.outputAsJson,
          outputAsHtml: template.outputAsHtml,
          selectedLLMs: template.selectedLLMs,
          useSharedBrowser: template.useSharedBrowser,
          turnOffHeadless: template.turnOffHeadless
        }));
    } catch (error) {
      console.error('Error fetching templates:', error);
      throw error;
    }
  }

  // List task templates (used by list_task_templates MCP tool)
  public async listTaskTemplates(): Promise<any> {
    try {
      const templates = await this.getAvailableTemplates();

      if (templates.length === 0) {
        return {
          success: true,
          message: 'No templates are currently available.',
          templates: [],
          totalTemplates: 0
        };
      }

      // Group by category for organized presentation
      const grouped: Record<string, any[]> = {};
      templates.forEach((t: any) => {
        const cat = t.category || 'General';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push({
          template_id: t.templateId,
          name: t.name,
          description: t.description,
          category: cat,
          parameters: (t.parameters || []).map((p: any) => typeof p === 'string' ? p : p.name || p.id)
        });
      });

      return {
        success: true,
        message: `Found ${templates.length} template(s)`,
        templates_by_category: grouped,
        totalTemplates: templates.length
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to list task templates',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Helper method to convert file URLs to TaskAttachment objects
  private convertUrlsToAttachments(fileUrls: string[]): any[] {
    return fileUrls.map(url => {
      // Extract filename from URL (last part after the last slash)
      const filename = url.split('/').pop() || 'unknown_file';
      return {
        url: url,
        key: url, // Use URL as key for now
        filename: filename,
        uploadedAt: new Date().toISOString()
      };
    });
  }

  // Helper function to wait for task completion
  public async waitForTaskCompletion(taskId: string, executionId: string, userId: string, maxWaitTime: number = 300000, additionalFields: any = {}, pollInterval: number = 2000): Promise<any> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const execution = await taskDb.getTaskExecutionById(executionId);
        if (execution && (execution.status === 'completed' || execution.status === 'failed')) {
          return {
            success: execution.status === 'completed',
            message: execution.status === 'completed'
              ? 'Task completed successfully'
              : `Task failed: ${execution.error || 'Unknown error'}`,
            status: execution.status,
            taskId: taskId,
            executionId: executionId,
            result: execution.result,
            error: execution.error,
            ...additionalFields
          };
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        console.error('AgentMode: Error polling task execution:', error);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    // Timeout reached - return async format
    return {
      success: true,
      message: `Task "${additionalFields.taskName || 'Unknown'}" has been created successfully. The task is still running and may complete later.`,
      status: 'pending',
      taskId: taskId,
      executionId: executionId,
      ...additionalFields
    };
  }

  // Create task from template
  public async createTaskFromTemplate(templateId: string, parameters: Record<string, string>, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true, attachedFileUrls: string[] = [], async: boolean = false): Promise<any> {
    try {

      // Validate parameters
      if (!parameters || typeof parameters !== 'object') {
        return {
          success: false,
          message: 'Invalid parameters provided. Parameters must be a dictionary with parameter IDs as keys.',
          status: 'invalid_parameters'
        };
      }

      // Load specific template by ID
      const template = await taskTemplateDb.getTemplateById(templateId);
      if (!template) {
        return {
          success: false,
          message: 'Template not found. Please check the template ID and try again.',
          status: 'template_not_found'
        };
      }

      // Check if user has access to the template (either owns it or it's published)
      if (template.userId !== userId && !template.published) {
        return {
          success: false,
          message: 'You do not have access to this template.',
          status: 'access_denied'
        };
      }


      // Map template to the expected format
      const templateData = {
        templateId: template.templateId,
        name: template.name,
        description: template.description,
        category: template.category,
        parameters: template.parameters || [],
        promptTemplate: template.prompt,
        isInteractive: template.isInteractive,
        isDeepResearch: template.isDeepResearch,
        isComplexTask: template.isComplexTask,
        outputAsJson: template.outputAsJson,
        outputAsHtml: template.outputAsHtml,
        selectedLLMs: template.selectedLLMs,
        useSharedBrowser: template.useSharedBrowser,
        turnOffHeadless: template.turnOffHeadless,
        isAgenticDevMode: template.isAgenticDevMode,
        nameParameter: template.nameParameter
      };

      // Check if required parameters are missing
      const missingRequired = (templateData.parameters || [])
        .filter((p: any) => {
          const paramName = typeof p === 'string' ? p : p.name || p.id;
          return !parameters[paramName];
        })
        .map((p: any) => typeof p === 'string' ? p : p.name || p.id);

      if (missingRequired.length > 0) {
        return {
          success: false,
          message: `I need more information to create this task. Please provide the following required details: ${missingRequired.join(', ')}`,
          status: 'missing_parameters',
          missingParameters: missingRequired
        };
      }

      // Generate final prompt by replacing parameters in template
      let finalPrompt = templateData.promptTemplate;
      if (templateData.parameters && templateData.parameters.length > 0) {
        templateData.parameters.forEach((param: any) => {
          // Use the parameter name directly as the key
          const paramName = typeof param === 'string' ? param : param.name || param.id;
          const value = parameters[paramName] || `[${paramName}]`;
          finalPrompt = finalPrompt?.replace(
            new RegExp(`\\[${paramName}\\]`, 'g'),
            value
          );
        });
      }

      // Attach previous task results if requested
      if (attachPreviousTaskResults) {
        const previousResults = await this.getPreviousTaskResults(userId, sessionId);
        if (previousResults) {
          finalPrompt += previousResults;
        }
      }

      // Generate task name
      let taskName = templateData.name;
      if (templateData.nameParameter && parameters[templateData.nameParameter]) {
        taskName = `${templateData.name} - ${parameters[templateData.nameParameter]}`;
      }

      // Convert file URLs to attachments
      const attachments = this.convertUrlsToAttachments(attachedFileUrls);

      // Create task using template
      const task = {
        taskId: Date.now().toString(),
        userId,
        name: taskName,
        prompt: finalPrompt,
        status: 'active',
        emailNotification: templateData.isDeepResearch || false,
        isInteractive: templateData.isInteractive || false,
        isDeepResearch: templateData.isDeepResearch || false,
        isComplexTask: templateData.isComplexTask || false,
        extractPageContent: false,
        outputAsJson: templateData.outputAsJson || false,
        outputAsHtml: templateData.outputAsHtml || false,
        selectedLLMs: templateData.selectedLLMs || undefined,
        useSharedBrowser: templateData.useSharedBrowser || false,
        turnOffHeadless: templateData.turnOffHeadless !== undefined ? templateData.turnOffHeadless : true,
        isAgenticDevMode: templateData.isAgenticDevMode || false,
        useKnowledgeBase: false,
        updateKnowledgeBase: false,
        updateLeadList: false,
        createVideo: false,
        videoModel: undefined,
        imageModel: undefined,
        category: templateData.category || 'General',
        description: templateData.description,
        templateId: templateData.templateId,
        parameterValues: parameters,
        attachments: attachments,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Save task to database
      await taskDb.createTask(task);

      // Create task execution
      const execution = await taskDb.createTaskExecution({
        executionId: Date.now().toString(),
        taskId: task.taskId,
        userId: userId,
        status: 'pending',
        startTime: new Date().toISOString()
      });

      // If async is false, wait for task completion
      if (!async && execution?.executionId) {
        return await this.waitForTaskCompletion(task.taskId, execution.executionId, userId, 3600000, {
          templateName: templateData.name,
          taskName: taskName
        });
      }

      return {
        success: true,
        message: `Task "${taskName}" has been created successfully using the ${templateData.name} template. The task will start running shortly.`,
        status: 'pending',
        taskId: task.taskId,
        executionId: execution?.executionId,
        templateName: templateData.name,
        taskName: taskName
      };
    } catch (error) {
      console.error('AgentMode: Error creating task from template:', error);
      return {
        success: false,
        message: 'Failed to create task from template. Please try again.',
        status: 'error'
      };
    }
  }

  // Create task from raw prompt
  public async createTaskFromPrompt(taskName: string, prompt: string, category: string, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true, attachedFileUrls: string[] = [], async: boolean = false): Promise<any> {
    try {

      // Attach previous task results if requested
      let finalPrompt = prompt;
      if (attachPreviousTaskResults) {
        const previousResults = await this.getPreviousTaskResults(userId, sessionId);
        if (previousResults) {
          finalPrompt += previousResults;
        }
      }

      // Convert file URLs to attachments
      const attachments = this.convertUrlsToAttachments(attachedFileUrls);

      // Create task using raw prompt
      const task = {
        taskId: Date.now().toString(),
        userId,
        name: taskName,
        prompt: finalPrompt,
        status: 'active',
        emailNotification: false,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        extractPageContent: false,
        outputAsJson: false,
        outputAsHtml: true,
        useSharedBrowser: false,
        turnOffHeadless: true,
        useKnowledgeBase: false,
        updateKnowledgeBase: false,
        updateLeadList: false,
        createVideo: false,
        videoModel: undefined,
        imageModel: undefined,
        category: category,
        description: `Custom task created from prompt: ${taskName}`,
        attachments: attachments,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Save task to database
      await taskDb.createTask(task);

      // Create task execution
      const execution = await taskDb.createTaskExecution({
        executionId: Date.now().toString(),
        taskId: task.taskId,
        userId: userId,
        status: 'pending',
        startTime: new Date().toISOString()
      });

      // If async is false, wait for task completion
      if (!async && execution?.executionId) {
        return await this.waitForTaskCompletion(task.taskId, execution.executionId, userId, 3600000, {
          taskName: taskName
        });
      }

      return {
        success: true,
        message: `Task "${taskName}" has been created successfully using a custom prompt. The task will start running shortly.`,
        status: 'pending',
        taskId: task.taskId,
        executionId: execution?.executionId,
        taskName: taskName
      };
    } catch (error) {
      console.error('AgentMode: Error creating task from prompt:', error);
      return {
        success: false,
        message: 'Failed to create task from prompt. Please try again.',
        status: 'error'
      };
    }
  }

  // Create image generation task from raw prompt
  public async createImageTaskFromPrompt(taskName: string, prompt: string, category: string, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true): Promise<any> {
    try {

      // Format the prompt using the same format as handleCreateAdImageTask
      let formattedPrompt = "Please create high-quality ad images that align with the below context and target the specified audience. The images should be professional, engaging, and suitable for various marketing channels. Use download_image to download reference images and generate_image to create the result images. Valid size values for generate_image include \"1024x1024\", \"1536x1024\", \"1024x1536\", \"auto\". Valid quality values for generate_image include \"low\", \"medium\", \"high\" (defaults to medium if not specified). DO NOT browse the internet for other images.\n\n";

      // Add the user's image prompt
      if (prompt.trim()) {
        formattedPrompt += `Image Prompt:\n${prompt.trim()}\n\n`;
      }

      // Attach previous task results if requested
      if (attachPreviousTaskResults) {
        const previousResults = await this.getPreviousTaskResults(userId, sessionId);
        if (previousResults) {
          formattedPrompt += previousResults;
        }
      }

      // Create image generation task with standard settings
      const task = {
        taskId: Date.now().toString(),
        userId,
        name: taskName,
        prompt: formattedPrompt,
        status: 'active',
        emailNotification: false,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        extractPageContent: false,
        outputAsJson: false,
        outputAsHtml: false, // Images don't need HTML output
        useSharedBrowser: false,
        turnOffHeadless: true,
        useKnowledgeBase: false,
        updateKnowledgeBase: false,
        updateLeadList: false,
        createVideo: false,
        category: category,
        description: `Image generation task: ${taskName}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Save task to database
      await taskDb.createTask(task);

      // Create task execution
      const execution = await taskDb.createTaskExecution({
        executionId: Date.now().toString(),
        taskId: task.taskId,
        userId: userId,
        status: 'pending',
        startTime: new Date().toISOString()
      });


      return {
        success: true,
        message: `Image generation task "${taskName}" has been created successfully. The task will start running shortly.`,
        status: 'pending',
        taskId: task.taskId,
        executionId: execution?.executionId,
        taskName: taskName
      };
    } catch (error) {
      console.error('AgentMode: Error creating image task from prompt:', error);
      return {
        success: false,
        message: 'Failed to create image generation task. Please try again.',
        status: 'error'
      };
    }
  }

  async generateSessionTitle(userMessage: string): Promise<string> {
    try {
      const defaultModel = await this.getDefaultModel();

      const response = await this.callLLM(defaultModel, [
        {
          role: 'system',
          content: `You are a session title generator for AgentWeb's Agent Mode. Based on the user's first message, generate a concise, descriptive title (max 60 characters) that captures the main marketing topic or task. Return ONLY the title, nothing else.`
        },
        { role: 'user', content: userMessage }
      ], {
        max_completion_tokens: 100
      });

      const title = response.choices[0]?.message?.content?.trim();

      return title || 'Marketing Task';
    } catch (error) {
      console.error('AgentMode: Failed to generate session title:', error);
      return 'Marketing Task';
    }
  }

  public async listMetaAdsCampaigns(userId: string): Promise<any> {
    try {
      // Import the Meta API functions
      const { getMetaAccessToken } = await import('../utils/secretsManager');
      const { userDb } = await import('./db');
      const { fetchWithRetryAndPaging } = await import('../utils/metaApiFetch');

      // Get user from database
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // Check if user has ad account configured
      if (!user.adAccount || user.adAccount.trim() === "") {
        return {
          success: false,
          message: 'Ad account not configured. Please configure your Meta ad account first.',
          error: 'Ad account not configured'
        };
      }

      // Get Meta API access token from Secrets Manager
      let accessToken: string;
      try {
        accessToken = await getMetaAccessToken();
      } catch (error: any) {
        console.error('AgentMode: Error fetching Meta access token:', error);
        return {
          success: false,
          message: 'Meta access token not configured. Please contact your administrator.',
          error: error.message || 'Failed to fetch access token from Secrets Manager'
        };
      }

      // Get API version from environment or default to v18.0
      const apiVersion = process.env.META_API_VERSION || 'v18.0';

      // Fetch campaigns
      console.log('AgentMode: Fetching Meta ad campaigns for user:', userId);
      const campaignsData = await fetchWithRetryAndPaging(
        `https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`
      );

      if (campaignsData.error) {
        console.error('AgentMode: Campaigns API Error:', campaignsData.error);
        return {
          success: false,
          message: `Failed to fetch campaigns: ${campaignsData.error.message}`,
          error: campaignsData.error.message
        };
      }

      const campaigns = (campaignsData.data || []).map((campaign: any) => ({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        objective: campaign.objective
      }));

      return {
        success: true,
        message: `Found ${campaigns.length} campaign(s)`,
        campaigns: campaigns,
        totalCount: campaigns.length
      };
    } catch (error) {
      console.error('AgentMode: Error fetching Meta ad campaigns:', error);
      return {
        success: false,
        message: 'Failed to fetch Meta ad campaigns. Please ensure your Meta ad account is properly configured.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async getMetaCredentials(userId: string, accountId?: string) {
    const { userDb } = await import('./db');
    const user = await userDb.getUserById(userId);
    if (!user) throw new Error('User not found');

    const connectedAccounts = user.connected_accounts || [];
    if (!Array.isArray(connectedAccounts)) {
      throw new Error('Invalid user account data');
    }

    // Helper to strip 'act_' prefix
    const clean = (id: string) => (id || '').replace('act_', '');

    // 1. Filter for valid Meta Ad Accounts
    // Check both 'facebook' and 'meta' for backward compatibility with accounts
    // created before the platform name was standardized to 'meta'.
    const fbAccounts = connectedAccounts.filter((acc: any) =>
      (acc.platform === 'facebook' || acc.platform === 'meta') &&
      acc.config?.account_type === 'ad_account' &&
      acc.config?.access_token
    );

    if (fbAccounts.length === 0) {
      console.error(`[AgentMode] No valid Meta connected account found for user ${userId}`);
      throw new Error('Meta ad account not connected. Please connect your Facebook account in settings.');
    }

    // 2. Handle specific account selection if accountId is provided
    if (accountId) {
      const cleanTargetId = clean(accountId);
      const selected = fbAccounts.find(acc => clean(acc.account_id || acc.config?.ad_account_id) === cleanTargetId);

      if (!selected) {
        throw new Error(`Meta ad account with ID "${accountId}" not found in connected accounts. Ensure you have the correct ID from list_connected_accounts.`);
      }

      if (selected.config.token_expires_at && selected.config.token_expires_at < Date.now()) {
        throw new Error('Meta access token has expired. Please reconnect your Meta account in settings.');
      }

      return {
        accountId: clean(selected.account_id || selected.config?.ad_account_id),
        accessToken: selected.config.access_token
      };
    }

    // 3. Handle multiple accounts ambiguity
    if (fbAccounts.length > 1) {
      const accountList = fbAccounts
        .map(acc => {
          const id = clean(acc.account_id || acc.config?.ad_account_id);
          return `${acc.account_name} (ID: act_${id})`;
        })
        .join(', ');
      throw new Error(`Multiple Meta accounts found: [${accountList}]. Specify which one to use.`);
    }

    // 4. Default to the single available account
    const selected = fbAccounts[0];

    if (selected.config.token_expires_at && selected.config.token_expires_at < Date.now()) {
      throw new Error('Meta access token has expired. Please reconnect your Meta account in settings.');
    }

    console.log(`[AgentMode] Using Meta credentials from connected_accounts for user ${userId} (Account: ${selected.account_name})`);

    return {
      accountId: clean(selected.account_id || selected.config?.ad_account_id),
      accessToken: selected.config.access_token
    };
  }

  /**
  * Secure wrapper for Meta Ads Insights API calls (always async, with internal polling)
  */
  public async callMetaAdsInsightsApiWrapper(
    userId: string,
    args: {
      account_id: string;
      object_type: AllowedNodeType;
      object_id?: string;
      fields: string[];
      date_preset?: string;
      time_range?: { since: string; until: string };
      level?: AllowedNodeType;
      breakdowns?: string[];
      action_breakdowns?: string[];
      filtering?: any[];
    }
  ): Promise<any> {
    try {
      const {
        account_id,
        object_type,
        object_id,
        fields,
        date_preset,
        time_range,
        level,
        breakdowns,
        action_breakdowns,
        filtering,
      } = args;

      if (!ALLOWED_NODE_TYPES.includes(object_type)) {
        throw new Error(`Invalid object_type: ${object_type}`);
      }

      if (!fields?.length) {
        throw new Error("fields array is required");
      }

      const invalidFields = fields.filter(
        (f) => !ALLOWED_INSIGHTS_FIELDS.includes(f)
      );

      if (invalidFields.length) {
        throw new Error(
          `Invalid insights fields requested: ${invalidFields.join(", ")}`
        );
      }

      if (breakdowns?.length) {
        const invalidBreakdowns = breakdowns.filter(
          (b) => !ALLOWED_INSIGHTS_BREAKDOWNS.includes(b)
        );

        if (invalidBreakdowns.length) {
          throw new Error(
            `Invalid breakdowns requested: ${invalidBreakdowns.join(", ")}. Allowed: ${ALLOWED_INSIGHTS_BREAKDOWNS.join(", ")}`
          );
        }
      }

      // Validate action_breakdowns
      if (action_breakdowns?.length) {
        const invalidActionBreakdowns = action_breakdowns.filter(
          (ab) => !ALLOWED_ACTION_BREAKDOWNS.includes(ab)
        );
        if (invalidActionBreakdowns.length) {
          throw new Error(
            `Invalid action_breakdowns requested: ${invalidActionBreakdowns.join(", ")}. Allowed: ${ALLOWED_ACTION_BREAKDOWNS.join(", ")}`
          );
        }
      }

      // Validate level
      if (level && !ALLOWED_NODE_TYPES.includes(level)) {
        throw new Error(
          `Invalid level: ${level}. Allowed: ${ALLOWED_NODE_TYPES.join(", ")}`
        );
      }

      // Date validation (mutually exclusive)
      if (date_preset && time_range) {
        throw new Error("Provide either date_preset or time_range, not both.");
      }

      // Validate date_preset value
      if (date_preset && !ALLOWED_DATE_PRESETS.includes(date_preset)) {
        throw new Error(
          `Invalid date_preset: "${date_preset}". Allowed: ${ALLOWED_DATE_PRESETS.join(", ")}`
        );
      }

      // Validate time_range format and logic
      if (time_range) {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!time_range.since || !dateRegex.test(time_range.since)) {
          throw new Error(`time_range.since must be in YYYY-MM-DD format (got "${time_range.since}").`);
        }
        if (!time_range.until || !dateRegex.test(time_range.until)) {
          throw new Error(`time_range.until must be in YYYY-MM-DD format (got "${time_range.until}").`);
        }
        if (time_range.since > time_range.until) {
          throw new Error(`time_range.since (${time_range.since}) must be on or before time_range.until (${time_range.until}).`);
        }
      }

      const { accountId, accessToken } =
        await this.getMetaCredentials(userId, account_id);

      const actualNodeId =
        object_type === "account"
          ? `act_${accountId}`
          : object_id ??
            (() => {
              throw new Error(
                `object_id is required for object_type ${object_type}`
              );
            })();

      const version = process.env.META_API_VERSION || "v24.0";
      const baseUrl = `https://graph.facebook.com/${version}`;
      const submitUrl = `${baseUrl}/${actualNodeId}/insights`;

      const filteredParams = {
        fields: fields.join(","),
        limit: 5000,

        ...(date_preset && { date_preset }),
        ...(time_range && { time_range }),
        ...(level && { level }),
        ...(breakdowns?.length && {
          breakdowns: breakdowns.join(","),
        }),
        ...(action_breakdowns?.length && {
          action_breakdowns: action_breakdowns.join(","),
        }),
        ...(filtering?.length && { filtering }),
      };

      const submitRes = await axios.post(submitUrl, {
        ...filteredParams,
        access_token: accessToken,
      });

      const reportRunId = (submitRes.data as any)?.report_run_id;

      if (!reportRunId) {
        throw new Error("Failed to get report_run_id from Meta");
      }

      // Polling Engine
      let attempts = 0;
      const maxAttempts = 60;

      while (attempts < maxAttempts) {
        attempts++;

        await new Promise((resolve) => setTimeout(resolve, 10000));

        const statusRes = await axios.get(`${baseUrl}/${reportRunId}`, {
          params: { access_token: accessToken },
        });

        const status = (statusRes.data as any)?.async_status;

        if (status === "Job Completed") break;

        if (status === "Job Failed" || status === "Job Skipped") {
          throw new Error(`Meta Insights Job failed: ${status}`);
        }

        if (attempts === maxAttempts) {
          throw new Error("Meta Insights Job timed out.");
        }
      }

      // Fetch Paginated Results
      const resultsUrl = `${baseUrl}/${reportRunId}/insights`;

      let allData: any[] = [];
      let nextUrl: string | null = resultsUrl;
      let isFirstRequest = true;

      while (nextUrl) {
        const res: any = isFirstRequest
          ? await axios.get(nextUrl, { params: { access_token: accessToken } })
          : await axios.get(nextUrl); // paging.next already includes token
        allData.push(...(res.data?.data || []));
        nextUrl = res.data?.paging?.next || null;
        isFirstRequest = false;
      }

      const envelope = {
        metadata: {
          requested_at: new Date().toISOString(),
          tool: "call_meta_ads_insights_api",
          object_type,
          object_id: object_id || null,
          account_id,
          query: filteredParams,
          report_run_id: reportRunId,
          api_version: version,
        },
        data: allData,
      };

      const filename = `insights_${actualNodeId}_${Date.now()}.json`;

      const s3Result = await uploadFileToS3(
        JSON.stringify(envelope, null, 2),
        filename,
        userId,
        "application/json"
      );

      return { success: true, s3_url: s3Result.url, totalRows: allData.length };

    } catch (error: any) {
      console.error("Error in callMetaAdsInsightsApiWrapper:", error);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  // --- Unified Meta Ads Manager Methods ---
  public async manageMetaAdsCampaigns(userId: string, action: 'LIST' | 'CREATE' | 'UPDATE' | 'DELETE', account_id: string, campaign_id?: string, params: any = {}): Promise<MetaApiResult> {
    switch (action) {
      case 'LIST':
        return this.listMetaAdsCampaignsNew(userId, account_id);
      case 'CREATE':
        return this.createMetaAdsCampaign(userId, { ...params, account_id });
      case 'UPDATE':
        if (!campaign_id) throw new Error('campaign_id is required for UPDATE action');
        console.log(`AgentMode: Updating campaign ${campaign_id} with params:`, params);
        return this.updateMetaAdsCampaign(userId, campaign_id, params, account_id);
      case 'DELETE':
        if (!campaign_id) throw new Error('campaign_id is required for DELETE action');
        return this.deleteMetaAdsCampaign(userId, campaign_id, account_id);
      default:
        throw new Error(`Invalid action: ${action}`);
    }
  }

  public async manageMetaAdsAdSets(userId: string, action: 'LIST' | 'CREATE' | 'UPDATE' | 'DELETE', account_id: string, campaign_id?: string, ad_set_id?: string, params: any = {}): Promise<MetaApiResult> {
    switch (action) {
      case 'LIST':
        return this.listMetaAdsAdSets(userId, campaign_id, account_id);
      case 'CREATE':
        // Explicitly pass account_id in args for createMetaAdsAdSet as it expects it in the args object
        return this.createMetaAdsAdSet(userId, { ...params, account_id, campaign_id });
      case 'UPDATE':
        if (!ad_set_id) throw new Error('ad_set_id is required for UPDATE action');
        console.log(`AgentMode: Updating ad set ${ad_set_id} with params:`, params);
        return this.updateMetaAdsAdSet(userId, ad_set_id, params, account_id);
      case 'DELETE':
        if (!ad_set_id) throw new Error('ad_set_id is required for DELETE action');
        return this.deleteMetaAdsAdSet(userId, ad_set_id, account_id);
      default:
        throw new Error(`Invalid action: ${action}`);
    }
  }

  public async manageMetaAdsAdCreatives(userId: string, action: 'LIST' | 'CREATE' | 'UPLOAD_IMAGE' | 'UPLOAD_VIDEO', account_id: string, params: any = {}): Promise<MetaApiResult> {
    switch (action) {
      case 'LIST':
        return this.listMetaAdsAdCreatives(userId, account_id);
      case 'CREATE':
        return this.createMetaAdsAdCreative(userId, { ...params, account_id });
      case 'UPLOAD_IMAGE':
          if (!params.image_url) throw new Error('image_url is required for UPLOAD_IMAGE action');
          return this.uploadMetaAdsImage(userId, params.image_url, account_id);
      case 'UPLOAD_VIDEO':
          if (!params.video_url && !params.image_url) throw new Error('video_url (or image_url as proxy) is required for UPLOAD_VIDEO action');
          return this.uploadMetaAdsVideo(userId, params.video_url || params.image_url, account_id);
      default:
        throw new Error(`Invalid action: ${action}`);
    }
  }

  public async manageMetaAdsAds(userId: string, action: 'LIST' | 'CREATE' | 'UPDATE' | 'DELETE', account_id: string, ad_set_id?: string, ad_id?: string, params: any = {}): Promise<MetaApiResult> {
    switch (action) {
      case 'LIST':
        return this.listMetaAdsAds(userId, ad_set_id, account_id);
      case 'CREATE':
         return this.createMetaAdsAd(userId, { ...params, account_id, adset_id: ad_set_id });
      case 'UPDATE':
        if (!ad_id) throw new Error('ad_id is required for UPDATE action');
        console.log(`AgentMode: Updating ad ${ad_id} with params:`, params);
        return this.updateMetaAdsAd(userId, ad_id, params, account_id);
      case 'DELETE':
        if (!ad_id) throw new Error('ad_id is required for DELETE action');
        return this.deleteMetaAdsAd(userId, ad_id, account_id);
      default:
        throw new Error(`Invalid action: ${action}`);
    }
  }

  public async listMetaPages(userId: string, account_id?: string): Promise<any> {
    try {
      const { accessToken } = await this.getMetaCredentials(userId, account_id);
      const pages = await metaService.getPages(accessToken);
      const totalCount = Array.isArray(pages) ? pages.length : 0;

      return {
        success: true,
        message: `Found ${totalCount} Facebook Page(s)`,
        pages: pages,
        totalCount: totalCount
      };
    } catch (error: any) {
      console.error('AgentMode: Error fetching Meta pages:', error);
      return {
        success: false,
        message: error.message || 'Failed to fetch Meta pages.',
        error: error.message
      };
    }
  }

  public async listMetaAdsCampaignsNew(userId: string, account_id?: string): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, account_id);
      const campaigns = (await metaService.listCampaigns(accountId, accessToken)) || [];
      const totalCount = Array.isArray(campaigns) ? campaigns.length : 0;

      return {
        success: true,
        message: `Found ${totalCount} campaign(s)`,
        campaigns: campaigns,
        totalCount: totalCount
      };
    } catch (error: any) {
      console.error('AgentMode: Error fetching Meta ad campaigns:', error);
      return {
        success: false,
        message: error.message || 'Failed to fetch Meta ad campaigns.',
        error: error.message
      };
    }
  }

  public async createMetaAdsCampaign(userId: string, params: MetaAdsCampaignParams & { account_id?: string }): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, params.account_id);
      const campaign = await metaService.createCampaign(accountId, accessToken, params);

      return {
        success: true,
        message: `Campaign "${campaign.name}" created successfully`,
        campaign: campaign
      };
    } catch (error: any) {
      console.error('AgentMode: Error creating Meta ad campaign:', error);
      return {
        success: false,
        message: this.enrichMetaError(error, 'create Meta ad campaign'),
        error: error.message,
        details: error.structuredError
      };
    }
  }

  public async listMetaAdsAdSets(userId: string, campaignId?: string, account_id?: string): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, account_id);
      const adSets = (await metaService.listAdSets(accountId, accessToken, campaignId)) || [];
      const totalCount = Array.isArray(adSets) ? adSets.length : 0;

      return {
        success: true,
        message: `Found ${totalCount} ad set(s)`,
        adSets: adSets,
        totalCount: totalCount
      };
    } catch (error: any) {
      console.error('AgentMode: Error fetching Meta ad sets:', error);
      return {
        success: false,
        message: error.message || 'Failed to fetch Meta ad sets.',
        error: error.message
      };
    }
  }

  public async createMetaAdsAdSet(userId: string, args: any): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, args.account_id);

      // --- Deterministic Validation Engine ---

      // 0. Fetch campaign to resolve objective and detect Advantage Campaign Budget (CBO)
      const campaign = await metaService.getCampaign(accountId, accessToken, args.campaign_id);
      const objective = args.campaign_objective || campaign.objective;
      const campaignHasBudget = !!(campaign.daily_budget || campaign.lifetime_budget);

      // 1. Budget Validation — depends on whether campaign has ACB/CBO
      const dailyBudget = args.daily_budget;
      const lifetimeBudget = args.lifetime_budget;

      if (campaignHasBudget) {
        // Campaign has Advantage Campaign Budget (CBO) — ad set must NOT have its own budget
        if (dailyBudget !== undefined || lifetimeBudget !== undefined) {
          console.log(`[MetaAdSet] Campaign ${args.campaign_id} has Advantage Campaign Budget enabled (campaign budget: daily=${campaign.daily_budget}, lifetime=${campaign.lifetime_budget}). Stripping ad set budget to avoid conflict.`);
        }
        // Strip budget fields — CBO campaigns manage budget at campaign level
        delete args.daily_budget;
        delete args.lifetime_budget;
      } else {
        // No CBO — ad set must have its own budget
        if (dailyBudget !== undefined && lifetimeBudget !== undefined) {
          throw new Error('Exactly one of daily_budget or lifetime_budget must be provided, not both.');
        }
        if (dailyBudget === undefined && lifetimeBudget === undefined) {
          throw new Error('Either daily_budget or lifetime_budget must be provided (campaign does not have Advantage Campaign Budget).');
        }

        const budget = dailyBudget ?? lifetimeBudget;
        if (budget < 1.00) {
          throw new Error('Minimum budget must be at least $1.00 USD.');
        }

        // Hallucination Guard
        if (dailyBudget > 5000) throw new Error('Daily budget exceeds safety limit of $5,000.');
        if (lifetimeBudget > 50000) throw new Error('Lifetime budget exceeds safety limit of $50,000.');
      }

      // 2. Schedule Enforcement
      if (lifetimeBudget !== undefined && !campaignHasBudget && !args.end_time) {
        throw new Error('end_time is required when using a lifetime_budget.');
      }

      const startTime = args.start_time ? new Date(args.start_time) : new Date();
      const endTime = args.end_time ? new Date(args.end_time) : null;

      if (endTime) {
        if (startTime >= endTime) {
          throw new Error('start_time must be strictly before end_time.');
        }

        // 24h Duration Enforcement for Lifetime Budget
        if (lifetimeBudget !== undefined && !campaignHasBudget) {
          const durationHrs = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
          if (durationHrs < 24) {
            throw new Error('Lifetime budget campaigns must have a duration of at least 24 hours.');
          }
        }
      }

      // Auto-set start_time for ACTIVE status if missing
      if (args.status === 'ACTIVE' && !args.start_time) {
        args.start_time = new Date().toISOString();
      }

      // 3. Campaign Objective & Goal/Billing Compatibility
      const allowedGoals = META_OBJ_GOAL_MAP[objective];
      if (!allowedGoals || !allowedGoals.includes(args.optimization_goal)) {
        throw new Error(`Optimization goal "${args.optimization_goal}" is not compatible with campaign objective "${objective}". Allowed: ${allowedGoals?.join(', ') || 'none'}`);
      }

      const allowedBilling = META_GOAL_BILLING_MAP[args.optimization_goal];
      if (!allowedBilling || !allowedBilling.includes(args.billing_event)) {
        throw new Error(`Billing event "${args.billing_event}" is not compatible with optimization goal "${args.optimization_goal}". Allowed: ${allowedBilling?.join(', ') || 'none'}`);
      }

      // 4. Bidding Strategy rules
      const strategy = args.bid_strategy || 'LOWEST_COST_WITHOUT_CAP';
      if (strategy === 'LOWEST_COST_WITH_MIN_ROAS') {
        throw new Error('ROAS bidding (LOWEST_COST_WITH_MIN_ROAS) is not yet supported.');
      }

      // Validate bid strategy compatibility with optimization goal
      const allowedStrategies = META_GOAL_BID_STRATEGY_MAP[args.optimization_goal];
      if (allowedStrategies && !allowedStrategies.includes(strategy)) {
        throw new Error(`Bid strategy "${strategy}" is not compatible with optimization goal "${args.optimization_goal}". Allowed: ${allowedStrategies.join(', ')}`);
      }

      if (strategy === 'LOWEST_COST_WITHOUT_CAP' && args.bid_amount !== undefined) {
        throw new Error('bid_amount must not be provided for LOWEST_COST_WITHOUT_CAP strategy.');
      }
      if ((strategy === 'LOWEST_COST_WITH_BID_CAP' || strategy === 'COST_CAP') && args.bid_amount === undefined) {
        throw new Error(`bid_amount is required for ${strategy} strategy.`);
      }

      // Bid amount min/max guard
      if (args.bid_amount !== undefined) {
        if (args.bid_amount < 0.01) {
          throw new Error('bid_amount must be at least $0.01.');
        }
        if (args.bid_amount > 1000) {
          throw new Error('bid_amount exceeds safety limit of $1,000.');
        }
      }

      // 5. Targeting Guardrails
      if (!args.targeting || typeof args.targeting !== 'object') {
        throw new Error('Targeting object is required.');
      }
      if (!args.targeting.geo_locations || Object.keys(args.targeting.geo_locations).length === 0) {
        throw new Error('targeting.geo_locations is required and cannot be empty.');
      }
      const geo = args.targeting.geo_locations;
      if (!geo.countries && !geo.regions && !geo.cities && !geo.zips) {
        throw new Error('targeting.geo_locations must contain at least one of: countries, regions, cities, or zips.');
      }

      // Validate geo arrays are non-empty (e.g. countries: [] is invalid)
      const geoFields = ['countries', 'regions', 'cities', 'zips'] as const;
      for (const field of geoFields) {
        if (geo[field] && Array.isArray(geo[field]) && geo[field].length === 0) {
          throw new Error(`targeting.geo_locations.${field} cannot be an empty array. Either provide values or omit the field.`);
        }
      }

      // Age validation
      if (args.targeting.age_min !== undefined && args.targeting.age_min < 18) {
        throw new Error('targeting.age_min must be at least 18.');
      }
      if (args.targeting.age_max !== undefined && args.targeting.age_max > 65) {
        throw new Error('targeting.age_max must be at most 65.');
      }
      if (args.targeting.age_min !== undefined && args.targeting.age_max !== undefined) {
        if (args.targeting.age_min > args.targeting.age_max) {
          throw new Error(`targeting.age_min (${args.targeting.age_min}) cannot be greater than age_max (${args.targeting.age_max}).`);
        }
      }

      // --- Prepared Params for SDK layer ---

      // 6. Advantage Audience — Meta requires targeting_automation.advantage_audience to be
      //    explicitly set to 0 or 1 (error_subcode 1870227 if missing). Default to 0 (disabled).
      if (!args.targeting.targeting_automation || args.targeting.targeting_automation.advantage_audience === undefined) {
        args.targeting = {
          ...args.targeting,
          targeting_automation: {
            ...(args.targeting.targeting_automation || {}),
            advantage_audience: 0
          }
        };
        console.log('[MetaAdSet] Auto-set targeting_automation.advantage_audience=0 (Meta requires this field)');
      }

      // Convert all currencies to cents
      const toCents = (val?: number) => val !== undefined ? Math.round(val * 100) : undefined;

      const normalizedParams: MetaAdsAdSetParams = {
        ...args,
        daily_budget: campaignHasBudget ? undefined : toCents(args.daily_budget),
        lifetime_budget: campaignHasBudget ? undefined : toCents(args.lifetime_budget),
        bid_amount: toCents(args.bid_amount),
        bid_strategy: strategy // Ensure we use the resolved strategy
      };

      const adSet = await metaService.createAdSet(accountId, accessToken, normalizedParams);

      return {
        success: true,
        message: `Ad set "${adSet.name}" created successfully`,
        adSet: adSet
      };
    } catch (error: any) {
      console.error('AgentMode: Error creating Meta ad set:', error);
      return {
        success: false,
        message: this.enrichMetaError(error, 'create Meta ad set'),
        error: error.message,
        details: error.structuredError
      };
    }
  }

  public async listMetaAdsAdCreatives(userId: string, account_id?: string): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, account_id);
      const creatives = (await metaService.listAdCreatives(accountId, accessToken)) || [];
      const totalCount = Array.isArray(creatives) ? creatives.length : 0;

      return {
        success: true,
        message: `Found ${totalCount} ad creative(s)`,
        creatives: creatives,
        totalCount: totalCount
      };
    } catch (error: any) {
      console.error('AgentMode: Error fetching Meta ad creatives:', error);
      return {
        success: false,
        message: error.message || 'Failed to fetch Meta ad creatives.',
        error: error.message
      };
    }
  }

  public async createMetaAdsAdCreative(userId: string, params: MetaAdsAdCreativeParams & { account_id?: string }): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, params.account_id);
      const creative = await metaService.createAdCreative(accountId, accessToken, params);

      return {
        success: true,
        message: `Ad creative "${creative.name}" created successfully`,
        creative: creative
      };
    } catch (error: any) {
      console.error('AgentMode: Error creating Meta ad creative:', error);
      return {
        success: false,
        message: this.enrichMetaError(error, 'create Meta ad creative'),
        error: error.message,
        details: error.structuredError
      };
    }
  }

  public async listMetaAdsAds(userId: string, adSetId?: string, account_id?: string): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, account_id);
      const ads = (await metaService.listAds(accountId, accessToken, adSetId)) || [];
      const totalCount = Array.isArray(ads) ? ads.length : 0;

      return {
        success: true,
        message: `Found ${totalCount} ad(s)`,
        ads: ads,
        totalCount: totalCount
      };
    } catch (error: any) {
      console.error('AgentMode: Error fetching Meta ads:', error);
      return {
        success: false,
        message: error.message || 'Failed to fetch Meta ads.',
        error: error.message
      };
    }
  }

  public async createMetaAdsAd(userId: string, params: MetaAdsAdParams & { account_id?: string }): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, params.account_id);
      const ad = await metaService.createAd(accountId, accessToken, params);

      return {
        success: true,
        message: `Ad "${ad.name}" created successfully`,
        ad: ad
      };
    } catch (error: any) {
      console.error('AgentMode: Error creating Meta ad:', error);
      return {
        success: false,
        message: this.enrichMetaError(error, 'create Meta ad'),
        error: error.message,
        details: error.structuredError
      };
    }
  }

  public async updateMetaAdsCampaign(userId: string, campaignId: string, params: any, account_id?: string): Promise<any> {
    try {
      const { accessToken } = await this.getMetaCredentials(userId, account_id);
      await metaService.updateCampaign(accessToken, campaignId, params);
      return {
        success: true,
        message: `Campaign updated successfully`
      };
    } catch (error: any) {
      console.error('AgentMode: Error updating Meta ad campaign:', error);
      return {
        success: false,
        message: error.message || 'Failed to update Meta ad campaign.',
        error: error.message
      };
    }
  }

  public async deleteMetaAdsCampaign(userId: string, campaignId: string, account_id?: string): Promise<any> {
    try {
      const { accessToken } = await this.getMetaCredentials(userId, account_id);
      await metaService.deleteCampaign(accessToken, campaignId);
      return {
        success: true,
        message: `Campaign deleted successfully`
      };
    } catch (error: any) {
      console.error('AgentMode: Error deleting Meta ad campaign:', error);
      return {
        success: false,
        message: error.message || 'Failed to delete Meta ad campaign.',
        error: error.message
      };
    }
  }

  public async updateMetaAdsAdSet(userId: string, adSetId: string, params: any, account_id?: string): Promise<any> {
    try {
      const { accessToken } = await this.getMetaCredentials(userId, account_id);
      await metaService.updateAdSet(accessToken, adSetId, params);
      return {
        success: true,
        message: `Ad set updated successfully`
      };
    } catch (error: any) {
      console.error('AgentMode: Error updating Meta ad set:', error);
      return {
        success: false,
        message: error.message || 'Failed to update Meta ad set.',
        error: error.message
      };
    }
  }

  public async deleteMetaAdsAdSet(userId: string, adSetId: string, account_id?: string): Promise<any> {
    try {
      const { accessToken } = await this.getMetaCredentials(userId, account_id);
      await metaService.deleteAdSet(accessToken, adSetId);
      return {
        success: true,
        message: `Ad set deleted successfully`
      };
    } catch (error: any) {
      console.error('AgentMode: Error deleting Meta ad set:', error);
      return {
        success: false,
        message: error.message || 'Failed to delete Meta ad set.',
        error: error.message
      };
    }
  }

  public async updateMetaAdsAd(userId: string, adId: string, params: any, account_id?: string): Promise<any> {
    try {
      const { accessToken } = await this.getMetaCredentials(userId, account_id);
      await metaService.updateAd(accessToken, adId, params);
      return {
        success: true,
        message: `Ad updated successfully`
      };
    } catch (error: any) {
      console.error('AgentMode: Error updating Meta ad:', error);
      return {
        success: false,
        message: error.message || 'Failed to update Meta ad.',
        error: error.message
      };
    }
  }

  public async deleteMetaAdsAd(userId: string, adId: string, account_id?: string): Promise<any> {
    try {
      const { accessToken } = await this.getMetaCredentials(userId, account_id);
      await metaService.deleteAd(accessToken, adId);
      return {
        success: true,
        message: `Ad deleted successfully`
      };
    } catch (error: any) {
      console.error('AgentMode: Error deleting Meta ad:', error);
      return {
        success: false,
        message: error.message || 'Failed to delete Meta ad.',
        error: error.message
      };
    }
  }

  public async uploadMetaAdsImage(userId: string, imageUrl: string, account_id?: string): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, account_id);
      
      // Download image from URL
      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data as any);
      // Simple filename extraction or default
      let filename = 'ad-image.jpg';
      try {
        const urlObj = new URL(imageUrl);
        const pathname = urlObj.pathname;
        const potentialFilename = path.basename(pathname);
        if (potentialFilename && potentialFilename.length > 0 && potentialFilename.includes('.')) {
          filename = potentialFilename;
        }
      } catch (e) {
        // ignore
      }

      const image = await metaService.uploadImage(accountId, accessToken, filename, buffer);
      return {
        success: true,
        message: `Image uploaded successfully`,
        image: image
      };
    } catch (error: any) {
      console.error('AgentMode: Error uploading Meta ad image:', error);
      return {
        success: false,
        message: error.message || 'Failed to upload Meta ad image.',
        error: error.message
      };
    }
  }

  public async uploadMetaAdsVideo(userId: string, videoUrl: string, account_id?: string): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, account_id);
      
      console.log(`AgentMode: Uploading video to Meta Ads (Account: ${accountId})`);
      const video = await metaService.uploadVideo(accountId, accessToken, videoUrl);

      return {
        success: true,
        message: `Video "${videoUrl}" uploaded successfully`,
        video: video
      };
    } catch (error: any) {
      console.error('AgentMode: Error uploading Meta ad video:', error);
      return {
        success: false,
        message: error.message || 'Failed to upload Meta ad video. Ensure the URL is publicly accessible.',
        error: error.message
      };
    }
  }

  public async getMetaAdsMetrics(timeframe: string, userId: string, campaign_ids: string[] | string): Promise<any> {
    try {

      // Import the Meta API functions directly to reuse the same logic
      const { getMetaAccessToken } = await import('../utils/secretsManager');
      const { userDb } = await import('./db');
      const { fetchWithRetryAndPaging } = await import('../utils/metaApiFetch');

      // Get user from database
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // Check if user has ad account configured
      if (!user.adAccount || user.adAccount.trim() === "") {
        return {
          success: false,
          message: 'Ad account not configured. Please configure your Meta ad account first.',
          error: 'Ad account not configured'
        };
      }

      // Get Meta API access token from Secrets Manager
      let accessToken: string;
      try {
        accessToken = await getMetaAccessToken();
      } catch (error: any) {
        console.error('AgentMode: Error fetching Meta access token:', error);
        return {
          success: false,
          message: 'Meta access token not configured. Please contact your administrator.',
          error: error.message || 'Failed to fetch access token from Secrets Manager'
        };
      }

      // Get API version from environment or default to v18.0
      const apiVersion = process.env.META_API_VERSION || 'v18.0';

      // Calculate date range based on timeframe
      // Exclude today since it's not fully complete - use yesterday as end date
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1); // Set to yesterday
      const startDate = new Date(endDate); // Copy endDate
      if (timeframe === "7d") {
        startDate.setDate(endDate.getDate() - 6); // 7 days total (yesterday - 6 = 7 days)
      } else if (timeframe === "14d") {
        startDate.setDate(endDate.getDate() - 13); // 14 days total
      } else if (timeframe === "30d") {
        startDate.setDate(endDate.getDate() - 29); // 30 days total
      } else if (timeframe === "90d") {
        startDate.setDate(endDate.getDate() - 89); // 90 days total
      }
      const sinceStr = startDate.toISOString().split('T')[0];
      const untilStr = endDate.toISOString().split('T')[0];
      const attributionDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))) + 1; // +1 to include both start and end dates

      // Build filtering parameter for API calls from campaign_ids
      let campaignFilterIds: string[] = [];
      const rawCampaignIds = Array.isArray(campaign_ids)
        ? campaign_ids
        : (typeof campaign_ids === 'string' ? [campaign_ids] : []);
      campaignFilterIds = [...new Set(rawCampaignIds.map((id) => String(id).trim()).filter(Boolean))];
      console.log('AgentMode: Filtering metrics by campaign IDs:', campaignFilterIds);
      if (campaignFilterIds.length === 0) {
        return {
          success: false,
          message: 'campaign_ids is required and must contain at least one campaign ID.',
          error: 'Invalid campaign_ids'
        };
      }

      // Build filtering parameter for API calls
      const filteringParam = campaignFilterIds.length > 0
        ? `&filtering=[{"field":"campaign.id","operator":"IN","value":["${campaignFilterIds.join('","')}"]}]`
        : '';


      // Get campaigns, ad sets, ads, and insights using Graph API - fetch at multiple levels
      // Using fetchWithRetryAndPaging to automatically handle pagination if there are multiple pages
      const [campaignsData, adSetsData, adsData, adInsightsData, adSetInsightsData, campaignInsightsData, insightsDemographicsData, insightsPlacementData, insightsDeviceData] = await Promise.all([
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/campaigns?fields=id,name,status,objective${filteringParam}&access_token=${accessToken}`),
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/adsets?fields=id,name,status,campaign_id,targeting${filteringParam}&access_token=${accessToken}`),
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/ads?fields=id,name,status,adset_id,campaign_id,creative{thumbnail_url,title,body,image_url}${filteringParam}&access_token=${accessToken}`),
        // Ad-level insights for ads processing
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,ad_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=ad${filteringParam}&access_token=${accessToken}`),
        // Adset-level insights for ad sets processing
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=adset${filteringParam}&access_token=${accessToken}`),
        // Campaign-level insights for campaigns processing
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
        // Demographics breakdown (age/gender)
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=age,gender&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
        // Placement breakdown (publisher platform and position)
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=publisher_platform,platform_position&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
        // Device breakdown (mobile/desktop, etc.)
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=impression_device&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`)
      ]);


      // Check for errors in any of the responses
      if (campaignsData.error) {
        console.error('AgentMode: Campaigns API Error:', campaignsData.error);
        throw new Error(`Campaigns API Error: ${campaignsData.error.message}`);
      }
      if (adSetsData.error) {
        console.error('AgentMode: Ad Sets API Error:', adSetsData.error);
        throw new Error(`Ad Sets API Error: ${adSetsData.error.message}`);
      }
      if (adsData.error) {
        console.error('AgentMode: Ads API Error:', adsData.error);
        throw new Error(`Ads API Error: ${adsData.error.message}`);
      }
      if (adInsightsData.error) {
        console.error('AgentMode: Ad-level Insights API Error:', adInsightsData.error);
        throw new Error(`Ad-level Insights API Error: ${adInsightsData.error.message}`);
      }
      if (adSetInsightsData.error) {
        console.error('AgentMode: Adset-level Insights API Error:', adSetInsightsData.error);
        throw new Error(`Adset-level Insights API Error: ${adSetInsightsData.error.message}`);
      }
      if (campaignInsightsData.error) {
        console.error('AgentMode: Campaign-level Insights API Error:', campaignInsightsData.error);
        throw new Error(`Campaign-level Insights API Error: ${campaignInsightsData.error.message}`);
      }
      if (insightsDemographicsData.error) {
        console.error('AgentMode: Demographics Insights API Error:', insightsDemographicsData.error);
        // Don't throw; proceed without demographics
      }
      if (insightsPlacementData.error) {
        console.error('AgentMode: Placement Insights API Error:', insightsPlacementData.error);
        // Don't throw; proceed without placements
      }
      if (insightsDeviceData.error) {
        console.error('AgentMode: Device Insights API Error:', insightsDeviceData.error);
        // Don't throw; proceed without devices
      }

      // Process the data using simplified logic (filtering is now done at API level)
      const adPerformance = this.processCampaignData(campaignsData.data || [], campaignInsightsData.data || [], adSetsData.data || []);
      const processedAdSetsData = this.processAdSetsData(adSetsData.data || [], adSetInsightsData.data || [], campaignsData.data || []);
      const processedAdsData = this.processAdsData(adsData.data || [], adInsightsData.data || [], adSetsData.data || [], campaignsData.data || []);
      const campaignSummary = this.generateCampaignSummary(adPerformance);
      // Filter breakdown data by campaign if filtering is applied
      let demographicsBreakdown = insightsDemographicsData?.data || [];
      let placementBreakdown = insightsPlacementData?.data || [];
      let deviceBreakdown = insightsDeviceData?.data || [];

      if (campaignFilterIds.length > 0) {
        demographicsBreakdown = demographicsBreakdown.filter((item: any) =>
          item.campaign_id && campaignFilterIds.includes(item.campaign_id)
        );
        placementBreakdown = placementBreakdown.filter((item: any) =>
          item.campaign_id && campaignFilterIds.includes(item.campaign_id)
        );
        deviceBreakdown = deviceBreakdown.filter((item: any) =>
          item.campaign_id && campaignFilterIds.includes(item.campaign_id)
        );
      }

      const processedDemographicsBreakdown = this.processBreakdownData(demographicsBreakdown);
      const processedPlacementBreakdown = this.processBreakdownData(placementBreakdown);
      const processedDeviceBreakdown = this.processBreakdownData(deviceBreakdown);

      // Format the data for LLM consumption
      const formattedContent = await this.formatMetricsSummary({
        adPerformance,
        adSetsData: processedAdSetsData,
        adsData: processedAdsData,
        campaignSummary,
        demographicsBreakdown: processedDemographicsBreakdown,
        placementBreakdown: processedPlacementBreakdown,
        deviceBreakdown: processedDeviceBreakdown,
        attributionWindow: { start: sinceStr, end: untilStr, days: attributionDays },
        timeframe
      }, userId);

      const result = {
        success: true,
        message: `Meta ads metrics loaded for ${timeframe} timeframe`,
        timeframe,
        attributionWindow: { start: sinceStr, end: untilStr, days: attributionDays },
        campaignSummary,
        formattedContent
      };

      return result;
    } catch (error) {
      console.error('AgentMode: Error fetching Meta ads metrics:', error);
      console.error('AgentMode: Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      return {
        success: false,
        message: 'Failed to fetch Meta ads metrics. Please ensure your Meta ad account is properly configured.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Translate known Meta API error subcodes into actionable messages for Emma.
   * Returns an enriched message string (falls back to original if subcode unknown).
   */
  private enrichMetaError(error: any, context: string): string {
    const subcode = error.structuredError?.error_subcode ?? error.response?.error_subcode;
    const code = error.structuredError?.code ?? error.response?.code;
    const originalMsg = error.message || `Failed to ${context}.`;

    switch (subcode) {
      case 1341012:
        return (
          'Page permission denied (subcode 1341012): The page_id used is not accessible with your current credentials. ' +
          'Run PAGE LIST to get the pages you have permission to manage, pick the correct one, and retry.'
        );
      case 1443226:
        return (
          'Missing video thumbnail (subcode 1443226): Video creatives require a thumbnail. ' +
          'Upload a thumbnail image via AD_CREATIVE UPLOAD_IMAGE and pass the returned image_hash alongside video_id.'
        );
      case 1870227:
        return (
          'Advantage Audience flag required (subcode 1870227): Add targeting_automation: { advantage_audience: 0 } ' +
          'inside the targeting object and retry.'
        );
      default:
        // Enrich with error_user_msg from Meta if available (more human-readable than raw message)
        if (code === 10) {
          return `Permission error: ${error.structuredError?.error_user_msg || originalMsg} — check that the entity IDs were obtained via LIST operations and not manually provided.`;
        }
        if (error.structuredError?.error_user_msg) {
          return `${error.structuredError.error_user_msg} (Meta code ${code}${subcode ? `, subcode ${subcode}` : ''})`;
        }
        return originalMsg;
    }
  }

  /**
   * Pre-validate Meta Marketing API params before making any API calls.
   * Throws a descriptive Error if required params are missing or invalid.
   */
  private validateMetaActionParams(
    entity_type: string,
    action: string,
    campaign_id: string | undefined,
    ad_set_id: string | undefined,
    ad_id: string | undefined,
    params: any
  ): void {
    switch (entity_type) {
      case 'CAMPAIGN':
        if (action === 'CREATE') {
          MetaService.validateCampaignParams('CREATE', params);
        } else if (action === 'UPDATE' && !campaign_id) {
          throw new Error('CAMPAIGN UPDATE requires "campaign_id".');
        } else if (action === 'DELETE' && !campaign_id) {
          throw new Error('CAMPAIGN DELETE requires "campaign_id".');
        }
        break;

      case 'AD_SET':
        if (action === 'CREATE' && !campaign_id) {
          throw new Error('AD_SET CREATE requires "campaign_id".');
        } else if (action === 'UPDATE' && !ad_set_id) {
          throw new Error('AD_SET UPDATE requires "ad_set_id".');
        } else if (action === 'DELETE' && !ad_set_id) {
          throw new Error('AD_SET DELETE requires "ad_set_id".');
        }
        break;

      case 'AD_CREATIVE':
        if (action === 'CREATE') {
          MetaService.validateCreativeParams('CREATE', params);
        }
        break;

      case 'AD':
        if (action === 'CREATE') {
          MetaService.validateAdParams('CREATE', { ...params, adset_id: ad_set_id });
        } else if (action === 'UPDATE' && !ad_id) {
          throw new Error('AD UPDATE requires "ad_id".');
        } else if (action === 'DELETE' && !ad_id) {
          throw new Error('AD DELETE requires "ad_id".');
        }
        break;

      case 'TARGETING':
        if (action === 'SEARCH') {
          if (!params.q) throw new Error('TARGETING SEARCH requires "params.q" (search query).');
          if (!params.type) throw new Error('TARGETING SEARCH requires "params.type" (adinterest | adbehavior | addemographics).');
        }
        break;
    }
  }

  /**
   * Master method for calling Meta Marketing API.
   * Routes the request to the appropriate entity manager based on entity_type.
   */
  public async callMetaMarketingApi(
    userId: string,
    entity_type: 'CAMPAIGN' | 'AD_SET' | 'AD_CREATIVE' | 'AD' | 'CUSTOM_AUDIENCE' | 'TARGETING' | 'PAGE',
    action: string,
    account_id: string,
    campaign_id?: string,
    ad_set_id?: string,
    ad_id?: string,
    params: any = {}
  ): Promise<MetaApiResult> {
    console.log(`AgentMode: callMetaMarketingApi -> ${entity_type} / ${action}`);

    // Ensure params is an object
    params = params || {};

    // Pre-validate params before any API round-trip
    try {
      this.validateMetaActionParams(entity_type, action, campaign_id, ad_set_id, ad_id, params);
    } catch (validationError: any) {
      return {
        success: false,
        message: validationError.message,
        error: 'PARAM_VALIDATION_ERROR',
        hint: 'Fix the listed parameters and retry.'
      } as any;
    }

    switch (entity_type) {
      case 'CAMPAIGN':
        // Map master params to specific params if needed, but schema is unified so passing through is safe
        return this.manageMetaAdsCampaigns(userId, action as any, account_id, campaign_id, params);
      
      case 'AD_SET':
        // Validation for Ad Set CREATE handled within manageMetaAdsAdSets -> createMetaAdsAdSet
        return this.manageMetaAdsAdSets(userId, action as any, account_id, campaign_id, ad_set_id, params);
      
      case 'AD_CREATIVE':
        return this.manageMetaAdsAdCreatives(userId, action as any, account_id, params);
      
      case 'AD':
        return this.manageMetaAdsAds(userId, action as any, account_id, ad_set_id, ad_id, params);
      
      case 'CUSTOM_AUDIENCE':
        return this.manageMetaCustomAudiences(userId, action as any, account_id, params);

      case 'TARGETING':
        return this.searchAdTargeting(userId, account_id, params.q, params.type);

      case 'PAGE':
        return this.listMetaPages(userId, account_id);

      default:
        throw new Error(`Invalid entity_type: ${entity_type}`);
    }
  }

  /**
   * Manage Custom Audiences (Custom, Lookalike, Website)
   */
  public async manageMetaCustomAudiences(
    userId: string,
    action: 'LIST' | 'CREATE' | 'UPLOAD_USERS',
    account_id: string,
    params: any
  ): Promise<MetaApiResult> {
    try {
       const { accountId, accessToken } = await this.getMetaCredentials(userId, account_id);

       switch (action) {
         case 'LIST': {
            const result = await metaService.listCustomAudiences(accountId, accessToken);
            const audiences = Array.isArray(result) ? result : [];
            return {
              success: true,
              message: `Found ${audiences.length} custom audience(s)`,
              audiences: audiences
            };
         }
         case 'CREATE': {
            // Validate required fields
            if (!params.name) {
              throw new Error('Custom audience requires a "name".');
            }
            if (!params.subtype || !['CUSTOM', 'LOOKALIKE'].includes(params.subtype)) {
              throw new Error('Custom audience requires "subtype" — must be "CUSTOM" or "LOOKALIKE".');
            }

            // Lookalike spec validation
            if (params.subtype === 'LOOKALIKE') {
              const spec = params.lookalike_spec;
              if (!spec || typeof spec !== 'object') {
                throw new Error('LOOKALIKE audiences require "lookalike_spec" with origin, ratio, and country.');
              }
              if (!spec.origin || !Array.isArray(spec.origin) || spec.origin.length === 0) {
                throw new Error('lookalike_spec.origin must be a non-empty array with at least one source audience: [{ "id": "AUDIENCE_ID", "type": "custom_audience" }].');
              }
              for (const source of spec.origin) {
                if (!source.id) {
                  throw new Error('Each lookalike_spec.origin entry must have an "id" (source audience ID).');
                }
              }
              if (spec.ratio === undefined || spec.ratio === null) {
                throw new Error('lookalike_spec.ratio is required (0.01 to 0.20, e.g., 0.01 = top 1% of country population).');
              }
              if (spec.ratio < 0.01 || spec.ratio > 0.20) {
                throw new Error(`lookalike_spec.ratio must be between 0.01 and 0.20 (got ${spec.ratio}). Use 0.01-0.05 for best quality.`);
              }
              if (!spec.country || typeof spec.country !== 'string' || spec.country.length !== 2) {
                throw new Error('lookalike_spec.country is required and must be a 2-letter ISO country code (e.g., "US").');
              }
            }

            const audience = await metaService.createCustomAudience(accountId, accessToken, params);
            return {
              success: true,
              message: `Custom Audience "${audience.name}" created successfully`,
              audience: audience
            };
         }
         case 'UPLOAD_USERS': {
            if (!params.id || !params.payload || !params.schema) {
              throw new Error('UPLOAD_USERS requires "id", "schema", and "payload".');
            }
            let userPayload = params.payload;
            
            // Smart handling: Check if payload is a URL (S3 or otherwise)
            if (typeof userPayload === 'string' && (userPayload.startsWith('http://') || userPayload.startsWith('https://'))) {
               try {
                  console.log(`[AgentMode] Detected URL in payload, fetching content: ${userPayload}`);
                  const response = await axios.get(userPayload);
                  // Ensure response data is a string for parsing
                  userPayload = typeof response.data === 'object' ? JSON.stringify(response.data) : response.data;
               } catch (fetchError: any) {
                  throw new Error(`Failed to fetch CSV content from URL: ${fetchError.message}`);
               }
            }

            // Parse CSV/String payload into Arrays
            let parsedPayload: string[][] = [];
            if (Array.isArray(userPayload)) {
                // Already an array (e.g. from JSON)
                parsedPayload = userPayload;
            } else if (typeof userPayload === 'string') {
                // Split by newline to get rows
                const rows = userPayload.split(/\r?\n/).filter(row => row.trim().length > 0);
                // Split by comma to get columns
                parsedPayload = rows.map(row => row.split(',').map(cell => cell.trim()));
            } else {
                // Fallback or error
                parsedPayload = []; 
                console.warn('[AgentMode] Payload format unrecognized for UPLOAD_USERS, sending empty array.');
            }

            // Validate schema/payload column count alignment
            const schemaLength = params.schema.length;
            if (parsedPayload.length === 0) {
              throw new Error('Payload is empty — no user rows to upload.');
            }
            for (let i = 0; i < parsedPayload.length; i++) {
              if (parsedPayload[i].length !== schemaLength) {
                throw new Error(
                  `Row ${i + 1} has ${parsedPayload[i].length} column(s) but schema expects ${schemaLength}. ` +
                  `Schema: [${params.schema.join(', ')}]. Row data: [${parsedPayload[i].join(', ')}]`
                );
              }
            }

            // SHA256 Hashing logic
            // Iterating through parsed payload and hashing fields based on schema

            const hashedPayload = parsedPayload.map((row: string[]) => {
                return row.map((cell: string, index: number) => {
                    const fieldType = (params.schema && params.schema[index]) ? params.schema[index].toUpperCase() : '';
                    let value = cell ? cell.trim() : '';

                    if (!value) return '';

                    // Pass through if already a SHA256 hash (64 hex chars)
                    if (/^[a-fA-F0-9]{64}$/.test(value)) {
                        return value;
                    }

                    // Normalization Rules per Meta requirements:
                    if (['EMAIL'].includes(fieldType)) {
                        value = value.toLowerCase();
                    } else if (['PHONE'].includes(fieldType)) {
                        // Standardize to digits only (strip spaces, dashes, parens)
                        value = value.toLowerCase().replace(/[^a-z0-9]/g, '');
                    } else if (['GEN'].includes(fieldType)) {
                        // Gender: 'f' or 'm'
                        value = value.toLowerCase() === 'female' ? 'f' : (value.toLowerCase() === 'male' ? 'm' : value.toLowerCase());
                    } else if (['DOBY', 'DOBM', 'DOBD'].includes(fieldType)) {
                         // Keep trimmed string
                         value = value.trim();
                    } else if (['COUNTRY'].includes(fieldType)) {
                        // Country codes must be lowercase 2-letter ISO
                        value = value.toLowerCase();
                    } else {
                        // Default: lowercase + trim
                        value = value.toLowerCase();
                    }

                    // Compute SHA256
                    return createHash('sha256').update(value).digest('hex');
                });
            });

            console.log(`[AgentMode] Hashed ${hashedPayload.length} rows for upload.`);

            const result = await metaService.uploadCustomAudienceUsers(
              accountId, 
              accessToken, 
              params.id, 
              params.schema, 
              hashedPayload
            );

            return {
              success: true,
              message: `Successfully initiated user upload to audience ${params.id}`,
              result: result
            };
         }
         default:
           throw new Error(`Action ${action} is not supported for CUSTOM_AUDIENCE.`);
       }
     } catch (error: any) {
       console.error('AgentMode: Error managing custom audiences:', error);
       return {
         success: false,
         message: error.message || 'Failed to manage custom audiences.',
         error: error.message
       };
     }
  }

  /**
   * Search for Detailed Targeting options (Interests, Behaviors, Demographics)
   */
  public async searchAdTargeting(
    userId: string,
    account_id: string,
    q: string,
    type: string = 'adTargetingCategory'
  ): Promise<any> {
    try {
      const { accountId, accessToken } = await this.getMetaCredentials(userId, account_id);
      
      const searchResult = await metaService.searchTargeting(accountId, accessToken, q, type);
      const results = Array.isArray(searchResult) ? searchResult : [];
      
      return {
        success: true,
        message: `Found ${results.length} results for "${q}"`,
        data: results
      };
    } catch (error: any) {
      console.error('AgentMode: Error searching ad targeting:', error);
      return {
        success: false,
        message: error.message || 'Failed to search ad targeting.',
        error: error.message
      };
    }
  }

  public async createRevision(taskId: string, executionId: string, revisionPrompt: string, userId: string, targetResultName?: string): Promise<any> {
    try {
      console.log('AgentMode: Creating revision for task:', taskId, 'execution:', executionId, 'targetResultName:', targetResultName);

      // Get the task to verify ownership
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        return {
          success: false,
          message: 'Task not found',
          status: 'error'
        };
      }

      // Get the execution to verify it exists and is completed
      const execution = await taskDb.getTaskExecutionById(executionId);
      if (!execution) {
        return {
          success: false,
          message: 'Execution not found',
          status: 'error'
        };
      }

      if (execution.status !== 'completed') {
        return {
          success: false,
          message: 'Can only revise completed executions',
          status: 'error'
        };
      }

      // Analyze result files to find available reports and images
      const resultFiles = execution.result_files || [];
      const htmlFiles = resultFiles.filter((file: any) =>
        file.is_html || file.view_type === 'html' || file.filename.toLowerCase().endsWith('.html')
      );
      const imageFiles = resultFiles.filter((file: any) => {
        const filename = file.filename.toLowerCase();
        return file.view_type === 'image' ||
          filename.endsWith('.jpg') || filename.endsWith('.jpeg') ||
          filename.endsWith('.png') || filename.endsWith('.gif') ||
          filename.endsWith('.webp') || filename.endsWith('.svg');
      });

      // If no results available, return error
      if (htmlFiles.length === 0 && imageFiles.length === 0) {
        return {
          success: false,
          message: 'No results found for revision. The execution must have completed HTML reports or images to create a revision.',
          status: 'error'
        };
      }

      // If multiple results and no target specified, return list of available results
      const totalResults = htmlFiles.length + imageFiles.length;
      if (totalResults > 1 && !targetResultName) {
        const availableResults = [
          ...htmlFiles.map((f: any) => ({ name: f.filename, type: 'report', url: f.url })),
          ...imageFiles.map((f: any) => ({ name: f.filename, type: 'image', url: f.url }))
        ];

        return {
          success: false,
          message: `Multiple results found. Please specify which result to revise by providing the target_result_name parameter. Available results: ${availableResults.map(r => `${r.name} (${r.type})`).join(', ')}`,
          availableResults,
          status: 'multiple_results'
        };
      }

      // Find the target result file
      let targetFile = null;
      let assetType = '';
      let originalAssetUrl = '';

      if (targetResultName) {
        // Look for the specific file by name
        targetFile = resultFiles.find((file: any) => file.filename === targetResultName);
        if (!targetFile) {
          return {
            success: false,
            message: `Target result file '${targetResultName}' not found. Available files: ${resultFiles.map((f: any) => f.filename).join(', ')}`,
            status: 'error'
          };
        }
      } else {
        // Use the first available result
        targetFile = htmlFiles[0] || imageFiles[0];
      }

      if (!targetFile) {
        return {
          success: false,
          message: 'No target result file found',
          status: 'error'
        };
      }

      // Determine asset type and URL
      if (targetFile.is_html || targetFile.view_type === 'html' || targetFile.filename.toLowerCase().endsWith('.html')) {
        assetType = 'report';
        originalAssetUrl = targetFile.url;
      } else {
        assetType = 'image';
        originalAssetUrl = targetFile.url;
      }

      // Format revision prompt based on asset type (similar to Ad Images page)
      let formattedRevisionPrompt = revisionPrompt;
      if (assetType === 'image') {
        // For images, add specific instructions similar to Ad Images page
        formattedRevisionPrompt = `Please create a revised version of the image based on the following feedback: ${revisionPrompt}. Use the original image as a reference and create a new version that addresses the requested changes.`;
      }

      // Create a new task execution with revision prompt
      const revisionExecution = {
        executionId: Date.now().toString(),
        taskId,
        userId: task.userId,
        run_user_id: userId !== task.userId ? userId : undefined,
        status: 'pending',
        startTime: new Date().toISOString(),
        revision_prompt: formattedRevisionPrompt,
        original_execution_id: executionId,
        original_report_url: assetType === 'report' ? originalAssetUrl : undefined,
        original_image_url: assetType === 'image' ? originalAssetUrl : undefined,
        variations: 1,
        // Include Slack channel info from task so revision gets sent back to Slack
        slack_channel: task.slackChannel,
        slack_channel_name: task.slackChannelName,
        requireApproval: task.requireApproval || false,
        approvalAssetType: assetType === 'report' ? 'html' : assetType
      };

      await taskDb.createTaskExecution(revisionExecution);

      return {
        success: true,
        message: `Revision created successfully for ${assetType} '${targetFile.filename}'. New execution ID: ${revisionExecution.executionId}`,
        taskId: revisionExecution.taskId,
        executionId: revisionExecution.executionId,
        status: 'pending',
        assetType,
        targetFile: targetFile.filename
      };
    } catch (error) {
      console.error('AgentMode: Error creating revision:', error);
      return {
        success: false,
        message: 'Failed to create revision. Please try again.',
        status: 'error'
      };
    }
  }

  // Action type mappings (shared across all processing functions)
  private readonly FORM_ACTIONS = new Set([
    'leadgen',
    'on_facebook_lead',
    'onsite_conversion.lead_form',
    'offsite_conversion.fb_pixel_custom',
    'offsite_conversion.fb_pixel_lead'
  ]);
  private readonly WEBSITE_ACTIONS = new Set([
    'website_lead',
    'lead'
  ]);

  // Helper function to process campaign data from Meta API
  private processCampaignData(campaigns: any[], insights: any[], adSets: any[]): any[] {
    const campaignMap = new Map();

    // Create ad set to campaign mapping
    const adSetToCampaignMap = new Map();
    for (const adSet of adSets) {
      adSetToCampaignMap.set(adSet.id, adSet.campaign_id);
    }

    // Initialize campaigns with zero metrics
    for (const campaign of campaigns) {
      campaignMap.set(campaign.id, {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        objective: campaign.objective,
        impressions: 0,
        clicks: 0,
        spend: 0,
        ctr: 0,
        cpc: 0,
        reach: 0,
        frequency: 0,
        websiteLeads: 0,
        costPerWebsiteLead: 0,
        formLeads: 0,
        costPerFormLead: 0,
        totalLeads: 0,
        costPerLead: 0,
        lastUpdated: new Date().toISOString(),
      });
    }

    // Process campaign-level insights directly
    for (const insight of insights) {
      const campaignId = insight.campaign_id;

      if (campaignMap.has(campaignId)) {
        const campaign = campaignMap.get(campaignId);

        // Use campaign-level metrics directly
        campaign.impressions = parseInt(insight.impressions) || 0;
        campaign.clicks = parseInt(insight.clicks) || 0;
        campaign.spend = parseFloat(insight.spend) || 0;
        campaign.reach = parseInt(insight.reach) || 0;

        // Process lead generation metrics from actions and cost_per_action_type
        if (insight.actions && Array.isArray(insight.actions)) {
          for (const action of insight.actions) {
            if (this.WEBSITE_ACTIONS.has(action.action_type)) {
              campaign.websiteLeads += parseInt(action.value) || 0;
            }
            if (this.FORM_ACTIONS.has(action.action_type)) {
              campaign.formLeads += parseInt(action.value) || 0;
            }
          }
        }

        if (insight.cost_per_action_type && Array.isArray(insight.cost_per_action_type)) {
          for (const costAction of insight.cost_per_action_type) {
            if (this.WEBSITE_ACTIONS.has(costAction.action_type)) {
              campaign.costPerWebsiteLead = parseFloat(costAction.value) || 0;
            }
            if (this.FORM_ACTIONS.has(costAction.action_type)) {
              campaign.costPerFormLead = parseFloat(costAction.value) || 0;
            }
          }
        }
      }
    }

    // Calculate derived metrics (CTR, CPC, Cost per Lead) after aggregation
    for (const campaign of campaignMap.values()) {
      if (campaign.impressions > 0) {
        campaign.ctr = (campaign.clicks / campaign.impressions) * 100; // Convert to percentage
      }
      if (campaign.clicks > 0) {
        campaign.cpc = campaign.spend / campaign.clicks;
      }
      if (campaign.reach > 0) {
        campaign.frequency = campaign.impressions / campaign.reach;
      }

      // Apply same logic as Meta Campaigns page: prioritize website leads over form submissions
      if (campaign.websiteLeads > 0) {
        campaign.formLeads = 0; // Set form submissions to 0 when website leads exist
        campaign.costPerWebsiteLead = campaign.costPerWebsiteLead || (campaign.spend / campaign.websiteLeads);
        campaign.costPerFormLead = 0;
      } else if (campaign.formLeads > 0) {
        campaign.costPerFormLead = campaign.costPerFormLead || (campaign.spend / campaign.formLeads);
      }

      campaign.totalLeads = (campaign.websiteLeads || 0) + (campaign.formLeads || 0);
      if (campaign.totalLeads > 0) {
        campaign.costPerLead = campaign.spend / campaign.totalLeads;
      }
    }

    // Return all campaigns regardless of activity
    return Array.from(campaignMap.values());
  }

  // Helper function to process ad sets data
  private processAdSetsData(adSets: any[], insights: any[], campaigns: any[]): any[] {
    const adSetMap = new Map();
    const campaignMap = new Map();

    // Create campaign mapping
    for (const campaign of campaigns) {
      campaignMap.set(campaign.id, campaign);
    }

    // Initialize ad sets with zero metrics
    for (const adSet of adSets) {
      const campaign = campaignMap.get(adSet.campaign_id);
      adSetMap.set(adSet.id, {
        id: adSet.id,
        name: adSet.name,
        status: adSet.status,
        campaignId: adSet.campaign_id,
        campaignName: campaign ? campaign.name : 'Unknown Campaign',
        impressions: 0,
        clicks: 0,
        spend: 0,
        ctr: 0,
        cpc: 0,
        reach: 0,
        frequency: 0,
        websiteLeads: 0,
        costPerWebsiteLead: 0,
        formLeads: 0,
        costPerFormLead: 0,
        totalLeads: 0,
        costPerLead: 0,
        lastUpdated: new Date().toISOString(),
      });
    }

    // Process adset-level insights directly
    for (const insight of insights) {
      const adSetId = insight.adset_id;
      if (adSetMap.has(adSetId)) {
        const adSet = adSetMap.get(adSetId);
        adSet.impressions = parseInt(insight.impressions) || 0;
        adSet.clicks = parseInt(insight.clicks) || 0;
        adSet.spend = parseFloat(insight.spend) || 0;
        adSet.reach = parseInt(insight.reach) || 0;

        // Process lead generation metrics from actions and cost_per_action_type
        if (insight.actions && Array.isArray(insight.actions)) {
          for (const action of insight.actions) {
            if (this.WEBSITE_ACTIONS.has(action.action_type)) {
              adSet.websiteLeads += parseInt(action.value) || 0;
            }
            if (this.FORM_ACTIONS.has(action.action_type)) {
              adSet.formLeads += parseInt(action.value) || 0;
            }
          }
        }

        if (insight.cost_per_action_type && Array.isArray(insight.cost_per_action_type)) {
          for (const costAction of insight.cost_per_action_type) {
            if (this.WEBSITE_ACTIONS.has(costAction.action_type)) {
              adSet.costPerWebsiteLead = parseFloat(costAction.value) || 0;
            }
            if (this.FORM_ACTIONS.has(costAction.action_type)) {
              adSet.costPerFormLead = parseFloat(costAction.value) || 0;
            }
          }
        }
      }
    }

    // Calculate derived metrics
    for (const adSet of adSetMap.values()) {
      if (adSet.impressions > 0) {
        adSet.ctr = (adSet.clicks / adSet.impressions) * 100;
      }
      if (adSet.clicks > 0) {
        adSet.cpc = adSet.spend / adSet.clicks;
      }
      if (adSet.reach > 0) {
        adSet.frequency = adSet.impressions / adSet.reach;
      }

      // Apply same logic as Meta Campaigns page: prioritize website leads over form submissions
      if (adSet.websiteLeads > 0) {
        adSet.formLeads = 0; // Set form submissions to 0 when website leads exist
        adSet.costPerWebsiteLead = adSet.costPerWebsiteLead || (adSet.spend / adSet.websiteLeads);
        adSet.costPerFormLead = 0;
      } else if (adSet.formLeads > 0) {
        adSet.costPerFormLead = adSet.costPerFormLead || (adSet.spend / adSet.formLeads);
      }

      adSet.totalLeads = (adSet.websiteLeads || 0) + (adSet.formLeads || 0);
      if (adSet.totalLeads > 0) {
        adSet.costPerLead = adSet.spend / adSet.totalLeads;
      }
    }

    // Return all ad sets regardless of activity
    return Array.from(adSetMap.values());
  }

  // Helper function to process ads data
  private processAdsData(ads: any[], insights: any[], adSets: any[], campaigns: any[]): any[] {
    const adMap = new Map();
    const adSetMap = new Map();
    const campaignMap = new Map();

    // Create mappings
    for (const adSet of adSets) {
      adSetMap.set(adSet.id, adSet);
    }
    for (const campaign of campaigns) {
      campaignMap.set(campaign.id, campaign);
    }

    // Initialize ads with zero metrics
    for (const ad of ads) {
      const adSet = adSetMap.get(ad.adset_id);
      const campaign = campaignMap.get(ad.campaign_id);

      adMap.set(ad.id, {
        id: ad.id,
        name: ad.name,
        status: ad.status,
        adSetId: ad.adset_id,
        adSetName: adSet ? adSet.name : 'Unknown Ad Set',
        campaignId: ad.campaign_id,
        campaignName: campaign ? campaign.name : 'Unknown Campaign',
        creative: ad.creative,
        impressions: 0,
        clicks: 0,
        spend: 0,
        ctr: 0,
        cpc: 0,
        reach: 0,
        frequency: 0,
        websiteLeads: 0,
        costPerWebsiteLead: 0,
        formLeads: 0,
        costPerFormLead: 0,
        totalLeads: 0,
        costPerLead: 0,
        lastUpdated: new Date().toISOString(),
      });
    }

    // Aggregate insights data by ad
    for (const insight of insights) {
      const adId = insight.ad_id;
      if (adMap.has(adId)) {
        const ad = adMap.get(adId);
        ad.impressions += parseInt(insight.impressions) || 0;
        ad.clicks += parseInt(insight.clicks) || 0;
        ad.spend += parseFloat(insight.spend) || 0;
        ad.reach += parseInt(insight.reach) || 0;

        // Process lead generation metrics from actions and cost_per_action_type
        if (insight.actions && Array.isArray(insight.actions)) {
          for (const action of insight.actions) {
            if (this.WEBSITE_ACTIONS.has(action.action_type)) {
              ad.websiteLeads += parseInt(action.value) || 0;
            }
            if (this.FORM_ACTIONS.has(action.action_type)) {
              ad.formLeads += parseInt(action.value) || 0;
            }
          }
        }

        if (insight.cost_per_action_type && Array.isArray(insight.cost_per_action_type)) {
          for (const costAction of insight.cost_per_action_type) {
            if (this.WEBSITE_ACTIONS.has(costAction.action_type)) {
              ad.costPerWebsiteLead = parseFloat(costAction.value) || 0;
            }
            if (this.FORM_ACTIONS.has(costAction.action_type)) {
              ad.costPerFormLead = parseFloat(costAction.value) || 0;
            }
          }
        }
      }
    }

    // Calculate derived metrics
    for (const ad of adMap.values()) {
      if (ad.impressions > 0) {
        ad.ctr = (ad.clicks / ad.impressions) * 100;
      }
      if (ad.clicks > 0) {
        ad.cpc = ad.spend / ad.clicks;
      }
      if (ad.reach > 0) {
        ad.frequency = ad.impressions / ad.reach;
      }

      // Apply same logic as Meta Campaigns page: prioritize website leads over form submissions
      if (ad.websiteLeads > 0) {
        ad.formLeads = 0; // Set form submissions to 0 when website leads exist
        ad.costPerWebsiteLead = ad.costPerWebsiteLead || (ad.spend / ad.websiteLeads);
        ad.costPerFormLead = 0;
      } else if (ad.formLeads > 0) {
        ad.costPerFormLead = ad.costPerFormLead || (ad.spend / ad.formLeads);
      }

      ad.totalLeads = (ad.websiteLeads || 0) + (ad.formLeads || 0);
      if (ad.totalLeads > 0) {
        ad.costPerLead = ad.spend / ad.totalLeads;
      }
    }

    // Return all ads regardless of activity
    return Array.from(adMap.values());
  }

  // Helper function to generate campaign summary
  private generateCampaignSummary(adPerformance: any[]): any {
    const totalCampaigns = adPerformance.length;
    const activeCampaigns = adPerformance.filter(campaign => campaign.status === 'ACTIVE').length;

    const totalSpend = adPerformance.reduce((sum, campaign) => sum + campaign.spend, 0);
    const totalImpressions = adPerformance.reduce((sum, campaign) => sum + campaign.impressions, 0);
    const totalClicks = adPerformance.reduce((sum, campaign) => sum + campaign.clicks, 0);
    const totalWebsiteLeads = adPerformance.reduce((sum, campaign) => sum + (campaign.websiteLeads || 0), 0);
    const totalFormLeads = adPerformance.reduce((sum, campaign) => sum + (campaign.formLeads || 0), 0);
    const totalLeads = totalWebsiteLeads + totalFormLeads;

    const averageCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    const averageCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
    const averageCostPerWebsiteLead = totalWebsiteLeads > 0 ? totalSpend / totalWebsiteLeads : 0;
    const averageCostPerFormLead = totalFormLeads > 0 ? totalSpend / totalFormLeads : 0;
    const averageCostPerLead = totalLeads > 0 ? totalSpend / totalLeads : 0;

    return {
      totalCampaigns,
      activeCampaigns,
      totalSpend,
      totalImpressions,
      totalClicks,
      totalWebsiteLeads,
      totalFormLeads,
      totalLeads,
      averageCtr,
      averageCpc,
      averageCostPerWebsiteLead,
      averageCostPerFormLead,
      averageCostPerLead
    };
  }

  // Helper function to process breakdown data with lead generation metrics
  private processBreakdownData(breakdownData: any[]): any[] {
    return breakdownData.map(item => {
      const processedItem = {
        ...item,
        websiteLeads: 0,
        costPerWebsiteLead: 0,
        formLeads: 0,
        costPerFormLead: 0,
        totalLeads: 0,
        costPerLead: 0
      };

      // Process lead generation metrics from actions and cost_per_action_type
      if (item.actions && Array.isArray(item.actions)) {
        for (const action of item.actions) {
          if (this.WEBSITE_ACTIONS.has(action.action_type)) {
            processedItem.websiteLeads += parseInt(action.value) || 0;
          }
          if (this.FORM_ACTIONS.has(action.action_type)) {
            processedItem.formLeads += parseInt(action.value) || 0;
          }
        }
      }

      if (item.cost_per_action_type && Array.isArray(item.cost_per_action_type)) {
        for (const costAction of item.cost_per_action_type) {
          if (this.WEBSITE_ACTIONS.has(costAction.action_type)) {
            processedItem.costPerWebsiteLead = parseFloat(costAction.value) || 0;
          }
          if (this.FORM_ACTIONS.has(costAction.action_type)) {
            processedItem.costPerFormLead = parseFloat(costAction.value) || 0;
          }
        }
      }

      // Apply same logic as Meta Campaigns page: prioritize website leads over form submissions
      if (processedItem.websiteLeads > 0) {
        processedItem.formLeads = 0; // Set form submissions to 0 when website leads exist
        processedItem.costPerFormLead = 0;
      }

      // Calculate totals
      processedItem.totalLeads = (processedItem.websiteLeads || 0) + (processedItem.formLeads || 0);
      if (processedItem.totalLeads > 0) {
        processedItem.costPerLead = (processedItem.spend || 0) / processedItem.totalLeads;
      }

      // Calculate cost per lead if we have leads but no cost_per_action_type data
      if (processedItem.websiteLeads > 0 && processedItem.costPerWebsiteLead === 0 && item.spend) {
        processedItem.costPerWebsiteLead = parseFloat(item.spend) / processedItem.websiteLeads;
      }

      return processedItem;
    });
  }

  // Helper function to format metrics summary for AI analysis
  public async formatMetricsSummary(data: any, userId: string): Promise<string> {
    const { adPerformance, adSetsData, adsData, campaignSummary, demographicsBreakdown, placementBreakdown, deviceBreakdown, attributionWindow } = data;

    try {
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const fileUrls: { url: string; name: string }[] = [];

      // Create date range string for filenames
      const startDate = attributionWindow?.start || 'unknown';
      const endDate = attributionWindow?.end || 'unknown';
      const dateRange = `${startDate}_${endDate}`;

      // Helper function to convert array to CSV
      const arrayToCSV = (headers: string[], rows: string[][]): string => {
        const csvRows = [headers.join(',')];
        rows.forEach(row => {
          csvRows.push(row.map(cell => {
            // Escape quotes and wrap in quotes if contains comma or quote
            const cellStr = String(cell);
            if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
              return `"${cellStr.replace(/"/g, '""')}"`;
            }
            return cellStr;
          }).join(','));
        });
        return csvRows.join('\n');
      };

      // 1. Ad-Level Data CSV
      if (adsData && adsData.length > 0) {
        const adRows = adsData.map((ad: any) => [
          ad.name,
          ad.adSetName,
          ad.campaignName,
          String(ad.impressions),
          String(ad.clicks),
          `$${ad.spend.toFixed(2)}`,
          `${ad.ctr.toFixed(2)}%`,
          `$${ad.cpc.toFixed(2)}`,
          String(ad.websiteLeads || 0),
          String(ad.formLeads || 0),
          String(ad.totalLeads || 0),
          `$${(ad.costPerLead || 0).toFixed(2)}`
        ]);

        const adCSV = arrayToCSV(
          ['Ad Name', 'Ad Set', 'Campaign', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
          adRows
        );
        const adResult = await uploadFileToS3(
          Buffer.from(adCSV, 'utf-8'),
          `meta-ads-ad-level-data-${dateRange}.csv`,
          userId,
          'text/csv'
        );
        if (adResult.success && adResult.url) {
          fileUrls.push({ url: adResult.url, name: 'Ad-Level Data (all individual ads)' });
        }
      }

      // 2. Demographics Breakdown CSV
      if (demographicsBreakdown && demographicsBreakdown.length > 0) {
        // Group by age and gender, then aggregate metrics
        const demographicsMap = new Map();
        demographicsBreakdown.forEach((item: any) => {
          const key = `${item.age || 'Unknown'}-${item.gender || 'Unknown'}`;
          if (!demographicsMap.has(key)) {
            demographicsMap.set(key, {
              age: item.age || 'Unknown',
              gender: item.gender || 'Unknown',
              impressions: 0,
              clicks: 0,
              spend: 0,
              websiteLeads: 0,
              formLeads: 0,
              totalLeads: 0
            });
          }
          const demo = demographicsMap.get(key);
          demo.impressions += parseInt(item.impressions) || 0;
          demo.clicks += parseInt(item.clicks) || 0;
          demo.spend += parseFloat(item.spend) || 0;
          demo.websiteLeads += parseInt(item.websiteLeads) || 0;
          demo.formLeads += parseInt(item.formLeads) || 0;
          demo.totalLeads = demo.websiteLeads + demo.formLeads;
        });

        // Sort by spend descending
        const sortedDemographics = Array.from(demographicsMap.values())
          .sort((a, b) => b.spend - a.spend);

        const demoRows = sortedDemographics.map((demo: any) => {
          const ctr = demo.impressions > 0 ? (demo.clicks / demo.impressions) * 100 : 0;
          const cpc = demo.clicks > 0 ? demo.spend / demo.clicks : 0;
          const costPerLead = demo.totalLeads > 0 ? demo.spend / demo.totalLeads : 0;
          return [
            demo.age,
            demo.gender,
            String(demo.impressions),
            String(demo.clicks),
            `$${demo.spend.toFixed(2)}`,
            `${ctr.toFixed(2)}%`,
            `$${cpc.toFixed(2)}`,
            String(demo.websiteLeads),
            String(demo.formLeads),
            String(demo.totalLeads),
            `$${costPerLead.toFixed(2)}`
          ];
        });

        const demoCSV = arrayToCSV(
          ['Age', 'Gender', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
          demoRows
        );
        const demoResult = await uploadFileToS3(
          Buffer.from(demoCSV, 'utf-8'),
          `meta-ads-demographics-breakdown-${dateRange}.csv`,
          userId,
          'text/csv'
        );
        if (demoResult.success && demoResult.url) {
          fileUrls.push({ url: demoResult.url, name: 'Demographics Breakdown' });
        }
      }

      // 3. Placement Breakdown CSV
      if (placementBreakdown && placementBreakdown.length > 0) {
        // Group by platform and position, then aggregate metrics
        const placementMap = new Map();
        placementBreakdown.forEach((item: any) => {
          const key = `${item.publisher_platform || 'Unknown'}-${item.platform_position || 'Unknown'}`;
          if (!placementMap.has(key)) {
            placementMap.set(key, {
              platform: item.publisher_platform || 'Unknown',
              position: item.platform_position || 'Unknown',
              impressions: 0,
              clicks: 0,
              spend: 0,
              websiteLeads: 0,
              formLeads: 0,
              totalLeads: 0
            });
          }
          const placement = placementMap.get(key);
          placement.impressions += parseInt(item.impressions) || 0;
          placement.clicks += parseInt(item.clicks) || 0;
          placement.spend += parseFloat(item.spend) || 0;
          placement.websiteLeads += parseInt(item.websiteLeads) || 0;
          placement.formLeads += parseInt(item.formLeads) || 0;
          placement.totalLeads = placement.websiteLeads + placement.formLeads;
        });

        // Sort by spend descending
        const sortedPlacements = Array.from(placementMap.values())
          .sort((a, b) => b.spend - a.spend);

        const placementRows = sortedPlacements.map((placement: any) => {
          const ctr = placement.impressions > 0 ? (placement.clicks / placement.impressions) * 100 : 0;
          const cpc = placement.clicks > 0 ? placement.spend / placement.clicks : 0;
          const costPerLead = placement.totalLeads > 0 ? placement.spend / placement.totalLeads : 0;
          return [
            placement.platform,
            placement.position,
            String(placement.impressions),
            String(placement.clicks),
            `$${placement.spend.toFixed(2)}`,
            `${ctr.toFixed(2)}%`,
            `$${cpc.toFixed(2)}`,
            String(placement.websiteLeads),
            String(placement.formLeads),
            String(placement.totalLeads),
            `$${costPerLead.toFixed(2)}`
          ];
        });

        const placementCSV = arrayToCSV(
          ['Platform', 'Position', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
          placementRows
        );
        const placementResult = await uploadFileToS3(
          Buffer.from(placementCSV, 'utf-8'),
          `meta-ads-placement-breakdown-${dateRange}.csv`,
          userId,
          'text/csv'
        );
        if (placementResult.success && placementResult.url) {
          fileUrls.push({ url: placementResult.url, name: 'Placement Breakdown' });
        }
      }

      // 4. Device Breakdown CSV
      if (deviceBreakdown && deviceBreakdown.length > 0) {
        // Group by device, then aggregate metrics
        const deviceMap = new Map();
        deviceBreakdown.forEach((item: any) => {
          const device = item.impression_device || 'Unknown';
          if (!deviceMap.has(device)) {
            deviceMap.set(device, {
              device,
              impressions: 0,
              clicks: 0,
              spend: 0,
              websiteLeads: 0,
              formLeads: 0,
              totalLeads: 0
            });
          }
          const deviceData = deviceMap.get(device);
          deviceData.impressions += parseInt(item.impressions) || 0;
          deviceData.clicks += parseInt(item.clicks) || 0;
          deviceData.spend += parseFloat(item.spend) || 0;
          deviceData.websiteLeads += parseInt(item.websiteLeads) || 0;
          deviceData.formLeads += parseInt(item.formLeads) || 0;
          deviceData.totalLeads = deviceData.websiteLeads + deviceData.formLeads;
        });

        // Sort by spend descending
        const sortedDevices = Array.from(deviceMap.values())
          .sort((a, b) => b.spend - a.spend);

        const deviceRows = sortedDevices.map((device: any) => {
          const ctr = device.impressions > 0 ? (device.clicks / device.impressions) * 100 : 0;
          const cpc = device.clicks > 0 ? device.spend / device.clicks : 0;
          const costPerLead = device.totalLeads > 0 ? device.spend / device.totalLeads : 0;
          return [
            device.device,
            String(device.impressions),
            String(device.clicks),
            `$${device.spend.toFixed(2)}`,
            `${ctr.toFixed(2)}%`,
            `$${cpc.toFixed(2)}`,
            String(device.websiteLeads),
            String(device.formLeads),
            String(device.totalLeads),
            `$${costPerLead.toFixed(2)}`
          ];
        });

        const deviceCSV = arrayToCSV(
          ['Device', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
          deviceRows
        );
        const deviceResult = await uploadFileToS3(
          Buffer.from(deviceCSV, 'utf-8'),
          `meta-ads-device-breakdown-${dateRange}.csv`,
          userId,
          'text/csv'
        );
        if (deviceResult.success && deviceResult.url) {
          fileUrls.push({ url: deviceResult.url, name: 'Device Breakdown' });
        }
      }

      // Build summary with campaign and ad set data, plus file URLs
      let summary = `📊 **Meta Ads Performance Data**\n\n`;

      // Attribution Window
      if (attributionWindow && attributionWindow.start && attributionWindow.end) {
        summary += `**Attribution Window:** ${attributionWindow.start} to ${attributionWindow.end} (${attributionWindow.days} days)\n\n`;
      }

      // Campaign Summary
      if (campaignSummary) {
        summary += `**📈 Campaign Summary**\n\n`;
        summary += `| Metric | Value |\n`;
        summary += `|--------|-------|\n`;
        summary += `| Total Campaigns | ${campaignSummary.totalCampaigns} |\n`;
        summary += `| Total Spend | $${campaignSummary.totalSpend.toFixed(2)} |\n`;
        summary += `| Impressions | ${campaignSummary.totalImpressions.toLocaleString()} |\n`;
        summary += `| Clicks | ${campaignSummary.totalClicks.toLocaleString()} |\n`;
        summary += `| CTR | ${campaignSummary.averageCtr.toFixed(2)}% |\n`;
        summary += `| CPC | $${campaignSummary.averageCpc.toFixed(2)} |\n`;
        summary += `| Website Leads | ${campaignSummary.totalWebsiteLeads.toLocaleString()} |\n`;
        summary += `| Form Submissions | ${campaignSummary.totalFormLeads.toLocaleString()} |\n`;
        summary += `| Total Leads | ${campaignSummary.totalLeads.toLocaleString()} |\n`;
        summary += `| Cost per Website Lead | $${campaignSummary.averageCostPerWebsiteLead.toFixed(2)} |\n`;
        summary += `| Cost per Form Lead | $${campaignSummary.averageCostPerFormLead.toFixed(2)} |\n`;
        summary += `| Cost per Lead | $${campaignSummary.averageCostPerLead.toFixed(2)} |\n\n`;
      }

      // Campaign Performance (top 10 by spend)
      if (adPerformance && adPerformance.length > 0) {
        const topCampaigns = adPerformance.slice(0, 10);
        summary += `**🎯 Campaign Performance** (Top ${topCampaigns.length} by Spend)\n\n`;
        summary += `| Campaign Name | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
        summary += `|---------------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;

        topCampaigns.forEach((campaign: any) => {
          summary += `| ${campaign.name} | $${campaign.spend.toFixed(2)} | ${campaign.impressions.toLocaleString()} | ${campaign.clicks.toLocaleString()} | ${campaign.ctr.toFixed(2)}% | $${campaign.cpc.toFixed(2)} | ${(campaign.websiteLeads || 0).toLocaleString()} | ${(campaign.formLeads || 0).toLocaleString()} | ${(campaign.totalLeads || 0).toLocaleString()} | $${(campaign.costPerLead || 0).toFixed(2)} |\n`;
        });
        summary += `\n`;
      }

      // Ad Sets Performance (top 10 by spend)
      if (adSetsData && adSetsData.length > 0) {
        const topAdSets = adSetsData.slice(0, 10);
        summary += `**📦 Ad Sets Performance** (Top ${topAdSets.length} by Spend)\n\n`;
        summary += `| Ad Set Name | Campaign | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
        summary += `|-------------|----------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;

        topAdSets.forEach((adSet: any) => {
          summary += `| ${adSet.name} | ${adSet.campaignName} | $${adSet.spend.toFixed(2)} | ${adSet.impressions.toLocaleString()} | ${adSet.clicks.toLocaleString()} | ${adSet.ctr.toFixed(2)}% | $${adSet.cpc.toFixed(2)} | ${(adSet.websiteLeads || 0).toLocaleString()} | ${(adSet.formLeads || 0).toLocaleString()} | ${(adSet.totalLeads || 0).toLocaleString()} | $${(adSet.costPerLead || 0).toFixed(2)} |\n`;
        });
        summary += `\n`;
      }

      // CSV Files Section
      if (fileUrls.length > 0) {
        summary += `**📥 Detailed Data Files**\n\n`;
        summary += `The following CSV files contain detailed ad-level and breakdown data:\n\n`;

        fileUrls.forEach((file, index) => {
          summary += `${index + 1}. **${file.name}**\n   📥 [Download CSV](${file.url})\n\n`;
        });
      }

      summary += `*Data includes ${adPerformance?.length || 0} campaigns, ${adSetsData?.length || 0} ad sets, and ${adsData?.length || 0} individual ads.*\n`;
      summary += `*Note: Breakdown data (demographics, placement, device) only includes spend from ads with sufficient data for those breakdowns. Breakdown totals may not match campaign totals due to this limitation.*\n`;

      return summary;
    } catch (error) {
      console.error('Error generating CSV files for Meta ads metrics:', error);
      // Fallback to text summary if CSV generation fails
      return `📊 **Meta Ads Performance Data**\n\nError generating CSV files: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`;
    }
  }


  // Helper function to format web search results for AI analysis
  private formatWebSearchResults(searchResult: any): string {
    const { query, results, totalResults } = searchResult;

    if (!results || results.length === 0) {
      return `<strong>🔍 Web Search Results for "${query}"</strong><br>No results found for your search query.`;
    }

    let summary = `<strong>🔍 Web Search Results for "${query}"</strong><br>`;
    summary += `I found ${totalResults} relevant search results:<br><br>`;

    results.forEach((result: any, index: number) => {
      summary += `<strong>${index + 1}. ${result.title}</strong><br>`;
      summary += `🔗 <a href="${result.url}" target="_blank">${result.url}</a><br>`;
      summary += `<em>${result.snippet}</em><br>`;
      if (result.publishedDate) {
        const date = new Date(result.publishedDate);
        summary += `📅 Published: ${date.toLocaleDateString()}<br>`;
      }
      summary += `<br>`;
    });

    summary += `<em>💡 I've gathered this current information to provide you with data-driven insights and recommendations.</em>`;

    return summary;
  }

  // Helper to format tool error for LLM feedback
  private formatToolError(toolName: string, errorMessage: string): string {
    const safeMessage = typeof errorMessage === 'string' ? errorMessage : 'Unknown error';
    return `⚠️ Tool Error: ${toolName}\nReason: ${safeMessage}\nNext: Adjust the plan or ask the user for missing info.`;
  }

  // Knowledge base search functionality
  // Helper: get an authenticated Google Drive client using the service account
  private async getGoogleDriveClient() {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/Google/Share'
      : 'dev/AgentWeb/Google/Share';
    const secretString = await getSecret(secretName);
    const credentials = JSON.parse(secretString);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    return google.drive({ version: 'v3', auth });
  }

  // Helper: get Google Drive shared folders for a user
  private async getUserGoogleDriveFolders(userId: string): Promise<Array<{ folderId: string; name: string }>> {
    const { userDb } = await import('./db');
    const user = await userDb.getUserById(userId);
    return user?.googleDriveFolders || [];
  }

  public async searchKnowledgeBase(query: string, maxResults: number = 5, userId?: string): Promise<any> {
    try {
      console.log('AgentMode: Searching knowledge base for query:', query, 'maxResults:', maxResults);

      // Limit max results to 10
      const limitedMaxResults = Math.min(maxResults, 10);

      // Search platform knowledge base (both public and private)
      const searchResults = await searchPlatformKnowledgeBase(query, limitedMaxResults, userId);

      const results: Array<{ content: string; source: string }> = (searchResults || []).map(result => ({
        content: result.content,
        source: result.metadata?.source || 'unknown'
      }));

      // Search Google Drive shared folders
      if (userId) {
        try {
          const folders = await this.getUserGoogleDriveFolders(userId);
          if (folders.length > 0) {
            const drive = await this.getGoogleDriveClient();
            // Build query: search across all shared folders
            const parentClauses = folders.map(f => `'${f.folderId}' in parents`).join(' or ');
            const driveResponse = await drive.files.list({
              q: `(${parentClauses}) and fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
              fields: 'files(id, name, mimeType, parents)',
              pageSize: limitedMaxResults,
            });

            const driveFiles = driveResponse.data.files || [];
            for (const file of driveFiles) {
              // Read file content for text-based files
              if (file.id && file.mimeType && !file.mimeType.startsWith('application/vnd.google-apps.folder')) {
                try {
                  const content = await this.readGoogleDriveFileContent(drive, file.id, file.name || '', file.mimeType);
                  if (content) {
                    const parentFolder = folders.find(f => file.parents?.includes(f.folderId));
                    results.push({
                      content: content.length > 5000 ? content.substring(0, 5000) + '\n\n[Content truncated]' : content,
                      source: `google-drive/${parentFolder?.name || 'shared'}/${file.name}`
                    });
                  }
                } catch (readErr) {
                  console.log(`AgentMode: Could not read Drive file ${file.name} for search:`, readErr);
                }
              }
            }
          }
        } catch (driveError) {
          console.log('AgentMode: Error searching Google Drive shared folders:', driveError);
          // Don't fail the whole search if Drive search fails
        }
      }

      // Search ClickUp docs (name match + content match)
      if (userId) {
        try {
          const clickUpToken = await getClickUpAccessToken(userId);
          if (clickUpToken) {
            const workspaces = await getClickUpWorkspaces(clickUpToken);
            const queryLower = query.toLowerCase();
            for (const workspace of workspaces) {
              try {
                const docs = await listClickUpDocs(clickUpToken, workspace.id);
                let clickUpResultCount = 0;
                for (const doc of docs) {
                  if (clickUpResultCount >= limitedMaxResults) break;
                  try {
                    const nameMatch = doc.name.toLowerCase().includes(queryLower);
                    const content = await readClickUpDocContent(clickUpToken, workspace.id, doc.id);
                    if (!content) continue;
                    const contentMatch = content.toLowerCase().includes(queryLower);
                    if (nameMatch || contentMatch) {
                      results.push({
                        content: content.length > 5000 ? content.substring(0, 5000) + '\n\n[Content truncated]' : content,
                        source: `clickup/${workspace.name}/${doc.name}`
                      });
                      clickUpResultCount++;
                    }
                  } catch (readErr) {
                    console.log(`AgentMode: Could not read ClickUp doc ${doc.name} for search:`, readErr);
                  }
                }
              } catch (wsErr) {
                console.log(`AgentMode: Error searching ClickUp docs in workspace ${workspace.name}:`, wsErr);
              }
            }
          }
        } catch (clickUpError) {
          console.log('AgentMode: Error searching ClickUp docs:', clickUpError);
          // Don't fail the whole search if ClickUp search fails
        }
      }

      if (results.length === 0) {
        return {
          success: true,
          message: `No knowledge base results found for "${query}"`,
          query,
          results: [],
          totalResults: 0
        };
      }

      return {
        success: true,
        message: `Found ${results.length} knowledge base results for "${query}"`,
        query,
        results,
        totalResults: results.length
      };
    } catch (error) {
      console.error('AgentMode: Error searching knowledge base:', error);
      return {
        success: false,
        message: 'Failed to search the knowledge base. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // List all knowledge base files for a user
  public async listKnowledgeBaseFiles(userId: string): Promise<any> {
    try {
      console.log('AgentMode: Listing knowledge base files for user:', userId);

      // Get user's private knowledge bases
      const userKnowledgeBaseTasks = await taskDb.getTasksWithKnowledgeBase(userId);

      // Get all public knowledge bases from all users
      const publicKnowledgeBaseTasks = await taskDb.getAllPublicKnowledgeBaseTasks();

      // Combine both lists, removing duplicates (in case user has public KBs)
      const taskIdSet = new Set<string>();

      // Add user's task IDs to set first
      for (const task of userKnowledgeBaseTasks || []) {
        taskIdSet.add(task.taskId);
      }

      const allKnowledgeBaseTasks = [...(userKnowledgeBaseTasks || [])];

      // Add public knowledge bases that are not already in the user's list
      for (const publicTask of publicKnowledgeBaseTasks || []) {
        if (!taskIdSet.has(publicTask.taskId)) {
          taskIdSet.add(publicTask.taskId);
          allKnowledgeBaseTasks.push(publicTask);
        }
      }

      const knowledgeBases = (allKnowledgeBaseTasks || []).map((task: any) => {
        const taskId = task.taskId;
        const taskName = task.name;
        const kbType = task.knowledgeBaseType || 'private';
        const kbUpdatedAt = task.knowledgeBaseUpdatedAt || task.updatedAt || task.createdAt;
        // Default file + uploaded files
        const files = [
          {
            fileName: 'knowledge-base.txt',
            fileSize: task.knowledgeBaseSize || 0,
            url: task.knowledgeBase || null
          },
          ...(task.knowledgeBaseFiles || []).map((f: any) => ({
            fileName: f.filename,
            fileSize: f.size || 0,
            url: f.url || null
          }))
        ];

        return {
          identifier: taskId,
          name: taskName,
          type: kbType,
          updatedAt: kbUpdatedAt,
          files
        };
      });

      // Include Google Drive shared folders
      try {
        const folders = await this.getUserGoogleDriveFolders(userId);
        if (folders.length > 0) {
          const drive = await this.getGoogleDriveClient();
          for (const folder of folders) {
            try {
              const response = await drive.files.list({
                q: `'${folder.folderId}' in parents and trashed = false`,
                fields: 'files(id, name, mimeType, size, modifiedTime)',
                orderBy: 'name',
                pageSize: 100,
              });

              const driveFiles = (response.data.files || []).map((f) => ({
                fileName: f.name || 'unknown',
                fileSize: f.size ? parseInt(f.size, 10) : 0,
                mimeType: f.mimeType || 'unknown',
                driveFileId: f.id,
                modifiedTime: f.modifiedTime,
              }));

              knowledgeBases.push({
                identifier: `gdrive:${folder.folderId}`,
                name: folder.name,
                type: 'google-drive',
                updatedAt: driveFiles.length > 0 ? driveFiles[0].modifiedTime : undefined,
                files: driveFiles,
              });
            } catch (folderErr) {
              console.log(`AgentMode: Error listing files in Drive folder ${folder.name}:`, folderErr);
            }
          }
        }
      } catch (driveError) {
        console.error('AgentMode: Error listing Google Drive shared folders:', driveError);
      }

      // Include ClickUp docs
      try {
        const clickUpToken = await getClickUpAccessToken(userId);
        if (clickUpToken) {
          const workspaces = await getClickUpWorkspaces(clickUpToken);
          for (const workspace of workspaces) {
            try {
              const docs = await listClickUpDocs(clickUpToken, workspace.id);
              const clickUpFiles = docs.map(doc => ({
                fileName: doc.name,
                fileSize: 0,
                docId: doc.id,
                dateCreated: doc.dateCreated,
                dateUpdated: doc.dateUpdated,
              }));

              knowledgeBases.push({
                identifier: `clickup:${workspace.id}`,
                name: `ClickUp - ${workspace.name}`,
                type: 'clickup',
                updatedAt: clickUpFiles.length > 0 ? clickUpFiles[0].dateUpdated : undefined,
                files: clickUpFiles,
              });
            } catch (wsErr) {
              console.log(`AgentMode: Error listing ClickUp docs in workspace ${workspace.name}:`, wsErr);
            }
          }
        }
      } catch (clickUpError) {
        console.error('AgentMode: Error listing ClickUp docs:', clickUpError);
      }

      const totalFiles = knowledgeBases.reduce(
        (sum: number, kb: any) => sum + (kb.files?.length || 0),
        0
      );

      if (knowledgeBases.length === 0) {
        return {
          success: true,
          message: 'No knowledge bases found',
          knowledge_bases: [],
          totalKnowledgeBases: 0,
          totalFiles: 0
        };
      }

      return {
        success: true,
        message: `Found ${knowledgeBases.length} knowledge base(s) with ${totalFiles} file(s). For Google Drive files, use kb_identifier starting with "gdrive:" and the file name to read them. For ClickUp docs, use kb_identifier starting with "clickup:" and the doc name to read them.`,
        knowledge_bases: knowledgeBases,
        totalKnowledgeBases: knowledgeBases.length,
        totalFiles
      };
    } catch (error) {
      console.error('AgentMode: Error listing knowledge base files:', error);
      return {
        success: false,
        message: 'Failed to list knowledge base files. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Read multiple knowledge base files; each entry must include kb_identifier (taskId) and file_name
  public async readKnowledgeBaseFiles(files: Array<{ kb_identifier: string; file_name: string }>, userId: string): Promise<any> {
    try {
      if (!Array.isArray(files) || files.length === 0) {
        return {
          success: false,
          message: 'files array is required'
        };
      }

      const results: any[] = [];

      for (const entry of files) {
        const kbIdentifier = entry?.kb_identifier;
        const fileName = entry?.file_name;

        if (!kbIdentifier || !fileName) {
          results.push({
            success: false,
            message: 'kb_identifier and file_name are required'
          });
          continue;
        }

        try {
          const result = await this.readSingleKnowledgeBaseFile(kbIdentifier, fileName, userId);
          results.push(result);
        } catch (err: any) {
          results.push({
            success: false,
            message: `Failed to read knowledge base file: ${err?.message || 'Unknown error'}`
          });
        }
      }

      return {
        success: true,
        message: `Read ${results.filter(r => r.success).length} of ${results.length} file(s)`,
        files: results
      };
    } catch (error) {
      console.error('AgentMode: Error reading knowledge base file:', error);
      return {
        success: false,
        message: 'Failed to read knowledge base file. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Read a single knowledge base file; file_identifier can be "kb_identifier::file_name" or an object.
  public async readKnowledgeBaseFile(fileIdentifier: any, userId: string): Promise<any> {
    let kbIdentifier: string | undefined;
    let fileName: string | undefined;

    if (typeof fileIdentifier === 'string') {
      if (fileIdentifier.includes('::')) {
        const [kb, file] = fileIdentifier.split('::');
        kbIdentifier = kb;
        fileName = file;
      } else if (fileIdentifier.includes('/')) {
        const [kb, ...rest] = fileIdentifier.split('/');
        kbIdentifier = kb;
        fileName = rest.join('/');
      }
    } else if (fileIdentifier?.kb_identifier && fileIdentifier?.file_name) {
      kbIdentifier = fileIdentifier.kb_identifier;
      fileName = fileIdentifier.file_name;
    }

    if (!kbIdentifier || !fileName) {
      return {
        success: false,
        message: 'file_identifier must include kb_identifier and file_name'
      };
    }

    return await this.readSingleKnowledgeBaseFile(kbIdentifier, fileName, userId);
  }

  // Helper: read a Google Drive file's content as text
  private async readGoogleDriveFileContent(drive: any, fileId: string, fileName: string, mimeType: string): Promise<string> {
    let content: Buffer;

    // Google Workspace files need to be exported
    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' });
      content = Buffer.from(res.data);
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res = await drive.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'arraybuffer' });
      content = Buffer.from(res.data);
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'arraybuffer' });
      content = Buffer.from(res.data);
    } else {
      // Binary files — download directly
      const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
      content = Buffer.from(res.data);
    }

    const extension = (fileName.split('.').pop() || '').toLowerCase();

    if (extension === 'pdf' || mimeType === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(content);
      return pdfData.text || '';
    } else if (['txt', 'md', 'html', 'htm', 'csv', 'json', 'xml', 'log'].includes(extension) ||
               mimeType.startsWith('text/') ||
               mimeType.startsWith('application/vnd.google-apps.')) {
      return content.toString('utf-8');
    } else {
      return content.toString('base64');
    }
  }

  // Helper: read a single knowledge base file
  public async readSingleKnowledgeBaseFile(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
    // Handle Google Drive shared folder files (identifier starts with "gdrive:")
    if (kbIdentifier.startsWith('gdrive:')) {
      return await this.readGoogleDriveSharedFile(kbIdentifier, fileName, userId);
    }

    // Handle ClickUp docs (identifier starts with "clickup:")
    if (kbIdentifier.startsWith('clickup:')) {
      return await this.readClickUpSharedDoc(kbIdentifier, fileName, userId);
    }

    // Get the task
    const task = await taskDb.getTaskById(kbIdentifier);
    if (!task) {
      return { success: false, message: `Knowledge base "${kbIdentifier}" not found` };
    }

    // Auth check: allow access if the knowledge base is public, otherwise check ownership
    const isPublic = task.knowledgeBaseType === 'public';
    if (!isPublic && task.userId !== userId) {
      return { success: false, message: 'Not authorized to access this knowledge base file' };
    }

    // Default file size check
    const size = typeof task.knowledgeBaseSize === 'string'
      ? parseInt(task.knowledgeBaseSize)
      : task.knowledgeBaseSize || 0;
    if (fileName === 'knowledge-base.txt' && size === 0) {
      return { success: false, message: `Knowledge base file "${fileName}" is empty or does not exist` };
    }

    // Storage setup
    const privateKey = await getGCSPPrivateKey();
    const storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: { client_email: process.env.GCS_CLIENT_EMAIL, private_key: privateKey }
    });
    const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev';
    const PRIVATE_BUCKET_NAME = process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev';
    const bucketType = task.knowledgeBaseType || 'private';
    const bucket = storage.bucket(bucketType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);

    // Resolve path (use stored key for uploads)
    let filePath: string;
    if (fileName === 'knowledge-base.txt') {
      filePath = `tasks/${kbIdentifier}/knowledge-base.txt`;
    } else {
      const kbFiles = (task as any).knowledgeBaseFiles || [];
      const matched = kbFiles.find((f: any) => f.filename === fileName || f.key?.endsWith(fileName));
      if (!matched) {
        return { success: false, message: `Knowledge base file "${fileName}" not found in metadata` };
      }
      filePath = matched.key || `tasks/${kbIdentifier}/knowledge-base-files/${fileName}`;
    }

    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) {
      return { success: false, message: `Knowledge base file "${fileName}" not found in storage` };
    }

    // Download content
    const [content] = await file.download();
    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || '';
    const extension = (fileName.split('.').pop() || '').toLowerCase();

    let contentStr = '';
    try {
      if (extension === 'pdf' || contentType.includes('application/pdf')) {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(content);
        contentStr = pdfData.text || '';
      } else if (['txt', 'md', 'html', 'htm', 'csv', 'json', 'xml', 'log'].includes(extension) || contentType.startsWith('text/')) {
        contentStr = content.toString('utf-8');
      } else {
        contentStr = content.toString('base64');
      }
    } catch (parseError: any) {
      console.error('AgentMode: Error parsing file content:', parseError);
      contentStr = content.toString('utf-8');
    }

    const maxContentLength = 50000;
    if (contentStr.length > maxContentLength) {
      contentStr = contentStr.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]';
      console.log(`AgentMode: Knowledge base content truncated to ${maxContentLength} characters`);
    }

    return {
      success: true,
      message: `Successfully read knowledge base file "${fileName}"`,
      kb_identifier: kbIdentifier,
      file_name: fileName,
      name: task.name,
      content: contentStr,
      size: content.length,
      type: bucketType,
      updatedAt: task.knowledgeBaseUpdatedAt || task.updatedAt || task.createdAt
    };
  }

  // Helper: read a file from a Google Drive shared folder
  private async readGoogleDriveSharedFile(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
    const folderId = kbIdentifier.replace('gdrive:', '');

    // Verify the folder belongs to this user
    const folders = await this.getUserGoogleDriveFolders(userId);
    if (!folders.some(f => f.folderId === folderId)) {
      return { success: false, message: 'Not authorized to access this Google Drive folder' };
    }

    const folderMeta = folders.find(f => f.folderId === folderId);

    try {
      const drive = await this.getGoogleDriveClient();

      // Find the file by name in the folder
      const listResponse = await drive.files.list({
        q: `'${folderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`,
        fields: 'files(id, name, mimeType, size, modifiedTime)',
        pageSize: 1,
      });

      const files = listResponse.data.files || [];
      if (files.length === 0) {
        return { success: false, message: `File "${fileName}" not found in Google Drive folder "${folderMeta?.name || folderId}"` };
      }

      const file = files[0];
      const contentStr = await this.readGoogleDriveFileContent(drive, file.id!, file.name || fileName, file.mimeType || '');

      const maxContentLength = 50000;
      const truncated = contentStr.length > maxContentLength
        ? contentStr.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]'
        : contentStr;

      return {
        success: true,
        message: `Successfully read Google Drive file "${fileName}"`,
        kb_identifier: kbIdentifier,
        file_name: fileName,
        name: folderMeta?.name || folderId,
        content: truncated,
        size: file.size ? parseInt(file.size, 10) : contentStr.length,
        type: 'google-drive',
        modifiedTime: file.modifiedTime,
      };
    } catch (error) {
      console.error('AgentMode: Error reading Google Drive file:', error);
      return {
        success: false,
        message: `Failed to read Google Drive file "${fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  // Helper: read a document from a ClickUp workspace
  private async readClickUpSharedDoc(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
    const workspaceId = kbIdentifier.replace('clickup:', '');

    try {
      const clickUpToken = await getClickUpAccessToken(userId);
      if (!clickUpToken) {
        return { success: false, message: 'ClickUp not connected' };
      }

      // Verify user has access to this workspace
      const workspaces = await getClickUpWorkspaces(clickUpToken);
      const workspace = workspaces.find(w => w.id === workspaceId);
      if (!workspace) {
        return { success: false, message: 'Not authorized to access this ClickUp workspace' };
      }

      // Find the doc by name in the workspace
      const docs = await listClickUpDocs(clickUpToken, workspaceId);
      const doc = docs.find(d => d.name === fileName);
      if (!doc) {
        return { success: false, message: `Document "${fileName}" not found in ClickUp workspace "${workspace.name}"` };
      }

      // Read doc content (all pages concatenated)
      const content = await readClickUpDocContent(clickUpToken, workspaceId, doc.id);

      const maxContentLength = 50000;
      const truncated = content.length > maxContentLength
        ? content.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]'
        : content;

      return {
        success: true,
        message: `Successfully read ClickUp document "${fileName}"`,
        kb_identifier: kbIdentifier,
        file_name: fileName,
        name: workspace.name,
        content: truncated,
        size: content.length,
        type: 'clickup',
        dateUpdated: doc.dateUpdated,
      };
    } catch (error) {
      console.error('AgentMode: Error reading ClickUp doc:', error);
      return {
        success: false,
        message: `Failed to read ClickUp document "${fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  // Web search functionality
  public async searchWeb(query: string, maxResults: number = 10): Promise<any> {
    try {
      console.log('AgentMode: Searching web for query:', query, 'maxResults:', maxResults);

      // Limit max results to 10
      const limitedMaxResults = Math.min(maxResults, 10);
      const maxAttempts = Math.max(1, Number(process.env.SEARCH_WEB_MAX_RETRIES || 4));
      const baseDelayMs = Math.max(100, Number(process.env.SEARCH_WEB_RETRY_BASE_MS || 600));
      let attempt = 0;
      let searchResults: any[] = [];

      while (attempt < maxAttempts) {
        attempt += 1;
        try {
          searchResults = await this.performWebSearch(query, limitedMaxResults);
          break;
        } catch (error) {
          const isLastAttempt = attempt >= maxAttempts;
          const shouldRetry = this.isRetryableSearchError(error);

          if (!shouldRetry || isLastAttempt) {
            throw error;
          }

          // Exponential backoff with jitter to reduce burst pressure and quota spikes.
          const jitterMs = Math.floor(Math.random() * 300);
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitterMs;
          console.warn(
            `AgentMode: searchWeb retry ${attempt}/${maxAttempts} for query "${query}" after ${delayMs}ms due to:`,
            error instanceof Error ? error.message : error
          );
          await this.sleep(delayMs);
        }
      }

      // Format the results for LLM consumption
      const formattedContent = this.formatWebSearchResults({
        query,
        results: searchResults,
        totalResults: searchResults.length
      });

      return {
        success: true,
        message: `Found ${searchResults.length} web search results for "${query}"`,
        query,
        results: searchResults,
        totalResults: searchResults.length,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error searching web:', error);
      return {
        success: false,
        message: 'Failed to search the web. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private isRetryableSearchError(error: any): boolean {
    const statusCode = error?.code || error?.response?.status || error?.status;
    const message = String(error?.message || '').toLowerCase();
    const reason = String(error?.errors?.[0]?.reason || '').toLowerCase();

    const hasQuotaSignal =
      message.includes('quota') ||
      message.includes('rate limit') ||
      reason.includes('quot') ||
      reason.includes('ratelimit') ||
      reason.includes('rate_limit_exceeded');

    const hasTransientSignal =
      statusCode === 429 ||
      statusCode === 408 ||
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504 ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('socket hang up') ||
      message.includes('temporarily unavailable');

    return hasQuotaSignal || hasTransientSignal;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get Google Search API credentials from AWS Secrets Manager
  public async getGoogleSearchCredentials(): Promise<{ apiKey: string; searchEngineId: string } | null> {
    try {
      const secretName = process.env.NODE_ENV === 'development'
        ? 'dev/AgentWeb/Google/Search'
        : 'prod/AgentWeb/Google/Search';

      const secretJson = await getSecret(secretName);
      const credentials = JSON.parse(secretJson);

      if (!credentials.apiKey || !credentials.searchEngineId) {
        console.error('Google Search API credentials missing required fields');
        return null;
      }

      return {
        apiKey: credentials.apiKey,
        searchEngineId: credentials.searchEngineId
      };
    } catch (error) {
      console.error('Error fetching Google Search API credentials from Secrets Manager:', error);
      return null;
    }
  }

  // Perform actual web search using Google Custom Search API
  public async performWebSearch(query: string, maxResults: number): Promise<any[]> {
    try {
      // Get credentials from Secrets Manager
      const credentials = await this.getGoogleSearchCredentials();

      if (!credentials) {
        throw new Error('Google Search API not configured in Secrets Manager');
      }

      // Initialize Google Custom Search API
      const customsearch = google.customsearch('v1');

      // Perform the search
      const response = await customsearch.cse.list({
        auth: credentials.apiKey,
        cx: credentials.searchEngineId,
        q: query,
        num: Math.min(maxResults, 10), // Google API max is 10
        safe: 'medium', // Safe search level
        fields: 'items(title,link,snippet,pagemap/metatags,pagemap/cse_thumbnail)'
      });

      if (!response.data.items || response.data.items.length === 0) {
        throw new Error('No search results found');
      }

      // Transform Google API results to our format
      const searchResults = response.data.items.map((item: any) => ({
        title: item.title || 'No title',
        url: item.link || '#',
        snippet: item.snippet || 'No description available',
        publishedDate: this.extractPublishedDate(item.pagemap?.metatags?.[0]) || new Date().toISOString(),
        thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || null
      }));

      console.log(`Google Search API returned ${searchResults.length} results for query: "${query}"`);
      return searchResults;

    } catch (error) {
      console.error('Error performing Google web search:', error);
      throw error;
    }
  }


  // Extract published date from page metadata
  private extractPublishedDate(metatags: any): string | null {
    if (!metatags) return null;

    // Try different common meta tag formats for publication date
    const dateFields = [
      'article:published_time',
      'pubdate',
      'date',
      'dc.date',
      'dc.date.issued',
      'og:article:published_time',
      'article:published',
      'publication_date'
    ];

    for (const field of dateFields) {
      if (metatags[field]) {
        try {
          const date = new Date(metatags[field]);
          if (!isNaN(date.getTime())) {
            return date.toISOString();
          }
        } catch (e) {
          // Continue to next field
        }
      }
    }

    return null;
  }

  // Helper function to format brand guidelines for AI analysis
  private formatBrandGuidelines(brandResult: any): string {
    if (!brandResult.exists) {
      return `<strong>🎨 Brand Guidelines</strong><br>No brand guidelines are currently configured. You can help the user set up their brand identity by asking about their brand name, colors, tone of voice, and other brand elements.`;
    }

    const { brandData, attachments } = brandResult;
    let formattedSummary = `<strong>🎨 Brand Guidelines Retrieved</strong><br>`;
    formattedSummary += `I've successfully retrieved your brand guidelines. Here's what I found:<br><br>`;

    // Brand Identity Section (matches UI structure)
    formattedSummary += `<strong>💖 Brand Identity</strong><br>`;
    formattedSummary += `• <strong>Brand Name:</strong> ${brandData.brandName || 'Not set'}<br>`;
    formattedSummary += `• <strong>Tagline:</strong> ${brandData.tagline || 'Not set'}<br>`;
    formattedSummary += `• <strong>Target Audience:</strong> ${brandData.targetAudience || 'Not set'}<br><br>`;

    // Brand Colors Section (matches UI structure)
    formattedSummary += `<strong>🎨 Brand Colors</strong><br>`;
    if (brandData.primaryColor) {
      if (brandData.isGradient && brandData.primaryColorEnd) {
        formattedSummary += `• <strong>Primary Color (Gradient):</strong> ${brandData.primaryColor} → ${brandData.primaryColorEnd}<br>`;
      } else {
        formattedSummary += `• <strong>Primary Color:</strong> ${brandData.primaryColor}<br>`;
      }
    }
    formattedSummary += `• <strong>Secondary Color:</strong> ${brandData.secondaryColor || 'Not set'}<br><br>`;

    // Typography Section (matches UI structure)
    formattedSummary += `<strong>🔤 Typography</strong><br>`;
    formattedSummary += `• <strong>Font Family:</strong> ${brandData.fontFamily || 'Not set'}<br><br>`;

    // Brand Voice & Messaging Section (matches UI structure)
    formattedSummary += `<strong>💬 Brand Voice & Messaging</strong><br>`;
    formattedSummary += `• <strong>Tone of Voice:</strong> ${brandData.toneOfVoice || 'Not set'}<br>`;
    formattedSummary += `• <strong>Brand Personality:</strong> ${brandData.brandPersonality || 'Not set'}<br><br>`;

    // Key Messages Section (matches UI structure)
    formattedSummary += `<strong>📝 Key Messages</strong><br>`;
    if (brandData.keyMessages && brandData.keyMessages.length > 0) {
      brandData.keyMessages.forEach((message: string, index: number) => {
        formattedSummary += `• ${index + 1}. ${message}<br>`;
      });
    } else {
      formattedSummary += `• No key messages set<br>`;
    }
    formattedSummary += `<br>`;

    // Brand Values Section (matches UI structure)
    formattedSummary += `<strong>💖 Brand Values</strong><br>`;
    if (brandData.brandValues && brandData.brandValues.length > 0) {
      brandData.brandValues.forEach((value: string) => {
        formattedSummary += `• ${value}<br>`;
      });
    } else {
      formattedSummary += `• No brand values set<br>`;
    }
    formattedSummary += `<br>`;

    // Founder Profile Section (matches UI structure)
    formattedSummary += `<strong>👥 Founder Profile</strong><br>`;
    if (brandData.founders && brandData.founders.length > 0) {
      brandData.founders.forEach((founder: any, index: number) => {
        formattedSummary += `• <strong>Founder ${index + 1}:</strong> ${founder.name}<br>`;
        if (founder.jobTitle) {
          formattedSummary += `  📋 <strong>Job Title:</strong> ${founder.jobTitle}<br>`;
        }
        if (founder.styleTone) {
          formattedSummary += `  🎭 <strong>Style & Tone:</strong> ${founder.styleTone}<br>`;
        }
        if (founder.signaturePosts) {
          formattedSummary += `  ✍️ <strong>Signature Posts:</strong> ${founder.signaturePosts}<br>`;
        }
        formattedSummary += `<br>`;
      });
    } else {
      formattedSummary += `• No founder profiles added<br>`;
    }
    formattedSummary += `<br>`;

    // Logo & Assets Section (matches UI structure)
    formattedSummary += `<strong>🖼️ Logo & Assets</strong><br>`;
    if (attachments && attachments.length > 0) {
      const logoAssets = attachments.filter((asset: any) => asset.type === 'logo' || asset.type === 'secondaryLogo');
      const brandGuideAssets = attachments.filter((asset: any) => asset.type === 'brandGuide');

      if (logoAssets.length > 0) {
        logoAssets.forEach((asset: any) => {
          const logoType = asset.type === 'logo' ? 'Primary Logo' : 'Secondary Logo';
          formattedSummary += `• <strong>${logoType}:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View ${logoType}</a><br>`;
        });
      } else {
        formattedSummary += `• No logos uploaded<br>`;
      }

      if (brandGuideAssets.length > 0) {
        brandGuideAssets.forEach((asset: any) => {
          formattedSummary += `• <strong>Brand Guide:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View Brand Guide</a><br>`;
        });
      } else {
        formattedSummary += `• No brand guide uploaded<br>`;
      }
    } else {
      formattedSummary += `• No assets uploaded<br>`;
    }

    formattedSummary += `<br><em>💡 I'll use this brand information to ensure all generated content aligns with your brand identity and guidelines.</em>`;
    formattedSummary += `<br><br><strong>⚠️ Note:</strong> This brand guidelines data is current and complete. Please do not call read_brand_guidelines again in this conversation as it will return the same information.`;

    return formattedSummary;
  }

  // Helper function to format brand guidelines update feedback for AI analysis
  private formatBrandGuidelinesUpdate(updateResult: any): string {
    if (!updateResult.success) {
      return `<strong>❌ Brand Guidelines Update Failed</strong><br>${updateResult.message || 'Unknown error occurred while updating brand guidelines.'}`;
    }

    const { updatedFields, brandData, updatedAssets } = updateResult;
    let formattedSummary = `<strong>✅ Brand Guidelines Updated Successfully</strong><br>`;
    formattedSummary += `Here's what was changed:<br><br>`;

    // Show only the updated fields
    if (updatedFields && updatedFields.length > 0) {
      formattedSummary += `<strong>📝 Updated Fields:</strong><br>`;
      updatedFields.forEach((field: string) => {
        let value;
        if (field === 'brandAssets') {
          // Handle brand assets separately - use only the updated assets
          value = updatedAssets;
        } else {
          // Handle brand data fields
          value = brandData[field];
        }

        if (value !== undefined && value !== null) {
          if (field === 'brandAssets' && Array.isArray(value) && value.length > 0) {
            formattedSummary += `• <strong>Brand Assets:</strong> Updated ${value.length} asset(s)<br>`;
            value.forEach((asset: any) => {
              const assetType = asset.type === 'logo' ? 'Primary Logo' :
                asset.type === 'secondaryLogo' ? 'Secondary Logo' :
                  asset.type === 'brandGuide' ? 'Brand Guide' :
                    asset.type === 'additionalAsset' ? 'Additional Asset' : asset.type;
              formattedSummary += `  - ${assetType}: ${asset.filename}<br>`;
            });
          } else if (field === 'founders' && Array.isArray(value)) {
            formattedSummary += `• <strong>Founder Profiles:</strong> Updated ${value.length} founder(s)<br>`;
            value.forEach((founder: any, index: number) => {
              formattedSummary += `  - <strong>Founder ${index + 1}:</strong> ${founder.name}<br>`;
              if (founder.jobTitle) {
                formattedSummary += `    📋 Job Title: ${founder.jobTitle}<br>`;
              }
              if (founder.styleTone) {
                formattedSummary += `    🎭 Style & Tone: ${founder.styleTone}<br>`;
              }
              if (founder.signaturePosts) {
                formattedSummary += `    ✍️ Signature Posts: ${founder.signaturePosts}<br>`;
              }
            });
          } else if (Array.isArray(value)) {
            formattedSummary += `• <strong>${field}:</strong> ${value.join(', ')}<br>`;
          } else {
            formattedSummary += `• <strong>${field}:</strong> ${value}<br>`;
          }
        }
      });
    }

    formattedSummary += `<br><em>💡 You can view the latest brand guidelines at the <a href="/brand-guidelines">Brand Guidelines page</a>.</em>`;

    return formattedSummary;
  }

  // Helper function to format market strategy for AI analysis
  private formatMarketStrategy(marketResult: any): string {
    if (!marketResult.exists) {
      return `<strong>📊 Market Strategy</strong><br>No market strategy is currently configured. You can help the user set up their market strategy by asking about their business overview, competitors, and ideal customer profiles.`;
    }

    const { marketData } = marketResult;
    let formattedSummary = `<strong>📊 Market Strategy Retrieved</strong><br>`;
    formattedSummary += `I've successfully retrieved your market strategy. Here's what I found:<br><br>`;

    // Business Overview Section (matches UI structure)
    formattedSummary += `<strong>🏢 Business Overview</strong><br>`;
    if (marketData.businessOverview) {
      formattedSummary += `${marketData.businessOverview}<br><br>`;
    } else {
      formattedSummary += `No business overview provided yet.<br><br>`;
    }

    // Competitors Section (matches UI structure)
    formattedSummary += `<strong>🏆 Competitors</strong><br>`;
    if (marketData.competitors && marketData.competitors.length > 0) {
      marketData.competitors.forEach((competitor: any, index: number) => {
        if (typeof competitor === 'object' && competitor.name) {
          formattedSummary += `• <strong>${competitor.name}:</strong> ${competitor.description || 'No description provided'}<br>`;
        } else {
          formattedSummary += `• ${competitor}<br>`;
        }
      });
    } else {
      formattedSummary += `• No competitors identified yet<br>`;
    }
    formattedSummary += `<br>`;

    // Ideal Customer Profile (ICP) Section (matches UI structure)
    formattedSummary += `<strong>🎯 Ideal Customer Profile (ICP)</strong><br>`;
    if (marketData.icp && marketData.icp.length > 0) {
      marketData.icp.forEach((icp: any, index: number) => {
        if (typeof icp === 'object' && icp.title) {
          formattedSummary += `• <strong>${icp.title}:</strong> ${icp.description || 'No description provided'}<br>`;
          if (icp.valueProposition) {
            formattedSummary += `  <em>Value Proposition:</em> ${icp.valueProposition}<br>`;
          }
          if (icp.buyerPersonas && Array.isArray(icp.buyerPersonas) && icp.buyerPersonas.length > 0) {
            formattedSummary += `  <em>Buyer Personas:</em> ${icp.buyerPersonas.join(', ')}<br>`;
          }
        } else {
          formattedSummary += `• ${icp}<br>`;
        }
      });
    } else {
      formattedSummary += `• No ideal customer profiles defined yet<br>`;
    }

    formattedSummary += `<br><em>💡 I'll use this market strategy information to inform marketing campaigns, content strategy, and business development decisions.</em>`;
    formattedSummary += `<br><br><strong>⚠️ Note:</strong> This market strategy data is current and complete. Please do not call read_market_strategy again in this conversation as it will return the same information.`;

    return formattedSummary;
  }

  // Helper function to format market strategy update feedback for AI analysis
  private formatMarketStrategyUpdate(updateResult: any): string {
    if (!updateResult.success) {
      return `<strong>❌ Market Strategy Update Failed</strong><br>${updateResult.message || 'Unknown error occurred while updating market strategy.'}`;
    }

    const { updatedFields, marketData, updatedEntries, addedEntries, totalCompetitors, totalICPs } = updateResult;
    let formattedSummary = `<strong>✅ Market Strategy Updated Successfully</strong><br>`;
    formattedSummary += `Here's what was changed:<br><br>`;

    // Show updated fields
    if (updatedFields && updatedFields.length > 0) {
      formattedSummary += `<strong>📝 Updated Fields:</strong><br>`;
      updatedFields.forEach((field: string) => {
        if (field === 'businessOverview') {
          formattedSummary += `• <strong>Business Overview:</strong> Updated<br>`;
        } else if (field === 'competitors') {
          const updatedCount = updatedEntries.filter((entry: string) => entry.startsWith('Competitor:')).length;
          const addedCount = addedEntries.filter((entry: string) => entry.startsWith('Competitor:')).length;
          formattedSummary += `• <strong>Competitors:</strong> ${updatedCount} updated, ${addedCount} added (${totalCompetitors} total)<br>`;
        } else if (field === 'icp') {
          const updatedCount = updatedEntries.filter((entry: string) => entry.startsWith('ICP:')).length;
          const addedCount = addedEntries.filter((entry: string) => entry.startsWith('ICP:')).length;
          formattedSummary += `• <strong>Ideal Customer Profiles:</strong> ${updatedCount} updated, ${addedCount} added (${totalICPs} total)<br>`;
        }
      });
    }

    // Show specific entries that were updated vs added
    if (updatedEntries && updatedEntries.length > 0) {
      formattedSummary += `<br><strong>🔄 Updated Entries:</strong><br>`;
      updatedEntries.forEach((entry: string) => {
        formattedSummary += `• ${entry}<br>`;
      });
    }

    if (addedEntries && addedEntries.length > 0) {
      formattedSummary += `<br><strong>➕ Added Entries:</strong><br>`;
      addedEntries.forEach((entry: string) => {
        formattedSummary += `• ${entry}<br>`;
      });
    }

    formattedSummary += `<br><em>💡 You can view the latest market strategy at the <a href="/market-strategy">Market Strategy page</a>.</em>`;

    return formattedSummary;
  }

  // Helper function to format file content for AI analysis
  private formatFileContent(fileResult: any): string {
    if (!fileResult.success) {
      return `❌ File Reading Failed: ${fileResult.message || 'Unknown error occurred while reading the file.'}`;
    }

    const { content, file_type, file_size, content_length, file_url } = fileResult;

    let formattedContent = `📄 File Content Read Successfully\n`;
    formattedContent += `File Type: ${file_type}\n`;
    formattedContent += `File Size: ${file_size} bytes\n`;
    formattedContent += `Content Length: ${content_length} characters\n`;
    formattedContent += `Source URL: ${file_url}\n\n`;

    // Add the actual content
    formattedContent += `📝 Extracted Content:\n`;
    formattedContent += `---\n`;
    formattedContent += content;
    formattedContent += `\n---`;

    return formattedContent;
  }

  // Save file to S3 and return URL with content-based deduplication
  public async saveFile(fileName: string, fileContent: string, userId: string, sessionId: string): Promise<any> {
    try {
      console.log('AgentMode: Saving file:', fileName, 'for user:', userId, 'session:', sessionId);

      // Validate inputs
      if (!fileName || typeof fileName !== 'string') {
        throw new Error('fileName is required and must be a string');
      }

      if (fileContent === undefined || fileContent === null) {
        throw new Error('fileContent is required and cannot be undefined or null');
      }

      if (typeof fileContent !== 'string') {
        throw new Error(`fileContent must be a string, received: ${typeof fileContent}`);
      }

      if (fileContent.trim().length === 0) {
        throw new Error('fileContent cannot be empty');
      }

      // Generate content hash for deduplication
      const contentHash = createHash('sha256').update(fileContent).digest('hex');

      // Check if we already have this content cached
      const cachedFile = this.fileContentCache.get(contentHash);
      if (cachedFile) {
        console.log('AgentMode: File content already exists, returning cached URL:', cachedFile.file_url);
        // Format the save result for LLM consumption
        const formattedContent = `📁 **File Saved Successfully**\nFile: ${fileName}\nSize: ${fileContent.length} bytes\nURL: ${cachedFile.file_url}\n\nThe file has been uploaded to S3 and is ready for sharing or reference.`;

        return {
          success: true,
          message: `File "${fileName}" has been saved successfully.`,
          file_url: cachedFile.file_url,
          file_name: fileName,
          file_size: fileContent.length,
          formattedContent
        };
      }

      const { uploadFileToS3 } = await import('../utils/s3Utils');

      // Determine content type based on file extension
      const extension = fileName.split('.').pop()?.toLowerCase();
      const contentTypes: { [key: string]: string } = {
        'txt': 'text/plain',
        'md': 'text/markdown',
        'json': 'application/json',
        'csv': 'text/csv',
        'html': 'text/html',
        'xml': 'application/xml',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      };
      const contentType = contentTypes[extension || ''] || 'application/octet-stream';

      // Upload to S3 using common utility
      const uploadResult = await uploadFileToS3(
        fileContent,
        fileName,
        userId,
        contentType
      );

      if (uploadResult.success) {
        // Cache the file content hash to URL mapping
        this.fileContentCache.set(contentHash, {
          file_url: uploadResult.url || '',
          file_name: fileName || 'unknown',
          file_size: fileContent.length
        });

        console.log('AgentMode: File uploaded and cached with hash:', contentHash);

        // Format the save result for LLM consumption
        const formattedContent = `📁 **File Saved Successfully**\nFile: ${fileName}\nSize: ${fileContent.length} bytes\nURL: ${uploadResult.url}\n\nThe file has been uploaded to S3 and is ready for sharing or reference.`;

        return {
          success: true,
          message: `File "${fileName}" has been saved successfully.`,
          file_url: uploadResult.url,
          file_name: fileName,
          file_size: fileContent.length,
          formattedContent
        };
      } else {
        return {
          success: false,
          message: 'Failed to save file to S3. Please try again.',
          error: uploadResult.error
        };
      }
    } catch (error) {
      console.error('AgentMode: Error saving file:', error);
      return {
        success: false,
        message: 'Failed to save file. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Read file content from URL with support for various file types
  public async readFileContent(fileUrl: string): Promise<any> {
    try {
      console.log('AgentMode: Reading file content from URL:', fileUrl);

      // Validate URL format
      if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
        return {
          success: false,
          message: 'Invalid URL format. Must be HTTP or HTTPS.',
          error: 'Invalid URL format'
        };
      }

      // Determine file type from URL
      const urlPath = new URL(fileUrl).pathname;
      const extension = urlPath.split('.').pop()?.toLowerCase() || '';

      // Fetch the file content
      const response = await axios.get(fileUrl, {
        timeout: 30000, // 30 seconds timeout for larger files
        responseType: 'arraybuffer', // Use arraybuffer to handle binary files
        headers: {
          'User-Agent': 'AgentWeb-Backend/1.0',
        },
      });

      const buffer = Buffer.from(response.data as ArrayBuffer);
      const contentType = response.headers['content-type'] || '';

      console.log(`AgentMode: Successfully fetched file, size: ${buffer.length} bytes, type: ${contentType}`);

      // Process content based on file type
      let extractedContent = '';
      let fileType = 'unknown';

      if (extension === 'pdf' || contentType.includes('application/pdf')) {
        // Handle PDF files
        try {
          // Use require for dynamic loading to avoid TypeScript module resolution issues
          const pdfParse = require('pdf-parse');
          const pdfData: PDFData = await pdfParse(buffer);
          extractedContent = pdfData.text;
          fileType = 'pdf';
          console.log(`AgentMode: Successfully parsed PDF, extracted ${extractedContent.length} characters`);
        } catch (pdfError) {
          console.error('AgentMode: Error parsing PDF:', pdfError);
          return {
            success: false,
            message: 'Failed to parse PDF file. The file may be corrupted or password-protected.',
            error: pdfError instanceof Error ? pdfError.message : 'PDF parsing failed'
          };
        }
      } else if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'js', 'css', 'log', 'yml', 'yaml'].includes(extension)) {
        // Handle text-based files
        try {
          extractedContent = buffer.toString('utf-8');
          fileType = 'text';
          console.log(`AgentMode: Successfully read text file, extracted ${extractedContent.length} characters`);
        } catch (textError) {
          console.error('AgentMode: Error reading text file:', textError);
          return {
            success: false,
            message: 'Failed to read text file. The file may contain invalid characters.',
            error: textError instanceof Error ? textError.message : 'Text file reading failed'
          };
        }
      } else {
        // For other file types, try to read as text but with a warning
        try {
          extractedContent = buffer.toString('utf-8');
          fileType = 'text';
          console.log(`AgentMode: Attempted to read unknown file type as text, extracted ${extractedContent.length} characters`);
        } catch (textError) {
          console.error('AgentMode: Error reading file as text:', textError);
          return {
            success: false,
            message: `Unsupported file type (${extension}). Only text files, PDFs, and common document formats are supported.`,
            error: 'Unsupported file type'
          };
        }
      }

      // Limit content size to prevent overwhelming the LLM and session storage
      const maxContentLength = 50000; // 50KB limit for tool results
      if (extractedContent.length > maxContentLength) {
        extractedContent = extractedContent.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]';
        console.log(`AgentMode: Content truncated to ${maxContentLength} characters`);
      }

      // Format the file content for LLM consumption
      const formattedContent = this.formatFileContent({
        success: true,
        content: extractedContent,
        file_type: fileType,
        file_size: buffer.length,
        content_length: extractedContent.length,
        file_url: fileUrl
      });

      // Compute content hash for integrity verification
      const contentHash = createHash('sha256').update(extractedContent).digest('hex');
      console.log(`AgentMode: Computed content hash: ${contentHash}`);

      return {
        success: true,
        content: extractedContent,
        content_hash: contentHash,
        file_type: fileType,
        file_size: buffer.length,
        content_length: extractedContent.length,
        file_url: fileUrl,
        message: `Successfully read ${fileType} file content (${extractedContent.length} characters)`
      };

    } catch (error: any) {
      console.error('AgentMode: Error reading file content:', error);

      let errorMessage = 'Failed to read file content';
      let statusCode = 500;

      if (error.response) {
        statusCode = error.response.status;
        errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
      } else if (error.code === 'ENOTFOUND') {
        statusCode = 404;
        errorMessage = 'File not found or URL is unreachable';
      } else if (error.code === 'ETIMEDOUT') {
        statusCode = 408;
        errorMessage = 'Request timeout while fetching file';
      }

      return {
        success: false,
        message: errorMessage,
        error: error.message,
        file_url: fileUrl
      };
    }
  }

  /**
   * Generate an image using AI image generation models
   */
  public async generateImage(
    prompt: string,
    filename: string,
    size: string,
    quality: string,
    inputImages: string[],
    userId: string,
    sessionId: string,
    imageModel?: string,
    logoImage?: string
  ): Promise<any> {
    try {
      // Import the image generation service
      const { imageService } = await import('./imageGeneration');

      // Check if the service is available
      const isAvailable = await imageService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Image generation service is not available. Please check API key configuration in AWS Secrets Manager.',
          error: 'Service unavailable'
        };
      }

      // Generate the image
      const result = await imageService.generateImage({
        prompt,
        filename,
        size,
        quality,
        inputImages: inputImages || [],
        logoImage,
        userId,
        imageModel
      });

      if (result.success && result.imageUrl) {
        // Save the image URL to the session for reference
        const imageData = {
          url: result.imageUrl,
          filename: result.filename,
          generatedAt: new Date().toISOString(),
          prompt: prompt,
          size: size,
          quality: quality
        };

        // Store image data in session metadata (optional)
        try {
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'system',
            content: `Image generated: ${result.filename}`,
            metadata: {
              timestamp: new Date().toISOString()
            }
          });
        } catch (error) {
          console.warn('Failed to store image generation metadata:', error);
        }

        return {
          success: true,
          message: `✅ Image "${result.filename}" generated successfully!`,
          imageUrl: result.imageUrl,
          filename: result.filename,
          prompt: prompt,
          size: size,
          quality: quality
        };
      } else {
        return {
          success: false,
          message: result.error || 'Failed to generate image',
          error: result.error
        };
      }

    } catch (error: any) {
      console.error('AgentMode: Error generating image:', error);
      return {
        success: false,
        message: 'Failed to generate image',
        error: error.message
      };
    }
  }

  /**
   * Generate a video using AI video generation models
   */
  public async generateVideo(
    prompt: string,
    filename: string,
    userId: string,
    sessionId: string,
    videoModel?: string,
    startFrame?: string,
    endFrame?: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Generating video with prompt:', prompt, 'filename:', filename, 'videoModel:', videoModel, 'startFrame:', startFrame ? 'provided' : 'none', 'endFrame:', endFrame ? 'provided' : 'none', 'userId:', userId, 'sessionId:', sessionId);

      // Import the video generation service
      const { videoService } = await import('./videoGeneration');

      // Check if the service is available
      const isAvailable = await videoService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Video generation service is not available. Please check API key configuration in AWS Secrets Manager.',
          error: 'Service unavailable'
        };
      }

      // Generate the video
      const result = await videoService.generateVideo({
        prompt,
        filename,
        userId,
        videoModel,
        startFrame,
        endFrame
      });

      if (result.success && result.videoUrl) {
        // Save the video URL to the session for reference
        const videoData = {
          url: result.videoUrl,
          filename: result.filename,
          generatedAt: new Date().toISOString(),
          prompt: prompt,
          model: videoModel || 'veo-3.1-generate-preview'
        };

        // Store video data in session metadata (optional)
        try {
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'system',
            content: `Video generated: ${result.filename}`,
            metadata: {
              timestamp: new Date().toISOString()
            }
          });
        } catch (error) {
          console.warn('Failed to store video generation metadata:', error);
        }

        return {
          success: true,
          message: `✅ Video "${result.filename}" generated successfully!`,
          videoUrl: result.videoUrl,
          filename: result.filename,
          prompt: prompt,
          model: videoModel || 'veo-3.1-generate-preview'
        };
      } else {
        return {
          success: false,
          message: result.error || 'Failed to generate video',
          error: result.error
        };
      }

    } catch (error: any) {
      console.error('AgentMode: Error generating video:', error);
      return {
        success: false,
        message: 'Failed to generate video',
        error: error.message
      };
    }
  }

  /**
   * Remove C2PA metadata from an image by downloading it, stripping metadata, and uploading to S3
   */
  public async removeC2PAFromImage(
    imageUrl: string,
    filename?: string,
    userId?: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Removing C2PA metadata from image:', imageUrl);

      if (!imageUrl) {
        return {
          success: false,
          message: 'Image URL is required',
          error: 'missing_image_url'
        };
      }

      // Import required services
      const axios = require('axios');
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const { imageService } = await import('./imageGeneration');

      // Download the image
      let imageBuffer: Buffer;
      if (imageUrl.startsWith('data:image/')) {
        // Handle data URL
        const base64Data = imageUrl.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        // Download from URL
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
          }
        });
        imageBuffer = Buffer.from(response.data);
      }

      // Remove C2PA metadata using the imageService's method
      const cleanedBuffer = await imageService.removeC2PAMetadata(imageBuffer);

      // Generate filename if not provided
      let finalFilename = filename;
      if (!finalFilename) {
        // Extract filename from URL or generate one
        try {
          const urlObj = new URL(imageUrl);
          const pathParts = urlObj.pathname.split('/');
          const urlFilename = pathParts[pathParts.length - 1];
          if (urlFilename && urlFilename.includes('.')) {
            // Replace extension with .png
            const nameWithoutExt = urlFilename.substring(0, urlFilename.lastIndexOf('.'));
            finalFilename = `${nameWithoutExt}_no_c2pa.png`;
          } else {
            finalFilename = `image_no_c2pa_${Date.now()}.png`;
          }
        } catch {
          finalFilename = `image_no_c2pa_${Date.now()}.png`;
        }
      } else if (!finalFilename.endsWith('.png')) {
        // Ensure .png extension
        const nameWithoutExt = finalFilename.substring(0, finalFilename.lastIndexOf('.') || finalFilename.length);
        finalFilename = `${nameWithoutExt}.png`;
      }

      // Upload to S3
      if (!userId) {
        return {
          success: false,
          message: 'User ID is required for S3 upload',
          error: 'missing_user_id'
        };
      }

      const uploadResult = await uploadFileToS3(
        cleanedBuffer,
        finalFilename,
        userId,
        'image/png'
      );

      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          message: uploadResult.error || 'Failed to upload cleaned image to S3',
          error: uploadResult.error || 's3_upload_failed'
        };
      }

      return {
        success: true,
        message: `✅ C2PA metadata removed successfully! Image uploaded to S3.`,
        imageUrl: uploadResult.url,
        filename: finalFilename,
        originalUrl: imageUrl
      };

    } catch (error: any) {
      console.error('AgentMode: Error removing C2PA metadata:', error);
      return {
        success: false,
        message: 'Failed to remove C2PA metadata from image',
        error: error.message
      };
    }
  }

  /**
   * Perform deep research on a topic and upload to S3, returning the S3 URL
   */
  public async performDeepResearchTool(
    topic: string,
    prompt?: string,
    tone: string = 'professional',
    depth: string = 'detailed',
    focus_areas?: string[],
    userId?: string
  ): Promise<any> {

    try {
      console.log('AgentMode: Performing deep research on topic:', topic, 'tone:', tone, 'depth:', depth, 'focus_areas:', focus_areas);

      // Import the deep research service
      const { deepResearchService } = await import('./deepResearchService');

      // Check if the service is available
      const isAvailable = await deepResearchService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Deep Research service is not available. Please check API key configuration.',
          error: 'Service unavailable'
        };
      }

      // Perform the deep research
      const researchResult = await deepResearchService.performDeepResearch({
        topic,
        prompt,
        tone,
        depth,
        focus_areas
      });

      if (!researchResult.success || !researchResult.markdownContent) {
        return {
          success: false,
          message: researchResult.error || 'Deep research failed',
          error: researchResult.error || 'Unknown error'
        };
      }

      // Calculate word count for context
      const wordCount = researchResult.markdownContent.split(/\s+/).length;

      // Upload markdown content to S3
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const sanitizedTopic = topic.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().substring(0, 50);
      const filename = `research-${sanitizedTopic}-${Date.now()}.md`;

      const uploadResult = await uploadFileToS3(
        researchResult.markdownContent,
        filename,
        userId || 'anonymous',
        'text/markdown'
      );

      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          message: 'Failed to upload research content to S3',
          error: 'S3 upload failed'
        };
      }

      console.log('AgentMode: Deep research uploaded to S3:', uploadResult.url);

      return {
        success: true,
        message: `Deep research completed successfully. Generated ${wordCount} words of content and saved to S3.`,
        data: {
          research_url: uploadResult.url,
          title: researchResult.title,
          summary: researchResult.researchSummary,
          word_count: wordCount,
          research_depth: depth,
          topic: topic
        }
      };

    } catch (error: any) {
      console.error('AgentMode: Error performing deep research:', error);
      return {
        success: false,
        message: 'Failed to perform deep research',
        error: error.message
      };
    }
  }

  public async createBlogArticle(
    titleDraft: string,
    contentDraft: string,
    length: string,
    researchContext: string,
    requirements: string,
    userId: string,
    sessionId: string,
    style: string = 'default',
    deepResearch: boolean = false
  ): Promise<any> {
    try {
      // Import required services
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const { generateBlogImage, generateBlogHtml, generateBlogContent } = await import('../controllers/blog');

      if (!titleDraft || !contentDraft) {
        throw new Error("title_draft and content_draft are required");
      }

      // Calculate first and last 100 bytes for logging
      const contentLength = contentDraft.length;
      const first100Bytes = contentDraft.substring(0, Math.min(100, contentLength));
      const last100Bytes = contentLength > 100 ? contentDraft.substring(contentLength - 100) : contentDraft;
      const contentPreview = `${contentLength}: ${first100Bytes}...${last100Bytes}`;

      console.log('AgentMode: Creating blog article for title_draft:', titleDraft, 'length:', length, 'deepResearch:', deepResearch, 'userId:', userId, 'content_draft:', contentPreview);

      // Import restyleContent for processing the draft
      const { restyleContent } = await import('../controllers/blog');

      let blogData: { title: string; description: string; content: string; imagePrompt: string };
      let finalContent: string;
      let inlineImagesCount = 0;

      if (deepResearch) {
        // ========================================
        // DEEP RESEARCH FLOW: Research + Restyle + Inline Images
        // ========================================
        console.log('AgentMode: Deep research enabled, performing research...');
        const { deepResearchService } = await import('./deepResearchService');

        // Combine title_draft and content_draft as topic for deep research
        const researchTopic = `${titleDraft}\n\n${contentDraft}`;

        const researchResult = await deepResearchService.performDeepResearch({
          topic: researchTopic,
          prompt: requirements || undefined,
          tone: 'professional',
          style
        });

        if (!researchResult.success || !researchResult.markdownContent) {
          throw new Error(researchResult.error || 'Deep research failed');
        }

        console.log('AgentMode: Deep research complete. Length:', researchResult.markdownContent.length);
        console.log('AgentMode: Restyling research content with style:', style);

        // Restyle with inline image placeholders
        blogData = await restyleContent(
          researchResult.markdownContent,
          titleDraft,
          'professional',
          style,
          true // includeInlineImages = true for deep research
        );

        if (!blogData.title || !blogData.content) {
          throw new Error("Blog content restyling failed");
        }

        // Use the generated title from blogData (not the draft)

        // Parse and generate inline images
        const placeholders = this.parseImagePlaceholders(blogData.content);
        console.log(`AgentMode: Found ${placeholders.length} image placeholders in content`);

        if (placeholders.length > 0) {
          console.log('AgentMode: Generating inline images...');
          const inlineImageResults = await Promise.all(
            placeholders.map(p => generateBlogImage(p.prompt, userId))
          );

          const inlineImageUrls = inlineImageResults.map(r => r.imageUrl || '');
          inlineImagesCount = inlineImageUrls.filter(u => u).length;
          console.log(`AgentMode: Generated ${inlineImagesCount} inline images successfully`);

          // Replace placeholders with actual image URLs
          finalContent = this.replaceImagePlaceholders(blogData.content, placeholders, inlineImageUrls);
          console.log('AgentMode: Replaced image placeholders with actual images');
        } else {
          finalContent = blogData.content;
        }
      } else {
        // ========================================
        // STANDARD FLOW: Generate content from draft
        // ========================================
        console.log('AgentMode: Generating blog content from draft with style:', style);
        blogData = await generateBlogContent(
          titleDraft,
          contentDraft,
          length,
          researchContext,
          requirements,
          style
        );

        if (!blogData.title || !blogData.content) {
          throw new Error("Blog content generation failed");
        }

        console.log('AgentMode: Blog content ready. Title:', blogData.title);
        finalContent = blogData.content;
      }

      // ========================================
      // COMMON: Generate Hero Image
      // ========================================
      console.log('AgentMode: Generating hero image...');
      const heroResult = await generateBlogImage(blogData.imagePrompt, userId);
      if (!heroResult.imageUrl) {
        throw new Error('Hero image generation failed');
      }
      const heroImageUrl = heroResult.imageUrl;
      console.log('AgentMode: Hero image generated successfully');

      // ========================================
      // COMMON: Build HTML and Upload to S3
      // ========================================
      console.log('AgentMode: Generating HTML file with style:', style);
      const htmlContent = await generateBlogHtml(
        blogData.title,
        blogData.description,
        finalContent,
        heroImageUrl,
        style
      );
      console.log('AgentMode: Uploading HTML file to S3...');
      const htmlFilename = `blog-${Date.now()}.html`;

      const uploadResult = await uploadFileToS3(
        htmlContent,
        htmlFilename,
        userId,
        'text/html'
      );

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload HTML file to S3');
      }

      const htmlUrl = uploadResult.url;
      console.log('AgentMode: HTML file uploaded successfully to:', htmlUrl);

      // Calculate word count from the content
      const wordCount = blogData.content.split(/\s+/).filter((word: string) => word.length > 0).length;

      return {
        success: true,
        message: this.getBlogSuccessMessage(deepResearch, inlineImagesCount),
        data: {
          title: blogData.title,
          description: blogData.description,
          heroImageUrl: heroImageUrl,
          imageUrl: heroImageUrl,
          htmlUrl: htmlUrl,
          deepResearchUsed: deepResearch,
          inlineImagesCount: inlineImagesCount,
          wordCount: wordCount
        }
      };

    } catch (error: any) {
      console.error('AgentMode: Error creating blog article:', error);
      return {
        success: false,
        message: 'Failed to create blog article',
        error: error.message
      };
    }
  }

  /**
   * Get success message based on options used
   */
  private getBlogSuccessMessage(deepResearch: boolean, inlineCount: number): string {
    const parts = ['Blog article created successfully'];
    if (deepResearch) parts.push('with deep research');
    if (inlineCount > 0) {
      parts.push(`and ${inlineCount} inline images`);
    }
    return parts.join(' ');
  }

  /**
   * Parse {{IMAGE: prompt="...", caption="..."}} placeholders from content
   */
  private parseImagePlaceholders(content: string): Array<{
    fullMatch: string;
    prompt: string;
    caption: string;
  }> {
    const placeholders: Array<{ fullMatch: string; prompt: string; caption: string }> = [];

    // Match {{IMAGE: prompt="...", caption="..."}} pattern
    const regex = /\{\{IMAGE:\s*prompt="([^"]+)",\s*caption="([^"]+)"\}\}/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      placeholders.push({
        fullMatch: match[0],
        prompt: match[1],
        caption: match[2]
      });
    }

    return placeholders;
  }

  /**
   * Replace {{IMAGE: ...}} placeholders with actual <figure> HTML
   */
  private replaceImagePlaceholders(
    content: string,
    placeholders: Array<{ fullMatch: string; prompt: string; caption: string }>,
    imageUrls: string[]
  ): string {
    let result = content;

    placeholders.forEach((placeholder, index) => {
      const imageUrl = imageUrls[index];
      if (!imageUrl) {
        // Remove placeholder if no image was generated
        result = result.replace(placeholder.fullMatch, '');
        return;
      }

      const figureMarkdown = `
![${placeholder.caption}](${imageUrl})
*${placeholder.caption}*
`;

      result = result.replace(placeholder.fullMatch, figureMarkdown);
    });

    return result;
  }

  public async publishBlogArticle(
    title: string,
    description: string,
    heroImageUrl: string,
    blogHtmlUrl: string,
    userId: string,
    sessionId: string,
    status: string = 'draft',
    author?: string,
    categories: string[] = []
  ): Promise<any> {
    try {
      console.log('AgentMode: Publishing blog article - Title:', title, 'Status:', status);

      // Step 1: Fetch HTML and extract body content
      const htmlResponse = await axios.get(blogHtmlUrl, {
        timeout: 30000,
        responseType: 'text',
        headers: {
          'User-Agent': 'AgentWeb-Backend/1.0',
        },
      });

      const htmlContent = htmlResponse.data as string;

      // Extract content from <div class="content"> - find first opening tag and last closing tag before </body>
      const contentDivStart = htmlContent.search(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>/i);
      if (contentDivStart === -1) {
        throw new Error('Could not extract content from HTML. Expected <div class="content"> element.');
      }

      // Find the position after the opening tag
      const afterOpenTag = htmlContent.indexOf('>', contentDivStart) + 1;

      // Find the last </div> before </body>
      const bodyEnd = htmlContent.lastIndexOf('</body>');
      if (bodyEnd === -1) {
        throw new Error('Could not find </body> tag in HTML');
      }

      // Find the last </div> before </body>
      const lastDivClose = htmlContent.lastIndexOf('</div>', bodyEnd);
      if (lastDivClose === -1) {
        throw new Error('Could not find closing </div> tag for content');
      }

      // Extract everything between the opening tag and the last </div>
      let bodyHtml = htmlContent.substring(afterOpenTag, lastDivClose).trim();

      if (!bodyHtml) {
        throw new Error('Content is empty after cleaning');
      }

      // Extract image filename from URL
      let imageFilename: string | undefined;
      if (heroImageUrl) {
        const urlParts = heroImageUrl.split('/');
        imageFilename = urlParts[urlParts.length - 1];
      }

      // Step 3: Get user's CMS type
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);

      if (!user) {
        throw new Error('User not found');
      }

      const cmsType = user.cmsType;

      if (!cmsType) {
        return {
          success: false,
          message: 'CMS Type is not configured for this user. Please contact an administrator to set up CMS publishing.',
          error: 'CMS Type not configured'
        };
      }

      console.log('AgentMode: User CMS Type:', cmsType);

      // Step 4: Publish to CMS
      // Only Webflow is supported for publish_blog_article function
      if (cmsType === 'Webflow') {
        const { getWebflowConfig } = await import('../controllers/blog');
        const { apiToken, siteId, collectionId, fieldMappings, categories: categoryMapping } = await getWebflowConfig(userId);

        // Call Webflow publishing
        const axios = (await import('axios')).default;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        // Use different field names based on whether we're using live endpoint or draft endpoint
        const cmsItemData: any = {
          fieldData: {
            name: title,
            slug: slug,
          }
        };

        // For draft endpoint, use _archived and _draft
        // For live endpoint, use isArchived and isDraft
        if (status === 'draft') {
          cmsItemData.fieldData._archived = false;
          cmsItemData.fieldData._draft = true;
        } else {
          cmsItemData.isArchived = false;
          cmsItemData.isDraft = false;
        }

        // Use body HTML directly for Webflow
        // Webflow API may strip HTML tags if newlines are present, so remove them
        const cleanBodyHtml = bodyHtml.replace(/\n/g, '').replace(/\r/g, '');

        if (fieldMappings?.summary) {
          cmsItemData.fieldData[fieldMappings.summary] = description;
        }

        if (fieldMappings?.body) {
          cmsItemData.fieldData[fieldMappings.body] = cleanBodyHtml;
        }

        if (heroImageUrl && fieldMappings?.image) {
          cmsItemData.fieldData[fieldMappings.image] = heroImageUrl;
        }

        // Add author if provided (use fieldMapping or default to 'author')
        if (author) {
          const authorField = fieldMappings?.author || 'author';
          cmsItemData.fieldData[authorField] = author;
        }

        // Add categories - use fieldMapping or default to 'categories'
        // Detect if field is single reference (singular name) or multi-reference (plural name)
        // Convert category names to IDs using the mapping from secrets manager
        const categoryField = fieldMappings?.category || 'categories';

        // Detect if this is a single reference or multi-reference field
        // Single reference: field name is singular (e.g., "category", "tag")
        // Multi-reference: field name is plural (e.g., "categories", "tags")
        const isSingleReference = !categoryField.endsWith('ies') && !categoryField.endsWith('s');

        console.log(`AgentMode: Category field "${categoryField}" detected as ${isSingleReference ? 'single reference' : 'multi-reference'}`);

        let categoryIds: string[] = [];
        const invalidCategories: string[] = [];

        // Check if category mapping is required but not configured
        if (categories && categories.length > 0 && !categoryMapping) {
          const availableCategories: string[] = [];
          return {
            success: false,
            message: 'Category mapping is not configured in secrets manager. Please configure the "categories" field in your Webflow secrets with category name-to-ID mappings.',
            error: 'Categories mapping required but not configured',
            invalidCategories: categories,
            availableCategories: availableCategories
          };
        }

        if (categories && categories.length > 0 && categoryMapping) {
          // Map category names to IDs
          categoryIds = categories
            .map(name => {
              const id = categoryMapping[name];
              if (!id) {
                console.warn(`AgentMode: Category name "${name}" not found in mapping, skipping`);
                invalidCategories.push(name);
                return null;
              }
              return id;
            })
            .filter((id): id is string => id !== null);

          // If all provided categories are invalid, return error immediately
          if (categories.length > 0 && categoryIds.length === 0) {
            const availableCategories = Object.keys(categoryMapping);
            return {
              success: false,
              message: `All provided category names are invalid: ${invalidCategories.join(', ')}. Available categories: ${availableCategories.join(', ')}`,
              error: 'Invalid category names',
              invalidCategories: invalidCategories,
              availableCategories: availableCategories
            };
          }
        }

        // Set the field value based on reference type
        if (isSingleReference) {
          // Single reference: use only the first category ID
          cmsItemData.fieldData[categoryField] = categoryIds.length > 0 ? categoryIds[0] : '';
          if (categoryIds.length > 1) {
            console.warn(`AgentMode: Field "${categoryField}" is a single reference but ${categoryIds.length} categories provided. Using only the first one: ${categoryIds[0]}`);
          }
        } else {
          // Multi-reference: use array of category IDs
          cmsItemData.fieldData[categoryField] = categoryIds;
        }

        // Log warning if some categories were invalid but others were valid
        if (invalidCategories.length > 0 && categoryIds.length > 0) {
          const availableCategories = categoryMapping ? Object.keys(categoryMapping) : [];
          console.warn(`AgentMode: Some invalid categories were skipped: ${invalidCategories.join(', ')}. Valid categories: ${availableCategories.join(', ')}`);
        }

        // Validate: if status is published, categories cannot be empty
        if (status === 'published' && categoryIds.length === 0) {
          const availableCategories = categoryMapping ? Object.keys(categoryMapping) : [];

          const fieldType = isSingleReference ? 'category (single reference)' : 'categories (multi-reference)';
          let errorMessage = `Cannot publish article without ${fieldType}. Please provide at least one category when status is "published".`;

          // If invalid categories were provided, mention them
          if (invalidCategories.length > 0) {
            errorMessage = `Invalid category names provided: ${invalidCategories.join(', ')}.`;
          }

          // Add available categories to the message
          if (availableCategories.length > 0) {
            errorMessage += ` Available categories: ${availableCategories.join(', ')}`;
          } else {
            errorMessage += ' No category mapping found in configuration.';
          }

          // Add note about single reference if applicable
          if (isSingleReference && categories.length > 1) {
            errorMessage += ` Note: Field "${categoryField}" is a single reference - only the first valid category will be used.`;
          }

          return {
            success: false,
            message: errorMessage,
            error: 'Categories required for published articles',
            invalidCategories: invalidCategories,
            availableCategories: availableCategories,
            fieldType: isSingleReference ? 'single-reference' : 'multi-reference'
          };
        }

        const headers = {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          'accept-version': '2.0.0'
        };

        // Use /items/live endpoint for published articles, /items for drafts
        // Note: The live endpoint uses /collections/{id}/items/live (without /sites/ prefix)
        // while the draft endpoint uses /sites/{siteId}/collections/{id}/items
        const endpoint = status === 'published'
          ? `https://api.webflow.com/v2/collections/${collectionId}/items/live?skipInvalidFiles=true`
          : `https://api.webflow.com/v2/sites/${siteId}/collections/${collectionId}/items`;

        console.log(`AgentMode: Publishing to Webflow ${status === 'published' ? 'live' : 'draft'} endpoint: ${endpoint}`);

        try {
          const response = await axios.post(
            endpoint,
            cmsItemData,
            { headers }
          );

          console.log(`AgentMode: Blog article published successfully to Webflow as ${status}`);

          // Sanitize response to remove large content fields before sending to LLM
          const responseData = response.data as any;
          const sanitizedResponse = responseData && typeof responseData === 'object'
            ? { ...responseData }
            : responseData;

          if (sanitizedResponse && sanitizedResponse.fieldData && typeof sanitizedResponse.fieldData === 'object') {
            const sanitizedFieldData = { ...sanitizedResponse.fieldData };
            // Remove large content fields that aren't needed by the LLM
            delete sanitizedFieldData['post-body'];
            delete sanitizedFieldData['body'];
            sanitizedResponse.fieldData = sanitizedFieldData;
          }

          return {
            success: true,
            message: `Blog article published successfully to Webflow as ${status}`,
            data: {
              title,
              status,
              cmsType: 'Webflow',
              cmsResponse: sanitizedResponse
            }
          };
        } catch (webflowError: any) {
          // Extract detailed error information
          const errorInfo: any = {
            status: webflowError.response?.status,
            statusText: webflowError.response?.statusText,
          };

          if (webflowError.response?.data) {
            const errorData = webflowError.response.data;

            if (errorData.message) {
              errorInfo.message = errorData.message;
            }

            // Extract validation error details
            if (errorData.details && Array.isArray(errorData.details)) {
              errorInfo.details = errorData.details;
              const detailMessages = errorData.details
                .map((d: any) => `${d.param}: ${d.description}`)
                .join('; ');
              if (detailMessages) {
                errorInfo.message = `${errorInfo.message || 'Validation Error'}. ${detailMessages}`;
              }
            }
          }

          // Add available categories to error response so LLM knows what to use
          const availableCategories = categoryMapping ? Object.keys(categoryMapping) : [];
          if (availableCategories.length > 0) {
            errorInfo.message = `${errorInfo.message || 'Webflow API error'}. Available categories: ${availableCategories.join(', ')}`;
            errorInfo.availableCategories = availableCategories;
          }

          // If error is related to file size, suggest using repair_blog_article
          if (errorInfo.message && (
            errorInfo.message.includes('File size limit') ||
            errorInfo.message.includes('failed to import') ||
            errorInfo.message.includes('image') && errorInfo.message.includes('too large')
          )) {
            errorInfo.message += '. SUGGESTION: Use repair_blog_article function to fix image size issues before retrying.';
            errorInfo.repairSuggested = true;
          }

          // Log concise error summary
          if (errorInfo.details && errorInfo.details.length > 0) {
            const errorDetails = errorInfo.details
              .map((d: any) => `${d.param}: ${d.description}`)
              .join(', ');
            console.error(`AgentMode: Webflow API error (${errorInfo.status}): ${errorDetails}`);
          } else {
            console.error(`AgentMode: Webflow API error (${errorInfo.status}): ${errorInfo.message}`);
          }

          // Return error response with available categories so LLM can retry with correct values
          return {
            success: false,
            message: errorInfo.message || `Webflow API error: ${errorInfo.status} ${errorInfo.statusText}`,
            error: 'Webflow API validation error',
            availableCategories: errorInfo.availableCategories || [],
            repairSuggested: errorInfo.repairSuggested || false
          };
        }
      } else if (cmsType === 'Basehub') {
        return {
          success: false,
          message: 'Basehub CMS is not supported for publish_blog_article function. Please use the Research Reports page to publish to Basehub.',
          error: 'Basehub not supported'
        };
      } else {
        return {
          success: false,
          message: `Unsupported CMS Type: ${cmsType}. Supported types are 'Basehub' and 'Webflow'.`,
          error: 'Unsupported CMS Type'
        };
      }
    } catch (error: any) {
      console.error('AgentMode: Error publishing blog article:', error);

      // Extract detailed error information for better user feedback
      let errorMessage = error.message || 'Failed to publish blog article';

      if (error.response?.data) {
        const errorData = error.response.data;

        // Extract validation error details
        if (errorData.details && Array.isArray(errorData.details)) {
          const detailMessages = errorData.details
            .map((d: any) => {
              if (d.param && d.description) {
                return `${d.param}: ${d.description}`;
              }
              return JSON.stringify(d);
            })
            .join('; ');
          if (detailMessages) {
            errorMessage = `Webflow validation error: ${detailMessages}`;
          }
        } else if (errorData.message) {
          errorMessage = errorData.message;
        }
      }

      return {
        success: false,
        message: errorMessage,
        error: error.message || 'Unknown error'
      };
    }
  }

  /**
   * Repair blog article by creating a new version with optimized images
   * Takes only the article URL, finds and resizes all images, creates a new HTML file
   */
  public async repairBlogArticle(
    articleUrl: string,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Repairing blog article...');
      console.log('AgentMode: Article URL:', articleUrl);

      const AWS = (await import('aws-sdk')).default;
      const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'us-west-2',
      });

      const repairResults = {
        imagesRepaired: 0,
        totalImagesChecked: 0,
        originalArticleUrl: articleUrl,
        repairedArticleUrl: articleUrl,
      };

      // Step 1: Download and parse HTML
      console.log('AgentMode: Downloading HTML article...');
      const htmlResponse = await axios.get(articleUrl, {
        timeout: 30000,
        responseType: 'text',
        headers: {
          'User-Agent': 'AgentWeb-Backend/1.0',
        },
      });

      let htmlContent = htmlResponse.data as string;

      // Step 2: Find all images in HTML
      console.log('AgentMode: Looking for all images in HTML...');
      const allImages = new Set<string>();

      // Find all images with class="hero-image" - need to handle both src before/after class
      const heroImageRegex1 = /<img[^>]+class="[^"]*hero-image[^"]*"[^>]+src="([^"]+)"[^>]*>/gi;
      const heroImageRegex2 = /<img[^>]+src="([^"]+)"[^>]+class="[^"]*hero-image[^"]*"[^>]*>/gi;

      let match;
      while ((match = heroImageRegex1.exec(htmlContent)) !== null) {
        const imgUrl = match[1];
        if (imgUrl.includes('agentweb-user-files.s3')) {
          allImages.add(imgUrl);
          console.log(`AgentMode: Found hero image with class="hero-image": ${imgUrl}`);
        }
      }

      while ((match = heroImageRegex2.exec(htmlContent)) !== null) {
        const imgUrl = match[1];
        if (imgUrl.includes('agentweb-user-files.s3')) {
          allImages.add(imgUrl);
          console.log(`AgentMode: Found hero image with class="hero-image": ${imgUrl}`);
        }
      }

      // Also check for images in meta tags (og:image, twitter:image)
      const ogImageMatch = htmlContent.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"[^>]*>/i);
      if (ogImageMatch && ogImageMatch[1].includes('agentweb-user-files.s3')) {
        allImages.add(ogImageMatch[1]);
      }

      const twitterImageMatch = htmlContent.match(/<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"[^>]*>/i);
      if (twitterImageMatch && twitterImageMatch[1].includes('agentweb-user-files.s3')) {
        allImages.add(twitterImageMatch[1]);
      }

      // Find all other images in <img> tags
      const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
      while ((match = imgRegex.exec(htmlContent)) !== null) {
        const imgUrl = match[1];
        if (imgUrl.includes('agentweb-user-files.s3')) {
          allImages.add(imgUrl);
        }
      }

      const imagesToCheck = Array.from(allImages);
      repairResults.totalImagesChecked = imagesToCheck.length;
      console.log(`AgentMode: Found ${imagesToCheck.length} images to check`);

      // Step 3: Check and resize each image if needed
      for (const imgUrl of imagesToCheck) {
        try {
          console.log(`AgentMode: Checking image: ${imgUrl}`);
          const imgResult = await this.checkAndResizeImage(imgUrl, userId);
          if (imgResult.resized) {
            // Replace all occurrences of this URL in HTML
            const escapedUrl = imgUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            htmlContent = htmlContent.replace(new RegExp(escapedUrl, 'g'), imgResult.url);
            repairResults.imagesRepaired++;
            console.log(`AgentMode: Image repaired. Size reduced from ${(imgResult.originalSize / 1024 / 1024).toFixed(2)}MB to ${(imgResult.newSize! / 1024 / 1024).toFixed(2)}MB`);
          } else {
            console.log(`AgentMode: Image OK (${(imgResult.originalSize / 1024 / 1024).toFixed(2)}MB)`);
          }
        } catch (imgError) {
          console.warn(`AgentMode: Failed to check/repair image ${imgUrl}:`, imgError);
          // Continue with other images
        }
      }

      // Step 4: Upload repaired HTML as a new file (always create new version, even if no changes)
      console.log('AgentMode: Creating repaired article...');
      const timestamp = Date.now();
      const htmlKey = `users/${userId}/files/${timestamp}/blog-${timestamp}-repaired.html`;

      await s3.putObject({
        Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
        Key: htmlKey,
        Body: htmlContent,
        ContentType: 'text/html',
      }).promise();

      repairResults.repairedArticleUrl = `https://${process.env.AWS_S3_BUCKET || 'agentweb-user-files'}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${htmlKey}`;
      console.log('AgentMode: Repaired article uploaded:', repairResults.repairedArticleUrl);

      // Step 6: Extract hero image URL from repaired HTML for convenience
      let heroImageUrl = '';

      // Try to find hero image with class="hero-image" (both attribute orders)
      const heroMatch1 = htmlContent.match(/<img[^>]+class="[^"]*hero-image[^"]*"[^>]+src="([^"]+)"[^>]*>/i);
      const heroMatch2 = htmlContent.match(/<img[^>]+src="([^"]+)"[^>]+class="[^"]*hero-image[^"]*"[^>]*>/i);

      if (heroMatch1) {
        heroImageUrl = heroMatch1[1];
      } else if (heroMatch2) {
        heroImageUrl = heroMatch2[1];
      } else {
        // Fallback to og:image meta tag
        const ogImageMatchFinal = htmlContent.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"[^>]*>/i);
        if (ogImageMatchFinal) {
          heroImageUrl = ogImageMatchFinal[1];
        }
      }

      // Step 5: Return repair results
      const message = repairResults.imagesRepaired > 0
        ? `Blog article repaired successfully. Fixed ${repairResults.imagesRepaired} of ${repairResults.totalImagesChecked} image(s) by resizing to meet file size limits. Use the repaired URLs to retry publishing.`
        : `Blog article checked. All ${repairResults.totalImagesChecked} image(s) are within limits. A new article version has been created.`;

      return {
        success: true,
        message,
        repairedArticleUrl: repairResults.repairedArticleUrl,
        heroImageUrl: heroImageUrl,
        imagesRepaired: repairResults.imagesRepaired,
        totalImagesChecked: repairResults.totalImagesChecked,
        originalArticleUrl: repairResults.originalArticleUrl,
      };
    } catch (error: any) {
      console.error('AgentMode: Error repairing blog article:', error);
      return {
        success: false,
        message: `Failed to repair blog article: ${error.message}`,
        error: error.message || 'Unknown error'
      };
    }
  }

  /**
   * Check image size and resize if needed for Webflow compatibility
   * Webflow has a 4MB file size limit for images
   */
  private async checkAndResizeImage(
    imageUrl: string,
    userId: string
  ): Promise<{ url: string; resized: boolean; originalSize: number; newSize?: number }> {
    const sharp = (await import('sharp')).default;
    const AWS = (await import('aws-sdk')).default;

    // Configure S3
    const s3 = new AWS.S3({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-west-2',
    });

    // Webflow's image size limit (4MB)
    const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB in bytes

    try {
      // Download image from S3
      console.log('AgentMode: Downloading image from S3:', imageUrl);
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const imageBuffer = Buffer.from(imageResponse.data as ArrayBuffer);
      const originalSize = imageBuffer.length;

      console.log(`AgentMode: Original image size: ${originalSize} bytes (${(originalSize / 1024 / 1024).toFixed(2)} MB)`);

      // If image is within size limit, return original URL
      if (originalSize <= MAX_FILE_SIZE) {
        return { url: imageUrl, resized: false, originalSize };
      }

      // Image is too large, resize it
      console.log('AgentMode: Image exceeds 4MB limit, resizing...');

      // Resize image to reduce file size
      // Start with 80% quality and adjust if needed
      let resizedBuffer: Buffer;
      let quality = 80;
      let width = 1920; // Max width for blog images

      do {
        const sharpInstance = sharp(imageBuffer).resize(width, null, {
          fit: 'inside',
          withoutEnlargement: true,
        });

        // Apply format-specific compression
        const metadata = await sharp(imageBuffer).metadata();
        if (metadata.format === 'png') {
          resizedBuffer = await sharpInstance.png({ quality, compressionLevel: 9 }).toBuffer();
        } else if (metadata.format === 'webp') {
          resizedBuffer = await sharpInstance.webp({ quality }).toBuffer();
        } else {
          // Default to JPEG for other formats
          resizedBuffer = await sharpInstance.jpeg({ quality }).toBuffer();
        }

        console.log(`AgentMode: Resized to ${width}px width, quality ${quality}, size: ${resizedBuffer.length} bytes`);

        // If still too large, reduce quality further
        if (resizedBuffer.length > MAX_FILE_SIZE && quality > 50) {
          quality -= 10;
        } else if (resizedBuffer.length > MAX_FILE_SIZE && width > 1280) {
          width = 1280;
          quality = 80;
        } else {
          break;
        }
      } while (resizedBuffer.length > MAX_FILE_SIZE && (quality >= 50 || width >= 1280));

      // Generate new filename
      const timestamp = Date.now();
      const originalFilename = imageUrl.split('/').pop() || 'resized-image.jpg';
      const extension = originalFilename.split('.').pop();
      const filenameWithoutExt = originalFilename.replace(`.${extension}`, '');
      const newFilename = `${filenameWithoutExt}-resized-${timestamp}.${extension}`;

      // Upload resized image to S3
      const s3Key = `users/${userId}/files/${timestamp}/${newFilename}`;
      console.log('AgentMode: Uploading resized image to S3:', s3Key);

      await s3.putObject({
        Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
        Key: s3Key,
        Body: resizedBuffer,
        ContentType: `image/${extension}`,
      }).promise();

      const newImageUrl = `https://${process.env.AWS_S3_BUCKET || 'agentweb-user-files'}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${s3Key}`;

      console.log(`AgentMode: Resized image uploaded successfully. New size: ${resizedBuffer.length} bytes (${(resizedBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

      return {
        url: newImageUrl,
        resized: true,
        originalSize,
        newSize: resizedBuffer.length,
      };
    } catch (error) {
      console.error('AgentMode: Error resizing image:', error);
      throw error;
    }
  }

  public async createSocialMediaPosts(
    posts: Array<{ type: string; content: string; image_url?: string }>,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Creating social media posts, count:', posts?.length || 0);

      if (!posts || !Array.isArray(posts) || posts.length === 0) {
        return {
          success: false,
          message: 'No posts provided. Please provide an array of posts.',
          error: 'invalid_input'
        };
      }

      // Import required utilities
      const { uploadFileToS3 } = await import('../utils/s3Utils');

      // Dynamically import remark modules (ES modules)
      const { remark } = await import('remark');
      const remarkHtml = (await import('remark-html')).default;
      const remarkGfm = (await import('remark-gfm')).default;
      const remarkBreaks = (await import('remark-breaks')).default;

      // Convert markdown to HTML processor
      const processor = remark()
        .use(remarkGfm) // GitHub Flavored Markdown support
        .use(remarkBreaks) // Convert line breaks to <br> tags
        .use(remarkHtml, { sanitize: false }); // Convert to HTML

      // Generate HTML for each post
      const postsHtml = posts.map((post, index) => {
        const postNumber = index + 1;
        // Map post types to display labels
        const typeLabelMap: Record<string, string> = {
          'linkedin': 'LinkedIn',
          'x/twitter': 'X (Twitter)',
          'instagram': 'Instagram',
          'facebook': 'Facebook',
          'custom': 'Custom'
        };
        const typeLabel = typeLabelMap[post.type] || post.type.charAt(0).toUpperCase() + post.type.slice(1);

        // Convert markdown content to HTML
        const htmlContent = processor.processSync(post.content || '').toString();

        // Build post HTML
        let postHtml = `
      <div class="post" data-type="${post.type}">
        <div class="post-header">
          <span class="post-number">Post ${postNumber}</span>
          <span class="post-type">${typeLabel}</span>
        </div>
        <div class="post-content">
          ${htmlContent}
        </div>`;

        // Add image if provided
        if (post.image_url) {
          postHtml += `
        <div class="post-image">
          <img src="${post.image_url}" alt="Post image" />
        </div>`;
        }

        // Add copy button
        postHtml += `
        <div class="post-actions">
          <button class="copy-button" onclick="copyPostContent(${index})">Copy Content</button>
        </div>
        <div class="post-raw-content" id="post-${index}-raw" style="display: none;">${post.content}</div>
      </div>`;

        return postHtml;
      }).join('\n');

      // Generate complete HTML file
      const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Social Media Posts</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f5f5f5;
            padding: 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            padding: 30px;
        }
        h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 10px;
            color: #1a1a1a;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .post {
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
            background-color: #fafafa;
        }
        .post-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e0e0e0;
        }
        .post-number {
            font-weight: 600;
            color: #666;
            font-size: 14px;
        }
        .post-type {
            background-color: #0077b5;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .post[data-type="x/twitter"] .post-type {
            background-color: #1da1f2;
        }
        .post[data-type="instagram"] .post-type {
            background: linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%);
        }
        .post[data-type="facebook"] .post-type {
            background-color: #1877f2;
        }
        .post[data-type="custom"] .post-type {
            background-color: #666;
        }
        .post-content {
            margin: 15px 0;
            font-size: 16px;
            line-height: 1.6;
            color: #333;
        }
        .post-content p {
            margin-bottom: 12px;
        }
        .post-content h1, .post-content h2, .post-content h3 {
            margin-top: 20px;
            margin-bottom: 12px;
        }
        .post-content ul, .post-content ol {
            margin-left: 20px;
            margin-bottom: 12px;
        }
        .post-content a {
            color: #0077b5;
            text-decoration: none;
        }
        .post-content a:hover {
            text-decoration: underline;
        }
        .post-content img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            margin: 15px 0;
            display: block;
        }
        .post-image {
            margin: 15px 0;
        }
        .post-image img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .post-actions {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #e0e0e0;
        }
        .copy-button {
            background-color: #0077b5;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: background-color 0.2s;
        }
        .copy-button:hover {
            background-color: #005885;
        }
        .copy-button:active {
            transform: scale(0.98);
        }
        .post-raw-content {
            display: none;
        }
        @media (max-width: 600px) {
            .container {
                padding: 15px;
            }
            .post {
                padding: 15px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Social Media Posts</h1>
        <p class="subtitle">${posts.length} post${posts.length !== 1 ? 's' : ''} created</p>
        ${postsHtml}
    </div>
    <script>
        function copyPostContent(index) {
            const rawContentElement = document.getElementById('post-' + index + '-raw');
            if (!rawContentElement) return;
            
            const content = rawContentElement.textContent || rawContentElement.innerText;
            
            // Create a temporary textarea to copy text
            const textarea = document.createElement('textarea');
            textarea.value = content;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            
            try {
                document.execCommand('copy');
                const button = event.target;
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.style.backgroundColor = '#28a745';
                setTimeout(() => {
                    button.textContent = originalText;
                    button.style.backgroundColor = '#0077b5';
                }, 2000);
            } catch (err) {
                console.error('Failed to copy:', err);
                alert('Failed to copy content. Please select and copy manually.');
            }
            
            document.body.removeChild(textarea);
        }
    </script>
</body>
</html>`;

      // Upload HTML file to S3
      console.log('AgentMode: Uploading social media posts HTML file to S3...');
      const htmlFilename = `social-media-posts-${Date.now()}.html`;

      const uploadResult = await uploadFileToS3(
        htmlContent,
        htmlFilename,
        userId,
        'text/html'
      );

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload HTML file to S3');
      }

      const htmlUrl = uploadResult.url;

      console.log('AgentMode: Social media posts HTML file uploaded successfully to:', htmlUrl);

      return {
        success: true,
        message: `Successfully created ${posts.length} social media post${posts.length !== 1 ? 's' : ''}`,
        htmlUrl: htmlUrl,
        postsCount: posts.length
      };

    } catch (error: any) {
      console.error('AgentMode: Error creating social media posts:', error);
      return {
        success: false,
        message: 'Failed to create social media posts',
        error: error.message
      };
    }
  }

  /**
   * Get task subscriber metrics for Agent Mode function calls
   */
  public async getTaskSubscriberMetrics(taskId: string, userId: string): Promise<any> {
    try {
      const { TaskSubscriberMetricsService } = await import('./taskSubscriberMetricsService');
      const metrics = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

      // Strip engagedEmails from subject metrics to reduce data for agent processing
      const cleanedMetrics = {
        ...metrics,
        metrics: {
          ...metrics.metrics,
          subjectMetrics: Object.fromEntries(
            Object.entries(metrics.metrics.subjectMetrics).map(([subject, subjectData]) => [
              subject,
              Object.fromEntries(
                Object.entries(subjectData).filter(([key]) => key !== 'engagedEmails')
              )
            ])
          )
        }
      };

      return {
        success: true,
        message: 'Task subscriber metrics retrieved successfully',
        data: cleanedMetrics
      };
    } catch (error: any) {
      console.error('AgentMode: Error getting task subscriber metrics:', error);
      return {
        success: false,
        message: 'Failed to get task subscriber metrics',
        error: error.message
      };
    }
  }

  /**
   * Get task subscriber engagement events for Agent Mode function calls
   * Returns engagement metrics instead of raw events for better agent processing
   */
  public async getTaskSubscriberEngagementEvents(taskId: string, emailSubject: string, userId: string): Promise<any> {
    try {
      const { TaskSubscriberMetricsService } = await import('./taskSubscriberMetricsService');
      const events = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

      // Transform raw events into meaningful engagement metrics
      const engagementMetrics = this.calculateEngagementMetrics(events);

      return {
        success: true,
        message: 'Task subscriber engagement metrics retrieved successfully',
        data: engagementMetrics
      };
    } catch (error: any) {
      console.error('AgentMode: Error getting task subscriber engagement events:', error);
      return {
        success: false,
        message: 'Failed to get task subscriber engagement events',
        error: error.message
      };
    }
  }

  /**
   * Calculate engagement metrics from raw events data
   */
  private calculateEngagementMetrics(events: any) {
    const { eventsByUser, totalEngagedUsers, taskId, emailSubject } = events;

    if (totalEngagedUsers === 0) {
      return {
        taskId,
        emailSubject,
        engagementPatterns: {
          immediateEngagement: 0,
          delayedEngagement: 0,
          multiTouchEngagement: 0,
          singleTouchEngagement: 0
        },
        timingMetrics: {
          averageTimeToOpen: null,
          averageTimeToClick: null,
          fastestEngagement: null,
          slowestEngagement: null
        },
        linkAnalysis: []
      };
    }

    // Calculate engagement-specific metrics
    let clickedCount = 0;
    const linkClicks = new Map<string, number>();
    const engagementTimes: number[] = [];
    const openTimes: number[] = [];
    const clickTimes: number[] = [];

    // Analyze each user's engagement
    let immediateEngagement = 0; // Users who engaged within 1 hour
    let delayedEngagement = 0; // Users who engaged after 1 hour
    let multiTouchEngagement = 0; // Users with 2+ engagement events (opened or clicked)
    let singleTouchEngagement = 0; // Users with only 1 engagement event (opened or clicked)

    eventsByUser.forEach((user: any) => {
      const userEvents = user.events;

      // Count event types for engagement analysis
      const eventTypes = new Set(userEvents.map((e: any) => e.eventType));
      userEvents.forEach((event: any) => {
        if (event.eventType === 'email.clicked') {
          clickedCount++;
          if (event.link) {
            // Normalize unsubscribe links by replacing email with placeholder
            let normalizedLink = event.link;
            if (event.link.includes('/unsubscribe?') && event.link.includes('email=')) {
              normalizedLink = event.link.replace(/email=[^&]+/, 'email=placeholder@example.com');
            }
            linkClicks.set(normalizedLink, (linkClicks.get(normalizedLink) || 0) + 1);
          }
        }
      });

      // Calculate engagement timing
      if (userEvents.length > 0) {
        const firstEvent = userEvents[0];
        const firstEventTime = new Date(firstEvent.createdAt).getTime();
        const emailSentTime = firstEventTime; // Assuming first event is delivery

        // Find first engagement (open or click)
        const firstEngagement = userEvents.find((e: any) =>
          e.eventType === 'email.opened' || e.eventType === 'email.clicked'
        );

        if (firstEngagement) {
          const engagementTime = new Date(firstEngagement.createdAt).getTime();
          const timeToEngagement = engagementTime - emailSentTime;
          engagementTimes.push(timeToEngagement);

          // Categorize engagement timing
          if (timeToEngagement <= 3600000) { // 1 hour in milliseconds
            immediateEngagement++;
          } else {
            delayedEngagement++;
          }
        }

        // Find open and click times
        const openEvent = userEvents.find((e: any) => e.eventType === 'email.opened');
        const clickEvent = userEvents.find((e: any) => e.eventType === 'email.clicked');

        if (openEvent) {
          const openTime = new Date(openEvent.createdAt).getTime();
          openTimes.push(openTime - emailSentTime);
        }

        if (clickEvent) {
          const clickTime = new Date(clickEvent.createdAt).getTime();
          clickTimes.push(clickTime - emailSentTime);
        }

        // Categorize engagement depth based on opened/clicked events
        const engagementEvents = userEvents.filter((event: any) =>
          event.eventType === 'email.opened' || event.eventType === 'email.clicked'
        );

        if (engagementEvents.length >= 2) {
          multiTouchEngagement++;
        } else if (engagementEvents.length === 1) {
          singleTouchEngagement++;
        }
      }
    });

    // Calculate timing metrics
    const averageTimeToOpen = openTimes.length > 0
      ? Math.round(openTimes.reduce((a, b) => a + b, 0) / openTimes.length / 1000 / 60) // Convert to minutes
      : null;

    const averageTimeToClick = clickTimes.length > 0
      ? Math.round(clickTimes.reduce((a, b) => a + b, 0) / clickTimes.length / 1000 / 60) // Convert to minutes
      : null;

    const fastestEngagement = engagementTimes.length > 0
      ? Math.round(Math.min(...engagementTimes) / 1000 / 60) // Convert to minutes
      : null;

    const slowestEngagement = engagementTimes.length > 0
      ? Math.round(Math.max(...engagementTimes) / 1000 / 60) // Convert to minutes
      : null;

    // Convert link clicks map to array of objects
    const linkAnalysis = Array.from(linkClicks.entries()).map(([url, clicks]) => ({
      url,
      clicks
    })).sort((a, b) => b.clicks - a.clicks); // Sort by click count descending

    return {
      taskId,
      emailSubject,
      engagementPatterns: {
        immediateEngagement,
        delayedEngagement,
        multiTouchEngagement,
        singleTouchEngagement
      },
      timingMetrics: {
        averageTimeToOpen,
        averageTimeToClick,
        fastestEngagement,
        slowestEngagement
      },
      linkAnalysis
    };
  }

  // List all HTML templates for the user (including email templates)
  public async listHtmlTemplates(userId: string): Promise<any> {
    try {
      const settingName = `email_templates_${userId}`;
      const setting = await settingsService.getSetting(settingName);

      let templates = [];
      if (setting) {
        try {
          templates = JSON.parse(setting.settingValue);
        } catch (error) {
          console.error('Error parsing email templates:', error);
          templates = [];
        }
      }

      return {
        success: true,
        email_templates: templates.map((template: any) => ({
          template_name: template.template_name,
          subject: template.subject,
          variables: template.variables || [],
          arrayVariables: template.arrayVariables || [],
          created_at: template.created_at,
          updated_at: template.updated_at
        }))
      };
    } catch (error) {
      console.error('Error listing email templates:', error);
      return {
        success: false,
        message: 'Failed to list email templates',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update HTML file with direct content replacement
  public async updateHtmlFile(
    fileUrl: string,
    updateType: string,
    replacementInstructions: any,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      // Validate update_type first (before fetching file)
      if (!updateType || !['part', 'full'].includes(updateType)) {
        return {
          success: false,
          message: 'update_type must be either "part" or "full"'
        };
      }

      // Validate replacement instructions (before fetching file)
      // This is a quick validation to catch errors early
      if (!Array.isArray(replacementInstructions)) {
        return {
          success: false,
          message: 'replacement_json must be an array of replacement instructions'
        };
      }

      if (replacementInstructions.length === 0) {
        return {
          success: false,
          message: 'At least one replacement instruction is required'
        };
      }

      // Fetch current file content
      const currentContent = await this.fetchFileContent(fileUrl);
      console.log(`AgentMode: Fetched file content, length: ${currentContent.length} characters`);

      // Compute hash of current content for verification
      const currentContentHash = createHash('sha256').update(currentContent).digest('hex');
      console.log(`AgentMode: Computed current content hash: ${currentContentHash}`);

      // Use common replacement function
      const replacementResult = this.performContentReplacements(
        currentContent,
        currentContentHash,
        updateType,
        replacementInstructions
      );

      if (!replacementResult.success) {
        // Map error messages to match expected format for HTML files
        let errorMessage = replacementResult.error?.message || 'Failed to perform replacements';

        // Replace generic messages with HTML-specific ones for backward compatibility
        if (replacementResult.error?.isHashMismatch || errorMessage.includes('Content hash mismatch')) {
          errorMessage = errorMessage.replace('Content hash mismatch', 'File hash mismatch');
        }

        return {
          success: false,
          message: errorMessage,
          suggestion: replacementResult.error?.suggestion
        };
      }

      // Create versioned filename and upload the updated content
      const versionedFilename = this.createVersionedFilename(fileUrl);
      console.log(`AgentMode: Original file URL: ${fileUrl}`);
      console.log(`AgentMode: Generated versioned filename: ${versionedFilename}`);
      const originalPath = this.extractPathFromS3Url(fileUrl);
      console.log(`AgentMode: Original path: ${originalPath}`);
      const uploadResult = await this.uploadUpdatedFile(replacementResult.updatedContent!, versionedFilename, originalPath);

      return {
        success: true,
        s3_url: uploadResult.url,
        message: `File updated successfully with ${replacementResult.replacementResults!.length} replacements`,
        method: 'mixed_replacement',
        replacements: replacementResult.replacementResults,
        versioned_filename: versionedFilename
      };

    } catch (error) {
      console.error('Error updating HTML file:', error);
      return {
        success: false,
        message: 'Failed to update HTML file',
        error: error instanceof Error ? error.message : 'Unknown error',
        suggestion: 'For entire file replacement, use old_content_hash from read_file_content. For partial replacement, use old_content with the exact text to replace'
      };
    }
  }

  // Fetch file content from URL
  public async fetchFileContent(fileUrl: string): Promise<string> {
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      console.error('Error fetching file content:', error);
      throw new Error(`Failed to fetch file content: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Common function to validate and perform content replacements
  // Used by both update_html_file and update_book_content
  private performContentReplacements(
    currentContent: string,
    currentContentHash: string,
    updateType: string,
    replacementInstructions: any[]
  ): { success: boolean; updatedContent?: string; replacementResults?: any[]; error?: any } {
    // Validate update_type
    if (!updateType || !['part', 'full'].includes(updateType)) {
      return {
        success: false,
        error: {
          message: 'update_type must be either "part" or "full"'
        }
      };
    }

    // Validate that replacementInstructions is an array
    if (!Array.isArray(replacementInstructions)) {
      return {
        success: false,
        error: {
          message: 'replacement_json must be an array of replacement instructions'
        }
      };
    }

    if (replacementInstructions.length === 0) {
      return {
        success: false,
        error: {
          message: 'At least one replacement instruction is required'
        }
      };
    }

    // Validate each replacement instruction based on update_type
    for (let i = 0; i < replacementInstructions.length; i++) {
      const instruction = replacementInstructions[i];

      if (instruction.new_content === undefined || instruction.expected_count === undefined) {
        return {
          success: false,
          error: {
            message: `Missing required fields in replacement instruction ${i + 1}: new_content and expected_count are required`
          }
        };
      }

      if (updateType === 'full') {
        // For full replacement, require old_content_hash
        if (!instruction.old_content_hash) {
          return {
            success: false,
            error: {
              message: `Replacement instruction ${i + 1} missing old_content_hash. For update_type="full", old_content_hash is required`
            }
          };
        }
        if (instruction.old_content !== undefined) {
          return {
            success: false,
            error: {
              message: `Replacement instruction ${i + 1} should not have old_content when update_type="full". Use hash instead`
            }
          };
        }
      } else if (updateType === 'part') {
        // For part replacement, require old_content
        if (!instruction.old_content) {
          return {
            success: false,
            error: {
              message: `Replacement instruction ${i + 1} missing old_content. For update_type="part", old_content is required`
            }
          };
        }
        if (instruction.old_content_hash !== undefined) {
          return {
            success: false,
            error: {
              message: `Replacement instruction ${i + 1} should not have old_content_hash when update_type="part". Use old_content instead`
            }
          };
        }
      }
    }

    let updatedContent = currentContent;
    const replacementResults = [];

    // Perform all replacements
    for (let i = 0; i < replacementInstructions.length; i++) {
      const instruction = replacementInstructions[i];
      const { new_content, expected_count } = instruction;

      if (updateType === 'full') {
        // Entire content replacement using hash
        const providedHash = instruction.old_content_hash;
        console.log(`AgentMode: Full replacement ${i + 1}: hash: ${providedHash}, new_content length: ${new_content.length}, expected_count: ${expected_count}`);

        // Verify that the provided hash matches the current content hash
        if (providedHash !== currentContentHash) {
          return {
            success: false,
            error: {
              message: `Replacement ${i + 1} failed: Content hash mismatch. Expected: ${currentContentHash}, provided: ${providedHash}. The content may have been modified since it was last read.`,
              suggestion: 'Use get_book_content or read_file_content to get the current content and hash, then retry the replacement',
              isHashMismatch: true // Flag for HTML file error message mapping
            }
          };
        }

        // For hash-based replacement, we replace the entire content
        if (expected_count === 1) {
          console.log(`AgentMode: Hash verification successful, replacing entire content`);
          updatedContent = new_content;
          replacementResults.push({
            index: i + 1,
            old_content_hash: instruction.old_content_hash,
            new_content: new_content,
            expected_count: expected_count,
            actual_count: 1,
            success: true
          });
        } else {
          return {
            success: false,
            error: {
              message: `Replacement ${i + 1} failed: Full replacement only supports expected_count of 1 (entire content replacement)`,
              suggestion: 'Use expected_count: 1 for full content replacement'
            }
          };
        }
      } else if (updateType === 'part') {
        // Partial content replacement using old_content
        const { old_content } = instruction;
        console.log(`AgentMode: Part replacement ${i + 1}: old_content length: ${old_content.length}, new_content length: ${new_content.length}, expected_count: ${expected_count}`);

        // Perform the replacement using the existing logic
        const replacementResult = this.performDirectReplacement(
          updatedContent,
          old_content,
          new_content,
          true // exact_match = true for partial replacements
        );

        if (replacementResult === null) {
          return {
            success: false,
            error: {
              message: `Replacement ${i + 1} failed: The old_content was not found in the content. No changes were made.`,
              suggestion: 'Check that the old_content exactly matches the content. Use get_book_content or read_file_content to retrieve the exact current content.'
            }
          };
        }

        // Check if the actual change count matches expected count
        if (replacementResult.changeCount !== expected_count) {
          return {
            success: false,
            error: {
              message: `Replacement ${i + 1} failed: Expected ${expected_count} occurrences of old_content, but found ${replacementResult.changeCount}. No changes were made.`,
              suggestion: 'Check the expected_count matches the actual number of occurrences in the content'
            }
          };
        }

        updatedContent = replacementResult.content;
        replacementResults.push({
          index: i + 1,
          old_content: old_content,
          new_content: new_content,
          expected_count: expected_count,
          actual_count: replacementResult.changeCount,
          success: true
        });
      }
    }

    return {
      success: true,
      updatedContent,
      replacementResults
    };
  }

  // Perform direct replacement of old content with new content
  private performDirectReplacement(
    content: string,
    oldContent: string,
    newContent: string,
    exactMatch: boolean = true
  ): { content: string; changeCount: number } | null {
    try {
      // For entire file replacement (when oldContent is very large), use more flexible matching
      if (oldContent.length > 1000) {
        if (exactMatch) {
          // Use exact string comparison
          if (content === oldContent) {
            console.log(`AgentMode: Exact match found for entire file replacement`);
            return { content: newContent, changeCount: 1 };
          } else {
            console.warn(`Old content does not match exactly. Expected length: ${oldContent.length}, actual length: ${content.length}`);
            console.warn(`First 100 chars of expected: ${oldContent.substring(0, 100)}`);
            console.warn(`First 100 chars of actual: ${content.substring(0, 100)}`);
            return null;
          }
        } else {
          // Use normalized whitespace comparison for flexible matching
          const normalizedContent = content.replace(/\s+/g, ' ').trim();
          const normalizedOldContent = oldContent.replace(/\s+/g, ' ').trim();

          if (normalizedContent === normalizedOldContent) {
            console.log(`AgentMode: Normalized match found for entire file replacement`);
            return { content: newContent, changeCount: 1 };
          } else {
            // Try exact match as fallback
            if (content === oldContent) {
              console.log(`AgentMode: Exact match found for entire file replacement (fallback)`);
              return { content: newContent, changeCount: 1 };
            } else {
              console.warn(`Old content does not match even with normalization. Expected length: ${oldContent.length}, actual length: ${content.length}`);
              console.warn(`First 100 chars of expected: ${oldContent.substring(0, 100)}`);
              console.warn(`First 100 chars of actual: ${content.substring(0, 100)}`);
              return null;
            }
          }
        }
      }

      // For smaller content, use regex for more flexible matching
      const changeCount = (content.match(new RegExp(oldContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

      // Check if old content exists
      if (changeCount === 0) {
        console.warn(`Old content not found. Content length: ${content.length}, old content length: ${oldContent.length}`);
        return null;
      }

      // Perform replacement - replace all occurrences
      const updatedContent = content.replace(new RegExp(oldContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newContent);

      return { content: updatedContent, changeCount };

    } catch (error) {
      console.error('Error in direct replacement:', error);
      return null;
    }
  }

  // Extract path from S3 URL
  private extractPathFromS3Url(s3Url: string): string {
    try {
      // Parse the S3 URL to extract the key
      const url = new URL(s3Url);
      const key = url.pathname.substring(1); // Remove leading slash

      // Extract path by removing the filename
      const lastSlashIndex = key.lastIndexOf('/');
      if (lastSlashIndex === -1) {
        return ''; // No path, just filename
      }

      return key.substring(0, lastSlashIndex);
    } catch (error) {
      console.error('Error extracting path from S3 URL:', error);
      return '';
    }
  }

  // Create versioned filename
  private createVersionedFilename(originalUrl: string): string {
    try {
      // Extract filename from original URL
      const urlParts = originalUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      console.log(`AgentMode: Extracted filename: ${filename}`);

      // Split filename into name and extension
      const lastDotIndex = filename.lastIndexOf('.');
      if (lastDotIndex === -1) {
        // No extension, just add version
        console.log(`AgentMode: No extension found, adding _v2`);
        return `${filename}_v2`;
      }

      const nameWithoutExt = filename.substring(0, lastDotIndex);
      const extension = filename.substring(lastDotIndex);
      console.log(`AgentMode: Name without ext: ${nameWithoutExt}, extension: ${extension}`);

      // Check if filename already has a version pattern (_v followed by digits)
      const versionMatch = nameWithoutExt.match(/^(.+)_v(\d+)$/);
      console.log(`AgentMode: Version match result:`, versionMatch);

      if (versionMatch) {
        // Extract base name and current version number
        const baseName = versionMatch[1];
        const currentVersion = parseInt(versionMatch[2], 10);
        const newVersion = currentVersion + 1;
        console.log(`AgentMode: Found existing version ${currentVersion}, incrementing to ${newVersion}`);
        return `${baseName}_v${newVersion}${extension}`;
      } else {
        // No existing version, add _v2
        console.log(`AgentMode: No existing version found, adding _v2`);
        return `${nameWithoutExt}_v2${extension}`;
      }
    } catch (error) {
      console.error('Error creating versioned filename:', error);
      // Fallback: add timestamp to avoid conflicts
      const timestamp = Date.now();
      const urlParts = originalUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      const lastDotIndex = filename.lastIndexOf('.');

      if (lastDotIndex === -1) {
        return `${filename}_v2_${timestamp}`;
      } else {
        const nameWithoutExt = filename.substring(0, lastDotIndex);
        const extension = filename.substring(lastDotIndex);
        return `${nameWithoutExt}_v2_${timestamp}${extension}`;
      }
    }
  }

  // Upload updated file content
  public async uploadUpdatedFile(
    content: string,
    filename: string,
    path: string
  ): Promise<{ url: string }> {
    try {
      // Upload to S3 with the same path as the original file
      const { uploadFileToS3WithPath } = await import('../utils/s3Utils');
      const uploadResult = await uploadFileToS3WithPath(content, filename, 'text/html', path);

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload updated file');
      }

      return { url: uploadResult.url };
    } catch (error) {
      console.error('Error uploading updated file:', error);
      throw new Error(`Failed to upload updated file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Create HTML from template with variable substitution
  public async createHtmlFromTemplate(
    llmModel: string,
    templateName: string,
    variableValues: Record<string, string> | undefined,
    arrayVariableValues: Record<string, string[]> | undefined,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      // Get the template
      const settingName = `email_templates_${userId}`;
      const setting = await settingsService.getSetting(settingName);

      if (!setting) {
        return {
          success: false,
          message: 'No email templates found for user'
        };
      }

      let templates = [];
      try {
        templates = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error('Error parsing email templates:', error);
        return {
          success: false,
          message: 'Failed to parse email templates'
        };
      }

      // Find the specific template
      const template = templates.find((t: any) => t.template_name === templateName);
      if (!template) {
        return {
          success: false,
          message: `Template '${templateName}' not found`
        };
      }

      // Validate template structure first
      if (!template.html_content || !template.subject) {
        return {
          success: false,
          message: 'Invalid template structure: missing html_content or subject'
        };
      }
      if (!llmModel) {
        llmModel = await this.getDefaultModel();
      }
      // Validate that all required variables are provided
      const templateVariables = template.variables || [];
      const templateArrayVariables = template.arrayVariables || [];

      // Parameters are already objects
      const variableValuesObj = variableValues || {};
      const arrayVariableValuesObj = arrayVariableValues || {};

      // Check for missing regular variables
      const missingVariables = templateVariables.filter((variable: string) =>
        !(variable in variableValuesObj)
      );

      // Check for missing array variables
      const missingArrayVariables = templateArrayVariables.filter((variable: string) =>
        !(variable in arrayVariableValuesObj)
      );

      // Check for extra variables that aren't in the template
      const extraVariables = Object.keys(variableValuesObj).filter(variable =>
        !templateVariables.includes(variable)
      );

      const extraArrayVariables = Object.keys(arrayVariableValuesObj).filter(variable =>
        !templateArrayVariables.includes(variable)
      );

      // Build validation error message
      const validationErrors = [];

      if (missingVariables.length > 0) {
        validationErrors.push(`Missing required variables: ${missingVariables.join(', ')}`);
      }

      if (missingArrayVariables.length > 0) {
        validationErrors.push(`Missing required array variables: ${missingArrayVariables.join(', ')}`);
      }

      if (extraVariables.length > 0) {
        validationErrors.push(`Extra variables provided: ${extraVariables.join(', ')}`);
      }

      if (extraArrayVariables.length > 0) {
        validationErrors.push(`Extra array variables provided: ${extraArrayVariables.join(', ')}`);
      }

      // Validate array variable values are actually arrays
      const invalidArrayVariables = Object.entries(arrayVariableValuesObj).filter(([key, value]) =>
        !Array.isArray(value)
      );

      if (invalidArrayVariables.length > 0) {
        validationErrors.push(`Array variable items must be an array: ${invalidArrayVariables.map(([key]) => key).join(', ')}`);
      }

      if (validationErrors.length > 0) {
        return {
          success: false,
          message: validationErrors.join('; '),
          errors: validationErrors,
          template_variables: templateVariables,
          template_array_variables: templateArrayVariables
        };
      }

      // Use LLM to handle variable substitution
      const substitutionPrompt = `You are a template engine. Your task is to replace variables in HTML templates with provided values while preserving the exact same format and structure.

TEMPLATE HTML:
${template.html_content}

TEMPLATE SUBJECT:
${template.subject}

VARIABLE VALUES:
${JSON.stringify(variableValuesObj, null, 2)}

ARRAY VARIABLE VALUES:
${JSON.stringify(arrayVariableValuesObj, null, 2)}

CRITICAL INSTRUCTIONS:
1. PRESERVE THE EXACT FORMAT: Keep the same HTML structure, tags, classes, and styling as the original template
2. REPLACE VARIABLES: Replace all {{variable_name}} placeholders with corresponding values
3. ARRAY VARIABLES: For array variables, repeat the surrounding HTML structure for each array item
   - If {{array_var}} is inside a <li> tag, repeat the <li> tag for each array item
   - If {{array_var}} is inside a <div> tag, repeat the <div> tag for each array item
   - Maintain the exact same HTML structure around the array variable
4. VALID HTML: Ensure the final HTML is valid and well-formatted
5. NO STRUCTURAL CHANGES: Do not add new HTML elements, change classes, or modify the template structure (except for empty array handling as described below)
6. EMPTY ARRAY VARIABLES: If an array variable has an empty array (no data), you must add text within that section to indicate there is no data, remove the array variables from the HTML structure and keep the rest of the HTML structure intact. For example, for array variable "features_n", if there is no data, all variables "features_1", "features_2", etc. must be removed from the HTML structure as they together indicate the array variable.
7. EXACT REPLACEMENT: Only replace {{}} placeholders, keep everything else identical

RESPONSE FORMAT:
You must return a valid JSON object with exactly these two fields:
{
  "final_html": "final HTML content with variables replaced but structure preserved",
  "final_subject": "final subject with variables replaced"
}

IMPORTANT: Return ONLY the JSON object, no additional text or explanations.`;

      const substitutionResponse = await this.callLLM(llmModel, [
        {
          role: 'user',
          content: substitutionPrompt
        }
      ], {
        temperature: 0.1,
        response_format: { type: 'json_object' },
        max_completion_tokens: 16384
      });

      const substitutionResult = substitutionResponse.choices[0].message.content;
      if (!substitutionResult) {
        throw new Error('LLM did not return substitution result');
      }

      let substitutionData;
      try {
        substitutionData = JSON.parse(substitutionResult);
      } catch (parseError) {
        // Some models (e.g. Gemini) wrap JSON in markdown code blocks — strip and retry
        const codeBlockMatch = substitutionResult.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (codeBlockMatch) {
          try {
            substitutionData = JSON.parse(codeBlockMatch[1].trim());
          } catch (innerParseError) {
            console.error('createHtmlFromTemplate: Failed to parse JSON even after stripping code block wrapper. Raw response (first 500 chars):', substitutionResult.substring(0, 500));
            throw new Error('LLM returned invalid JSON for variable substitution');
          }
        } else {
          console.error('createHtmlFromTemplate: Failed to parse LLM response as JSON. Raw response (first 500 chars):', substitutionResult.substring(0, 500));
          throw new Error('LLM returned invalid JSON for variable substitution');
        }
      }

      if (!substitutionData.final_html || !substitutionData.final_subject) {
        throw new Error('LLM substitution result missing final_html or final_subject fields');
      }

      const finalHtml = substitutionData.final_html;
      const finalSubject = substitutionData.final_subject;

      // Verify the substitution was correct
      const remainingPlaceholders = finalHtml.match(/\{\{[^}]+\}\}/g) || [];
      const remainingSubjectPlaceholders = finalSubject.match(/\{\{[^}]+\}\}/g) || [];

      if (remainingPlaceholders.length > 0 || remainingSubjectPlaceholders.length > 0) {
        console.warn('Warning: Some variables were not substituted:', {
          htmlPlaceholders: remainingPlaceholders,
          subjectPlaceholders: remainingSubjectPlaceholders
        });
      }

      // Verify HTML structure is preserved (basic check)
      const originalTagCount = (template.html_content.match(/<[^>]+>/g) || []).length;
      const finalTagCount = (finalHtml.match(/<[^>]+>/g) || []).length;

      // Allow for some variation due to array repetition, but flag significant changes
      const tagDifference = Math.abs(originalTagCount - finalTagCount);
      if (tagDifference > originalTagCount * 0.5) { // More than 50% change in tag count
        console.warn('Warning: Significant HTML structure change detected:', {
          originalTagCount,
          finalTagCount,
          difference: tagDifference
        });
      }

      // Upload to S3
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const filename = `html_${templateName}.html`;
      const uploadResult = await uploadFileToS3(finalHtml, filename, userId, 'text/html');

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload to S3');
      }

      const s3Url = uploadResult.url;

      return {
        success: true,
        s3_url: s3Url,
        final_subject: finalSubject,
        template_name: templateName,
        filename: filename
      };
    } catch (error) {
      console.error('Error creating email HTML from template:', error);

      // Return specific error messages based on the error type
      if (error instanceof Error) {
        if (error.message.includes('Failed to process template with LLM') || error.message.includes('OpenAI API error')) {
          return {
            success: false,
            message: 'Failed to process template with LLM',
            error: error.message
          };
        } else if (error.message.includes('LLM returned invalid JSON')) {
          return {
            success: false,
            message: 'Failed to parse LLM response',
            error: error.message
          };
        } else if (error.message.includes('missing final_html or final_subject')) {
          return {
            success: false,
            message: 'LLM response missing final_html',
            error: error.message
          };
        } else if (error.message.includes('Failed to upload to S3') || error.message.includes('S3 upload failed')) {
          return {
            success: false,
            message: 'Failed to upload to S3',
            error: error.message
          };
        }
      }

      return {
        success: false,
        message: 'Failed to create email HTML from template',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async createHtmlFile(
    title: string,
    contentDraft: string,
    formatRequirements: string,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      // Use Claude model by default (check for Claude in model name)
      const defaultClaudeModel = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

      // Import LLMService
      const { createLLMService } = await import('../utils/llmService');
      // Use 16K tokens for HTML generation to avoid truncation
      const llmService = createLLMService(defaultClaudeModel, 0.8, 16384);

      // Build system prompt for HTML generation
      const systemPrompt = `You are an expert web developer and HTML designer. Your task is to create a well-formatted, professional HTML document from the provided title and content draft.

Requirements:
- Create a complete, valid HTML5 document with proper DOCTYPE, html, head, and body tags
- Include appropriate meta tags for charset, viewport, and SEO
- Add modern, clean CSS styling (embedded in <style> tag or inline as appropriate)
- Ensure the HTML is responsive and works well on different screen sizes
- Use semantic HTML5 elements where appropriate
- Make the design professional and visually appealing
- Ensure proper typography, spacing, and color scheme
- Include the title in an appropriate heading element
- Format the content draft into well-structured HTML with proper paragraphs, headings, lists, etc. as needed
${formatRequirements ? `\nAdditional Format Requirements:\n${formatRequirements}` : ''}

The HTML should be production-ready and well-formatted.`;

      // Build user prompt
      const userPrompt = `Create a well-formatted HTML document with the following:

Title: ${title}

Content Draft:
${contentDraft}

${formatRequirements ? `\nFormat Requirements:\n${formatRequirements}` : ''}

Please generate a complete, professional HTML document that properly formats and presents this content.`;

      // Generate HTML using LLMService
      console.log('AgentMode: Generating HTML file with LLMService (Claude model)');
      const htmlContent = await llmService.generateHTML(systemPrompt, userPrompt);

      if (!htmlContent || htmlContent.trim().length === 0) {
        throw new Error('LLM did not generate HTML content');
      }

      // Upload to S3
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const filename = `html_${Date.now()}_${title.replace(/[^a-z0-9]/gi, '_').substring(0, 50)}.html`;
      const uploadResult = await uploadFileToS3(htmlContent, filename, userId, 'text/html');

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload HTML file to S3');
      }

      const s3Url = uploadResult.url;
      console.log('AgentMode: HTML file created and uploaded successfully to:', s3Url);

      return {
        success: true,
        s3_url: s3Url,
        filename: filename,
        title: title,
        message: 'HTML file created successfully'
      };
    } catch (error) {
      console.error('Error creating HTML file:', error);
      return {
        success: false,
        message: 'Failed to create HTML file',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Create HTML template from existing HTML file (upload to email templates)
  public async createHtmlTemplate(
    htmlSource: string,
    templateName: string,
    subject: string,
    additionalInstructions: string,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      // Read HTML content from source (either S3 URL or direct HTML content)
      let htmlContent = htmlSource;

      // If htmlSource looks like a URL, fetch it
      if (htmlSource.startsWith('http://') || htmlSource.startsWith('https://')) {
        console.log('AgentMode: Fetching HTML from URL:', htmlSource);
        const response = await fetch(htmlSource);
        if (!response.ok) {
          throw new Error(`Failed to fetch HTML from URL: ${response.statusText}`);
        }
        htmlContent = await response.text();
      }

      // Use Claude model to process/enhance the HTML based on instructions
      const defaultClaudeModel = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

      const { createLLMService } = await import('../utils/llmService');
      // Use 16K tokens for HTML template generation to avoid truncation
      const llmService = createLLMService(defaultClaudeModel, 0.8, 16384);

      // Build system prompt for HTML template creation
      const systemPrompt = `You are an expert web developer and HTML email template designer. Your task is to create or enhance an HTML email template based on the provided HTML content and instructions.

Requirements:
- Create a well-formatted, professional HTML email template
- Ensure the HTML is valid and follows email best practices (inline styles, table-based layouts if needed)
- Make the template reusable by identifying dynamic content that should be replaced with variables
- Use the {{variable_name}} syntax for all dynamic placeholders (e.g., {{user_name}}, {{company_name}})

CRITICAL - Array Variable Pattern for Repeating Sections:
For ANY repeating sections (lists, products, features, items, etc.), you MUST use this EXACT three-part pattern:
  {{property_1_field}} - First item
  {{property_2_field}} - Second item
  {{property_n_field}} - Array pattern

Example for a feature list with title and description:
<div class="feature">
  <h3>{{features_1_title}}</h3>
  <p>{{features_1_description}}</p>
</div>
<div class="feature">
  <h3>{{features_2_title}}</h3>
  <p>{{features_2_description}}</p>
</div>
<div class="feature">
  <h3>{{features_n_title}}</h3>
  <p>{{features_n_description}}</p>
</div>

REQUIRED: You MUST include ALL THREE (_1, _2, _n) for EACH property in repeating sections.
FORBIDDEN: Do NOT use _3, _4, _5, etc. Only _1, _2, and _n are valid.

Other Requirements:
- Ensure the template is responsive and works well across email clients
- Include appropriate styling that works in email contexts (inline CSS preferred)
- Keep the original intent and structure but enhance as needed based on instructions
- Make sure all images use absolute URLs
- Ensure proper HTML structure with appropriate tags

The HTML template should be production-ready, well-formatted, and suitable for use as an email template.`;

      // Build user prompt
      const userPrompt = `Create an email template with the following details:

Template Name: ${templateName}
Subject Line: ${subject}

Base HTML Content:
${htmlContent}

Additional Instructions:
${additionalInstructions || 'None - please process the HTML and identify appropriate variables for dynamic content.'}

Please:
1. Process the HTML content and enhance it for email template usage
2. Identify dynamic content and replace with {{variable_name}} placeholders
3. For repeating sections, use the REQUIRED three-part pattern: {{items_1_property}}, {{items_2_property}}, {{items_n_property}}
   - MUST include all three: _1, _2, and _n
   - Do NOT use _3, _4, _5, etc.
4. Ensure email compatibility (inline styles, proper structure)
5. Keep the subject line and enhance it with variables if needed
6. Return ONLY the final HTML content (no explanations)`;

      // Generate enhanced HTML template using LLMService
      console.log('AgentMode: Generating HTML email template with Claude model');
      const enhancedHtml = await llmService.generateHTML(systemPrompt, userPrompt);

      if (!enhancedHtml || enhancedHtml.trim().length === 0) {
        throw new Error('LLM did not generate HTML content');
      }

      // Extract variables from the enhanced HTML and subject
      const { variables, arrayVariables } = this.extractVariables(enhancedHtml, subject);

      console.log('AgentMode: Extracted variables:', { variables, arrayVariables });

      // Save template to DynamoDB settings
      const { settingsService } = await import('./settingsService');
      const settingName = `email_templates_${userId}`;
      const existingSetting = await settingsService.getSetting(settingName);

      let templates = [];
      if (existingSetting) {
        try {
          templates = JSON.parse(existingSetting.settingValue);
        } catch (error) {
          console.error('Error parsing existing templates:', error);
          templates = [];
        }
      }

      // Check if template already exists
      const existingTemplateIndex = templates.findIndex(
        (t: any) => t.template_name === templateName
      );

      const newTemplate = {
        template_name: templateName,
        subject: subject,
        html_content: enhancedHtml,
        variables: variables,
        arrayVariables: arrayVariables,
        created_at: existingTemplateIndex >= 0 ? templates[existingTemplateIndex].created_at : new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      if (existingTemplateIndex >= 0) {
        templates[existingTemplateIndex] = newTemplate;
      } else {
        templates.push(newTemplate);
      }

      await settingsService.setSetting(
        settingName,
        JSON.stringify(templates),
        'User email templates',
        userId
      );

      console.log('AgentMode: HTML email template created successfully:', templateName);

      return {
        success: true,
        template_name: templateName,
        subject: subject,
        variables: variables,
        arrayVariables: arrayVariables,
        message: `Email template "${templateName}" created successfully with ${variables.length} variables and ${arrayVariables.length} array variables`,
        preview_note: 'Template is now available in Email Templates section for editing and preview'
      };
    } catch (error) {
      console.error('Error creating HTML template:', error);
      return {
        success: false,
        message: 'Failed to create HTML template',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Extract variables from HTML content and subject (same logic as in settings.ts)
  private extractVariables(htmlContent: string, subject?: string): { variables: string[], arrayVariables: string[] } {
    const variableRegex = /\{\{([^}]+)\}\}/g;
    const allVariables: string[] = [];
    const regularVariables: string[] = [];
    const arrayVariableNames = new Set<string>();
    let match;

    // Collect all variables from HTML content
    while ((match = variableRegex.exec(htmlContent)) !== null) {
      const variable = match[1].trim();
      if (!allVariables.includes(variable)) {
        allVariables.push(variable);
      }
    }

    // Also collect variables from subject if provided
    if (subject) {
      const subjectRegex = /\{\{([^}]+)\}\}/g;
      let subjectMatch;
      while ((subjectMatch = subjectRegex.exec(subject)) !== null) {
        const variable = subjectMatch[1].trim();
        if (!allVariables.includes(variable)) {
          allVariables.push(variable);
        }
      }
    }

    // Find all _n and _n_ patterns first
    const nPatterns = new Set<string>();
    allVariables.forEach(variable => {
      const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
      if (nMatch) {
        const baseName = nMatch[1];
        const suffix = nMatch[2];
        if (suffix) {
          nPatterns.add(`${baseName}_n_${suffix}`);
        } else {
          nPatterns.add(`${baseName}_n`);
        }
      }
    });

    // Now process all variables
    const processedArrayNames = new Set<string>();

    allVariables.forEach(variable => {
      let isArrayVariable = false;

      // Check if this variable matches any _n pattern
      nPatterns.forEach(nPattern => {
        const baseName = nPattern.replace(/_n.*$/, '');
        const numericMatch = variable.match(new RegExp(`^${baseName}_(\\d+)(?:_|$)`));
        if (numericMatch) {
          if (!processedArrayNames.has(nPattern)) {
            arrayVariableNames.add(nPattern);
            processedArrayNames.add(nPattern);
          }
          isArrayVariable = true;
        }
      });

      // Check if this is already an _n pattern
      const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
      if (nMatch) {
        const baseName = nMatch[1];
        const suffix = nMatch[2];
        const fullName = suffix ? `${baseName}_n_${suffix}` : `${baseName}_n`;
        if (!processedArrayNames.has(fullName)) {
          arrayVariableNames.add(fullName);
          processedArrayNames.add(fullName);
        }
        isArrayVariable = true;
      }

      if (!isArrayVariable) {
        regularVariables.push(variable);
      }
    });

    return { variables: regularVariables, arrayVariables: Array.from(arrayVariableNames) };
  }

  // Work Plan Management Methods

  public async createWorkPlan(title: string, steps: Array<{ stepCount: number; title: string; description?: string; requiredFunctionCalls?: string[] }>, sessionId: string): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return {
          success: false,
          message: 'Session not found'
        };
      }

      // Create the work plan with all steps in pending status
      // Ensure stepCount is sequential starting from 1
      const workPlan = {
        title,
        steps: steps.map((step, index) => ({
          stepCount: index + 1, // Must be sequential: index+1
          title: step.title,
          description: step.description,
          status: 'pending' as const,
          completedAt: undefined,
          notes: undefined,
          requiredFunctionCalls: step.requiredFunctionCalls
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Update the session with the work plan
      await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

      return {
        success: true,
        message: `Work plan "${title}" created with ${steps.length} steps`,
        workPlan,
        formattedContent: `Created work plan "${title}" with ${steps.length} steps:\n${workPlan.steps.map(s => `${s.stepCount}. ${s.title}`).join('\n')}`
      };
    } catch (error) {
      console.error('AgentMode: Error creating work plan:', error);
      return {
        success: false,
        message: 'Failed to create work plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async modifyWorkPlan(steps: Array<{ stepCount: number; title: string; description?: string; requiredFunctionCalls?: string[] }>, removeStepCounts: number[], sessionId: string): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || !session.workPlan) {
        return {
          success: false,
          message: 'No work plan found in this session. Create one first using create_work_plan.'
        };
      }

      const workPlan = { ...session.workPlan };

      // Remove steps if specified
      if (removeStepCounts && removeStepCounts.length > 0) {
        workPlan.steps = workPlan.steps.filter(s => !removeStepCounts.includes(s.stepCount));
      }

      // Update or add steps
      for (const newStep of steps) {
        const existingIndex = workPlan.steps.findIndex(s => s.stepCount === newStep.stepCount);
        if (existingIndex >= 0) {
          // Update existing step (preserve status and completion info)
          workPlan.steps[existingIndex] = {
            ...workPlan.steps[existingIndex],
            title: newStep.title,
            description: newStep.description,
            requiredFunctionCalls: newStep.requiredFunctionCalls !== undefined ? newStep.requiredFunctionCalls : workPlan.steps[existingIndex].requiredFunctionCalls
          };
        } else {
          // Add new step (stepCount will be fixed by updateSessionWorkPlan)
          workPlan.steps.push({
            stepCount: newStep.stepCount,
            title: newStep.title,
            description: newStep.description,
            status: 'pending',
            completedAt: undefined,
            notes: undefined,
            requiredFunctionCalls: newStep.requiredFunctionCalls
          });
        }
      }

      // Sort steps by stepCount before saving
      workPlan.steps.sort((a, b) => a.stepCount - b.stepCount);
      workPlan.updatedAt = new Date().toISOString();

      // Update the session (will throw error if stepCount is not sequential)
      await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

      return {
        success: true,
        message: `Work plan modified successfully`,
        workPlan,
        formattedContent: `Modified work plan. Current steps:\n${workPlan.steps.map((s, i) => `${i + 1}. ${s.title} (${s.status})`).join('\n')}`
      };
    } catch (error) {
      console.error('AgentMode: Error modifying work plan:', error);
      return {
        success: false,
        message: 'Failed to modify work plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async setWorkPlanStatus(
    updates: Array<{ stepCount: number; status: 'pending' | 'completed' | 'skipped'; notes?: string }>,
    sessionId: string
  ): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || !session.workPlan) {
        return {
          success: false,
          message: 'No work plan found in this session. Create one first using create_work_plan.'
        };
      }

      const workPlan = { ...session.workPlan };
      const updatedSteps: Array<{ stepCount: number; title: string; status: string }> = [];
      const notFoundSteps: number[] = [];
      const missingFunctionCalls: Array<{ stepCount: number; title: string; missing: string[] }> = [];

      // Get function call counts from session (make a copy to modify)
      const calledFunctionCounts = { ...(session.calledFunctions || {}) };
      let countsModified = false;

      // Process each update
      for (const update of updates) {
        const stepIndex = workPlan.steps.findIndex(s => s.stepCount === update.stepCount);

        if (stepIndex < 0) {
          notFoundSteps.push(update.stepCount);
          continue;
        }

        const step = workPlan.steps[stepIndex];

        // Validate required function calls if marking as completed
        if (update.status === 'completed' && step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0) {
          // Count how many times each function is required
          const requiredCounts: Record<string, number> = {};
          for (const fn of step.requiredFunctionCalls) {
            requiredCounts[fn] = (requiredCounts[fn] || 0) + 1;
          }

          // Check if we have enough calls for each required function
          const missing: string[] = [];
          for (const [fn, requiredCount] of Object.entries(requiredCounts)) {
            const availableCount = calledFunctionCounts[fn] || 0;
            if (availableCount < requiredCount) {
              missing.push(`${fn} (need ${requiredCount}, have ${availableCount})`);
            }
          }

          if (missing.length > 0) {
            missingFunctionCalls.push({
              stepCount: update.stepCount,
              title: step.title,
              missing
            });
            continue; // Skip updating this step
          }

          // If validation passed and marking as completed, decrement the function counts
          for (const fn of step.requiredFunctionCalls) {
            calledFunctionCounts[fn] = (calledFunctionCounts[fn] || 0) - 1;
            countsModified = true;
          }
        }

        // Update the step status
        workPlan.steps[stepIndex] = {
          ...workPlan.steps[stepIndex],
          status: update.status,
          notes: update.notes,
          completedAt: update.status === 'completed' ? new Date().toISOString() : workPlan.steps[stepIndex].completedAt
        };

        updatedSteps.push({
          stepCount: update.stepCount,
          title: workPlan.steps[stepIndex].title,
          status: update.status
        });
      }

      // Check if there are missing function calls - this is a critical error
      if (missingFunctionCalls.length > 0) {
        const errorDetails = missingFunctionCalls.map(mfc =>
          `Step ${mfc.stepCount} "${mfc.title}": missing required function calls: ${mfc.missing.join(', ')}`
        ).join('\n');

        return {
          success: false,
          message: 'Cannot mark steps as completed. Required function calls have not been made yet.',
          missingFunctionCalls,
          formattedContent: `❌ Cannot complete these steps yet:\n${errorDetails}\n\nPlease make the required function calls first, then mark the steps as completed.`
        };
      }

      // Check if any steps were not found
      if (notFoundSteps.length > 0 && updatedSteps.length === 0) {
        return {
          success: false,
          message: `Steps not found: ${notFoundSteps.join(', ')}`
        };
      }

      // Only update if there are changes
      if (updatedSteps.length > 0) {
        workPlan.updatedAt = new Date().toISOString();
        // Update the session (will throw error if stepCount is not sequential)
        await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

        // Update function counts if they were modified
        if (countsModified) {
          await chatbotDb.updateCalledFunctions(sessionId, calledFunctionCounts);
        }
      }

      const message = updatedSteps.length === 1
        ? `Step ${updatedSteps[0].stepCount} status updated to ${updatedSteps[0].status}`
        : `Updated ${updatedSteps.length} step${updatedSteps.length > 1 ? 's' : ''}`;

      const formattedContent = updatedSteps.map(s =>
        `Updated step ${s.stepCount} "${s.title}" to ${s.status}`
      ).join('\n');

      return {
        success: updatedSteps.length > 0,
        message: notFoundSteps.length > 0
          ? `${message}. Steps not found: ${notFoundSteps.join(', ')}`
          : message,
        updatedSteps,
        notFoundSteps: notFoundSteps.length > 0 ? notFoundSteps : undefined,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error setting work plan status:', error);
      return {
        success: false,
        message: 'Failed to update work plan status',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async listBooks(userId: string, type?: string, status?: string): Promise<any> {
    try {
      console.log('AgentMode: Listing books for user:', userId);

      const { bookDb } = await import('./bookDb');

      const filters: {
        type?: "book" | "whitepaper";
        status?: "draft" | "published" | "archived";
      } = {};

      if (type === "book" || type === "whitepaper") {
        filters.type = type;
      }

      if (status === "draft" || status === "published" || status === "archived") {
        filters.status = status;
      }

      const books = await bookDb.getBooksByUser(userId, filters);

      if (!books || books.length === 0) {
        return {
          success: true,
          message: 'No books found',
          books: [],
          totalBooks: 0
        };
      }

      // Format books for Agent Mode
      const formattedBooks = books.map((book: any) => ({
        book_id: book.bookId,
        title: book.title,
        description: book.description,
        type: book.type,
        author: book.author,
        status: book.status,
        published_at: book.publishedAt,
        created_at: book.createdAt,
        updated_at: book.updatedAt,
        tags: book.tags || [],
        has_sections: !!(book.sections && book.sections.length > 0)
      }));

      return {
        success: true,
        message: `Found ${formattedBooks.length} book(s)`,
        books: formattedBooks,
        totalBooks: formattedBooks.length
      };
    } catch (error) {
      console.error('Error listing books:', error);
      return {
        success: false,
        message: 'Failed to list books',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async getBookDetails(bookId: string, userId: string): Promise<any> {
    try {
      console.log('AgentMode: Getting book details for:', bookId);

      const { bookDb } = await import('./bookDb');
      const { bookContentDb } = await import('./bookContentDb');

      const book = await bookDb.getBookById(bookId, userId);

      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Load all contents for this book
      const contents = await bookContentDb.getAllBookContents(bookId, userId);

      // Attach contents to sections and chapters
      if (book.sections) {
        for (const section of book.sections) {
          const sectionContent = contents.find(
            (c) => c.sectionId === section.sectionId && !c.chapterId
          );
          if (sectionContent) {
            section.content = sectionContent.content;
          }

          for (const chapter of section.chapters) {
            const chapterContent = contents.find(
              (c) => c.sectionId === section.sectionId && c.chapterId === chapter.chapterId
            );
            if (chapterContent) {
              chapter.content = chapterContent.content;
            }
          }
        }
      }

      // Format book details for Agent Mode
      const formattedBook = {
        book_id: book.bookId,
        title: book.title,
        description: book.description,
        type: book.type,
        author: book.author,
        language: book.language,
        genre: book.genre,
        status: book.status,
        published_at: book.publishedAt,
        created_at: book.createdAt,
        updated_at: book.updatedAt,
        tags: book.tags || [],
        cover_image_url: book.coverImageUrl,
        characters: book.characters || [],
        outline: book.sections ? book.sections.map((section: any) => ({
          section_id: section.sectionId,
          title: section.title,
          description: section.description,
          order: section.order,
          has_content: !!section.content,
          chapters: section.chapters.map((chapter: any) => ({
            chapter_id: chapter.chapterId,
            title: chapter.title,
            description: chapter.description,
            order: chapter.order,
            has_content: !!chapter.content
          }))
        })) : []
      };

      return {
        success: true,
        message: 'Book details retrieved successfully',
        book: formattedBook
      };
    } catch (error) {
      console.error('Error getting book details:', error);
      return {
        success: false,
        message: 'Failed to get book details',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async getBookContent(
    bookId: string,
    sectionId: string,
    chapterId: string | undefined,
    userId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Getting book content for:', { bookId, sectionId, chapterId });

      const { bookDb } = await import('./bookDb');
      const { bookContentDb } = await import('./bookContentDb');

      // Verify book exists and belongs to user
      const book = await bookDb.getBookById(bookId, userId);
      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Verify section exists
      const section = book.sections?.find((s) => s.sectionId === sectionId);
      if (!section) {
        return {
          success: false,
          message: 'Section not found',
          error: 'Section not found in this book'
        };
      }

      // If chapterId provided, verify chapter exists
      if (chapterId) {
        const chapter = section.chapters.find((c) => c.chapterId === chapterId);
        if (!chapter) {
          return {
            success: false,
            message: 'Chapter not found',
            error: 'Chapter not found in this section'
          };
        }
      }

      // Get content from bookContentDb
      const content = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);

      if (!content) {
        const emptyContentHash = createHash('sha256').update('').digest('hex');
        return {
          success: true,
          message: chapterId ? 'Chapter content not found' : 'Section content not found',
          content: '',
          content_hash: emptyContentHash,
          content_type: chapterId ? 'chapter' : 'section',
          section_id: sectionId,
          chapter_id: chapterId || null,
          has_content: false
        };
      }

      // Compute content hash for full replacement verification
      const contentHash = createHash('sha256').update(content.content).digest('hex');

      return {
        success: true,
        message: chapterId ? 'Chapter content retrieved successfully' : 'Section content retrieved successfully',
        content: content.content,
        content_hash: contentHash,
        content_type: chapterId ? 'chapter' : 'section',
        section_id: sectionId,
        chapter_id: chapterId || null,
        updated_at: content.updatedAt,
        has_content: true
      };
    } catch (error) {
      console.error('Error getting book content:', error);
      return {
        success: false,
        message: 'Failed to get book content',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async updateBookContent(
    bookId: string,
    sectionId: string,
    chapterId: string | undefined,
    replacementInstructions: any[],
    userId: string
  ): Promise<any> {
    try {
      // Validate that replacementInstructions is an array
      if (!Array.isArray(replacementInstructions)) {
        return {
          success: false,
          message: 'replacement_json must be an array of replacement instructions'
        };
      }

      if (replacementInstructions.length === 0) {
        return {
          success: false,
          message: 'At least one replacement instruction is required'
        };
      }

      // Validate each replacement instruction (always partial replacement)
      for (let i = 0; i < replacementInstructions.length; i++) {
        const instruction = replacementInstructions[i];

        if (instruction.new_content === undefined || instruction.expected_count === undefined) {
          return {
            success: false,
            message: `Missing required fields in replacement instruction ${i + 1}: new_content and expected_count are required`
          };
        }

        // For partial replacement, require old_content
        if (!instruction.old_content) {
          return {
            success: false,
            message: `Replacement instruction ${i + 1} missing old_content. old_content is required for partial replacements`
          };
        }
      }

      // Get current content
      const { bookDb } = await import('./bookDb');
      const { bookContentDb } = await import('./bookContentDb');

      // Verify book exists and belongs to user
      const book = await bookDb.getBookById(bookId, userId);
      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Verify section exists
      const section = book.sections?.find((s) => s.sectionId === sectionId);
      if (!section) {
        return {
          success: false,
          message: 'Section not found',
          error: 'Section not found in this book'
        };
      }

      // If chapterId provided, verify chapter exists
      if (chapterId) {
        const chapter = section.chapters.find((c) => c.chapterId === chapterId);
        if (!chapter) {
          return {
            success: false,
            message: 'Chapter not found',
            error: 'Chapter not found in this section'
          };
        }
      }

      // Get current content
      const currentContentRecord = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);
      const currentContent = currentContentRecord?.content || '';

      console.log(`AgentMode: Current content length: ${currentContent.length} characters`);

      // Compute hash of current content for verification
      const currentContentHash = createHash('sha256').update(currentContent).digest('hex');
      console.log(`AgentMode: Computed current content hash: ${currentContentHash}`);

      // Use common replacement function (always "part" for partial replacements)
      const replacementResult = this.performContentReplacements(
        currentContent,
        currentContentHash,
        'part',
        replacementInstructions
      );

      if (!replacementResult.success) {
        return {
          success: false,
          message: replacementResult.error?.message || 'Failed to perform replacements',
          suggestion: replacementResult.error?.suggestion
        };
      }

      // Save the updated content
      await bookContentDb.createOrUpdateContent(bookId, userId, {
        sectionId: sectionId,
        chapterId: chapterId,
        content: replacementResult.updatedContent!
      });

      return {
        success: true,
        message: `Content updated successfully with ${replacementResult.replacementResults!.length} replacement(s)`,
        content_type: chapterId ? 'chapter' : 'section',
        section_id: sectionId,
        chapter_id: chapterId || null,
        replacements: replacementResult.replacementResults,
        updated_content_length: replacementResult.updatedContent!.length
      };

    } catch (error) {
      console.error('Error updating book content:', error);
      return {
        success: false,
        message: 'Failed to update book content',
        error: error instanceof Error ? error.message : 'Unknown error',
        suggestion: 'Use get_book_content to retrieve the current content, then provide the exact old_content to replace. For generating full content, use generate_book_content instead.'
      };
    }
  }

  public async generateBookContent(
    bookId: string,
    sectionId: string,
    chapterId: string | undefined,
    contentDescription: string,
    length: string,
    imagine: boolean,
    userId: string,
    researchUrl?: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Generating book content for:', { bookId, sectionId, chapterId, length, imagine, userId, researchUrl: researchUrl ? 'provided' : 'not provided' });

      const { bookDb } = await import('./bookDb');
      const { bookContentDb } = await import('./bookContentDb');

      // Fetch research content from S3 URL if provided
      let researchContent = '';
      if (researchUrl) {
        try {
          console.log('AgentMode: Fetching research content from S3:', researchUrl);
          const response = await fetch(researchUrl);
          if (response.ok) {
            researchContent = await response.text();
            console.log(`AgentMode: Fetched ${researchContent.length} characters of research content`);
          } else {
            console.warn('AgentMode: Failed to fetch research content from S3:', response.status);
          }
        } catch (fetchError) {
          console.error('AgentMode: Error fetching research content:', fetchError);
        }
      }

      // Verify book exists and belongs to user
      const book = await bookDb.getBookById(bookId, userId);
      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Verify section exists
      const section = book.sections?.find((s) => s.sectionId === sectionId);
      if (!section) {
        return {
          success: false,
          message: 'Section not found',
          error: 'Section not found in this book'
        };
      }

      // If chapterId provided, verify chapter exists
      if (chapterId) {
        const chapter = section.chapters.find((c) => c.chapterId === chapterId);
        if (!chapter) {
          return {
            success: false,
            message: 'Chapter not found',
            error: 'Chapter not found in this section'
          };
        }
      }

      // Get existing content if it exists
      const existingContent = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);
      const existingContentText = existingContent?.content || '';

      // Check if imagine setting exists in content record and overwrite the parameter only when it's false
      // (since the default is true, we only need to override when explicitly set to false)
      let finalImagine = imagine;
      let imagineOverridden = false;
      if (existingContent?.imagine === false) {
        finalImagine = false;
        imagineOverridden = true;
      }

      // Map length to word count range - different ranges for books vs whitepapers
      // Whitepapers need smaller word counts to produce concise 8-12 page documents
      const bookWordCounts: Record<string, { min: number; max: number; target: number }> = {
        short: { min: 1000, max: 2000, target: 1500 },
        medium: { min: 2000, max: 3000, target: 2500 },
        long: { min: 3000, max: 4000, target: 3500 }
      };

      const whitepaperWordCounts: Record<string, { min: number; max: number; target: number }> = {
        short: { min: 300, max: 600, target: 450 },   // ~1 page (Executive Summary, Conclusion)
        medium: { min: 600, max: 1000, target: 800 }, // ~2 pages (Introduction, Key Findings)
        long: { min: 1000, max: 1500, target: 1250 }  // ~3 pages (Analysis sections)
      };

      const wordCountRanges = book.type === 'whitepaper' ? whitepaperWordCounts : bookWordCounts;
      const wordCount = wordCountRanges[length] || wordCountRanges.medium;

      // Get section/chapter title for context
      const sectionTitle = section.title;
      const chapterTitle = chapterId ? section.chapters.find((c) => c.chapterId === chapterId)?.title : undefined;
      const contentTitle = chapterTitle || sectionTitle;

      // Build the prompt for content generation
      let contentPrompt = `You are an expert content writer creating ${length} content for a ${book.type === 'book' ? 'book' : 'white paper'} chapter or section.

Book Context:
- Title: ${book.title}
- Author: ${book.author}
- Type: ${book.type}
${book.description ? `- Description: ${book.description}` : ''}
${book.language ? `- Language: ${book.language}` : ''}
${book.type === 'book' && book.genre ? `- Genre: ${book.genre}` : ''}
${book.type === 'book' && book.characters && book.characters.length > 0 ? `
- Characters:
${book.characters.map((char, idx) => `  ${idx + 1}. ${char.name}: ${char.description}`).join('\n')}

IMPORTANT: Not all characters need to be mentioned in every chapter. Only include characters that are relevant to this specific ${chapterId ? 'chapter' : 'section'}. Use characters naturally when they fit the narrative or content, but do not force their inclusion if they are not relevant to this particular ${chapterId ? 'chapter' : 'section'}.` : ''}

Content Context:
- ${chapterId ? 'Chapter' : 'Section'} Title: ${contentTitle}
${section.description ? `- Section Description: ${section.description}` : ''}
${chapterId && section.chapters.find((c) => c.chapterId === chapterId)?.description ? `- Chapter Description: ${section.chapters.find((c) => c.chapterId === chapterId)?.description}` : ''}

Content Requirements:
- Content Description: ${contentDescription}
- Target Length: ${wordCount.min}-${wordCount.max} words (aim for approximately ${wordCount.target} words)
- Format: Markdown with proper headings (H2, H3), paragraphs, lists, and formatting
- Style: Professional, engaging, and well-structured
${book.language === '中文' ? '- Language: Write in Chinese (中文)' : '- Language: Write in English'}
${book.type === 'book' && book.genre ? `- Genre: Write in the style appropriate for ${book.genre} genre` : ''}
${!finalImagine ? `
CRITICAL: Do NOT invent or imagine details that do not exist. Stick strictly to facts, information provided in the content description, and details that are explicitly mentioned in the book context (title, description, characters, etc.). Do not add creative embellishments, fictional scenarios, or details that are not directly supported by the provided information. Focus on factual, accurate content based only on what is explicitly provided.` : ''}

${existingContentText ? `Existing Content (use as base and enhance/expand based on content description):
${existingContentText}

Instructions: Use the existing content above as a foundation, and enhance or expand it based on the content description. Maintain consistency with the existing style and structure while incorporating the new requirements.` : 'Instructions: Create comprehensive, well-structured content from scratch based on the content description.'}${researchContent ? `

=== DEEP RESEARCH CONTENT (SOURCE MATERIAL) ===
The following is comprehensive research content. Use this as your primary source material for creating this section.
Extract the relevant information for the "${contentTitle}" section and reformat it appropriately.

${researchContent}

=== END OF RESEARCH CONTENT ===
` : ''}${book.type === 'whitepaper' ? `

IMPORTANT WHITEPAPER GUIDELINES:
- This is a whitepaper, not a novel. Be concise and professional.
${researchContent ? '- You have been provided with DEEP RESEARCH CONTENT above. Your job is to EXTRACT and REFORMAT the relevant portions for this specific section.' : '- The content_description likely contains deep research content - your job is to REFORMAT and CONDENSE it for this section, not to generate entirely new content.'}
- Focus on key insights, actionable information, and data-driven conclusions.
- Use bullet points, tables, and clear headings for improved readability and scannability.
- Target exactly ${wordCount.target} words - do NOT exceed ${wordCount.max} words under any circumstances.
- Remove verbose language and filler content. Every sentence should add value.

ANTI-REPETITION RULES (CRITICAL):
- Do NOT repeat concepts, frameworks, or key points that belong in other sections of the whitepaper.
- Governance/trust topics should ONLY appear in their dedicated section, not repeated in Analysis or Conclusion.
- If a concept was covered in an earlier section, briefly reference it (e.g., "As noted in the Executive Summary...") instead of re-explaining.
- Each section should contain UNIQUE insights - check what section you're writing and stay focused on its specific purpose.

CITATION FORMATTING (REQUIRED):
- Use numbered references in brackets: [1], [2], [3], etc.
- When citing statistics, research findings, or expert opinions, always include the source.
- Format example: "AI adoption will reach 80% by 2026 [1]" or "According to Gartner research [2]..."
- If writing the Conclusion/References section, include a numbered reference list at the end.
- Prefer specific, verifiable sources over vague attributions like "studies show" or "experts say".` : ''}`;

      // Get content model from settings
      let contentModel: string | undefined;
      try {
        const setting = await settingsService.getSetting('agent_mode_content_model');
        if (setting && setting.settingValue) {
          contentModel = setting.settingValue;
        }
      } catch (error) {
        console.error('Error getting content model setting:', error);
      }

      // Generate content using LangChain LLM service
      const { createLLMService } = await import('../utils/llmService');
      const modelName = contentModel || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';

      // Use XML format for Chinese content (more forgiving with quotes)
      const useXMLFormat = book.language === '中文';
      const format = useXMLFormat ? 'xml' : 'json';
      console.log(`[generateBookContent] Using model: ${modelName}, output format: ${format.toUpperCase()}, language: ${book.language}`);

      const llmService = createLLMService(modelName, 0.8, 4000);

      const systemPrompt = `You are a seasoned content writer specializing in ${book.type === 'book' ? 'books' : 'white papers'}. Write naturally, avoid AI patterns, and focus on providing comprehensive, well-structured content. ${book.language === '中文' ? 'Write in Chinese (中文).' : 'Write in English.'}

${useXMLFormat ? `CRITICAL: You MUST respond ONLY in XML format. Do NOT use JSON format.

Format your response as XML with this structure:
<response>
  <content>Full content in markdown format. Do not include a title in the content (the title is already provided above). Start directly with the main content.</content>
</response>

IMPORTANT: 
- Use XML format ONLY - do not use JSON
- XML handles quotes and special characters naturally - you do NOT need to escape quotes
- The content can contain any Chinese characters, quotes, or special characters without escaping
- Return ONLY the XML structure above, nothing else` : `Format your response as JSON with this structure:
{{
  "content": "Full content in markdown format. Do not include a title in the content (the title is already provided above). Start directly with the main content."
}}

IMPORTANT: Always respond with valid JSON. Escape quotes in the content properly.`}`;

      // Generate content using LangChain with appropriate format
      const contentData = await llmService.generateJSONContent<{ content: string }>(systemPrompt, contentPrompt, format);

      // Extract content from JSON
      if (!contentData.content) {
        throw new Error('JSON response missing "content" field');
      }
      let finalContent = contentData.content;
      finalContent = finalContent.trim();
      // Remove markdown code blocks if present
      finalContent = finalContent.replace(/^```markdown\s*|\s*```$/g, '').trim();
      finalContent = finalContent.replace(/^```\s*|\s*```$/g, '').trim();

      // Save the generated content
      await bookContentDb.createOrUpdateContent(
        bookId,
        userId,
        {
          sectionId,
          chapterId,
          content: finalContent
        }
      );

      // Count words (approximate)
      const wordCountActual = finalContent.split(/\s+/).filter((word: string) => word.length > 0).length;

      let message = `${chapterId ? 'Chapter' : 'Section'} content generated successfully`;
      if (imagineOverridden) {
        message += ` (imagine setting from ${chapterId ? 'chapter' : 'section'} record: ${finalImagine ? 'enabled' : 'disabled'})`;
      }

      return {
        success: true,
        message,
        content_type: chapterId ? 'chapter' : 'section',
        section_id: sectionId,
        chapter_id: chapterId || null,
        content_length: finalContent.length,
        word_count: wordCountActual,
        target_word_range: `${wordCount.min}-${wordCount.max}`,
        content_preview: finalContent.substring(0, 200) + (finalContent.length > 200 ? '...' : '')
      };

    } catch (error) {
      console.error('Error generating book content:', error);
      return {
        success: false,
        message: 'Failed to generate book content',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async createBook(
    title: string,
    description: string,
    type: string,
    author: string,
    language: string,
    genre: string | undefined,
    tags: string[],
    userId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Creating book for user:', userId);

      // Validate required parameters
      if (!title || !title.trim()) {
        return {
          success: false,
          message: 'Title is required',
          error: 'Title cannot be empty'
        };
      }

      if (!description || !description.trim()) {
        return {
          success: false,
          message: 'Description is required',
          error: 'Description cannot be empty'
        };
      }

      if (!type || (type !== 'book' && type !== 'whitepaper')) {
        return {
          success: false,
          message: 'Type must be "book" or "whitepaper"',
          error: 'Invalid type specified'
        };
      }

      if (!author || !author.trim()) {
        return {
          success: false,
          message: 'Author is required',
          error: 'Author cannot be empty'
        };
      }

      const { bookDb } = await import('./bookDb');

      // Set genre only for books, default to "Other" if not provided
      const bookGenre = type === 'book' ? (genre?.trim() || 'Other') : undefined;

      const bookData = {
        userId,
        title: title.trim(),
        description: description.trim(),
        content: '', // Empty content initially
        type: type as 'book' | 'whitepaper',
        author: author.trim(),
        language: language || 'English',
        genre: bookGenre,
        tags: tags && Array.isArray(tags) ? tags : [],
        status: 'draft' as const,
        sections: []
      };

      const book = await bookDb.createBook(bookData);

      return {
        success: true,
        message: 'Book created successfully',
        book: {
          book_id: book.bookId,
          title: book.title,
          description: book.description,
          type: book.type,
          author: book.author,
          language: book.language,
          genre: book.genre,
          tags: book.tags || [],
          status: book.status,
          sections: book.sections || []
        }
      };
    } catch (error) {
      console.error('Error creating book:', error);
      return {
        success: false,
        message: 'Failed to create book',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async createBookOutline(
    bookId: string,
    outlineJson: string,
    userId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Creating book outline for:', bookId);

      // Validate book exists and belongs to user
      const { bookDb } = await import('./bookDb');
      const book = await bookDb.getBookById(bookId, userId);

      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Parse outline JSON
      let outline: any[];
      try {
        outline = JSON.parse(outlineJson);
      } catch (error) {
        return {
          success: false,
          message: 'Invalid JSON in outline_json',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

      // Validate outline structure
      if (!Array.isArray(outline)) {
        return {
          success: false,
          message: 'Outline must be an array of sections',
          error: 'Invalid outline structure'
        };
      }

      // Build sections array with proper structure
      const sections = outline.map((section: any, sectionIndex: number) => {
        // Validate section has title
        if (!section.title || !section.title.trim()) {
          throw new Error(`Section at index ${sectionIndex} is missing required field: title`);
        }

        const sectionId = uuidv4();
        const sectionOrder = section.order !== undefined ? section.order : sectionIndex + 1;

        // Process chapters if provided
        const chapters = (section.chapters || []).map((chapter: any, chapterIndex: number) => {
          // Validate chapter has title
          if (!chapter.title || !chapter.title.trim()) {
            throw new Error(`Chapter at index ${chapterIndex} in section "${section.title}" is missing required field: title`);
          }

          return {
            chapterId: uuidv4(),
            title: chapter.title.trim(),
            description: chapter.description?.trim() || '',
            order: chapter.order !== undefined ? chapter.order : chapterIndex + 1
          };
        });

        return {
          sectionId,
          title: section.title.trim(),
          description: section.description?.trim() || '',
          order: sectionOrder,
          chapters
        };
      });

      // Update book with new outline
      const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

      if (!updatedBook) {
        return {
          success: false,
          message: 'Failed to update book outline',
          error: 'Book update failed'
        };
      }

      const totalChapters = sections.reduce((sum, section) => sum + section.chapters.length, 0);

      return {
        success: true,
        message: `Outline created successfully with ${sections.length} section(s) and ${totalChapters} chapter(s)`,
        book_id: bookId,
        sections_count: sections.length,
        total_chapters: totalChapters
      };
    } catch (error) {
      console.error('Error creating book outline:', error);
      return {
        success: false,
        message: 'Failed to create book outline',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  public async addCharacters(
    bookId: string,
    charactersJson: string,
    userId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Adding characters to book:', bookId);

      // Validate book exists and belongs to user
      const { bookDb } = await import('./bookDb');
      const book = await bookDb.getBookById(bookId, userId);

      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Parse characters JSON
      let newCharacters: any[];
      try {
        newCharacters = JSON.parse(charactersJson);
      } catch (error) {
        return {
          success: false,
          message: 'Invalid JSON in characters_json',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

      // Validate characters structure
      if (!Array.isArray(newCharacters)) {
        return {
          success: false,
          message: 'Characters must be an array',
          error: 'Invalid characters structure'
        };
      }

      // Validate each character has name and description
      for (let i = 0; i < newCharacters.length; i++) {
        const char = newCharacters[i];
        if (!char.name || !char.name.trim()) {
          return {
            success: false,
            message: `Character at index ${i} is missing required field: name`,
            error: 'Invalid character structure'
          };
        }
        if (!char.description || !char.description.trim()) {
          return {
            success: false,
            message: `Character at index ${i} is missing required field: description`,
            error: 'Invalid character structure'
          };
        }
      }

      // Get existing characters or initialize empty array
      const existingCharacters = book.characters || [];

      // Add new characters to existing list
      const updatedCharacters = [
        ...existingCharacters,
        ...newCharacters.map((char: any) => ({
          name: char.name.trim(),
          description: char.description.trim()
        }))
      ];

      // Update book with new characters
      const updatedBook = await bookDb.updateBook(bookId, userId, { characters: updatedCharacters });

      if (!updatedBook) {
        return {
          success: false,
          message: 'Failed to update book characters',
          error: 'Book update failed'
        };
      }

      return {
        success: true,
        message: `Added ${newCharacters.length} character(s) to book`,
        book_id: bookId,
        characters_added: newCharacters.length,
        total_characters: updatedCharacters.length,
        characters: updatedCharacters
      };
    } catch (error) {
      console.error('Error adding characters:', error);
      return {
        success: false,
        message: 'Failed to add characters',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // List connected accounts helper
   async listConnectedAccounts(userId: string, platform: string = 'all'): Promise<any> {
    try {
      const { getAccountsByUserId, isTokenValid } = await import('./connectedAccountsDb');

      let accounts = await getAccountsByUserId(userId);

      if (platform && platform !== 'all') {
        accounts = accounts.filter(acc => acc.platform === platform);
      }

      return {
        success: true,
        message: `Found ${accounts.length} connected account(s)`,
        accounts: await Promise.all(accounts.map(async acc => ({
          id: acc.account_id,
          platform: acc.platform,
          account_name: acc.account_name,
          account_type: acc.config.account_type,
          is_active: await isTokenValid(acc)
        })))
      };
    } catch (error) {
      console.error('AgentMode: Error listing connected accounts:', error);
      return {
        success: false,
        message: 'Failed to list connected accounts',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Post on connected account helper
  async postOnConnectedAccount(userId: string, accountId: string, content: string, mediaUrls: string[] = []): Promise<any> {
    console.log('[AgentMode] postOnConnectedAccount called:', {
      userId,
      accountId,
      contentLength: content?.length || 0,
      mediaUrlCount: mediaUrls?.length || 0
    });

    try {
      const { getAccountById, isTokenValid } = await import('./connectedAccountsDb');
      const { socialPlatformService } = await import('./socialPlatformService');

      try {
        console.log('[AgentMode] Looking up account:', accountId);
        const account = await getAccountById(accountId, userId);
        console.log('[AgentMode] Account lookup result:', account ? { 
          found: true, 
          platform: account.platform, 
          accountType: account.config?.account_type,
          accountName: account.account_name
        } : { found: false });

        if (!account) {
          console.log('[AgentMode] Account not found, returning error');
          return {
            success: false,
            message: 'Account not found or access denied'
          };
        }

        // NOTE: Skipping isTokenValid check here because the adapter's getValidToken()
        // method will automatically refresh expired tokens. The adapter handles token
        // refresh internally before making API calls.
        console.log('[AgentMode] Getting adapter for platform:', account.platform);
        const adapter = socialPlatformService.getAdapter(account.platform);
        console.log('[AgentMode] Calling adapter.createPost (adapter will handle token refresh if needed)...');
        const result = await adapter.createPost(account, content, mediaUrls, userId);

        return {
          success: true,
          message: result.message,
          post_id: result.postId,
          post_url: result.postUrl
        };
      } catch (error: any) {
        // Handle specific error messages
        let message = error.message;
        if (message.includes('access token expired')) {
          message = 'Account token expired. Please reconnect the account in Settings.';
        }
        
        return {
          success: false,
          message: `Failed to post: ${message}`
        };
      }

    } catch (error) {
      console.error('AgentMode: Error posting on account:', error);
      return {
        success: false,
        message: 'Failed to create post',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async commentOnLinkedInPost(userId: string, accountId: string, postUrn: string, commentText: string): Promise<any> {
    console.log('[AgentMode] commentOnLinkedInPost called:', {
      userId,
      accountId,
      postUrn,
      commentLength: commentText?.length || 0
    });

    try {
      const { getAccountById } = await import('./connectedAccountsDb');
      const { socialPlatformService } = await import('./socialPlatformService');

      try {
        console.log('[AgentMode] Looking up account:', accountId);
        const account = await getAccountById(accountId, userId);
        console.log('[AgentMode] Account lookup result:', account ? {
          found: true,
          platform: account.platform,
          accountType: account.config?.account_type,
          accountName: account.account_name
        } : { found: false });

        if (!account) {
          console.log('[AgentMode] Account not found, returning error');
          return {
            success: false,
            message: 'Account not found or access denied'
          };
        }

        // Only LinkedIn is supported for commenting
        if (account.platform !== 'linkedin') {
          return {
            success: false,
            message: 'Commenting is currently only supported for LinkedIn accounts'
          };
        }

        console.log('[AgentMode] Getting LinkedIn adapter');
        const adapter = socialPlatformService.getAdapter(account.platform);

        // Check if the adapter supports commenting
        if (!adapter.createComment) {
          return {
            success: false,
            message: 'Commenting is not supported for this platform'
          };
        }

        console.log('[AgentMode] Calling adapter.createComment (adapter will handle token refresh if needed)...');
        const result = await adapter.createComment(account, postUrn, commentText, userId);

        return {
          success: true,
          message: result.message,
          comment_id: result.postId,
          post_url: result.postUrl
        };
      } catch (error: any) {
        // Handle specific error messages
        let message = error.message;
        if (message.includes('access token expired')) {
          message = 'Account token expired. Please reconnect the account in Settings.';
        }

        return {
          success: false,
          message: `Failed to comment: ${message}`
        };
      }

    } catch (error) {
      console.error('AgentMode: Error commenting on post:', error);
      return {
        success: false,
        message: 'Failed to create comment',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async reactToLinkedInPost(userId: string, accountId: string, postUrn: string, reactionType: string = 'LIKE'): Promise<any> {
    console.log('[AgentMode] reactToLinkedInPost called:', {
      userId,
      accountId,
      postUrn,
      reactionType
    });

    try {
      const { getAccountById } = await import('./connectedAccountsDb');
      const { socialPlatformService } = await import('./socialPlatformService');

      try {
        console.log('[AgentMode] Looking up account:', accountId);
        const account = await getAccountById(accountId, userId);
        console.log('[AgentMode] Account lookup result:', account ? {
          found: true,
          platform: account.platform,
          accountType: account.config?.account_type,
          accountName: account.account_name
        } : { found: false });

        if (!account) {
          console.log('[AgentMode] Account not found, returning error');
          return {
            success: false,
            message: 'Account not found or access denied'
          };
        }

        // Only LinkedIn is supported for reactions
        if (account.platform !== 'linkedin') {
          return {
            success: false,
            message: 'Reactions are currently only supported for LinkedIn accounts'
          };
        }

        console.log('[AgentMode] Getting LinkedIn adapter');
        const adapter = socialPlatformService.getAdapter(account.platform);

        // Check if the adapter supports reactions
        if (!adapter.createReaction) {
          return {
            success: false,
            message: 'Reactions are not supported for this platform'
          };
        }

        console.log('[AgentMode] Calling adapter.createReaction (adapter will handle token refresh if needed)...');
        const result = await adapter.createReaction(account, postUrn, reactionType, userId);

        return {
          success: true,
          message: result.message,
          reaction_id: result.postId,
          post_url: result.postUrl
        };
      } catch (error: any) {
        // Handle specific error messages
        let message = error.message;
        if (message.includes('access token expired')) {
          message = 'Account token expired. Please reconnect the account in Settings.';
        }

        return {
          success: false,
          message: `Failed to react: ${message}`
        };
      }

    } catch (error) {
      console.error('AgentMode: Error reacting to post:', error);
      return {
        success: false,
        message: 'Failed to create reaction',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Load posts for connected account helper
  async loadConnectedAccountPosts(
    userId: string,
    accountId: string,
    options: { limit?: number; include_metrics?: boolean } = {}
  ): Promise<any> {
    console.log('[AgentMode] loadConnectedAccountPosts called:', {
      userId,
      accountId,
      options
    });

    try {
      const { getAccountById } = await import('./connectedAccountsDb');
      const { socialPlatformService } = await import('./socialPlatformService');

      try {
        console.log('[AgentMode] Looking up account:', accountId);
        const account = await getAccountById(accountId, userId);
        console.log('[AgentMode] Account lookup result:', account ? {
          found: true,
          platform: account.platform,
          accountType: account.config?.account_type,
          accountName: account.account_name
        } : { found: false });

        if (!account) {
          return {
            success: false,
            message: 'Account not found or access denied'
          };
        }

        // NOTE: Skipping isTokenValid check here because the adapter should handle 
        // token refresh internally. However, listPosts doesn't pass userId, so we
        // need to check if the adapter supports token refresh for this operation.
        console.log('[AgentMode] Getting adapter for platform:', account.platform);
        const adapter = socialPlatformService.getAdapter(account.platform);
        const limit = options.limit || 10;
        
        console.log('[AgentMode] Calling adapter.listPosts with limit:', limit);
        // Fetch posts via adapter
        let posts = await adapter.listPosts(account, { limit });
        console.log('[AgentMode] listPosts returned', posts?.length || 0, 'posts');
        
        // Fetch metrics merging if requested and supported
        if (options.include_metrics && posts.length > 0) {
          try {
            // Assume posts have an 'id' field as per LinkedIn/generic structure
            const postIds = posts.map(p => p.id).filter(Boolean);
            if (postIds.length > 0) {
              const metrics = await adapter.getPostMetrics(account, postIds);
              
              // Merge metrics into posts
              posts = posts.map(post => {
                const metric = metrics.find(m => m.share === post.id);
                return {
                  ...post,
                  metrics: metric ? {
                    likeCount: metric.likes,
                    commentCount: metric.comments,
                    shareCount: metric.shares,
                    impressionCount: metric.impressions,
                    clickCount: metric.clicks,
                    engagement: metric.engagement
                  } : null
                };
              });
            }
          } catch (metricError) {
            console.warn('AgentMode: Failed to fetch post metrics:', metricError);
            // Continue without metrics
          }
        }
        
        return {
          success: true,
          message: `Successfully loaded ${posts.length} posts from ${account.platform}`,
          posts: posts
        };

      } catch (error: any) {
        return {
          success: false,
          message: `Failed to load posts: ${error.message}`
        };
      }

    } catch (error) {
      console.error('AgentMode: Error loading connected account posts:', error);
      return {
        success: false,
        message: 'Failed to load posts',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Load metrics for connected account helper
  async loadConnectedAccountMetrics(userId: string, accountId: string): Promise<any> {
    try {
      const { getAccountById } = await import('./connectedAccountsDb');
      const { socialPlatformService } = await import('./socialPlatformService');

      try {
        const account = await getAccountById(accountId, userId);

        if (!account) {
          return {
            success: false,
            message: 'Account not found or access denied'
          };
        }

        const adapter = socialPlatformService.getAdapter(account.platform);

        const metrics = await adapter.getAccountMetrics(account);

        return {
          success: true,
          message: `Metrics loaded successfully from ${account.platform}`,
          metrics: metrics
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Failed to load metrics: ${error.message}`
        };
      }

    } catch (error) {
      console.error('AgentMode: Error loading connected account metrics:', error);
      return {
        success: false,
        message: 'Failed to load metrics',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get detailed analytics for specific posts
   * The account must belong to the authenticated user
   */
  async getPostAnalytics(
    userId: string,
    accountId: string,
    postIds: string[]
  ): Promise<any> {
    console.log('[AgentMode] getPostAnalytics called:', {
      userId,
      accountId,
      postIds: postIds?.length || 0
    });

    try {
      if (!postIds || postIds.length === 0) {
        return {
          success: false,
          message: 'No post IDs provided'
        };
      }

      const { getAccountById } = await import('./connectedAccountsDb');
      const { socialPlatformService } = await import('./socialPlatformService');

      // Verify account ownership
      const account = await getAccountById(accountId, userId);
      if (!account) {
        return {
          success: false,
          message: 'Account not found or access denied'
        };
      }

      const adapter = socialPlatformService.getAdapter(account.platform);
      const analytics = await adapter.getPostAnalytics(account, postIds, userId);

      // Check for any errors in the results
      const failedCount = analytics.filter((a: any) => a.error).length;
      const successCount = analytics.length - failedCount;

      return {
        success: true,
        message: failedCount > 0
          ? `Retrieved analytics for ${successCount}/${analytics.length} posts (${failedCount} failed)`
          : `Successfully retrieved analytics for ${analytics.length} post(s)`,
        analytics,
        summary: {
          totalPosts: analytics.length,
          successCount,
          failedCount
        }
      };

    } catch (error) {
      console.error('AgentMode: Error getting post analytics:', error);
      return {
        success: false,
        message: 'Failed to get post analytics',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

export const agentModeService = new AgentModeService();
