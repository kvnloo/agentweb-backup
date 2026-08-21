import { agentModeService } from './agentModeService';

const DEEP_RESEARCH_MODEL = 'openrouter/perplexity/sonar-deep-research';
const DEEP_RESEARCH_FALLBACK_MODEL = 'openrouter/perplexity/sonar-pro-search';
// Return our stable error contract before the ALB/Nginx 600-second request budget closes.
const DEEP_RESEARCH_TIMEOUT_MS = 9 * 60 * 1000;

interface DeepResearchResult {
  success: boolean;
  markdownContent?: string;
  title?: string;
  researchSummary?: string;
  error?: string;
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

  async performDeepResearch(params: DeepResearchParams): Promise<DeepResearchResult> {
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
          timeoutMs: DEEP_RESEARCH_TIMEOUT_MS,
          usageContext: { userId: params.userId, feature: 'content_gen' },
          taskClass: 'content_generation',
          fallbackModels: [DEEP_RESEARCH_FALLBACK_MODEL],
        },
      );

      const researchText = String(completion?.choices?.[0]?.message?.content || '').trim();
      if (!researchText) {
        return {
          success: false,
          error: 'Deep research completed but no report content was returned.',
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
        success: true,
        markdownContent: researchText,
        title,
        researchSummary,
      };
    } catch (error: any) {
      console.error('Deep research error:', error);
      return {
        success: false,
        error: `Deep research failed: ${error?.message || 'Unknown error'}`,
      };
    }
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
