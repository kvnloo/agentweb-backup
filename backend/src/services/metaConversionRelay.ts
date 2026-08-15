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
/** Closed-won whose value we cannot state. Meta REJECTS a Purchase with no currency —
 *  "Missing Currency for Purchase Event", verified against Graph v25 — so a deal with no
 *  usable currency cannot be a Purchase at all. A custom event carries the conversion
 *  honestly: Meta learns this lead closed, and no revenue figure is invented. Custom events
 *  have no required custom_data, also verified. */
export const META_WON_NO_VALUE_EVENT = 'CRMWonDeal';

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
export type ConversionKind = 'won' | 'qualified';

/**
 * `conversionKind` is the stable identity of the conversion; the Meta event NAME is chosen
 * later, because a closed-won becomes either `Purchase` or `CRMWonDeal` depending on whether
 * its value can be stated. Fire-once keys off the kind, never the name — otherwise a deal
 * that fired `CRMWonDeal` while its currency was missing would fire `Purchase` all over
 * again once someone filled the currency in, double-counting one deal under two names.
 */
export function mapStatusToMetaEvent(
  statusConfig: LeadStatusConfigEntry[] | undefined | null,
  status: string | undefined | null,
): { conversionKind: ConversionKind; isValueEvent: boolean } | null {
  const wanted = normalize(status);
  if (!wanted) return null;

  const config = statusConfig && statusConfig.length > 0 ? statusConfig : DEFAULT_LEAD_STATUS_CONFIG;
  const entry = config.find((e) => normalize(e.value) === wanted);
  if (!entry) return null;

  if (entry.type === 'won') {
    return { conversionKind: 'won', isValueEvent: true };
  }
  if (normalize(entry.value) === 'qualified' || normalize(entry.label) === 'qualified') {
    return { conversionKind: 'qualified', isValueEvent: false };
  }
  return null;
}

