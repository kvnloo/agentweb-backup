import type { ResolvedSmartlead } from "./smartleadConnection";
import type { PushRun, PushRunSummary } from "./smartleadPushRunDb";
import type { EventOutcome } from "./smartleadEventService";
import type { SmartleadEvent, SmartleadEventKind } from "./smartleadEvents";
import { SmartleadApiError, scrubSmartleadSecrets, type SmartleadEmailStatus, type SmartleadLeadRow } from "./smartleadService";

/**
 * The hourly poll that backs up the event webhook (ENG-673, slice 3). The webhook is the main path, but Smartlead's delivery can be missed (our
 * server down, a retry window passed, a webhook the customer deleted), and a missed unsubscribe or bounce means we keep treating a blocked
 * contact as reachable. So once an hour, for every campaign a recent push went into, ask Smartlead which contacts replied, bounced or
 * unsubscribed, and feed each through the SAME handler the webhook uses.
 *
 * Replies and bounces are read with Smartlead's status filter (`emailStatus=is_replied|is_bounced`); opt-outs are read both with its
 * `is_unsubscribed` filter and from the plain listing keeping rows whose own flag is set, because the filter misses a contact unsubscribed through
 * the API. An answer is trusted only as "these contacts did it", never as "the others did not": Smartlead's plain listing lags minutes behind a
 * large add, and a lagging or partial answer simply means a contact is found on the next pass. The poll learns THAT a contact did it, with no time, text or event id, so
 * it records only what the contact does not already show (see SmartleadEventService, `polled`), and it is as idempotent as the webhook.
 * Like the withdrawal sweep it runs whether or not pushing is switched on: stopping pushes must never stop opt-outs.
 */
export const POLL_WINDOW_DAYS = 60;
const RUNS_PER_PASS = 1000;
/** Campaigns looked at per pass (newest first); more are logged, not silently skipped. */
export const POLL_CAMPAIGNS_PER_PASS = 100;
const PAGE = 100;
/** Pages per status per campaign per pass: 1000 contacts. A campaign with more is logged once a day. */
export const POLL_MAX_PAGES = 10;
/** A contact handled this recently is not looked up again (kept in memory; a restart only costs some repeat lookups). */
const SEEN_FOR_MS = 6 * 60 * 60 * 1000;
/**
 * A contact that matched nobody in the CRM (the customer's own contacts, our withdrawn ones, or an email lookup that lagged) is looked at again
 * after this. Longer than the hourly cadence, so a pass does not repeat the lookup for every such contact each time; short enough that a lookup
 * that lagged is retried the same day.
 */
const UNMATCHED_SEEN_FOR_MS = 2 * 60 * 60 * 1000;
/**
 * A filtered answer that lists at least this many contacts AND the whole campaign is taken to mean the filter was ignored. Low, because a bounce is
 * acted on without any per-contact evidence and ends in an irreversible withdrawal; a small campaign where everyone really did bounce or reply is
 * refused too (logged, and the webhook still delivers those).
 */
const FILTER_IGNORED_MIN = 5;
const LOG_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * What to ask for. Opt-outs are read TWICE: with Smartlead's own `is_unsubscribed` filter, and from the unfiltered listing keeping rows whose
 * `lead.is_unsubscribed` flag is set, because the filter misses a contact unsubscribed through the API (live finding 2026-10-30).
 */
const STATUSES: Array<{ status: SmartleadEmailStatus | null; kind: SmartleadEventKind }> = [
  { status: "is_unsubscribed", kind: "unsubscribe" }, // the ones that stop sends first
  { status: null, kind: "unsubscribe" }, // rows kept only if the contact's own flag is set
  { status: "is_bounced", kind: "bounce" },
  { status: "is_replied", kind: "reply" },
];

