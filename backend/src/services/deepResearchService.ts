import { agentModeService } from './agentModeService';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';

const DEEP_RESEARCH_MODEL = 'openrouter/perplexity/sonar-deep-research';
const DEEP_RESEARCH_FALLBACK_MODEL = 'openrouter/perplexity/sonar-pro-search';
// Return our stable error contract before the ALB/Nginx 600-second request budget closes.
const DEEP_RESEARCH_TIMEOUT_MS = 9 * 60 * 1000;
// ENG-738: a genuine timeout at DEEP_RESEARCH_TIMEOUT_MS used to surface as a bare
// failure with nothing to show for it. Reserve a slice of that same budget for ONE
// automatic retry at the next cheaper depth -- 'overview' asks for 800-1200 words
// instead of comprehensive's 4000+, so it has a real shot at finishing where the
// original depth didn't.
const DEGRADE_RETRY_TIMEOUT_MS = 2 * 60 * 1000;
const MIN_PRIMARY_TIMEOUT_MS = 60 * 1000;

// 'overview' is the floor -- once we're already there, there is nothing cheaper
// left to fall back to, so it (and an unset depth) has no entry here.
const DEPTH_DEGRADE: Record<string, string> = {
  comprehensive: 'detailed',
  detailed: 'overview',
};

interface DeepResearchResult {
  success: boolean;
  markdownContent?: string;
  title?: string;
  researchSummary?: string;
  error?: string;
  // Set only when the primary attempt timed out and the automatic retry at a
  // cheaper depth succeeded -- callers that report `research_depth` back to the
  // model/user should use `actualDepth`, not the originally requested depth.
  degradedFrom?: string;
  actualDepth?: string;
}

interface DeepResearchParams {
  topic: string;
  prompt?: string;
  tone?: string;
  style?: string;
  depth?: string;
  focus_areas?: string[];
  userId?: string;
}

/**
 * Deep research through the same OpenRouter boundary as every other text call.
 * Sonar Deep Research performs its own multi-step search and synthesis; AgentWeb
 * only owns product prompting and the stable result contract consumed by tools.
 */
export class DeepResearchService {
  private buildPrompt(params: DeepResearchParams): string {
    const instructions = [
      'Cite the source of every quoted number, statistic, or data point inline, immediately next to the claim it supports.',
    ];

    if (params.tone) {
      const tones: Record<string, string> = {
        professional: 'professional and authoritative, suitable for business audiences',
        casual: 'conversational and approachable',
        technical: 'technical and detailed, suitable for developers and engineers',
        executive: 'concise and strategic, suitable for C-suite executives',
      };
      instructions.push(`Write in a ${tones[params.tone] || params.tone} tone.`);
    }

    if (params.style === 'substack') {
      instructions.push(
        'Use a newsletter-style format with personal observations and conversational section headers.',
        'Write in first person where appropriate.',
      );
    }

    const depthInstructions: Record<string, string> = {
      overview: 'Provide a concise 800-1200 word overview covering the main points.',
      detailed: 'Generate at least 2000 words with substantive examples, analysis, and multiple detailed sections.',
      comprehensive: 'Generate at least 4000 words as a publication-ready deep dive with citations, analysis, and case studies. Each major section should be 500-800 words.',
    };
    if (params.depth) instructions.push(depthInstructions[params.depth] || params.depth);
    if (params.focus_areas?.length) {
      instructions.push(`Focus specifically on: ${params.focus_areas.join(', ')}.`);
    }
    if (params.prompt) instructions.push(`Additional instructions: ${params.prompt}`);

    return `${params.topic}\n\nFormat and Style Instructions:\n${instructions.map((item) => `- ${item}`).join('\n')}`;
  }

  private async attempt(
    params: DeepResearchParams,
    timeoutMs: number,
  ): Promise<{ result: DeepResearchResult; timedOut: boolean }> {
    try {
      const completion = await agentModeService.callLLM(
        DEEP_RESEARCH_MODEL,
        [{ role: 'user', content: this.buildPrompt(params) }],
        {
          max_completion_tokens: params.depth === 'comprehensive'
            ? 8_000
            : params.depth === 'detailed'
              ? 7_000
              : 5_000,
          temperature: 0.2,
          timeoutMs,
          usageContext: { userId: params.userId, feature: 'content_gen' },
          taskClass: 'content_generation',
          fallbackModels: [DEEP_RESEARCH_FALLBACK_MODEL],
        },
      );

      const researchText = String(completion?.choices?.[0]?.message?.content || '').trim();
      if (!researchText) {
        return {
          result: {
            success: false,
            error: 'Deep research completed but no report content was returned.',
          },
          timedOut: false,
        };
      }

      const titleMatch = researchText.match(/^#\s+(.+)$/m);
      const title = titleMatch?.[1]?.trim()
        || researchText.split('\n')[0].replace(/^#+\s*/, '').trim()
        || params.topic;
      const cleanText = researchText.replace(/[#*\-]/g, '').trim();
      const researchSummary = cleanText.length > 500
        ? `${cleanText.slice(0, 500)}...`
        : cleanText;

      return {
        result: {
          success: true,
          markdownContent: researchText,
          title,
          researchSummary,
        },
        timedOut: false,
      };
    } catch (error: any) {
      console.error('Deep research error:', error);
      return {
        result: {
          success: false,
          error: `Deep research failed: ${error?.message || 'Unknown error'}`,
        },
        timedOut: classifyToolErrorClass(error) === 'timeout',
      };
    }
  }

  async performDeepResearch(params: DeepResearchParams): Promise<DeepResearchResult> {
    const degradedDepth = params.depth ? DEPTH_DEGRADE[params.depth] : undefined;
    const primaryTimeoutMs = degradedDepth
      ? Math.max(MIN_PRIMARY_TIMEOUT_MS, DEEP_RESEARCH_TIMEOUT_MS - DEGRADE_RETRY_TIMEOUT_MS)
      : DEEP_RESEARCH_TIMEOUT_MS;

    const primary = await this.attempt(params, primaryTimeoutMs);
    if (primary.result.success || !degradedDepth || !primary.timedOut) {
      return primary.result;
    }

    console.warn(
      `Deep research: primary attempt at depth "${params.depth}" timed out after ${primaryTimeoutMs}ms, retrying once at "${degradedDepth}"`,
    );
    const retry = await this.attempt({ ...params, depth: degradedDepth }, DEGRADE_RETRY_TIMEOUT_MS);
    if (retry.result.success) {
      return { ...retry.result, degradedFrom: params.depth, actualDepth: degradedDepth };
    }
    // Report the original attempt's failure -- it reflects what the caller
    // actually asked for; the retry was our own internal fallback.
    return primary.result;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await agentModeService.getOpenRouterClient();
      return true;
    } catch (error) {
      console.warn('Deep Research service not available:', error);
      return false;
    }
  }
}

export const deepResearchService = new DeepResearchService();
