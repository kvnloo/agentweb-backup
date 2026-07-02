import AWS from "aws-sdk";

/**
 * Parameters for composing a branded video via Remotion Lambda.
 * The raw AI-generated clip (from Veo) is overlaid with brand elements.
 */
export interface RemotionComposeParams {
  /** S3 URL of the raw AI-generated video clip (e.g. from Veo 3.1) */
  clipUrl: string;
  /** Additional clip URLs to concatenate after clipUrl (for >8s videos) */
  extraClipUrls?: string[];
  /** Brand display name shown as headline overlay */
  brandName: string;
  /** Optional tagline shown under the brand name */
  tagline?: string;
  /** Primary hex color for the gradient bar (e.g. "#1a73e8") */
  primaryColor: string;
  /** Secondary hex color for accent elements */
  secondaryColor: string;
  /** Optional logo image URL */
  logoUrl?: string;
  /** Optional call-to-action text for the outro */
  ctaText?: string;
  /** Optional URL shown alongside the CTA */
  ctaUrl?: string;
  /** Output filename (will get .mp4 if missing) */
  filename: string;
  /** User ID for S3 path scoping */
  userId: string;
  /**
   * Uniform duration of each source clip in seconds.
   * Used when all clips share the same length.
   * If not provided, defaults to 8 seconds (Veo default clip length).
   */
  clipDurationSeconds?: number;
  /**
   * Per-clip durations in seconds (variable-length support).
   * When provided, overrides clipDurationSeconds for each individual clip.
   * E.g. [8, 8, 8, 6] for a 30s video with 3 × 8s clips and one 6s clip.
   */
  clipDurationsSeconds?: number[];
  /**
   * Exact total duration to render in seconds.
   * When provided, overrides the sum of clip durations. Use as a final
   * trim guard (e.g. exactly 30s when clips sum to 30s anyway).
   */
  targetDurationSeconds?: number;
  /**
   * Maximum length (seconds) of a single source clip, used to clamp stale/incorrect
   * per-clip durations. Defaults to 8 (Veo clip cap). Seedance returns one clip up to
   * 15s, so callers pass 15 there to avoid truncating the paid clip to 8s.
   */
  maxClipSeconds?: number;
  /** Optional S3 URL of an MP3 voiceover to overlay on the composed video */
  audioUrl?: string;
  /** Voiceover volume (0.0–1.0, default 1.0) */
  audioVolume?: number;
  /**
   * Epoch-ms deadline (from the agent run's media-generation time budget) by which this
   * compose should stop blocking and hand off. When the render can't finish in the
   * remaining budget we return a `processing` result with the deterministic output URL
   * rather than blocking until the run's hard wall-clock timeout kills it (ENG-123).
   * When omitted, the legacy 5-minute poll cap applies.
   */
  renderDeadlineMs?: number;
}

export interface RemotionComposeResult {
  success: boolean;
  videoUrl?: string;
  filename?: string;
  error?: string;
  /**
   * 'complete' — the render finished and videoUrl is ready now.
   * 'processing' — the render is still finalizing on Lambda (detached); videoUrl is the
   * deterministic S3 location where it will appear shortly. Used for the timeout handoff.
   */
  status?: 'complete' | 'processing';
  /** Human-facing note (e.g. the "still finalizing" handoff message). */
  message?: string;
}

/**
 * Config stored in AWS Secrets Manager at:
 *   dev/AgentWeb/Remotion  (development)
 *   prod/AgentWeb/Remotion (production)
 *
 * Expected JSON shape:
 * {
 *   "functionName": "remotion-render-4-0-290-mem2048mb-disk2048mb-120sec",
 *   "serveUrl": "https://remotionlambda-xxxx.s3.us-east-1.amazonaws.com/sites/agentweb-compositions/index.html",
 *   "region": "us-east-1"
 * }
 */
interface RemotionConfig {
  functionName: string;
  serveUrl: string;
  region: string;
}

const FPS = 30;

