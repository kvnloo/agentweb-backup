/**
 * Background email-validation helpers for lead create + CSV import.
 *
 * Both helpers swallow transient errors so an enrich.so outage never breaks lead
 * creation. A 402 / out-of-credits answer is logged + alerted (ENG-2983) and
 * fails bulk validation jobs explicitly. Callers should fire-and-forget (`void validateLeadsInBackground(...)`).
 *
 * The validated result is persisted on the lead under:
 *   customFields.email_validation       — the result the UI renders
 *   enrichmentMetadata.email_validation — metadata for the EnrichedValue badge
 */

import { crmDb } from './db';
import { getEnrichSoService } from './enrichSoService';

export interface ValidatableLead {
  leadId: string;
  email?: string;
}

/**
 * Concurrency cap for bulk background validation. Bounded so a 5K-lead list
 * doesn't fan out 5K simultaneous enrich.so + DDB writes. Tuned to stay well
 * under the upstream rate limit while still finishing in a few minutes.
 */
const VALIDATION_CONCURRENCY = 8;

// ─── ENG-2983: enrich.so credit exhaustion ─────────────────────────────────
//
// A 402 / insufficient-credits answer is NOT a transient outage: every further
// call fails the same way until someone tops up the account. Swallowing it (as
// we do for 5xx) silently disabled validation for lead create, CSV import and
// bulk validate-emails. It is now classified, logged with a stable error class,
// raised as one deduped operator alert per window, and fails bulk jobs loudly.

/** Stable error class operators/log alarms key off. */
export const ENRICHSO_CREDITS_EXHAUSTED = 'ENRICHSO_CREDITS_EXHAUSTED';

export class EnrichSoCreditsExhaustedError extends Error {
  readonly errorClass = ENRICHSO_CREDITS_EXHAUSTED;
  constructor(cause?: string) {
    super(`enrich.so credits exhausted (402)${cause ? `: ${cause}` : ''}`);
    this.name = 'EnrichSoCreditsExhaustedError';
  }
}

/** True for a 402 / insufficient-credits failure, including the plain Error the
 *  enrich.so cache rethrows for a memoized error row (status lost, message kept). */
export function isEnrichSoCreditsExhausted(err: unknown): boolean {
  if (err instanceof EnrichSoCreditsExhaustedError) return true;
  const e = err as any;
  if (e?.response?.status === 402) return true;
  const msg = String(e?.message ?? '');
  return /status code 402|payment required|insufficient[ _-]?(credits?|balance)|out of credits/i.test(msg);
}

/** Alert dedupe window and the window the bulk route treats the account as
 *  still out of credits (refuses new jobs with an explicit error). */
export const CREDITS_ALERT_WINDOW_MS = 15 * 60 * 1000;

let lastCreditsExhaustedAt = 0;
let lastCreditsAlertAt = 0;

type CreditsAlertSink = (info: { errorClass: string; message: string; at: string }) => void;

/** Default sink: one structured error line on a stable marker, same shape as
 *  usageWriteFailureMonitor's alert, so a log alarm keys off it. Injectable. */
let creditsAlertSink: CreditsAlertSink = (info) => {
  console.error(`[enrichSo] ALERT ${info.errorClass} email validation is disabled until enrich.so is topped up:`, JSON.stringify(info));
};

export function setEnrichSoCreditsAlertSink(sink: CreditsAlertSink): void {
  creditsAlertSink = sink;
}

export function recordEnrichSoCreditsExhausted(err: unknown, now: number = Date.now()): void {
  lastCreditsExhaustedAt = now;
  const message = (err as Error)?.message ?? String(err);
  console.error(`[enrichSo] ${ENRICHSO_CREDITS_EXHAUSTED} background validation failed:`, message);
  if (now - lastCreditsAlertAt < CREDITS_ALERT_WINDOW_MS) return;
  lastCreditsAlertAt = now;
  try {
    creditsAlertSink({ errorClass: ENRICHSO_CREDITS_EXHAUSTED, message, at: new Date(now).toISOString() });
  } catch (sinkErr) {
    console.error('[enrichSo] credits alert sink failed:', (sinkErr as Error).message);
  }
}

/** True when a 402 was seen inside the alert window. */
export function isEnrichSoCreditsRecentlyExhausted(now: number = Date.now()): boolean {
  return lastCreditsExhaustedAt > 0 && now - lastCreditsExhaustedAt < CREDITS_ALERT_WINDOW_MS;
}

export function __resetEnrichSoCreditsStateForTesting(): void {
  lastCreditsExhaustedAt = 0;
  lastCreditsAlertAt = 0;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const cap = Math.max(1, limit);
  let i = 0;
  const runners = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx]);
      } catch {
        // Worker is expected to handle its own errors; this catch keeps the
        // runner alive even if the worker rejects unexpectedly.
      }
    }
  });
  await Promise.all(runners);
}

export interface ValidateLeadEmailOpts {
  /** When true and the result is undeliverable/risky, the lead is also flipped
   *  to contactStatus='do-not-contact' (best-effort; failures are logged, not
   *  thrown). Already-DNC/unsubscribed leads are preserved. Default: false —
   *  legacy single-create + CSV-import callers don't want this surprise. The
   *  bulk validate route passes true when the user ticks the UI checkbox. */
  autoDncOnFailure?: boolean;
}

