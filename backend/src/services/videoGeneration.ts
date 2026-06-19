import axios from "axios";
import { getSecret } from "../utils/secretsManager";
import { uploadFileToS3 } from "../utils/s3Utils";
import { remotionService, RemotionComposeParams } from "./remotionService";
import { imageService } from "./imageGeneration";
import { McpClientService } from "../mcp/client/mcpClientService";

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
  "seedance-2.0",
] as const;

type SupportedModel = typeof SUPPORTED_MODELS[number];

// Seedance 2.0 is served only through Higgsfield's hosted MCP server (registered in
// the admin MCP Servers tab as "higgsfield", OAuth). The name is overridable via env.
const HIGGSFIELD_MCP_SERVER = process.env.HIGGSFIELD_MCP_SERVER_NAME || "higgsfield";

// Maps our internal model id → the Higgsfield MCP catalog id (from models_explore).
const HIGGSFIELD_MODEL_IDS: Record<string, string> = {
  "seedance-2.0": "seedance_2_0",
};

const isHiggsfieldModel = (model: string): boolean =>
  Object.prototype.hasOwnProperty.call(HIGGSFIELD_MODEL_IDS, model);

// Seedance 2.0 capability sets (confirmed via models_explore). The UI dropdowns and
// backend validation both source these so they can't drift.
export const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const SEEDANCE_ASPECT_RATIOS = ["auto", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
const SEEDANCE_MIN_DURATION = 4;
const SEEDANCE_MAX_DURATION = 15;
const DEFAULT_VIDEO_MODEL = "seedance-2.0";

// Time budgets are LENGTH-DRIVEN — generation time scales with output length (more
// frames = more compute), so the budget does too. No env knobs: duration is the only
// input. Generous on purpose (image-to-video, references, and queue wait add overhead
// on top of raw length); calibrate from the fat logs rather than guessing tighter.
//
// Applies to both surfaces (Emma chat + /videos) since both run through generateVideo.
// /videos has no turn cap (45-min worker limit), so long budgets run free there; Emma
// chat's 600s turn cap still bounds a turn independently if a long video runs there.

/** Clamp to Seedance's supported 4–15s range (also what we ever request). */
const budgetSeconds = (durationSeconds?: number): number =>
  Math.max(SEEDANCE_MIN_DURATION, Math.min(SEEDANCE_MAX_DURATION, Math.round(durationSeconds ?? 8)));

/** Veo fallback reserve (ms): scales with clip count (Veo caps at 8s/clip → ceil(secs/8) clips). */
export function veoFallbackReserveMs(durationSeconds?: number): number {
  const secs = budgetSeconds(durationSeconds);
  const clips = secs > 8 ? Math.ceil(secs / 8) : 1;
  return clips * 150_000; // ~150s per Veo clip (generate + poll)
}

/** Whole-op wall-clock budget (ms): generous Seedance allowance (base + per-second) plus the Veo reserve. */
export function videoTotalBudgetMs(durationSeconds?: number): number {
  const secs = budgetSeconds(durationSeconds);
  const seedance = 150_000 + secs * 45_000; // base overhead + generous per output-second
  return seedance + veoFallbackReserveMs(secs);
}

/**
 * Poll budget (ms) for the Seedance attempt: whatever's left before the deadline after
 * reserving the (length-scaled) Veo fallback time. Returns 0 → skip polling, go to Veo.
 */
export function seedancePollBudgetMs(now: number, deadlineMs: number, durationSeconds?: number): number {
  return Math.max(0, deadlineMs - now - veoFallbackReserveMs(durationSeconds));
}

/** Time (ms) left until `deadlineMs`, floored at 0. */
export function remainingBudgetMs(now: number, deadlineMs: number): number {
  return Math.max(0, deadlineMs - now);
}

// Veo 3.1 only supports a subset of Seedance's aspect ratios (auto / 16:9 / 9:16).
// The UI offers the full Seedance set; when Seedance fails and we fall back to Veo,
// map the chosen ratio to the closest Veo-supported one so orientation is preserved.
export const VEO_ASPECT_RATIOS = ["auto", "16:9", "9:16"] as const;

const aspectToNumber = (a: string): number => {
  const [w, h] = a.split(":").map(Number);
  return w && h ? w / h : NaN;
};

/** Map any Seedance aspect ratio to the nearest Veo-supported ratio (auto/16:9/9:16). */
export function closestVeoAspectRatio(aspect?: string): string {
  if (!aspect || aspect === "auto") return "auto";
  if ((VEO_ASPECT_RATIOS as readonly string[]).includes(aspect)) return aspect;
  const target = aspectToNumber(aspect);
  if (!isFinite(target)) return "auto";
  let best = "16:9";
  let bestDiff = Infinity;
  for (const c of ["16:9", "9:16"]) {
    const diff = Math.abs(aspectToNumber(c) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

// Lazy singleton MCP client for backend tool calls (createTransport attaches the
// OAuth authProvider + auto-refresh for the "higgsfield" server automatically).
let mcpClientSingleton: McpClientService | null = null;
const getMcpClient = (): McpClientService => {
  if (!mcpClientSingleton) mcpClientSingleton = new McpClientService();
  return mcpClientSingleton;
};

// Extract the JSON payload from an MCP tool result (prefers structuredContent,
// falls back to parsing the first text content block).
const parseMcpResult = (result: any): any => {
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.find((c: any) => c?.type === "text")?.text
    : undefined;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return undefined;
};

// Pull the single "generation" object from a Higgsfield tool result. The success
// wrapper differs by tool (confirmed via outputSchema):
//   generate_video / job_display → structuredContent.results (ARRAY) → take [0]
//   job_status                   → structuredContent.generation (single OBJECT)
const extractGeneration = (result: any): any => {
  const sc = parseMcpResult(result);
  if (!sc || typeof sc !== "object") return undefined;
  if (Array.isArray(sc.results)) return sc.results[0];
  if (sc.generation) return sc.generation;
  return undefined;
};

// The finished video URL lives on the generation's inner `results` object.
// rawUrl is the full-res file (confirmed primary); minUrl/thumbnailUrl are fallbacks.
const extractVideoUrl = (generation: any): string | undefined => {
  const r = generation?.results;
  if (!r || typeof r !== "object") return undefined;
  return r.rawUrl || r.minUrl || r.thumbnailUrl;
};

const clampDuration = (seconds: number): number =>
  Math.max(SEEDANCE_MIN_DURATION, Math.min(SEEDANCE_MAX_DURATION, Math.round(seconds)));

interface VideoGenerationParams {
  prompt: string;
  filename: string;
  userId: string;
  videoModel?: string; // Optional model parameter - must be one of the supported models
  startFrame?: string; // Optional: URL of the first frame image
  endFrame?: string; // Optional: URL of the last frame image
  /** Requested duration in seconds (passed to Veo API). Veo supports 5–8s; defaults to 8. */
  durationSeconds?: number;
  /**
   * When true and clipCount > 1, generate N+1 keyframe images before generating clips.
   * Clip[i] gets startFrame=keyframes[i], endFrame=keyframes[i+1], so Veo interpolates
   * between AI-generated visual waypoints — producing smooth, visually coherent transitions.
   */
  useKeyframes?: boolean;
  /** When true, post-process the generated clip with Remotion to add brand overlays */
  compose?: boolean;
  /** Brand overlay params — required when compose is true */
  composeParams?: Omit<RemotionComposeParams, "clipUrl" | "filename" | "userId">;
  /** Seedance aspect ratio (one of SEEDANCE_ASPECT_RATIOS). Defaults to "auto". */
  aspectRatio?: string;
  /** Seedance output resolution (one of SEEDANCE_RESOLUTIONS). Defaults to "720p". */
  resolution?: string;
  /**
   * Internal: absolute epoch-ms hard stop for the WHOLE video op (Seedance + Veo
   * fallback). Set once by generateVideo and propagated through the Seedance attempt
   * and the Veo fallback so their combined wall-clock stays under the turn cap.
   */
  deadlineMs?: number;
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

      // Honor the requested aspect ratio, mapped to the nearest Veo-supported value
      // (the UI offers the full Seedance set; Veo only does 16:9/9:16). 'auto' is left
      // unset so Veo defaults / matches the input frame.
      const veoAspect = closestVeoAspectRatio(params.aspectRatio);
      if (veoAspect === "16:9" || veoAspect === "9:16") {
        config.aspectRatio = veoAspect;
        console.log(`VideoService: Veo aspect ratio set to ${veoAspect} (from requested "${params.aspectRatio ?? "auto"}")`);
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
      
      // Poll the operation status until the video is ready.
      // Bound by the whole-op deadline (shared with any Seedance attempt that ran
      // first) so the turn never overruns the agent-mode cap; the attempt count is a
      // secondary safety cap. When called standalone (no deadline) fall back to 20 min.
      const maxPollAttempts = 120; // 20 minutes max (120 * 10 seconds)
      const deadlineMs = params.deadlineMs ?? (Date.now() + videoTotalBudgetMs(params.durationSeconds));
      let pollAttempts = 0;

      while (!operation.done && pollAttempts < maxPollAttempts && Date.now() < deadlineMs) {
        console.log(`Waiting for video generation to complete... (attempt ${pollAttempts + 1}/${maxPollAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds

        operation = await ai.operations.getVideosOperation({
          operation: operation,
        });

        pollAttempts++;
      }

      if (!operation.done) {
        const budgetExceeded = Date.now() >= deadlineMs;
        console.warn(
          `VideoService: Veo generation did not finish — ${budgetExceeded ? 'exceeded its time budget' : 'timed out after 20 minutes'} ` +
          `(${pollAttempts} poll attempts)`
        );
        return {
          success: false,
          error: budgetExceeded
            ? 'Video generation exceeded its time budget'
            : 'Video generation timed out after 20 minutes'
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
   * Download a video from an HTTP(S) URL and upload it to S3.
   * Used by providers (e.g. Higgsfield) that return a hosted video URL rather than
   * an SDK file handle.
   */
  private async downloadUrlAndUploadVideo(
    videoUrl: string,
    filename: string,
    userId: string
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
      const downloadResponse = await axios.get(videoUrl, {
        responseType: "arraybuffer",
        timeout: 300000, // 5 minutes for large video downloads
      });
      const buffer = Buffer.from(downloadResponse.data as ArrayBuffer);
      const uploadResult = await uploadFileToS3(buffer, filename, userId, "video/mp4");
      if (uploadResult.success && uploadResult.url) {
        return { success: true, url: uploadResult.url };
      }
      return { success: false, error: uploadResult.error || "Failed to upload video to S3" };
    } catch (error: any) {
      console.error("❌ Failed to download and upload video from URL:", error.message);
      return { success: false, error: `Failed to download video: ${error.message}` };
    }
  }

  /**
   * Generate a video using Higgsfield (e.g. ByteDance Seedance 2.0).
   *
   * Higgsfield models are image-to-video, so an input image is required. When no
   * startFrame is supplied we generate a first frame from the prompt using the image
   * service, mirroring the keyframe approach used elsewhere in this service.
   *
   * The Higgsfield API is an async queue: POST returns a request_id + status_url, which
   * we poll until the job reaches a terminal state (completed/failed/nsfw).
   */
  private async generateWithHiggsfield(
    params: VideoGenerationParams
  ): Promise<VideoGenerationResult> {
    try {
      const model = params.videoModel || DEFAULT_VIDEO_MODEL;
      const modelId = HIGGSFIELD_MODEL_IDS[model];
      if (!modelId) {
        return { success: false, error: `No Higgsfield MCP model id configured for '${model}'` };
      }

      const mcp = getMcpClient();

      // Build the generate_video params (all args nest under a single `params` object;
      // only `model` is required). Resolution/aspect ratio come from the user; defaults
      // match Seedance's own (720p / auto) when unset.
      const resolution = SEEDANCE_RESOLUTIONS.includes(params.resolution as any)
        ? (params.resolution as string)
        : "720p";
      const aspectRatio = SEEDANCE_ASPECT_RATIOS.includes(params.aspectRatio as any)
        ? (params.aspectRatio as string)
        : "auto";

      const seedanceParams: Record<string, any> = {
        model: modelId,
        prompt: params.prompt,
        duration: clampDuration(params.durationSeconds ?? 8),
        resolution,
        aspect_ratio: aspectRatio,
      };

      // Run the entire job over ONE MCP session (media import → submit → poll →
      // display) so the streamable-HTTP connection + OAuth isn't re-established per
      // call (which previously caused reconnect/abort loops and the 600s timeout).
      const outcome = await mcp.withServerSession(HIGGSFIELD_MCP_SERVER, async (callTool) => {
        // Image-to-video: register start/end frames with Higgsfield (URL import is
        // single-step → returns a ready media_id) and pass them as medias references.
        // `medias[].value` must be a media_id, never a raw URL.
        const medias: Array<{ value: string; role: string }> = [];
        if (params.startFrame) {
          medias.push({ value: await this.importHiggsfieldMedia(callTool, params.startFrame), role: "start_image" });
        }
        if (params.endFrame) {
          medias.push({ value: await this.importHiggsfieldMedia(callTool, params.endFrame), role: "end_image" });
        }
        if (medias.length) {
          seedanceParams.medias = medias;
        }

        // Submit — returns a job id (async).
        const submitRaw = await callTool("generate_video", { params: seedanceParams }, { timeoutMs: 120000 });
        // The job id is `generation.id` (same key in every tool's payload).
        const submitGen = extractGeneration(submitRaw);
        const jobId = submitGen?.id;
        if (!jobId) {
          console.error("Seedance generate_video returned no job id; raw:", JSON.stringify(submitRaw)?.slice(0, 2000));
          return { ok: false as const, error: "Seedance did not return a job id (check credits/auth)" };
        }

        // Poll job_status until terminal. completed = done; failed/canceled/nsfw =
        // terminal failure; ip_detected = gated (treated as failure → Veo fallback).
        // Bounded by a wall-clock budget that stays under the agent-mode cap.
        const maxPollAttempts = 240; // safety cap; the real bound is the time budget
        const failStates = new Set(["failed", "canceled", "nsfw"]);
        // Grant Seedance only what we can spend while still reserving time for a Veo
        // fallback before the whole-op deadline — so a Seedance hang can't starve Veo.
        const pollBudgetMs = params.deadlineMs !== undefined
          ? seedancePollBudgetMs(Date.now(), params.deadlineMs, params.durationSeconds)
          : (videoTotalBudgetMs(params.durationSeconds) - veoFallbackReserveMs(params.durationSeconds));
        const deadline = Date.now() + pollBudgetMs;
        console.log(`VideoService: Seedance job ${jobId} polling with a ${Math.round(pollBudgetMs / 1000)}s budget (requested ${params.durationSeconds ?? 8}s video)`);
        let status = (submitGen?.status || "").toString().toLowerCase();
        let resultUrl: string | undefined = extractVideoUrl(submitGen);
        let backoffMs = 10000;
        let timedOut = false;

        for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
          if (status === "completed" || status === "ip_detected" || failStates.has(status)) break;
          if (Date.now() >= deadline) {
            timedOut = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          // job_status requires the camelCase `jobId` (confirmed against the live MCP
          // schema). Sending `job_id` fails validation → empty status → spurious timeout.
          const statusRaw = await callTool("job_status", { jobId }, { timeoutMs: 60000 });
          const statusSc = parseMcpResult(statusRaw);
          const gen = extractGeneration(statusRaw);
          status = (gen?.status || "").toString().toLowerCase();
          resultUrl = extractVideoUrl(gen) || resultUrl;
          // Respect server-provided backoff (poll_after_seconds), clamped to 2–30s.
          if (typeof statusSc?.poll_after_seconds === "number" && statusSc.poll_after_seconds > 0) {
            backoffMs = Math.max(2000, Math.min(30000, statusSc.poll_after_seconds * 1000));
          }
        }

        if (timedOut && status !== "completed") {
          const remainingForVeo = params.deadlineMs !== undefined ? remainingBudgetMs(Date.now(), params.deadlineMs) : 0;
          console.warn(
            `VideoService: Seedance job ${jobId} exceeded its ${Math.round(pollBudgetMs / 1000)}s budget ` +
            `(last status "${status}") — failing over to Veo with ~${Math.round(remainingForVeo / 1000)}s left`
          );
          return {
            ok: false as const,
            error: `Seedance generation exceeded the ${Math.round(pollBudgetMs / 1000)}s budget`,
          };
        }

        if (failStates.has(status)) {
          return {
            ok: false as const,
            error:
              status === "nsfw"
                ? "Video generation was blocked by content policies (NSFW)"
                : "Seedance video generation failed",
          };
        }
        if (status === "ip_detected") {
          return { ok: false as const, error: "Seedance generation is gated by IP detection and needs manual review" };
        }

        // Pull the final URL via job_display if job_status didn't include it.
        if (!resultUrl) {
          // job_display requires `id` (confirmed against the live MCP schema).
          const displayRaw = await callTool("job_display", { id: jobId }, { timeoutMs: 60000 });
          resultUrl = extractVideoUrl(extractGeneration(displayRaw));
        }
        if (!resultUrl) {
          return { ok: false as const, error: "Seedance generation did not return a video URL (or timed out)" };
        }
        return { ok: true as const, url: resultUrl };
      });

      if (!outcome.ok) {
        return { success: false, error: outcome.error };
      }

      // Download the hosted video and re-upload to our S3 bucket (outside the MCP session).
      const uploadResult = await this.downloadUrlAndUploadVideo(outcome.url, params.filename, params.userId);
      if (!uploadResult.success || !uploadResult.url) {
        return { success: false, error: uploadResult.error || "Failed to upload video to S3" };
      }

      return { success: true, videoUrl: uploadResult.url, filename: params.filename };
    } catch (error: any) {
      const detail = error?.message || String(error);
      console.error("❌ Error generating video with Seedance (Higgsfield MCP):", detail);
      // Surface auth/credit problems clearly so the Veo fallback can engage.
      return { success: false, error: `Seedance (Higgsfield MCP) failed: ${detail}` };
    }
  }

  /**
   * Import an image URL into Higgsfield via the MCP `media_import_url` tool, using
   * the caller's open session. URL import is single-step (no media_confirm needed)
   * and returns a ready media_id.
   */
  private async importHiggsfieldMedia(
    callTool: (toolName: string, args: Record<string, any>, opts?: { timeoutMs?: number }) => Promise<any>,
    url: string
  ): Promise<string> {
    const raw = await callTool("media_import_url", { url, type: "image" }, { timeoutMs: 120000 });
    const data = parseMcpResult(raw);
    const mediaId = data?.media_id || data?.id;
    if (!mediaId) {
      throw new Error("media_import_url did not return a media_id");
    }
    return mediaId;
  }

  /**
   * Generate N+1 keyframe images for a multi-clip video sequence.
   * Frame i is the start of clip i; frame i+1 is its end, which is also the start of clip i+1.
   * All frames are generated in parallel using the image service.
   *
   * @param prompt  The video prompt — each frame description is derived from this
   * @param clipCount  Number of video clips (we generate clipCount+1 frames)
   * @param filenameBase  Base filename without extension (e.g. "my_video")
   * @param userId  Used for S3 path scoping by the image service
   * @returns Array of image URLs (length = clipCount+1), or null if generation failed
   */
  private async generateKeyframes(
    prompt: string,
    clipCount: number,
    filenameBase: string,
    userId: string
  ): Promise<string[] | null> {
    const frameCount = clipCount + 1;
    console.log(`VideoService: Generating ${frameCount} keyframes for ${clipCount}-clip sequence`);

    // Build per-frame prompts that describe temporal progression through the scene
    const framePrompts = Array.from({ length: frameCount }, (_, i) => {
      const pct = Math.round((i / (frameCount - 1)) * 100);
      if (i === 0) {
        return `Opening frame (0%) of a video scene: ${prompt}. Cinematic still frame, 16:9 aspect ratio, photorealistic.`;
      } else if (i === frameCount - 1) {
        return `Closing frame (100%) of a video scene: ${prompt}. Cinematic still frame, 16:9 aspect ratio, photorealistic.`;
      } else {
        return `Mid-scene frame (${pct}% through the scene) of a video: ${prompt}. Cinematic still frame, 16:9 aspect ratio, photorealistic.`;
      }
    });

    try {
      const results = await Promise.all(
        framePrompts.map((fp, i) =>
          imageService.generateImage({
            prompt: fp,
            filename: `${filenameBase}_kf${i + 1}.png`,
            size: "16:9",
            userId,
          })
        )
      );

      // If any frame failed, log and return null (caller falls back to no-keyframe generation)
      const failed = results.find((r) => !r.success);
      if (failed) {
        console.warn(`VideoService: Keyframe generation failed: ${failed.error} — falling back to no-keyframe mode`);
        return null;
      }

      const urls = results.map((r) => r.imageUrl!);
      console.log(`VideoService: Generated ${urls.length} keyframes`);
      return urls;
    } catch (err: any) {
      console.warn(`VideoService: Keyframe generation threw: ${err.message} — falling back to no-keyframe mode`);
      return null;
    }
  }

  /**
   * Generate a video using various AI models
   */
  async generateVideo(
    params: VideoGenerationParams
  ): Promise<VideoGenerationResult> {
    try {
      // Determine which model to use before validation.
      // Seedance 2.0 is the default for all video generation; Veo 3.1 is an
      // automatic fallback if Seedance fails (see the generation branch below).
      if (!params.videoModel) {
        params.videoModel = DEFAULT_VIDEO_MODEL;
      }

      // Establish the whole-op deadline ONCE, on the first (Seedance) call. The Veo
      // fallback re-enters generateVideo with the same params, so this carries over —
      // Seedance + Veo together are bounded by VIDEO_TOTAL_BUDGET_MS (< the turn cap).
      if (params.deadlineMs === undefined) {
        const total = videoTotalBudgetMs(params.durationSeconds);
        const veoReserve = veoFallbackReserveMs(params.durationSeconds);
        params.deadlineMs = Date.now() + total;
        console.log(
          `VideoService: length-driven budget for ${params.durationSeconds ?? 8}s video → ` +
          `total=${Math.round(total / 1000)}s ` +
          `(Seedance up to ~${Math.round((total - veoReserve) / 1000)}s, ` +
          `~${Math.round(veoReserve / 1000)}s reserved for Veo fallback)`
        );
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
      // Veo supports max 8s per clip; for longer videos generate multiple clips in parallel.
      // Per-clip playback durations can be variable (e.g. [8,8,8,6] for a 30s video).
      const VEO_MAX_SECONDS = 8;
      const VEO_MIN_SECONDS = 4;
      const requestedDuration = params.durationSeconds ?? VEO_MAX_SECONDS;

      // Each Veo clip is generated at VEO_MAX_SECONDS (snapped up per spec).
      // The playback duration per clip may be shorter for the last clip to hit the exact target.
      const clipCount = requestedDuration > VEO_MAX_SECONDS ? Math.ceil(requestedDuration / VEO_MAX_SECONDS) : 1;
      const veoGenerateDuration = VEO_MAX_SECONDS; // always ask Veo for 8s per clip
      // Playback durations: all full-length except possibly the last
      const remainder = requestedDuration - (clipCount - 1) * VEO_MAX_SECONDS;
      const lastClipPlayback = Math.max(VEO_MIN_SECONDS, Math.min(VEO_MAX_SECONDS, remainder));
      const clipPlaybackDurations: number[] = Array.from({ length: clipCount }, (_, i) =>
        i === clipCount - 1 ? lastClipPlayback : VEO_MAX_SECONDS
      );

      console.log(`VideoService: Generating ${clipCount} clip(s) for requested ${requestedDuration}s, playback=[${clipPlaybackDurations.join(',')}]s`);

      // Generate video
      let result: VideoGenerationResult;
      try {
        let clipUrls: string[] = [];

        if (isHiggsfieldModel(modelToUse)) {
          // Seedance (Higgsfield MCP) generates a single clip per request and handles its
          // own duration; multi-clip Veo composition does not apply here.
          result = await this.generateWithHiggsfield({ ...params, durationSeconds: requestedDuration });
          if (!result.success) {
            // Automatic fallback: if Seedance fails (auth/credits/job error/timeout),
            // regenerate with Veo 3.1 so video generation still succeeds.
            console.warn(
              `VideoService: Seedance generation failed (${result.error}); falling back to Veo 3.1`
            );
            return await this.generateVideo({ ...params, videoModel: "veo-3.1-generate-preview" });
          }
          if (result.videoUrl) {
            clipUrls = [result.videoUrl];
          }
        } else if (modelToUse === "veo-3.1-generate-preview") {
          if (clipCount === 1) {
            result = await this.generateWithVeo31({ ...params, durationSeconds: veoGenerateDuration });
            if (result.success && result.videoUrl) {
              clipUrls = [result.videoUrl];
            }
          } else {
            // For multi-clip: optionally generate keyframes first to guide each clip's start/end
            const filenameBase = params.filename.replace(/\.mp4$/i, '');
            let keyframes: string[] | null = null;
            if (params.useKeyframes) {
              keyframes = await this.generateKeyframes(params.prompt, clipCount, filenameBase, params.userId);
            }

            // Generate all clips concurrently at full Veo duration; playback trimming happens in Remotion
            const clipResults = await Promise.all(
              Array.from({ length: clipCount }, (_, i) =>
                this.generateWithVeo31({
                  ...params,
                  durationSeconds: veoGenerateDuration,
                  filename: `${filenameBase}_clip${i + 1}.mp4`,
                  // Keyframe steering: clip[i] goes from frame[i] to frame[i+1]
                  startFrame: keyframes ? keyframes[i] : params.startFrame,
                  endFrame: keyframes ? keyframes[i + 1] : params.endFrame,
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

        // Stitch/compose with Remotion when needed:
        //  - branded composition when compose+composeParams are supplied, OR
        //  - a plain concatenation whenever there is >1 clip (e.g. a >8s Veo fallback),
        //    so multi-clip videos aren't silently truncated to the first 8s clip.
        // For the plain-concat case we pass empty branding; the composition skips the
        // intro overlay when brandName is empty (acts as a pure concatenator).
        const needsBranding = !!(params.compose && params.composeParams);
        const needsConcat = clipUrls.length > 1;
        if (result.success && clipUrls.length > 0 && (needsBranding || needsConcat)) {
          const composeArgs = params.composeParams ?? { brandName: "", primaryColor: "#000000", secondaryColor: "#000000" };
          console.log(`VideoService: ${needsBranding ? "Composing" : "Stitching"} ${clipUrls.length} clip(s) with Remotion...`);
          const composeResult = await remotionService.compose({
            ...composeArgs,
            clipUrl: clipUrls[0],
            extraClipUrls: clipUrls.slice(1),
            // Pass per-clip playback durations so Remotion places each clip exactly
            // (e.g. [8,8,8,6] for a 30s video — last clip plays only 6s of its 8s footage)
            clipDurationsSeconds: clipPlaybackDurations,
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

