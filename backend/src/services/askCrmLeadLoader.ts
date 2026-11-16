/**
 * Production ask_crm lead loader.
 *
 * Live signals are enrichment only. User-account data is consumed only when the
 * matched account is the caller or belongs to the caller's organization.
 * The owner-wide deal query is bounded, so it supplies positive evidence only:
 * absence from that page never erases a stored open-deal signal.
 *
 * Known, accepted limitation (not fixed here): this makes `openDealStages`
 * one-directional — a deal this query SEES as still open can correctly ADD to the
 * stored stages, but a deal that has since closed (Won/Lost) is dropped from this
 * computation entirely rather than used to REMOVE a stale stored entry, because
 * `openDealStages` only stores stage NAME strings with no deal-id linkage — once a
 * deal closes there is no way to tell which stored stage string it used to
 * correspond to. A real fix needs either a per-contact deal query (defeats the
 * "one bounded query" cost design) or a data-model change so a lead's open-deal
 * signal carries deal ids, not just stage names. Until then, a closed-but-stale
 * `openDealStages` entry can make `hasCurrentOpenDeal` (askCrmService.ts) keep
 * firing for a dead deal — `computeLifecycle`'s `in_deal` rule is lower-priority
 * than the churned/paying/trialing rules, so the blast radius is a stale pipeline
 * classification, not a false financial/churn answer.
 */
import type { AskCrmLead } from './askCrmService';
import { mapSubscriptionState, pickLatestTimestamp } from '../utils/crmBackfill';
import { excludeSessionLists } from '../utils/sessionList';

/**
 * Exported so callers (ask_crm's `load_limit` parameter) can cap how many leads
 * they ever ask this loader to scan at this same number — scanning more than this
 * would silently return leads with no live enrichment at all, reintroducing the
 * exact frozen-forever staleness ENG-2155 exists to fix for whichever leads fall
 * past the budget, with nothing in the response signalling that it happened.
 */
export const USER_LOOKUP_BUDGET = 500;
const USER_LOOKUP_BATCH = 20;
const DEAL_LOOKUP_LIMIT = 1000;

type Row = Record<string, unknown>;

export interface AskCrmLeadLoaderDeps {
  getLeadListsForUser(userId: string): Promise<unknown>;
  getLeadsByListId(listId: string, limit: number): Promise<unknown>;
  getUserById(userId: string): Promise<unknown>;
  getUserByEmail(email: string): Promise<unknown>;
  getDealsByOwner(userId: string, opts: { limit: number }): Promise<unknown>;
}

function record(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Row
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return stringValue(value) ?? null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizedEmail(value: unknown): string | null {
  const email = stringValue(value)?.trim().toLowerCase();
  return email || null;
}

function openStages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((stage): stage is string => typeof stage === 'string' && stage.trim() !== '')
      .filter((stage) => !['won', 'lost'].includes(stage.trim().toLowerCase()))
  )];
}

function normalizeUser(value: unknown): {
  userId: string;
  orgId?: string;
  subscriptionStatus?: string;
  lastActiveAt?: string;
  lastLoginTime?: string;
} | null {
  const row = record(value);
  const userId = row && stringValue(row.userId);
  if (!row || !userId) return null;
  return {
    userId,
    ...(stringValue(row.orgId) ? { orgId: stringValue(row.orgId) } : {}),
    ...(stringValue(row.subscription_status) ? { subscriptionStatus: stringValue(row.subscription_status) } : {}),
    ...(stringValue(row.lastActiveAt) ? { lastActiveAt: stringValue(row.lastActiveAt) } : {}),
    ...(stringValue(row.lastLoginTime) ? { lastLoginTime: stringValue(row.lastLoginTime) } : {}),
  };
}

function sameAuthorizedAccount(
  ownerUserId: string,
  owner: ReturnType<typeof normalizeUser>,
  candidate: ReturnType<typeof normalizeUser>,
): boolean {
  if (!candidate) return false;
  if (candidate.userId === ownerUserId) return true;
  return !!owner?.orgId && !!candidate.orgId && owner.orgId === candidate.orgId;
}

function normalizeLead(value: unknown, fallbackListId: string): AskCrmLead | null {
  const row = record(value);
  if (!row) return null;
  const leadId = stringValue(row.leadId);
  const listId = stringValue(row.listId) ?? fallbackListId;
  if (!leadId || !listId) return null;

  const lifecycle = stringValue(row.lifecycle) as AskCrmLead['lifecycle'];
  const contactStatus = stringValue(row.contactStatus) as AskCrmLead['contactStatus'];
  const subscriptionState = stringValue(row.subscriptionState) as AskCrmLead['subscriptionState'];

  return {
    leadId,
    listId,
    email: nullableString(row.email),
    phone: nullableString(row.phone),
    firstName: nullableString(row.firstName),
    lastName: nullableString(row.lastName),
    company: nullableString(row.company),
    title: nullableString(row.title),
    status: nullableString(row.status),
    dealValue: numberValue(row.dealValue),
    lifecycle: lifecycle ?? null,
    heatScore: numberValue(row.heatScore),
    healthScore: numberValue(row.healthScore),
    isICP: booleanValue(row.isICP),
    lastEngagementAt: nullableString(row.lastEngagementAt),
    hasUserRecord: booleanValue(row.hasUserRecord),
    hasActiveSubscription: booleanValue(row.hasActiveSubscription),
    subscriptionState: subscriptionState ?? null,
    lastActivityAt: nullableString(row.lastActivityAt),
    lastUsageAt: nullableString(row.lastUsageAt),
    openDealStages: openStages(row.openDealStages).length ? openStages(row.openDealStages) : null,
    contactStatus: contactStatus ?? null,
  };
}

