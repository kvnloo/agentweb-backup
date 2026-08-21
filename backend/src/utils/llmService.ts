import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { extractJson, JsonExtractError } from '../services/util/extractJson';
import { meterUserUsage } from '../services/usageRecorderService';

export type OutputFormat = 'json' | 'xml';

const STRICT_JSON_SUFFIX =
  '\n\nCRITICAL: You MUST respond with only valid JSON. No preamble, no markdown fences, no commentary. Output the JSON value and NOTHING else.';

export interface LLMUsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type OnUsageCallback = (usage: LLMUsageData) => void;

export interface LLMUsageContext {
  userId?: string;
  billingUserId?: string;
  feature?: string;
  sessionId?: string;
}

export interface LLMServiceOptions {
  /** Long generations receive a longer gateway deadline; callers still receive one final response. */
  streaming?: boolean;
}

type InvokeResponse = {
  content?: unknown;
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_token_details?: { cache_read?: number; cache_creation?: number };
  };
  /** callLLM already recorded this response, so the compatibility wrapper must not double-charge it. */
  __agentwebGatewayMetered?: boolean;
};

/**
 * Compatibility facade for legacy content/enrichment callers.
 *
 * Model selection, transport, fallback and charging now live in
 * AgentModeService.callLLM. This class retains only response parsing and the
 * narrow web-search APIs that are proven separately in ENG-1432.
 */
export class LLMService {
  private chatModel: { invoke(messages: unknown[]): Promise<InvokeResponse> };
  private readonly gatewayAdapter: { invoke(messages: unknown[]): Promise<InvokeResponse> };
  private readonly modelName: string;
  private readonly isGemini: boolean;
  private readonly provider: string;
  private readonly temperature: number | null;
  private readonly maxTokens?: number;
  private readonly longRunning: boolean;

  constructor(
    modelName?: string,
    temperature: number | null = 0.8,
    maxTokens?: number,
    options: LLMServiceOptions = {},
  ) {
    this.modelName = modelName || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.5';
    this.isGemini = this.modelName.toLowerCase().includes('gemini');
    this.provider = this.isGemini
      ? 'gemini'
      : this.modelName.toLowerCase().includes('claude') || this.modelName.startsWith('anthropic.')
        ? 'bedrock'
        : 'azure-openai';
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.longRunning = options.streaming === true;
    this.gatewayAdapter = { invoke: (messages) => this.invokeGateway(messages) };
    this.chatModel = this.gatewayAdapter;
  }

  private async invokeGateway(
    messages: unknown[],
    usageContext?: LLMUsageContext,
  ): Promise<InvokeResponse> {
    // Dynamic import avoids a module-init cycle: AgentModeService imports this
    // file's public types and compatibility factory for older tool handlers.
    const { agentModeService } = await import('../services/agentModeService');
    const normalizedMessages = messages.map((message: any) => ({
      role: message?._getType?.() === 'system' || message?.type === 'system' ? 'system' : 'user',
      content: typeof message?.content === 'string' ? message.content : String(message?.content || ''),
    }));
    const response = await agentModeService.callLLM(this.modelName, normalizedMessages, {
      temperature: this.temperature,
      max_completion_tokens: this.maxTokens,
      timeoutMs: this.longRunning ? 30 * 60 * 1000 : undefined,
      usageContext: usageContext || { feature: 'unknown' },
      taskClass: 'nonstandard_consumer',
    });
    const usage = response?.usage || {};
    return {
      content: response?.choices?.[0]?.message?.content || '',
      usage_metadata: {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        input_token_details: {
          cache_read: usage.cache_read_input_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
          cache_creation: usage.cache_creation_input_tokens || 0,
        },
      },
      __agentwebGatewayMetered: true,
    };
  }

  private requireChatModel(): { invoke(messages: unknown[]): Promise<InvokeResponse> } {
    return this.chatModel;
  }

