import { createHash } from 'crypto';
import { humanEvalService, type HumanEvalAction, type HumanEvalCandidate, type HumanEvalReviewType } from './humanEvalService';
import { settingsService } from './settingsService';
import type { CreativeGateResult } from './creativeGates';
import type { CreativeBrief } from './creativeRubricJudge';
import { judgeHumanEvalCandidate } from './creativeRubricJudgeRuntime';
import { runContentChecksForCandidate } from './creativeContentCheckRunner';

export interface AutoHumanEvalInput {
  reviewType: HumanEvalReviewType;
  outputSummary: string;
  sourceKey: string;
  userId?: string;
  sessionId?: string;
  agentRunId?: string;
  artifactUrl?: string;
  chatUrl?: string;
  originalRequest?: string;
  action?: HumanEvalAction;
  /**
   * Ad vs Organic Post use-case tag (ENG-90). Set it only when the enqueueing
   * flow knows its use case; ambiguous flows omit it and the candidate is
   * stored fail-open as 'uncategorized'.
   */
  category?: string;
  /** Advisory creative gate result from generation (ENG-2139); stored on the candidate. */
  creativeGates?: CreativeGateResult;
  /** What the generating flow knows about the creative's brief, for the rubric judge (ENG-2140). */
  creativeBrief?: Omit<CreativeBrief, 'brand'>;
  /** Landing pages: the generated page source for the rubric judge, read only if sampled (ENG-2192). */
  loadLandingPageSource?: () => Promise<string | undefined>;
  /** Ad copy (headline/body/CTA) supplied alongside the image, if any — spell-checked and
   *  policy-screened together with the OCR'd text by the ENG-2193 content checks. */
  adCopyText?: string;
}

function dedupeSettingKey(sourceKey: string): string {
  const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 32);
  return `human_eval_auto_${digest}`;
}

/**
 * One settings row per UTC month, holding the claimed-artifact-URL set for that month. Bounds
 * the set's growth (a fresh row every month) rather than one global, ever-growing row — this
 * table has no TTL/pruning, and human-eval-eligible artifact volume, while not huge, runs
 * indefinitely.
 */
function artifactClaimsSettingName(): string {
  const now = new Date();
  const bucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `human_eval_artifact_claims_${bucket}`;
}

/**
 * Cross-path dedup (ENG-1854), independent of the sourceKey dedup above. sourceKey dedup only
 * catches ONE trigger mechanism re-firing on its own retries — it does nothing when the SAME
 * artifact reaches #eval-queue via two genuinely different mechanisms, e.g. an image
 * auto-posts on generation, and Emma's manual enqueue_human_eval tool also fires for that
 * same image (the two paths have no shared sourceKey format to collide on). This claims the
 * artifact URL itself, the one identity every path for a given artifact can independently
 * derive without knowing about the other paths. Whichever caller reaches this first wins; the
 * other should skip enqueueing.
 *
 * Uses `settingsService.claimSetMember` — an atomic DynamoDB `ADD`, not a get-then-set — so two
 * genuinely concurrent callers can't both win the same claim (a plain get/check/set here would
 * be exactly the TOCTOU race this dedup exists to prevent). Every caller MUST call
 * `releaseArtifactClaim` if it claims but then fails to actually create the candidate — an
 * unreleased claim on a failed attempt would permanently blackhole that artifact from ever
 * being sent, the same "silently dropped" failure mode this whole PR exists to eliminate.
 *
 * Fail-open on any settings error: never block a real candidate over an infra hiccup.
 */
export async function claimArtifactForHumanEval(artifactUrl: string | undefined): Promise<boolean> {
  if (!artifactUrl) return true;
  try {
    return await settingsService.claimSetMember(artifactClaimsSettingName(), artifactUrl);
  } catch (err: any) {
    console.warn('[auto-human-eval] artifact dedupe claim failed, proceeding anyway:', err?.message || err);
    return true;
  }
}

/** Release counterpart — call after a claimed artifact's candidate creation fails, so a retry
 *  (or a different path) can claim it again instead of it being lost forever. */
export async function releaseArtifactClaim(artifactUrl: string | undefined): Promise<void> {
  if (!artifactUrl) return;
  try {
    await settingsService.releaseSetMember(artifactClaimsSettingName(), artifactUrl);
  } catch (err: any) {
    console.warn('[auto-human-eval] failed to release artifact claim (non-fatal — a retry may be treated as a duplicate until this ages out):', err?.message || err);
  }
}