/**
 * Resolve the per-clip and total durations for a composition — the pure math behind
 * remotionService.compose, extracted so it can be unit-tested without invoking Lambda.
 *
 * ENG-123 "black hole": when a caller passes a `targetDurationSeconds` LONGER than the
 * actual clip footage (e.g. target 30s but 3×8s = 24s of clips), the old code set the
 * composition to the full target. The clip <Sequence>s only covered the footage, so the
 * trailing frames rendered the bare black background — a multi-second black tail. We now
 * clamp the composition to the available footage: a target can only ever TRIM, never pad.
 */
export function resolveCompositionDuration(input: {
  clipCount: number;
  clipDurationSeconds?: number;
  clipDurationsSeconds?: number[];
  targetDurationSeconds?: number;
  maxClipSeconds?: number;
  fps?: number;
}): {
  perClipSeconds: number[];
  sumSeconds: number;
  totalDurationSeconds: number;
  durationInFrames: number;
  clipDurationInFrames: number[];
  targetExceededFootage: boolean;
} {
  const fps = input.fps ?? FPS;
  // Default cap is 8s (Veo per-clip max). Seedance produces one clip up to 15s and
  // passes maxClipSeconds=15 so the full paid clip isn't truncated to 8s.
  const maxClipSeconds = input.maxClipSeconds ?? 8;
  const uniformSeconds = Math.min((input.clipDurationSeconds || maxClipSeconds), maxClipSeconds);
  const perClipSeconds: number[] = Array.from({ length: input.clipCount }, (_, i) =>
    input.clipDurationsSeconds?.[i] != null
      ? Math.min(input.clipDurationsSeconds[i], maxClipSeconds)
      : uniformSeconds
  );

  const sumSeconds = perClipSeconds.reduce((a, b) => a + b, 0);
  // A target can only TRIM the footage, never pad it: clamp to the clip sum so the
  // composition never outruns the clips (the black-tail guard).
  const targetExceededFootage =
    input.targetDurationSeconds != null && input.targetDurationSeconds > sumSeconds;
  const totalDurationSeconds = Math.min(input.targetDurationSeconds ?? sumSeconds, sumSeconds);
  const durationInFrames = Math.round(totalDurationSeconds * fps);
  const clipDurationInFrames = perClipSeconds.map(s => Math.round(s * fps));

  return {
    perClipSeconds,
    sumSeconds,
    totalDurationSeconds,
    durationInFrames,
    clipDurationInFrames,
    targetExceededFootage,
  };
}

/**
 * Number of poll iterations compose should run before handing off, bounded by the run's
 * remaining media-generation budget. Extracted as a pure function so the timeout handoff
 * math is unit-testable without invoking Lambda (ENG-123).
 *
 * - No deadline → the legacy hard cap (unchanged behavior).
 * - Deadline in the future → floor(remaining / interval), clamped to [1, hardCap].
 * - Already past the deadline (e.g. clip regen ate the whole budget) → 1 poll, so we
 *   catch an instant completion/failure and otherwise hand off immediately.
 */
export function computeRenderPollBudget(input: {
  renderDeadlineMs?: number;
  now: number;
  pollIntervalMs: number;
  hardCapPolls: number;
  safetyMarginMs?: number;
}): number {
  const { renderDeadlineMs, now, pollIntervalMs, hardCapPolls } = input;
  if (renderDeadlineMs == null) return hardCapPolls;
  const safetyMarginMs = input.safetyMarginMs ?? 0;
  const remainingMs = renderDeadlineMs - now - safetyMarginMs;
  if (remainingMs <= 0) return 1;
  return Math.max(1, Math.min(hardCapPolls, Math.floor(remainingMs / pollIntervalMs)));
}

/**
 * Construct the deterministic S3 URL that the detached Remotion Lambda writes its output
 * to, mirroring Remotion's own getOutputUrlFromMetadata:
 *   https://s3.<region>.amazonaws.com/<bucket>/renders/<renderId>/<outName>
 * We know all four parts the instant renderMediaOnLambda returns, so we can hand this
 * back before the render finishes — the Lambda keeps rendering and the URL resolves.
 */
