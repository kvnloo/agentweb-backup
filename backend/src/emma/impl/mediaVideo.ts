/**
 * ENG-2103 (F2) — video-generation / media-post-processing tool cluster,
 * extracted from `AgentModeService`. The eighth domain cluster in this
 * series.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * generateVideo, muxVideoWithAudio, generateVoiceover, composeVideo,
 * listVideoCharacters, getVideoCharacter, createVideoCharacter,
 * deleteVideoCharacter, removeC2PAFromImage, removeImageBackground — plus the
 * private helper `estimateVideoGenerationCost` (used only by generateVideo,
 * zero other callers/spies, so moved and deleted from the class rather than
 * promoted to a shared module).
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions rather
 * than duplicating them: emma/tools.ts is the only real caller for all 10
 * (whole-backend grep, no other route/service/cron calls any of them
 * directly), but 4 of the 10 (generateVideo, composeVideo,
 * removeC2PAFromImage, removeImageBackground) have dedicated test files that
 * call `(agentModeService as any).<method>` directly on the real singleton
 * (agentModeService.generateVideo.test.ts, .composeVideo.test.ts,
 * .removeC2PA.test.ts, .removeImageBackground.test.ts) — deleting those 4
 * would break those suites. The other 6 keep their delegates too, matching
 * this series' established convention of keeping every PUBLIC tool-facing
 * method as a delegate even when its only caller is emma/tools.ts (see
 * gtmPlans.ts/leads.ts's own reasoning) — only genuinely private, zero-
 * external-reference pure helpers are deleted outright.
 *
 * FLAGGED, NOT EXTRACTED: `generateImage` (the 11th method in this same
 * source range, sitting directly before generateVideo) is deliberately
 * excluded. It is a NEW SHAPE of the `this.callLLM` disqualifying-coupling
 * pattern this series has flagged before (createHtmlFromTemplate,
 * updateEmailDraftForLead, importLeadsFromSearch) — but one hop removed:
 * generateImage does not call `this.callLLM` directly anywhere in its own
 * body. It calls `this.describeImage(...)` (a "FABRICATED_METRICS_CHECK" on
 * the generated image), and describeImage's OWN body calls
 * `this.callVisionLLMWithTimeout(...)`, a private helper that itself calls
 * `this.callLLM` twice. Neither describeImage nor callVisionLLMWithTimeout
 * are part of this cluster or moved. Extracting generateImage would require
 * deciding how a standalone module reaches that vision-LLM-gateway chain —
 * the same category of design decision the coordinator asked to have flagged
 * back rather than guessed at, so generateImage (and its own 4 exclusive
 * private helpers — getImageApiDefaultModel, getImageGenerationFallbackModel,
 * isRetryableMediaToolError, estimateImageGenerationCost, all used ONLY by
 * generateImage) are left untouched on the class.
 *
 * Transitive-import notes: `chatbotDb` (used by generateVideo for session
 * cost/message bookkeeping) was reached via agentModeService.ts's top-level
 * `chatbotService` import, but chatbotService.ts itself top-level-imports
 * aws-sdk (constructs a real client at module scope) — the same
 * transitive-import trap round 2's createGTMPlan hit with
 * chatbotDb.getChatSession. Lazily `await import()`'d inside generateVideo
 * instead. `videoGenerationCostUsd` (from utils/llmPricing.ts, which has ZERO
 * imports of its own — a pure pricing-table module) is a safe top-level
 * import. videoGeneration.ts, voiceoverService.ts, remotionService.ts,
 * characterDb.ts, and imageGeneration.ts were already lazily `await
 * import()`'d inline in the original source for every one of these 10
 * methods — kept exactly as-is, same load timing as before. `axios` and
 * `sharp` are loaded via synchronous `require()` inside
 * removeC2PAFromImage/removeImageBackground, also unchanged from the
 * original — neither constructs anything at module scope.
 *
 * Metering/RunFunding audit: zero matches for llmService, generateJSONContent,
 * callLLM, meterUserUsage, currentRunFunding, or any LLM-provider name across
 * the whole cluster. generateVideo's chatbotDb.addToolCostToSession call is a
 * per-session cost-display bucket, not the usageContext/billingUserId-
 * forwarding metering chokepoint this audit watches for — per its own
 * pre-existing comment, the actual usage metering fires once at the
 * generation SOURCE (videoService.generateVideo), unmodified by this move.
 */