export async function validateLeadEmailInBackground(
  listId: string,
  leadId: string,
  email: string,
  userId?: string,
  opts: ValidateLeadEmailOpts = {},
): Promise<{ status: string } | null> {
  try {
    return await validateLeadEmailOrThrowCredits(listId, leadId, email, userId, opts);
  } catch (err) {
    // Fire-and-forget callers must never see a rejection; the 402 was already
    // logged + alerted inside.
    if (err instanceof EnrichSoCreditsExhaustedError) return null;
    throw err;
  }
}

/** Same as validateLeadEmailInBackground but rethrows a credit-exhaustion
 *  failure (after logging + alerting) so bulk jobs can stop and fail loudly. */
async function validateLeadEmailOrThrowCredits(
  listId: string,
  leadId: string,
  email: string,
  userId?: string,
  opts: ValidateLeadEmailOpts = {},
): Promise<{ status: string } | null> {
  if (!email || !email.trim()) return null;

  let svc;
  try {
    svc = getEnrichSoService();
  } catch {
    return null;  // service not initialized — skip silently
  }

  let result;
  try {
    result = await svc.validateEmail(email, userId ? { userId } : {});
  } catch (err) {
    if (isEnrichSoCreditsExhausted(err)) {
      recordEnrichSoCreditsExhausted(err);
      throw new EnrichSoCreditsExhaustedError((err as Error)?.message);
    }
    console.error('[enrichSo] background validation failed (transient):', (err as Error).message);
    return null;
  }

  // Use the targeted setLeadEmailValidation path so we update only the two
  // email_validation keys without read-modify-writing the rest of customFields
  // (which would clobber concurrent user edits — see review M4).
  const validation = {
    status: result.status,
    confidence: result.confidence,
    isCatchAll: result.isCatchAll,
    provider: result.provider,
    message: result.message,
    checkedAt: result.checkedAt,
  };
  const now = new Date().toISOString();
  const metadata = {
    source: 'web_search' as const,
    confidence: result.confidence,
    enrichedAt: now,
    sourceQuote: `Email verification: ${result.message ?? result.status}`,
  };
  try {
    await crmDb.setLeadEmailValidation(listId, leadId, validation, metadata);
  } catch (err) {
    console.error('[enrichSo] setLeadEmailValidation failed during background validation:', (err as Error).message);
    return null;
  }

  // Auto-DNC (opt-in via opts). Only `undeliverable` triggers the flip — risky
  // is intentionally excluded since many risky results are catch-all domains
  // that still deliver. One extra getLeadById per undeliverable hit so we don't
  // clobber a user-set DNC reason. Failures here are logged but don't fail the
  // whole call — the validation pill already updated.
  const isBadResult = result.status === 'undeliverable';
  if (opts.autoDncOnFailure && isBadResult) {
    try {
      const lead: any = await crmDb.getLeadById(listId, leadId);
      const alreadySuppressed =
        lead?.contactStatus === 'do-not-contact' || lead?.contactStatus === 'unsubscribed';
      if (lead && !alreadySuppressed) {
        await crmDb.updateLead(listId, leadId, {
          contactStatus: 'do-not-contact',
          contactStatusReason: 'bounced',
          contactStatusNote: `Email ${result.status}`,
          contactStatusUpdatedAt: now,
          contactStatusUpdatedBy: userId ?? 'system',
        } as any);
      }
    } catch (err) {
      console.error('[enrichSo] auto-DNC failed (best-effort):', (err as Error).message);
    }
  }

  return { status: result.status };
}

import { recordResult, completeJob } from './emailJobTracker';

export const ENRICHSO_CREDITS_EXHAUSTED_USER_MESSAGE =
  'Email validation is unavailable: the enrich.so account is out of credits. No validation results were recorded for the remaining leads.';

export async function validateLeadsInBackground(
  listId: string,
  leads: ValidatableLead[],
  userId?: string,
  jobId?: string,
  opts: ValidateLeadEmailOpts = {},
): Promise<void> {
  let creditsError: EnrichSoCreditsExhaustedError | null = null;
  try {
    await runWithConcurrency(leads, VALIDATION_CONCURRENCY, async (l) => {
      // Once the account is out of credits every further call fails the same
      // way — stop instead of burning N doomed requests.
      if (creditsError) return;
      let r: { status: string } | null;
      try {
        r = await validateLeadEmailOrThrowCredits(listId, l.leadId, l.email ?? '', userId, opts);
      } catch (err) {
        if (err instanceof EnrichSoCreditsExhaustedError) {
          creditsError = err;
          return;
        }
        r = null;
      }
      if (jobId) {
        // For validate jobs, "found" === deliverable. Risky/undeliverable/unknown
        // count as not-found so the UI breakdown is meaningful.
        if (!r) recordResult(jobId, { found: false, error: true });
        else recordResult(jobId, { found: r.status === 'deliverable' });
      }
    });
    if (creditsError) {
      if (jobId) completeJob(jobId, ENRICHSO_CREDITS_EXHAUSTED_USER_MESSAGE);
      return;
    }
    if (jobId) completeJob(jobId);
  } catch (err) {
    if (jobId) completeJob(jobId, (err as Error).message);
    throw err;
  }
}
