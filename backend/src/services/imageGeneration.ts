import OpenAI from "openai";
import axios from "axios";
import { getSecret } from "../utils/secretsManager";
import { uploadFileToS3 } from "../utils/s3Utils";

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
  userId: string;
}

export class ImageService {
  constructor() {
    // No initialization needed - clients will be created as needed
  }

  /**
   * Get the API key from Secrets Manager for a specific model
   */
  private async getApiKey(model: string): Promise<string> {
    try {
      let secretName: string;
      
      if (model === "FLUX.1-Kontext-pro" || model === "gpt-image-1") {
        // Azure AI Services
        secretName = process.env.NODE_ENV === "development" 
          ? "dev/AgentWeb/Azure/Image" 
          : "prod/AgentWeb/Azure/Image";
      } else if (model === "gemini-2.5-flash-image-preview") {
        // Google Gemini
        secretName = process.env.NODE_ENV === "development" 
          ? "dev/AgentWeb/Google/Image" 
          : "prod/AgentWeb/Google/Image";
      } else {
        // Default to OpenAI
        secretName = process.env.NODE_ENV === "development" 
        ? "dev/AgentWeb/OpenAI/Image" 
        : "prod/AgentWeb/OpenAI/Image";
      }
      
      const apiKey = await getSecret(secretName);
      
      if (!apiKey || apiKey.trim() === "") {
        throw new Error(`${model} API key is empty`);
      }
      
      return apiKey;
    } catch (error) {
      console.error(`Error fetching ${model} API key from Secrets Manager:`, error);
      throw new Error(`Failed to fetch ${model} API key from Secrets Manager`);
    }
  }

  /**
   * Generate an image using various AI models
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

      // Check if we have input images for editing
      const hasInputImages = params.inputImages && params.inputImages.length > 0;
      const inputImageCount = params.inputImages ? params.inputImages.length : 0;
      
      // Determine which model to use
      let modelToUse: string;
      if (inputImageCount > 1) {
        // Multiple input images - use Google Gemini as it supports multiple images
        modelToUse = "gemini-2.5-flash-image-preview";
      } else if (inputImageCount === 1) {
        // Single input image - use Azure AI Services for image editing
        modelToUse = "gpt-image-1";
      } else {
        // No input images - use default model for text-to-image generation
        modelToUse = "gpt-image-1";
      }
      
      // Generate or edit image
      let result: ImageGenerationResult;
      try {
        if (modelToUse === "gpt-image-1") {
          result = await this.generateWithAzureAI(params, modelToUse, hasInputImages);
        } else if (modelToUse === "FLUX.1-Kontext-pro") {
          result = await this.generateWithAzureAI(params, modelToUse, hasInputImages);
        } else if (modelToUse === "gemini-2.5-flash-image-preview") {
          result = await this.generateWithGoogleGemini(params);
        } else {
          result = await this.generateWithOpenAI(params, modelToUse);
        }
        
        // If generation was successful, upload to S3
        if (result.success && result.imageUrl) {
          // Check if it's a data URL (base64) and convert to buffer
          let imageBuffer: Buffer;
          if (result.imageUrl.startsWith('data:image/')) {
            // Extract base64 data from data URL
            const base64Data = result.imageUrl.split(',')[1];
            imageBuffer = Buffer.from(base64Data, 'base64');
          } else {
            // It's already a URL, we can't upload it
            return result;
          }
          
          // Upload to S3
          const uploadResult = await uploadFileToS3(
            imageBuffer,
            result.filename || params.filename,
            params.userId,
            'image/png'
          );
          
          if (uploadResult.success) {
            // Return S3 URL instead of data URL
            return {
              success: true,
              imageUrl: uploadResult.url,
              filename: result.filename || params.filename,
            };
          } else {
            // If S3 upload fails, return the original result
            console.warn('Failed to upload image to S3, returning original result:', uploadResult.error);
            return result;
          }
        }
        
        return result;
      } catch (apiError: any) {
        console.error("💥 API error details:", {
          model: modelToUse,
          status: apiError.status,
          message: apiError.message,
          error: apiError.error,
          type: apiError.type,
          code: apiError.code,
          fullError: apiError
        });
        
        // Re-throw the error with more context
        throw new Error(`${modelToUse} API failed: ${apiError.message || apiError.error || 'Unknown error'}`);
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
   * Generate image using Azure AI Services
   */
  private async generateWithAzureAI(params: ImageGenerationParams, model: string, hasInputImages: boolean = false): Promise<ImageGenerationResult> {
    const apiKey = await this.getApiKey(model);
    const axios = require('axios');
    
    const azureEndpoint = "https://ai-ruiwangwarm7085ai345967089938.services.ai.azure.com";
    const deploymentName = model === "FLUX.1-Kontext-pro" ? "FLUX.1-Kontext-pro" : "gpt-image-1";
    
    if (hasInputImages) {
      // Image editing mode
      const inputImageUrl = params.inputImages![0];
      
      // Download the input image
      const imageResponse = await axios.get(inputImageUrl, { responseType: 'arraybuffer' });
      const imageBuffer = Buffer.from(imageResponse.data);
      
      // Use FormData for image editing
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('image', imageBuffer, {
        filename: 'input.png',
        contentType: 'image/png'
      });
      formData.append('prompt', params.prompt);
      formData.append('n', '1');
      formData.append('size', params.size || '1024x1024');
      formData.append('quality', params.quality || 'medium');
      
      const url = `${azureEndpoint}/openai/deployments/${deploymentName}/images/edits`;
      const headers = {
        "api-key": apiKey,
        ...formData.getHeaders()
      };
      
      const response = await axios.post(url, formData, { 
        headers,
        params: { "api-version": "2025-04-01-preview" }
      });
      
      if (response.status !== 200) {
        throw new Error(`Azure AI Services API error: ${response.status} - ${response.statusText}`);
      }
      
      const resultData = response.data;
      if (!resultData.data || resultData.data.length === 0) {
        throw new Error("No image data received from Azure AI Services API");
      }
      
      const imageBase64 = resultData.data[0].b64_json;
      if (!imageBase64) {
        throw new Error("No b64_json data in Azure AI Services response");
      }
      
      const dataUrl = `data:image/png;base64,${imageBase64}`;
      return {
        success: true,
        imageUrl: dataUrl,
        filename: params.filename,
      };
    } else {
      // Text-to-image generation mode
      const url = `${azureEndpoint}/openai/deployments/${deploymentName}/images/generations`;
      const headers = {
        "Content-Type": "application/json",
        "api-key": apiKey
      };
      const data = {
        prompt: params.prompt,
        size: params.size,
        n: 1,
        quality: params.quality,
        output_format: "png"
      };
      
      const response = await axios.post(url, data, { 
        headers, 
        params: { "api-version": "2025-04-01-preview" }
      });
      
      if (response.status !== 200) {
        throw new Error(`Azure AI Services API error: ${response.status} - ${response.statusText}`);
      }
      
      const resultData = response.data;
      if (!resultData.data || resultData.data.length === 0) {
        throw new Error("No image data received from Azure AI Services API");
      }
      
      const imageBase64 = resultData.data[0].b64_json;
      if (!imageBase64) {
        throw new Error("No b64_json data in Azure AI Services response");
      }
      
      const dataUrl = `data:image/png;base64,${imageBase64}`;
      return {
        success: true,
        imageUrl: dataUrl,
        filename: params.filename,
      };
    }
  }

