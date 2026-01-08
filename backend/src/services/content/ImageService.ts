
import { llmClientFactory } from '../llm/LLMClientFactory';
import { ToolService } from '../../tools/ServiceRegistry';
import { chatbotDb } from '../chatbotService';

/**
 * Image generation options
 */
export interface ImageGenerationOptions {
  prompt: string;
  filename: string;
  size?: string;
  quality?: string;
  inputImages?: string[];
  userId: string;
  sessionId?: string;
  imageModel?: string;
}

/**
 * Image Service - handles AI image generation and analysis
 */
export class ImageService implements ToolService {
  readonly serviceName = 'image';

  /**
   * Describe an image using vision model
   */
  async describeImage(llmModel: string, imageUrl: string, prompt?: string): Promise<any> {
    try {
      if (!imageUrl) {
        return {
          success: false,
          message: 'No image URL provided'
        };
      }
      if (!llmModel) {
        llmModel = await llmClientFactory.getDefaultModel();
      }
      // Use custom prompt or default
      const analysisPrompt = prompt || 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.';

      // Create messages for vision API
      const messages = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: analysisPrompt
            },
            {
              type: 'image_url' as const,
              image_url: { url: imageUrl }
            }
          ]
        }
      ];

      // Call OpenAI Vision API using the same model as agent mode
      const response = await llmClientFactory.callLLM(llmModel, messages, {
        max_completion_tokens: 2000
      });

      const description = response.choices[0]?.message?.content || 'Unable to analyze image';

      return {
        success: true,
        description: description,
        imageUrl: imageUrl
      };

    } catch (error) {
      console.error('ImageService: Error describing image:', error);
      return {
        success: false,
        message: 'Failed to analyze image. Please check that the URL is accessible and contains a valid image.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate an image using AI
   */
  async generateImage(
    prompt: string,
    filename: string,
    size: string,
    quality: string,
    inputImages: string[],
    userId: string,
    sessionId: string,
    imageModel?: string
  ): Promise<any> {
    try {
      // Import the image generation service
      const { imageService } = await import('../imageGeneration');

      // Check if the service is available
      const isAvailable = await imageService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Image generation service is not available. Please check API key configuration in AWS Secrets Manager.',
          error: 'Service unavailable'
        };
      }

      // Generate the image
      const result = await imageService.generateImage({
        prompt,
        filename,
        size,
        quality,
        inputImages: inputImages || [],
        userId,
        imageModel
      });

      if (result.success && result.imageUrl) {
        // Save the image URL to the session for reference
        const imageData = {
          url: result.imageUrl,
          filename: result.filename,
          generatedAt: new Date().toISOString(),
          prompt: prompt,
          size: size,
          quality: quality
        };

        // Store image data in session metadata (optional)
        try {
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'system',
            content: `Image generated: ${result.filename}`,
            metadata: {
              timestamp: new Date().toISOString()
            }
          });
        } catch (error) {
          console.warn('Failed to store image generation metadata:', error);
        }

        return {
          success: true,
          message: `✅ Image "${result.filename}" generated successfully!`,
          imageUrl: result.imageUrl,
          filename: result.filename,
          prompt: prompt,
          size: size,
          quality: quality
        };
      } else {
        return {
          success: false,
          message: result.error || 'Failed to generate image',
          error: result.error
        };
      }

    } catch (error: any) {
      console.error('ImageService: Error generating image:', error);
      return {
        success: false,
        message: 'Failed to generate image',
        error: error.message
      };
    }
  }

  /**
   * Remove C2PA metadata from an image
   */
  async removeC2PAFromImage(imageUrl: string, filename?: string, userId?: string): Promise<any> {
    try {
      console.log('ImageService: Removing C2PA metadata from image:', imageUrl);

      if (!imageUrl) {
        return {
          success: false,
          message: 'Image URL is required',
          error: 'missing_image_url'
        };
      }

      // Import required services
      const axios = require('axios');
      const { uploadFileToS3 } = await import('../../utils/s3Utils');
      const { imageService } = await import('../imageGeneration');

      // Download the image
      let imageBuffer: Buffer;
      if (imageUrl.startsWith('data:image/')) {
        // Handle data URL
        const base64Data = imageUrl.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        // Download from URL
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
          }
        });
        imageBuffer = Buffer.from(response.data);
      }

      // Remove C2PA metadata using the imageService's method
      const cleanedBuffer = await imageService.removeC2PAMetadata(imageBuffer);

      // Generate filename if not provided
      let finalFilename = filename;
      if (!finalFilename) {
        // Extract filename from URL or generate one
        try {
          const urlObj = new URL(imageUrl);
          const pathParts = urlObj.pathname.split('/');
          const urlFilename = pathParts[pathParts.length - 1];
          if (urlFilename && urlFilename.includes('.')) {
            // Replace extension with .png
            const nameWithoutExt = urlFilename.substring(0, urlFilename.lastIndexOf('.'));
            finalFilename = `${nameWithoutExt}_no_c2pa.png`;
          } else {
            finalFilename = `image_no_c2pa_${Date.now()}.png`;
          }
        } catch {
          finalFilename = `image_no_c2pa_${Date.now()}.png`;
        }
      } else if (!finalFilename.endsWith('.png')) {
        // Ensure .png extension
        const nameWithoutExt = finalFilename.substring(0, finalFilename.lastIndexOf('.') || finalFilename.length);
        finalFilename = `${nameWithoutExt}.png`;
      }

      // Upload to S3
      if (!userId) {
        return {
          success: false,
          message: 'User ID is required for S3 upload',
          error: 'missing_user_id'
        };
      }

      const uploadResult = await uploadFileToS3(
        cleanedBuffer,
        finalFilename,
        userId,
        'image/png'
      );

      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          message: uploadResult.error || 'Failed to upload cleaned image to S3',
          error: uploadResult.error || 's3_upload_failed'
        };
      }

      return {
        success: true,
        message: `✅ C2PA metadata removed successfully! Image uploaded to S3.`,
        imageUrl: uploadResult.url,
        filename: finalFilename,
        originalUrl: imageUrl
      };

    } catch (error: any) {
      console.error('ImageService: Error removing C2PA metadata:', error);
      return {
        success: false,
        message: 'Failed to remove C2PA metadata from image',
        error: error.message
      };
    }
  }

  /**
   * Check if service is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { imageService } = await import('../imageGeneration');
      return imageService.isAvailable();
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const imageService = new ImageService();
