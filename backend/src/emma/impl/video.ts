/**
 * ENG-2103 (F2) — video tools cluster, extracted from `AgentModeService`.
 * Cluster 21 in this series. Small.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 *   - `getVideoApiDefaultModel` (bare `async`, no access-modifier keyword,
 *     ~2155-2172 pre-extraction) — reads the admin-configured video API
 *     default model setting, falling back to `seedance-2.0`. Sits among
 *     several similarly-named config helpers (`getVideoGenerationDefaultModel`,
 *     `getCustomerSupportDefaultModel`, `getCodingAgentDefaultModel`,
 *     `getVisionModel`, `getVisionModelOptions`) that belong to unrelated code
 *     and were NOT touched.
 *   - `describeVideo` (`public async`, ~9913-10235 pre-extraction) — analyzes
 *     a video via Gemini's video-understanding API.
 *   - `waitForGeminiFileActive` (`public async`, ~10237-10266 pre-extraction)
 *     — a Gemini file-upload-polling helper. Confirmed by whole-backend grep
 *     to have exactly one caller, `describeVideo`, despite being `public`.
 *     DELETED from the class outright (not kept as a wrapper) — moved here as
 *     a module-internal (non-exported) function.
 *
 * One module-level helper moved alongside, exclusive to `describeVideo`
 * (confirmed by whole-backend grep — the only other reference anywhere is a
 * test's `__testHooks.parseTimecodeToSeconds` access):
 *   - `parseTimecodeToSeconds` (was a top-level `export function` in
 *     `agentModeService.ts`, ~line 346) — converts Gemini's MM:SS/HH:MM:SS
 *     timestamps back to numeric seconds. `agentModeService.ts` keeps a
 *     re-export of this name (imports it from here, then
 *     `export { parseTimecodeToSeconds };`) — the same idiom already used
 *     there for `normalizeMetaCampaignIds` — so the existing
 *     `__testHooks.parseTimecodeToSeconds` access keeps working unchanged.
 *
 * `VIDEO_API_MODELS` (was `AgentModeService.VIDEO_API_MODELS`) now lives in
 * `services/videoModels.ts` as `VIDEO_MODELS`, shared with the video service so
 * the allowed list and legacy-Veo aliasing cannot drift.
 *
 * `IMAGE_EXTENSIONS` is NOT moved — the original set is shared with an
 * out-of-scope call site elsewhere in `agentModeService.ts` (unrelated to
 * this cluster), so the tiny literal is duplicated here instead, per the F2
 * design draft §3.2 ("just strings/literals; inline them").
 *
 * The `agent_mode_video_api_default_model` settings-name constant (was
 * `this.videoApiDefaultModelSettingName`, confirmed exclusive to this method)
 * is inlined directly, per the same §3.2 guidance, matching the established
 * idiom (`books.ts`'s `'agent_mode_content_model'`, `gtmPlans.ts`'s
 * `'gtm_common_items'`).
 *
 * Zero `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling anywhere in this cluster — all 3
 * methods and the 1 helper were read in full and individually grepped for the
 * four names; none matched.
 *
 * Worth flagging (a different shape, NOT an exclusion): `describeVideo` never
 * goes through `AgentModeService`'s shared `callLLM` gateway — it gets a
 * Gemini client directly via a lazy `await import('../../utils/llmClients')`
 * → `getGeminiClient(...)` and calls `aiClient.models.generateContent(...)`
 * itself, metering the response by hand via `meterUsageFromResponse`
 * (ENG-200/ENG-1961: it needs to CHARGE, not just record, so the client is
 * fetched `metered: false` and metered here explicitly). This is a real,
 * disclosed architectural difference from most tools in this series, but it
 * does not trip this cluster's exclusion criterion, which is specifically
 * about `AgentModeService`'s own `callLLM`/`generateImage`/`describeImage`/
 * `callVisionLLMWithTimeout` methods.
 *
 * `settingsService` (used by `getVideoApiDefaultModel`) is lazy-`require`'d
 * inside the function body, not a top-level import: `settingsService.ts`
 * constructs a real `AWS.DynamoDB.DocumentClient` at module load — the same
 * established idiom as `books.ts`/`gtmPlans.ts`.
 *
 * All other imports below (`getSecret`, `fs`/`os`/`path`, `meterUsageFromResponse`)
 * are unchanged STATIC imports (ENG-2840 removed `axios` and `Readable`: the video
 * download now goes through the lazily imported `utils/callerUrlFetch`), exactly matching how
 * `agentModeService.ts` already imported every one of them — none of these
 * modules imports `agentModeService.ts`, `chatbotService.ts`,
 * `settingsService.ts`, `orgProfileResolver.ts`,
 * `brandGuidelinesPopulation.ts`, or `services/db.ts` (already established
 * safe by prior clusters, e.g. `searchResearch.ts`'s identical import list for
 * `getSecret`/`meterUsageFromResponse`/axios). `getGeminiClient` stays a lazy
 * `await import('../../utils/llmClients')` inside `describeVideo`, exactly as
 * it already was in the original code.
 *
 * All public entry points kept as delegating wrappers on
 * `AgentModeService.prototype.*`:
 *   - `getVideoApiDefaultModel`: NOT kept as a wrapper — deleted from the
 *     class outright. Confirmed by whole-backend grep to have zero callers
 *     beyond `emma/tools.ts`'s `generate_video`, which is repointed to call
 *     this module directly.
 *   - `describeVideo`: kept as a delegating wrapper — real caller beyond
 *     `emma/tools.ts` is `routes/emmaApi.ts`'s `POST /describe-media`
 *     (`type === 'video'` branch), plus
 *     `agentModeService.describeVideo.test.ts`'s many direct real-instance
 *     calls and `routes.emmaApi.test.ts`'s whole-module mock
 *     (`describeVideo: jest.fn()`). `emma/tools.ts`'s `describe_video` tool
 *     is repointed to call this module directly.
 *   - `waitForGeminiFileActive`: NOT kept as a wrapper — deleted from the
 *     class outright (see above).
 *
 * Verified with a module-isolation test (`video.moduleIsolation.test.ts`)
 * that requiring this module alone does NOT load `agentModeService.ts` or
 * `chatbotService.ts`.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getSecret } from '../../utils/secretsManager';
import { meterUsageFromResponse } from '../../utils/llmClients';
import { isSupportedVideoModel, normalizeVideoModel } from '../../services/videoModels';

// Shared with an out-of-scope call site elsewhere in agentModeService.ts
// (unrelated to this cluster) — duplicated here rather than exported/imported
// back, per the F2 design draft §3.2 ("just strings/literals; inline them").
/** Total time for downloading a caller's video, redirects included (the size cap is MAX_DOWNLOADED_VIDEO_SIZE_MB, default 100 MB). */
const VIDEO_DOWNLOAD_TIMEOUT_MS = 180_000;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif', 'ico', 'avif', 'heic', 'heif']);