export function buildRemotionOutputUrl(
  region: string,
  bucketName: string,
  renderId: string,
  outName: string
): string {
  return `https://s3.${region}.amazonaws.com/${bucketName}/renders/${renderId}/${outName}`;
}

export class RemotionService {
  private config: RemotionConfig | null = null;

  /**
   * Fetch a secret from a specific region, bypassing the app-wide secretsManager
   * client which is pinned to us-west-2.  The Remotion secret lives in us-east-1
   * (same region as the Lambda function) so we need a dedicated client here.
   */
  private async fetchSecret(secretName: string, region: string): Promise<string> {
    const client = new AWS.SecretsManager({ region });
    const data = await client.getSecretValue({ SecretId: secretName }).promise();
    if (data.SecretString) return data.SecretString;
    throw new Error(`Secret ${secretName} has no SecretString`);
  }

  private async getConfig(): Promise<RemotionConfig> {
    if (this.config) return this.config;

    const secretName =
      process.env.NODE_ENV === "development"
        ? "dev/AgentWeb/Remotion"
        : "prod/AgentWeb/Remotion";

    // The Remotion secret is stored in us-east-1 (same region as the Lambda function).
    // Try us-east-1 first, then fall back to us-west-2 (where other app secrets live).
    let raw: string;
    try {
      console.log(`RemotionService: Fetching secret ${secretName} from us-east-1...`);
      raw = await this.fetchSecret(secretName, "us-east-1");
      console.log(`RemotionService: Secret fetched successfully from us-east-1`);
    } catch (e1: any) {
      console.warn(`RemotionService: us-east-1 fetch failed (${e1.code}: ${e1.message}), trying us-west-2...`);
      try {
        raw = await this.fetchSecret(secretName, "us-west-2");
        console.log(`RemotionService: Secret fetched successfully from us-west-2`);
      } catch (e2: any) {
        console.error(`RemotionService: Both regions failed. us-east-1: ${e1.code}, us-west-2: ${e2.code}`);
        throw new Error(`Remotion secret not found in us-east-1 (${e1.code}) or us-west-2 (${e2.code})`);
      }
    }

    if (!raw) {
      throw new Error(`Remotion config not found in Secrets Manager (${secretName})`);
    }

    // getSecret returns either a plain string or a JSON string
    let parsed: RemotionConfig;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      throw new Error(`Remotion config in Secrets Manager is not valid JSON`);
    }

    if (!parsed.functionName || !parsed.serveUrl || !parsed.region) {
      throw new Error(
        `Remotion config is missing required fields: functionName, serveUrl, region`
      );
    }

