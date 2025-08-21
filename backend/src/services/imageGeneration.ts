import OpenAI from "openai";
import { getSecret } from "../utils/secretsManager";

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
    // Initialize without API key - will be fetched when needed
    this.client = new OpenAI();
  }

  /**
   * Get the API key from Secrets Manager
   */
  private async getApiKey(): Promise<string> {
    try {
      const secretName = process.env.NODE_ENV === "development" 
        ? "dev/AgentWeb/OpenAI/Image" 
        : "prod/AgentWeb/OpenAI/Image";
      
      const apiKey = await getSecret(secretName);
      
      if (!apiKey || apiKey.trim() === "") {
        throw new Error("OpenAI API key is empty");
      }
      
      return apiKey;
    } catch (error) {
      console.error("Error fetching OpenAI API key from Secrets Manager:", error);
      throw new Error("Failed to fetch OpenAI API key from Secrets Manager");
    }
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
      try {
        // Get API key from Secrets Manager
        const apiKey = await this.getApiKey();
        
        // Update client with the fetched API key
        this.client.apiKey = apiKey;

        const result = await this.client.images.generate({
          model: "gpt-image-1",
          prompt: params.prompt,
          size: params.size as any,
          quality: params.quality as any,
        });

        // Return the image URL directly from OpenAI
        if (result.data && result.data.length > 0) {
          const imageData = result.data[0];
          
          if (imageData.url) {
            // DALL-E returns URLs
            return {
              success: true,
              imageUrl: imageData.url,
              filename: params.filename,
            };
          } else if (imageData.b64_json) {
            // GPT Image 1 returns base64 data - convert to data URL
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
      // Try to get API key from Secrets Manager
      await this.getApiKey();
      return true;
    } catch (error) {
      console.warn("OpenAI image service not available - cannot fetch API key from Secrets Manager:", error);
      return false;
    }
  }
}

// Create a singleton instance with error handling
let openaiImageService: OpenAIImageService;

try {
  openaiImageService = new OpenAIImageService();
  console.log("✅ OpenAI Image Service initialized successfully");
} catch (error) {
  console.warn("⚠️ Failed to initialize OpenAI Image Service, creating fallback service");
  
  // Create a fallback service that always returns false for isAvailable
  openaiImageService = {
    isAvailable: async () => false,
    generateImage: async () => ({ success: false, error: "Service not available" })
  } as any;
}

export { openaiImageService };
