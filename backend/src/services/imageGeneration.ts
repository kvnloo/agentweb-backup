import OpenAI from "openai";

interface ImageGenerationResult {
  success: boolean;
  imageUrl?: string;
  filename?: string;
  error?: string;
}

interface ImageGenerationParams {
  prompt: string;
  filename: string;
  size?: string;
  quality?: string;
  inputImages?: string[];
}

export class OpenAIImageService {
  private client: OpenAI;

  constructor() {
    // Get API key from environment
    const apiKey = process.env.OPENAI_IMAGE_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_IMAGE_API_KEY environment variable is not set");
    }

    // Initialize OpenAI client
    this.client = new OpenAI({
      apiKey: apiKey,
    });
  }

  /**
   * Generate an image using OpenAI's GPT Image 1 model
   */
  async generateImage(
    params: ImageGenerationParams
  ): Promise<ImageGenerationResult> {
    try {
      // Validate parameters
      const validationResult = this.validateParams(params);
      if (!validationResult.valid) {
        return {
          success: false,
          error: validationResult.error,
        };
      }

      // For now, only support text-to-image generation
      // Image-to-image support can be added later if needed
      if (params.inputImages && params.inputImages.length > 0) {
        return {
          success: false,
          error: "Image-to-image generation is not currently supported. Please use text prompts only.",
        };
      }

      // Generate new image from prompt only
      console.log("Generating new image from prompt...");
      console.log("🔧 Parameters being sent to OpenAI:", {
        model: "gpt-image-1",
        prompt: params.prompt,
        size: params.size,
        quality: params.quality,
        filename: params.filename
      });
      
      try {
        const result = await this.client.images.generate({
          model: "gpt-image-1",
          prompt: params.prompt,
          size: params.size as any,
          quality: params.quality as any,
        });

        console.log("🔍 OpenAI API response:", JSON.stringify(result, null, 2));

        // Return the image URL directly from OpenAI
        if (result.data && result.data.length > 0) {
          const imageData = result.data[0];
          console.log("🔍 Image data:", JSON.stringify(imageData, null, 2));
          
          if (imageData.url) {
            // DALL-E returns URLs
            return {
              success: true,
              imageUrl: imageData.url,
              filename: params.filename,
            };
          } else if (imageData.b64_json) {
            // GPT Image 1 returns base64 data - convert to data URL
            console.log("✅ Image generated with base64 data, converting to data URL");
            const dataUrl = `data:image/png;base64,${imageData.b64_json}`;
            return {
              success: true,
              imageUrl: dataUrl,
              filename: params.filename,
            };
          } else {
            console.error("❌ No URL or base64 data in image response:", imageData);
            throw new Error(`No image data in response. Image data keys: ${Object.keys(imageData)}`);
          }
        } else {
          console.error("❌ No data in OpenAI response:", result);
          throw new Error(`No data in OpenAI response: ${JSON.stringify(result)}`);
        }
      } catch (apiError: any) {
        console.error("💥 OpenAI API error details:", {
          status: apiError.status,
          message: apiError.message,
          error: apiError.error,
          type: apiError.type,
          code: apiError.code,
          fullError: apiError
        });
        
        // Re-throw the error with more context
        throw new Error(`OpenAI API failed: ${apiError.message || apiError.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      console.error("Error generating image:", error);
      return {
        success: false,
        error: `Failed to generate image: ${error.message}`,
      };
    }
  }

  /**
   * Validate input parameters
   */
  private validateParams(params: ImageGenerationParams): { valid: boolean; error?: string } {
    // Validate quality
    const validQualities = ["low", "medium", "high", "auto"];
    if (params.quality && !validQualities.includes(params.quality)) {
      return {
        valid: false,
        error: `Invalid quality '${params.quality}'. Must be one of: ${validQualities.join(", ")}`,
      };
    }

    // Validate size
    const validSizes = ["1024x1024", "1536x1024", "1024x1536", "auto"];
    if (params.size && !validSizes.includes(params.size)) {
      return {
        valid: false,
        error: `Invalid size '${params.size}'. Must be one of: ${validSizes.join(", ")}`,
      };
    }

    // Filename validation - just ensure it's not empty
    if (!params.filename || params.filename.trim() === "") {
      return {
        valid: false,
        error: "Filename is required",
      };
    }

    return { valid: true };
  }

  /**
   * Check if the OpenAI image generation service is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check if API key is set
      if (!process.env.OPENAI_IMAGE_API_KEY) {
        console.warn("OPENAI_IMAGE_API_KEY environment variable is not set");
        return false;
      }

      return true;
    } catch (error) {
      console.warn("Error checking OpenAI image service availability:", error);
      return false;
    }
  }
}

// Create a singleton instance
export const openaiImageService = new OpenAIImageService();