import { videoGenerationCostUsd } from '../../utils/llmPricing';


  /**
   * Generate a video using AI video generation models
   */
export async function generateVideo(
    prompt: string,
    filename: string,
    userId: string,
    sessionId: string,
    videoModel?: string,
    startFrame?: string,
    endFrame?: string,
    compose?: boolean,
    composeParams?: Record<string, any>,
    durationSeconds?: number,
    useKeyframes?: boolean,
    aspectRatio?: string,
    resolution?: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Generating video with prompt:', prompt, 'filename:', filename, 'videoModel:', videoModel, 'startFrame:', startFrame ? 'provided' : 'none', 'endFrame:', endFrame ? 'provided' : 'none', 'compose:', compose ?? false, 'durationSeconds:', durationSeconds, 'useKeyframes:', useKeyframes ?? false, 'aspectRatio:', aspectRatio, 'resolution:', resolution, 'userId:', userId, 'sessionId:', sessionId);

      // Import the video generation service
      const { videoService } = await import('../../services/videoGeneration');
      // ENG-2103 (F2): lazily required — chatbotService.ts top-level imports
      // aws-sdk (constructs a real AWS client at module scope), so this
      // cannot be a top-level import here even though it was one in
      // agentModeService.ts (established precedent: round 2's
      // createGTMPlan/chatbotDb.getChatSession finding).
      const { chatbotDb } = await import('../../services/chatbotService');

      // Check if the service is available
      const isAvailable = await videoService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Video generation service is not available. Please check API key configuration in AWS Secrets Manager.',
          error: 'Service unavailable'
        };
      }

      // Generate the video
      const result = await videoService.generateVideo({
        prompt,
        filename,
        userId,
        videoModel,
        startFrame,
        endFrame,
        durationSeconds,
        useKeyframes,
        compose,
        composeParams: composeParams as any,
        aspectRatio,
        resolution,
      });

      if (result.success && result.videoUrl) {
        // Session cost accounting (agent-mode chat). The per-user burn shadow record is
        // fired once at the generation SOURCE (videoService.generateVideo) so every caller
        // is metered exactly once — see llmPricing.videoGenerationCostUsd (ENG-200).
        const videoCost = estimateVideoGenerationCost(videoModel || 'veo-3.1-generate-preview', durationSeconds);
        chatbotDb.addToolCostToSession(sessionId, videoCost, 'generateVideo').catch((err) =>
          console.error('AgentMode: Failed to add video cost to session:', err)
        );

        // Save the video URL to the session for reference
        const videoData = {
          url: result.videoUrl,
          filename: result.filename,
          generatedAt: new Date().toISOString(),
          prompt: prompt,
          model: videoModel || 'veo-3.1-generate-preview'
        };

        // Store video data in session metadata (optional)
        try {
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'system',
            content: `Video generated: ${result.filename}`,
            metadata: {
              timestamp: new Date().toISOString()
            }
          });
        } catch (error) {
          console.warn('Failed to store video generation metadata:', error);
        }

        const isComposed = Boolean((result as any).composedVideoUrl);
        return {
          success: true,
          message: isComposed
            ? `✅ Video "${result.filename}" generated and composed with brand overlays!`
            : `✅ Video "${result.filename}" generated successfully!`,
          videoUrl: result.videoUrl,
          ...(isComposed && { composedVideoUrl: (result as any).composedVideoUrl }),
          filename: result.filename,
          prompt: prompt,
          model: videoModel || 'veo-3.1-generate-preview',
          composed: isComposed,
        };
      } else {
        return {
          success: false,
          message: result.error || 'Failed to generate video',
          error: result.error
        };
      }

    } catch (error: any) {
      console.error('AgentMode: Error generating video:', error);
      return {
        success: false,
        message: 'Failed to generate video',
        error: error.message
      };
    }
  }

  /**
   * Mux a video file with a voiceover audio track using ffmpeg.
   */
