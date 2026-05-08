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
  const populatedFieldNames = new Set<string>();
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
          if (r.apolloMatch) {
            const proj = applyApolloMatchToLead(lead, r.apolloMatch, { fillEmail: true });
            if (r.emailStatus && proj.enrichmentMetadata.email) {
              proj.enrichmentMetadata.email.sourceQuote = `Apollo (${r.emailStatus})`;
            }
            // Belt-and-suspenders: all leads here have no email (guaranteed by
            // isApplicableForFindEmail), but guard in case applyApolloMatchToLead
            // skipped it for an unexpected edge case.
            if (!proj.updates.email) proj.updates.email = r.email;

            // Extract only the delta — proj.enrichmentMetadata is a full map
            // (snapshot + new keys). We only want to write keys for fields we
            // actually changed so we don't touch unrelated metadata.
            const enrichmentMetadataDelta: Record<string, any> = {};
            for (const k of proj.changed) {
              if (proj.enrichmentMetadata[k] !== undefined) {
                enrichmentMetadataDelta[k] = proj.enrichmentMetadata[k];
              }
            }

            await crmDb.setLeadFields(listId, lead.leadId, {
              topLevel: proj.updates,
              enrichmentMetadata: enrichmentMetadataDelta,
              customFields: proj.customFields,
            });

            for (const k of proj.changed) populatedFieldNames.add(k);
          } else {
            const now = new Date().toISOString();
            await crmDb.setLeadFields(listId, lead.leadId, {
              topLevel: { email: r.email },
              enrichmentMetadata: {
                email: {
                  source: 'web_search' as const,
                  provider: r.provider ?? 'enrich.so',
                  confidence: r.confidence ?? 'medium',
                  enrichedAt: now,
                  sourceQuote: r.message ?? (r.emailStatus ? `Apollo (${r.emailStatus})` : undefined),
                },
              },
            });
            populatedFieldNames.add('email');
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
