import { AzureChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { JsonOutputParser } from '@langchain/core/output_parsers';

/**
 * Common LLM service for generating content using LangChain
 * Supports multiple models and providers
 */
export class LLMService {
  private chatModel: AzureChatOpenAI;

  constructor(modelName?: string, temperature: number = 0.8, maxTokens?: number) {
    // Determine which model to use
    const model = modelName || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
    
    // Get the endpoint URL
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    
    // Validate required environment variables
    if (!apiKey) {
      throw new Error('AZURE_OPENAI_API_KEY is not set');
    }
    if (!endpoint) {
      throw new Error('AZURE_OPENAI_ENDPOINT is not set');
    }
    
    // Extract instance name from endpoint (e.g., https://myinstance.openai.azure.com -> myinstance)
    // LangChain expects just the instance name, not the full URL
    let instanceName = '';
    try {
      const url = new URL(endpoint);
      instanceName = url.hostname.replace('.openai.azure.com', '');
    } catch (error) {
      // Fallback to regex if URL parsing fails
      const urlMatch = endpoint.match(/https?:\/\/([^\/]+)/);
      if (urlMatch) {
        instanceName = urlMatch[1].replace('.openai.azure.com', '');
      }
    }
    
    if (!instanceName) {
      throw new Error(`Could not extract instance name from AZURE_OPENAI_ENDPOINT: ${endpoint}`);
    }
    
    // Configure Azure OpenAI for LangChain
    // Use AzureChatOpenAI which accepts Azure-specific properties
    try {
      const config: any = {
        azureOpenAIApiKey: apiKey,
        azureOpenAIApiInstanceName: instanceName,
        azureOpenAIApiDeploymentName: model,
        azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview',
        temperature: temperature,
      };
      
      if (maxTokens) {
        config.maxTokens = maxTokens;
      }
      
      this.chatModel = new AzureChatOpenAI(config);
    } catch (configError) {
      console.error('LLMService: Configuration error:', {
        error: configError,
        endpoint,
        instanceName,
        model,
        hasApiKey: !!apiKey,
        apiKeyLength: apiKey ? apiKey.length : 0,
      });
      throw new Error(`Failed to configure Azure OpenAI: ${configError instanceof Error ? configError.message : 'Unknown configuration error'}`);
    }
  }

  /**
   * Generate content with system and user prompts
   * @param systemPrompt System prompt for the LLM
   * @param userPrompt User prompt with the actual request
   * @param responseFormat Optional: 'json' to request JSON output
   * @returns The generated content as a string
   */
  async generateContent(
    systemPrompt: string,
    userPrompt: string,
    responseFormat?: 'json' | 'text'
  ): Promise<string> {
    try {
      const prompt = ChatPromptTemplate.fromMessages([
        ['system', systemPrompt],
        ['user', userPrompt],
      ]);

      const chain = prompt.pipe(this.chatModel);

      if (responseFormat === 'json') {
        // Use JSON output parser for structured responses
        const jsonParser = new JsonOutputParser();
        const jsonChain = chain.pipe(jsonParser);
        const result = await jsonChain.invoke({});
        // Return as stringified JSON for consistency
        return typeof result === 'string' ? result : JSON.stringify(result);
      } else {
        // Regular text response
        const response = await chain.invoke({}) as { content: string };
        return response.content;
      }
    } catch (error) {
      console.error('LLMService: Error generating content:', error);
      throw error;
    }
  }

  /**
   * Generate JSON content with validation
   * @param systemPrompt System prompt (should instruct to return JSON)
   * @param userPrompt User prompt
   * @returns Parsed JSON object
   */
  async generateJSONContent<T = any>(
    systemPrompt: string,
    userPrompt: string
  ): Promise<T> {
    try {
      const prompt = ChatPromptTemplate.fromMessages([
        ['system', systemPrompt],
        ['user', userPrompt],
      ]);

      const jsonParser = new JsonOutputParser();
      const chain = prompt.pipe(this.chatModel).pipe(jsonParser);

      const result = await chain.invoke({});
      return result as T;
    } catch (error) {
      console.error('LLMService: Error generating JSON content:', error);
      if (error instanceof Error) {
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        // Check for common Azure OpenAI configuration errors
        if (error.message.includes('api key') || error.message.includes('API key') || error.message.includes('api-key')) {
          throw new Error(`Azure OpenAI API key configuration error: ${error.message}`);
        }
        if (error.message.includes('endpoint') || error.message.includes('instance')) {
          throw new Error(`Azure OpenAI endpoint configuration error: ${error.message}`);
        }
      }
      throw error;
    }
  }
}

/**
 * Helper function to create an LLM service instance with default settings
 */
export function createLLMService(
  modelName?: string,
  temperature: number = 0.8,
  maxTokens?: number
): LLMService {
  return new LLMService(modelName, temperature, maxTokens);
}