export async function muxVideoWithAudio(
    videoUrl: string,
    audioUrl: string,
    outputFilename: string,
    userId: string,
    _sessionId: string
  ): Promise<any> {
    try {
      console.log(`AgentMode: Muxing video+audio for user ${userId}`);
      const { muxVideoWithAudio } = await import('../../services/voiceoverService');
      const result = await muxVideoWithAudio(videoUrl, audioUrl, outputFilename, userId);
      if (result.success && result.videoUrl) {
        return {
          success: true,
          message: `✅ Video with voiceover "${result.filename}" ready!`,
          videoUrl: result.videoUrl,
          filename: result.filename,
        };
      }
      return { success: false, message: result.error || 'Mux failed', error: result.error };
    } catch (error: any) {
      console.error('AgentMode: Error muxing video+audio:', error);
      return { success: false, message: 'Failed to combine video and audio', error: error.message };
    }
  }

  /**
   * Generate voiceover audio from a script using ElevenLabs TTS.
   */
export async function generateVoiceover(
    script: string,
    filename: string,
    userId: string,
    sessionId: string,
    voice?: string,
    stability?: number,
    similarityBoost?: number
  ): Promise<any> {
    try {
      console.log(`AgentMode: Generating voiceover, script length=${script?.length}, voice=${voice ?? 'george'}, userId=${userId}`);
      const { generateVoiceover, isAvailable } = await import('../../services/voiceoverService');
      if (!await isAvailable()) {
        return { success: false, message: 'Voiceover service is not available. ElevenLabs API key may not be configured.', error: 'Service unavailable' };
      }
      const result = await generateVoiceover(script, filename, userId, voice, stability, similarityBoost);
      if (result.success && result.audioUrl) {
        return {
          success: true,
          message: `✅ Voiceover "${result.filename}" generated successfully!`,
          audioUrl: result.audioUrl,
          filename: result.filename,
          durationSeconds: result.durationSeconds,
          voiceId: result.voiceId,
        };
      }
      return { success: false, message: result.error || 'Failed to generate voiceover', error: result.error };
    } catch (error: any) {
      console.error('AgentMode: Error generating voiceover:', error);
      return { success: false, message: 'Failed to generate voiceover', error: error.message };
    }
  }

  /**
   * Compose pre-existing video clips into a branded final video using Remotion.
   * Use this when clips have already been generated and need to be stitched + branded.
   */
export async function composeVideo(
    clipUrls: string[],
    filename: string,
    userId: string,
    sessionId: string,
    composeParams: Record<string, any>,
    clipDurationSeconds?: number,
    targetDurationSeconds?: number,
    clipDurationsSeconds?: number[]
  ): Promise<any> {
    try {
      if (!clipUrls || clipUrls.length === 0) {
        return { success: false, message: 'At least one clip URL is required', error: 'missing_clip_urls' };
      }

      console.log(`AgentMode: Composing ${clipUrls.length} pre-existing clip(s) for user ${userId}`);

      const { remotionService } = await import('../../services/remotionService');
      const composeResult = await remotionService.compose({
        brandName: composeParams.brandName,
        tagline: composeParams.tagline,
        primaryColor: composeParams.primaryColor,
        secondaryColor: composeParams.secondaryColor,
        logoUrl: composeParams.logoUrl,
        ctaText: composeParams.ctaText,
        ctaUrl: composeParams.ctaUrl,
        // Forward the optional voiceover track so a spot composed via compose_video is
        // never shipped silent (ENG-123). remotionService.compose + the BrandedVideo
        // composition both support an audio overlay; omitting these here dropped it.
        audioUrl: composeParams.audioUrl,
        audioVolume: composeParams.audioVolume,
        clipUrl: clipUrls[0],
        extraClipUrls: clipUrls.slice(1),
        clipDurationSeconds: clipDurationSeconds ?? 8,
        targetDurationSeconds,
        clipDurationsSeconds,
        // Run's remaining media-gen budget (epoch ms), threaded from the tool context, so a
        // long render on a revision pass hands off instead of blocking until the run's hard
        // wall-clock timeout kills it with no asset (ENG-123).
        renderDeadlineMs: composeParams.renderDeadlineMs,
        filename,
        userId,
      });

      // Regression tripwire (ENG-123): a spot must never silently ship without a voiceover.
      // Surface a soft warning when composed with no audio track — catches revision passes
      // where the agent recomposes and forgets to re-attach the VO. Not a hard failure:
      // silent b-roll stitching is still valid.
      const voiceoverWarning = !composeParams.audioUrl
        ? 'Composed with no voiceover track. If this is an ad spot, generate one with generate_voiceover and pass audio_url so it is not shipped silent.'
        : undefined;

      if (composeResult.success && composeResult.videoUrl) {
        const stillProcessing = composeResult.status === 'processing';
        // Combine any composition-layer advisory (e.g. duration clamp) with the voiceover
        // tripwire so the user sees every relevant note, not just one.
        const warning = [composeResult.warning, voiceoverWarning].filter(Boolean).join(' ') || undefined;
        return {
          success: true,
          message: stillProcessing
            ? (composeResult.message ?? `🎬 ${clipUrls.length} clip(s) are still finalizing — the video will be ready at this link shortly.`)
            : `✅ ${clipUrls.length} clip(s) composed into branded video!`,
          videoUrl: composeResult.videoUrl,
          filename: composeResult.filename ?? filename,
          ...(stillProcessing && { status: 'processing' as const }),
          ...(warning && { warning }),
        };
      }

      return {
        success: false,
        message: composeResult.error || 'Composition failed',
        error: composeResult.error,
      };
    } catch (error: any) {
      console.error('AgentMode: Error composing video:', error);
      return { success: false, message: 'Failed to compose video', error: error.message };
    }
  }

  // ---- Video character management ----

