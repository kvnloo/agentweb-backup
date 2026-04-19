/**
 * ask_crm orchestrator service (G1)
 *
 * Takes a free-form question from the user, synthesises a structured answer
 * drawing on heat scores, lifecycle state, and open deals. Returns a compact
 * response object that Emma can narrate.
 *
 * This service is the orchestrator layer behind Emma's ask_crm tool. It does
 * not invoke an LLM — it assembles deterministic signals; the LLM (Emma)
 * decides how to phrase the answer.
 *
 * All data access is dependency-injected for testability. In production the
 * tool wires up crmDb + lead iteration.
 */

import { computeHeatScore, HeatScoreSignals } from './heatScoreService';
import { computeLifecycle, LifecycleSignals, LifecycleStage } from './lifecycleService';

/** Minimal shape we need from a Lead row for CRM answers. */
export interface AskCrmLead {
  leadId: string;
  listId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  status?: string | null;
  dealValue?: number | null;
  lifecycle?: LifecycleStage | null;
  heatScore?: number | null;
  healthScore?: number | null;
  isICP?: boolean | null;
  lastEngagementAt?: string | null;
  hasUserRecord?: boolean | null;
  hasActiveSubscription?: boolean | null;
  subscriptionState?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none' | null;
  lastActivityAt?: string | null;
  lastUsageAt?: string | null;
  openDealStages?: string[] | null;
  contactStatus?: 'active' | 'do-not-contact' | 'unsubscribed' | null;
  primaryPOCName?: string | null;
}

export interface AskCrmDeps {
  /** Stream or page through the user's leads. Callers cap to a reasonable window. */
  loadLeadsForUser: (userId: string, opts: { limit: number }) => Promise<AskCrmLead[]>;
  /** Clock. */
  now?: () => Date;
}

export type AskCrmIntent =
  | 'hot_leads'
  | 'at_risk'
  | 'deals_closing'
  | 'paying_customers'
  | 'specific_contact'
  | 'unknown';

export interface AskCrmAnswerItem {
  leadId: string;
  listId: string;
  name: string;
  company: string | null;
  email: string | null;
  status: string | null;
  lifecycle: LifecycleStage;
  heatScore: number;
  dealValue: number | null;
  lastEngagementAt: string | null;
  citationUrl: string;
}

export interface AskCrmAnswer {
  intent: AskCrmIntent;
  summary: string;
  items: AskCrmAnswerItem[];
  totalConsidered: number;
}

/**
 * Heuristic intent classifier. Keep simple — LLM will handle the fuzzy cases,
 * we just need to pick the right shape of data to load.
 */
export function classifyIntent(question: string): AskCrmIntent {
  const q = question.toLowerCase().trim();
  if (!q) return 'unknown';

  // at_risk first so "who is at risk" doesn't collide with the specific_contact
  // regex ("is … at …").
  if (/\b(at.?risk|risk|churn|cancel|cancelled|canceled|leaving)\b/.test(q)) {
    return 'at_risk';
  }

  // "Is jane at acme paying us?" — explicit name mention. Check before the
  // paying_customers regex so a proper-noun question doesn't get routed to
  // the aggregate paying-customers list.
  if (/\b(is|does|has|show|find|look up)\b.+\b(at|from|with|of|@)\b/.test(q)) {
    return 'specific_contact';
  }

  if (/\b(paying|pays|paid|subscribed|customer|mrr|revenue)\b/.test(q)) {
    return 'paying_customers';
  }

  if (/\b(deal|close|closing|pipeline|won|pipeline|close date)\b/.test(q)) {
    return 'deals_closing';
  }

  if (/\b(hot|reach out|top|prospects?|best|today|follow.?up|outreach|warm|priority)\b/.test(q)) {
    return 'hot_leads';
  }

  // Fall through — "who should I reach out to" — default to hot_leads.
  return 'hot_leads';
}

function fullName(lead: AskCrmLead): string {
  const parts = [lead.firstName, lead.lastName].filter(Boolean);
  return parts.join(' ').trim() || lead.email || '(unnamed)';
}

function toItem(lead: AskCrmLead, heatScore: number, lifecycle: LifecycleStage): AskCrmAnswerItem {
  return {
    leadId: lead.leadId,
    listId: lead.listId,
    name: fullName(lead),
    company: lead.company || null,
    email: lead.email || null,
    status: lead.status || null,
    lifecycle,
    heatScore,
    dealValue: lead.dealValue || null,
    lastEngagementAt: lead.lastEngagementAt || null,
    citationUrl: `/crm/lists/${encodeURIComponent(lead.listId)}/leads/${encodeURIComponent(lead.leadId)}`,
  };
}

