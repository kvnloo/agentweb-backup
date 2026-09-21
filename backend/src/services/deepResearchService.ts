import { getSecret } from "../utils/secretsManager";
import { DEEP_RESEARCH_AGENT_SPEED, DEEP_RESEARCH_AGENT_MAX } from '../config';
import { getGeminiClient, normalizeGeminiUsage } from '../utils/llmClients';
import { meterUserUsage } from './usageRecorderService';

const POLL_INTERVAL_MS = 10000; // 10 seconds between status polls

// ENG-738: agentModeController's GENERATION_TIMEOUT_MS wraps the ENTIRE
// agent-mode turn in a Promise.race and kills it — including any tool call
// still in flight — with no way for the killed call to return a result of its
// own. The prior fixed 20-minute poll budget here was LONGER than that outer
// cap's 10-minute default, so for any research that legitimately ran past
// ~10 minutes, the outer race always won: the whole turn died with a bare 504
// before this service's own graceful-failure branches ever got a chance to
// run, and the model never saw any tool result to react to.
//
// These budgets are derived from the SAME env var agentModeController reads
// (not a hardcoded guess) so they can never silently drift back out of sync
// with the outer cap if that value is ever reconfigured — a fixed constant
// here would become unsafe (too long again) the moment someone lowered
// AGENT_MODE_GENERATION_TIMEOUT_MS without knowing this file depends on it.
function getGenerationTimeoutMs(): number {
  const raw = parseInt(process.env.AGENT_MODE_GENERATION_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 600000; // matches agentModeController's own default
}

// Reserved off the top of the outer timeout for: the interactions.create()
// call, the S3 upload of the final (or partial) content, and — critically —
// the LLM turn that synthesizes the assistant's reply AFTER the tool result
// comes back, which still has to complete before the SAME outer deadline.
export const RESEARCH_TIME_BUFFER_MS = 3 * 60 * 1000;
// Fixed slice reserved for the one depth-degraded retry pass, whenever the
// requested depth actually has somewhere cheaper to fall back to.
export const RETRY_SHARE_MS = 2 * 60 * 1000;
const MIN_POLL_BUDGET_MS = 60000; // never poll for less than one useful minute

function usableResearchBudgetMs(): number {
  return Math.max(MIN_POLL_BUDGET_MS, getGenerationTimeoutMs() - RESEARCH_TIME_BUFFER_MS);
}

/**
 * Primary-attempt poll budget. When the requested depth CAN'T degrade further
 * (already 'overview', or no depth given — e.g. the createBlogArticle caller),
 * no retry will ever follow, so the primary attempt gets the full usable
 * budget instead of artificially giving up early to reserve time nothing will
 * use.
 */
export function getPollBudgetMs(canDegrade: boolean): number {
  const override = parseInt(process.env.DEEP_RESEARCH_POLL_BUDGET_MS || '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  const usable = usableResearchBudgetMs();
  return canDegrade ? Math.max(MIN_POLL_BUDGET_MS, usable - RETRY_SHARE_MS) : usable;
}

export function getRetryPollBudgetMs(): number {
  const override = parseInt(process.env.DEEP_RESEARCH_RETRY_POLL_BUDGET_MS || '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  // Cap at whatever the primary (degradable) attempt's budget actually left
  // behind — RETRY_SHARE_MS is a ceiling, not a guarantee. Without this cap,
  // a squeezed outer timeout (AGENT_MODE_GENERATION_TIMEOUT_MS lowered, or
  // getPollBudgetMs(true) hitting its MIN_POLL_BUDGET_MS floor) could let
  // primary + retry exceed the usable budget again — the exact class of bug
  // this file exists to prevent.
  const usable = usableResearchBudgetMs();
  const remaining = Math.max(MIN_POLL_BUDGET_MS, usable - getPollBudgetMs(true));
  return Math.min(RETRY_SHARE_MS, remaining);
}

// Depth ladder for the automatic degrade-on-timeout retry. 'overview' is the
// floor — once we're already there, there is nothing cheaper left to fall back to.
const DEPTH_DEGRADE: Record<string, string> = {
  comprehensive: 'detailed',
  detailed: 'overview',
};

type PollStatus = 'completed' | 'timeout' | 'failed' | 'invalid' | 'poll_error';

interface PollResult {
  interaction: any;
  status: PollStatus;
  error?: string;
}

interface ResearchAttempt {
  depth: string | undefined;
  agent: string;
  pollResult: PollResult;
  researchText: string;
}

/**
 * Result from deep research operation
 */
interface DeepResearchResult {
  success: boolean;
  markdownContent?: string;  // Raw markdown for blog integration
  title?: string;            // Extracted title for blog
  researchSummary?: string;
  error?: string;
  // ENG-738: set when the requested depth timed out and an automatic
  // depth-degraded retry succeeded instead (e.g. 'comprehensive' -> 'detailed').
  // actualDepth carries the depth the retry actually completed at.
  degradedFrom?: string;
  actualDepth?: string;
  // ENG-738: set only when a failure result still carries real, non-empty
  // partial content extracted from the interaction before it timed out —
  // never dressed up when there is genuinely nothing to show (see
  // extractReportText / the honesty convention this mirrors from ENG-510).
  partial?: boolean;
  partialContent?: string;
  partialDepth?: string;
}

/**
 * Parameters for deep research
 */
interface DeepResearchParams {
  topic: string;
  prompt?: string;
  tone?: string;              // e.g., 'professional', 'casual', 'technical', 'executive'
  style?: string;             // e.g., 'default', 'substack'
  depth?: string;             // e.g., 'overview', 'detailed', 'comprehensive'
  focus_areas?: string[];     // Specific areas to focus on
  userId?: string;            // caller's user id — for per-user burn attribution (not quota)
}

/**
 * Extract the full markdown report from a completed Deep Research interaction.
 *
 * The April 2026 agents (deep-research-preview-04-2026 /
 * deep-research-max-preview-04-2026) return the report under `steps`: the user
 * turn is a `user_input` step, and the report is emitted across one or more
 * `model_output` steps, each whose `content` array holds text chunks (and
 * optionally `image` chunks for charts). The complete report is the
 * concatenation of every model_output text chunk, in order.
 *
 * Older agents returned the report in a flat `outputs` array, so we fall back to
 * that shape when no `steps` are present.
 */
export function extractReportText(interaction: any): string {
  const steps = interaction?.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    const chunks: string[] = [];
    for (const step of steps) {
      if (step?.type !== 'model_output') continue;
      const content = Array.isArray(step.content) ? step.content : [];
      for (const item of content) {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text) {
          chunks.push(item.text);
        }
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n\n').trim();
    }
  }

  // Legacy fallback: flat outputs array, take the last text output.
  const outputs = interaction?.outputs;
  if (Array.isArray(outputs) && outputs.length > 0) {
    const finalOutput = outputs[outputs.length - 1];
    if (finalOutput && typeof finalOutput.text === 'string') {
      return finalOutput.text.trim();
    }
  }

  return '';
}

/**
 * Simplified Deep Research Service
 *
 * This service handles only the Gemini Deep Research API calls.
 * All content processing (restyling, image placeholders, HTML generation)
 * is handled by blog.ts.
 */
export class DeepResearchService {
  private geminiApiKey: string | null = null;
  private geminiApiKeyPromise: Promise<string> | null = null;

  constructor() {
    // API key will be lazy-loaded from secrets manager
  }

  /**
   * Get the Gemini API key from Secrets Manager (lazy-loaded)
   */
  private async getGeminiApiKey(): Promise<string> {
    // Return cached key if available
    if (this.geminiApiKey) {
      return this.geminiApiKey;
    }

    // If already loading, wait for that promise
    if (this.geminiApiKeyPromise) {
      return this.geminiApiKeyPromise;
    }

    // Load the API key
    this.geminiApiKeyPromise = (async () => {
      try {
        const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
        const secretName = `${environment}/AgentWeb/GeminiAPIKey`;
        const apiKey = await getSecret(secretName);

        if (!apiKey || !apiKey.trim()) {
          throw new Error('Gemini API key is empty');
        }

        this.geminiApiKey = apiKey.trim();
        return this.geminiApiKey;
      } catch (error) {
        console.error('Error getting Gemini API key:', error);
        this.geminiApiKeyPromise = null; // Reset promise on error
        throw error;
      }
    })();

    return this.geminiApiKeyPromise;
  }

  /**
   * Build the research prompt with tone/style/depth steerability.
   * See: https://ai.google.dev/gemini-api/docs/deep-research#steerability_and_formatting
   */
  private buildResearchInput(params: DeepResearchParams, depth?: string): string {
    let researchInput = params.topic;

    const formatInstructions: string[] = [];

    // ENG-351: cite the source of every quoted figure inline, next to the number it
    // supports — matching the Claude/Gemini inline-citation style — so readers can
    // trace each figure without scrolling to a separate references section.
    formatInstructions.push(
      'Cite the source of every quoted number, statistic, or data point INLINE — immediately next to the figure it supports (a linked source or a parenthetical attribution) — rather than collecting sources only in a separate references section at the end. Match the inline-citation style of Claude and Gemini outputs, where the source sits adjacent to the claim it backs.'
    );

    if (params.tone) {
      const toneDescriptions: Record<string, string> = {
        'professional': 'professional and authoritative, suitable for business audiences',
        'casual': 'conversational and approachable, like explaining to a friend',
        'technical': 'technical and detailed, suitable for developers and engineers',
        'executive': 'concise and strategic, suitable for C-suite executives',
      };
      const toneDesc = toneDescriptions[params.tone] || params.tone;
      formatInstructions.push(`Write in a ${toneDesc} tone.`);
    }

    if (params.style === 'substack') {
      formatInstructions.push(
        'Use a newsletter-style format with personal observations.',
        'Write in first-person perspective where appropriate.',
        'Include engaging section headers that feel conversational.'
      );
    }

    // Add depth instructions
    if (depth) {
      const depthDescriptions: Record<string, string> = {
        'overview': 'Provide a high-level summary with key points only (approximately 800-1200 words, 1-2 pages). Be concise but cover the main points.',
        'detailed': 'Provide comprehensive research with examples, analysis, and supporting details (approximately 2000-3500 words, 3-5 pages). Include multiple sections with depth on each topic.',
        'comprehensive': 'Provide an in-depth deep dive with citations, detailed analysis, case studies, and thorough coverage (approximately 4000-6000 words, 5-10 pages). This should be a complete, publication-ready document with extensive detail in each section.',
      };
      const depthDesc = depthDescriptions[depth] || depth;
      formatInstructions.push(depthDesc);

      // Add explicit word count guidance
      if (depth === 'comprehensive') {
        formatInstructions.push('IMPORTANT: Generate at least 4000 words of content. Do NOT summarize or abbreviate sections. Each major section should be 500-800 words minimum.');
      } else if (depth === 'detailed') {
        formatInstructions.push('IMPORTANT: Generate at least 2000 words of content. Each section should be substantive with examples and analysis.');
      }
    }

    // Add focus areas if specified
    if (params.focus_areas && params.focus_areas.length > 0) {
      formatInstructions.push(`Focus specifically on these areas: ${params.focus_areas.join(', ')}.`);
    }

    // Add format instructions to prompt
    if (formatInstructions.length > 0) {
      researchInput += `\n\nFormat and Style Instructions:\n${formatInstructions.map(i => `- ${i}`).join('\n')}`;
    }

    // Add additional custom instructions if provided
    if (params.prompt) {
      researchInput += `\n\nAdditional instructions: ${params.prompt}`;
    }

    return researchInput;
  }

  /**
   * Select the agent tier by requested depth: the most thorough requests use
   * the "max" agent for maximum comprehensiveness; everything else uses the
   * faster "speed" agent.
   */
  private selectAgent(depth?: string): string {
    return depth === 'comprehensive' ? DEEP_RESEARCH_AGENT_MAX : DEEP_RESEARCH_AGENT_SPEED;
  }

  /**
   * Poll a started interaction until it completes, fails, or exceeds budgetMs.
   * Bounded by a caller-supplied time budget rather than a fixed attempt count
   * so a primary attempt and a depth-degraded retry can each get their own
   * slice of the outer generation-timeout wall clock (see the budget constants
   * above this class).
   */
  private async pollUntilComplete(ai: any, initialInteraction: any, budgetMs: number): Promise<PollResult> {
    const maxPollAttempts = Math.max(1, Math.floor(budgetMs / POLL_INTERVAL_MS));
    let pollAttempts = 0;
    let interaction = initialInteraction;

    while (pollAttempts < maxPollAttempts) {
      if (interaction.status === 'completed') {
        return { interaction, status: 'completed' };
      }

      if (interaction.status === 'failed' || interaction.status === 'cancelled') {
        console.error(`Deep research ${interaction.status}`);
        return {
          interaction,
          status: 'failed',
          error: `Deep research ${interaction.status}. Please try again.`,
        };
      }

      console.log(`Deep research status: ${interaction.status || 'unknown'} (attempt ${pollAttempts + 1}/${maxPollAttempts})`);

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      try {
        interaction = await ai.interactions.get(initialInteraction.id);

        if (!interaction || typeof interaction.status !== 'string') {
          console.error('Invalid interaction response:', interaction);
          return {
            interaction,
            status: 'invalid',
            error: 'Deep research API returned invalid response. Please try again.',
          };
        }
      } catch (error: any) {
        console.error('Error getting interaction status:', error);
        if (pollAttempts >= 10) {
          return {
            interaction,
            status: 'poll_error',
            error: `Deep research API error after ${pollAttempts} attempts: ${error.message || 'Unknown error'}`,
          };
        }
        pollAttempts++;
        continue;
      }

      pollAttempts++;
    }

    if (interaction.status === 'completed') {
      return { interaction, status: 'completed' };
    }

    console.error(`Deep research timed out after ${maxPollAttempts} attempts. Final status: ${interaction.status}`);
    return {
      interaction,
      status: 'timeout',
      error: 'Deep research timed out. Please try again with a more specific topic.',
    };
  }

  /**
   * Best-effort cancel of a background interaction we're no longer reading
   * from (ENG-738). A 'timeout'/'invalid'/'poll_error' interaction was
   * started with background: true and keeps running — and being billed —
   * server-side on Gemini's end even after we stop polling it; a 'completed'
   * or 'failed' interaction is already terminal and has nothing left to
   * cancel. Fire-and-forget and fully guarded, matching the metering guard in
   * performDeepResearch: cleanup must never delay or break the research
   * result itself.
   */
  private abandonInteraction(ai: any, pollResult: PollResult): void {
    const id = pollResult?.interaction?.id;
    if (!id || pollResult.status === 'completed' || pollResult.status === 'failed') {
      return;
    }
    try {
      void Promise.resolve(ai.interactions.cancel(id)).catch((error: any) => {
        console.warn(`Deep research: failed to cancel abandoned interaction ${id}:`, error?.message || error);
      });
    } catch (error: any) {
      console.warn(`Deep research: failed to cancel abandoned interaction ${id}:`, error?.message || error);
    }
  }

  /** Start one interaction at the given depth and poll it to completion or budget exhaustion. */
  private async runResearchAttempt(
    ai: any,
    params: DeepResearchParams,
    depth: string | undefined,
    budgetMs: number,
  ): Promise<ResearchAttempt> {
    const researchInput = this.buildResearchInput(params, depth);
    const agent = this.selectAgent(depth);
    console.log(`Deep Research Prompt: ${researchInput}`);
    console.log(`Deep Research agent: ${agent} (depth: ${depth || 'default'})`);

    // Start the Deep Research Agent with background=true for async execution
    const initialInteraction = await ai.interactions.create({
      input: researchInput,
      agent,
      background: true,
    });
    console.log(`Deep research started. Interaction ID: ${initialInteraction.id}`);

    const pollResult = await this.pollUntilComplete(ai, initialInteraction, budgetMs);
    // Extract whatever report text exists in the last-seen interaction snapshot,
    // even when it never reached 'completed' — the April 2026 Deep Research
    // agents stream the report across `steps` as they go, so a timed-out
    // interaction can still carry real, usable partial content.
    const researchText = extractReportText(pollResult.interaction);

    return { depth, agent, pollResult, researchText };
  }

  /**
   * Perform deep research on a topic using Gemini Deep Research Agent
   * Returns raw markdown content for further processing by blog.ts
   */
  async performDeepResearch(params: DeepResearchParams): Promise<DeepResearchResult> {
    try {
      const apiKey = await this.getGeminiApiKey();
      // Metered factory client (shadow metering). Usage is attributed to
      // params.userId when the caller supplies it (per-user burn, not quota) and
      // falls back to 'system' otherwise.
      const ai = await getGeminiClient({ userId: params.userId, feature: 'content_gen' }, apiKey);

      const requestedDepth = params.depth;
      const degradedDepth = requestedDepth ? DEPTH_DEGRADE[requestedDepth] : undefined;
      const canDegrade = Boolean(degradedDepth);
      const primaryAttempt = await this.runResearchAttempt(ai, params, requestedDepth, getPollBudgetMs(canDegrade));

      let finalAttempt = primaryAttempt;
      let retryAttempt: ResearchAttempt | undefined;
      let degradedFrom: string | undefined;
      let actualDepth: string | undefined;

      // ENG-738: on a TIMEOUT (not an explicit failure/cancellation — reduced
      // depth won't fix a policy rejection or a cancelled run) at a depth that
      // still has a cheaper tier available, retry once automatically instead of
      // returning a bare failure. This also doubles as the retry-loop guard: the
      // degrade-and-retry happens inside this one tool call, so the model never
      // needs to (and is told not to, see performDeepResearchTool) re-issue the
      // identical failing call itself.
      if (primaryAttempt.pollResult.status === 'timeout' && degradedDepth) {
        console.warn(
          `Deep research at depth "${requestedDepth}" timed out; retrying once at reduced depth "${degradedDepth}".`
        );
        retryAttempt = await this.runResearchAttempt(ai, params, degradedDepth, getRetryPollBudgetMs());
        if (
          retryAttempt.pollResult.status === 'completed' ||
          retryAttempt.researchText.length > primaryAttempt.researchText.length
        ) {
          finalAttempt = retryAttempt;
          degradedFrom = requestedDepth;
          actualDepth = degradedDepth;
        }
      }

      // Both the primary and retry interactions run in the background
      // (background: true) — whichever one we did NOT keep is still running
      // server-side with nothing left to read it. Free it up rather than pay
      // for an abandoned run. Best-effort: never lets cleanup delay or break
      // the actual research result.
      if (retryAttempt) {
        const loserAttempt = finalAttempt === retryAttempt ? primaryAttempt : retryAttempt;
        this.abandonInteraction(ai, loserAttempt.pollResult);
      }

      if (finalAttempt.pollResult.status === 'completed' && finalAttempt.researchText) {
        console.log('Deep research completed successfully');

        // Shadow metering: the llmClients Gemini wrapper covers
        // models.generateContent / generateContentStream, NOT the interactions
        // API — so the completed interaction is recorded here directly.
        // Fire-and-forget + fully guarded: metering must never affect the
        // research result or add latency.
        try {
          const usage = normalizeGeminiUsage((finalAttempt.pollResult.interaction as any)?.usageMetadata);
          const hasUsage = usage.inputTokens > 0 || usage.outputTokens > 0;
          void meterUserUsage({
            userId: params.userId, // charge the caller's cap when supplied; else "system" (absorbed)
            model: finalAttempt.agent,
            provider: 'gemini',
            feature: hasUsage ? 'content_gen' : 'content_gen:interactions-no-usage',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
          });
        } catch {
          // Metering must never break deep research.
        }

        const researchText = finalAttempt.researchText;

        // Extract title from first H1 or first line
        const titleMatch = researchText.match(/^#\s+(.+)$/m);
        const title = titleMatch
          ? titleMatch[1].trim()
          : researchText.split('\n')[0].replace(/^#+\s*/, '').trim() || params.topic;

        // Create summary from first 500 chars
        const cleanText = researchText.replace(/[#*\-]/g, '').trim();
        const summary = cleanText.length > 500
          ? cleanText.substring(0, 500) + '...'
          : cleanText;

        return {
          success: true,
          markdownContent: researchText,
          title,
          researchSummary: summary,
          ...(degradedFrom ? { degradedFrom, actualDepth } : {}),
        };
      }

      if (finalAttempt.pollResult.status === 'completed' && !finalAttempt.researchText) {
        return {
          success: false,
          error: 'Deep research completed but no report content was returned.',
        };
      }

      // Not completed and we're giving up on it — nothing will poll it again.
      this.abandonInteraction(ai, finalAttempt.pollResult);

      // An honest failure. Only claim partial progress when real, non-empty
      // content was actually gathered (mirrors the ENG-510 "genuinely empty
      // must not be dressed up as a partial success" rule).
      const errorMessage = finalAttempt.pollResult.error
        || `Deep research ended with status: ${finalAttempt.pollResult.interaction?.status}. Please try again.`;

      if (finalAttempt.researchText) {
        return {
          success: false,
          error: errorMessage,
          partial: true,
          partialContent: finalAttempt.researchText,
          partialDepth: finalAttempt.depth,
          ...(degradedFrom ? { degradedFrom } : {}),
        };
      }

      return { success: false, error: errorMessage };
    } catch (error: any) {
      console.error('Deep research error:', error);
      
      // Handle specific errors
      if (error.message?.includes('interactions')) {
        return {
          success: false,
          error: 'The Gemini Deep Research API is not available. Please ensure you have access to the preview feature.'
        };
      }

      return {
        success: false,
        error: `Deep research failed: ${error.message || 'Unknown error'}`
      };
    }
  }

  /**
   * Check if the Deep Research service is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.getGeminiApiKey();
      return true;
    } catch (error) {
      console.warn('Deep Research service not available:', error);
      return false;
    }
  }
}

// Create a singleton instance
let deepResearchService: DeepResearchService;

try {
  deepResearchService = new DeepResearchService();
  console.log('✅ Deep Research Service initialized successfully');
} catch (error) {
  console.warn('⚠️ Failed to initialize Deep Research Service, creating fallback service');
  
  // Create a fallback service that always returns false for isAvailable
  deepResearchService = {
    isAvailable: async () => false,
    performDeepResearch: async () => ({ success: false, error: 'Service not available' })
  } as any;
}

export { deepResearchService };