/** The Meta event name for a conversion, given whether its value could be stated. */
export function resolveEventName(
  conversionKind: ConversionKind,
  hasValue: boolean,
): string {
  if (conversionKind !== 'won') return META_QUALIFIED_EVENT;
  return hasValue ? META_PURCHASE_EVENT : META_WON_NO_VALUE_EVENT;
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

/**
 * Whether the CRM → Meta relay is switched on for this account.
 *
 * DEFAULT OFF, deliberately. Without a gate, merging this turns on a new behaviour for
 * every customer with Meta connected at once: deal values start flowing to Meta, and
 * `Purchase` events land in the same stream their existing campaign optimisation reads,
 * with nobody having asked for either. That is a consent problem, not a code problem, and
 * no amount of correctness fixes it.
 *
 * Two ways to switch on, checked in order:
 *   - `connected_accounts[].config.crmConversionRelayEnabled` on the owner's Meta ad
 *     account — the real, per-customer opt-in. The portal control that sets it is a
 *     follow-up PR; the field is read here so the engine is ready for it.
 *   - `META_CONVERSION_RELAY_ENABLED=true` — an environment-wide override, so a test
 *     environment can exercise the path end to end without a portal.
 *
 * Anything else, including a missing field, means off.
 */
export function isConversionRelayEnabled(owner: any): boolean {
  if (process.env.META_CONVERSION_RELAY_ENABLED === 'true') return true;

  const accounts = Array.isArray(owner?.connected_accounts) ? owner.connected_accounts : [];
  return accounts.some(
    (acc: any) =>
      (acc?.platform === 'facebook' || acc?.platform === 'meta') &&
      acc?.config?.account_type === 'ad_account' &&
      acc?.config?.crmConversionRelayEnabled === true,
  );
}

export interface RelayDeps {
  getUserById: (userId: string) => Promise<any>;
  resolvePixel: (
    owner: any,
    userId: string,
    stored?: { pixelId: string; accountId: string },
  ) => Promise<
    | { pixelId: string; accountId: string }
    | { unresolved: true; reason: string; transient?: boolean }
  >;
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
  /** Atomic single-event append. Takes ONE event, not the whole array: handing it a list
   *  would reintroduce the read-modify-write race it exists to remove. */
  recordSent: (listId: string, leadId: string, eventName: string) => Promise<void>;
  /** Release a pending marker whose conversion is settled and will never be sent. */
  clearPending?: (listId: string, leadId: string, conversionKind: string) => Promise<void>;
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
  /** The conversion recorded when the transition actually happened, carried through the
   *  queue so a retry honours THAT rather than re-deriving one from whatever the lead's
   *  status says now. Absent on the first, inline attempt, where current state is the
   *  transition. See processConversionRelayJob for why this matters. */
  conversionKind?: ConversionKind;
}

export type RelayResult =
  | { sent: true; eventName: string; eventId: string }
  /** `retryable` separates a skip that is terminal (the lead opted out, the event already
   *  went, this status is not a conversion) from one that is purely temporal — the send
   *  budget is exhausted, or Meta has throttled this ad account. Collapsing the two is how
   *  a throttled Purchase gets silently dropped forever: the status never changes again,
   *  so nothing ever re-dispatches it (Greptile P1 on #2412). */
  | { skipped: true; reason: string; retryable: boolean; settled?: boolean }
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
    recordSent: (listId, leadId, eventName) => crmDb.appendMetaConversionSent(listId, leadId, eventName),
    clearPending: (listId, leadId, kind) => crmDb.clearConversionRelayPending(listId, leadId, kind),
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
/**
 * The monetary payload for a value event, or undefined when we cannot state it truthfully.
 *
 * Requires an explicit `dealCurrency` on the lead. Inferring one from the ad account is the
 * tempting shortcut and is exactly how a USD deal gets reported in INR — silently, because
 * Meta validates the currency CODE but has no way to know the number was denominated in
 * something else.
 */
export function buildConversionValue(
  lead: Record<string, any>,
  listId?: string,
): { value: number; currency: string } | undefined {
  if (typeof lead?.dealValue !== 'number' || !Number.isFinite(lead.dealValue)) return undefined;

  const currency = typeof lead?.dealCurrency === 'string' ? lead.dealCurrency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    console.log(
      `[CAPI Relay] lead ${lead?.leadId}${listId ? ` (list ${listId})` : ''} has dealValue ` +
      `${lead.dealValue} but no valid dealCurrency — sending the conversion WITHOUT a value ` +
      `rather than guessing a denomination`,
    );
    return undefined;
  }

  return { value: lead.dealValue, currency };
}

