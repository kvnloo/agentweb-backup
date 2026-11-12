/**
 * ENG-2958 (ENG-2847.11): pure external activation-preview digest.
 *
 * External (non-Emma-chat) callers such as a Slack-approved Yugo/MCP bridge
 * need the same preview-bound activation contract as ENG-964's A1+A2 gate,
 * without fabricating Emma approval cards. This module only computes and
 * verifies a preview: it activates nothing, sends nothing, persists nothing,
 * and deliberately imports no Emma agent/session/approval-card code (the
 * ENG-964 gate module pulls in approvalDeck at runtime, so the hash material is
 * mirrored here rather than imported).
 *
 * Wiring this into manage_crm_sequence is a separate Risk: High follow-up.
 */
import { createHash } from 'crypto';

export interface ExternalActivationSequence {
  sequenceId?: string;
  steps?: Array<Record<string, any>>;
  autoEnrollListIds?: unknown;
  enrollmentCondition?: unknown;
  exitConditions?: unknown;
  recipientsCount?: number;
}

export interface ExternalActivationPreview {
  sequenceId: string;
  versionHash: string;
  stepCount: number;
  channels: string[];
  recipientsCount?: number;
  approverPrincipal: string;
  /** sha256 over versionHash + sequenceId + approverPrincipal. */
  digest: string;
}

export type ExternalActivationVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'version_drift' | 'principal_mismatch' | 'malformed' };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value ?? null;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Stable hash over ordered step content (copy/sender/channel/delay) and audience. */
export function computeExternalVersionHash(sequence: ExternalActivationSequence): string {
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
  return sha256({
    sequenceId: sequence?.sequenceId ?? null,
    steps: steps.map((s) => ({
      name: s?.name,
      channel: s?.channel ?? 'email',
      subject: s?.subject,
      bodyHtml: s?.bodyHtml,
      messageText: s?.messageText,
      senderId: s?.senderId,
      linkedInAccountId: s?.linkedInAccountId,
      delayDays: s?.delayDays ?? null,
    })),
    audience: {
      autoEnrollListIds: Array.isArray(sequence?.autoEnrollListIds)
        ? [...(sequence.autoEnrollListIds as unknown[])].map(String).sort()
        : [],
      enrollmentCondition: sequence?.enrollmentCondition ?? null,
      exitConditions: sequence?.exitConditions ?? null,
    },
  });
}

function computeDigest(sequenceId: string, versionHash: string, approverPrincipal: string): string {
  return sha256({ sequenceId, versionHash, approverPrincipal });
}

export function buildExternalActivationPreview(
  sequence: ExternalActivationSequence,
  { approverPrincipal }: { approverPrincipal: string },
): ExternalActivationPreview {
  if (!isNonEmptyString(sequence?.sequenceId)) throw new Error('sequenceId is required');
  if (!isNonEmptyString(approverPrincipal)) throw new Error('approverPrincipal is required');
  if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
    throw new Error('sequence must have at least one step');
  }
  const versionHash = computeExternalVersionHash(sequence);
  const channels = [...new Set(sequence.steps.map((s) => String(s?.channel ?? 'email')))].sort();
  const preview: ExternalActivationPreview = {
    sequenceId: sequence.sequenceId,
    versionHash,
    stepCount: sequence.steps.length,
    channels,
    approverPrincipal,
    digest: computeDigest(sequence.sequenceId, versionHash, approverPrincipal),
  };
  if (typeof sequence.recipientsCount === 'number') preview.recipientsCount = sequence.recipientsCount;
  return preview;
}

export function verifyExternalActivationPreview(
  preview: ExternalActivationPreview,
  currentSequence: ExternalActivationSequence,
  { approverPrincipal }: { approverPrincipal: string },
): ExternalActivationVerifyResult {
  if (
    !preview ||
    !isNonEmptyString(preview.sequenceId) ||
    !isNonEmptyString(preview.versionHash) ||
    !isNonEmptyString(preview.approverPrincipal) ||
    !isNonEmptyString(preview.digest) ||
    !isNonEmptyString(approverPrincipal) ||
    !currentSequence ||
    !Array.isArray(currentSequence.steps) ||
    preview.digest !== computeDigest(preview.sequenceId, preview.versionHash, preview.approverPrincipal)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (preview.approverPrincipal !== approverPrincipal) return { ok: false, reason: 'principal_mismatch' };
  if (
    currentSequence.sequenceId !== preview.sequenceId ||
    computeExternalVersionHash(currentSequence) !== preview.versionHash
  ) {
    return { ok: false, reason: 'version_drift' };
  }
  return { ok: true };
}