export async function listVideoCharacters(userId: string): Promise<any> {
    try {
      const { characterDb } = await import('../../services/characterDb');
      const characters = await characterDb.listCharacters(userId);
      return { success: true, characters };
    } catch (error: any) {
      console.error('AgentMode: Error listing characters:', error);
      return { success: false, message: 'Failed to list characters', error: error.message };
    }
  }

export async function getVideoCharacter(characterId: string): Promise<any> {
    try {
      const { characterDb } = await import('../../services/characterDb');
      const character = await characterDb.getCharacterById(characterId);
      if (!character) return { success: false, message: 'Character not found' };
      return { success: true, character };
    } catch (error: any) {
      console.error('AgentMode: Error getting character:', error);
      return { success: false, message: 'Failed to get character', error: error.message };
    }
  }

export async function createVideoCharacter(userId: string, input: {
    name: string;
    description: string;
    referenceImageUrl: string;
    referenceImageKey: string;
    prompt: string;
  }): Promise<any> {
    try {
      const { characterDb } = await import('../../services/characterDb');
      const character = await characterDb.createCharacter(userId, input);
      return { success: true, character };
    } catch (error: any) {
      console.error('AgentMode: Error creating character:', error);
      return { success: false, message: 'Failed to create character', error: error.message };
    }
  }

export async function deleteVideoCharacter(userId: string, characterId: string): Promise<any> {
    try {
      const { characterDb } = await import('../../services/characterDb');
      const character = await characterDb.getCharacterById(characterId);
      if (!character) return { success: false, message: 'Character not found' };
      if (character.userId !== userId) return { success: false, message: 'Not authorized' };
      await characterDb.deleteCharacter(userId, characterId);
      return { success: true, message: 'Character deleted' };
    } catch (error: any) {
      console.error('AgentMode: Error deleting character:', error);
      return { success: false, message: 'Failed to delete character', error: error.message };
    }
  }

  /**
   * Remove C2PA metadata from an image by downloading it, stripping metadata, and uploading to S3
   */