/**
 * Normalize a video timecode to a numeric number of seconds.
 *
 * Gemini localizes timestamps far more reliably when asked for the MM:SS format
 * (per Google's video-understanding docs), so describe_video requests MM:SS /
 * HH:MM:SS strings and uses this to convert them back to the numeric seconds the
 * transcript/scene schema (and all downstream consumers) expect. Already-numeric
 * values pass through unchanged for backward compatibility.
 *
 * Returns undefined for null/undefined/unparseable input so callers can drop the
 * field rather than emit a misleading 0.
 */
export function parseTimecodeToSeconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // Plain numeric string (e.g. "10", "5.5")
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }

  // Colon-separated timecode: MM:SS or HH:MM:SS (seconds may be fractional)
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(trimmed)) {
    const parts = trimmed.split(':').map(p => parseFloat(p));
    if (parts.some(p => !Number.isFinite(p))) return undefined;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  return undefined;
}

export async function getVideoApiDefaultModel(): Promise<string | undefined> {
  try {
    // Lazy require, not a top-level import: settingsService.ts constructs a real
    // AWS.DynamoDB.DocumentClient at module load.
    const { settingsService } = require('../../services/settingsService') as typeof import('../../services/settingsService');
    const setting = await settingsService.getSetting('agent_mode_video_api_default_model');
    const configuredModel = setting?.settingValue?.trim();
    if (configuredModel) {
      // Retired Veo ids still stored in the setting resolve to gemini-omni-1.1-flash
      // (read-time alias only — the stored value is never rewritten).
      if (isSupportedVideoModel(configuredModel)) {
        return normalizeVideoModel(configuredModel);
      }
      console.warn(`AgentMode: Unsupported video API default model "${configuredModel}" in settings; using hardcoded default.`);
    }
  } catch (error) {
    console.error('AgentMode: Error getting video API default model setting:', error);
  }
  // Seedance 2.0 is the product default for all video generation (gemini-omni is an
  // automatic fallback inside the video service). Return it explicitly so the
  // model is never undefined in logs / cost estimation.
  return 'seedance-2.0';
}