const seen = new Map<string, { at: number; for: number }>();
/**
 * A contact that looks genuinely bounced (in Smartlead's bounced list, not in its sender-side list) is acted on only when it looks so on TWO passes at
 * least this far apart. The two lists are separate reads and might not change at the same moment, and a block ends in an irreversible withdrawal; the
 * poll is only a backstop (the webhook delivers a genuine bounce at once), so waiting one pass costs nothing. In memory: a restart starts the wait again.
 */
export const BOUNCE_CONFIRM_AFTER_MS = 45 * 60 * 1000;
/**
 * A waiting contact that was last SEEN longer ago than this starts its wait again: it dropped out of the bounced list and came back (a rotation, a
 * re-add, a list that flapped), and an old first sighting must not stand in for the second one. Long enough that a campaign polled only every few
 * passes (more than 100 campaigns in the window, longest-waiting first) still completes its wait.
 */
export const BOUNCE_WAIT_STALE_MS = 12 * 60 * 60 * 1000; // up to 1000 runs / 100 campaigns per pass = a campaign polled about every 10 h: revisit this if either number changes
const pendingBounce = new Map<string, { first: number; last: number }>();
/** When each campaign was last polled, so that when there are more campaigns than one pass covers, the longest-waiting go first and none starve. */
const lastPolled = new Map<number, number>();
const loggedAt = new Map<string, number>();
/** For tests: how many waiting records are held. */
export const __pendingBounceCount = (): number => pendingBounce.size;
export const __resetEventPoll = () => { seen.clear(); loggedAt.clear(); lastPolled.clear(); pendingBounce.clear(); };

export interface PollDeps {
  db: {
    listRunsSince(sinceIso: string, limit?: number): Promise<PushRunSummary[]>;
    getRun(runId: string): Promise<PushRun | null>;
  };
  resolveKey(userId: string, accountId?: string): Promise<ResolvedSmartlead>;
  reportFailure(resolved: Extract<ResolvedSmartlead, { ok: true }>, error: unknown): Promise<unknown>;
  smartlead: {
    /** The campaign's status, or null when this key cannot see it. */
    campaignStatus(apiKey: string, campaignId: number): Promise<string | null>;
    listLeads(apiKey: string, campaignId: number, status: SmartleadEmailStatus | null, offset: number, limit: number): Promise<{ total: number; rows: SmartleadLeadRow[] }>;
  };
  events: { handle(ctx: { accountId: string; campaignId: number }, event: SmartleadEvent): Promise<EventOutcome> };
  now(): Date;
  log(line: string): void;
  windowDays?: number;
  maxCampaigns?: number;
  maxPages?: number;
  /** How long a genuine-looking bounce waits for a second sighting (tests set 0 to switch the wait off). */
  bounceConfirmAfterMs?: number;
}

export interface PollResult {
  campaigns: number;
  /** Contacts fed to the handler. */
  checked: number;
  /** Effects that changed something (a missed event recovered). */
  changed: number;
  keyUnavailable: number;
  errors: number;
}

const logOnce = (deps: { log(line: string): void; now(): Date }, key: string, line: string) => {
  const nowMs = deps.now().getTime();
  const last = loggedAt.get(key);
  if (last !== undefined && nowMs - last < LOG_EVERY_MS) return;
  loggedAt.set(key, nowMs);
  if (loggedAt.size > 50_000) loggedAt.clear();
  deps.log(line);
};