export async function removeC2PAFromImage(
    imageUrl: string,
    filename?: string,
    userId?: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Removing C2PA metadata from image:', imageUrl);

      if (!imageUrl) {
        return {
          success: false,
          message: 'Image URL is required',
          error: 'missing_image_url'
        };
      }

      // Import required services
      const axios = require('axios');
      const { uploadFileToS3 } = await import('../../utils/s3Utils');
      const { imageService } = await import('../../services/imageGeneration');

      // Download the image
      let imageBuffer: Buffer;
      if (imageUrl.startsWith('data:image/')) {
        // Handle data URL
        const base64Data = imageUrl.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        // Download from URL
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
          }
        });
        imageBuffer = Buffer.from(response.data);
      }

      // Remove C2PA metadata using the imageService's method
      const cleanedBuffer = await imageService.removeC2PAMetadata(imageBuffer);

      // Generate filename if not provided
      let finalFilename = filename;
      if (!finalFilename) {
        // Extract filename from URL or generate one
        try {
          const urlObj = new URL(imageUrl);
          const pathParts = urlObj.pathname.split('/');
          const urlFilename = pathParts[pathParts.length - 1];
          if (urlFilename && urlFilename.includes('.')) {
            // Replace extension with .png
            const nameWithoutExt = urlFilename.substring(0, urlFilename.lastIndexOf('.'));
            finalFilename = `${nameWithoutExt}_no_c2pa.png`;
          } else {
            finalFilename = `image_no_c2pa_${Date.now()}.png`;
          }
        } catch {
          finalFilename = `image_no_c2pa_${Date.now()}.png`;
        }
      } else if (!finalFilename.endsWith('.png')) {
        // Ensure .png extension
        const dotIndex = finalFilename.lastIndexOf('.');
        const nameWithoutExt = dotIndex > 0 ? finalFilename.substring(0, dotIndex) : finalFilename;
        finalFilename = `${nameWithoutExt}.png`;
      }

      // Upload to S3
      if (!userId) {
        return {
          success: false,
          message: 'User ID is required for S3 upload',
          error: 'missing_user_id'
        };
      }

      const uploadResult = await uploadFileToS3(
        cleanedBuffer,
        finalFilename,
        userId,
        'image/png'
      );

      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          message: uploadResult.error || 'Failed to upload cleaned image to S3',
          error: uploadResult.error || 's3_upload_failed'
        };
      }

      return {
        success: true,
        message: `✅ C2PA metadata removed successfully! Image uploaded to S3.`,
        imageUrl: uploadResult.url,
        filename: finalFilename,
        originalUrl: imageUrl
      };

    } catch (error: any) {
      console.error('AgentMode: Error removing C2PA metadata:', error);
      return {
        success: false,
        message: 'Failed to remove C2PA metadata from image',
        error: error.message
      };
    }
  }

  /**
   * Remove a solid/near-solid background from an image, producing a genuine
   * transparent-alpha PNG WITHOUT redrawing the artwork, and upload it to S3.
   *
   * This is the correct tool for "make this logo transparent" / "put this logo
   * on a different colored background". It operates on the original pixels
   * (edge-seeded flood fill), so the brand mark — its exact letters, shapes and
   * colors — is preserved byte-for-byte; only the background becomes alpha=0.
   *
   * Optionally validates foreground/background contrast: if `surfaceColor`
   * (the hex color of the surface the logo will sit on, e.g. a dark header) is
   * provided, the result includes a WCAG contrast ratio and a warning when the
   * logo would be hard to read on that surface (e.g. a dark wordmark on a dark
   * header). This guards against the "black logo on dark purple" mistake.
   */