async function lookupUsers(
  emails: string[],
  deps: AskCrmLeadLoaderDeps,
): Promise<Map<string, ReturnType<typeof normalizeUser>>> {
  const result = new Map<string, ReturnType<typeof normalizeUser>>();
  // getUserByEmail resolves to undefined for an ordinary "no matching account" —
  // this .catch only fires on a genuine failure (DB/network), so logging it is
  // meaningful, not noise from the common not-found case. One summary line per
  // batch, not per email: a sustained outage would otherwise flood the log.
  let failures = 0;
  for (let offset = 0; offset < emails.length; offset += USER_LOOKUP_BATCH) {
    const chunk = emails.slice(offset, offset + USER_LOOKUP_BATCH);
    const users = await Promise.all(
      chunk.map((email) => deps.getUserByEmail(email).catch(() => { failures++; return null; })),
    );
    chunk.forEach((email, index) => result.set(email, normalizeUser(users[index])));
  }
  if (failures > 0) {
    console.warn(`[askCrmLeadLoader] ${failures}/${emails.length} getUserByEmail lookups failed — those leads fall back to stored signals only`);
  }
  return result;
}

export function createAskCrmLeadLoader(deps: AskCrmLeadLoaderDeps) {
  return async (userId: string, opts: { limit: number }): Promise<AskCrmLead[]> => {
    // Clamped here, not just trusted from the caller: USER_LOOKUP_BUDGET also
    // bounds the user-lookup step below (uniqueEmails.slice), so a caller that
    // ever passes a larger limit than this would otherwise load MORE leads
    // than can be enriched, with no signal on which ones silently fell back to
    // stored-only data. This loader is exported precisely so that invariant
    // can't drift per-caller (see USER_LOOKUP_BUDGET's own comment) — so it
    // has to hold here, not only in today's one caller (emma/tools.ts).
    const limit = Math.min(opts.limit, USER_LOOKUP_BUDGET);
    const rawLists = await deps.getLeadListsForUser(userId);
    const lists = excludeSessionLists(
      Array.isArray(rawLists)
        ? rawLists.map(record).filter((item): item is Row => item !== null)
        : [],
    );

    const leads: AskCrmLead[] = [];
    for (const list of lists) {
      if (leads.length >= limit) break;
      const listId = stringValue(list.listId);
      if (!listId) continue;
      const page = record(await deps.getLeadsByListId(
        listId,
        Math.min(limit - leads.length, 200),
      ));
      const items = Array.isArray(page?.items) ? page!.items : [];
      for (const item of items) {
        const lead = normalizeLead(item, listId);
        if (lead) leads.push(lead);
        if (leads.length >= limit) break;
      }
    }

    const [ownerRaw, dealsRaw] = await Promise.all([
      deps.getUserById(userId).catch((err) => {
        console.warn(`[askCrmLeadLoader] getUserById(${userId}) failed — authorization check will reject every candidate account:`, err);
        return null;
      }),
      deps.getDealsByOwner(userId, { limit: DEAL_LOOKUP_LIMIT }).catch((err) => {
        console.warn(`[askCrmLeadLoader] getDealsByOwner(${userId}) failed — falling back to stored openDealStages only:`, err);
        return null;
      }),
    ]);
    const owner = normalizeUser(ownerRaw);

    // Bounded query => positive evidence only. Never synthesize [] for a lead
    // merely because its deal was not present in this page.
    const liveOpenStages = new Map<string, string[]>();
    if (Array.isArray(dealsRaw)) {
      for (const rawDeal of dealsRaw) {
        const deal = record(rawDeal);
        const stage = deal && stringValue(deal.stage);
        if (!deal || !stage || ['won', 'lost'].includes(stage.toLowerCase())) continue;
        const contactIds = [
          stringValue(deal.primaryContactId),
          ...(Array.isArray(deal.contactIds) ? deal.contactIds.map(stringValue) : []),
        ].filter((id): id is string => Boolean(id));
        for (const contactId of new Set(contactIds)) {
          const stages = liveOpenStages.get(contactId) ?? [];
          if (!stages.includes(stage)) stages.push(stage);
          liveOpenStages.set(contactId, stages);
        }
      }
    }

    const uniqueEmails = [...new Set(
      leads.map((lead) => normalizedEmail(lead.email)).filter((email): email is string => Boolean(email)),
    )].slice(0, USER_LOOKUP_BUDGET);
    const usersByEmail = await lookupUsers(uniqueEmails, deps);

    return leads.map((lead) => {
      const email = normalizedEmail(lead.email);
      const candidate = email ? usersByEmail.get(email) ?? null : null;
      const user = sameAuthorizedAccount(userId, owner, candidate) ? candidate : null;
      const subscriptionState = user
        ? mapSubscriptionState(user.subscriptionStatus)
        : lead.subscriptionState;
      const storedOpen = openStages(lead.openDealStages);
      const liveOpen = liveOpenStages.get(lead.leadId) ?? [];
      const mergedOpen = [...new Set([...storedOpen, ...liveOpen])];

      return {
        ...lead,
        ...(user
          ? {
              hasUserRecord: true,
              hasActiveSubscription: subscriptionState === 'active' || subscriptionState === 'trialing',
              subscriptionState,
              lastActivityAt: pickLatestTimestamp(
                lead.lastActivityAt,
                user.lastActiveAt,
                user.lastLoginTime,
              ),
            }
          : {}),
        openDealStages: mergedOpen.length ? mergedOpen : lead.openDealStages,
        liveOpenDealStages: liveOpen.length ? liveOpen : null,
      };
    });
  };
}