export async function eventPoll(deps: PollDeps): Promise<PollResult> {
  const out: PollResult = { campaigns: 0, checked: 0, changed: 0, keyUnavailable: 0, errors: 0 };
  const nowMs = deps.now().getTime();
  const rows = await deps.db.listRunsSince(new Date(nowMs - (deps.windowDays ?? POLL_WINDOW_DAYS) * 24 * 60 * 60 * 1000).toISOString(), RUNS_PER_PASS); // newest first
  if (rows.length >= RUNS_PER_PASS) logOnce(deps, "run-limit", `[SmartleadPoll] WARNING: ${rows.length} runs in the window, the limit: the OLDEST campaigns are not being polled`);

  // One target per campaign (a campaign belongs to one Smartlead account), keeping every run for it, newest first, so a newest run whose key is
  // gone does not hide the others.
  const targets = new Map<number, PushRunSummary[]>();
  for (const row of rows) {
    if (!row.campaignId) continue;
    const list = targets.get(row.campaignId);
    if (list) list.push(row);
    else targets.set(row.campaignId, [row]);
  }
  const cap = deps.maxCampaigns ?? POLL_CAMPAIGNS_PER_PASS;
  // Newest first (the order of `rows`), but campaigns not polled for the longest go first, so a campaign past the cap is reached on a later pass.
  const all = [...targets.entries()].sort((a, b) => (lastPolled.get(a[0]) ?? 0) - (lastPolled.get(b[0]) ?? 0));
  if (all.length > cap) logOnce(deps, "campaign-limit", `[SmartleadPoll] ${all.length} campaigns in the window, only the ${cap} waiting longest are polled this pass`);

  // Waiting records of contacts not seen for a day are dropped, so the map cannot fill with contacts that left the bounced list.
  for (const [k, v] of pendingBounce) if (nowMs - v.last > 2 * BOUNCE_WAIT_STALE_MS) pendingBounce.delete(k);

  const keys = new Map<string, ResolvedSmartlead>();
  for (const [campaignId, runRows] of all.slice(0, cap)) {
    let resolved: Extract<ResolvedSmartlead, { ok: true }> | undefined;
    // Set before the key is looked up: a campaign with no usable key must not stay at the front of the queue and use up the cap.
    lastPolled.set(campaignId, nowMs);
    if (lastPolled.size > 50_000) lastPolled.clear();
    try {
      let accountId: string | undefined;
      for (const row of runRows) {
        const run = await deps.db.getRun(row.runId).catch(() => null);
        if (!run) continue;
        const identity = `${run.keyOwnerId}#${run.smartleadAccountId}`;
        let candidate = keys.get(identity);
        if (!candidate) {
          candidate = await deps.resolveKey(run.keyOwnerId, run.smartleadAccountId);
          keys.set(identity, candidate);
        }
        if (candidate.ok) { resolved = candidate; accountId = run.smartleadAccountId; break; }
      }
      if (!resolved || !accountId) { out.keyUnavailable++; continue; } // the withdrawal sweep already says why, once a day
      out.campaigns++;

      const status = await deps.smartlead.campaignStatus(resolved.apiKey, campaignId);
      // Only a campaign that no longer exists (or that this key cannot see) is skipped. A drafted or archived one is still read: an opt-out the
      // customer recorded in Smartlead must reach the CRM whatever the campaign's status, and the cost is a few reads an hour.
      if (status === null) {
        logOnce(deps, `${campaignId}#invisible`, `[SmartleadPoll] campaign=${campaignId}: the connected key cannot see this campaign (deleted in Smartlead, or a key from another Smartlead account); it is not being polled`);
        continue;
      }

      // The campaign's own size, for the check below. One cheap read (a page of one).
      let campaignSize: number | undefined;
      try {
        campaignSize = (await deps.smartlead.listLeads(resolved.apiKey, campaignId, null, 0, 1)).total;
      } catch (error) {
        if (error instanceof SmartleadApiError && (error.status === 401 || error.status === 403)) throw error;
        logOnce(deps, `${campaignId}#size`, `[SmartleadPoll] campaign=${campaignId}: could not read the campaign's size (${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error)).slice(0, 80)}); bounces and replies are not polled for it this pass`);
      }
      let flagUnset = 0;
      // Smartlead's `is_bounced` list ALSO holds contacts whose bounce came from OUR side (the sending mailbox was refused or is broken), flagged
      // `sender_bounce` on the email: on two real campaigns (2026-10-30) that was 41 of 57 and 2 of 9. Those say nothing about the contact's address,
      // and blocking them would withdraw reachable contacts in Smartlead for good. Smartlead lists them separately (`is_sender_bounced`), so a
      // contact counts as bounced only when it is in the first list and NOT in the second. Read once per pass, and only if a bounce needs it.
      let senderSide: Set<string> | null | undefined; // undefined: not read yet; null: could not be read in full
      const readSenderSide = async (): Promise<Set<string> | null> => {
        const ids = new Set<string>();
        const pages = deps.maxPages ?? POLL_MAX_PAGES;
        for (let page = 0; page < pages; page++) {
          const { total, rows: leads } = await deps.smartlead.listLeads(resolved!.apiKey, campaignId, "is_sender_bounced", page * PAGE, PAGE);
          for (const l of leads) ids.add(l.leadId);
          if ((page + 1) * PAGE >= total) return ids;
          if (leads.length === 0) return null; // an empty page before the end: the list is not complete
        }
        return null; // more than the pages read: the exclusion cannot be proven, so no bounce is acted on
      };

      for (const { status: emailStatus, kind } of STATUSES) {
        // Without the campaign's size there is no defence against a filter that was ignored, and a bounce ends in an irreversible withdrawal: skip
        // the kinds that rest on the filter alone. Opt-outs carry Smartlead's own flag on each contact, so they are still read.
        if (campaignSize === undefined && kind !== "unsubscribe") continue;
        const maxPages = deps.maxPages ?? POLL_MAX_PAGES;
        // One read failing (a rate limit, a timeout) must not cost the other kinds of event, every hour, because the order is fixed. A key that
        // is refused is the exception: nothing else can work, so it goes to the campaign's handler below.
        try {
          for (let page = 0; page < maxPages; page++) {
            const { total, rows: leads } = await deps.smartlead.listLeads(resolved.apiKey, campaignId, emailStatus, page * PAGE, PAGE);
            // A status filter that Smartlead ignored or renamed would answer with EVERY contact of the campaign, and every one would be treated as
            // having bounced or unsubscribed (then withdrawn in Smartlead for good). So a filtered answer as big as the whole campaign is refused.
            if (emailStatus && campaignSize !== undefined && total >= FILTER_IGNORED_MIN && total >= campaignSize) {
              logOnce(deps, `${campaignId}#${emailStatus}#ignored`, `[SmartleadPoll] campaign=${campaignId}: Smartlead's ${emailStatus} answer lists the whole campaign (${total} of ${campaignSize}); treated as an ignored filter and not used`);
              out.errors++;
              break;
            }
            // Smartlead's sender-side list is needed only when there IS something bounced, so it is read here, after the first bounced page has rows.
            if (kind === "bounce" && leads.length > 0 && senderSide === undefined) {
              try {
                senderSide = await readSenderSide();
              } catch (error) {
                if (error instanceof SmartleadApiError && (error.status === 401 || error.status === 403)) throw error;
                senderSide = null;
                logOnce(deps, `${campaignId}#sender#read`, `[SmartleadPoll] campaign=${campaignId}: could not read Smartlead's sender-side bounces (${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error)).slice(0, 80)})`);
              }
            }
            if (kind === "bounce" && leads.length > 0 && senderSide === null) {
              out.errors++;
              logOnce(deps, `${campaignId}#sender#skip`, `[SmartleadPoll] campaign=${campaignId}: sender-side bounces are not known, so bounces are not acted on for it this pass`);
              break;
            }
            for (const lead of leads) {
              // An opt-out is believed only when Smartlead's own flag on the contact says so, however the row was found.
              if (kind === "unsubscribe" && !lead.unsubscribed) { if (emailStatus) flagUnset++; continue; }
              // A bounce from our own sending side is not about this contact.
              if (kind === "bounce") {
                const waiting = `${accountId}#${campaignId}#bounce#${lead.leadId}`;
                if (senderSide!.has(lead.leadId)) { pendingBounce.delete(waiting); continue; }
                // Looks genuine: act only once it has looked so on an earlier pass too (see BOUNCE_CONFIRM_AFTER_MS).
                const confirmAfter = deps.bounceConfirmAfterMs ?? BOUNCE_CONFIRM_AFTER_MS;
                if (confirmAfter > 0) {
                  const nowMs = deps.now().getTime();
                  const entry = pendingBounce.get(waiting);
                  if (entry === undefined || nowMs - entry.last > BOUNCE_WAIT_STALE_MS) { pendingBounce.set(waiting, { first: nowMs, last: nowMs }); if (pendingBounce.size > 100_000) pendingBounce.clear(); continue; }
                  entry.last = nowMs;
                  if (nowMs - entry.first < confirmAfter) continue;
                }
              }
              const memo = `${accountId}#${campaignId}#${kind}#${lead.leadId}`;
              const last = seen.get(memo);
              if (last !== undefined && deps.now().getTime() - last.at < last.for) continue;
              out.checked++;
              // One contact that cannot be handled (a database error, a write race that never settles) must not stop the rest of the campaign, now
              // or every hour after: it is counted, logged once a day, and tried again on the next pass.
              try {
                const outcome = await deps.events.handle({ accountId, campaignId }, {
                  kind, campaignId, candidateEmails: [lead.email], soft: false, polled: true,
                  eventKey: `poll:${kind}:${campaignId}:${lead.leadId}`,
                });
                out.changed += outcome.changed;
                seen.set(memo, { at: deps.now().getTime(), for: outcome.matched > 0 ? SEEN_FOR_MS : UNMATCHED_SEEN_FOR_MS });
              } catch (error) {
                out.errors++;
                const text = scrubSmartleadSecrets(error instanceof Error ? error.message : String(error)).slice(0, 120);
                logOnce(deps, `${campaignId}#contact#${lead.leadId}`, `[SmartleadPoll] campaign=${campaignId}: one contact could not be handled (${kind}): ${text}`);
              }
              // Not remembered: a contact whose handling FAILED (a database error while blocking an opt-out) is tried again on the next pass.
            }
            if (seen.size > 100_000) seen.clear(); // never grows without bound
            if ((page + 1) * PAGE >= total || leads.length === 0) break;
            if (page === maxPages - 1) logOnce(deps, `${campaignId}#${kind}#pages`, `[SmartleadPoll] campaign=${campaignId}: more than ${maxPages * PAGE} ${emailStatus ?? "listed"} contacts, the rest are not polled`);
          }
        } catch (error) {
          if (error instanceof SmartleadApiError && (error.status === 401 || error.status === 403)) throw error;
          out.errors++;
          const text = scrubSmartleadSecrets(error instanceof Error ? error.message : String(error)).slice(0, 120);
          logOnce(deps, `${campaignId}#read#${kind}#${emailStatus}`, `[SmartleadPoll] campaign=${campaignId}: could not read ${emailStatus ?? "the listing"}: ${text}`);
        }
      }
      if (flagUnset > 0) logOnce(deps, `${campaignId}#flagunset`, `[SmartleadPoll] campaign=${campaignId}: ${flagUnset} contact(s) came back from Smartlead's unsubscribed filter without the unsubscribed flag set; not acted on (if this keeps appearing, link unsubscribes may not set the flag)`);
    } catch (error) {
      out.errors++;
      // A revoked or expired key is flagged on the connection (as the withdrawal sweep does), so the customer is told to reconnect.
      if (resolved) await deps.reportFailure(resolved, error).catch(() => undefined);
      const text = scrubSmartleadSecrets(error instanceof Error ? error.message : String(error)).slice(0, 120);
      logOnce(deps, `${campaignId}#error#${error instanceof SmartleadApiError ? error.status ?? "net" : "other"}#${text.slice(0, 40)}`, `[SmartleadPoll] campaign=${campaignId}: ${text}`);
    }
  }
  if (out.changed || out.errors) deps.log(`[SmartleadPoll] pass: campaigns=${out.campaigns} checked=${out.checked} recovered=${out.changed} keyUnavailable=${out.keyUnavailable} errors=${out.errors}`);
  return out;
}
