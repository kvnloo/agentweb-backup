/**
 * ENG-926 §C — CRM → Meta event relay.
 *
 * The card's missing return path. Today conversion data flows Meta → us and stops at the
 * initial `Lead` (routes/webhooks.ts) plus `Schedule` for a Calendly booking
 * (routes/calendlyWebhook.ts). Nothing ever tells Meta what BECAME of that lead, so Meta
 * optimizes toward form fills rather than revenue — it cannot distinguish a tyre-kicker
 * from a closed deal. This relays the two transitions that carry that information:
 * `qualified`, and closed-won as a `Purchase` with real value.
 *
 * The card's own "Blocker / dependency" field is stale and worth correcting here rather
 * than leaving for the next reader to re-derive: it says §C needs per-account dataset ids
 * plus system-user access tokens and that "there is no current connector." There is —
 * `metaAccountCredentials.getMetaAccountCredentials` resolves per-ad-account credentials
 * off the customer's own connected OAuth entry, with inline token refresh. The system-user
 * token was the Haven-era bespoke pattern (HAVEN_META_CAPI_TOKEN), superseded by the
 * platform path this module reuses.
 *
 * Two properties matter more than the mapping:
 *
 *   1. FIRE-ONCE. `event_id` is deterministic — sha256(leadId:eventName), never a
 *      timestamp — and the lead persists which events it has already sent. A lead moving
 *      won → lost → won must not double-count a Purchase. The deterministic id means even
 *      a lost race between two concurrent writers resolves at Meta's end via §E's dedup
 *      contract instead of double-counting.
 *
 *   2. NEVER FAIL-CLOSED. Every failure path here returns rather than throws, and the
 *      caller runs it fire-and-forget. An unresolved pixel, a missing dealValue, an
 *      expired token or a Meta-side rejection must never affect the lead write that
 *      already succeeded. Failing closed on missing attribution is precisely the original
 *      RankAI silent-undercounting bug this whole card exists to fix.
 */

import * as crypto from 'crypto';
import { isSmokeTestEmail } from '../utils/smokeTestLead';

export type LeadStatusType = 'active' | 'won' | 'lost' | 'churned';

export interface LeadStatusConfigEntry {
  value: string;
  label: string;
  color: string;
  type: LeadStatusType;
}

/** Meta's `Purchase` is standard; `QualifiedLead` is deliberately custom — Meta has no
 *  standard event that honestly means MQL, and reusing e.g. `SubmitApplication` would
 *  pollute a name Meta's models already hold priors on. */
export const META_PURCHASE_EVENT = 'Purchase';
export const META_QUALIFIED_EVENT = 'QualifiedLead';

/** Mirrors the platform default in db.ts's createLeadList, for lists created before
 *  statusConfig existed (or created without one). Kept in sync deliberately: a list with
 *  no config still has statuses, and treating it as "no conversions possible" would
 *  silently relay nothing for exactly the oldest accounts. */
const DEFAULT_LEAD_STATUS_CONFIG: LeadStatusConfigEntry[] = [
  { value: 'new', label: 'New', color: 'gray', type: 'active' },
  { value: 'contacted', label: 'Contacted', color: 'blue', type: 'active' },
  { value: 'qualified', label: 'Qualified', color: 'indigo', type: 'active' },
  { value: 'proposal_sent', label: 'Proposal Sent', color: 'purple', type: 'active' },
  { value: 'negotiating', label: 'Negotiating', color: 'yellow', type: 'active' },
  { value: 'won', label: 'Won', color: 'green', type: 'won' },
  { value: 'lost', label: 'Lost', color: 'red', type: 'lost' },
  { value: 'churned', label: 'Churned', color: 'orange', type: 'churned' },
];

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';

/**
 * Which Meta event, if any, a status represents.
 *
 * Closed-won is resolved by the entry's `type`, never by its `value` — customers rename
 * statuses ("Deal Closed!", "Signed"), and matching on the literal string would silently
 * stop relaying revenue the moment someone edits a label.
 *
 * `qualified` has no such type to key off (it is `active`, like every other mid-funnel
 * status), so it IS matched by name against value and label. Accepted limitation, stated
 * plainly: a customer who renames "Qualified" to something else stops emitting
 * QualifiedLead. That is the safe direction to fail — the alternative is guessing at
 * which mid-funnel status means MQL and firing conversions the customer never asked for.
 */