export async function relayLeadStatusEvent(
  ctx: RelayContext,
  deps?: RelayDeps,
): Promise<RelayResult> {
  const d = deps ?? (await defaultDeps());
  const { listId, userId, lead } = ctx;
  const leadId = lead?.leadId;
  // Whatever kind this call is about — the queued/marker one when supplied, else whatever
  // the current status maps to. Used only to release a marker on a settled skip.
  const ctxKindForClear =
    ctx.conversionKind ??
    mapStatusToMetaEvent(ctx.statusConfig ?? undefined, lead?.status)?.conversionKind ??
    '';

  // A skip that reaches here AFTER the status mapped to a real conversion event is worth
  // saying out loud. This card exists because a tracking failure was "silent by
  // construction" — a suppressed Purchase that logs nothing is the same shape of problem,
  // and it also makes the suppression untestable from outside (no log line is
  // indistinguishable from the relay never running). Transitions that never mapped to an
  // event at all stay quiet: every lead moving new -> contacted would otherwise be noise.
  /** `settled` marks a skip that resolves the conversion for good — the lead opted out, the
   *  event already went, it was never a conversion. Those must release any pending marker,
   *  or the marker outlives its own reason: the sweep re-finds that lead every tick forever,
   *  spending budget on a conversion that will never be sent and starving the leads behind
   *  it (Greptile P1 on #2412). A skip that is merely NOT-YET (not enabled, no pixel,
   *  throttled) keeps its marker, because it genuinely is still owed. */
  const skip = (
    reason: string,
    mapped: boolean,
    retryable = false,
    settled = false,
  ): RelayResult => {
    if (mapped) {
      console.log(
        `[CAPI Relay] skipped for lead ${leadId} (list ${listId}): ${reason}` +
        (retryable ? ' — will retry' : ''),
      );
    }
    if (settled && leadId) {
      void d.clearPending?.(listId, leadId, ctxKindForClear).catch(() => {});
    }
    return { skipped: true, reason, retryable, settled };
  };

  try {
    if (!leadId) return { skipped: true, reason: 'lead has no leadId', retryable: false };

    // A queued kind is authoritative: the conversion happened when the status changed, and
    // a later edit does not un-happen it. Only fall back to deriving one from current status
    // on the inline first attempt, where they are the same thing.
    const mapped = ctx.conversionKind
      ? { conversionKind: ctx.conversionKind, isValueEvent: ctx.conversionKind === 'won' }
      : mapStatusToMetaEvent(ctx.statusConfig ?? undefined, lead.status);
    if (!mapped) return skip(`status "${lead.status}" is not a conversion transition`, false, false, true);

    // §B's opt-out, honored here rather than waiting for the consent field: contactStatus
    // already carries a lead's explicit decline, and firing a CAPI conversion for someone
    // who opted out is the compliance problem the card names.
    const contactStatus = normalize(lead.contactStatus);
    if (contactStatus === 'unsubscribed' || contactStatus === 'do_not_contact') {
      return skip(`lead opted out (contactStatus=${lead.contactStatus})`, true, false, true);
    }

    // Never pollute a real ad account with the automated smoke test's synthetic lead —
    // same guard the form-submission path applies (routes/webhooks.ts).
    if (isSmokeTestEmail(lead.email)) {
      return skip('smoke-test lead', true, false, true);
    }

    const alreadySent: string[] = Array.isArray(lead.metaConversionsSent) ? lead.metaConversionsSent : [];
    // Keyed on the conversion KIND, not the emitted event name — see mapStatusToMetaEvent.
    if (alreadySent.includes(mapped.conversionKind)) {
      return skip(`${mapped.conversionKind} conversion already sent for this lead`, true, false, true);
    }

    if (!d.shouldAttemptSend(listId)) {
      return skip('per-list CAPI send budget exhausted', true, true);
    }

    const owner = await d.getUserById(userId);
    if (!owner) return skip(`owner ${userId} not found`, true);

    // Checked after the owner is loaded (the opt-in lives on their Meta connection) but
    // before any Meta call, so a customer who has not opted in never has a single event
    // computed against their account, let alone sent.
    if (!isConversionRelayEnabled(owner)) {
      return skip('CRM conversion relay not enabled for this account', true);
    }

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
      // Retry only a transient failure. "No Meta ad account connected" or "no pixels on any
      // connected account" is a configuration fact that five retries cannot change, whereas
      // a Graph 5xx or a token that failed to refresh is exactly the case whose conversion
      // would otherwise be dropped forever (Greptile on #2412, second pass).
      return skip(`pixel unresolved: ${resolution.reason}`, true, resolution.transient === true);
    }

    if (d.isAccountPaused(resolution.accountId)) {
      return skip(`ad account ${resolution.accountId} paused by Meta rate limiting`, true, true);
    }

    const creds = await d.getCredentials(owner, userId, resolution.accountId);

    // Value only rides on the value event. A dealValue on a QualifiedLead would report
    // revenue Meta should not yet attribute.
    //
    // A value is sent ONLY when the lead itself names its currency. Falling back to the ad
    // account's currency looks reasonable and is quietly dangerous: a deal entered as 5,000
    // against an INR-denominated account is reported as ₹5,000, ~80x off, and Meta accepts
    // whatever denomination it is handed without complaint. Nobody would ever notice, and
    // value-based bidding would optimise against fiction. An event with no value is honest
    // and still fully usable for conversion optimisation, so omission beats a confident
    // guess — see buildConversionValue.
    const customData = mapped.isValueEvent ? buildConversionValue(lead, listId) : undefined;

    // Meta REJECTS a Purchase carrying no currency ("Missing Currency for Purchase Event"),
    // so a won deal whose value we cannot state is sent under a custom event name instead
    // of being lost to a rejection. Verified against Graph v25, not inferred.
    const eventName = resolveEventName(mapped.conversionKind, customData !== undefined);

    const eventId = buildRelayEventId(leadId, mapped.conversionKind);
    const result = await d.sendEvent(resolution.pixelId, creds.accessToken, {
      eventId,
      email: lead.email,
      firstName: lead.firstName,
      lastName: lead.lastName,
      phone: lead.phone,
      // Both of Meta's browser ids, recovered rather than lost. `fbp` is now persisted at
      // capture (routes/webhooks.ts) because the cookie itself is long gone by the time a
      // deal closes; `fbc` is reconstructed from the stored fbclid, which is a documented
      // deterministic encoding. Between them they are the strongest match signals Meta has,
      // and a conversion sent without either matches on email alone.
      fbp: typeof lead.metaFbp === 'string' && lead.metaFbp ? lead.metaFbp : undefined,
      fbc: buildFbcFromFirstTouch(lead.firstTouch),
      sourceUrl: lead.firstTouch?.landingUrl,
      eventName,
      // A CRM status change is not a website event — nobody was on a page. Meta validates
      // this field (a bogus value is rejected outright), and 'system_generated' is its
      // documented value for a conversion recorded by a system rather than a browser.
      actionSource: 'system_generated',
      ...(customData ? { customData } : {}),
    });

    d.recordUsage?.(resolution.accountId, (result as any).usage);

    if (!result.success) {
      // Deliberately NOT recorded as sent — a soft Meta failure must stay retryable, the
      // exact gap Greptile caught on the Calendly path (#2291) where a swallowed failure
      // marked the job complete and lost the event permanently.
      console.error(
        `[CAPI Relay] ${eventName} failed for lead ${leadId} (list ${listId}): ${result.error}`,
      );
      return { failed: true, error: result.error };
    }

    console.log(
      `[CAPI Relay] ${eventName} sent for lead ${leadId} (list ${listId}, ` +
      `pixel ${resolution.pixelId}, fbtrace_id=${result.fbtraceId ?? 'n/a'})`,
    );

    try {
      await d.recordSent(listId, leadId, mapped.conversionKind);
    } catch (error: any) {
      // The send already happened and Meta has it. Losing the bookkeeping write means a
      // later transition could re-attempt — which the deterministic event_id makes safe,
      // so this is logged, not escalated.
      console.error(
        `[CAPI Relay] ${eventName} sent for lead ${leadId} but recording it failed: ${error?.message}`,
      );
    }

    return { sent: true, eventName, eventId };
  } catch (error: any) {
    console.error(`[CAPI Relay] threw for lead ${leadId} (list ${listId}): ${error?.message}`);
    return { failed: true, error: error?.message || 'Unknown error relaying conversion' };
  }
}