export async function removeImageBackground(
    imageUrl: string,
    filename?: string,
    userId?: string,
    options?: { tolerance?: number; surfaceColor?: string }
  ): Promise<any> {
    try {
      console.log('AgentMode: Removing background from image:', imageUrl);

      if (!imageUrl) {
        return {
          success: false,
          message: 'Image URL is required',
          error: 'missing_image_url'
        };
      }

      const axios = require('axios');
      const { uploadFileToS3 } = await import('../../utils/s3Utils');
      const { imageService, ImageService } = await import('../../services/imageGeneration');

      // Download the image (supports data URLs and HTTP(S) URLs).
      let imageBuffer: Buffer;
      if (imageUrl.startsWith('data:image/')) {
        const base64Data = imageUrl.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
          }
        });
        imageBuffer = Buffer.from(response.data);
      }

      const { buffer, detectedBackground, removedRatio } = await imageService.removeImageBackground(
        imageBuffer,
        { tolerance: options?.tolerance }
      );

      // Generate filename if not provided; always output PNG (alpha requires it).
      let finalFilename = filename;
      if (!finalFilename) {
        try {
          const urlObj = new URL(imageUrl);
          const pathParts = urlObj.pathname.split('/');
          const urlFilename = pathParts[pathParts.length - 1];
          if (urlFilename && urlFilename.includes('.')) {
            const nameWithoutExt = urlFilename.substring(0, urlFilename.lastIndexOf('.'));
            finalFilename = `${nameWithoutExt}_transparent.png`;
          } else {
            finalFilename = `image_transparent_${Date.now()}.png`;
          }
        } catch {
          finalFilename = `image_transparent_${Date.now()}.png`;
        }
      } else if (!finalFilename.endsWith('.png')) {
        const dotIndex = finalFilename.lastIndexOf('.');
        const nameWithoutExt = dotIndex > 0 ? finalFilename.substring(0, dotIndex) : finalFilename;
        finalFilename = `${nameWithoutExt}.png`;
      }

      if (!userId) {
        return {
          success: false,
          message: 'User ID is required for S3 upload',
          error: 'missing_user_id'
        };
      }

      const uploadResult = await uploadFileToS3(
        buffer,
        finalFilename,
        userId,
        'image/png'
      );

      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          message: uploadResult.error || 'Failed to upload transparent image to S3',
          error: uploadResult.error || 's3_upload_failed'
        };
      }

      // Optional foreground/background contrast check against the target surface.
      let contrast: any = undefined;
      if (options?.surfaceColor) {
        const surface = ImageService.parseHexColor(options.surfaceColor);
        if (!surface) {
          contrast = {
            surfaceColor: options.surfaceColor,
            warning: `Could not parse surfaceColor "${options.surfaceColor}" as a hex color; skipped contrast check.`
          };
        } else {
          // Re-read the transparent PNG's opaque pixels to estimate the logo's color.
          // Wrapped in its own try/catch: the image was already uploaded
          // successfully, so a failure here should only drop the contrast info,
          // not fail the whole operation.
          try {
            const sharp = require('sharp');
            const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
            const fg = ImageService.averageOpaqueColor(data, (info as any).channels);
            if (fg) {
              const ratio = ImageService.contrastRatio(fg, surface);
              const legible = ratio >= 3; // WCAG AA for large text / graphical objects
              contrast = {
                surfaceColor: options.surfaceColor,
                foregroundColor: `rgb(${fg.r}, ${fg.g}, ${fg.b})`,
                ratio: Math.round(ratio * 100) / 100,
                legible,
                ...(legible
                  ? {}
                  : {
                      warning:
                        `⚠️ Low contrast (${Math.round(ratio * 100) / 100}:1, below the 3:1 minimum): the logo's ` +
                        `average color rgb(${fg.r}, ${fg.g}, ${fg.b}) may be hard to read on surface ${options.surfaceColor}. ` +
                        `Consider an all-white or all-dark variant of the logo to match this surface.`
                    })
              };
            }
          } catch (contrastError: any) {
            console.warn('AgentMode: contrast check failed (image still uploaded):', contrastError?.message);
          }
        }
      }

      return {
        success: true,
        message:
          `✅ Background removed — genuine transparent-alpha PNG produced (original artwork preserved). ` +
          `Detected background rgb(${detectedBackground.r}, ${detectedBackground.g}, ${detectedBackground.b}); ` +
          `${Math.round(removedRatio * 100)}% of pixels made transparent.` +
          (contrast?.warning ? ` ${contrast.warning}` : ''),
        imageUrl: uploadResult.url,
        filename: finalFilename,
        originalUrl: imageUrl,
        detectedBackground,
        removedRatio,
        ...(contrast ? { contrast } : {})
      };
    } catch (error: any) {
      console.error('AgentMode: Error removing background from image:', error);
      return {
        success: false,
        message: 'Failed to remove background from image',
        error: error.message
      };
    }
  }

  /** Cost per video generation in USD. Veo bills per 8s clip, so longer videos cost proportionally more. */
function estimateVideoGenerationCost(model: string, durationSeconds?: number): number {
    // Per-clip rates sourced from llmPricing (single source of truth).
    return videoGenerationCostUsd(model, durationSeconds);
  }