export function mapStatusToMetaEvent(
  statusConfig: LeadStatusConfigEntry[] | undefined | null,
  status: string | undefined | null,
): { eventName: string; isValueEvent: boolean } | null {
  const wanted = normalize(status);
  if (!wanted) return null;

  const config = statusConfig && statusConfig.length > 0 ? statusConfig : DEFAULT_LEAD_STATUS_CONFIG;
  const entry = config.find((e) => normalize(e.value) === wanted);
  if (!entry) return null;

  if (entry.type === 'won') {
    return { eventName: META_PURCHASE_EVENT, isValueEvent: true };
  }
  if (normalize(entry.value) === 'qualified' || normalize(entry.label) === 'qualified') {
    return { eventName: META_QUALIFIED_EVENT, isValueEvent: false };
  }
  return null;
}

/**
 * Deterministic per (lead, event). Deliberately carries no timestamp and no nonce: a retry
 * — whether ours or a duplicate transition — must produce the SAME id so Meta collapses it
 * under §E's dedup contract rather than counting it twice.
 */
export function buildRelayEventId(leadId: string, eventName: string): string {
  return crypto.createHash('sha256').update(`${leadId}:${eventName}`).digest('hex');
}

/**
 * Rebuild Meta's `fbc` from the fbclid stored on the lead's first touch.
 *
 * At form-capture time `fbc` arrives as a browser cookie (routes/webhooks.ts) and is used
 * immediately, never persisted — so by the time a deal closes weeks later the cookie is
 * long gone. What IS persisted is `firstTouch.clickIds.fbclid`, and Meta's `fbc` is a
 * documented deterministic encoding of exactly that: `fb.1.<creation-unix-ms>.<fbclid>`.
 * The subdomain index is 1 because these are first-party cookies set on the lander's own
 * domain, and the creation time is the touch itself — the moment the click landed.
 *
 * Returns undefined when there is no fbclid: an organic or direct lead genuinely has no
 * click to attribute, and inventing one would be worse than sending none.
 */
export function buildFbcFromFirstTouch(firstTouch: any): string | undefined {
  const fbclid = firstTouch?.clickIds?.fbclid;
  if (typeof fbclid !== 'string' || !fbclid) return undefined;

  const parsed = Date.parse(firstTouch?.timestamp ?? '');
  const creationMs = Number.isFinite(parsed) ? parsed : Date.now();
  return `fb.1.${creationMs}.${fbclid}`;
}

export interface RelayDeps {
  getUserById: (userId: string) => Promise<any>;
  resolvePixel: (
    owner: any,
    userId: string,
    stored?: { pixelId: string; accountId: string },
  ) => Promise<{ pixelId: string; accountId: string } | { unresolved: true; reason: string }>;
  getCredentials: (
    owner: any,
    userId: string,
    accountId: string,
  ) => Promise<{ accountId: string; accessToken: string; accountName: string; currency?: string }>;
  sendEvent: (
    pixelId: string,
    accessToken: string,
    event: Record<string, any>,
  ) => Promise<{ success: true; fbtraceId?: string; usage?: any } | { success: false; error: string; usage?: any }>;
  recordSent: (listId: string, leadId: string, eventNames: string[]) => Promise<void>;
  shouldAttemptSend: (listId: string) => boolean;
  isAccountPaused: (accountId: string) => boolean;
  recordUsage?: (accountId: string, usage?: any) => void;
}

export interface RelayContext {
  listId: string;
  userId: string;
  lead: Record<string, any>;
  previousStatus?: string | null;
  statusConfig?: LeadStatusConfigEntry[] | null;
}

export type RelayResult =
  | { sent: true; eventName: string; eventId: string }
  | { skipped: true; reason: string }
  | { failed: true; error: string };

/** Lazily-bound production dependencies. Every Meta import is dynamic: this module is
 *  reached from db.ts, and a static import chain into metaService would be circular
 *  (metaTokenRefresh already imports metaService). Same pattern metaService itself uses
 *  to reach metaAccountCredentials. */