// ─── Durable dispatch ────────────────────────────────────────────────────────
//
// Greptile P1 on #2412: the original hook was fire-and-forget with no retry, so a relay
// that failed (Meta 5xx, a token that could not refresh) or was skipped for a purely
// temporal reason (send budget exhausted, ad account throttled by Meta) lost that
// conversion permanently. Nothing would ever re-dispatch it, because the only trigger is
// a status CHANGE and a won deal sits at `won` forever.
//
// That is this card's own failure mode reproduced inside the fix for it, so it goes
// through the same durable queue the Calendly CAPI leg already uses (routes/
// calendlyWebhook.ts, itself hardened by a Greptile P1 on #2291): enqueue-and-claim in one
// atomic write, process inline, and on failure mark the job failed so the poller retries
// it with the queue's own backoff and attempt ceiling.

export const RELAY_QUEUE_SOURCE = 'meta_conversion_relay';

export interface ConversionRelayJobPayload {
  listId: string;
  leadId: string;
  userId: string;
  /** The conversion as it was at transition time. Older queued jobs predate this field, so
   *  it is optional and those fall back to deriving from current status. */
  conversionKind?: ConversionKind;
}

/**
 * Re-reads the lead for everything that must reflect CURRENT state — whether they have since
 * opted out, whether the event already went, their current contact details — while taking the
 * conversion itself from the QUEUED payload.
 *
 * That split is deliberate and was got wrong first time round (Greptile on #2412). Deriving
 * the conversion from current status looks safer, but it means a retry after a status edit
 * silently sends nothing and completes the job: the closed-won that genuinely happened is
 * omitted forever. Omission is the exact failure this card exists to eliminate, whereas an
 * over-send is guarded twice — by metaConversionsSent and by Meta's own dedup on a
 * deterministic event_id. The asymmetry decides it.
 */
