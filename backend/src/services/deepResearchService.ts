import { getSecret } from "../utils/secretsManager";
import { DEEP_RESEARCH_AGENT_SPEED, DEEP_RESEARCH_AGENT_MAX } from '../config';
import { getGeminiClient, normalizeGeminiUsage } from '../utils/llmClients';
import { meterUserUsage } from './usageRecorderService';

/**
 * Result from deep research operation
 */
interface DeepResearchResult {
  success: boolean;
  markdownContent?: string;  // Raw markdown for blog integration
  title?: string;            // Extracted title for blog
  researchSummary?: string;
  error?: string;
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

      // Build the research prompt with tone/style steerability
      // See: https://ai.google.dev/gemini-api/docs/deep-research#steerability_and_formatting
      let researchInput = params.topic;
      
      // Add formatting instructions based on tone and style
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
      if (params.depth) {
        const depthDescriptions: Record<string, string> = {
          'overview': 'Provide a high-level summary with key points only (approximately 800-1200 words, 1-2 pages). Be concise but cover the main points.',
          'detailed': 'Provide comprehensive research with examples, analysis, and supporting details (approximately 2000-3500 words, 3-5 pages). Include multiple sections with depth on each topic.',
          'comprehensive': 'Provide an in-depth deep dive with citations, detailed analysis, case studies, and thorough coverage (approximately 4000-6000 words, 5-10 pages). This should be a complete, publication-ready document with extensive detail in each section.',
        };
        const depthDesc = depthDescriptions[params.depth] || params.depth;
        formatInstructions.push(depthDesc);
        
        // Add explicit word count guidance
        if (params.depth === 'comprehensive') {
          formatInstructions.push('IMPORTANT: Generate at least 4000 words of content. Do NOT summarize or abbreviate sections. Each major section should be 500-800 words minimum.');
        } else if (params.depth === 'detailed') {
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

      console.log(`Deep Research Prompt: ${researchInput}`);

      // Select the agent tier by requested depth: the most thorough requests use
      // the "max" agent for maximum comprehensiveness; everything else uses the
      // faster "speed" agent.
      const agent = params.depth === 'comprehensive'
        ? DEEP_RESEARCH_AGENT_MAX
        : DEEP_RESEARCH_AGENT_SPEED;
      console.log(`Deep Research agent: ${agent} (depth: ${params.depth || 'default'})`);

      // Start the Deep Research Agent with background=true for async execution
      const initialInteraction = await ai.interactions.create({
        input: researchInput,
        agent,
        background: true,
      });

      console.log(`Deep research started. Interaction ID: ${initialInteraction.id}`);

      // Poll for results
      const maxPollAttempts = 120; // 20 minutes max (120 * 10 seconds)
      let pollAttempts = 0;
      let interaction = initialInteraction;

      while (pollAttempts < maxPollAttempts) {
        // Check if already completed before waiting
        if (interaction.status === 'completed') {
          break;
        }

        // Check for failure states
        if (interaction.status === 'failed' || interaction.status === 'cancelled') {
          console.error(`Deep research ${interaction.status}`);
          return {
            success: false,
            error: `Deep research ${interaction.status}. Please try again.`
          };
        }

        console.log(`Deep research status: ${interaction.status || 'unknown'} (attempt ${pollAttempts + 1}/${maxPollAttempts})`);
        
        // Wait 10 seconds before polling again
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Get updated interaction status with error handling
        try {
          interaction = await ai.interactions.get(initialInteraction.id);
          
          // Validate interaction object
          if (!interaction || typeof interaction.status !== 'string') {
            console.error('Invalid interaction response:', interaction);
            return {
              success: false,
              error: 'Deep research API returned invalid response. Please try again.'
            };
          }
        } catch (error: any) {
          console.error('Error getting interaction status:', error);
          // If we've tried many times, give up
          if (pollAttempts >= 10) {
            return {
              success: false,
              error: `Deep research API error after ${pollAttempts} attempts: ${error.message || 'Unknown error'}`
            };
          }
          // Otherwise, continue polling (might be a transient error)
          pollAttempts++;
          continue;
        }
        
        pollAttempts++;
      }

      // Check final status after loop exits
      if (pollAttempts >= maxPollAttempts && interaction.status !== 'completed') {
        console.error(`Deep research timed out after ${maxPollAttempts} attempts. Final status: ${interaction.status}`);
        return {
          success: false,
          error: 'Deep research timed out after 20 minutes. Please try again with a more specific topic.'
        };
      }

      if (interaction.status !== 'completed') {
        console.error(`Deep research ended with unexpected status: ${interaction.status}`);
        return {
          success: false,
          error: `Deep research ended with status: ${interaction.status}. Please try again.`
        };
      }

      console.log('Deep research completed successfully');

      // Shadow metering: the llmClients Gemini wrapper covers
      // models.generateContent / generateContentStream, NOT the interactions
      // API — so the completed interaction is recorded here directly.
      // Fire-and-forget + fully guarded: metering must never affect the
      // research result or add latency.
      try {
        const usage = normalizeGeminiUsage((interaction as any)?.usageMetadata);
        const hasUsage = usage.inputTokens > 0 || usage.outputTokens > 0;
        void meterUserUsage({
          userId: params.userId, // charge the caller's cap when supplied; else "system" (absorbed)
          model: agent,
          provider: 'gemini',
          feature: hasUsage ? 'content_gen' : 'content_gen:interactions-no-usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
        });
      } catch {
        // Metering must never break deep research.
      }

      // Extract the research report. The April 2026 Deep Research agents return
      // the report under `steps` (each model_output step holds a chunk of the
      // report, streamed across multiple steps), not the legacy `outputs` array.
      // The full report is the concatenation of every model_output text chunk in
      // order. We still fall back to `outputs` for backward compatibility.
      const researchText = extractReportText(interaction);

      if (!researchText) {
        return {
          success: false,
          error: 'Deep research completed but no report content was returned.'
        };
      }

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
        researchSummary: summary
      };

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