    this.config = parsed;
    return this.config;
  }

  /**
   * Render a branded composition on top of a raw AI video clip using Remotion Lambda.
   *
   * Flow:
   *   1. Load Lambda config from Secrets Manager
   *   2. Invoke @remotion/lambda renderMediaOnLambda() with the BrandedVideo composition
   *   3. Lambda renders and writes the output to the configured S3 bucket
   *   4. Return the output S3 URL
   */
  /**
   * Ensure AWS credentials are set in environment variables so that
   * @remotion/lambda (which doesn't use the SDK credential chain) can
   * authenticate.  On EC2 we pull them from the instance metadata service.
   */
  private async ensureRemotionCredentials(): Promise<void> {
    // Already set — nothing to do
    if (process.env.REMOTION_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) return;

    // Fetch credentials from the EC2 instance metadata (IMDSv2)
    try {
      const tokenResp = await fetch(
        "http://169.254.169.254/latest/api/token",
        { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" } }
      );
      const token = await tokenResp.text();

      const roleResp = await fetch(
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        { headers: { "X-aws-ec2-metadata-token": token } }
      );
      const roleName = (await roleResp.text()).trim();

      const credResp = await fetch(
        `http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`,
        { headers: { "X-aws-ec2-metadata-token": token } }
      );
      const creds = await credResp.json() as any;

      process.env.REMOTION_AWS_ACCESS_KEY_ID = creds.AccessKeyId;
      process.env.REMOTION_AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
      process.env.REMOTION_AWS_SESSION_TOKEN = creds.Token;
      console.log("RemotionService: Loaded credentials from instance metadata for role", roleName);
    } catch (err: any) {
      console.warn("RemotionService: Could not load instance metadata credentials:", err.message);
      // Let renderMediaOnLambda try on its own (will fail with a clear message if missing)
    }
  }

  async compose(params: RemotionComposeParams): Promise<RemotionComposeResult> {
    try {
      const config = await this.getConfig();

      // Ensure @remotion/lambda has credentials — it doesn't use the SDK chain
      await this.ensureRemotionCredentials();

      // Lazy-require so the backend doesn't fail to start if @remotion/lambda
      // is not yet installed (it will only be used when compose is called)
      const { renderMediaOnLambda, getRenderProgress } = await import(
        "@remotion/lambda/client"
      );

      // Veo generates clips up to 8 seconds. Cap here so a stale or incorrect
      // clipDurationSeconds from the caller never makes the composition longer
      // than the actual clip (which would cause the video to freeze at the end).
      // Build the full ordered list of clip URLs
      const allClipUrls = [params.clipUrl, ...(params.extraClipUrls ?? [])];
      const clipCount = allClipUrls.length;

      // Resolve per-clip and total durations. Variable lengths take priority over uniform,
      // each clip is capped at maxClipSeconds, and the total is CLAMPED to the clip sum so
      // a target longer than the footage can only trim, never pad with a black tail (ENG-123).
      const {
        perClipSeconds,
        sumSeconds,
        totalDurationSeconds,
        durationInFrames,
        clipDurationInFrames,
        targetExceededFootage,
      } = resolveCompositionDuration({
        clipCount,
        clipDurationSeconds: params.clipDurationSeconds,
        clipDurationsSeconds: params.clipDurationsSeconds,
        targetDurationSeconds: params.targetDurationSeconds,
        maxClipSeconds: params.maxClipSeconds,
        fps: FPS,
      });
      if (targetExceededFootage) {
        console.warn(
          `RemotionService: targetDurationSeconds=${params.targetDurationSeconds}s exceeds available footage ${sumSeconds}s ` +
          `for ${clipCount} clip(s) — clamping to ${totalDurationSeconds}s to avoid a black tail. ` +
          `Generate more/longer clips to reach the requested length.`
        );
      }
      console.log(`RemotionService: ${clipCount} clip(s) [${perClipSeconds.join(',')}]s = ${totalDurationSeconds}s → durationInFrames=${durationInFrames}`);

      // Ensure filename ends with .mp4
      let filename = params.filename;
      if (!filename.toLowerCase().endsWith(".mp4")) {
        filename = `${filename}.mp4`;
      }

      const introDurationFrames = Math.max(1, Math.min(90, Math.round(durationInFrames * 0.15)));
      const outroDurationFrames = params.ctaText
        ? Math.max(1, Math.min(90, Math.round(durationInFrames * 0.15)))
        : 90; // default to 90 even if no CTA; BrandedVideo guards against rendering it

      const inputPropsWithDuration: Record<string, any> = {
        clipUrl: allClipUrls[0],
        extraClipUrls: allClipUrls.slice(1),
        clipDurationInFrames,
        brandName: params.brandName,
        tagline: params.tagline,
        primaryColor: params.primaryColor,
        secondaryColor: params.secondaryColor,
        logoUrl: params.logoUrl,
        ctaText: params.ctaText,
        ctaUrl: params.ctaUrl,
        introDurationFrames,
        outroDurationFrames,
        durationInFrames,
        ...(params.audioUrl && { audioUrl: params.audioUrl }),
        ...(params.audioUrl && params.audioVolume != null && { audioVolume: params.audioVolume }),
      };

      console.log(
        `RemotionService: Rendering BrandedVideo for user ${params.userId}, clips=${clipCount}, durationInFrames=${durationInFrames}, introDurationFrames=${introDurationFrames}, outroDurationFrames=${outroDurationFrames}, hasCtaText=${Boolean(params.ctaText)}`
      );

      // Capture the exact output key once (it embeds Date.now()) so the detached-handoff
      // URL below matches what the Lambda actually writes.
      const outName = `users/${params.userId}/remotion/${Date.now()}_${filename}`;

      const renderResult = await renderMediaOnLambda({
        region: config.region as any,
        functionName: config.functionName,
        serveUrl: config.serveUrl,
        composition: "BrandedVideo",
        inputProps: inputPropsWithDuration,
        codec: "h264",
        imageFormat: "jpeg",
        framesPerLambda: 60,
        outName: outName as any,
        timeoutInMilliseconds: 300000, // 5 minutes
      });

      // Poll for completion (renderMediaOnLambda is async; it returns immediately)
      const bucketName = renderResult.bucketName;
      const renderId = renderResult.renderId;

      // The Lambda renders detached — it finishes and writes to this deterministic URL
      // even if we stop polling. So if we run out of budget we can hand this back and the
      // video will appear here shortly, instead of blocking until the run is hard-killed.
      const detachedOutputUrl = buildRemotionOutputUrl(config.region, bucketName, renderId, outName);

      const POLL_INTERVAL_MS = 5000;
      const HARD_CAP_POLLS = 60; // 5 minutes at 5s intervals — secondary ceiling
      // Bound the poll to the run's remaining media-generation budget (when supplied) so
      // compose hands off BEFORE the run's hard wall-clock timeout. Keep a safety margin
      // so the handoff result has time to propagate back through the agent loop.
      const maxPolls = computeRenderPollBudget({
        renderDeadlineMs: params.renderDeadlineMs,
        now: Date.now(),
        pollIntervalMs: POLL_INTERVAL_MS,
        hardCapPolls: HARD_CAP_POLLS,
        safetyMarginMs: 15000,
      });
      let polls = 0;

      while (polls < maxPolls) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        polls++;

        const progress = await getRenderProgress({
          renderId,
          bucketName,
          functionName: config.functionName,
          region: config.region as any,
        });

        if (progress.fatalErrorEncountered) {
          return {
            success: false,
            error: `Remotion render failed: ${progress.errors?.[0]?.message ?? "unknown error"}`,
          };
        }

        if (progress.done) {
          const outputFile = progress.outputFile;
          if (!outputFile) {
            return { success: false, error: "Remotion render completed but outputFile is missing" };
          }
          console.log(`RemotionService: Render complete → ${outputFile}`);
          return {
            success: true,
            status: "complete",
            videoUrl: outputFile,
            filename,
          };
        }

        console.log(
          `RemotionService: Render progress ${(progress.overallProgress * 100).toFixed(1)}% (poll ${polls}/${maxPolls})`
        );
      }

      // Out of poll budget but the render is still going. Rather than block until the run
      // is killed with nothing to show, hand off the detached render: the Lambda keeps
      // going and writes to detachedOutputUrl, which resolves shortly (ENG-123).
      console.log(
        `RemotionService: Render still processing after ${polls} poll(s) — handing off detached URL ${detachedOutputUrl}`
      );
      return {
        success: true,
        status: "processing",
        videoUrl: detachedOutputUrl,
        filename,
        message:
          "The video is still finalizing and will be ready at this link in a minute or two — " +
          "no need to regenerate it.",
      };
    } catch (error: any) {
      console.error("RemotionService: Error composing video:", error);
      return {
        success: false,
        error: `Remotion composition failed: ${error.message ?? "unknown error"}`,
      };
    }
  }

  /**
   * Check if the Remotion service is configured and available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.getConfig();
      return true;
    } catch {
      return false;
    }
  }
}

let remotionService: RemotionService;

try {
  remotionService = new RemotionService();
  console.log("✅ Remotion Service initialized successfully");
} catch (error) {
  console.warn("⚠️ Failed to initialize Remotion Service");
  remotionService = {
    isAvailable: async () => false,
    compose: async () => ({ success: false, error: "Service not available" }),
  } as any;
}

export { remotionService };