/** Compute heat + lifecycle for one lead, preferring stored values when present. */
function deriveScores(lead: AskCrmLead, now: Date): { heat: number; lifecycle: LifecycleStage } {
  const heat = typeof lead.heatScore === 'number'
    ? lead.heatScore
    : computeHeatScore(
        {
          hasUserRecord: lead.hasUserRecord ?? undefined,
          hasActiveSubscription: lead.hasActiveSubscription ?? undefined,
          status: lead.status ?? undefined,
          openDealStages: lead.openDealStages ?? undefined,
          lastEngagementAt: lead.lastEngagementAt ?? undefined,
          isICP: lead.isICP ?? undefined,
          contactStatus: lead.contactStatus ?? undefined,
        } as HeatScoreSignals,
        now
      );

  const lifecycle = lead.lifecycle ?? computeLifecycle(
    {
      email: lead.email ?? undefined,
      hasUserRecord: lead.hasUserRecord ?? undefined,
      subscriptionState: lead.subscriptionState ?? undefined,
      lastActivityAt: lead.lastActivityAt ?? undefined,
      lastUsageAt: lead.lastUsageAt ?? undefined,
      healthScore: lead.healthScore ?? undefined,
      openDealStages: lead.openDealStages ?? undefined,
    } as LifecycleSignals,
    now
  );

  return { heat, lifecycle };
}

export interface AskCrmOptions {
  /** Max leads to load from the user. Default 500 — enough for founders@agentweb.pro. */
  loadLimit?: number;
  /** Max items in the returned list. Default 10. */
  resultLimit?: number;
}

/** Main entry point. */
export async function askCrm(
  question: string,
  userId: string,
  deps: AskCrmDeps,
  opts: AskCrmOptions = {}
): Promise<AskCrmAnswer> {
  const intent = classifyIntent(question);
  const resultLimit = opts.resultLimit ?? 10;
  const loadLimit = opts.loadLimit ?? 500;
  const now = deps.now ? deps.now() : new Date();

  const leads = await deps.loadLeadsForUser(userId, { limit: loadLimit });
  const enriched = leads.map(lead => ({ lead, ...deriveScores(lead, now) }));

  let filtered = enriched;
  let summary = '';

  switch (intent) {
    case 'hot_leads': {
      filtered = enriched
        .filter(e => e.lifecycle !== 'churned' && (e.lead.contactStatus || 'active') === 'active')
        .sort((a, b) => b.heat - a.heat);
      summary = `Top ${Math.min(resultLimit, filtered.length)} prospects ranked by heat score.`;
      break;
    }
    case 'at_risk': {
      filtered = enriched
        .filter(e => e.lifecycle === 'at_risk')
        .sort((a, b) => (a.lead.healthScore ?? 100) - (b.lead.healthScore ?? 100));
      summary = `${filtered.length} at-risk customers, sorted by health score (lowest first).`;
      break;
    }
    case 'deals_closing': {
      filtered = enriched
        .filter(e => e.lifecycle === 'in_deal')
        .sort((a, b) => (b.lead.dealValue ?? 0) - (a.lead.dealValue ?? 0));
      summary = `${filtered.length} open deals, sorted by deal value.`;
      break;
    }
    case 'paying_customers': {
      filtered = enriched
        .filter(e => e.lifecycle === 'paying' || e.lifecycle === 'trialing');
      summary = `${filtered.length} paying + trialing customers.`;
      break;
    }
    case 'specific_contact': {
      const qLower = question.toLowerCase();
      filtered = enriched.filter(e => {
        const hay = [
          e.lead.email,
          e.lead.firstName,
          e.lead.lastName,
          e.lead.company,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        // Very loose — if any named token from the question hits the haystack.
        const tokens = qLower.split(/\s+/).filter(t => t.length > 2 && !/^(the|who|is|at|does|has|show)$/.test(t));
        return tokens.some(t => hay.includes(t));
      });
      summary = filtered.length === 0
        ? 'No contacts matched the question.'
        : `${filtered.length} contact(s) matched.`;
      break;
    }
    default: {
      summary = 'Unable to classify the question — showing a generic heat-ranked list.';
      filtered = enriched.sort((a, b) => b.heat - a.heat);
    }
  }

  const items = filtered
    .slice(0, resultLimit)
    .map(e => toItem(e.lead, e.heat, e.lifecycle));

  return {
    intent,
    summary,
    items,
    totalConsidered: enriched.length,
  };
}
