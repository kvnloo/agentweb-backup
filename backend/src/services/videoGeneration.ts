import axios from "axios";
import { getSecret } from "../utils/secretsManager";
import { uploadFileToS3 } from "../utils/s3Utils";
import { remotionService, RemotionComposeParams } from "./remotionService";
import { imageService } from "./imageGeneration";
import { McpClientService } from "../mcp/client/mcpClientService";
import { meterUserUsage } from "./usageRecorderService";
import {
  videoGenerationCostUsd,
  videoClipCount,
  omniVideoUsageCostUsd,
  LLM_PRICE_BOOK_PROVENANCE,
} from "../utils/llmPricing";
import {
  GEMINI_OMNI_VIDEO_MODEL,
  SEEDANCE_VIDEO_MODEL,
  VIDEO_MODELS,
  isSupportedVideoModel,
  normalizeVideoModel,
  omniClipDurations,
  omniDurationParam,
  OMNI_MAX_CLIP_SECONDS,
  DEFAULT_VIDEO_SECONDS,
} from "./videoModels";

interface VideoGenerationResult {
  success: boolean;
  videoUrl?: string;
  filename?: string;
  /** Present when the video was post-processed by Remotion */
  composedVideoUrl?: string;
  error?: string;
  /** The model that actually produced the video (after any fallback). */
  model?: string;
  /** Actual provider cost in USD when the provider reported usage (Omni). */
  costUsd?: number;
}

// Gemini Interactions API — the only API gemini-omni-1.1-flash accepts
// (generateContent / predictLongRunning are rejected for it).
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
// Omni output resolutions. Seedance's 480p (and anything unknown) maps to 720p.
export const OMNI_RESOLUTIONS = ["360p", "720p", "1080p", "4k"] as const;
// Omni clips are at most 10s; each is requested at its exact length via
// response_format.duration ("5s" — see omniDurationParam / omniClipDurations).
const OMNI_CLIP_SECONDS = OMNI_MAX_CLIP_SECONDS;

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
const DEFAULT_VIDEO_MODEL = SEEDANCE_VIDEO_MODEL;

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

/**
 * Omni fallback reserve (ms): scales with clip count (Omni returns ~10s/clip →
 * ceil(secs/10) clips). A 360p clip measured 25s end-to-end; 150s/clip leaves room
 * for 720p+ and frame downloads.
 */
export function omniFallbackReserveMs(durationSeconds?: number): number {
  const secs = budgetSeconds(durationSeconds);
  const clips = secs > OMNI_CLIP_SECONDS ? Math.ceil(secs / OMNI_CLIP_SECONDS) : 1;
  return clips * 150_000;
}

/** Whole-op wall-clock budget (ms): generous Seedance allowance (base + per-second) plus the Omni reserve. */
export function videoTotalBudgetMs(durationSeconds?: number): number {
  const secs = budgetSeconds(durationSeconds);
  const seedance = 150_000 + secs * 45_000; // base overhead + generous per output-second
  return seedance + omniFallbackReserveMs(secs);
}

/**
 * Poll budget (ms) for the Seedance attempt: whatever's left before the deadline after
 * reserving the (length-scaled) Omni fallback time. Returns 0 → skip polling, go to Omni.
 */
export function seedancePollBudgetMs(now: number, deadlineMs: number, durationSeconds?: number): number {
  return Math.max(0, deadlineMs - now - omniFallbackReserveMs(durationSeconds));
}

/** Time (ms) left until `deadlineMs`, floored at 0. */
export function remainingBudgetMs(now: number, deadlineMs: number): number {
  return Math.max(0, deadlineMs - now);
}

// Omni only supports a subset of Seedance's aspect ratios (auto / 16:9 / 9:16).
// The UI offers the full Seedance set; when Seedance fails and we fall back to Omni,
// map the chosen ratio to the closest Omni-supported one so orientation is preserved.
export const OMNI_ASPECT_RATIOS = ["auto", "16:9", "9:16"] as const;

