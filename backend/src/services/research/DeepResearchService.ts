
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { getSecret } from '../../utils/secretsManager';
import { uploadFileToS3 } from '../../utils/s3Utils';
import { ToolService } from '../../tools/ServiceRegistry';
import { deepResearchService as legacyDeepResearchService } from '../deepResearchService';

/**
 * Deep Research Service
 * Handles Deep Research and Data Analysis tools
 */
export class DeepResearchService implements ToolService {
  readonly serviceName = 'deep_research';

  /**
   * Perform deep research on a topic and upload to S3
   */
  async performDeepResearchTool(
    topic: string,
    prompt?: string,
    tone: string = 'professional',
    depth: string = 'detailed',
    focus_areas?: string[],
    userId?: string
  ): Promise<any> {
    try {
      console.log('DeepResearchService: Performing deep research on topic:', topic, 'tone:', tone, 'depth:', depth);

      // Check availability
      const isAvailable = await legacyDeepResearchService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Deep Research service is not available. Please check API key configuration.',
          error: 'Service unavailable'
        };
      }

      // Perform research
      const researchResult = await legacyDeepResearchService.performDeepResearch({
        topic,
        prompt,
        tone,
        depth,
        focus_areas: focus_areas || [] // Ensure array
      });

      if (!researchResult.success || !researchResult.markdownContent) {
        return {
          success: false,
          message: researchResult.error || 'Deep research failed',
          error: researchResult.error || 'Unknown error'
        };
      }

      // Calculate word count
      const wordCount = researchResult.markdownContent.split(/\s+/).length;

      // Upload to S3
      const sanitizedTopic = topic.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().substring(0, 50);
      const filename = `research-${sanitizedTopic}-${Date.now()}.md`;

      const uploadResult = await uploadFileToS3(
        researchResult.markdownContent,
        filename,
        userId || 'anonymous',
        'text/markdown'
      );

      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          message: 'Failed to upload research content to S3',
          error: 'S3 upload failed'
        };
      }

      console.log('DeepResearchService: Deep research uploaded to S3:', uploadResult.url);

      return {
        success: true,
        message: `Deep research completed successfully. Generated ${wordCount} words of content and saved to S3.`,
        data: {
          research_url: uploadResult.url,
          title: researchResult.title,
          summary: researchResult.researchSummary,
          word_count: wordCount,
          research_depth: depth,
          topic: topic
        }
      };
    } catch (error: any) {
      console.error('DeepResearchService: Error performing deep research:', error);
      return {
        success: false,
        message: 'Failed to perform deep research',
        error: error.message
      };
    }
  }

  /**
   * Perform data analysis on files
   */
  async performDataAnalysis(
    fileUrls: string[], 
    analysisInstruction: string, 
    userId: string
  ): Promise<any> {
    try {
      const urlsToProcess = Array.isArray(fileUrls) ? fileUrls.filter(url => !!url) : [];

      if (!analysisInstruction) {
        return {
          success: false,
          message: 'Analysis instruction is required'
        };
      }

      // Get Gemini API key
      const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
      const geminiSecretName = environment === 'prod'
        ? 'prod/AgentWeb/GeminiAPIKey'
        : 'dev/AgentWeb/GeminiAPIKey';
        
      let geminiApiKey: string | undefined;
      try {
        geminiApiKey = await getSecret(geminiSecretName);
      } catch (error) {
        console.error('DeepResearchService: Failed to retrieve Gemini API key:', error);
        return {
          success: false,
          message: 'Failed to retrieve Gemini API key'
        };
      }

      if (!geminiApiKey || !geminiApiKey.trim()) {
        return {
          success: false,
          message: 'Gemini API key is empty'
        };
      }

      // Initialize Gemini
      const genAI = new GoogleGenerativeAI(geminiApiKey.trim());
      const modelName = process.env.DATA_ANALYSIS_LLM_NAME || 'gemini-1.5-pro'; // Default to pro for analysis
      const maxTotalSize = parseInt(process.env.DATA_ANALYSIS_FILE_SIZE || '52428800'); // 50MB

      // Prepare files
      const fileParts: any[] = [];
      let totalSize = 0;

      for (const fileUrl of urlsToProcess) {
        try {
          // Download file
          const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
          });

          const fileData = response.data as Buffer; // axios returns Buffer in node
          totalSize += fileData.byteLength;

          if (totalSize > maxTotalSize) {
            console.warn(`DeepResearchService: Total file size exceeds limit (${totalSize} > ${maxTotalSize}). Stopping file processing.`);
            break;
          }

          const contentType = response.headers['content-type'] || 'application/octet-stream';
          
          // Convert to base64 for Gemini
          const base64Data = Buffer.from(fileData).toString('base64');
          
          fileParts.push({
            inlineData: {
              data: base64Data,
              mimeType: contentType
            }
          });
        } catch (err: any) {
          console.error(`DeepResearchService: Error processing file ${fileUrl}:`, err);
          // Continue with other files
        }
      }

      if (fileParts.length === 0) {
        return {
          success: false,
          message: 'No files could be processed for analysis'
        };
      }

      const model = genAI.getGenerativeModel({ model: modelName });
      
      const prompt = `
        Perform a detailed data analysis on the attached files based on the following instruction:
        "${analysisInstruction}"
        
        Provide a comprehensive report including:
        1. Executive Summary
        2. Key Findings & Insights
        3. Detailed Analysis
        4. Recommendations (if applicable)
        
        Format the output as Markdown.
      `;

      console.log(`DeepResearchService: Sending analysis request to ${modelName} with ${fileParts.length} files`);
      const result = await model.generateContent([prompt, ...fileParts]);
      const response = await result.response;
      const text = response.text();

      // Upload report to S3
      const filename = `analysis-${Date.now()}.md`;
      const uploadResult = await uploadFileToS3(
        text,
        filename,
        userId,
        'text/markdown'
      );

      return {
        success: true,
        message: 'Data analysis completed successfully',
        analysis_report: text,
        report_url: uploadResult.url
      };

    } catch (error: any) {
      console.error('DeepResearchService: Error performing data analysis:', error);
      return {
        success: false,
        message: 'Failed to perform data analysis',
        error: error.message
      };
    }
  }
}

// Singleton instance
export const deepResearchService = new DeepResearchService();
