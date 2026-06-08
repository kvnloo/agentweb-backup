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

// Supported image generation models
const SUPPORTED_MODELS = [
  "gpt-image-1",
  "gpt-image-2",
  "gemini-2.5-flash-image",
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
  "gen4_image",
  "gemini_2.5_flash",
] as const;

type SupportedModel = typeof SUPPORTED_MODELS[number];

interface ImageGenerationParams {
  prompt: string;
  filename: string;
  size?: string;
  quality?: string;
  inputImages?: string[];
  logoImage?: string; // Separate logo image URL - will be added with emphasis on preserving exact text, shape, and color
  userId: string;
  imageModel?: string; // Optional model parameter - must be one of the supported models
  removeC2PA?: boolean; // Optional parameter to remove C2PA metadata, defaults to true
}

// Deterministic compositing (sharp, in-process) — the exact-count fallback for
// requests that generative models cannot reliably satisfy (e.g. "9 avatars in a
// hexagon layout"). N input images always produce exactly N placed cells.
export type CompositeLayout = "grid" | "row" | "column" | "honeycomb";
export type CompositeShape = "square" | "circle";

interface CompositeLayoutOptions {
  layout?: CompositeLayout;
  columns?: number; // explicit column count (grid/honeycomb); auto near-square when omitted
  cellSize?: number; // px per cell (square); default 256
  gap?: number; // px between cells; default 16
}

interface CompositeCell {
  x: number;
  y: number;
  size: number;
}

interface CompositeLayoutResult {
  cells: CompositeCell[];
  width: number;
  height: number;
}

interface CompositeImagesParams extends CompositeLayoutOptions {
  images: string[]; // URLs of the exact images to place, in order
  filename: string;
  userId: string;
  shape?: CompositeShape; // mask each cell into a circle (e.g. avatars) or leave square
  background?: string; // CSS color for the canvas; default transparent
}

// Upper bound on images per composite — guards memory and keeps layouts sane.
const MAX_COMPOSITE_IMAGES = 50;
const DEFAULT_CELL_SIZE = 256;
const DEFAULT_CELL_GAP = 16;

export class ImageService {
  // Default timeout for a single image generation API call (10 minutes).
  // Prevents sessions from hanging indefinitely when a provider is unresponsive.
  private readonly IMAGE_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

  constructor() {
    // No initialization needed - clients will be created as needed
  }

  /**
   * Wraps a promise with a timeout. If the promise doesn't resolve within the timeout,
   * it rejects with a timeout error.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${operationName} timed out after ${timeoutMs / 1000} seconds`)),
          timeoutMs
        )
      ),
    ]);
  }

  /**
   * Remove C2PA metadata from an image buffer by re-encoding it
   * This strips all metadata including C2PA manifests
   * The image is re-encoded as PNG to ensure all metadata is removed
   */
  async removeC2PAMetadata(imageBuffer: Buffer): Promise<Buffer> {
    try {
      const sharp = require('sharp');
      
      // Re-encode the image without metadata to remove C2PA
      // Sharp will strip all metadata (including C2PA) when re-encoding
      // We convert to PNG to ensure consistent format and complete metadata removal
      const cleanedBuffer = await sharp(imageBuffer)
        .png({
          quality: 100,
          compressionLevel: 0,
          // Remove all metadata
          withMetadata: false
        })
        .toBuffer();
      
      return cleanedBuffer;
    } catch (error: any) {
      console.error("❌ Failed to remove C2PA metadata:", error.message);
      // If metadata removal fails, return original buffer
      // This ensures the upload still works even if metadata removal fails
      return imageBuffer;
    }
  }

