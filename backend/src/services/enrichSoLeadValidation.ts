/**
 * Background email-validation helpers for lead create + CSV import.
 *
 * Both helpers swallow errors so a transient enrich.so outage never breaks lead
 * creation. Callers should fire-and-forget (`void validateLeadsInBackground(...)`).
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
    console.error('[enrichSo] background validation failed:', (err as Error).message);
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

export async function validateLeadsInBackground(
  listId: string,
  leads: ValidatableLead[],
  userId?: string,
  jobId?: string,
  opts: ValidateLeadEmailOpts = {},
): Promise<void> {
  try {
    await runWithConcurrency(leads, VALIDATION_CONCURRENCY, async (l) => {
      const r = await validateLeadEmailInBackground(listId, l.leadId, l.email ?? '', userId, opts);
      if (jobId) {
        // For validate jobs, "found" === deliverable. Risky/undeliverable/unknown
        // count as not-found so the UI breakdown is meaningful.
        if (!r) recordResult(jobId, { found: false, error: true });
        else recordResult(jobId, { found: r.status === 'deliverable' });
      }
    });
    if (jobId) completeJob(jobId);
  } catch (err) {
    if (jobId) completeJob(jobId, (err as Error).message);
    throw err;
  }
}
