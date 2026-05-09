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
}

export interface RemotionComposeResult {
  success: boolean;
  videoUrl?: string;
  filename?: string;
  error?: string;
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

      // Resolve per-clip durations (seconds). Variable lengths take priority over uniform.
      const MAX_VEO_CLIP_SECONDS = 8;
      const uniformSeconds = Math.min((params.clipDurationSeconds || MAX_VEO_CLIP_SECONDS), MAX_VEO_CLIP_SECONDS);
      const perClipSeconds: number[] = allClipUrls.map((_, i) =>
        params.clipDurationsSeconds?.[i] != null
          ? Math.min(params.clipDurationsSeconds[i], MAX_VEO_CLIP_SECONDS)
          : uniformSeconds
      );

      // Total = sum of per-clip durations, optionally overridden by targetDurationSeconds
      const sumSeconds = perClipSeconds.reduce((a, b) => a + b, 0);
      const totalDurationSeconds = params.targetDurationSeconds ?? sumSeconds;
      const durationInFrames = Math.round(totalDurationSeconds * FPS);
      const clipDurationInFrames = perClipSeconds.map(s => Math.round(s * FPS));
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

      const inputPropsWithDuration = {
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
      };

      console.log(
        `RemotionService: Rendering BrandedVideo for user ${params.userId}, clips=${clipCount}, durationInFrames=${durationInFrames}, introDurationFrames=${introDurationFrames}, outroDurationFrames=${outroDurationFrames}, hasCtaText=${Boolean(params.ctaText)}`
      );

      const renderResult = await renderMediaOnLambda({
        region: config.region as any,
        functionName: config.functionName,
        serveUrl: config.serveUrl,
        composition: "BrandedVideo",
        inputProps: inputPropsWithDuration,
        codec: "h264",
        imageFormat: "jpeg",
        framesPerLambda: 60,
        outName: `users/${params.userId}/remotion/${Date.now()}_${filename}` as any,
        timeoutInMilliseconds: 300000, // 5 minutes
      });

      // Poll for completion (renderMediaOnLambda is async; it returns immediately)
      const bucketName = renderResult.bucketName;
      const renderId = renderResult.renderId;

      const maxPolls = 60; // 5 minutes at 5s intervals
      let polls = 0;

      while (polls < maxPolls) {
        await new Promise((r) => setTimeout(r, 5000));
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
            videoUrl: outputFile,
            filename,
          };
        }

        console.log(
          `RemotionService: Render progress ${(progress.overallProgress * 100).toFixed(1)}% (poll ${polls}/${maxPolls})`
        );
      }

      return {
        success: false,
        error: "Remotion render timed out after 5 minutes",
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
