import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { extractJson, JsonExtractError } from '../services/util/extractJson';
import { meterUserUsage } from '../services/usageRecorderService';
import type { GatewayTaskClass } from './openRouterGatewayContract';

export type OutputFormat = 'json' | 'xml';

const STRICT_JSON_SUFFIX =
  '\n\nCRITICAL: You MUST respond with only valid JSON. No preamble, no markdown fences, no commentary. Output the JSON value and NOTHING else.';
const WEB_SEARCH_TIMEOUT_MS = 2 * 60 * 1000;

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
  /** Product task class for independent gateway canary and rollback. */
  taskClass?: GatewayTaskClass;
  /** Models OpenRouter tries, in order, if the primary model fails. */
  fallbackModels?: string[];
  /** Providers OpenRouter must skip on web-search calls (ENG-2720: Azure errors on the search tool). */
  providerIgnoreForWebSearch?: string[];
  /** Retry a 200 with no answer instead of returning an empty string (ENG-2720). */
  requireContent?: boolean;
  /** Parameters for the web-search tool on this service's web-search calls (ENG-2720). */
  webSearchParameters?: Record<string, string | number>;
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
  /** Provider finish reason (ENG-2679); undefined when the transport omits it. */
  finishReason?: string;
};

/**
 * Compatibility facade for legacy content/enrichment callers.
 *
 * Model selection, transport, fallback and charging now live in
 * AgentModeService.callLLM. This class retains only response parsing and
 * compatibility method names for older callers.
 */
export class LLMService {
  private chatModel: { invoke(messages: unknown[]): Promise<InvokeResponse> };
  private readonly gatewayAdapter: { invoke(messages: unknown[]): Promise<InvokeResponse> };
  private readonly modelName: string;
  private readonly provider: string;
  private readonly temperature: number | null;
  private readonly maxTokens?: number;
  private readonly longRunning: boolean;
  private readonly taskClass: GatewayTaskClass;
  private readonly fallbackModels?: string[];
  private readonly providerIgnoreForWebSearch?: string[];
  private readonly requireContent: boolean;
  private readonly webSearchParameters?: Record<string, string | number>;

  constructor(
    modelName?: string,
    temperature: number | null = 0.8,
    maxTokens?: number,
    options: LLMServiceOptions = {},
  ) {
    this.modelName = modelName || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.5';
    this.provider = this.modelName.toLowerCase().includes('gemini')
      ? 'gemini'
      : this.modelName.toLowerCase().includes('claude') || this.modelName.startsWith('anthropic.')
        ? 'bedrock'
        : 'azure-openai';
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.longRunning = options.streaming === true;
    this.taskClass = options.taskClass || 'nonstandard_consumer';
    this.fallbackModels = options.fallbackModels;
    this.providerIgnoreForWebSearch = options.providerIgnoreForWebSearch;
    this.requireContent = options.requireContent === true;
    this.webSearchParameters = options.webSearchParameters;
    this.gatewayAdapter = { invoke: (messages) => this.invokeGateway(messages) };
    this.chatModel = this.gatewayAdapter;
  }

  private async invokeGateway(
    messages: unknown[],
    usageContext?: LLMUsageContext,
    requestOptions: { webSearch?: boolean; timeoutMs?: number } = {},
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
      timeoutMs: requestOptions.timeoutMs ?? (this.longRunning ? 30 * 60 * 1000 : undefined),
      webSearch: requestOptions.webSearch,
      ...(requestOptions.webSearch && this.webSearchParameters ? { webSearchParameters: this.webSearchParameters } : {}),
      usageContext: usageContext || { feature: 'unknown' },
      taskClass: this.taskClass,
      ...(this.fallbackModels?.length ? { fallbackModels: this.fallbackModels } : {}),
      ...(requestOptions.webSearch && this.providerIgnoreForWebSearch?.length ? { providerIgnore: this.providerIgnoreForWebSearch } : {}),
      ...(this.requireContent ? { requireContent: true } : {}),
    });
    const usage: any = response?.usage;
    const hasUsage = !!usage && typeof usage === 'object';
    if (!hasUsage) {
      console.warn('[LLMService] gateway response omitted usage', { model: this.modelName });
    }
    return {
      content: response?.choices?.[0]?.message?.content || '',
      usage_metadata: hasUsage ? {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        input_token_details: {
          cache_read: usage.cache_read_input_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
          cache_creation: usage.cache_creation_input_tokens || 0,
        },
      } : undefined,
      __agentwebGatewayMetered: hasUsage ? true : undefined,
      finishReason: response?.choices?.[0]?.finish_reason || undefined,
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
      } catch (error) {
        // Metering remains fail-open for injected/test and direct web-search responses.
        console.warn('[LLMService] local metering failed', {
          model: usage.model,
          feature: usageContext?.feature,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
    onUsage?.(usage);
  }

  private async invoke(
    systemPrompt: string,
    userPrompt: string,
    usageContext?: LLMUsageContext,
    onUsage?: OnUsageCallback,
    requestOptions: { webSearch?: boolean; timeoutMs?: number } = {},
  ): Promise<string> {
    return (await this.invokeWithMeta(systemPrompt, userPrompt, usageContext, onUsage, requestOptions)).content;
  }

  private async invokeWithMeta(
    systemPrompt: string,
    userPrompt: string,
    usageContext?: LLMUsageContext,
    onUsage?: OnUsageCallback,
    requestOptions: { webSearch?: boolean; timeoutMs?: number } = {},
  ): Promise<{ content: string; finishReason?: string }> {
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];
    const response = this.chatModel === this.gatewayAdapter
      ? await this.invokeGateway(messages, usageContext, requestOptions)
      : await this.requireChatModel().invoke(messages);
    this.observeUsage(response, usageContext, onUsage);
    const content = typeof response.content === 'string' ? response.content : String(response.content || '');
    return { content, finishReason: response.finishReason };
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
        rawLength: error.rawSnippet.length,
        model: this.modelName,
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
    const { content: raw, finishReason } = await this.invokeWithMeta(`${systemPrompt}\n\nCRITICAL: You MUST wrap your HTML output in the following XML tags:\n<actual_html_content>\n[Your complete HTML code here]\n</actual_html_content>\n\nThe HTML must be a complete, well-formed HTML document with proper DOCTYPE, head, and body sections.`, userPrompt, usageContext, onUsage);
    // ENG-2679: a max-token cutoff is never a usable document or fragment.
    if (finishReason === 'length') {
      const err = new Error(`HTML generation truncated (finish_reason=length, model=${this.modelName})`);
      err.name = 'IncompleteHtmlRenderError';
      throw err;
    }
    const tagged = raw.match(/<actual_html_content>([\s\S]*?)<\/actual_html_content>/i)?.[1];
    if (tagged) return tagged.trim();
    const htmlStart = raw.search(/<!DOCTYPE|<html/i);
    if (htmlStart < 0) return raw.trim();
    const html = raw.slice(htmlStart).trim();
    const htmlEnd = html.lastIndexOf('</html>');
    return htmlEnd >= 0 ? html.slice(0, htmlEnd + '</html>'.length).trim() : html;
  }

  /** Web search uses the same gateway, metering, and provider-fallback boundary as every text call. */
  async generateJSONContentWithWebSearch<T = any>(
    systemPrompt: string,
    userPrompt: string,
    usageContext?: LLMUsageContext,
  ): Promise<T> {
    return extractJson<T>(await this.invoke(
      systemPrompt,
      userPrompt,
      usageContext,
      undefined,
      { webSearch: true, timeoutMs: WEB_SEARCH_TIMEOUT_MS },
    ));
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
