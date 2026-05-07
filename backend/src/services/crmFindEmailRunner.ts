/**
 * Background bulk find-email runner — for leads with name + (company or
 * website) OR a LinkedIn URL but no email, look up the email via the
 * cross-provider waterfall and write it back to the lead record. Does not
 * block the response. Per-lead failures are swallowed (logged + recorded
 * on the job tracker).
 *
 * Extracted from routes/crmEnrichSo.ts so non-route callers (Phase 1
 * auto-enrich glue) can invoke it without a service → route import.
 */

import { crmDb } from './db';
import { waterfallFindEmail } from './enrichmentWaterfall';
import { applyApolloMatchToLead } from './applyApolloMatchToLead';
import { recordResult, completeJob } from './emailJobTracker';
import {
  runWithConcurrency,
  BULK_ENRICH_CONCURRENCY,
} from './crmEnrichmentConcurrency';

export async function findEmailsForLeadsInBackground(
  listId: string,
  leads: any[],
  userId: string,
  jobId?: string,
): Promise<void> {
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
        const r = await waterfallFindEmail(
          {
            firstName,
            lastName,
            company: company || undefined,
            website: website || undefined,
            linkedin: lead.linkedin || undefined,
            leadHint: { listId, leadId: lead.leadId },
          },
          { userId },
        );
        if (r.found && r.email) {
          // When Apollo's matchPerson was the source (Tier 2 first leg, has
          // r.apolloMatch), project the full payload onto missing fields too —
          // title, linkedin, company, employment history, tech stack, funding,
          // headcount growth. Never overwrites existing values.
          //
          // For non-Apollo hits (enrich.so finder, pattern, Apollo findEmail
          // basic) we only have the email itself, so just write that.
          if (r.apolloMatch) {
            const proj = applyApolloMatchToLead(lead, r.apolloMatch, { fillEmail: true });
            // The waterfall already returned r.email which equals proj.updates.email
            // (or the existing lead email if user filled). Ensure the email
            // metadata sourceQuote includes Apollo's emailStatus where available.
            if (r.emailStatus && proj.enrichmentMetadata.email) {
              proj.enrichmentMetadata.email.sourceQuote = `Apollo (${r.emailStatus})`;
            }
            const payload: any = { ...proj.updates, enrichmentMetadata: proj.enrichmentMetadata };
            if (Object.keys(proj.customFields).length > 0) {
              payload.customFields = { ...((lead.customFields ?? {}) as Record<string, any>), ...proj.customFields };
            }
            // Ensure email always lands even if applyApolloMatchToLead's
            // never-overwrite rule skipped it for some edge case.
            if (!payload.email) payload.email = r.email;
            await crmDb.updateLead(listId, lead.leadId, payload);
          } else {
            const now = new Date().toISOString();
            const enrichmentMetadata = {
              ...((lead.enrichmentMetadata ?? {}) as Record<string, any>),
              email: {
                source: 'web_search' as const,
                provider: r.provider ?? 'enrich.so',
                confidence: r.confidence ?? 'medium',
                enrichedAt: now,
                sourceQuote: r.message ?? (r.emailStatus ? `Apollo (${r.emailStatus})` : undefined),
              },
            };
            await crmDb.updateLead(listId, lead.leadId, { email: r.email, enrichmentMetadata });
          }
          if (jobId) recordResult(jobId, { found: true, tier: r.tier });
        } else {
          if (jobId) recordResult(jobId, { found: false });
        }
      } catch (err) {
        console.error('[CRM bulk find-email] failed for', lead.leadId, ':', (err as Error).message);
        if (jobId) recordResult(jobId, { found: false, error: true });
      }
    });
    if (jobId) completeJob(jobId);
  } catch (err) {
    if (jobId) completeJob(jobId, (err as Error).message);
    throw err;
  }
}