export async function processConversionRelayJob(payload: ConversionRelayJobPayload): Promise<boolean> {
  const { crmDb } = await import('./db');
  const lead = await crmDb.getLeadById(payload.listId, payload.leadId);
  if (!lead) {
    console.log(`[CAPI Relay] lead ${payload.leadId} no longer exists — dropping queued conversion`);
    return false;
  }
  const list = await crmDb.getLeadListById(payload.listId);

  const result = await relayLeadStatusEvent({
    listId: payload.listId,
    userId: payload.userId,
    lead,
    statusConfig: (list as any)?.statusConfig,
    conversionKind: payload.conversionKind,
  });

  // Throwing is how the queue learns to retry — markJobFailed runs in the caller's catch.
  if ('failed' in result) {
    throw new Error(result.error);
  }
  if ('skipped' in result && result.retryable) {
    throw new Error(result.reason);
  }
  return 'sent' in result;
}

/** Registered at boot (imported for its side effect from app.ts). The poller warns and
 *  leaves a job claimed-but-unprocessed when no processor is registered for its source, so
 *  registering lazily on first dispatch would strand every job queued before the first
 *  transition of a process's life. */
export function registerConversionRelayProcessor(): void {
  // Required lazily to keep this module importable from db.ts without dragging the queue
  // (and its own db dependency) into that import chain.
  const { registerProcessor } = require('./asyncJobQueue');
  // 15 rather than the global default of 5, matching calendly_webhook's reasoning: five
  // quick attempts can be consumed by a single Meta incident, and once they are gone the
  // conversion needs a human to touch the lead again before anything retries it. A wider
  // ceiling outlasts an ordinary outage. It is not a complete answer — a permanently failed
  // job still needs the reconciliation sweep that belongs to §F — but it removes the common
  // case where a brief outage costs a real conversion.
  registerProcessor(RELAY_QUEUE_SOURCE, processConversionRelayJob, {
    maxAttempts: 15,
    // This source's dedupe key is (list, lead, conversion) — reused by design whenever the
    // customer fixes what caused a skip. A finished job must therefore be removed rather
    // than left as 'completed', on the poller path exactly as on the inline one.
    deleteOnComplete: true,
  });
}

/**
 * Entry point used by db.ts's updateLead hook. Enqueues durably, then processes inline so
 * the common case still lands within the same request.
 *
 * The dedupe key is (list, lead, event-bearing status) rather than a timestamp, so a repeat
 * transition collapses onto the same job instead of queueing a second conversion — the same
 * fire-once property `metaConversionsSent` gives, enforced a second time at the queue.
 */