async function waitForGeminiFileActive(aiClient: any, fileName: string): Promise<void> {
  const maxAttempts = 30;
  const delayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let fileInfo: any;
      try {
        fileInfo = await aiClient.files.get({ name: fileName });
      } catch {
        fileInfo = await aiClient.files.get(fileName);
      }

      const state = fileInfo?.state || fileInfo?.file?.state;
      if (state === 'ACTIVE') {
        return;
      }

      if (state === 'FAILED') {
        throw new Error('Gemini file processing failed');
      }
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
    }

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

export async function describeVideo(
  videoFileUrl: string,
  prompt?: string,
  options?: {
    return_transcript?: boolean;
    return_scenes?: boolean;
    start_time?: string;
    end_time?: string;
    /** Attributable user — charges this describe_video LLM spend to their cap (ENG-200). */
    userId?: string;
    /** Chat session the analysis belongs to, so the ledger row is traceable (ENG-1961). */
    sessionId?: string;
  }
): Promise<any> {
  let tempDirPath: string | null = null;
  let uploadedFileName: string | null = null;
  let aiClient: any = null;

  try {
    if (!videoFileUrl) {
      return {
        success: false,
        message: 'No video URL provided'
      };
    }

    try {
      const parsedUrl = new URL(videoFileUrl);
      const ext = path.extname(parsedUrl.pathname).toLowerCase().replace(/^\./, '');
      if (IMAGE_EXTENSIONS.has(ext)) {
        return {
          success: false,
          message: `This appears to be an image file (.${ext}), not a video. Please use the 'describe_image' tool instead to analyze images.`
        };
      }
    } catch {
      // URL parsing failed — continue and let downstream handling deal with it
    }

    const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    const geminiSecretName = `${environment}/AgentWeb/GeminiAPIKey`;
    const geminiApiKey = await getSecret(geminiSecretName);

    if (!geminiApiKey || !geminiApiKey.trim()) {
      return {
        success: false,
        message: 'Gemini API key is empty'
      };
    }

    // Un-metered Gemini client: the wrapped factory only RECORDS burn, so to
    // actually CHARGE describe_video spend to the user's cap we meter the
    // response ourselves via meterUsageFromResponse below (ENG-200). No userId
    // → that meter degrades to a burn-only "system" record (absorbed).
    const { getGeminiClient } = await import('../../utils/llmClients');
    aiClient = await getGeminiClient({ userId: options?.userId, feature: 'agent_task' }, geminiApiKey.trim(), { metered: false });

    const modelName = 'gemini-3-flash-preview';

    // Build structured prompt based on requested output fields
    const wantTranscript = options?.return_transcript === true;
    const wantScenes = options?.return_scenes === true;
    const wantStructured = wantTranscript || wantScenes;
    const timeRange = (options?.start_time || options?.end_time)
      ? `Focus your analysis on the segment from ${options.start_time || 'the beginning'} to ${options.end_time || 'the end'} of the video.`
      : '';

    let analysisPrompt: string;
    if (wantStructured) {
      const fields: string[] = ['description: a concise overall description of the video'];
      if (wantTranscript) {
        fields.push('transcript: an array of objects with {start: string, end: string, text: string} for all spoken content, where start/end are timestamps in MM:SS format (or HH:MM:SS if over an hour)');
      }
      if (wantScenes) {
        fields.push('scenes: an array of objects with {start: string, end: string, title: string, description: string} identifying distinct scene segments, where start/end are timestamps in MM:SS format (or HH:MM:SS if over an hour)');
      }
      fields.push('duration: total video duration as a timestamp in MM:SS format (or HH:MM:SS if over an hour)');
      analysisPrompt = [
        prompt || 'Analyze this video thoroughly.',
        timeRange,
        // Gemini localizes timestamps most accurately in MM:SS (per Google's
        // video-understanding guidance); we parse them back to numeric seconds.
        'For every timestamp, use the MM:SS format (e.g. 01:15 for 1 minute 15 seconds), and base each one on the actual moment it occurs in the video.',
        `Return ONLY a JSON object (no markdown fences) with these fields: ${fields.join('; ')}.`
      ].filter(Boolean).join(' ');
    } else {
      analysisPrompt = [
        prompt || 'Please describe this video in detail. Focus on key events, visual elements, and any spoken content.',
        timeRange
      ].filter(Boolean).join(' ');
    }

    const url = new URL(videoFileUrl);
    const hostname = (url.hostname || '').toLowerCase();
    const isYoutube = hostname.includes('youtube.com') || hostname.includes('youtu.be');

    let contents: any;

    if (isYoutube) {
      contents = [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: videoFileUrl
              }
            },
            { text: analysisPrompt }
          ]
        }
      ];
    } else {
      const maxSizeMb = parseInt(process.env.MAX_DOWNLOADED_VIDEO_SIZE_MB || '100', 10);
      const maxSizeBytes = maxSizeMb * 1024 * 1024;

      // ENG-2840: the URL is the caller's choice, so it is fetched only through the SSRF-guarded fetch (DNS pinned to a public address,
      // every redirect re-checked, the size capped while downloading, the whole download bounded in time). Before, a plain axios GET with
      // no host check and no timeout let any signed-in user make the server request an internal address.
      const { fetchCallerUrlBuffer, CallerUrlBlockedError, CallerUrlTooLargeError } = await import('../../utils/callerUrlFetch');
      let downloaded: { buffer: Buffer; contentType: string };
      try {
        downloaded = await fetchCallerUrlBuffer(videoFileUrl, {
          tool: 'describe_video',
          userId: options?.userId,
          maxBytes: maxSizeBytes,
          timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS,
        });
      } catch (err: any) {
        if (err instanceof CallerUrlTooLargeError) {
          return { success: false, message: `Video file too large for analysis: it exceeds the limit of ${maxSizeMb} MB` };
        }
        if (err instanceof CallerUrlBlockedError) return { success: false, message: err.message };
        throw err;
      }

      const contentTypeHeader = downloaded.contentType || '';
      const urlExtension = path.extname(url.pathname).toLowerCase();
      const mimeTypeMap: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.m4v': 'video/x-m4v',
        '.avi': 'video/x-msvideo'
      };
      const fallbackMimeType = mimeTypeMap[urlExtension] || 'video/mp4';
      const mimeType = contentTypeHeader.startsWith('video/') ? contentTypeHeader : fallbackMimeType;

      // Reject if Content-Type indicates this is an image, not a video
      if (contentTypeHeader.startsWith('image/')) {
        return {
          success: false,
          message: `This appears to be an image file (${contentTypeHeader}), not a video. Please use the 'describe_image' tool instead to analyze images.`
        };
      }

      tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agentweb-video-'));
      const fileExtension = urlExtension || '.mp4';
      const tempFilePath = path.join(tempDirPath, `video${fileExtension}`);

      if (downloaded.buffer.length === 0) {
        return {
          success: false,
          message: 'Downloaded video file is empty'
        };
      }
      await fs.writeFile(tempFilePath, downloaded.buffer);

      const uploadResponse = await aiClient.files.upload({
        file: tempFilePath,
        config: { mimeType }
      });

      const fileUri = uploadResponse.uri || uploadResponse.file?.uri;
      const uploadedMime = uploadResponse.mimeType || uploadResponse.file?.mimeType || mimeType;
      uploadedFileName = uploadResponse.name || uploadResponse.file?.name || fileUri || null;

      if (!fileUri) {
        return {
          success: false,
          message: 'Failed to upload video to Gemini Files API'
        };
      }

      if (uploadedFileName) {
        await waitForGeminiFileActive(aiClient, uploadedFileName);
      }

      contents = [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri,
                mimeType: uploadedMime
              }
            },
            { text: analysisPrompt }
          ]
        }
      ];
    }

    const response = await aiClient.models.generateContent({
      model: modelName,
      contents
    });

    // Charge (record + deduct when a userId is present; absorb under "system"
    // otherwise). The client above is un-metered, so this is the single meter.
    // ENG-1961: named `describe_video` rather than the catch-all `agent_task`,
    // and carrying the session, so this spend is attributable the same way
    // describeImage's is. The user was already correct (ENG-200).
    meterUsageFromResponse(
      {
        userId: options?.userId,
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        model: modelName,
        provider: 'gemini',
        feature: 'describe_video',
      },
      response
    );

    const rawText = response.text;

    if (!rawText) {
      return {
        success: false,
        message: 'No description returned from Gemini'
      };
    }

    // When structured output was requested, try to parse JSON from Gemini
    if (wantStructured) {
      try {
        // Strip optional markdown code fences Gemini may add despite instructions
        const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const parsed = JSON.parse(jsonText);

        // Gemini is prompted for MM:SS timestamps (most accurate); convert them
        // back to the numeric seconds the transcript/scene schema expects.
        const normalizeSegments = (segments: any): any => {
          if (!Array.isArray(segments)) return segments;
          return segments.map(seg => {
            if (!seg || typeof seg !== 'object') return seg;
            const start = parseTimecodeToSeconds(seg.start);
            const end = parseTimecodeToSeconds(seg.end);
            return {
              ...seg,
              ...(start !== undefined ? { start } : {}),
              ...(end !== undefined ? { end } : {}),
            };
          });
        };
        const normalizedDuration = parseTimecodeToSeconds(parsed.duration);

        return {
          success: true,
          description: parsed.description || rawText,
          ...(wantTranscript && parsed.transcript !== undefined ? { transcript: normalizeSegments(parsed.transcript) } : {}),
          ...(wantScenes && parsed.scenes !== undefined ? { scenes: normalizeSegments(parsed.scenes) } : {}),
          ...(normalizedDuration !== undefined ? { duration: normalizedDuration } : {}),
          videoUrl: videoFileUrl
        };
      } catch {
        // Gemini returned non-JSON despite instruction — fall back to plain description
        return {
          success: true,
          description: rawText,
          videoUrl: videoFileUrl
        };
      }
    }

    return {
      success: true,
      description: rawText,
      videoUrl: videoFileUrl
    };
  } catch (error) {
    console.error('AgentMode: Error describing video:', error);
    return {
      success: false,
      message: 'Failed to analyze video. Please check that the URL is accessible and contains a valid video.',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    if (aiClient && uploadedFileName) {
      try {
        await aiClient.files.delete({ name: uploadedFileName });
      } catch (cleanupError) {
        try {
          await (aiClient.files as any).delete(uploadedFileName);
        } catch (fallbackError) {
          console.warn('AgentMode: Failed to delete uploaded Gemini file:', fallbackError);
        }
      }
    }

    if (tempDirPath) {
      try {
        await fs.rm(tempDirPath, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('AgentMode: Failed to clean up temp video file:', cleanupError);
      }
    }
  }
}
