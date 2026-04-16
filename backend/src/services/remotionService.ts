import { getSecret } from "../utils/secretsManager";

/**
 * Parameters for composing a branded video via Remotion Lambda.
 * The raw AI-generated clip (from Veo) is overlaid with brand elements.
 */
export interface RemotionComposeParams {
  /** S3 URL of the raw AI-generated video clip (e.g. from Veo 3.1) */
  clipUrl: string;
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
   * Duration of the source clip in seconds.
   * Used to calculate durationInFrames for the composition.
   * If not provided, defaults to 8 seconds (Veo default clip length).
   */
  clipDurationSeconds?: number;
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

  private async getConfig(): Promise<RemotionConfig> {
    if (this.config) return this.config;

    const secretName =
      process.env.NODE_ENV === "development"
        ? "dev/AgentWeb/Remotion"
        : "prod/AgentWeb/Remotion";

    const raw = await getSecret(secretName);
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
  async compose(params: RemotionComposeParams): Promise<RemotionComposeResult> {
    try {
      const config = await this.getConfig();

      // Lazy-require so the backend doesn't fail to start if @remotion/lambda
      // is not yet installed (it will only be used when compose is called)
      const { renderMediaOnLambda, getRenderProgress } = await import(
        "@remotion/lambda/client"
      );

      const clipDurationSeconds = params.clipDurationSeconds ?? 8;
      const durationInFrames = Math.round(clipDurationSeconds * FPS);

      // Ensure filename ends with .mp4
      let filename = params.filename;
      if (!filename.toLowerCase().endsWith(".mp4")) {
        filename = `${filename}.mp4`;
      }

      console.log(
        `RemotionService: Rendering BrandedVideo composition for user ${params.userId}, clip: ${params.clipUrl}`
      );

      const inputProps = {
        clipUrl: params.clipUrl,
        brandName: params.brandName,
        tagline: params.tagline,
        primaryColor: params.primaryColor,
        secondaryColor: params.secondaryColor,
        logoUrl: params.logoUrl,
        ctaText: params.ctaText,
        ctaUrl: params.ctaUrl,
        introDurationFrames: Math.min(90, Math.round(durationInFrames * 0.35)),
        outroDurationFrames: params.ctaText
          ? Math.min(90, Math.round(durationInFrames * 0.35))
          : 0,
      };

      // Pass durationInFrames via inputProps so the Root composition can
      // read it and override the composition duration at render time.
      // The BrandedVideo Root uses durationInFrames from props when provided.
      const inputPropsWithDuration = {
        ...inputProps,
        durationInFrames,
      };

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
