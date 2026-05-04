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

export async function validateLeadEmailInBackground(
  listId: string,
  leadId: string,
  email: string,
  userId?: string,
): Promise<void> {
  if (!email || !email.trim()) return;

  let svc;
  try {
    svc = getEnrichSoService();
  } catch {
    return;  // service not initialized — skip silently
  }

  let result;
  try {
    result = await svc.validateEmail(email, userId ? { userId } : {});
  } catch (err) {
    console.error('[enrichSo] background validation failed:', (err as Error).message);
    return;
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
  const metadata = {
    source: 'web_search' as const,
    confidence: result.confidence,
    enrichedAt: new Date().toISOString(),
    sourceQuote: `Email verification: ${result.message ?? result.status}`,
  };
  try {
    await crmDb.setLeadEmailValidation(listId, leadId, validation, metadata);
  } catch (err) {
    console.error('[enrichSo] setLeadEmailValidation failed during background validation:', (err as Error).message);
  }
}

export async function validateLeadsInBackground(
  listId: string,
  leads: ValidatableLead[],
  userId?: string,
): Promise<void> {
  await Promise.allSettled(
    leads.map((l) => validateLeadEmailInBackground(listId, l.leadId, l.email ?? '', userId)),
  );
}
