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
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A) — `describeImage`
 * and `generateImage` MOVED HERE. Originally flagged and excluded (see the
 * design-decision list): `generateImage` never calls `this.callLLM` directly
 * — it calls `this.describeImage(...)` (a "FABRICATED_METRICS_CHECK" on the
 * generated image), and describeImage's OWN body calls
 * `this.callVisionLLMWithTimeout(...)`, a private helper that itself calls
 * `this.callLLM` twice — a one-hop-removed variant of the same
 * `this.callLLM` coupling as `createHtmlFromTemplate`/
 * `updateEmailDraftForLead`/`importLeadsFromSearch`/`resolveEmployersForSizeFilter`.
 * Since both chain members target the SAME module, the chain collapses
 * cleanly:
 *
 *  - `callVisionLLMWithTimeout` (private helper, confirmed by whole-backend
 *    grep to have exactly ONE caller, `describeImage`) and
 *    `resolveDescribeImageTimeoutMs` (was `static`) moved verbatim, along
 *    with the `DEFAULT_DESCRIBE_IMAGE_TIMEOUT_MS` constant they share.
 *    `callVisionLLMWithTimeout` is not exported (nothing outside this module
 *    ever called it); `resolveDescribeImageTimeoutMs` IS exported because
 *    `agentModeService.describeImageTimeout.test.ts` asserts on it directly
 *    (retargeted from `AgentModeService.resolveDescribeImageTimeoutMs`).
 *  - `describeImage` moved verbatim, exported, with `callLLM` injected as
 *    `DescribeImageLlmCall` (a narrow structural type covering only the one
 *    call shape `callVisionLLMWithTimeout` actually sends — not the full
 *    private `LLMCallOptions` interface this module must not import anyway,
 *    same discipline as `createHtmlFromTemplate`'s
 *    `CreateHtmlFromTemplateLlmCall`) and `getVisionModel` injected as
 *    `GetVisionModelFn` (genuine LLM-gateway/routing infrastructure — it
 *    resolves `agent_mode_vision_model` from settings — same "never a
 *    candidate for extraction, same category as `callLLM` itself" reasoning
 *    already applied to `getDefaultModel`/`resolveGenerationModel`).
 *    `AgentModeService.prototype.normalizeImageForVision` (was `private
 *    static`, zero callers beyond `describeImage`) and its
 *    `VISION_NATIVE_MEDIA_TYPES` companion constant moved verbatim too,
 *    exported for `agentModeService.describeImageNormalize.test.ts`
 *    (retargeted from `(AgentModeService as any).normalizeImageForVision`).
 *  - `generateImage` moved verbatim, exported, with `callLLM` AND
 *    `getVisionModel` injected ONCE at its own top level (read the body in
 *    full to confirm: `generateImage` itself never calls `this.callLLM`
 *    directly — its ONLY LLM-reaching path is the data-fabrication check
 *    through `describeImage`). Its internal `this.describeImage(...)` call
 *    collapses to a plain same-module call, `self.describeImage(...)`,
 *    forwarding the SAME injected `callLLM`/`getVisionModel` through — NOT a
 *    second, redundant injection point for the same underlying capability.
 *  - Its own 3 exclusive private helpers — `getImageGenerationFallbackModel`,
 *    `isRetryableMediaToolError`, `estimateImageGenerationCost` — are pure
 *    (zero `this.*` reads in their bodies, confirmed by reading each one)
 *    and moved as plain exports/functions, called directly (no injection
 *    needed, since they and `generateImage` now live in the same module).
 *    `getImageGenerationFallbackModel`/`estimateImageGenerationCost` are kept
 *    as thin `private` delegating wrappers on `AgentModeService` ONLY because
 *    `agentModeService.generateImage.test.ts` binds them off the real
 *    instance (`(agentModeService as any).<name>.bind(agentModeService)`) —
 *    a pure-function body behind a delegate needs no injection, same
 *    treatment `estimateCost`/`sharedEstimateLlmCost` already has elsewhere
 *    in `agentModeService.ts`. `isRetryableMediaToolError` has zero such
 *    test dependency (confirmed by grep) and was moved + deleted from the
 *    class outright, called as a local function.
 *  - **Correction to the original (pre-this-round) header note above**: a
 *    4th "exclusive private helper", `getImageApiDefaultModel`, was claimed
 *    to belong to this chain. Reading `generateImage`'s actual body (not
 *    re-trusting the old claim) shows it is NEVER called there —
 *    `generateImage` resolves its model via `resolveModelForUser(userId,
 *    'image')` (`services/modelRoles.ts`), which reads
 *    `agent_mode_image_api_default_model`/`default_image_model` from
 *    settings directly and has no dependency on
 *    `AgentModeService.prototype.getImageApiDefaultModel` at all.
 *    `getImageApiDefaultModel` is `public`, has its own test dependencies
 *    (`emmaToolGateWiring.test.ts` `jest.spyOn`s it;
 *    `foreplayDiscovery.test.ts` mocks it) unrelated to image generation, and
 *    is left completely untouched on the class — not part of this cluster.
 *
 * Real callers beyond `emma/tools.ts` for BOTH moved methods (whole-backend
 * grep): `routes/emmaApi.ts`'s `POST /generate-image` and `POST
 * /describe-media` (the non-`video` branch) both call
 * `(await getAgentModeService()).generateImage(...)` /
 * `.describeImage(...)` — so both class methods are kept as delegating
 * wrappers, never deleted. `emma/tools.ts`'s `describe_image`/`generate_image`
 * tools are repointed to call this module directly (binding
 * `agentModeService.callLLM`/`agentModeService.getVisionModel` straight off
 * the singleton), the same shape as `createHtmlFromTemplate`'s tool wiring —
 * the class wrapper exists for `routes/emmaApi.ts` and direct-instance tests,
 * not for `emma/tools.ts`.
 *
 * Sibling-function-spy issue (cluster-10 lesson), hit twice in this round,
 * both fixed with the same-module self-import (`import * as self from
 * './mediaVideo'`, referenced only inside the two call sites below) and
 * verified with actual mutation testing (temporarily reverted to a direct
 * local-function call, confirmed the dependent tests failed as predicted,
 * restored):
 *  1. `callVisionLLMWithTimeout` calls `self.resolveDescribeImageTimeoutMs()`
 *     — `agentModeService.describeImageTimeout.test.ts` spies on the
 *     exported `resolveDescribeImageTimeoutMs` while exercising
 *     `describeImage`'s real timeout behavior; a plain local-function
 *     reference would silently stop routing through the spied export.
 *  2. `generateImage` calls `self.describeImage(...)` for its
 *     data-fabrication check — `agentModeService.generateImage.test.ts`'s
 *     "Data-fabrication backstop wiring" suite spies on the exported
 *     `describeImage` while exercising `generateImage`'s real wiring
 *     (retargeted from `jest.spyOn(agentModeService, 'describeImage')`).
 *
 * Transitive-import notes: `chatbotDb` (used by generateVideo for session
 * cost/message bookkeeping, and by generateImage for the same reason) was
 * reached via agentModeService.ts's top-level `chatbotService` import, but
 * chatbotService.ts itself top-level-imports aws-sdk (constructs a real
 * client at module scope) — the same transitive-import trap round 2's
 * createGTMPlan hit with chatbotDb.getChatSession. Lazily `await import()`'d
 * inside generateVideo/generateImage instead. `enqueueAutoHumanEval`
 * (`services/autoHumanEvalService.ts`) statically imports `settingsService`,
 * which constructs a real `AWS.DynamoDB.DocumentClient` at module scope
 * (unconditionally, not behind a lazy guard) — lazily `await import()`'d
 * inside `generateImage` for the same reason, a NEW instance of this
 * established trap, confirmed by `mediaVideo.moduleIsolation.test.ts`'s new
 * settingsService guard. `recordGeneratedCreative`
 * (`services/creativeLineage.ts`) is a SAFE top-level import despite also
 * touching `aws-sdk`/DynamoDB: its `documentClientDb()` constructs the real
 * client lazily inside a function body (`if (!defaultDb) { ... }`), not at
 * module scope — confirmed by reading the file directly, not assumed.
 * `brandLogo.ts`/`dataFabricationGuard.ts`/`generateImagePlacement.ts` have
 * zero imports of their own (or only a pure constants module), and
 * `modelRoles.ts`/`agentModeErrors.ts`/`ssrfGuard.ts`/`imageGeneration.ts`
 * (for `normalizeImageModel`) are already safe top-level imports elsewhere in
 * this series — all six are plain top-level imports here too.
 * `videoGenerationCostUsd`/`imageGenerationCostUsd` (from utils/llmPricing.ts,
 * which has ZERO imports of its own — a pure pricing-table module) are safe
 * top-level imports. videoGeneration.ts, voiceoverService.ts,
 * remotionService.ts, characterDb.ts, and imageGeneration.ts's
 * `imageService`/`ImageService` were already lazily `await import()`'d
 * inline in the original source for every one of these methods — kept
 * exactly as-is, same load timing as before. `axios` and `sharp` are loaded
 * via `require()`/`await import()` inline, also unchanged from the original
 * — neither constructs anything at module scope.
 *
 * Metering/RunFunding audit: zero matches for llmService, generateJSONContent,
 * meterUserUsage, currentRunFunding, or any LLM-provider name across the
 * whole cluster (describeImage/generateImage included — both meter through
 * `callLLM`'s own `usageContext` threading, not a separate metering call).
 * generateVideo's/generateImage's `chatbotDb.addToolCostToSession` calls are
 * a per-session cost-display bucket, not the usageContext/billingUserId-
 * forwarding metering chokepoint this audit watches for — per their own
 * pre-existing comments, the actual usage metering fires once at the
 * generation SOURCE (videoService.generateVideo / imageService.generateImage
 * / callLLM's own metering), unmodified by this move. Creative-lineage/C2PA
 * stamping: `generateImage`'s `enqueueAutoHumanEval(...)` (fire-and-forget,
 * not awaited — its returned Promise is threaded, not resolved, into the
 * next call, exactly as in the original) and `recordGeneratedCreative(...)`
 * (`void`-called, never awaited, links the human-eval candidate once it
 * resolves) both moved byte-identical. No `stampMeta*` calls exist in either
 * moved method — those belong to the Meta-ads cluster (`adsApis.ts`) and are
 * untouched by this move.
 */

import { videoGenerationCostUsd, imageGenerationCostUsd } from '../../utils/llmPricing';
import { normalizeImageModel } from '../../services/imageGeneration';
import { isTransientLLMError } from '../../utils/agentModeErrors';
import { fetchBufferFollowingRedirects, DEFAULT_MAX_IMAGE_BYTES } from '../../utils/ssrfGuard';
import {
  getPersistedBrandLogoUrlForUser,
  missingBrandLogoToolResult,
  promptCreatesLogo,
  promptRequestsLogo,
} from '../../services/agentMode/brandLogo';
import {
  describeImageReportsFabricatedMetrics,
  FABRICATED_METRICS_CHECK_PROMPT,
  FABRICATED_METRICS_CHECK_TIMEOUT_MS,
  FABRICATED_METRICS_WARNING,
  promptRisksFabricatedMetrics,
} from '../../services/agentMode/dataFabricationGuard';
import { declaredPlacementField } from '../../services/agentMode/generateImagePlacement';
import { recordGeneratedCreative } from '../../services/creativeLineage';
import { resolveModelForUser } from '../../services/modelRoles';
import { normalizeVideoModel, SEEDANCE_VIDEO_MODEL } from '../../services/videoModels';
import { withTimeoutOrReject } from './shared/withTimeoutOrReject';
import type { LLMUsageContext } from '../../utils/llmService';
// Self-import: `callVisionLLMWithTimeout`/`generateImage` reach
// `resolveDescribeImageTimeoutMs`/`describeImage` (both defined in this same
// module) through `self.<fn>` rather than a local function reference, so an
// external `jest.spyOn(mediaVideoImpl, '<fn>')` actually intercepts the
// internal call — the cluster-10 lesson.
import * as self from './mediaVideo';

/**
 * Bound a describe_image vision LLM call so a slow or hung vision model fails
 * fast instead of consuming the whole agent-mode generation wall-clock budget
 * (ENG-294). Without this, a single un-bounded vision call can stall for the
 * client's 5-minute per-request timeout — and with callLLM's internal retries
 * plus the fallback model, one image could burn 10+ minutes and blow the run's
 * GENERATION_TIMEOUT_MS (default 10 min). Reported by a CSV→CRM sync that OCR'd
 * contact screenshots and timed out repeatedly (6 failed describe_image calls).
 *
 * The timeout REJECTS with a "timed out" error, which isRetryableMediaToolError()
 * classifies as retryable — so a primary-model timeout routes to the fallback
 * model rather than aborting the whole tool call. Set the timeout to exactly 0
 * (via AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS=0) to disable the bound entirely.
 *
 * Parsing fails CLOSED: a malformed override (non-numeric like "90s", negative,
 * or NaN) falls back to the default bound rather than silently disabling it —
 * otherwise a typo would recreate the exact unbounded-call bug this exists to
 * prevent. Only a clean, explicit 0 disables the timeout.
 */
const DEFAULT_DESCRIBE_IMAGE_TIMEOUT_MS = 90000;

/**
 * Resolve the describe_image timeout (ms) from AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS.
 * Fails closed: unset/empty/malformed/negative values yield the default bound; only
 * a clean, explicit non-negative integer (including 0, which disables) is honored.
 */
export function resolveDescribeImageTimeoutMs(): number {
  const raw = process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_DESCRIBE_IMAGE_TIMEOUT_MS;
  }
  // Number() (not parseInt) so partial junk like "90s" becomes NaN instead of 90.
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_DESCRIBE_IMAGE_TIMEOUT_MS;
  }
  return parsed;
}

/** Matches the one call shape `callVisionLLMWithTimeout`/`describeImage` actually send. */
export type DescribeImageLlmCall = (
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: any }>,
  options: {
    max_completion_tokens: number;
    usageContext: LLMUsageContext;
  },
) => Promise<{
  choices: Array<{ message?: { content?: string | null } }>;
}>;

/** Matches `AgentModeService.prototype.getVisionModel`'s real signature exactly. */
export type GetVisionModelFn = () => Promise<string>;

async function callVisionLLMWithTimeout(
  callLLM: DescribeImageLlmCall,
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: any }>,
  options: { max_completion_tokens: number; usageContext: LLMUsageContext },
): Promise<{ choices: Array<{ message?: { content?: string | null } }> }> {
  const timeoutMs = self.resolveDescribeImageTimeoutMs();
  if (timeoutMs <= 0) {
    return callLLM(model, messages, options);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`describe_image vision call to "${model}" timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([callLLM(model, messages, options), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Media types the vision APIs decode natively. */
const VISION_NATIVE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Normalize uploaded image bytes to a vision-decodable representation. This
 * remains local image hygiene; text/tool model routing is handled separately.
 */
export async function normalizeImageForVision(
  buffer: Buffer,
  contentType: string,
): Promise<{ buffer: Buffer; contentType: string; undecodable?: boolean; detectedFormat?: string }> {
  let normalizedContentType = (contentType || '').toLowerCase().trim();
  if (normalizedContentType === 'image/jpg') normalizedContentType = 'image/jpeg';
  if (VISION_NATIVE_MEDIA_TYPES.has(normalizedContentType)) {
    return { buffer, contentType: normalizedContentType };
  }

  try {
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(buffer).metadata();
    const mediaTypeByFormat: Record<string, string> = {
      jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    };
    const detectedContentType = metadata.format ? mediaTypeByFormat[metadata.format] : undefined;
    if (detectedContentType) {
      return { buffer, contentType: detectedContentType, detectedFormat: metadata.format };
    }

    const png = await sharp(buffer).png().toBuffer();
    return { buffer: png, contentType: 'image/png', detectedFormat: metadata.format };
  } catch (err) {
    console.error(
      'AgentMode: normalizeImageForVision failed to decode/convert image; using original:',
      err instanceof Error ? err.message : err,
    );
    return { buffer, contentType: contentType || 'image/png', undecodable: true };
  }
}

/**
 * Analyze an image with a vision-capable LLM.
 *
 * @param llmModel - Optional. When omitted (the agent-mode `describe_image` tool
 *   intentionally passes nothing here), the configured vision model
 *   (`agent_mode_vision_model`) is used. describe_image is a vision utility, so it
 *   runs on its own dedicated vision model — independent of the chat/default model.
 */
export async function describeImage(
  llmModel: string | undefined,
  imageUrl: string,
  prompt: string | undefined,
  usageContext: LLMUsageContext | undefined,
  callLLM: DescribeImageLlmCall,
  getVisionModel: GetVisionModelFn,
): Promise<any> {
  try {
    if (!imageUrl) {
      return {
        success: false,
        message: 'No image URL provided'
      };
    }
    if (!llmModel) {
      llmModel = await getVisionModel();
    }
    // ENG-2840 (W2-8), the ENG-2988 rule: an object of OUR bucket is read below with the server's own credentials (presigned), so it is
    // read only for a caller who may read that key: the same check the file routes and the other storage tools make. Checked for every
    // model and before any read, so neither the download nor the raw-URL fallback below can hand another tenant's object to a model.
    if (!imageUrl.startsWith('data:')) {
      const { isS3Url, extractS3KeyFromUrl } = await import('../../utils/s3Utils');
      if (isS3Url(imageUrl)) {
        const { checkOurBucketKeyRead, TOOL_FILE_REFUSAL_MESSAGE, TOOL_FILE_UNAVAILABLE_MESSAGE } = await import('./toolStorageAccess');
        const key = extractS3KeyFromUrl(imageUrl);
        const decision = key ? await checkOurBucketKeyRead('describe_image', usageContext?.userId, key) : 'refuse';
        if (decision !== 'allow') {
          return {
            success: false,
            message: decision === 'unavailable' ? TOOL_FILE_UNAVAILABLE_MESSAGE : TOOL_FILE_REFUSAL_MESSAGE,
            error: 'File not accessible',
          };
        }
      }
    }
    // Use custom prompt or default
    const analysisPrompt = prompt || 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.';

    // Vision models here require the image as inline bytes rather than a bare URL:
    //  - Bedrock Converse API (anthropic.*) requires base64 data URIs.
    //  - Anthropic-on-Vertex (claude-*) can take a url source, but our images are
    //    typically private S3 objects Anthropic's fetcher cannot reach, so we
    //    download and presign them into a base64 data URI here.
    //  - Gemini (gemini-*) receives a non-data URL as `fileData.fileUri`. Gemini
    //    DOES fetch these URLs successfully for ordinary screenshots (verified in
    //    prod: 100+ sessions served by gemini-3.5-flash straight from an S3 URL),
    //    but it rejects an un-downscaled 4K image (3072x5504, ~16MB from
    //    gemini-3.1-flash-image) with a hard 400 INVALID_ARGUMENT. In prod that
    //    oversize class failed on Gemini 100% of the time across every session
    //    that attempted it. Downloading + downscaling + inlining here keeps the
    //    payload self-contained and within Gemini's limits (ENG-834).
    //    NOTE: until the native Gemini adapter landed (ENG-737, 2026-07-30) the
    //    OpenAI-compat transport reported this as "400 status code (no body)",
    //    which isRetryableMediaToolError() treats as retryable — so the Claude
    //    fallback below silently rescued every one of these. The native adapter
    //    surfaces Google's raw "...INVALID_ARGUMENT" JSON, which matches that
    //    method's /invalid/i non-retryable pattern, so the fallback stopped
    //    firing and the long-standing oversize bug became user-visible.
    // Download the image and convert to a (downscaled) data URI for these models.
    let resolvedImageUrl = imageUrl;
    if (
      (llmModel.startsWith('anthropic.') ||
        llmModel.startsWith('claude-') ||
        llmModel.startsWith('gemini-')) &&
      !imageUrl.startsWith('data:')
    ) {
      try {
        const axios = (await import('axios')).default;
        // For private S3 URLs from our bucket, generate a presigned URL so the download succeeds
        const { presignS3Url, isS3Url } = await import('../../utils/s3Utils');
        const isOwnS3 = isS3Url(imageUrl);
        const fetchUrl = isOwnS3 ? (presignS3Url(imageUrl) ?? imageUrl) : imageUrl;
        // Normalize content-type: strip any charset/extra params and trim whitespace.
        // Do NOT default a missing/empty header to a native type here — that would
        // short-circuit sharp detection and embed non-PNG bytes as image/png (ENG-370).
        // Pass the raw/empty type through so normalizeImageForVision decodes via sharp.
        let contentType: string;
        let imageBuffer: Buffer;
        if (isOwnS3) {
          // Our own presigned S3 object: no redirects, no SSRF surface. Still
          // size-capped — a user can put an arbitrarily large object in their
          // own bucket, and the >4MB resize below only runs once the whole
          // thing is already resident in memory, so the cap has to be enforced
          // by the transport rather than after the fact (Greptile).
          // `as any`: this repo's axios typings predate maxContentLength on the
          // config interface (same workaround as the guarded fetch helper).
          const imgResp = await axios.get<ArrayBuffer>(fetchUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: DEFAULT_MAX_IMAGE_BYTES,
            maxBodyLength: DEFAULT_MAX_IMAGE_BYTES,
          } as any);
          contentType = (imgResp.headers['content-type'] || '').split(';')[0].trim();
          imageBuffer = Buffer.from(imgResp.data as ArrayBuffer);
        } else {
          // describe_image is an agent-callable foundation tool fed image URLs
          // from untrusted content, so this server-side fetch of an agent-supplied
          // URL is a reachable SSRF vector (cloud metadata, RFC1918/loopback).
          // fetchBufferFollowingRedirects validates that the host resolves to a
          // public IP and pins the connection to that exact address (DNS-rebinding
          // safe) on EVERY hop — so redirects can be followed without reopening
          // the bypass. Flatly refusing redirects would be safe but false-blocks
          // ordinary one-hop image links such as Google Drive `uc?export=view`
          // (ENG-834).
          const fetched = await fetchBufferFollowingRedirects(fetchUrl);
          contentType = fetched.contentType;
          imageBuffer = fetched.buffer;
        }
        let finalContentType = contentType;
        // Normalize to a vision-decodable format so the declared media type always
        // matches the bytes. Fixes HEIC/AVIF/TIFF/BMP/SVG logos and mislabeled or
        // octet-stream content-types that otherwise fail silently downstream (ENG-370).
        const normalized = await normalizeImageForVision(imageBuffer, contentType);
        if (normalized.undecodable) {
          // sharp could not decode these bytes, so no vision API can either.
          // Fast-fail with actionable re-upload guidance instead of burning vision
          // retries and agent workarounds on an unreadable file (ENG-370).
          console.warn(
            `AgentMode: describeImage could not decode uploaded image (content-type "${contentType || 'none'}"); fast-failing with re-upload guidance`
          );
          return {
            success: false,
            retryable: false,
            message:
              `The uploaded file could not be read as an image${contentType ? ` (its content type was "${contentType}")` : ''} — ` +
              'it may be corrupted or in a format that cannot be decoded. Please re-upload the logo as a PNG or JPEG and try again.',
            error: 'Image could not be decoded',
          };
        }
        imageBuffer = normalized.buffer;
        finalContentType = normalized.contentType;
        // Auto-resize if image exceeds 4MB to stay under Bedrock's 5MB limit
        if (imageBuffer.length > 4 * 1024 * 1024) {
          try {
            const sharp = (await import('sharp')).default;
            imageBuffer = await sharp(imageBuffer)
              .resize({ width: 1200, withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer();
            finalContentType = 'image/jpeg';
            console.log(`AgentMode: describeImage resized large image to ${imageBuffer.length} bytes (JPEG 85%, max 1200px wide)`);
          } catch (resizeError) {
            console.error('AgentMode: Failed to resize image, proceeding with original:', resizeError instanceof Error ? resizeError.message : resizeError);
          }
        }
        const base64 = imageBuffer.toString('base64');
        resolvedImageUrl = `data:${finalContentType};base64,${base64}`;
        console.log(`AgentMode: describeImage downloaded image, final size=${imageBuffer.length} bytes, contentType="${finalContentType}", dataUri prefix="${resolvedImageUrl.substring(0, 40)}"`);
      } catch (downloadError) {
        console.error('AgentMode: Failed to download image for Bedrock, falling back to URL:', downloadError instanceof Error ? downloadError.message : downloadError);
      }
    }

    // Create messages for vision API
    const messages: Array<{ role: 'system' | 'user'; content: any }> = [
      {
        role: 'system' as const,
        // Describe only what is visibly on screen. A vision model has no way to
        // confirm from a single image whether a depicted product, version number,
        // or model name currently exists — its training data has a cutoff, and
        // the subject may simply postdate it (this exact prompt has previously
        // caused a real AgentWeb screenshot of AgentWeb's own model picker to be
        // called a "fictional mockup" of models that "don't exist"). Authenticity/
        // existence verdicts are a caller decision (verified via search or other
        // tools), never this tool's to assert.
        content:
          'You describe images factually. Report only what is visibly present: text, layout, colors, objects, ' +
          'and composition. Never assert or speculate about whether depicted content — a product, brand, ' +
          'version number, model name, or claim — is real, fake, fictional, outdated, or currently exists. ' +
          'You cannot verify that from an image alone, and confident guesses here are frequently wrong. If ' +
          'something looks unfamiliar, describe it neutrally exactly as shown, without a verdict on its legitimacy.'
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: analysisPrompt
          },
          {
            type: 'image_url' as const,
            image_url: { url: resolvedImageUrl }
          }
        ]
      }
    ];

    const visionModelUsed = llmModel;
    // This is one OpenRouter request. Provider failover occurs inside its
    // gateway, so AgentWeb never makes a second vision completion itself.
    const response = await callVisionLLMWithTimeout(callLLM, visionModelUsed, messages, {
      max_completion_tokens: 2000,
      // ENG-1858: vision analysis is the requesting user's work, not "system".
      usageContext: usageContext ?? { feature: 'describe_image' },
    });

    const description = response.choices[0]?.message?.content || 'Unable to analyze image';

    return {
      success: true,
      description: description,
      imageUrl: imageUrl,
      model: visionModelUsed,
    };

  } catch (error) {
    console.error('AgentMode: Error describing image:', error);
    // This is a catch-all: besides bad image bytes it also receives transient
    // network/provider failures that escaped the vision-call fallback flow. Do
    // NOT hard-code retryable:false here (that would make the agent give up on a
    // request that could succeed on retry) and do not assert the file itself is
    // the problem — only the undecodable-bytes fast-fail above is truly terminal.
    return {
      success: false,
      message:
        'Failed to analyze the image. It may be temporarily unavailable, inaccessible, or in a ' +
        'format that cannot be read. If it is a logo file, try re-uploading it as a PNG or JPEG.',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Generate an image using AI image generation models
 */
export async function generateImage(
  prompt: string,
  filename: string,
  size: string,
  quality: string,
  inputImages: string[],
  userId: string,
  sessionId: string,
  imageModel: string | undefined,
  logoImage: string | undefined,
  confirm: boolean | undefined,
  category: string | undefined,
  metricsVerified: boolean | undefined,
  placement: string | undefined,
  callLLM: DescribeImageLlmCall,
  getVisionModel: GetVisionModelFn,
): Promise<any> {
  // ENG-343: the producing flow must self-declare the eval use case — Matt's
  // review feedback differs entirely between ads and organic posts, and a
  // prompt-text classifier was explicitly ruled out. Missing/invalid input
  // fails visibly (recorded decision 2026-07-27 on ENG-343) so the caller gets
  // fixed instead of a falsely categorized candidate reaching the eval queue.
  if (category !== 'ad' && category !== 'organic_post') {
    return {
      success: false,
      error: 'invalid_category',
      message:
        `generate_image requires category: 'ad' | 'organic_post' (got ${JSON.stringify(category)}). ` +
        `Declare the use case: 'ad' for paid ad creatives, 'organic_post' for organic social content.`
    };
  }

  // Human-in-the-loop gate for image EDITING (inputImages present). Editing the
  // wrong source images is the wrong-set mistake from the satisfaction incident,
  // so before regenerating/editing existing images we surface the exact source
  // image(s) to the user (rendered as thumbnails via markdown) and wait for
  // explicit approval. Text-to-image (no inputImages) is fresh creation and is
  // NOT gated. The agent loop halts on `awaitingUserConfirmation`; on approval the
  // model re-calls with confirm=true. `confirm` never reaches the image service.
  if (Array.isArray(inputImages) && inputImages.length > 0 && confirm !== true) {
    const thumbs = inputImages.map((url, i) => `![source image ${i + 1}](${url})`).join('\n');
    const summary = `Edit/regenerate ${inputImages.length} existing image(s) and save the result as "${filename}".`;
    return {
      success: true,
      requiresConfirmation: true,
      awaitingUserConfirmation: true,
      summary,
      confirmationPrompt:
        `Based on your request, here's the image edit I'm about to make — ` +
        `please check these are the right source image(s) before I proceed:\n\n` +
        `${summary}\n\n${thumbs}\n\n` +
        `Reply "yes" / "confirm" to go ahead, or tell me which image(s) to use instead.`,
      // Per-item body (no intro/footer) used when several edits are batched in one turn.
      confirmationDetail: `${summary}\n\n${thumbs}`,
      // Model-facing instruction for the resumed turn (mirrors the Meta gate): once
      // the user approves the shown source image(s), re-call generate_image with the
      // SAME arguments plus confirm=true. If the user names different images, edit
      // those instead (which will re-confirm).
      message: `Image edit requires user confirmation: ${summary} The source image(s) have been shown to the user. ` +
        `Do NOT proceed until the user approves. Once approved, call generate_image again with the same arguments plus confirm=true. ` +
        `If the user asks for different source images, use those instead.`,
      target: { action: 'EDIT_IMAGE', filename, inputImages }
    } as any;
  }

  try {
    // ENG-326: branded text-to-image asks must composite the account's REAL
    // persisted logo — never one the model invents. When the prompt asks for
    // a logo and the model didn't pass logo_image, prefer the persisted
    // brand logo (AC-2); when none is persisted, ask the user / point at
    // brand config instead of generating (AC-3). Edits (inputImages) are
    // out of scope — the source images already carry the branding.
    //
    // ENG-393: this gate is for COMPOSITING an existing brand logo, not for
    // CREATING one. A prompt that asks to design a brand-new logo from
    // scratch ("create a logo for X") must NOT be gated — an account with no
    // logo yet legitimately wants to generate its first one, and blocking
    // that also blocks landing-page generation. Let creation asks through;
    // compositing asks ("add our logo to this banner") still gate.
    if (
      !logoImage &&
      (!Array.isArray(inputImages) || inputImages.length === 0) &&
      promptRequestsLogo(prompt) &&
      !promptCreatesLogo(prompt)
    ) {
      const persistedLogo = await getPersistedBrandLogoUrlForUser(userId);
      if (!persistedLogo) {
        return missingBrandLogoToolResult();
      }
      logoImage = persistedLogo;
      console.log(
        `AgentMode: generate_image prompt asks for a logo — compositing the persisted brand logo (${persistedLogo})`
      );
    }

    // Import the image generation service
    const { imageService } = await import('../../services/imageGeneration');

    // Check if the service is available
    const isAvailable = await imageService.isAvailable();
    if (!isAvailable) {
      return {
        success: false,
        message: 'Image generation service is not available. Please check API key configuration in AWS Secrets Manager.',
        error: 'Service unavailable'
      };
    }

    // ENG-510: distinguish an LLM-specified model from a system-resolved default.
    // Only a genuine per-request choice should suppress the transient-timeout
    // fallback; the admin-configured default is a system preference, not a
    // semantic lock, so a timeout on it must still fail over to another provider
    // instead of delivering zero images. Resolving the default here (rather than
    // in the tool handler) preserves that distinction end-to-end.
    const modelExplicitlyChosen = typeof imageModel === 'string' && imageModel.trim().length > 0;
    const resolvedImageModel = modelExplicitlyChosen
      ? imageModel
      : await resolveModelForUser(userId, 'image');

    const inputImagesForRequest = inputImages || [];
    const primaryRequest = {
      prompt,
      filename,
      size,
      quality,
      inputImages: inputImagesForRequest,
      logoImage,
      userId,
      imageModel: resolvedImageModel,
      // ENG-2187: the ad placement, when declared, sizes the creative gates' checks.
      ...declaredPlacementField(placement)
    };

    let result: any;
    let imageModelUsed = resolvedImageModel || 'gemini-3-pro-image-preview';
    let fallbackUsed = false;
    let primaryError: string | undefined;

    try {
      result = await imageService.generateImage(primaryRequest);
    } catch (primaryFailure: any) {
      primaryError = primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure);
      const fallbackModel = getImageGenerationFallbackModel(resolvedImageModel, inputImagesForRequest, logoImage, modelExplicitlyChosen);
      if (!fallbackModel || !isRetryableMediaToolError(primaryError)) {
        throw primaryFailure;
      }

      console.warn(
        `AgentMode: Image generation with "${imageModelUsed}" threw a retryable error; trying fallback "${fallbackModel}":`,
        primaryError
      );
      try {
        const fallbackQuality = quality === 'high' ? 'medium' : quality;
        result = await imageService.generateImage({
          ...primaryRequest,
          quality: fallbackQuality,
          imageModel: fallbackModel
        });
        imageModelUsed = fallbackModel;
        fallbackUsed = true;
        if (result.success && result.imageUrl) {
          quality = fallbackQuality;
        }
      } catch (fallbackError: any) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        return {
          success: false,
          message: `Image generation failed after primary and fallback attempts: ${fallbackMessage}`,
          error: fallbackMessage,
          primaryError,
          fallbackModel
        };
      }
    }

    if (!(result.success && result.imageUrl) && !fallbackUsed) {
      primaryError = result.error || 'Failed to generate image';
      const fallbackModel = getImageGenerationFallbackModel(resolvedImageModel, inputImagesForRequest, logoImage, modelExplicitlyChosen);
      if (fallbackModel && isRetryableMediaToolError(primaryError)) {
        console.warn(
          `AgentMode: Image generation with "${imageModelUsed}" failed with a retryable error; trying fallback "${fallbackModel}":`,
          primaryError
        );
        try {
          const fallbackQuality = quality === 'high' ? 'medium' : quality;
          result = await imageService.generateImage({
            ...primaryRequest,
            quality: fallbackQuality,
            imageModel: fallbackModel
          });
          imageModelUsed = fallbackModel;
          fallbackUsed = true;
          if (result.success && result.imageUrl) {
            quality = fallbackQuality;
          }
        } catch (fallbackError: any) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          return {
            success: false,
            message: `Image generation failed after primary and fallback attempts: ${fallbackMessage}`,
            error: fallbackMessage,
            primaryError,
            fallbackModel
          };
        }
      }
    }

    if (result.success && result.imageUrl) {
      // Session cost accounting (agent-mode chat). The per-user burn shadow record is
      // fired once at the generation SOURCE (imageService.generateImage) so every caller
      // is metered exactly once — see llmPricing.imageGenerationCostUsd (ENG-200).
      const imageCost = estimateImageGenerationCost(imageModelUsed);
      // ENG-2103 (F2): lazily required — chatbotService.ts top-level imports
      // aws-sdk (constructs a real AWS client at module scope), so this
      // cannot be a top-level import here even though it was one in
      // agentModeService.ts (established precedent: round 2's
      // createGTMPlan/chatbotDb.getChatSession finding).
      const { chatbotDb } = await import('../../services/chatbotService');
      chatbotDb.addToolCostToSession(sessionId, imageCost, 'generateImage').catch((err) =>
        console.error('AgentMode: Failed to add image cost to session:', err)
      );

      // Save the image URL to the session for reference
      const imageData = {
        url: result.imageUrl,
        filename: result.filename,
        generatedAt: new Date().toISOString(),
        prompt: prompt,
        size: size,
        quality: quality
      };

      // Store image data in session metadata (optional)
      try {
        await chatbotDb.addMessageToSession(sessionId, {
          role: 'system',
          content: `Image generated: ${result.filename}`,
          metadata: {
            timestamp: new Date().toISOString(),
            // Stable marker so extractGeneratedImageFilenames can detect generated
            // images without relying solely on the content-string format.
            kind: 'image-generated',
            imageFilename: result.filename,
            // ENG-510: carry the URL on this immediately-persisted marker so a completed
            // image is discoverable (scanMessagesForAssets) even if the whole-turn cap
            // kills the turn before the end-of-turn toolCalls stamp runs — graceful
            // partial delivery instead of losing finished work. De-duped by URL.
            imageUrl: result.imageUrl
          }
        });
      } catch (error) {
        console.warn('Failed to store image generation metadata:', error);
      }

      // ENG-2103 (F2): lazily required — autoHumanEvalService.ts statically
      // imports settingsService.ts, which constructs a real
      // AWS.DynamoDB.DocumentClient at module scope (unconditionally) — the
      // same transitive-import trap established elsewhere in this series.
      const { enqueueAutoHumanEval } = await import('../../services/autoHumanEvalService');
      const humanEvalCandidate = enqueueAutoHumanEval({
        reviewType: 'creative_image',
        userId,
        sessionId,
        category,
        artifactUrl: result.imageUrl,
        originalRequest: prompt,
        outputSummary:
          `Image generated: ${result.filename || filename}. ` +
          `Model: ${imageModelUsed}. Size: ${size || 'default'}. Quality: ${quality || 'default'}.`,
        sourceKey: `image:${sessionId}:${result.filename || filename}:${result.imageUrl}`,
        creativeGates: result.gates,
        // ENG-2140: the generation request is the only brief agent mode has; the placement
        // comes from the gate result.
        creativeBrief: { generationRequest: prompt },
        action: {
          type: 'agent_mode_image_revision',
          sessionId,
          userId,
          artifactUrl: result.imageUrl,
          filename: result.filename || filename,
        },
      });
      // ENG-2141: creative lineage record (inert unless CREATIVE_LINEAGE_ENABLED + table). Not
      // awaited and never throws; it links the human-eval candidate once that exists.
      void recordGeneratedCreative(
        { userId, artifactUrl: result.imageUrl, sessionId, category, prompt, generatorModel: imageModelUsed, gates: result.gates },
        humanEvalCandidate,
      );

      // ENG-1027 data-fabrication backstop: the tool-description guidance alone is
      // instruction-following-dependent, and live verification showed the image
      // model can invent metrics even in prompts that never asked for real data
      // (a bare "metrics preview" dashboard element is enough). For prompts shaped
      // like a dashboard/table that Emma hasn't declared use verified real values
      // (metricsVerified), run one bounded describe_image check against the actual
      // output and surface a warning so Emma discloses rather than silently
      // presenting invented numbers. Timeboxed tighter than describe_image's own
      // 90s ENG-294 bound — this is an added, best-effort safety net the user never
      // explicitly asked for, not worth spending that much turn budget on.
      let dataReliabilityWarning: string | undefined;
      if (promptRisksFabricatedMetrics(prompt, metricsVerified)) {
        console.log(`AgentMode: generate_image data-fabrication check triggered (session ${sessionId})`);
        try {
          const visionCheck = await withTimeoutOrReject(
            // ENG-1858: the check is part of this user's image generation.
            self.describeImage(undefined, result.imageUrl, FABRICATED_METRICS_CHECK_PROMPT, { userId, sessionId, feature: 'describe_image' }, callLLM, getVisionModel),
            FABRICATED_METRICS_CHECK_TIMEOUT_MS,
            'generate_image data-fabrication check'
          );
          if (visionCheck?.success && describeImageReportsFabricatedMetrics(visionCheck.description)) {
            dataReliabilityWarning = FABRICATED_METRICS_WARNING;
            console.log(`AgentMode: generate_image data-fabrication check WARNED (session ${sessionId})`);
          } else {
            console.log(`AgentMode: generate_image data-fabrication check clear (session ${sessionId})`);
          }
        } catch (visionErr) {
          console.warn('AgentMode: generate_image data-fabrication check failed/timed out (non-fatal):', visionErr);
        }
      }

      return {
        success: true,
        message: `✅ Image "${result.filename}" generated successfully!`,
        imageUrl: result.imageUrl,
        filename: result.filename,
        prompt: prompt,
        size: size,
        quality: quality,
        imageModel: imageModelUsed,
        ...(dataReliabilityWarning ? { dataReliabilityWarning } : {}),
        ...(fallbackUsed ? { fallbackUsed: true, primaryError } : {})
      };
    } else {
      if (fallbackUsed) {
        return {
          success: false,
          message: `Image generation failed after primary and fallback attempts: ${result.error || 'Fallback image generation failed'}`,
          error: result.error,
          primaryError,
          ...(result.errorClass ? { errorClass: result.errorClass } : {})
        };
      }
      return {
        success: false,
        message: result.error || 'Failed to generate image',
        error: result.error,
        // ENG-1535: typed class (transient/rate_limited/policy/config/...) for the gateway.
        ...(result.errorClass ? { errorClass: result.errorClass } : {})
      };
    }

  } catch (error: any) {
    console.error('AgentMode: Error generating image:', error);
    return {
      success: false,
      message: 'Failed to generate image',
      error: error.message
    };
  }
}

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
        // The service reports the model that actually produced the clip (after any
        // Seedance→Omni fallback) and its actual cost when the provider returned usage.
        const producedModel = result.model || normalizeVideoModel(videoModel) || SEEDANCE_VIDEO_MODEL;
        const videoCost = result.costUsd ?? estimateVideoGenerationCost(producedModel, durationSeconds);
        chatbotDb.addToolCostToSession(sessionId, videoCost, 'generateVideo').catch((err) =>
          console.error('AgentMode: Failed to add video cost to session:', err)
        );

        // Save the video URL to the session for reference
        const videoData = {
          url: result.videoUrl,
          filename: result.filename,
          generatedAt: new Date().toISOString(),
          prompt: prompt,
          model: producedModel
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
          model: producedModel,
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
      // ENG-2584: a 4xx on the source download means the URL itself is
      // unusable for a server-side fetch (expired signed CDN link, auth-gated
      // asset). Retrying the same URL can never succeed, so say so explicitly.
      const status = error?.response?.status;
      if ([401, 403, 404, 410].includes(status)) {
        return {
          success: false,
          message:
            `Could not download the source image (HTTP ${status}). The URL is expired, private, or ` +
            `forbidden for server-side download (signed CDN links such as fbcdn.net expire). Do not retry ` +
            `this same URL. Fetch a fresh image URL from the source (e.g. re-query the ads API), use an ` +
            `uploaded S3 copy, or ask the user to upload the image.`,
          error: 'source_download_refused',
          status,
        };
      }
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

  /** Cost per video generation in USD. Video bills per clip, so longer videos cost proportionally more. */
function estimateVideoGenerationCost(model: string, durationSeconds?: number): number {
    // Per-clip rates sourced from llmPricing (single source of truth).
    return videoGenerationCostUsd(model, durationSeconds);
  }

/**
 * Cost per image generation in USD (fixed per-generation pricing, sourced from
 * llmPricing). Exclusive to `generateImage` — kept as a thin `private`
 * delegating wrapper on `AgentModeService` only because
 * `agentModeService.generateImage.test.ts` binds it off the real instance.
 */
export function estimateImageGenerationCost(model: string): number {
  return imageGenerationCostUsd(model);
}

/**
 * Exclusive to `generateImage`. Zero `this.*` reads in its body, and zero
 * test dependency beyond doc-comment mentions (confirmed by whole-backend
 * grep) — called as a plain local function, no class-side wrapper needed.
 */
function isRetryableMediaToolError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const nonRetryablePatterns = [
    /api key/i,
    /auth/i,
    /unauthori[sz]ed/i,
    /forbidden/i,
    /permission/i,
    /invalid/i,
    /unsupported/i,
    /content.?filter/i,
    /safety/i,
    /policy/i,
    /blocked/i,
    /service is not available/i,
  ];
  if (nonRetryablePatterns.some((pattern) => pattern.test(message))) {
    return false;
  }

  return isTransientLLMError(error) || /timed out|timeout|overloaded|upstream|network/i.test(message);
}

/**
 * Exclusive to `generateImage`. Kept as a thin `private` delegating wrapper on
 * `AgentModeService` only because `agentModeService.generateImage.test.ts`
 * binds it off the real instance (`.bind(agentModeService)`).
 */
export function getImageGenerationFallbackModel(
  currentModel: string | undefined,
  inputImages: string[] | undefined,
  logoImage: string | undefined,
  modelExplicitlyChosen: boolean = false
): string | undefined {
  // Keep generation fallback narrow. Telemetry showed the painful cases were
  // product-fidelity workflows and explicit model choices; silently switching
  // providers there changes output semantics. Only recover when the caller left
  // model selection to us and the request is fresh text-to-image.
  //
  // ENG-510: gate on whether the model was an explicit per-request choice — NOT
  // merely on a model string being present. The admin-configured default is
  // resolved to a concrete id before generation, but that is a system default,
  // not a user choice, so a transient timeout on it must still fail over.
  if (modelExplicitlyChosen) {
    return undefined;
  }

  const editsExistingImage = (Array.isArray(inputImages) && inputImages.length > 0) || !!logoImage;
  if (editsExistingImage) {
    return undefined;
  }

  // Pick the first alternate that isn't the model we just failed on (compare on
  // the normalized id so e.g. the legacy "...-preview" alias matches its GA id).
  const normalizedCurrent = normalizeImageModel(currentModel);
  const fallbackOrder = ['gpt-image-2', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'];
  return fallbackOrder.find(
    (model) => model !== currentModel && model !== normalizedCurrent
  );
}
