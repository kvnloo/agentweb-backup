import { getSecret } from "../utils/secretsManager";

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
  userId: string;
  rawMarkdownOnly?: boolean;  // Always true in current usage
  tone?: string;              // e.g., 'professional', 'casual', 'technical', 'executive'
  style?: string;             // e.g., 'default', 'substack'
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
      const { GoogleGenAI } = require('@google/genai');
      
      const apiKey = await this.getGeminiApiKey();
      const ai = new GoogleGenAI({ apiKey });

      // Build the research prompt with tone/style steerability
      // See: https://ai.google.dev/gemini-api/docs/deep-research#steerability_and_formatting
      let researchInput = params.topic;
      
      // Add formatting instructions based on tone and style
      const formatInstructions: string[] = [];
      
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
      
      // Add format instructions to prompt
      if (formatInstructions.length > 0) {
        researchInput += `\n\nFormat and Style Instructions:\n${formatInstructions.map(i => `- ${i}`).join('\n')}`;
      }
      
      // Add additional custom instructions if provided
      if (params.prompt) {
        researchInput += `\n\nAdditional instructions: ${params.prompt}`;
      }

      console.log(`Deep Research Prompt: ${researchInput}`);
      
      // Start the Deep Research Agent with background=true for async execution
      const initialInteraction = await ai.interactions.create({
        input: researchInput,
        agent: 'deep-research-pro-preview-12-2025',
        background: true,
      });

      console.log(`Deep research started. Interaction ID: ${initialInteraction.id}`);

      // Poll for results
      const maxPollAttempts = 120; // 20 minutes max (120 * 10 seconds)
      let pollAttempts = 0;
      let interaction = initialInteraction;

      while (interaction.status !== 'completed' && pollAttempts < maxPollAttempts) {
        console.log(`Deep research status: ${interaction.status} (attempt ${pollAttempts + 1}/${maxPollAttempts})`);
        
        // Wait 10 seconds before polling again
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Get updated interaction status
        interaction = await ai.interactions.get(initialInteraction.id);
        pollAttempts++;

        // Check for failure states
        if (interaction.status === 'failed' || interaction.status === 'cancelled') {
          console.error(`Deep research ${interaction.status}`);
          return {
            success: false,
            error: `Deep research ${interaction.status}. Please try again.`
          };
        }
      }

      if (interaction.status !== 'completed') {
        return {
          success: false,
          error: 'Deep research timed out after 20 minutes. Please try again with a more specific topic.'
        };
      }

      console.log('Deep research completed successfully');

      // Extract the research report from the interaction outputs
      const outputs = interaction.outputs || [];
      if (outputs.length === 0) {
        return {
          success: false,
          error: 'Deep research completed but no output was returned.'
        };
      }

      // Get the final text output (usually the last one)
      const finalOutput = outputs[outputs.length - 1];
      const researchText = finalOutput.text || '';

      if (!researchText) {
        return {
          success: false,
          error: 'Deep research completed but the research report is empty.'
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