const INLINE_FALLBACK_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Last resort when no durable record can be written. Retries in-process a bounded number of
 * times, because without the queue there is nowhere to record a retry for later — a single
 * attempt would turn one unlucky moment (a Meta blip during a queue outage) into a
 * permanently lost conversion.
 *
 * This cannot survive a process restart, and nothing can while the queue is unreachable.
 * What it must not do is fail quietly: a conversion nobody knows was lost is the exact
 * problem this card exists to fix, so the give-up path says so explicitly.
 */
async function runInlineFallback(
  ctx: RelayContext,
  dedupeKey: string,
  kind: ConversionKind,
): Promise<void> {
  console.warn(
    `[CAPI Relay] no durable record possible for ${dedupeKey} — falling back to ` +
    `${INLINE_FALLBACK_ATTEMPTS} in-process attempts`,
  );

  let last = '';
  for (let attempt = 1; attempt <= INLINE_FALLBACK_ATTEMPTS; attempt++) {
    const result = await relayLeadStatusEvent(ctx);

    if ('sent' in result) return;
    // A terminal skip (opted out, already sent, not enabled) is a correct outcome, not
    // something to hammer.
    if ('skipped' in result && !result.retryable) return;

    last = 'failed' in result ? result.error : (result as any).reason;
    if (attempt < INLINE_FALLBACK_ATTEMPTS) await sleep(250 * attempt);
  }

  // Nothing durable exists in the queue, so leave the record where we know writes work: on
  // the lead itself. The status update that triggered this just succeeded against that
  // table, so it is the one place still demonstrably reachable. This is what turns
  // "exhausted and gone" into "exhausted and recoverable" (Greptile on #2412) — §F's
  // reconciliation sweep consumes these, and appendMetaConversionSent clears them.
  try {
    const { crmDb } = await import('./db');
    await crmDb.markConversionRelayPending(ctx.listId, ctx.lead.leadId, kind);
  } catch (error: any) {
    console.error(
      `[CAPI Relay] could not even record ${dedupeKey} as pending: ${error?.message}`,
    );
  }

  console.error(
    `[CAPI Relay] inline fallback exhausted for ${dedupeKey}; the conversion is recorded as ` +
    `PENDING on the lead for reconciliation rather than lost: ${last}`,
  );
}

/**
 * What a dispatch actually did. The reconciliation sweep budgets on real work, so it has to
 * be able to tell an attempt apart from a no-op: counting "another worker already owns this"
 * as work let 200 such rows exhaust the sweep's budget every tick and starve everything
 * behind them, since a no-op also leaves the marker in place to be re-found (Greptile P1 on
 * #2412).
 */
export type DispatchOutcome =
  /** Not a conversion, or nothing to do. */
  | 'noop'
  /** A live or freshly-created job elsewhere owns it — real progress, but not ours. */
  | 'already-queued'
  /** We processed it inline and a conversion actually reached Meta. */
  | 'sent'
  /** We processed it inline and nothing was sent — settled or not-yet. Real progress, but
   *  it must not consume a send budget, or a prefix of such leads blocks every sweep. */
  | 'processed'
  /** No durable record was possible; the inline fallback ran. */
  | 'fallback';