  /**
   * Get the API key from Secrets Manager for a specific model
   */
  private async getApiKey(model: string): Promise<string> {
    try {
      let secretName: string;
      
      if (model === "gpt-image-1" || model === "gpt-image-2") {
        // Azure AI Services
        secretName = process.env.NODE_ENV === "development"
          ? "dev/AgentWeb/Azure/Image"
          : "prod/AgentWeb/Azure/Image";
      } else if (model === "gemini-2.5-flash-image" || model === "gemini-3-pro-image-preview" || model === "gemini-3.1-flash-image-preview") {
        // Google Gemini
        secretName = process.env.NODE_ENV === "development" 
          ? "dev/AgentWeb/Google/Image" 
          : "prod/AgentWeb/Google/Image";
      } else if (model === "gen4_image" || model === "gemini_2.5_flash") {
        // Runway ML
        secretName = process.env.NODE_ENV === "development" 
          ? "dev/AgentWeb/Runway/Image" 
          : "prod/AgentWeb/Runway/Image";
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
   * Retry a function with exponential backoff for transient API errors (503, 429).
   * Includes a total timeout (default 5 minutes) to prevent hanging for 30+ minutes.
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    opts: { maxRetries?: number; baseDelayMs?: number; totalTimeoutMs?: number; retryableCheck?: (err: any) => boolean } = {}
  ): Promise<T> {
    const { maxRetries = 3, baseDelayMs = 3000, totalTimeoutMs = 5 * 60 * 1000, retryableCheck } = opts;
    const startTime = Date.now();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= totalTimeoutMs) {
          throw new Error(`Image generation timed out after ${Math.round(elapsed / 1000)}s. Please try again or use a different model.`);
        }
        const isRetryable = retryableCheck
          ? retryableCheck(err)
          : (err.status === 503 || err.status === 429 || err.code === 503 || err.code === 429
             || err.message?.includes('high demand') || err.message?.includes('UNAVAILABLE')
             || err.message?.includes('rate') || err.message?.includes('Too Many Requests'));
        if (!isRetryable || attempt === maxRetries) throw err;
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
        console.warn(`⚠️ Image generation attempt ${attempt}/${maxRetries} failed (retryable). Retrying in ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Generate an image using various AI models
   */
  async generateImage(
    params: ImageGenerationParams
  ): Promise<ImageGenerationResult> {
    try {
      // If logoImage is provided, append it to inputImages and enhance the prompt
      if (params.logoImage) {
        if (!params.inputImages) {
          params.inputImages = [];
        }
        params.inputImages.push(params.logoImage);
        // Enhance prompt to emphasize logo precision
        params.prompt = `${params.prompt}\n\nCRITICAL LOGO INSTRUCTION: The logo image provided must be reproduced with absolute precision. The logo's exact text (every letter, word, and character must match precisely), exact shape (all graphical elements, icons, and outlines must be identical), and exact colors (all colors, gradients, and color relationships must be preserved exactly) must be maintained. Do NOT alter, simplify, restyle, or reinterpret any aspect of the logo. The logo must appear exactly as provided in the reference image.`;
      }

      // Check if we have input images for editing
      const hasInputImages = params.inputImages && params.inputImages.length > 0;
      const inputImageCount = params.inputImages ? params.inputImages.length : 0;

      // Determine which model to use before validation
      // If model not defined, use gemini-3-pro-image-preview as default (supports multiple input images)
      if (!params.imageModel) {
        params.imageModel = "gemini-3-pro-image-preview";
      }
      
      // Validate the provided model
      if (!SUPPORTED_MODELS.includes(params.imageModel as SupportedModel)) {
        return {
          success: false,
          error: `Invalid imageModel '${params.imageModel}'. Must be one of: ${SUPPORTED_MODELS.join(", ")}`,
        };
      }
      
      // Validate parameters (now that model is determined)
      const validationResult = this.validateParams(params);
      if (!validationResult.valid) {
        return {
          success: false,
          error: validationResult.error,
        };
      }
      
      // Determine which model to use for generation
      const modelToUse = params.imageModel;
      
      // Generate or edit image with timeout
      let result: ImageGenerationResult;
      try {
        let generationPromise: Promise<ImageGenerationResult>;
        if (modelToUse === "gpt-image-1" || modelToUse === "gpt-image-2") {
          generationPromise = this.generateWithAzureAI(params, modelToUse, hasInputImages);
        } else if (modelToUse === "gemini-2.5-flash-image") {
          generationPromise = this.generateWithGoogleGemini(params);
        } else if (modelToUse === "gemini-3-pro-image-preview" || modelToUse === "gemini-3.1-flash-image-preview") {
          generationPromise = this.generateWithGoogleGemini3Pro(params);
        } else if (modelToUse === "gen4_image" || modelToUse === "gemini_2.5_flash") {
          generationPromise = this.generateWithRunwayML(params, modelToUse);
        } else {
          generationPromise = this.generateWithOpenAI(params, modelToUse);
        }

        // Wrap the generation call with a timeout
        result = await this.withTimeout(
          generationPromise,
          this.IMAGE_GENERATION_TIMEOUT_MS,
          `Image generation with ${modelToUse}`
        );
        
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
          
          // Remove C2PA metadata if removeC2PA is true (defaults to true)
          const shouldRemoveC2PA = params.removeC2PA !== false; // Default to true
          if (shouldRemoveC2PA) {
            imageBuffer = await this.removeC2PAMetadata(imageBuffer);
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
    const deploymentName = model === "gpt-image-2" ? "gpt-image-2" : "gpt-image-1";
    
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
      
      const response: any = await this.retryWithBackoff(
        () => axios.post(url, formData, {
          headers,
          params: { "api-version": "2025-04-01-preview" }
        }),
        { maxRetries: 3, baseDelayMs: 3000 }
      );

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
        quality: params.quality || 'medium',
        output_format: "png"
      };

      const response: any = await this.retryWithBackoff(
        () => axios.post(url, data, {
          headers,
          params: { "api-version": "2025-04-01-preview" }
        }),
        { maxRetries: 3, baseDelayMs: 3000 }
      );

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
    
    // Convert ArrayBufferLike to Buffer
    const data = imageResponse.data as ArrayBuffer;
    let imageBuffer: Buffer = Buffer.from(data);
    let mimeType = this.getImageMimeType(imageUrl, imageResponse.headers['content-type'] as string);
    
    // Check if it's an SVG and convert to PNG
    if (mimeType === 'image/svg+xml') {
      imageBuffer = await this.convertSvgToPng(imageBuffer) as Buffer;
      mimeType = 'image/png'; // After conversion, it's PNG
    }
    
    return { buffer: imageBuffer, mimeType };
  }

  /**
   * Compute a deterministic layout for placing exactly `count` cells.
   *
   * This is the heart of the exact-count guarantee: the returned `cells` array
   * always has exactly `count` entries, so N input images map 1:1 to N placed
   * positions — something generative image models cannot promise.
   *
   * Layouts:
   *  - grid (default): near-square arrangement, or `columns` if provided
   *  - row / column: single line of cells
   *  - honeycomb: grid with alternating rows offset by half a cell and a
   *    compressed vertical pitch, giving the packed "hexagon" look
   */
  public computeCompositeLayout(
    count: number,
    options: CompositeLayoutOptions
  ): CompositeLayoutResult {
    const cellSize = options.cellSize && options.cellSize > 0 ? options.cellSize : DEFAULT_CELL_SIZE;
    const gap = options.gap !== undefined && options.gap >= 0 ? options.gap : DEFAULT_CELL_GAP;
    const layout = options.layout || "grid";

    const cells: CompositeCell[] = [];

    if (layout === "row") {
      for (let i = 0; i < count; i++) {
        cells.push({ x: i * (cellSize + gap), y: 0, size: cellSize });
      }
      const width = count * cellSize + Math.max(0, count - 1) * gap;
      return { cells, width, height: cellSize };
    }

    if (layout === "column") {
      for (let i = 0; i < count; i++) {
        cells.push({ x: 0, y: i * (cellSize + gap), size: cellSize });
      }
      const height = count * cellSize + Math.max(0, count - 1) * gap;
      return { cells, width: cellSize, height };
    }

    // grid / honeycomb share column math
    const columns = options.columns && options.columns > 0
      ? Math.floor(options.columns)
      : Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / columns));

    if (layout === "honeycomb") {
      // Half-cell horizontal offset on odd rows; vertical pitch compressed to
      // ~86.6% (sin 60°) of the cell so rows nest like a honeycomb.
      const rowPitch = Math.round(cellSize * 0.866) + gap;
      const halfStep = (cellSize + gap) / 2;
      for (let i = 0; i < count; i++) {
        const r = Math.floor(i / columns);
        const c = i % columns;
        const xOffset = r % 2 === 1 ? halfStep : 0;
        cells.push({
          x: c * (cellSize + gap) + xOffset,
          y: r * rowPitch,
          size: cellSize,
        });
      }
      // Widest row spans `columns` cells plus a possible half-step offset.
      const width = columns * cellSize + Math.max(0, columns - 1) * gap + halfStep;
      const height = (rows - 1) * rowPitch + cellSize;
      return { cells, width, height };
    }

    // grid
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / columns);
      const c = i % columns;
      cells.push({
        x: c * (cellSize + gap),
        y: r * (cellSize + gap),
        size: cellSize,
      });
    }
    const width = columns * cellSize + Math.max(0, columns - 1) * gap;
    const height = rows * cellSize + Math.max(0, rows - 1) * gap;
    return { cells, width, height };
  }

  /**
   * Build a circular-mask SVG buffer for the given cell size.
   * Used to clip each tile into a circle (e.g. for avatar montages).
   */
  private circleMaskSvg(size: number): Buffer {
    const r = size / 2;
    return Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
        `<circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`
    );
  }

  /**
   * Deterministically composite N specific images into an exact layout using
   * sharp (in-process — no network sandbox, no generative model). Guarantees
   * every supplied image is placed exactly once.
   *
   * This is the reliable path for "exact element count" requests (e.g. "9
   * community avatars in a hexagon layout") that generative models fail at.
   */
  async compositeImages(params: CompositeImagesParams): Promise<ImageGenerationResult> {
    try {
      const { images, filename, userId } = params;

      if (!images || images.length === 0) {
        return { success: false, error: "compositeImages requires at least one image URL." };
      }
      if (images.length > MAX_COMPOSITE_IMAGES) {
        return {
          success: false,
          error: `Too many images: ${images.length}. Maximum is ${MAX_COMPOSITE_IMAGES}.`,
        };
      }
      if (!filename || !filename.trim()) {
        return { success: false, error: "compositeImages requires a filename." };
      }

      const sharp = require("sharp");

      const cellSize = params.cellSize && params.cellSize > 0 ? params.cellSize : DEFAULT_CELL_SIZE;
      const layout = this.computeCompositeLayout(images.length, {
        layout: params.layout,
        columns: params.columns,
        cellSize,
        gap: params.gap,
      });

      // Download, resize-to-cover, and (optionally) circle-mask each tile.
      const circleMask = params.shape === "circle" ? this.circleMaskSvg(cellSize) : null;
      const overlays = await Promise.all(
        images.map(async (url, i) => {
          const { buffer } = await this.processInputImage(url);
          let tile = sharp(buffer).resize(cellSize, cellSize, { fit: "cover", position: "center" });
          if (circleMask) {
            tile = tile.composite([{ input: circleMask, blend: "dest-in" }]);
          }
          const tileBuffer = await tile.png().toBuffer();
          return {
            input: tileBuffer,
            left: Math.round(layout.cells[i].x),
            top: Math.round(layout.cells[i].y),
          };
        })
      );

      const canvasBuffer = await sharp({
        create: {
          width: Math.round(layout.width),
          height: Math.round(layout.height),
          channels: 4,
          background: params.background || { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite(overlays)
        .png()
        .toBuffer();

      const uploadResult = await uploadFileToS3(canvasBuffer, filename, userId, "image/png");
      if (!uploadResult.success) {
        return { success: false, error: uploadResult.error || "Failed to upload composite to S3." };
      }

      return { success: true, imageUrl: uploadResult.url, filename };
    } catch (error: any) {
      console.error("Error compositing images:", error);
      return { success: false, error: `Failed to composite images: ${error.message}` };
    }
  }

  /**
   * Generate image using Google Gemini
   */
  private async generateWithGoogleGemini(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const axios = require('axios');
      
      const apiKey = await this.getApiKey("gemini-2.5-flash-image");
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });
      
      const inputImageCount = params.inputImages ? params.inputImages.length : 0;
      
      if (inputImageCount === 0) {
        // Text-to-image generation - use streaming (with retry for transient 503/429 errors)
        const streamResult = await this.retryWithBackoff(
          () => model.generateContentStream({
            contents: [{
              role: "user",
              parts: [{
                text: params.prompt
              }]
            }]
          }),
          { maxRetries: 3, baseDelayMs: 3000 }
        );
        
        // Get the async iterable stream - handle promise if needed
        let stream: any = streamResult;
        if (streamResult && typeof (streamResult as any).then === 'function') {
          stream = await streamResult;
        }
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
          stream = (stream as any)?.stream || stream;
        }
        
        // Process streaming response to find image data
        let imageData: string | undefined;
        let chunkCount = 0;
        for await (const chunk of stream) {
          chunkCount++;
          
          if (chunk.candidates && chunk.candidates.length > 0) {
            const candidate = chunk.candidates[0];
            if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                // Check for inlineData (camelCase) or inline_data (snake_case)
                if ((part as any).inlineData?.data) {
                  imageData = (part as any).inlineData.data;
                  break;
                } else if ((part as any).inline_data?.data) {
                  imageData = (part as any).inline_data.data;
                  break;
                }
              }
              if (imageData) break;
            }
          }
        }
        
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
        // Single image editing - use streaming for image generation
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
        
        // Use streaming for image generation (with retry for transient 503/429 errors)
        const streamResult = await this.retryWithBackoff(
          () => model.generateContentStream({
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
          }),
          { maxRetries: 3, baseDelayMs: 3000 }
        );
        
        // Get the async iterable stream - handle promise if needed
        let stream: any = streamResult;
        if (streamResult && typeof (streamResult as any).then === 'function') {
          stream = await streamResult;
        }
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
          stream = (stream as any)?.stream || stream;
        }
        
        // Process streaming response to find image data
        let imageData: string | undefined;
        let chunkCount = 0;
        for await (const chunk of stream) {
          chunkCount++;
          
          if (chunk.candidates && chunk.candidates.length > 0) {
            const candidate = chunk.candidates[0];
            if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                // Check for inlineData (camelCase) or inline_data (snake_case)
                if ((part as any).inlineData?.data) {
                  imageData = (part as any).inlineData.data;
                  break;
                } else if ((part as any).inline_data?.data) {
                  imageData = (part as any).inline_data.data;
                  break;
                }
              }
              if (imageData) break;
            }
          }
        }
        
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
        // Multiple image editing - use streaming for image generation
        const parts: any[] = [];
        
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
        
        // Use streaming for image generation (with retry for transient 503/429 errors)
        const streamResult = await this.retryWithBackoff(
          () => model.generateContentStream({
            contents: [{
              role: "user",
              parts: parts
            }]
          }),
          { maxRetries: 3, baseDelayMs: 3000 }
        );
        
        // Get the async iterable stream - handle promise if needed
        let stream: any = streamResult;
        if (streamResult && typeof (streamResult as any).then === 'function') {
          stream = await streamResult;
        }
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
          stream = (stream as any)?.stream || stream;
        }
        
        // Process streaming response to find image data
        let imageData: string | undefined;
        let chunkCount = 0;
        for await (const chunk of stream) {
          chunkCount++;
          
          if (chunk.candidates && chunk.candidates.length > 0) {
            const candidate = chunk.candidates[0];
            if (candidate.content && candidate.content.parts) {
              for (const part of candidate.content.parts) {
                // Check for inlineData (camelCase) or inline_data (snake_case)
                if ((part as any).inlineData?.data) {
                  imageData = (part as any).inlineData.data;
                  break;
                } else if ((part as any).inline_data?.data) {
                  imageData = (part as any).inline_data.data;
                  break;
                }
              }
              if (imageData) break;
            }
          }
        }
        
        if (!imageData) {
          console.error("❌ No image data in Google Gemini response");
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
   * Convert size parameter to aspect ratio for Gemini 3 Pro
   * Supports: 1:1, 9:16, 16:9, 3:4, 4:3, 3:2, 2:3, 5:4, 4:5, 21:9
   */
  private convertSizeToAspectRatio(size?: string): string {
    if (!size || size === 'auto') {
      return '1:1'; // Default aspect ratio
    }

    // If already in aspect ratio format (e.g., "16:9"), validate and return
    if (size.includes(':')) {
      const validRatios = ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'];
      if (validRatios.includes(size)) {
        return size;
      }
      // If it's a ratio format but not in the valid list, default to 1:1
      console.warn(`⚠️ Aspect ratio ${size} not supported, defaulting to 1:1`);
      return '1:1';
    }

    // Convert common size formats to aspect ratios
    // Format: "WIDTHxHEIGHT" (e.g., "1024x1024", "1536x1024")
    if (size.includes('x')) {
      const [width, height] = size.split('x').map(Number);
      if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
        // Calculate the ratio
        const ratio = width / height;
        
        // Map to closest supported aspect ratio
        const ratioMap: { [key: number]: string } = {
          1.0: '1:1',        // 1024x1024, 512x512, etc.
          0.5625: '9:16',    // 576x1024, 1080x1920, etc.
          1.7778: '16:9',    // 1920x1080, 1024x576, etc.
          0.75: '3:4',       // 768x1024, etc.
          1.3333: '4:3',     // 1024x768, etc.
          1.5: '3:2',        // 1536x1024, etc.
          0.6667: '2:3',     // 1024x1536, etc.
          1.25: '5:4',       // 1280x1024, etc.
          0.8: '4:5',        // 1024x1280, etc.
          2.3333: '21:9'     // 2560x1080, etc.
        };

        // Find closest ratio
        let closestRatio = '1:1';
        let minDiff = Infinity;
        for (const [targetRatio, aspectRatio] of Object.entries(ratioMap)) {
          const diff = Math.abs(ratio - parseFloat(targetRatio));
          if (diff < minDiff) {
            minDiff = diff;
            closestRatio = aspectRatio;
          }
        }

        return closestRatio;
      }
    }

    // Default to 1:1 if we can't parse the size
    console.warn(`⚠️ Could not parse size ${size}, defaulting to 1:1`);
    return '1:1';
  }

  /**
   * Generate image using Google Gemini 3 Pro Image
   */
  private async generateWithGoogleGemini3Pro(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    try {
      const { GoogleGenAI } = require('@google/genai');
      
      const modelId = params.imageModel || 'gemini-3-pro-image-preview';
      const apiKey = await this.getApiKey(modelId);
      const ai = new GoogleGenAI({
        apiKey: apiKey,
      });

      const model = modelId;
      const inputImageCount = params.inputImages ? params.inputImages.length : 0;
      
      // Convert size to aspect ratio
      const aspectRatio = this.convertSizeToAspectRatio(params.size);
      
      // Map quality parameter to imageSize for Gemini 3 Pro
      // low → 1K, medium → 2K, high → 4K
      // Default to medium (2K) if quality is not provided
      const qualityToImageSize: Record<string, string> = {
        'low': '1K',
        'medium': '2K',
        'high': '4K'
      };
      const imageSize = qualityToImageSize[params.quality || 'medium'] || '2K';
      
      // Configure image generation
      const config = {
        responseModalities: ['IMAGE', 'TEXT'],
        imageConfig: {
          aspectRatio: aspectRatio,
          imageSize: imageSize,
        },
      };

      // Build contents array
      const contents: any[] = [];
      
      if (inputImageCount === 0) {
        // Text-to-image generation
        contents.push({
          role: 'user',
          parts: [{
            text: params.prompt,
          }],
        });
      } else {
        // Image editing with input images
        const parts: any[] = [];
        
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
        
        contents.push({
          role: 'user',
          parts: parts
        });
      }

      // Generate content stream (with retry for transient 503/429 errors)
      const response: any = await this.retryWithBackoff(
        () => ai.models.generateContentStream({ model, config, contents }),
        { maxRetries: 3, baseDelayMs: 3000 }
      );

      // Process streaming response to find image data.
      //
      // Gemini 3 image models ("thinking" models, e.g. gemini-3-pro-image-preview
      // and gemini-3.1-flash-image-preview) emit up to two INTERIM draft images
      // before the final rendered image. Per Google's docs, "the last image within
      // Thinking is also the final rendered image", and interim drafts are flagged
      // with part.thought === true. We must therefore keep the LAST non-thought
      // image part — NOT the first. Keeping the first part returns a draft, which
      // on an edit closely resembles the input and appears to ignore the prompt.
      let imageData: string | undefined;
      let mimeType: string | undefined;
      let chunkCount = 0;

      for await (const chunk of response) {
        chunkCount++;

        if (!chunk.candidates || !chunk.candidates[0]?.content?.parts) {
          continue;
        }

        const parts = chunk.candidates[0].content.parts;
        for (const part of parts) {
          // Skip interim "thought" draft images so they never overwrite the final render.
          if ((part as any).thought) {
            continue;
          }
          const inlineData = (part as any).inlineData || (part as any).inline_data;
          if (inlineData?.data) {
            // Overwrite on each image part: the final render is the last one streamed.
            imageData = inlineData.data;
            mimeType = inlineData.mimeType || 'image/png';
          }
        }
      }

      if (!imageData) {
        console.error("❌ No image data in Google Gemini 3 Pro response");
        return {
          success: false,
          error: "No image data received from Google Gemini 3 Pro API. The model may not support image generation or the prompt may not be suitable for image generation."
        };
      }

      // Convert base64 to data URL
      const finalMimeType = mimeType || 'image/png';
      const imageUrl = `data:${finalMimeType};base64,${imageData}`;
      
      return {
        success: true,
        imageUrl: imageUrl,
        filename: params.filename
      };
      
    } catch (error: any) {
      console.error("Error with Google Gemini 3 Pro image generation:", error);
      return {
        success: false,
        error: `Google Gemini 3 Pro image generation failed: ${error.message || 'Unknown error'}`
      };
    }
  }

  /**
   * Generate image using Runway ML (Gen-4 or Gemini 2.5 Flash)
   */
  private async generateWithRunwayML(params: ImageGenerationParams, model: string = "gen4_image"): Promise<ImageGenerationResult> {
    try {
      const apiKey = await this.getApiKey(model);
      
      // Dynamically import Runway ML SDK
      const { default: RunwayML } = await import('@runwayml/sdk');
      
      const inputImageCount = params.inputImages ? params.inputImages.length : 0;
      
      // Initialize Runway ML client with API key
      const client = new RunwayML({ apiKey: apiKey });
      
      // Prepare request options
      const requestOptions: any = {
        model: model === 'gemini_2.5_flash' ? 'gemini_2.5_flash' : 'gen4_image',
        promptText: params.prompt,
      };
      
      // Handle size parameter - use ratio string as-is from client
      if (params.size && params.size !== 'auto') {
        requestOptions.ratio = params.size;
      }
      
      // Add reference images if provided (for image editing)
      if (inputImageCount > 0) {
        const referenceImages: { uri: string }[] = [];
        
        // Process each input image
        for (const imageUrl of params.inputImages!) {
          try {
            // Check if it's already a data URL
            if (imageUrl.startsWith('data:image/')) {
              referenceImages.push({ uri: imageUrl });
            } else {
              // Download and convert to base64 data URL
              const processedImage = await this.processInputImage(imageUrl);
              const imageBase64 = processedImage.buffer.toString('base64');
              const mimeType = processedImage.mimeType;
              const dataUrl = `data:${mimeType};base64,${imageBase64}`;
              referenceImages.push({ uri: dataUrl });
            }
          } catch (error: any) {
            console.error(`❌ Failed to process input image ${imageUrl}:`, error.message);
            return {
              success: false,
              error: `Failed to process input image: ${error.message}. Please check if the image URL is accessible.`
            };
          }
        }
        
        requestOptions.referenceImages = referenceImages;
      }
      
      // Create task and wait for output
      const task = await client.textToImage
        .create(requestOptions)
        .waitForTaskOutput();
      
      // Extract image URL from task output
      const taskAny = task as any;
      const imageUrl = taskAny.output[0];
      
      if (!imageUrl) {
        console.error("❌ Runway ML task output structure:", JSON.stringify(taskAny, null, 2));
        throw new Error("No image URL found in Runway ML task output");
      }
      
      return {
        success: true,
        imageUrl: imageUrl,
        filename: params.filename
      };
      
    } catch (error: any) {
      console.error("Error with Runway ML image generation:", error);
      
      // Provide more detailed error information
      let errorMessage = error.message || 'Unknown error';
      
      // Handle SDK-specific errors
      if (error.taskDetails) {
        errorMessage = `Task failed: ${JSON.stringify(error.taskDetails)}`;
      } else if (error.response) {
        errorMessage = `API returned ${error.response.status}: ${error.response.statusText}`;
        if (error.response.data) {
          try {
            const errorData = typeof error.response.data === 'string' 
              ? JSON.parse(error.response.data) 
              : error.response.data;
            if (errorData.message || errorData.error) {
              errorMessage += ` - ${errorData.message || errorData.error}`;
            }
          } catch {
            // Ignore JSON parse errors
          }
        }
      }
      
      return {
        success: false,
        error: `Runway ML image generation failed: ${errorMessage}`
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
          quality: (params.quality || 'medium') as any,
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
    const validQualities = ["low", "medium", "high"];
    if (params.quality && !validQualities.includes(params.quality)) {
      return {
        valid: false,
        error: `Invalid quality '${params.quality}'. Must be one of: ${validQualities.join(", ")}`,
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
      const defaultModel = "gemini-3-pro-image-preview";
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