const aspectToNumber = (a: string): number => {
  const [w, h] = a.split(":").map(Number);
  return w && h ? w / h : NaN;
};

/** Map any Seedance aspect ratio to the nearest Omni-supported ratio (auto/16:9/9:16). */
export function closestOmniAspectRatio(aspect?: string): string {
  if (!aspect || aspect === "auto") return "auto";
  if ((OMNI_ASPECT_RATIOS as readonly string[]).includes(aspect)) return aspect;
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
  /** Requested total duration in seconds; defaults to 8. */
  durationSeconds?: number;
  /**
   * When true and clipCount > 1, generate N+1 keyframe images before generating clips.
   * Clip[i] gets startFrame=keyframes[i], endFrame=keyframes[i+1], so Omni interpolates
   * between AI-generated visual waypoints — producing smooth, visually coherent transitions.
   */
  useKeyframes?: boolean;
  /** When true, post-process the generated clip with Remotion to add brand overlays */
  compose?: boolean;
  /** Brand overlay params — required when compose is true */
  composeParams?: Omit<RemotionComposeParams, "clipUrl" | "filename" | "userId">;
  /** Seedance aspect ratio (one of SEEDANCE_ASPECT_RATIOS). Defaults to "auto". */
  aspectRatio?: string;
  /** Output resolution (Seedance: SEEDANCE_RESOLUTIONS; Omni: OMNI_RESOLUTIONS). Defaults to "720p". */
  resolution?: string;
  /**
   * Internal: absolute epoch-ms hard stop for the WHOLE video op (Seedance + Omni
   * fallback). Set once by generateVideo and propagated through the Seedance attempt
   * and the Omni fallback so their combined wall-clock stays under the turn cap.
   */
  deadlineMs?: number;
}

export class VideoService {
  constructor() {
    // No initialization needed - clients will be created as needed
  }