  private extractUsage(response: InvokeResponse): LLMUsageData {
    const meta = response?.usage_metadata;
    const inputTokens = meta?.input_tokens || 0;
    const outputTokens = meta?.output_tokens || 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: meta?.total_tokens || inputTokens + outputTokens,
      model: this.modelName,
      cacheReadTokens: meta?.input_token_details?.cache_read || 0,
      cacheWriteTokens: meta?.input_token_details?.cache_creation || 0,
    };
  }

  private observeUsage(
    response: InvokeResponse,
    usageContext?: LLMUsageContext,
    onUsage?: OnUsageCallback,
  ): void {
    const usage = this.extractUsage(response);
    if (!response.__agentwebGatewayMetered) {
      try {
        meterUserUsage({
          userId: usageContext?.userId,
          billingUserId: usageContext?.billingUserId,
          sessionId: usageContext?.sessionId,
          model: usage.model,
          provider: this.provider,
          feature: usageContext?.feature || 'unknown',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        });
      } catch {
        // Metering remains fail-open for injected/test and direct web-search responses.
      }
    }
    onUsage?.(usage);
  }

  private async invoke(
    systemPrompt: string,
    userPrompt: string,
    usageContext?: LLMUsageContext,
    onUsage?: OnUsageCallback,
  ): Promise<string> {
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];
    const response = this.chatModel === this.gatewayAdapter
      ? await this.invokeGateway(messages, usageContext)
      : await this.requireChatModel().invoke(messages);
    this.observeUsage(response, usageContext, onUsage);
    return typeof response.content === 'string' ? response.content : String(response.content || '');
  }

  async generateContent(
    systemPrompt: string,
    userPrompt: string,
    responseFormat?: 'json' | 'text',
    usageContext?: LLMUsageContext,
  ): Promise<string> {
    const raw = await this.invoke(systemPrompt, userPrompt, usageContext);
    return responseFormat === 'json' ? JSON.stringify(extractJson(raw)) : raw;
  }

  private parseXML<T = any>(xmlString: string): T {
    const result: any = {};
    for (const key of ['content', 'title', 'description', 'imagePrompt']) {
      const match = xmlString.match(new RegExp(`<${key}>([\\s\\S]*?)</${key}>`, 'i'));
      if (match?.[1]) result[key] = match[1].trim();
    }
    return result as T;
  }

  async generateJSONContent<T = any>(
    systemPrompt: string,
    userPrompt: string,
    format: OutputFormat = 'json',
    onUsage?: OnUsageCallback,
    usageContext?: LLMUsageContext,
  ): Promise<T> {
    const raw = await this.invoke(systemPrompt, userPrompt, usageContext, onUsage);
    if (format === 'json') return extractJson<T>(raw);
    const parsed = this.parseXML<T>(raw);
    if ((parsed as any)?.content) return parsed;
    const contentStart = raw.indexOf('<content>');
    if (contentStart >= 0) {
      const start = contentStart + '<content>'.length;
      const end = raw.indexOf('</content>', start);
      const content = raw.slice(start, end >= 0 ? end : undefined).trim();
      if (content) return { content } as T;
    }
    throw new Error('Could not extract content from XML response');
  }

  async generateJsonRobust<T = any>(
    systemPrompt: string,
    userPrompt: string,
    onUsage?: OnUsageCallback,
    usageContext?: LLMUsageContext,
  ): Promise<T> {
    let firstRaw = '';
    try {
      firstRaw = await this.invoke(systemPrompt, userPrompt, usageContext, onUsage);
      return extractJson<T>(firstRaw);
    } catch (error) {
      if (!(error instanceof JsonExtractError)) throw error;
      console.warn('[LLMService] generateJsonRobust: first extraction failed, retrying with strict prompt', {
        firstSnippet: error.rawSnippet.slice(0, 120),
      });
    }

    try {
      return extractJson<T>(
        await this.invoke(systemPrompt + STRICT_JSON_SUFFIX, userPrompt, usageContext, onUsage),
      );
    } catch (error) {
      if (error instanceof JsonExtractError) throw error;
      throw new JsonExtractError(
        `LLM call failed during strict-retry: ${(error as Error).message}`,
        firstRaw,
      );
    }
  }

  async generateRaw(
    systemPrompt: string,
    userPrompt: string,
    onUsage?: OnUsageCallback,
    usageContext?: LLMUsageContext,
  ): Promise<string> {
    return this.invoke(systemPrompt, userPrompt, usageContext, onUsage);
  }

  async generateHTML(
    systemPrompt: string,
    userPrompt: string,
    onUsage?: OnUsageCallback,
    usageContext?: LLMUsageContext,
  ): Promise<string> {
    const raw = await this.invoke(`${systemPrompt}\n\nCRITICAL: You MUST wrap your HTML output in the following XML tags:\n<actual_html_content>\n[Your complete HTML code here]\n</actual_html_content>\n\nThe HTML must be a complete, well-formed HTML document with proper DOCTYPE, head, and body sections.`, userPrompt, usageContext, onUsage);
    const tagged = raw.match(/<actual_html_content>([\s\S]*?)<\/actual_html_content>/i)?.[1];
    if (tagged) return tagged.trim();
    const htmlStart = raw.search(/<!DOCTYPE|<html/i);
    if (htmlStart < 0) return raw.trim();
    const html = raw.slice(htmlStart).trim();
    const htmlEnd = html.lastIndexOf('</html>');
    return htmlEnd >= 0 ? html.slice(0, htmlEnd + '</html>'.length).trim() : html;
  }

  /**
   * Temporary capability exception: these two provider-native web-search APIs
   * remain until ENG-1432 proves the OpenRouter web plugin against the same
   * enrichment fixtures. Ordinary text generation no longer uses them.
   */
  async generateJSONContentWithWebSearch<T = any>(
    systemPrompt: string,
    userPrompt: string,
    usageContext?: LLMUsageContext,
  ): Promise<T> {
    if (this.isGemini) {
      const { GoogleGenAI } = await import('@google/genai');
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GEMINI_API_KEY not set');
      const response = await new GoogleGenAI({ apiKey: apiKey.trim() }).models.generateContent({
        model: this.modelName,
        contents: userPrompt,
        config: { systemInstruction: systemPrompt, tools: [{ googleSearch: {} }] },
      });
      const usage = (response as any)?.usageMetadata;
      this.observeUsage({
        content: response.text || '',
        usage_metadata: {
          input_tokens: usage?.promptTokenCount || 0,
          output_tokens: usage?.candidatesTokenCount || 0,
          total_tokens: usage?.totalTokenCount || 0,
          input_token_details: { cache_read: usage?.cachedContentTokenCount || 0 },
        },
      }, usageContext);
      return extractJson<T>(response.text || '');
    }

    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!apiKey || !endpoint) throw new Error('AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT must be set');
    const apiVersion = process.env.AZURE_OPENAI_RESPONSES_API_VERSION || '2025-03-01-preview';
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/openai/responses?api-version=${apiVersion}`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        instructions: systemPrompt,
        input: userPrompt,
        tools: [{ type: 'web_search' }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Azure Responses API ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = JSON.parse(await response.text()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
    const text = payload.output_text || payload.output?.flatMap((item) => item.content || [])
      .map((content) => content.text || '').filter(Boolean).join('') || '';
    this.observeUsage({
      content: text,
      usage_metadata: {
        input_tokens: payload.usage?.input_tokens || 0,
        output_tokens: payload.usage?.output_tokens || 0,
        total_tokens: payload.usage?.total_tokens || 0,
      },
    }, usageContext);
    return extractJson<T>(text);
  }
}

export function createLLMService(
  modelName?: string,
  temperature: number | null = 0.8,
  maxTokens?: number,
  options: LLMServiceOptions = {},
): LLMService {
  return new LLMService(modelName, temperature, maxTokens, options);
}
