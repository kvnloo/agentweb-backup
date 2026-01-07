import { AzureChatOpenAI } from '@langchain/openai';
import { ChatBedrockConverse } from '@langchain/aws';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { JsonOutputParser } from '@langchain/core/output_parsers';

export type OutputFormat = 'json' | 'xml';

export class LLMService {
  private chatModel: AzureChatOpenAI | ChatBedrockConverse;

  constructor(modelName?: string, temperature: number = 0.8, maxTokens?: number) {
    const model = modelName || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
    const isClaude = model.toLowerCase().includes('claude') || model.toLowerCase().includes('sonnet') || model.startsWith('anthropic.');
    
    if (isClaude) {
      const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
      const bedrockClient = new BedrockRuntimeClient({
        region,
        credentials: process.env.AWS_ACCESS_KEY_ID ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        } : undefined,
      });
      
      const modelId = model === 'anthropic.claude-sonnet-4-5-20250929-v1:0'
        ? 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0'
        : model;
      
      this.chatModel = new ChatBedrockConverse({
        model: modelId,
        region,
        client: bedrockClient,
        temperature,
        ...(maxTokens && { maxTokens }),
      });
    } else {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      if (!apiKey || !endpoint) {
        throw new Error('AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT must be set');
      }
      const instanceName = new URL(endpoint).hostname.replace('.openai.azure.com', '');
      this.chatModel = new AzureChatOpenAI({
        azureOpenAIApiKey: apiKey,
        azureOpenAIApiInstanceName: instanceName,
        azureOpenAIApiDeploymentName: model,
        azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview',
        temperature,
        ...(maxTokens && { maxTokens }),
      });
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
   * Parse XML format response
   */
  private parseXML<T = any>(xmlString: string): T {
    const result: any = {};
    const contentMatch = xmlString.match(/<content>([\s\S]*?)<\/content>/i);
    if (contentMatch?.[1]) {
      result.content = contentMatch[1].trim();
    }
    const titleMatch = xmlString.match(/<title>([\s\S]*?)<\/title>/i);
    if (titleMatch?.[1]) result.title = titleMatch[1].trim();
    const descriptionMatch = xmlString.match(/<description>([\s\S]*?)<\/description>/i);
    if (descriptionMatch?.[1]) result.description = descriptionMatch[1].trim();
    const imagePromptMatch = xmlString.match(/<imagePrompt>([\s\S]*?)<\/imagePrompt>/i);
    if (imagePromptMatch?.[1]) result.imagePrompt = imagePromptMatch[1].trim();
    return result as T;
  }

  /**
   * Generate structured content with validation
   * @param systemPrompt System prompt
   * @param userPrompt User prompt
   * @param format Output format: 'json' (default) or 'xml'
   * @returns Parsed content object
   */
  async generateJSONContent<T = any>(
    systemPrompt: string,
    userPrompt: string,
    format: OutputFormat = 'json'
  ): Promise<T> {
    try {
      const prompt = ChatPromptTemplate.fromMessages([
        ['system', systemPrompt],
        ['user', userPrompt],
      ]);

      const chain = prompt.pipe(this.chatModel);
      const response = await chain.invoke({}) as { content: string };
      const rawResponse = response.content;

      if (format === 'xml') {
        const parsed = this.parseXML<T>(rawResponse);
        if (parsed && (parsed as any).content) {
          return parsed;
        }
        // Fallback: extract content directly if XML parsing fails
        const contentStart = rawResponse.indexOf('<content>');
        if (contentStart !== -1) {
          const start = contentStart + '<content>'.length;
          const end = rawResponse.indexOf('</content>', start);
          const content = end !== -1 ? rawResponse.substring(start, end) : rawResponse.substring(start);
          if (content.trim()) {
            return { content: content.trim() } as T;
          }
        }
        throw new Error('Could not extract content from XML response');
      }

      // JSON format
      const jsonParser = new JsonOutputParser();
      const jsonChain = chain.pipe(jsonParser);
      return await jsonChain.invoke({}) as T;
    } catch (error) {
      console.error('LLMService: Error generating content:', error);
      throw error;
    }
  }

  /**
   * Generate HTML content with required output format
   * @param systemPrompt System prompt for HTML generation
   * @param userPrompt User prompt with HTML requirements
   * @returns The generated HTML content as a string
   */
  async generateHTML(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    try {
      const htmlSystemPrompt = `${systemPrompt}

CRITICAL: You MUST wrap your HTML output in the following XML tags:
<actual_html_content>
[Your complete HTML code here]
</actual_html_content>

The HTML must be a complete, well-formed HTML document with proper DOCTYPE, head, and body sections.`;

      const prompt = ChatPromptTemplate.fromMessages([
        ['system', htmlSystemPrompt],
        ['user', userPrompt],
      ]);

      const chain = prompt.pipe(this.chatModel);
      const response = await chain.invoke({}) as { content: string };
      const rawResponse = response.content;

      // Extract HTML from <actual_html_content> tags
      const htmlMatch = rawResponse.match(/<actual_html_content>([\s\S]*?)<\/actual_html_content>/i);
      if (htmlMatch && htmlMatch[1]) {
        return htmlMatch[1].trim();
      }

      // Fallback: if tags are not found, try to extract HTML directly
      // Look for DOCTYPE or <html> tag
      const htmlStart = rawResponse.search(/<!DOCTYPE|<html/i);
      if (htmlStart !== -1) {
        const extractedHtml = rawResponse.substring(htmlStart).trim();
        // Try to find the end of the HTML document
        const htmlEnd = extractedHtml.lastIndexOf('</html>');
        if (htmlEnd !== -1) {
          return extractedHtml.substring(0, htmlEnd + '</html>'.length).trim();
        }
        return extractedHtml;
      }

      // If no HTML structure found, return the raw response as fallback
      console.warn('LLMService: Could not extract HTML from response, returning raw content');
      return rawResponse.trim();
    } catch (error) {
      console.error('LLMService: Error generating HTML:', error);
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

