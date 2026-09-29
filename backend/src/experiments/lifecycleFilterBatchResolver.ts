import {
  computeBackfillScores,
  type BackfillLead,
  type BackfillUser,
} from '../utils/crmBackfill';
import {
  buildBackfillSignalsExtension,
  type BackfillDeal,
  type BackfillEvent,
} from '../utils/crmBackfillSignals';
import type { LifecycleStage } from '../services/lifecycleService';

export interface LifecycleFilterBatchDeps {
  loadUsersByEmails(emails: string[]): Promise<Map<string, BackfillUser | null>>;
  loadEventsByContactIds(contactIds: string[]): Promise<Map<string, BackfillEvent[]>>;
  loadDealsByIds(dealIds: string[]): Promise<Map<string, BackfillDeal>>;
}

export interface LifecycleFilterBatchResult {
  lifecycleByLeadId: Map<string, LifecycleStage>;
  dependencyCalls: number;
  uniqueEmails: number;
  uniqueDealIds: number;
}

const norm = (value: string) => value.trim().toLowerCase();

export async function resolveLifecycleFilterBatch(
  leads: BackfillLead[],
  deps: LifecycleFilterBatchDeps,
  now: Date = new Date(),
): Promise<LifecycleFilterBatchResult> {
  const emails = [...new Set(
    leads
      .map((lead) => typeof lead.email === 'string' ? norm(lead.email) : '')
      .filter(Boolean),
  )];
  const dealIds = [...new Set(leads.flatMap((lead) => Array.isArray(lead.dealIds) ? lead.dealIds : []).filter(Boolean))];

  const [usersByEmail, eventsByContactId, dealsById] = await Promise.all([
    deps.loadUsersByEmails(emails),
    deps.loadEventsByContactIds(emails),
    deps.loadDealsByIds(dealIds),
  ]);

  const lifecycleByLeadId = new Map<string, LifecycleStage>();
  for (const lead of leads) {
    const email = typeof lead.email === 'string' ? norm(lead.email) : '';
    const user = email ? (usersByEmail.get(email) ?? null) : null;
    const events = email ? (eventsByContactId.get(email) ?? []) : [];
    const deals = (lead.dealIds ?? [])
      .map((dealId) => dealsById.get(dealId))
      .filter((deal): deal is BackfillDeal => Boolean(deal));
    const extension = buildBackfillSignalsExtension(events, deals);
    lifecycleByLeadId.set(
      lead.leadId,
      computeBackfillScores({ lead, user, ...extension }, now).lifecycle,
    );
  }

  return {
    lifecycleByLeadId,
    dependencyCalls: 3,
    uniqueEmails: emails.length,
    uniqueDealIds: dealIds.length,
  };
}