  /**
   * Get the Google video API key from Secrets Manager (Omni uses the same secret the
   * retired Veo models did).
   */
  private async getApiKey(): Promise<string> {
    const secretName = process.env.NODE_ENV === "development"
      ? "dev/AgentWeb/Google/Video"
      : "prod/AgentWeb/Google/Video";
    try {
      const apiKey = await getSecret(secretName);
      if (!apiKey) {
        throw new Error(`API key not found in secret ${secretName}`);
      }
      return apiKey;
    } catch (error: any) {
      console.error(`❌ Failed to get Google video API key:`, error.message);
      throw new Error(`Failed to get Google video API key: ${error.message}`);
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
   * Upload an already-generated (already PAID for) video buffer to S3, retrying a
   * transient failure so a blip never discards the clip.
   */
  private async uploadVideoBuffer(
    buffer: Buffer,
    filename: string,
    userId: string
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    const MAX_ATTEMPTS = 3;
    let lastError = "Failed to upload video to S3";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const uploadResult = await uploadFileToS3(buffer, filename, userId, "video/mp4");
        if (uploadResult.success && uploadResult.url) {
          return { success: true, url: uploadResult.url };
        }
        lastError = uploadResult.error || lastError;
      } catch (error: any) {
        lastError = `Failed to upload video to S3: ${error.message}`;
      }
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`VideoService: S3 upload attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastError}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    return { success: false, error: lastError };
  }

  /**
   * Generate ONE clip with gemini-omni-1.1-flash via the Gemini Interactions API.
   *
   * The call is synchronous: the response carries the finished clip as base64 in
   * steps[].content[] ({type:"video", data}). Image parts go first (start frame,
   * then end frame for interpolation), followed by the text prompt. There is no
   * fallback model: a quota or API error fails clearly.
   */
  private async generateWithOmni(params: VideoGenerationParams): Promise<VideoGenerationResult> {
    const model = GEMINI_OMNI_VIDEO_MODEL;
    try {
      const deadlineMs = params.deadlineMs ?? (Date.now() + videoTotalBudgetMs(params.durationSeconds));
      if (remainingBudgetMs(Date.now(), deadlineMs) <= 0) {
        return { success: false, model, error: "Video generation exceeded its time budget" };
      }

      const apiKey = await this.getApiKey();

      // Frames, in order: first, then last (interpolation) — then the prompt text.
      const imageParts: Array<{ type: "image"; data: string; mime_type: string }> = [];
      for (const [label, url] of [["start", params.startFrame], ["end", params.endFrame]] as const) {
        if (!url) continue;
        try {
          const img = await this.processInputImage(url);
          imageParts.push({ type: "image", data: img.buffer.toString("base64"), mime_type: img.mimeType });
        } catch (error: any) {
          return { success: false, model, error: `Failed to process ${label} frame: ${error.message}` };
        }
      }
      const input = imageParts.length
        ? [...imageParts, { type: "text", text: params.prompt }]
        : params.prompt;

      const responseFormat: Record<string, string> = {
        type: "video",
        resolution: (OMNI_RESOLUTIONS as readonly string[]).includes(params.resolution as string)
          ? (params.resolution as string)
          : "720p",
      };
      if (typeof params.durationSeconds === "number" && Number.isFinite(params.durationSeconds)) {
        responseFormat.duration = omniDurationParam(params.durationSeconds);
      }
      // 'auto' is left unset so Omni defaults / matches the input frame.
      const aspect = closestOmniAspectRatio(params.aspectRatio);
      if (aspect === "16:9" || aspect === "9:16") {
        responseFormat.aspect_ratio = aspect;
      }

      const timeoutMs = remainingBudgetMs(Date.now(), deadlineMs);
      console.log(
        `VideoService: Omni request (${imageParts.length} frame(s), ${responseFormat.resolution}, ` +
        `duration=${responseFormat.duration ?? "default"}, ` +
        `aspect=${responseFormat.aspect_ratio ?? "auto"}, timeout=${Math.round(timeoutMs / 1000)}s)`
      );
      const response = await axios.post(
        GEMINI_INTERACTIONS_URL,
        { model, input, response_format: responseFormat },
        {
          params: { key: apiKey },
          headers: { "Content-Type": "application/json" },
          timeout: timeoutMs,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );

      const data: any = response.data;
      if (data?.status !== "completed") {
        return {
          success: false,
          model,
          error: `Omni video generation did not complete (status: ${data?.status ?? "unknown"})`,
        };
      }
      const video = (Array.isArray(data.steps) ? data.steps : [])
        .flatMap((step: any) => (Array.isArray(step?.content) ? step.content : []))
        .find((part: any) => part?.type === "video" && typeof part.data === "string" && part.data.length > 0);
      if (!video) {
        return { success: false, model, error: "Video generation completed but no video was returned" };
      }

      const costUsd = omniVideoUsageCostUsd(data.usage);
      const upload = await this.uploadVideoBuffer(Buffer.from(video.data, "base64"), params.filename, params.userId);
      if (!upload.success || !upload.url) {
        return { success: false, model, error: upload.error || "Failed to upload video to S3" };
      }
      return {
        success: true,
        model,
        videoUrl: upload.url,
        filename: params.filename,
        costUsd,
      };
    } catch (error: any) {
      const status = error?.response?.status;
      const apiMessage = error?.response?.data?.error?.message;
      if (status === 429) {
        console.error(`❌ ${model} quota exhausted (HTTP 429): ${apiMessage ?? error.message}`);
        return {
          success: false,
          model,
          error: `Video generation quota exhausted for ${model}. Please try again later or contact support.`,
        };
      }
      if (error?.code === "ECONNABORTED") {
        return { success: false, model, error: "Video generation exceeded its time budget" };
      }
      const detail = apiMessage || error?.message || "Unknown error";
      console.error(`❌ Error generating video with ${model}${status ? ` (HTTP ${status})` : ""}:`, detail);
      return { success: false, model, error: `Failed to generate video: ${detail}` };
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
    // The source clip is already generated (and, for Seedance, already PAID for) by the
    // time we get here. A transient download/S3 hiccup must not bubble up as a generation
    // failure — that would trigger a full Omni regen and double-charge. Retry a few times
    // with backoff so only a persistent failure surfaces.
    const MAX_ATTEMPTS = 3;
    let lastError = "Failed to download video to S3";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
        lastError = uploadResult.error || "Failed to upload video to S3";
      } catch (error: any) {
        lastError = `Failed to download video: ${error.message}`;
        console.error(`❌ Failed to download and upload video from URL (attempt ${attempt}/${MAX_ATTEMPTS}):`, error.message);
      }
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`VideoService: download/upload attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastError}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); // 1s, 2s backoff
      }
    }
    console.error(`❌ Download/upload to S3 failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
    return { success: false, error: lastError };
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
        // terminal failure; ip_detected = gated (treated as failure → Omni fallback).
        // Bounded by a wall-clock budget that stays under the agent-mode cap.
        const maxPollAttempts = 240; // safety cap; the real bound is the time budget
        const failStates = new Set(["failed", "canceled", "nsfw"]);
        // Grant Seedance only what we can spend while still reserving time for an Omni
        // fallback before the whole-op deadline — so a Seedance hang can't starve Omni.
        const pollBudgetMs = params.deadlineMs !== undefined
          ? seedancePollBudgetMs(Date.now(), params.deadlineMs, params.durationSeconds)
          : (videoTotalBudgetMs(params.durationSeconds) - omniFallbackReserveMs(params.durationSeconds));
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
          const remainingForOmni = params.deadlineMs !== undefined ? remainingBudgetMs(Date.now(), params.deadlineMs) : 0;
          console.warn(
            `VideoService: Seedance job ${jobId} exceeded its ${Math.round(pollBudgetMs / 1000)}s budget ` +
            `(last status "${status}") — failing over to Omni with ~${Math.round(remainingForOmni / 1000)}s left`
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
      // Surface auth/credit problems clearly so the Omni fallback can engage.
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
      // Seedance 2.0 is the default for all video generation; gemini-omni-1.1-flash is
      // an automatic fallback if Seedance fails (see the generation branch below).
      // Retired Veo ids (stored settings / old callers) resolve to Omni.
      params.videoModel = normalizeVideoModel(params.videoModel) || DEFAULT_VIDEO_MODEL;

      // Establish the whole-op deadline ONCE, on the first (Seedance) call. The Omni
      // fallback re-enters generateVideo with the same params, so this carries over —
      // Seedance + Omni together are bounded by videoTotalBudgetMs (< the turn cap).
      if (params.deadlineMs === undefined) {
        const total = videoTotalBudgetMs(params.durationSeconds);
        const omniReserve = omniFallbackReserveMs(params.durationSeconds);
        params.deadlineMs = Date.now() + total;
        console.log(
          `VideoService: length-driven budget for ${params.durationSeconds ?? 8}s video → ` +
          `total=${Math.round(total / 1000)}s ` +
          `(Seedance up to ~${Math.round((total - omniReserve) / 1000)}s, ` +
          `~${Math.round(omniReserve / 1000)}s reserved for Omni fallback)`
        );
      }

      // Validate the provided model
      if (!isSupportedVideoModel(params.videoModel)) {
        return {
          success: false,
          error: `Invalid videoModel '${params.videoModel}'. Must be one of: ${VIDEO_MODELS.join(", ")}`,
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
      
      // Determine how many clips to generate.
      // Omni clips are <=10s; longer videos are split into clips generated in parallel,
      // each requested at its exact length (e.g. [10,10,10] / [10,4] / [10,8,3] for 30s / 14s / 21s).
      const requestedDuration = params.durationSeconds ?? DEFAULT_VIDEO_SECONDS;
      const clipPlaybackDurations = omniClipDurations(requestedDuration);
      const clipCount = clipPlaybackDurations.length;

      // Generate video
      let result: VideoGenerationResult;
      try {
        let clipUrls: string[] = [];
        // Per-clip playback durations + the max-clip cap passed to Remotion.
        // Default to the Omni per-10s-clip model; Seedance overrides both below since it
        // returns ONE clip of the full (≤15s) length.
        let composeClipDurations: number[] = clipPlaybackDurations;
        let composeMaxClipSeconds = OMNI_CLIP_SECONDS;

        if (isHiggsfieldModel(modelToUse)) {
          // Seedance (Higgsfield MCP) generates a single clip per request and handles its
          // own duration; multi-clip Omni composition does not apply here.
          result = await this.generateWithHiggsfield({ ...params, durationSeconds: requestedDuration });
          if (!result.success) {
            // Automatic fallback: if Seedance fails (auth/credits/job error/timeout),
            // regenerate with gemini-omni-1.1-flash so video generation still succeeds.
            console.warn(
              `VideoService: Seedance generation failed (${result.error}); falling back to ${GEMINI_OMNI_VIDEO_MODEL}`
            );
            return await this.generateVideo({ ...params, videoModel: GEMINI_OMNI_VIDEO_MODEL });
          }
          if (result.videoUrl) {
            clipUrls = [result.videoUrl];
            // ONE real clip of the full requested length (clamped to Seedance's range).
            // Override the Omni [10,4]-style split so compose renders all paid seconds,
            // and lift the clip cap to Seedance's 15s max.
            composeClipDurations = [budgetSeconds(requestedDuration)];
            composeMaxClipSeconds = SEEDANCE_MAX_DURATION;
          }
        } else if (modelToUse === GEMINI_OMNI_VIDEO_MODEL) {
          console.log(`VideoService: Generating ${clipCount} Omni clip(s) for requested ${requestedDuration}s, playback=[${clipPlaybackDurations.join(',')}]s`);
          if (clipCount === 1) {
            result = await this.generateWithOmni({ ...params, durationSeconds: clipPlaybackDurations[0] });
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

            // Generate all clips concurrently; playback trimming happens in Remotion
            const clipResults = await Promise.all(
              Array.from({ length: clipCount }, (_, i) =>
                this.generateWithOmni({
                  ...params,
                  filename: `${filenameBase}_clip${i + 1}.mp4`,
                  durationSeconds: clipPlaybackDurations[i],
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
              // Actual cost only when EVERY clip reported usage; otherwise estimate.
              const costUsd = clipResults.every((r) => typeof r.costUsd === "number")
                ? clipResults.reduce((acc, r) => acc + (r.costUsd as number), 0)
                : undefined;
              result = { success: true, videoUrl: clipUrls[0], filename: params.filename, costUsd };
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
        //  - a plain concatenation whenever there is >1 clip (e.g. a >10s Omni fallback),
        //    so multi-clip videos aren't silently truncated to the first clip.
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
            // (e.g. [10,10,10] for a 30s Omni video; [14] for a single 14s Seedance clip)
            clipDurationsSeconds: composeClipDurations,
            // Max single-clip length (Omni=10s, Seedance=15s) so Remotion's clamp matches the provider
            maxClipSeconds: composeMaxClipSeconds,
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

        // Meter ONCE per successful generation at the source so every caller is charged
        // exactly once. The Seedance->Omni fallback re-enters generateVideo, so only the
        // terminal successful model reaches here. Omni bills on the provider-reported
        // usage when present; otherwise (and for Seedance) the per-clip price book applies.
        if (result.success && result.videoUrl) {
          const costUsd = result.costUsd ?? videoGenerationCostUsd(modelToUse, requestedDuration);
          result = { ...result, model: modelToUse, costUsd };
          void meterUserUsage({
            userId: params.userId,
            model: modelToUse,
            provider: isHiggsfieldModel(modelToUse) ? "higgsfield" : "google",
            feature: "video_generation",
            // Tokens stay 0: video is per-generation priced and its output tokens
            // must not count against the user's token allowance (ENG-1691).
            inputTokens: 0,
            outputTokens: 0,
            costUsdOverride: costUsd,
            costProvenance: LLM_PRICE_BOOK_PROVENANCE,
            generationCount: videoClipCount(requestedDuration, modelToUse),
          });
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
      await this.getApiKey();
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

