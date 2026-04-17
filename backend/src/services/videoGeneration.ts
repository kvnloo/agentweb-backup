import axios from "axios";
import { getSecret } from "../utils/secretsManager";
import { uploadFileToS3 } from "../utils/s3Utils";
import { remotionService, RemotionComposeParams } from "./remotionService";

interface VideoGenerationResult {
  success: boolean;
  videoUrl?: string;
  filename?: string;
  /** Present when the video was post-processed by Remotion */
  composedVideoUrl?: string;
  error?: string;
}

// Supported video generation models
const SUPPORTED_MODELS = [
  "veo-3.1-generate-preview",
  "veo-3.1-fast-generate-preview",
] as const;

type SupportedModel = typeof SUPPORTED_MODELS[number];

interface VideoGenerationParams {
  prompt: string;
  filename: string;
  userId: string;
  videoModel?: string; // Optional model parameter - must be one of the supported models
  startFrame?: string; // Optional: URL of the first frame image
  endFrame?: string; // Optional: URL of the last frame image
  /** Requested duration in seconds (passed to Veo API). Veo supports 5–8s; defaults to 8. */
  durationSeconds?: number;
  /** When true, post-process the generated clip with Remotion to add brand overlays */
  compose?: boolean;
  /** Brand overlay params — required when compose is true */
  composeParams?: Omit<RemotionComposeParams, "clipUrl" | "filename" | "userId">;
}

export class VideoService {
  constructor() {
    // No initialization needed - clients will be created as needed
  }

  /**
   * Get the API key from Secrets Manager for a specific model
   */
  private async getApiKey(model: string): Promise<string> {
    try {
      let secretName: string;
      
      if (model === "veo-3.1-generate-preview" || model === "veo-3.1-fast-generate-preview") {
        // Google Veo (both standard and fast models use the same API key)
        secretName = process.env.NODE_ENV === "development" 
          ? "dev/AgentWeb/Google/Video" 
          : "prod/AgentWeb/Google/Video";
      } else {
        // Default to Google Video
        secretName = process.env.NODE_ENV === "development" 
          ? "dev/AgentWeb/Google/Video" 
          : "prod/AgentWeb/Google/Video";
      }
      
      const apiKey = await getSecret(secretName);
      
      if (!apiKey) {
        throw new Error(`API key not found for model ${model} in secret ${secretName}`);
      }
      
      return apiKey;
    } catch (error: any) {
      console.error(`❌ Failed to get API key for ${model}:`, error.message);
      throw new Error(`Failed to get API key for ${model}: ${error.message}`);
    }
  }

  /**
   * Process input image (start or end frame) from URL
   */
  private async processInputImage(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    try {
      // Download the image from URL
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      
      const imageBuffer = Buffer.from(response.data as ArrayBuffer);
      
      // Try to determine MIME type from response headers
      let mimeType: string = 'image/png'; // Default to PNG
      const contentType = response.headers['content-type'];
      if (contentType && contentType.startsWith('image/')) {
        mimeType = contentType;
      }

      return { buffer: imageBuffer, mimeType };
    } catch (error: any) {
      console.error('❌ Failed to process input image:', error.message);
      throw new Error(`Failed to process input image: ${error.message}`);
    }
  }