async function defaultDeps(): Promise<RelayDeps> {
  const { userDb, crmDb } = await import('./db');
  const { metaService } = await import('./metaService');
  const { getMetaAccountCredentials, getConnectedMetaAccountsList } = await import('./metaAccountCredentials');
  const { shouldAttemptCapiSend, isCapiAccountPaused, recordCapiUsage } = await import('./capiSendBudget');

  return {
    getUserById: (userId) => userDb.getUserById(userId),
    resolvePixel: (owner, userId, stored) => metaService.resolveMetaPixelWithDefault(owner, userId, stored),
    getCredentials: async (owner, userId, accountId) => {
      const creds = await getMetaAccountCredentials(owner, userId, accountId);
      // getMetaAccountCredentials deliberately returns only what a Graph call needs, so
      // the ad account's own currency comes from the connection list instead. Without it
      // every non-USD customer's Purchase would be reported in the wrong denomination —
      // silently, since Meta accepts whatever currency it is told.
      const currency = getConnectedMetaAccountsList(owner).find(
        (a: any) => a.accountId === creds.accountId,
      )?.currency;
      return { ...creds, currency };
    },
    sendEvent: (pixelId, accessToken, event) => metaService.sendCapiLeadEvent(pixelId, accessToken, event as any),
    recordSent: async (listId, leadId, eventNames) => {
      await crmDb.updateLead(listId, leadId, {
        metaConversionsSent: eventNames,
        // Must not recurse: this write is itself an updateLead, and without the
        // suppression flag recording a Purchase would re-enter the relay.
        suppressConversionRelay: true,
        skipFieldNamesUpdate: true,
      } as any);
    },
    shouldAttemptSend: shouldAttemptCapiSend,
    isAccountPaused: isCapiAccountPaused,
    recordUsage: recordCapiUsage,
  };
}

/**
 * Relay one lead status transition to Meta. Never throws.
 *
 * Every skip below is an EXPECTED outcome, logged as such — not an error. Treating "this
 * customer has no Meta account connected" as a failure would bury the real failures in
 * noise, which is how ENG-926's original incident stayed invisible for three weeks.
 */
