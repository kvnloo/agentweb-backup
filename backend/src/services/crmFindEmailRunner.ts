/**
 * Background bulk find-email runner — for leads with name + (company or
 * website) OR a LinkedIn URL but no email, look up the email via the
 * identity resolver and write it back to the lead record. Does not
 * block the response. Per-lead failures are swallowed (logged + recorded
 * on the job tracker).
 *
 * Extracted from routes/crmEnrichSo.ts so non-route callers (Phase 1
 * auto-enrich glue) can invoke it without a service → route import.
 */

import { crmDb } from './db';
import { resolveIdentity } from './enrichmentIdentityResolver';
import type { LeadRecord } from './crmEnrichmentService';
import { recordResult, completeJob } from './emailJobTracker';
import {
  runWithConcurrency,
  BULK_ENRICH_CONCURRENCY,
} from './crmEnrichmentConcurrency';
import { validateLeadEmailInBackground } from './enrichSoLeadValidation';

export async function findEmailsForLeadsInBackground(
  listId: string,
  leads: any[],
  userId: string,
  jobId?: string,
): Promise<void> {
  const populatedFieldNames = new Set<string>();
  // Lazy require to avoid pulling enrichmentV3RealDeps (→ llmService → @langchain/aws)
  // at module load time. Callers like agentModeService that don't use LLM deps
  // would otherwise inherit a broken native module import.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildIdentityDeps } = require('./enrichmentV3RealDeps') as typeof import('./enrichmentV3RealDeps');
  const deps = buildIdentityDeps(userId);
  try {
    await runWithConcurrency(leads, BULK_ENRICH_CONCURRENCY, async (lead) => {
      const firstName = (lead.firstName ?? '').trim();
      const lastName = (lead.lastName ?? '').trim();
      const company = (lead.company ?? '').trim();
      const website = (lead.website ?? '').trim();
      const linkedin = (lead.linkedin ?? '').trim();
      const haveName = !!(firstName || lastName);
      const haveOrg = !!(company || website);
      if (!linkedin && !(haveName && haveOrg)) {
        if (jobId) recordResult(jobId, { found: false });
        return;
      }
      try {
        const result = await resolveIdentity(
          {
            lead: lead as LeadRecord,
            mode: 'enrich',
            listId,
            needsPersonFields: false,
            needsCompanyFields: false,
            leadHint: { listId, leadId: lead.leadId },
          },
          deps,
        );
        if (result.ok && result.resolved.email) {
          for (const k of Object.keys(result.resolved)) {
            if (k !== 'emailDomain') populatedFieldNames.add(k);
          }
          void validateLeadEmailInBackground(listId, lead.leadId, result.resolved.email, userId);
          if (jobId) recordResult(jobId, { found: true, tier: undefined });
        } else {
          if (jobId) recordResult(jobId, { found: false });
        }
      } catch (err) {
        console.error('[CRM bulk find-email] failed for', lead.leadId, ':', (err as Error).message);
        if (jobId) recordResult(jobId, { found: false, error: true });
      }
    });
    try {
      await crmDb.mergeFieldNames(listId, populatedFieldNames);
    } catch (err) {
      console.error('[CRM bulk find-email] failed to update fieldNames:', (err as Error).message);
    }
    if (jobId) completeJob(jobId);
  } catch (err) {
    if (jobId) completeJob(jobId, (err as Error).message);
    throw err;
  }
}