  /**
   * Download a file from Google GenAI and upload to S3
   */
  private async downloadAndUploadVideo(
    ai: any,
    file: any,
    filename: string,
    userId: string
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      
      // Create a temporary file path
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(tempDir, `video-${Date.now()}-${Math.random().toString(36).substring(7)}.mp4`);
      
      try {
        // Use the SDK's download method to save the file
        // Based on the sample: ai.files.download({ file, downloadPath })
        await ai.files.download({
          file: file,
          downloadPath: tempFilePath,
        });

        // Read the downloaded file
        const videoBuffer = fs.readFileSync(tempFilePath);
        
        // Upload to S3
        const uploadResult = await uploadFileToS3(
          videoBuffer,
          filename,
          userId,
          'video/mp4'
        );

        // Clean up temporary file
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          console.warn('Failed to cleanup temp file:', cleanupError);
        }

        if (uploadResult.success && uploadResult.url) {
          return {
            success: true,
            url: uploadResult.url
          };
        } else {
          return {
            success: false,
            error: uploadResult.error || 'Failed to upload video to S3'
          };
        }
      } catch (downloadError: any) {
        // Clean up temp file if it was created
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        
        // Fallback: try to download via HTTP if SDK download fails
        if (file.uri) {
          console.log('Falling back to HTTP download...');
          const apiKey = await this.getApiKey('veo-3.1-generate-preview');
          const downloadResponse = await axios.get(file.uri, {
            responseType: 'arraybuffer',
            headers: {
              'Authorization': `Bearer ${apiKey}`
            },
            timeout: 300000, // 5 minutes timeout for video downloads
          });
          
          const buffer = Buffer.from(downloadResponse.data as ArrayBuffer);
          
          // Upload to S3
          const uploadResult = await uploadFileToS3(
            buffer,
            filename,
            userId,
            'video/mp4'
          );

          if (uploadResult.success && uploadResult.url) {
            return {
              success: true,
              url: uploadResult.url
            };
          } else {
            return {
              success: false,
              error: uploadResult.error || 'Failed to upload video to S3'
            };
          }
        } else {
          throw downloadError;
        }
      }
    } catch (error: any) {
      console.error('❌ Failed to download and upload video:', error.message);
      return {
        success: false,
        error: `Failed to download and upload video: ${error.message}`
      };
    }
  }

  /**
   * Generate a video using Google Veo 3.1
   */
  private async generateWithVeo31(params: VideoGenerationParams): Promise<VideoGenerationResult> {
    try {
      const { GoogleGenAI } = require('@google/genai');
      
      const apiKey = await this.getApiKey("veo-3.1-generate-preview");
      let ai = new GoogleGenAI({
        apiKey: apiKey,
      });

      const model = 'veo-3.1-generate-preview';
      
      // Prepare the generation config
      const config: any = {};
      
      // Process start frame (first_frame) if provided
      // The generateVideos API expects image as Image type with imageBytes (base64) and mimeType
      let firstFrameImage: { imageBytes: string; mimeType: string } | null = null;
      if (params.startFrame) {
        try {
          const processedImage = await this.processInputImage(params.startFrame);
          
          // Convert buffer to base64 for the API
          // The SDK expects Image type with imageBytes (base64) and mimeType
          const base64String = processedImage.buffer.toString('base64');
          
          firstFrameImage = {
            imageBytes: base64String,
            mimeType: processedImage.mimeType,
          };
        } catch (error: any) {
          console.error(`❌ Failed to process start frame:`, error.message);
          return {
            success: false,
            error: `Failed to process start frame: ${error.message}`
          };
        }
      }

      // Process end frame (lastFrame) if provided
      // The generateVideos API expects lastFrame in config (camelCase for Node SDK)
      // Using imageBytes like the start frame - both use Image_2 type with {imageBytes: string, mimeType: string}
      let lastFrameImage: { imageBytes: string; mimeType: string } | null = null;
      if (params.endFrame) {
        try {
          const processedImage = await this.processInputImage(params.endFrame);
          
          // Convert buffer to base64 for the API
          const base64String = processedImage.buffer.toString('base64');
          
          lastFrameImage = {
            imageBytes: base64String,
            mimeType: processedImage.mimeType,
          };
        } catch (error: any) {
          console.error(`❌ Failed to process end frame:`, error.message);
          return {
            success: false,
            error: `Failed to process end frame: ${error.message}`
          };
        }
      }

      // Build the generation request
      // Based on the Python sample: client.models.generate_videos(model="veo-3.1-generate-preview", prompt=prompt, image=first_image, config=types.GenerateVideosConfig(last_frame=last_image))
      // Note: In Node.js SDK, use camelCase 'lastFrame' (not snake_case 'last_frame') and 'imageBytes' (not 'bytesBase64Encoded')
      const generateRequest: any = {
        model: model,
        prompt: params.prompt,
      };

      // Add start frame (image) if provided
      if (firstFrameImage) {
        generateRequest.image = firstFrameImage;
      }

      // Add end frame to config if provided
      // Note: Use camelCase 'lastFrame' (not 'last_frame')
      if (lastFrameImage) {
        config.lastFrame = lastFrameImage;
      }

      // Add duration if provided (Veo supports 5–8 seconds)
      if (params.durationSeconds) {
        config.durationSeconds = Math.min(8, Math.max(5, params.durationSeconds));
        console.log(`VideoService: Requesting durationSeconds=${config.durationSeconds} from Veo`);
      }

      // Add config if we have any config options (including lastFrame)
      if (Object.keys(config).length > 0) {
        generateRequest.config = config;
      }

      // Start the video generation operation
      let operation;
      try {
        operation = await ai.models.generateVideos(generateRequest);
      } catch (error: any) {
        // Check if it's a quota exhausted error (429)
        // Error can be: error.status === 429, error.error?.code === 429, or error.message contains quota/exceeded
        const isQuotaError = error.status === 429 || 
                             error.error?.code === 429 || 
                             (error.message && typeof error.message === 'string' && error.message.includes('quota') && error.message.includes('exceeded'));
        
        if (isQuotaError) {
          console.log('⚠️ Quota exhausted for veo-3.1-generate-preview, falling back to veo-3.1-fast-generate-preview...');
          
          // Fallback to fast model
          const fastModel = 'veo-3.1-fast-generate-preview';
          const fastApiKey = await this.getApiKey(fastModel);
          const fastAi = new GoogleGenAI({
            apiKey: fastApiKey,
          });
          
          // Update the request to use the fast model
          generateRequest.model = fastModel;
          
          console.log('Retrying with fast model:', fastModel);
          operation = await fastAi.models.generateVideos(generateRequest);
          
          // Use the fast AI client for polling too
          ai = fastAi;
        } else {
          // Re-throw if it's not a quota error
          throw error;
        }
      }
      
      // Poll the operation status until the video is ready
      const maxPollAttempts = 120; // 20 minutes max (120 * 10 seconds)
      let pollAttempts = 0;
      
      while (!operation.done && pollAttempts < maxPollAttempts) {
        console.log(`Waiting for video generation to complete... (attempt ${pollAttempts + 1}/${maxPollAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
        
        operation = await ai.operations.getVideosOperation({
          operation: operation,
        });
        
        pollAttempts++;
      }

      if (!operation.done) {
        return {
          success: false,
          error: 'Video generation timed out after 20 minutes'
        };
      }

      // Check if there was an error
      if (operation.error) {
        return {
          success: false,
          error: `Video generation failed: ${JSON.stringify(operation.error)}`
        };
      }

      // Check if videos were filtered by RAI policies
      if (operation.response?.raiMediaFilteredCount && operation.response.raiMediaFilteredCount > 0) {
        const reasons = operation.response.raiMediaFilteredReasons || [];
        const errorMessage = reasons.length > 0 
          ? reasons.join(' ') 
          : 'Video generation was filtered by content policies';
        return {
          success: false,
          error: errorMessage
        };
      }

      // Check if generation was successful
      if (!operation.response || !operation.response.generatedVideos || operation.response.generatedVideos.length === 0) {
        return {
          success: false,
          error: 'Video generation completed but no video was returned'
        };
      }

      // Get the generated video
      const generatedVideo = operation.response.generatedVideos[0];
      if (!generatedVideo.video) {
        return {
          success: false,
          error: 'Video generation completed but video file is missing'
        };
      }

      // Download and upload the video to S3
      console.log('Downloading generated video...');
      const uploadResult = await this.downloadAndUploadVideo(
        ai,
        generatedVideo.video,
        params.filename,
        params.userId
      );

      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          error: uploadResult.error || 'Failed to upload video to S3'
        };
      }

      return {
        success: true,
        videoUrl: uploadResult.url,
        filename: params.filename
      };

    } catch (error: any) {
      // Check if it's a quota exhausted error that wasn't caught earlier
      if (error.status === 429 || (error.error?.code === 429) || (error.message?.includes('quota') && error.message?.includes('exceeded'))) {
        console.log('⚠️ Quota exhausted error caught in outer catch, this should have been handled earlier');
        return {
          success: false,
          error: `Video generation quota exhausted. Please try again later or contact support.`
        };
      }
      
      console.error('❌ Error generating video with Veo 3.1:', error);
      return {
        success: false,
        error: `Failed to generate video: ${error.message || 'Unknown error'}`
      };
    }
  }

  /**
   * Generate a video using various AI models
   */
  async generateVideo(
    params: VideoGenerationParams
  ): Promise<VideoGenerationResult> {
    try {
      // Determine which model to use before validation
      // If model not defined, use veo-3.1-generate-preview as default
      if (!params.videoModel) {
        params.videoModel = "veo-3.1-generate-preview";
      }
      
      // Validate the provided model
      if (!SUPPORTED_MODELS.includes(params.videoModel as SupportedModel)) {
        return {
          success: false,
          error: `Invalid videoModel '${params.videoModel}'. Must be one of: ${SUPPORTED_MODELS.join(", ")}`,
        };
      }
      
      // Validate required parameters
      if (!params.prompt || !params.prompt.trim()) {
        return {
          success: false,
          error: 'Prompt is required for video generation'
        };
      }

      if (!params.filename || !params.filename.trim()) {
        return {
          success: false,
          error: 'Filename is required for video generation'
        };
      }

      // Ensure filename ends with .mp4
      if (!params.filename.toLowerCase().endsWith('.mp4')) {
        params.filename = `${params.filename}.mp4`;
      }

      // Determine which model to use for generation
      const modelToUse = params.videoModel;
      
      // Determine how many clips to generate
      // Veo supports max 8s per clip; for longer videos generate multiple clips in parallel
      const VEO_MAX_SECONDS = 8;
      const requestedDuration = params.durationSeconds ?? VEO_MAX_SECONDS;
      const perClipDuration = Math.min(VEO_MAX_SECONDS, Math.max(5, requestedDuration > VEO_MAX_SECONDS ? VEO_MAX_SECONDS : requestedDuration));
      const clipCount = requestedDuration > VEO_MAX_SECONDS ? Math.ceil(requestedDuration / VEO_MAX_SECONDS) : 1;

      console.log(`VideoService: Generating ${clipCount} clip(s) × ${perClipDuration}s for requested ${requestedDuration}s`);

      // Generate video
      let result: VideoGenerationResult;
      try {
        let clipUrls: string[] = [];

        if (modelToUse === "veo-3.1-generate-preview") {
          if (clipCount === 1) {
            result = await this.generateWithVeo31({ ...params, durationSeconds: perClipDuration });
            if (result.success && result.videoUrl) {
              clipUrls = [result.videoUrl];
            }
          } else {
            // Generate all clips concurrently with the per-clip duration
            const clipParams = { ...params, durationSeconds: perClipDuration };
            const clipResults = await Promise.all(
              Array.from({ length: clipCount }, (_, i) =>
                this.generateWithVeo31({
                  ...clipParams,
                  filename: `${params.filename.replace(/\.mp4$/i, '')}_clip${i + 1}.mp4`,
                })
              )
            );

            // Check if any failed
            const failed = clipResults.find((r) => !r.success);
            if (failed) {
              result = failed;
            } else {
              clipUrls = clipResults.map((r) => r.videoUrl!);
              result = { success: true, videoUrl: clipUrls[0], filename: params.filename };
            }
          }
        } else {
          result = {
            success: false,
            error: `Unsupported model: ${modelToUse}`
          };
        }

        // Post-process with Remotion if requested and Veo succeeded
        if (result.success && clipUrls.length > 0 && params.compose && params.composeParams) {
          console.log(`VideoService: Composing ${clipUrls.length} clip(s) with Remotion...`);
          const composeResult = await remotionService.compose({
            ...params.composeParams,
            clipUrl: clipUrls[0],
            extraClipUrls: clipUrls.slice(1),
            clipDurationSeconds: perClipDuration,
            filename: params.filename,
            userId: params.userId,
          });

          if (composeResult.success && composeResult.videoUrl) {
            // Return both URLs: raw clip and composed final video
            result = {
              ...result,
              composedVideoUrl: composeResult.videoUrl,
              // Callers get the composed video as the primary URL
              videoUrl: composeResult.videoUrl,
              filename: composeResult.filename ?? result.filename,
            };
          } else {
            // Composition failed — log a warning but still return the raw clip
            console.warn(`VideoService: Remotion composition failed (${composeResult.error}), returning raw clip`);
          }
        }

        return result;
      } catch (error: any) {
        console.error(`❌ Error in video generation with ${modelToUse}:`, error);
        return {
          success: false,
          error: `Video generation failed: ${error.message || 'Unknown error'}`
        };
      }
    } catch (error: any) {
      console.error('❌ Error in generateVideo:', error);
      return {
        success: false,
        error: error.message || 'Unknown error occurred during video generation'
      };
    }
  }

  /**
   * Check if the video generation service is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Try to get the API key to verify the service is configured
      await this.getApiKey("veo-3.1-generate-preview");
      return true;
    } catch (error: any) {
      console.warn("⚠️ Video generation service not available:", error.message);
      return false;
    }
  }
}

// Create a singleton instance with error handling
let videoService: VideoService;

try {
  videoService = new VideoService();
  console.log("✅ Video Service initialized successfully");
} catch (error) {
  console.warn("⚠️ Failed to initialize Video Service, creating fallback service");
  
  // Create a fallback service that always returns false for isAvailable
  videoService = {
    isAvailable: async () => false,
    generateVideo: async () => ({ success: false, error: "Service not available" })
  } as any;
}

export { videoService };

