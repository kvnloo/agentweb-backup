/**
 * ENG-2556 (ENG-2167 Phase 1): pure group-send recipient planner.
 * Normalizes + dedupes recipients, applies the do-not-email list, and chunks
 * the allowed set into Resend-sized batches. No I/O, not yet wired into a
 * send path. Fails closed on oversize or empty sends.
 */
import { checkSuppression, normalizeEmail, SuppressionList, SuppressionReason } from './dripSuppressionList';

export const RESEND_MAX_BATCH_SIZE = 100;
export const DEFAULT_MAX_RECIPIENTS = 5000;

export type ExclusionReason = SuppressionReason | 'duplicate';

export interface GroupSendPlanInput {
  recipients: readonly unknown[];
  suppression: SuppressionList;
  batchSize?: number;
  maxRecipients?: number;
}

export interface GroupSendExclusion {
  email: string;
  reason: ExclusionReason;
}

export type GroupSendPlan =
  | { ok: true; batches: string[][]; recipientCount: number; excluded: GroupSendExclusion[] }
  | {
      ok: false;
      error: 'invalid_batch_size' | 'invalid_max_recipients' | 'too_many_recipients' | 'no_recipients';
      excluded: GroupSendExclusion[];
      recipientCount: number;
    };

export function planGroupSend(input: GroupSendPlanInput): GroupSendPlan {
  const batchSize = input.batchSize ?? RESEND_MAX_BATCH_SIZE;
  const maxRecipients = input.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > RESEND_MAX_BATCH_SIZE) {
    return { ok: false, error: 'invalid_batch_size', excluded: [], recipientCount: 0 };
  }
  if (!Number.isInteger(maxRecipients) || maxRecipients < 1) {
    return { ok: false, error: 'invalid_max_recipients', excluded: [], recipientCount: 0 };
  }

  const seen = new Set<string>();
  const allowed: string[] = [];
  const excluded: GroupSendExclusion[] = [];
  for (const raw of input.recipients ?? []) {
    const result = checkSuppression(input.suppression, raw);
    const normalized = normalizeEmail(raw);
    if (result.suppressed || !normalized) {
      excluded.push({ email: normalized ?? String(raw), reason: result.reason ?? 'invalid_address' });
      continue;
    }
    if (seen.has(normalized)) {
      excluded.push({ email: normalized, reason: 'duplicate' });
      continue;
    }
    seen.add(normalized);
    allowed.push(normalized);
  }

  if (allowed.length === 0) {
    return { ok: false, error: 'no_recipients', excluded, recipientCount: 0 };
  }
  if (allowed.length > maxRecipients) {
    return { ok: false, error: 'too_many_recipients', excluded, recipientCount: allowed.length };
  }

  const batches: string[][] = [];
  for (let i = 0; i < allowed.length; i += batchSize) {
    batches.push(allowed.slice(i, i + batchSize));
  }
  return { ok: true, batches, recipientCount: allowed.length, excluded };
}
