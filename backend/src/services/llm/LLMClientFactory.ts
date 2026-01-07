/**
 * LLM Client Factory
 * 
 * Manages LLM client instances for different providers (Azure OpenAI, Gemini).
 * Extracted from agentModeService.ts for better modularity.
 */

import OpenAI from 'openai';
import { getSecret } from '../../utils/secretsManager';
import { settingsService } from '../settingsService';

/**
 * Type for LLM model configuration
 */
export interface LLMModelConfig {
  /** Provider type */
  provider: 'azure-openai' | 'gemini';
  
  /** Deployment/model name */
  deploymentName: string;
  
  /** Whether this model supports temperature parameter */
  supportsTemperature: boolean;
  
  /** Client instance (null for lazy-loaded) */
  client?: OpenAI | null;
}

/**
 * Type for LLM call options
 */
export interface LLMCallOptions {
  tools?: any[] | null;
  tool_choice?: 'auto' | 'none' | any | null;
  max_completion_tokens?: number | null;
  temperature?: number | null;
  response_format?: { type: 'text' | 'json_object' } | null;
}

/**
 * LLM response type
 */
export type LLMResponse = OpenAI.Chat.Completions.ChatCompletion;

/**
 * LLM Client Factory - manages LLM connections
 */
export class LLMClientFactory {
  private clients = new Map<string, OpenAI>();
  private geminiClientPromise: Promise<OpenAI> | null = null;
  private defaultModelSettingName = 'agent_mode_default_model';

  /**
   * Model configurations
   */
  private modelConfigs: Record<string, LLMModelConfig> = {
    'gpt-5-chat-2': {
      provider: 'azure-openai',
      deploymentName: 'gpt-5-chat-2',
      supportsTemperature: true
    },
    'gpt-5.2-chat': {
      provider: 'azure-openai',
      deploymentName: 'gpt-5.2-chat',
      supportsTemperature: false
    },
    'gemini-3-pro-preview': {
      provider: 'gemini',
      deploymentName: 'gemini-3-pro-preview',
      supportsTemperature: true
    },
    'gemini-3-flash-preview': {
      provider: 'gemini',
      deploymentName: 'gemini-3-flash-preview',
      supportsTemperature: true
    }
  };

  /**
   * Default model from environment
   */
  private envDefaultModel = process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2';

  /**
   * Get the default model (from settings or env)
   */
  async getDefaultModel(): Promise<string> {
    try {
      const setting = await settingsService.getSetting(this.defaultModelSettingName);
      const configuredModel = setting?.settingValue?.trim();
      
      if (configuredModel && this.modelConfigs[configuredModel]) {
        return configuredModel;
      }
      
      if (configuredModel) {
        console.warn(`LLMClientFactory: Unsupported model "${configuredModel}" in settings; using fallback.`);
      }
    } catch (error) {
      console.error('LLMClientFactory: Error getting default model setting:', error);
    }
    
    return this.envDefaultModel;
  }

  /**
   * Get list of supported models
   */
  getSupportedModels(): string[] {
    return Object.keys(this.modelConfigs);
  }

  /**
   * Check if a model is supported
   */
  isModelSupported(model: string): boolean {
    return model in this.modelConfigs;
  }

  /**
   * Get model configuration
   */
  getModelConfig(model: string): LLMModelConfig | undefined {
    return this.modelConfigs[model];
  }

  /**
   * Create Azure OpenAI client for a specific deployment
   */
  private createAzureOpenAIClient(deploymentName: string): OpenAI {
    return new OpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${deploymentName}`,
      defaultQuery: {
        'api-version': process.env.AZURE_OPENAI_API_VERSION_AGENT_MODE || 
                       process.env.AZURE_OPENAI_API_VERSION || 
                       '2025-01-01-preview'
      },
      defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY }
    });
  }

  /**
   * Get Gemini client (lazy-loaded with singleton pattern)
   */
  private async getGeminiClient(): Promise<OpenAI> {
    // Return cached promise if initializing
    if (this.geminiClientPromise) {
      return this.geminiClientPromise;
    }

    // Check if already cached
    const cached = this.clients.get('gemini');
    if (cached) {
      return cached;
    }

    // Initialize client
    this.geminiClientPromise = (async () => {
      try {
        const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
        const geminiSecretName = `${environment}/AgentWeb/GeminiAPIKey`;
        const geminiApiKey = await getSecret(geminiSecretName);

        if (!geminiApiKey || !geminiApiKey.trim()) {
          throw new Error('Gemini API key is empty');
        }

        const client = new OpenAI({
          apiKey: geminiApiKey.trim(),
          baseURL: 'https://generativelanguage.googleapis.com/v1beta'
        });

        this.clients.set('gemini', client);
        return client;
      } catch (error) {
        console.error('LLMClientFactory: Error initializing Gemini client:', error);
        this.geminiClientPromise = null; // Reset on error
        throw error;
      }
    })();

    return this.geminiClientPromise;
  }

  /**
   * Get client for a specific model
   */
  async getClient(model: string): Promise<OpenAI> {
    const config = this.modelConfigs[model];
    if (!config) {
      throw new Error(`Unsupported model: ${model}. Available: ${this.getSupportedModels().join(', ')}`);
    }

    // For Azure OpenAI, create/cache client per deployment
    if (config.provider === 'azure-openai') {
      if (!this.clients.has(model)) {
        this.clients.set(model, this.createAzureOpenAIClient(config.deploymentName));
      }
      return this.clients.get(model)!;
    }

    // For Gemini, use shared lazy-loaded client
    if (config.provider === 'gemini') {
      return this.getGeminiClient();
    }

    throw new Error(`Unknown provider for model: ${model}`);
  }

  /**
   * Make an LLM call
   */
  async callLLM(
    model: string,
    messages: any[],
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    const config = this.modelConfigs[model];
    if (!config) {
      throw new Error(`Invalid model '${model}'. Available: ${this.getSupportedModels().join(', ')}`);
    }

    // Build params
    const {
      tools = null,
      tool_choice = null,
      max_completion_tokens = null,
      temperature = null,
      response_format = { type: 'text' }
    } = options || {};

    const params: any = {
      model,
      messages,
      response_format: response_format || { type: 'text' }
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = tool_choice || 'auto';
    }

    // Add max_completion_tokens if specified
    if (max_completion_tokens) {
      params.max_completion_tokens = max_completion_tokens;
    }

    // Add temperature if model supports it
    if (config.supportsTemperature && temperature !== null) {
      params.temperature = temperature;
    }

    // Get client and make call
    const client = await this.getClient(model);
    return client.chat.completions.create(params);
  }

  /**
   * Clear cached clients (useful for testing)
   */
  clearClients(): void {
    this.clients.clear();
    this.geminiClientPromise = null;
  }
}

// Singleton instance
export const llmClientFactory = new LLMClientFactory();
