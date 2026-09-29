/**
 * Runtime wiring for ENG-2193's content checks (`./creativeContentChecks`).
 *
 * `creativeContentChecks.ts` is deliberately pure of I/O so it stays trivially unit-testable;
 * this file owns the network/S3 side — downloading the generated artifact and (if the account
 * has one on file) the brand logo — and merges the result onto the human-eval candidate's
 * existing `creativeGates` via `humanEvalService.appendCreativeGateChecks`.
 *
 * Fire-and-forget, mirroring `creativeRubricJudgeRuntime.ts` / `judgeHumanEvalCandidate`'s call
 * site in `autoHumanEvalService.ts`: never throws back to its caller, and never delays the
 * enqueue or the generation it followed.
 *
 * Gated behind `CREATIVE_CONTENT_CHECKS_ENABLED` (default off, inert). Unlike the fast
 * structural gates in `creativeGates.ts` (sharp only, already-in-hand bytes), this group does
 * OCR inference and an extra outbound download on every sampled candidate — ship inert until an
 * operator opts in; see the PR body for the exact EB env var to set.
 */
import axios from 'axios';
import { humanEvalService } from './humanEvalService';
import { getPersistedBrandLogoUrl, resolveBrandGuidelinesForUser } from './agentMode/brandLogo';
import { buildBrandProfile, runCreativeContentChecks } from './creativeContentChecks';

/** Same bounds as `imageGeneration.ts`'s remote-gate download (ENG-2187) — this hits the same
 *  kind of URL (a generated artifact, or a brand-configured logo), just later and off the
 *  request path. */
const CONTENT_CHECK_DOWNLOAD_TIMEOUT_MS = 20_000;
const CONTENT_CHECK_MAX_BYTES = 30 * 1024 * 1024;

async function downloadBounded(url: string): Promise<Buffer | undefined> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: CONTENT_CHECK_DOWNLOAD_TIMEOUT_MS,
      maxContentLength: CONTENT_CHECK_MAX_BYTES,
      maxRedirects: 0,
    });
    return Buffer.from(response.data);
  } catch (err) {
    console.warn('[creative-content-checks] artifact download failed (skipped):', err instanceof Error ? err.message : err);
    return undefined;
  }
}

export interface RunContentChecksForCandidateInput {
  candidateId: string;
  artifactUrl?: string;
  userId?: string;
  /** Ad copy (headline/body/CTA) supplied by the enqueueing flow, if any. */
  adCopyText?: string;
}

/** Never throws. No-op when the flag is off, there's no artifact URL, or the download fails. */
export async function runContentChecksForCandidate(input: RunContentChecksForCandidateInput): Promise<void> {
  if (process.env.CREATIVE_CONTENT_CHECKS_ENABLED !== 'true') return;
  if (!input.artifactUrl) return;
  try {
    const buffer = await downloadBounded(input.artifactUrl);
    if (!buffer) return;

    const brand = input.userId ? await resolveBrandGuidelinesForUser(input.userId) : null;
    const brandProfile = buildBrandProfile(brand?.brandData);
    const logoUrl = getPersistedBrandLogoUrl(brand);
    const logoBuffer = logoUrl ? await downloadBounded(logoUrl) : undefined;

    const { default: sharp } = await import('sharp');
    const meta = await sharp(buffer).metadata().catch(() => undefined);

    const checks = await runCreativeContentChecks({
      buffer,
      width: meta?.width,
      height: meta?.height,
      adCopyText: input.adCopyText,
      brand: brandProfile,
      logoBuffer,
    });

    await humanEvalService.appendCreativeGateChecks(input.candidateId, checks);
  } catch (err) {
    console.warn('[creative-content-checks] runtime hook failed (ignored):', err instanceof Error ? err.message : err);
  }
}