  /**
   * Get MIME type for an image based on file extension or content type
   */
  private getImageMimeType(imageUrl: string, contentType?: string): string {
    // First, try to use the content type from the response
    if (contentType && contentType.startsWith('image/')) {
      return contentType;
    }
    
    // Fallback to file extension detection
    const url = new URL(imageUrl);
    const pathname = url.pathname.toLowerCase();
    
    // Map file extensions to MIME types (same as Python version)
    const mimeMap: { [key: string]: string } = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    };
    
    // Extract file extension
    const lastDotIndex = pathname.lastIndexOf('.');
    if (lastDotIndex !== -1) {
      const extension = pathname.substring(lastDotIndex);
      const mimeType = mimeMap[extension];
      if (mimeType) {
        return mimeType;
      }
    }
    
    // Default to PNG if we can't determine the type
    console.warn(`⚠️ Could not determine MIME type for ${imageUrl}, defaulting to image/png`);
    return 'image/png';
  }

  /**
   * Convert SVG to PNG using sharp (similar to Python's cairosvg)
   */
  private async convertSvgToPng(svgBuffer: Buffer): Promise<Buffer> {
    try {
      const sharp = require('sharp');
      
      // Convert SVG to PNG with high quality (similar to Python version with DPI 300, width 2048)
      const pngBuffer = await sharp(svgBuffer)
        .resize(2048, null, { // 2048px width, maintain aspect ratio
          withoutEnlargement: false
        })
        .png({
          quality: 100,
          compressionLevel: 0
        })
        .toBuffer();
      
      return pngBuffer;
    } catch (error: any) {
      console.error("❌ Failed to convert SVG to PNG:", error.message);
      throw new Error(`SVG conversion failed: ${error.message}`);
    }
  }

  /**
   * Process input image (download, convert SVG if needed, determine MIME type)
   */
  private async processInputImage(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    // Download the image
    const imageResponse = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
      }
    });
    
    let imageBuffer = Buffer.from(imageResponse.data as ArrayBuffer);
    let mimeType = this.getImageMimeType(imageUrl, imageResponse.headers['content-type'] as string);
    
    // Check if it's an SVG and convert to PNG
    if (mimeType === 'image/svg+xml') {
      imageBuffer = await this.convertSvgToPng(imageBuffer);
      mimeType = 'image/png'; // After conversion, it's PNG
    }
    
    return { buffer: imageBuffer, mimeType };
  }

  /**
   * Generate image using Google Gemini
   */
  private async generateWithGoogleGemini(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const axios = require('axios');
      
      const apiKey = await this.getApiKey("gemini-2.5-flash-image-preview");
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image-preview" });
      
      const inputImageCount = params.inputImages ? params.inputImages.length : 0;
      
      if (inputImageCount === 0) {
        // Text-to-image generation
        const result = await model.generateContent({
          contents: [{
            role: "user",
            parts: [{
              text: params.prompt
            }]
          }]
        });
        
        const response = await result.response;
        
        const imageData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        
        if (!imageData) {
          console.error("❌ No image data in Google Gemini response");
          return {
            success: false,
            error: "No image data received from Google Gemini API. The model may not support image generation or the prompt may not be suitable for image generation."
          };
        }
        
        // Convert base64 to data URL
        const imageUrl = `data:image/png;base64,${imageData}`;
        
        return {
          success: true,
          imageUrl: imageUrl,
          filename: params.filename
        };
        
      } else if (inputImageCount === 1) {
        // Single image editing
        // Process the input image (download, convert SVG if needed, determine MIME type)
        let processedImage;
        try {
          processedImage = await this.processInputImage(params.inputImages![0]);
        } catch (error: any) {
          console.error("❌ Failed to process input image:", error.message);
          return {
            success: false,
            error: `Failed to process input image: ${error.message}. Please check if the image URL is accessible.`
          };
        }
        
        const imageBase64 = processedImage.buffer.toString('base64');
        
        const result = await model.generateContent({
          contents: [
            {
              role: "user",
              parts: [{
                inlineData: {
                  mimeType: processedImage.mimeType,
                  data: imageBase64
                }
              }]
            },
            {
              role: "user", 
              parts: [{
                text: params.prompt
              }]
            }
          ]
        });
        
        const response = await result.response;
        
        const imageData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        
        if (!imageData) {
          console.error("❌ No image data in Google Gemini response");
          return {
            success: false,
            error: "No image data received from Google Gemini API. The model may not support image generation or the prompt may not be suitable for image generation."
          };
        }
        
        // Convert base64 to data URL
        const imageUrl = `data:image/png;base64,${imageData}`;
        
        return {
          success: true,
          imageUrl: imageUrl,
          filename: params.filename
        };
        
      } else {
        // Multiple image editing
        const parts = [];
        
        // Add all input images as parts
        for (let i = 0; i < params.inputImages!.length; i++) {
          const imageUrl = params.inputImages![i];
          
          try {
            const processedImage = await this.processInputImage(imageUrl);
            const imageBase64 = processedImage.buffer.toString('base64');
            
            parts.push({
              inlineData: {
                mimeType: processedImage.mimeType,
                data: imageBase64
              }
            });
          } catch (error: any) {
            console.error(`❌ Failed to process input image ${i + 1}:`, error.message);
            return {
              success: false,
              error: `Failed to process input image ${i + 1} (${imageUrl}): ${error.message}. Please check if the image URL is accessible.`
            };
          }
        }
        
        // Add the text prompt as the last part
        parts.push({
          text: params.prompt
        });
        
        const result = await model.generateContent({
          contents: [{
            role: "user",
            parts: parts
          }]
        });
        
        const response = await result.response;
        
        const imageData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        
        if (!imageData) {
        return {
          success: false,
            error: "No image data received from Google Gemini API"
          };
        }
        
        // Convert base64 to data URL
        const imageUrl = `data:image/png;base64,${imageData}`;
        
        return {
          success: true,
          imageUrl: imageUrl,
          filename: params.filename
        };
      }
      
    } catch (error: any) {
      console.error("Error with Google Gemini image generation:", error);
      return {
        success: false,
        error: `Google Gemini image generation failed: ${error.message || 'Unknown error'}`
      };
    }
  }

  /**
   * Generate image using OpenAI
   */
  private async generateWithOpenAI(params: ImageGenerationParams, model: string): Promise<ImageGenerationResult> {
    const apiKey = await this.getApiKey(model);
    
    // Create client with the fetched API key
    const client = new OpenAI({
      apiKey: apiKey
    });

    const result = await client.images.generate({
      model: model,
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
   * Check if the image generation service is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Try to get API key from Secrets Manager for the default model
      const defaultModel = "gpt-image-1";
      await this.getApiKey(defaultModel);
      return true;
    } catch (error) {
      console.warn("Image generation service not available - cannot fetch API key from Secrets Manager:", error);
      return false;
    }
  }
}

// Create a singleton instance with error handling
let imageService: ImageService;

try {
  imageService = new ImageService();
  console.log("✅ Image Service initialized successfully");
} catch (error) {
  console.warn("⚠️ Failed to initialize OpenAI Image Service, creating fallback service");
  
  // Create a fallback service that always returns false for isAvailable
  imageService = {
    isAvailable: async () => false,
    generateImage: async () => ({ success: false, error: "Service not available" })
  } as any;
}

export { imageService };