export async function dispatchLeadStatusConversion(ctx: RelayContext): Promise<DispatchOutcome> {
  const { enqueueJob, markJobFailed, startHeartbeat, clearFailedJob, deleteJob } = await import('./asyncJobQueue');

  const leadId = ctx.lead?.leadId;
  if (!leadId) return 'noop';

  // An explicitly supplied kind is authoritative — it comes either from a queued job or from
  // a `metaConversionPending` marker, and in both cases the lead's CURRENT status may have
  // moved on since the conversion was earned. Deriving from current status here silently
  // dropped exactly the owed conversions the pending marker exists to rescue, leaving the
  // marker on the lead forever (Greptile on #2412 — a bug in the commit that added the
  // marker's consumer, which is why the consumer did not actually work).
  //
  // Otherwise: nothing to queue if this status was never a conversion, which keeps the job
  // table free of a row for every `new -> contacted` in the product.
  const mapped = ctx.conversionKind
    ? { conversionKind: ctx.conversionKind, isValueEvent: ctx.conversionKind === 'won' }
    : mapStatusToMetaEvent(ctx.statusConfig ?? undefined, ctx.lead.status);
  if (!mapped) return 'noop';

  const dedupeKey = `${ctx.listId}:${leadId}:${mapped.conversionKind}`;
  const payload: ConversionRelayJobPayload = {
    listId: ctx.listId,
    leadId,
    userId: ctx.userId,
    conversionKind: mapped.conversionKind,
  };

  let enqueued = await enqueueJob(RELAY_QUEUE_SOURCE, dedupeKey, payload, { claimImmediately: true });

  if (enqueued === 'duplicate') {
    // Normally correct: this conversion is already queued, in flight, or done. But the key
    // is derived from durable business state, so a job that exhausted its attempts would
    // otherwise make this lead+event permanently unreachable — every later genuine
    // transition rejected as a duplicate, even once Meta has recovered (Greptile P1 on
    // #2412). Clearing is conditional on the terminal `failed` state, so a live or
    // completed job is never touched, and `metaConversionsSent` still guarantees fire-once
    // if the event did in fact land.
    const cleared = await clearFailedJob(RELAY_QUEUE_SOURCE, dedupeKey);

    // A live or completed row means someone else owns this conversion — stand down.
    if (cleared === 'not-failed') return 'already-queued';

    // An ERROR is not that. We could not tell whether the row was terminal, so giving up
    // here would abandon the conversion over a transient DynamoDB blip, with no retry, no
    // fallback and no marker. Fall through to the fallback, which at minimum records that
    // this conversion is still owed (Greptile P1 on #2412).
    if (cleared === 'error') {
      await runInlineFallback(ctx, dedupeKey, mapped.conversionKind);
      return 'fallback';
    }

    enqueued = await enqueueJob(RELAY_QUEUE_SOURCE, dedupeKey, payload, { claimImmediately: true });
    // Another dispatcher recreated the row between our delete and our write; it owns the
    // work now, and doing it here too would just race it.
    if (enqueued === 'duplicate') return 'already-queued';
  }

  if (enqueued === 'unavailable') {
    // One retry: a transient write blip is a different thing from the table being
    // unreachable, and this is the last chance at a durable record (same reasoning as the
    // Calendly path's enqueue retry).
    enqueued = await enqueueJob(RELAY_QUEUE_SOURCE, dedupeKey, payload, { claimImmediately: true });
  }

  if (enqueued !== 'enqueued') {
    // No durable record exists. Critically this also covers the path where the clear above
    // succeeded and the replacement write did not — an earlier version returned here, having
    // deleted the only record of the conversion and done nothing with it, which is strictly
    // worse than the terminal failure it was trying to recover (Greptile on #2412).
    await runInlineFallback(ctx, dedupeKey, mapped.conversionKind);
    return 'fallback';
  }

  const stopHeartbeat = startHeartbeat(RELAY_QUEUE_SOURCE, dedupeKey);
  let sent = false;
  try {
    sent = await processConversionRelayJob(payload);
    // Deleted, not completed. The dedupe key is derived from durable business state, so a
    // lingering 'completed' row rejects every later enqueue for this lead+conversion —
    // including the legitimate retry after a customer opts in, or connects the pixel that
    // was missing when we first skipped. Fire-once does not depend on this row: it is
    // guaranteed by metaConversionsSent on the lead, which is written only on a real send.
    // Letting the queue also claim that job made it a second, weaker source of truth that
    // outlived the real one (Greptile on #2412).
    await deleteJob(RELAY_QUEUE_SOURCE, dedupeKey);
  } catch (error) {
    await markJobFailed(RELAY_QUEUE_SOURCE, dedupeKey, error);
  } finally {
    stopHeartbeat();
  }
  return sent ? 'sent' : 'processed';
}
