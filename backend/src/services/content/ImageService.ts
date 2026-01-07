
import { llmClientFactory } from '../llm/LLMClientFactory';
import { ToolService } from '../../tools/ServiceRegistry';
import { chatbotDb } from '../chatbotService';
import { uploadFileToS3 } from '../../utils/s3Utils';
import axios from 'axios';

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
        return { success: false, message: 'No image URL provided' };
      }
      
      const modelToUse = llmModel || 'gpt-4o'; 
      const analysisPrompt = prompt || 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.';

      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: analysisPrompt },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ];

      console.log(`ImageService: Describing image with model ${modelToUse}:`, imageUrl);

      const response = await llmClientFactory.callLLM(modelToUse, messages);
      const description = response.choices[0]?.message?.content || 'No description generated.';

      return {
        success: true,
        description: description,
        image_url: imageUrl
      };

    } catch (error: any) {
      console.error('ImageService: Error describing image:', error);
      return { success: false, message: 'Failed to describe image', error: error.message };
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

      const isAvailable = await imageService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Image generation service is not available. Please check API key configuration.',
          error: 'Service unavailable'
        };
      }

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
        if (sessionId) {
          try {
            await chatbotDb.addMessageToSession(sessionId, {
              role: 'system',
              content: `Image generated: ${result.filename}`,
              metadata: { timestamp: new Date().toISOString() }
            });
          } catch (error) {
            console.warn('Failed to store image generation metadata:', error);
          }
        }

        return {
          success: true,
          message: `✅ Image "${result.filename}" generated successfully!`,
          imageUrl: result.imageUrl,
          filename: result.filename,
          prompt,
          size,
          quality
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
      return { success: false, message: 'Failed to generate image', error: error.message };
    }
  }

  /**
   * Remove C2PA metadata from an image
   */
  async removeC2PAFromImage(imageUrl: string, filename?: string, userId?: string): Promise<any> {
    try {
      console.log('ImageService: Removing C2PA metadata from image:', imageUrl);

      if (!imageUrl) {
        return { success: false, message: 'Image URL is required', error: 'missing_image_url' };
      }

      const { imageService } = await import('../imageGeneration');

      let imageBuffer: Buffer;
      if (imageUrl.startsWith('data:image/')) {
        const base64Data = imageUrl.split(',')[1] as string;
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)' }
        });
        imageBuffer = Buffer.from(response.data as any);
      }

      const cleanedBuffer = await imageService.removeC2PAMetadata(imageBuffer);

      let finalFilename = filename;
      if (!finalFilename) {
         try {
           const urlObj = new URL(imageUrl);
           const pathParts = urlObj.pathname.split('/');
           const urlFilename = pathParts[pathParts.length - 1];
           if (urlFilename && urlFilename.includes('.')) {
             const nameWithoutExt = urlFilename.substring(0, urlFilename.lastIndexOf('.'));
             finalFilename = `${nameWithoutExt}_no_c2pa.png`;
           } else {
             finalFilename = `image_${Date.now()}_no_c2pa.png`;
           }
         } catch (e) {
           finalFilename = `image_${Date.now()}_no_c2pa.png`;
         }
      }

      if (!finalFilename.endsWith('.png')) {
        finalFilename = finalFilename.replace(/\.[^/.]+$/, "") + ".png";
      }

      const uploadResult = await uploadFileToS3(
        cleanedBuffer,
        finalFilename,
        userId || 'system',
        'image/png'
      );

      if (!uploadResult.success) {
        throw new Error(uploadResult.error || 'Failed to upload cleaned image to S3');
      }

      return {
        success: true,
        message: 'Successfully removed C2PA metadata',
        originalUrl: imageUrl,
        cleanedUrl: uploadResult.url,
        filename: finalFilename
      };

    } catch (error: any) {
      console.error('ImageService: Error removing C2PA metadata:', error);
      return { success: false, message: 'Failed to remove C2PA metadata', error: error.message };
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