/**
 * Best-effort automatic human-eval enqueue.
 *
 * Artifact creation must never fail because Slack/settings/eval storage is down.
 * We dedupe by stable source keys (session+filename, landing-page id, enrichment
 * run id) after a successful enqueue so retries do not spam the eval channel.
 */
export async function enqueueAutoHumanEval(
  input: AutoHumanEvalInput,
): Promise<HumanEvalCandidate | null> {
  if (process.env.AUTO_HUMAN_EVAL_DISABLED === 'true') return null;

  const outputSummary = input.outputSummary?.trim();
  const sourceKey = input.sourceKey?.trim();
  if (!outputSummary || !sourceKey) return null;

  const settingKey = dedupeSettingKey(sourceKey);
  let claimedArtifact = false;

  try {
    const existing = await settingsService.getSetting(settingKey);
    if (existing?.settingValue) return null;

    if (!(await claimArtifactForHumanEval(input.artifactUrl))) return null;
    claimedArtifact = true;

    const candidate = await humanEvalService.createCandidate({
      reviewType: input.reviewType,
      outputSummary,
      userId: input.userId,
      sessionId: input.sessionId,
      agentRunId: input.agentRunId,
      artifactUrl: input.artifactUrl,
      chatUrl: input.chatUrl,
      originalRequest: input.originalRequest,
      action: input.action,
      category: input.category,
      creativeGates: input.creativeGates,
    });

    // Round-4 review finding: this sourceKey-marker write is housekeeping, not the actual
    // success condition — it must be its own try/catch, non-fatal on failure. Letting it
    // propagate to the outer catch would incorrectly treat an already-persisted candidate as a
    // failure: the artifact claim would get released even though it was genuinely consumed,
    // reopening the exact cross-path duplicate window this claim exists to close (a different
    // path could then claim and create a second candidate for the same real artifact), and the
    // sourceKey dedupe would silently stop guarding this sourceKey against a later retry.
    try {
      await settingsService.setSetting(
        settingKey,
        candidate.candidateId,
        `Automatic human eval candidate for ${sourceKey}`,
        'auto-human-eval',
      );
    } catch (markerErr: any) {
      console.warn('[auto-human-eval] sourceKey dedupe marker write failed after the candidate was already created (non-fatal):', markerErr?.message || markerErr);
    }

    // ENG-2140 / ENG-2192: advisory rubric judge on sampled generated images and landing pages,
    // only when enabled. Not awaited, and the hook never throws, so it cannot delay or fail the
    // enqueue or the generation.
    if (input.reviewType === 'creative_image' || input.reviewType === 'landing_page') {
      void judgeHumanEvalCandidate({
        candidateId: candidate.candidateId,
        userId: input.userId,
        reviewType: input.reviewType,
        category: input.category,
        artifactUrl: candidate.artifactUrl ?? input.artifactUrl,
        createdAt: candidate.createdAt,
        creativeGates: input.creativeGates,
        ...(input.loadLandingPageSource ? { loadLandingPageSource: input.loadLandingPageSource } : {}),
        brief: input.creativeBrief,
      }).catch(() => undefined);
    }

    // ENG-2193: OCR/spelling/brand-colour/logo/policy-keyword checks, appended onto the
    // structural `creativeGates` already stored above. Images only for now — see
    // `creativeContentCheckRunner.ts`'s header for why landing pages aren't wired in here.
    // Off by default (`CREATIVE_CONTENT_CHECKS_ENABLED`); the runner no-ops when unset, but the
    // env check is duplicated here too so a disabled flag skips even the download-bound work of
    // scheduling the call, not just the checks themselves.
    if (input.reviewType === 'creative_image' && process.env.CREATIVE_CONTENT_CHECKS_ENABLED === 'true') {
      void runContentChecksForCandidate({
        candidateId: candidate.candidateId,
        artifactUrl: candidate.artifactUrl ?? input.artifactUrl,
        userId: input.userId,
        adCopyText: input.adCopyText,
      }).catch(() => undefined);
    }

    return candidate;
  } catch (err: any) {
    // Only reachable if the claim was won but createCandidate itself never succeeded — release
    // it so a retry (or a different path) can claim it again, rather than permanently
    // blackholing this artifact (see claimArtifactForHumanEval's own doc comment).
    if (claimedArtifact) await releaseArtifactClaim(input.artifactUrl);
    console.warn('[auto-human-eval] enqueue failed:', err?.message || err);
    return null;
  }
}