export async function relayLeadStatusEvent(
  ctx: RelayContext,
  deps?: RelayDeps,
): Promise<RelayResult> {
  const d = deps ?? (await defaultDeps());
  const { listId, userId, lead } = ctx;
  const leadId = lead?.leadId;

  // A skip that reaches here AFTER the status mapped to a real conversion event is worth
  // saying out loud. This card exists because a tracking failure was "silent by
  // construction" — a suppressed Purchase that logs nothing is the same shape of problem,
  // and it also makes the suppression untestable from outside (no log line is
  // indistinguishable from the relay never running). Transitions that never mapped to an
  // event at all stay quiet: every lead moving new -> contacted would otherwise be noise.
  const skip = (reason: string, mapped: boolean): RelayResult => {
    if (mapped) {
      console.log(`[CAPI Relay] skipped for lead ${leadId} (list ${listId}): ${reason}`);
    }
    return { skipped: true, reason };
  };

  try {
    if (!leadId) return { skipped: true, reason: 'lead has no leadId' };

    const mapped = mapStatusToMetaEvent(ctx.statusConfig ?? undefined, lead.status);
    if (!mapped) return skip(`status "${lead.status}" is not a conversion transition`, false);

    // §B's opt-out, honored here rather than waiting for the consent field: contactStatus
    // already carries a lead's explicit decline, and firing a CAPI conversion for someone
    // who opted out is the compliance problem the card names.
    const contactStatus = normalize(lead.contactStatus);
    if (contactStatus === 'unsubscribed' || contactStatus === 'do_not_contact') {
      return skip(`lead opted out (contactStatus=${lead.contactStatus})`, true);
    }

    // Never pollute a real ad account with the automated smoke test's synthetic lead —
    // same guard the form-submission path applies (routes/webhooks.ts).
    if (isSmokeTestEmail(lead.email)) {
      return skip('smoke-test lead', true);
    }

    const alreadySent: string[] = Array.isArray(lead.metaConversionsSent) ? lead.metaConversionsSent : [];
    if (alreadySent.includes(mapped.eventName)) {
      return skip(`${mapped.eventName} already sent for this lead`, true);
    }

    if (!d.shouldAttemptSend(listId)) {
      return skip('per-list CAPI send budget exhausted', true);
    }

    const owner = await d.getUserById(userId);
    if (!owner) return skip(`owner ${userId} not found`, true);

    // NOTE — no surface-level opt-out exists for CRM-sourced conversions yet. ENG-1141's
    // `attributionDisabled` is deliberately per-surface and lives on the CALENDLY
    // connection's config (routes/connectedAccounts.ts's calendly/:id/attribution), so it
    // says nothing about this one; there is no equivalent control for the CRM surface.
    // Checking a user-level flag here would be a guard that never fires, which reads as
    // covered and is not. The off switches that DO apply: the per-lead contactStatus
    // opt-out above (the compliance-load-bearing one), and having no Meta ad account
    // connected at all, which resolves as unresolved immediately below.
    const resolution = await d.resolvePixel(owner, userId);
    if ('unresolved' in resolution) {
      return skip(`pixel unresolved: ${resolution.reason}`, true);
    }

    if (d.isAccountPaused(resolution.accountId)) {
      return skip(`ad account ${resolution.accountId} paused by Meta rate limiting`, true);
    }

    const creds = await d.getCredentials(owner, userId, resolution.accountId);

    // Value only rides on the value event. A dealValue on a QualifiedLead would report
    // revenue Meta should not yet attribute.
    const customData = mapped.isValueEvent
      ? {
          ...(typeof lead.dealValue === 'number' ? { value: lead.dealValue } : {}),
          currency: lead.dealCurrency || creds.currency || 'USD',
        }
      : undefined;

    const eventId = buildRelayEventId(leadId, mapped.eventName);
    const result = await d.sendEvent(resolution.pixelId, creds.accessToken, {
      eventId,
      email: lead.email,
      firstName: lead.firstName,
      lastName: lead.lastName,
      phone: lead.phone,
      // No `fbp`: it is a browser cookie read at capture time (routes/webhooks.ts) and is
      // never persisted on the lead, so there is nothing truthful to send here. `fbc` IS
      // recoverable — it is a deterministic encoding of the stored fbclid — and is worth
      // reconstructing, since a click ID is the single strongest match signal Meta has.
      fbc: buildFbcFromFirstTouch(lead.firstTouch),
      sourceUrl: lead.firstTouch?.landingUrl,
      eventName: mapped.eventName,
      ...(customData ? { customData } : {}),
    });

    d.recordUsage?.(resolution.accountId, (result as any).usage);

    if (!result.success) {
      // Deliberately NOT recorded as sent — a soft Meta failure must stay retryable, the
      // exact gap Greptile caught on the Calendly path (#2291) where a swallowed failure
      // marked the job complete and lost the event permanently.
      console.error(
        `[CAPI Relay] ${mapped.eventName} failed for lead ${leadId} (list ${listId}): ${result.error}`,
      );
      return { failed: true, error: result.error };
    }

    console.log(
      `[CAPI Relay] ${mapped.eventName} sent for lead ${leadId} (list ${listId}, ` +
      `pixel ${resolution.pixelId}, fbtrace_id=${result.fbtraceId ?? 'n/a'})`,
    );

    try {
      await d.recordSent(listId, leadId, [...alreadySent, mapped.eventName]);
    } catch (error: any) {
      // The send already happened and Meta has it. Losing the bookkeeping write means a
      // later transition could re-attempt — which the deterministic event_id makes safe,
      // so this is logged, not escalated.
      console.error(
        `[CAPI Relay] ${mapped.eventName} sent for lead ${leadId} but recording it failed: ${error?.message}`,
      );
    }

    return { sent: true, eventName: mapped.eventName, eventId };
  } catch (error: any) {
    console.error(`[CAPI Relay] threw for lead ${leadId} (list ${listId}): ${error?.message}`);
    return { failed: true, error: error?.message || 'Unknown error relaying conversion' };
  }
}
