import { AzureChatOpenAI } from '@langchain/openai';
import { ChatBedrockConverse } from '@langchain/aws';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { extractJson, JsonExtractError } from '../services/util/extractJson';
import { meterUserUsage } from '../services/usageRecorderService';
import { resolveBedrockModelId } from './bedrockInferenceProfiles';

export type OutputFormat = 'json' | 'xml';

/** Suffix appended on retry when the first extraction attempt fails. */
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

/**
 * Optional attribution context for shadow usage metering. When omitted, usage
 * is still recorded under userId "system" / feature "unknown" so platform
 * overhead stays visible.
 */
export interface LLMUsageContext {
  userId?: string;
  feature?: string;
  sessionId?: string;
}

export class LLMService {
  private chatModel: AzureChatOpenAI | ChatBedrockConverse | null;
  private modelName: string;
  private isGemini: boolean;
  private provider: string;

  /**
   * @param temperature Pass `null` to omit the parameter entirely and let the
   *   deployment use its default. Some Azure deployments (e.g. gpt-5-chat-2)
   *   reject ANY non-default temperature with a 400 `unsupported_value`, which
   *   callers then swallow — silently disabling whatever they were doing.
   */
  constructor(modelName?: string, temperature: number | null = 0.8, maxTokens?: number) {
    const model = modelName || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
    this.modelName = model;
    this.isGemini = model.toLowerCase().includes('gemini');

    if (this.isGemini) {
      this.chatModel = null;
      this.provider = 'gemini';
      return;
    }

    const isClaude = model.toLowerCase().includes('claude') || model.toLowerCase().includes('sonnet') || model.startsWith('anthropic.');
    this.provider = isClaude ? 'bedrock' : 'azure-openai';

    if (isClaude) {
      const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
      const bedrockClient = new BedrockRuntimeClient({
        region,
        // Pin SigV4 explicitly. If AWS_BEARER_TOKEN_BEDROCK is present in the
        // environment (e.g. cloud-dev boxes set it for the Claude Code CLI), the
        // SDK would otherwise default to bearer-first auth and send that token —
        // scoped to the Opus 4.8 account (231030591963) — for every Bedrock call,
        // 403ing models like Sonnet/Opus 4.6 that live in the default account.
        authSchemePreference: ['sigv4'],
        credentials: process.env.AWS_ACCESS_KEY_ID ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        } : undefined,
        requestHandler: {
          connectionTimeout: 10_000,
          requestTimeout: 5 * 60 * 1000, // 5 minutes, matching agentModeService
        } as any,
      });

      // Map model IDs to inference profile ARNs for cross-region access.
      // NOTE: bearer-token models (see BEDROCK_BEARER_TOKEN_MODELS) resolve here
      // but are still unreachable from this client, which is SigV4-only.
      const modelId = resolveBedrockModelId(model);

      this.chatModel = new ChatBedrockConverse({
        model: modelId,
        region,
        client: bedrockClient,
        ...(temperature === null ? {} : { temperature }),
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
        ...(temperature === null ? {} : { temperature }),
        ...(maxTokens && { maxTokens }),
      });
    }
  }

  /**
   * Extract usage data from a LangChain AIMessage response.
   * LangChain standardizes token counts on `usage_metadata` across providers.
   */
  private requireChatModel(): AzureChatOpenAI | ChatBedrockConverse {
    if (!this.chatModel) throw new Error(`LLMService: model "${this.modelName}" requires generateJSONContentWithWebSearch, not generateJSONContent`);
    return this.chatModel;
  }

  private extractUsage(response: any): LLMUsageData {
    const meta = response?.usage_metadata;
    const inputTokens = meta?.input_tokens || 0;
    const outputTokens = meta?.output_tokens || 0;
    const totalTokens = meta?.total_tokens || (inputTokens + outputTokens);
    // LangChain standardizes provider cache counters under input_token_details
    // (Bedrock: cache_read/cache_creation; OpenAI: cache_read).
    const details = meta?.input_token_details;
    const cacheReadTokens = details?.cache_read || 0;
    const cacheWriteTokens = details?.cache_creation || 0;
    return { inputTokens, outputTokens, totalTokens, model: this.modelName, cacheReadTokens, cacheWriteTokens };
  }

  /**
   * Meter a completed call. ALWAYS fired (regardless of onUsage), never awaited,
   * never throws — metering can't fail or slow a response.
   *
   * Routes through meterUserUsage (not a bare recordUsage): the shadow burn is
   * always recorded, AND the per-user cost cap is charged whenever a real userId
   * is attributable (org members resolve to the owner via incrementUserTokenUsage).
   * With no userId the call degrades to a burn-only record under "system", so
   * platform/background spend stays absorbed. This closes the ENG-200 gap where
   * high-volume LLMService features (enrichment, etc.) recorded burn but never
   * deducted from any quota.
   */
  private meterUsage(usage: LLMUsageData, usageContext?: LLMUsageContext): void {
    try {
      meterUserUsage({
        userId: usageContext?.userId,
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
      // Usage analytics must never break the LLM path.
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
    responseFormat?: 'json' | 'text',
    usageContext?: LLMUsageContext
  ): Promise<string> {
    try {
      const prompt = ChatPromptTemplate.fromMessages([
        ['system', systemPrompt],
        ['user', userPrompt],
      ]);

      const chain = prompt.pipe(this.requireChatModel());

      // Invoke the model first (so usage_metadata is observable), then parse.
      const response = await chain.invoke({}) as any;
      this.meterUsage(this.extractUsage(response), usageContext);

      if (responseFormat === 'json') {
        // Use JSON output parser for structured responses
        const jsonParser = new JsonOutputParser();
        const result = await jsonParser.invoke(response);
        // Return as stringified JSON for consistency
        return typeof result === 'string' ? result : JSON.stringify(result);
      } else {
        // Regular text response
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
   * @param onUsage Optional callback invoked with token usage after the LLM call
   * @returns Parsed content object
   */
  async generateJSONContent<T = any>(
    systemPrompt: string,
    userPrompt: string,
    format: OutputFormat = 'json',
    onUsage?: OnUsageCallback,
    usageContext?: LLMUsageContext
  ): Promise<T> {
    try {
      // Invoke the model directly to capture usage_metadata before any parsing
      const messages = [
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ];
      const response = await this.requireChatModel().invoke(messages) as any;
      const rawResponse = typeof response.content === 'string' ? response.content : String(response.content || '');

      const usage = this.extractUsage(response);
      this.meterUsage(usage, usageContext);
      if (onUsage) {
        onUsage(usage);
      }

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

      // JSON format — parse the raw string
      const jsonParser = new JsonOutputParser();
      return await jsonParser.invoke(rawResponse) as T;
    } catch (error) {
      console.error('LLMService: Error generating content:', error);
      throw error;
    }
  }

  /**
   * Robust JSON-from-LLM helper with one retry. Use this in pipelines that
   * must NOT cascade-fail on a stray "It looks like..." preamble from the
   * model.
   *
   * Flow:
   *   1. Invoke the model. Strip fences + parse via `extractJson` (which
   *      also tries balanced-brace extraction from prose).
   *   2. If extraction throws `JsonExtractError`, retry the call ONCE with
   *      a stricter system prompt suffix demanding pure JSON.
   *   3. If extraction still fails after retry, throw `JsonExtractError`
   *      whose `rawSnippet` contains a 500-char window of the second raw
   *      response — callers can persist this in their failure-state
   *      breadcrumb so a human can debug what the model said.
   *
   * Non-extraction errors (network, auth, model timeouts) bubble up
   * unchanged on the first call — only `JsonExtractError` triggers retry.
   */
  async generateJsonRobust<T = any>(
    systemPrompt: string,
    userPrompt: string,
    onUsage?: OnUsageCallback,
    usageContext?: LLMUsageContext,
  ): Promise<T> {
    const callOnce = async (system: string): Promise<{ raw: string }> => {
      const messages = [
        new SystemMessage(system),
        new HumanMessage(userPrompt),
      ];
      const response = await this.requireChatModel().invoke(messages) as any;
      const rawResponse = typeof response.content === 'string'
        ? response.content
        : String(response.content || '');
      const usage = this.extractUsage(response);
      this.meterUsage(usage, usageContext);
      if (onUsage) {
        onUsage(usage);
      }
      return { raw: rawResponse };
    };

    let firstRaw = '';
    try {
      const { raw } = await callOnce(systemPrompt);
      firstRaw = raw;
      return extractJson<T>(raw);
    } catch (err) {
      if (!(err instanceof JsonExtractError)) {
        // Non-parse failure (network, auth, etc) — bubble up untouched.
        throw err;
      }
      // First attempt produced unparseable output — retry once with strict suffix.
      console.warn(
        '[LLMService] generateJsonRobust: first extraction failed, retrying with strict prompt',
        { firstSnippet: err.rawSnippet.slice(0, 120) },
      );
    }

    // Retry path — append the strict suffix and try again.
    try {
      const { raw } = await callOnce(systemPrompt + STRICT_JSON_SUFFIX);
      return extractJson<T>(raw);
    } catch (err) {
      if (err instanceof JsonExtractError) {
        // Surface the retry's raw snippet — that's the more recent / relevant breadcrumb.
        throw err;
      }
      // Non-parse error on retry — wrap with a JsonExtractError carrying the first raw text
      // so the caller's failure persistence path still has something useful.
      throw new JsonExtractError(
        `LLM call failed during strict-retry: ${(err as Error).message}`,
        firstRaw,
      );
    }
  }

  /**
   * Invoke the model and return the raw string response without any parsing.
   * Use this when you need to extract custom XML tags from the response.
   */
  async generateRaw(
    systemPrompt: string,
    userPrompt: string,
    onUsage?: OnUsageCallback,
    usageContext?: LLMUsageContext,
  ): Promise<string> {
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];
    const response = await this.requireChatModel().invoke(messages) as any;
    const usage = this.extractUsage(response);
    this.meterUsage(usage, usageContext);
    if (onUsage) {
      onUsage(usage);
    }
    return typeof response.content === 'string' ? response.content : String(response.content || '');
  }

  /**
   * Generate HTML content with required output format
   * @param systemPrompt System prompt for HTML generation
   * @param userPrompt User prompt with HTML requirements
   * @param onUsage Optional callback invoked with token usage after the LLM call
   * @returns The generated HTML content as a string
   */
  async generateHTML(
    systemPrompt: string,
    userPrompt: string,
    onUsage?: OnUsageCallback,
    usageContext?: LLMUsageContext
  ): Promise<string> {
    try {
      const htmlSystemPrompt = `${systemPrompt}

CRITICAL: You MUST wrap your HTML output in the following XML tags:
<actual_html_content>
[Your complete HTML code here]
</actual_html_content>

The HTML must be a complete, well-formed HTML document with proper DOCTYPE, head, and body sections.`;

      // Use direct message objects to avoid LangChain template parsing
      // This prevents issues with curly braces in CSS, JavaScript, and template variables
      const messages = [
        new SystemMessage(htmlSystemPrompt),
        new HumanMessage(userPrompt),
      ];

      const response = await this.requireChatModel().invoke(messages) as any;
      const rawResponse = typeof response.content === 'string' ? response.content : String(response.content || '');

      const usage = this.extractUsage(response);
      this.meterUsage(usage, usageContext);
      if (onUsage) {
        onUsage(usage);
      }

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

  /**
   * Generate structured JSON using a web-search-capable model.
   * - Gemini models: Google Search grounding tool
   * - Azure/OpenAI models: web_search_preview tool via Responses API
   * Prompt should instruct the model to use provided context first, then web
   * search if needed, then its own knowledge, and return null for unknowns.
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
      const genai = new GoogleGenAI({ apiKey: apiKey.trim() });
      const response = await genai.models.generateContent({
        model: this.modelName,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ googleSearch: {} }],
        },
      });
      const usageMeta = (response as any)?.usageMetadata;
      const geminiIn = usageMeta?.promptTokenCount || 0;
      const geminiOut = usageMeta?.candidatesTokenCount || 0;
      this.meterUsage({
        inputTokens: geminiIn,
        outputTokens: geminiOut,
        totalTokens: usageMeta?.totalTokenCount || (geminiIn + geminiOut),
        model: this.modelName,
        cacheReadTokens: usageMeta?.cachedContentTokenCount || 0,
      }, usageContext);
      const text = response.text ?? '';
      return extractJson<T>(text);
    }

    // Azure OpenAI — Responses API with web_search tool. Called via raw HTTP
    // because the top-level `openai` SDK in this repo (v4.x) predates the
    // Responses endpoint, and @langchain/openai v1.x no longer exposes its
    // bundled v6 client through a stable surface (`chatModel.client` is gone).
    // The Responses API requires api-version 2025-03-01-preview or later.
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!apiKey || !endpoint) {
      throw new Error('AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT must be set');
    }
    const apiVersion = process.env.AZURE_OPENAI_RESPONSES_API_VERSION || '2025-03-01-preview';
    const url = `${endpoint.replace(/\/$/, '')}/openai/responses?api-version=${apiVersion}`;
    const reqBody = JSON.stringify({
      model: this.modelName,
      instructions: systemPrompt,
      input: userPrompt,
      tools: [{ type: 'web_search' }],
    });
    const debug = process.env.LLM_WEB_SEARCH_DEBUG === '1';
    const reqStart = Date.now();
    if (debug) {
      console.log('[llm.webSearch] → POST', url);
      console.log('[llm.webSearch] → headers: api-key=[redacted], Content-Type=application/json');
      console.log('[llm.webSearch] → body:', reqBody.slice(0, 500));
    }
    const httpResp = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: reqBody,
    });
    if (debug) {
      console.log(`[llm.webSearch] ← status=${httpResp.status} in ${Date.now() - reqStart}ms`);
    }
    if (!httpResp.ok) {
      const errBody = await httpResp.text().catch(() => '');
      throw new Error(`Azure Responses API ${httpResp.status}: ${errBody.slice(0, 300)}`);
    }
    const rawBody = await httpResp.text();
    if (debug) {
      console.log('[llm.webSearch] ← body:', rawBody.slice(0, 800));
    }
    const resp = JSON.parse(rawBody) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
    const respIn = resp.usage?.input_tokens || 0;
    const respOut = resp.usage?.output_tokens || 0;
    this.meterUsage({
      inputTokens: respIn,
      outputTokens: respOut,
      totalTokens: resp.usage?.total_tokens || (respIn + respOut),
      model: this.modelName,
    }, usageContext);
    // Newer responses include `output_text`; older shape returns an `output`
    // array of items where each item's `content[*].text` carries the chunks.
    let text = resp.output_text ?? '';
    if (!text && Array.isArray(resp.output)) {
      text = resp.output.flatMap(item => item.content ?? [])
        .map(c => c?.text ?? '')
        .filter(Boolean)
        .join('');
    }
    return extractJson<T>(text);
  }
}

/**
 * Helper function to create an LLM service instance with default settings
 */
export function createLLMService(
  modelName?: string,
  temperature: number | null = 0.8,
  maxTokens?: number
): LLMService {
  return new LLMService(modelName, temperature, maxTokens);
}
