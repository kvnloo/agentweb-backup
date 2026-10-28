import { isDoNotContact } from "../utils/leadContactStatus";
import { getSmartleadMarker, smartleadMarkerKey, type SmartleadMarker } from "./smartleadMarkers";
import type { ResolvedSmartlead } from "./smartleadConnection";
import type { LeadCursor, PushRun, PushRunSummary } from "./smartleadPushRunDb";
import { SmartleadApiError, scrubSmartleadSecrets, type UnsubscribeOutcome } from "./smartleadService";

/**
 * The withdrawal sweep (ENG-673): an opt-out recorded in AgentWeb must reach Smartlead too. Smartlead sends on its own schedule, so a lead
 * that opts out in AgentWeb after it was pushed would keep receiving the customer's sequence. Hourly, for every list and campaign a run
 * touched in the last WINDOW_DAYS, this finds the leads whose marker is `pushed` (or `released`: a list editor releasing a lead changes
 * nothing in Smartlead, so a released lead that is do-not-contact must still be stopped there) and that are now do-not-contact here, unsubscribes
 * them account-wide in Smartlead (`POST /leads/{id}/unsubscribe`: idempotent, verified live) and sets the marker to `withdrawn`.
 *
 * It runs whether or not pushing is switched on: stopping pushes must never stop opt-outs. A failure leaves the marker as it was, so the next
 * pass tries again; a lead that keeps failing is tried LAST on later passes, so it cannot block the ones behind it. Known limits (tracker): it
 * reads whole lists every hour (an event hook on contact-status changes should replace it); the same address in another list carries no
 * marker there; a lead deleted in the CRM stays in Smartlead; a run older than the window is no longer swept.
 *
 * Policy, stated on purpose: EVERY do-not-contact status triggers the account-wide unsubscribe, bounces included. Smartlead's unsubscribe is
 * permanent and cannot be undone through its API, so a lead withdrawn here and later re-subscribed in AgentWeb stays blocked in Smartlead.
 */

type Lead = Record<string, any>;

export const WITHDRAWAL_WINDOW_DAYS = 60;
export const WITHDRAWALS_PER_LIST = 200;
const RUNS_PER_SWEEP = 500;
const PAGE = 200;
/** Stop a list after this many failures in a row (an outage): the next pass continues, trying other leads first. */
const MAX_CONSECUTIVE_FAILURES = 10;

export interface WithdrawalDeps {
  db: {
    listRunsSince(sinceIso: string, limit?: number): Promise<PushRunSummary[]>;
    getRun(runId: string): Promise<PushRun | null>;
  };
  resolveKey(userId: string, accountId?: string): Promise<ResolvedSmartlead>;
  reportFailure(resolved: Extract<ResolvedSmartlead, { ok: true }>, error: unknown): Promise<unknown>;
  readLeads(listId: string, after: LeadCursor | null, limit: number): Promise<{ items: Lead[]; hasMore: boolean }>;
  /** A CONSISTENT read of one lead: the irreversible unsubscribe is decided on this, not on the page read. */
  readLeadConsistent(listId: string, leadId: string): Promise<Lead | null>;
  writeMarker(listId: string, leadId: string, markerKey: string, marker: SmartleadMarker): Promise<void>;
  smartlead: {
    unsubscribe(apiKey: string, smartleadLeadId: string): Promise<UnsubscribeOutcome>;
    findLeadId(apiKey: string, email: string): Promise<string | null>;
  };
  now(): Date;
  log(line: string): void;
  windowDays?: number;
  maxPerList?: number;
}

export interface SweepResult {
  /** Distinct list and campaign pairs looked at. */
  targets: number;
  withdrawn: number;
  /** Leads whose unsubscribe did not go through; they stay as they were and are retried (after the others) next pass. */
  failed: number;
  /** Pairs left alone because no Smartlead key of theirs could be used. */
  keyUnavailable: number;
  /** Pairs that threw (a bad run row, an unreadable list): logged, and the pass went on to the next. */
  targetErrors: number;
}

export async function withdrawalSweep(deps: WithdrawalDeps): Promise<SweepResult> {
  const out: SweepResult = { targets: 0, withdrawn: 0, failed: 0, keyUnavailable: 0, targetErrors: 0 };
  const windowMs = (deps.windowDays ?? WITHDRAWAL_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const cap = deps.maxPerList ?? WITHDRAWALS_PER_LIST;
  const rows = await deps.db.listRunsSince(new Date(deps.now().getTime() - windowMs).toISOString(), RUNS_PER_SWEEP); // newest first

  // One target per list and campaign, with EVERY run for it (newest first): a Smartlead campaign belongs to one account, so any run's
  // key can reach it, and a newest run whose key is gone must not hide the others.
  const targets = new Map<string, PushRunSummary[]>();
  for (const row of rows) {
    if (!row.listId || !row.campaignId) continue;
    const key = `${row.listId}#${row.campaignId}`;
    const list = targets.get(key);
    if (list) list.push(row);
    else targets.set(key, [row]);
  }

  const keys = new Map<string, ResolvedSmartlead>();
  for (const runRows of targets.values()) {
    out.targets++;
    const first = runRows[0];
    try {
      let resolved: Extract<ResolvedSmartlead, { ok: true }> | undefined;
      let lastReason = "no_run";
      for (const row of runRows) {
        const run = await deps.db.getRun(row.runId).catch(() => null);
        if (!run) continue;
        const identity = `${run.keyOwnerId}#${run.smartleadAccountId}`;
        let candidate = keys.get(identity);
        if (!candidate) {
          candidate = await deps.resolveKey(run.keyOwnerId, run.smartleadAccountId);
          keys.set(identity, candidate);
        }
        if (candidate.ok) { resolved = candidate; break; }
        lastReason = candidate.reason;
      }
      if (!resolved) {
        out.keyUnavailable++;
        deps.log(`[SmartleadWithdrawal] list=${first.listId} campaign=${first.campaignId}: NO usable Smartlead key (${lastReason}); opt-outs on this list are NOT being sent to Smartlead`);
        continue;
      }
      const result = await sweepTarget(deps, resolved, first.listId!, first.campaignId!, cap);
      out.withdrawn += result.withdrawn;
      out.failed += result.failed;
    } catch (error) {
      out.targetErrors++;
      deps.log(`[SmartleadWithdrawal] list=${first.listId} campaign=${first.campaignId}: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }
  if (out.withdrawn || out.failed || out.keyUnavailable || out.targetErrors) {
    deps.log(`[SmartleadWithdrawal] pass: targets=${out.targets} withdrawn=${out.withdrawn} failed=${out.failed} keyUnavailable=${out.keyUnavailable} targetErrors=${out.targetErrors}`);
  }
  return out;
}

const needsWithdrawal = (lead: Lead, campaignId: number): SmartleadMarker | undefined => {
  const marker = getSmartleadMarker(lead, campaignId);
  return marker && (marker.state === "pushed" || marker.state === "released") && isDoNotContact(lead) ? marker : undefined;
};

async function sweepTarget(
  deps: WithdrawalDeps,
  resolved: Extract<ResolvedSmartlead, { ok: true }>,
  listId: string,
  campaignId: number,
  cap: number,
): Promise<{ withdrawn: number; failed: number }> {
  const markerKey = smartleadMarkerKey(campaignId);
  const result = { withdrawn: 0, failed: 0 };

  // Every lead that opted out here and is still live in Smartlead; those that failed before are tried last.
  const found: Array<{ leadId: string; attempts: number; attemptedAt: string }> = [];
  let after: LeadCursor | null = null;
  for (;;) {
    const page = await deps.readLeads(listId, after, PAGE);
    if (page.items.length === 0) break;
    for (const lead of page.items) {
      const marker = needsWithdrawal(lead, campaignId);
      if (marker) found.push({ leadId: String(lead.leadId), attempts: marker.withdrawAttempts ?? 0, attemptedAt: marker.withdrawAttemptedAt ?? "" });
    }
    after = { listId, leadId: String(page.items[page.items.length - 1].leadId) };
    if (!page.hasMore) break;
  }
  found.sort((a, b) => a.attempts - b.attempts || a.attemptedAt.localeCompare(b.attemptedAt));

  let consecutiveFailures = 0;
  for (const { leadId } of found.slice(0, cap)) {
    // Decide on a CONSISTENT read taken now: the unsubscribe cannot be undone, and the page read can be stale (a lead re-subscribed, or
    // already withdrawn, in the meantime).
    const lead = await deps.readLeadConsistent(listId, leadId);
    const marker = lead ? needsWithdrawal(lead, campaignId) : undefined;
    if (!lead || !marker) continue;
    const email = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";

    try {
      // The stored Smartlead id is trusted only while the lead still has the address that was pushed; otherwise (or with no id) the lead is
      // looked up by its CURRENT address, so an edited address can never unsubscribe somebody else.
      const stored = marker.smartleadLeadId;
      const trusted = !!stored && (!marker.email || marker.email === email);
      let smartleadLeadId: string | undefined = trusted ? stored : email ? (await deps.smartlead.findLeadId(resolved.apiKey, email)) ?? undefined : undefined;
      let outcome: UnsubscribeOutcome = smartleadLeadId ? await deps.smartlead.unsubscribe(resolved.apiKey, smartleadLeadId) : "not_found";
      // A 404 on a stored id can mean the customer deleted and re-imported the lead, which changes its id: look the address up before
      // deciding the lead is gone.
      if (outcome === "not_found" && smartleadLeadId && smartleadLeadId === stored && email) {
        const current = await deps.smartlead.findLeadId(resolved.apiKey, email);
        if (current && current !== stored) {
          smartleadLeadId = current;
          outcome = await deps.smartlead.unsubscribe(resolved.apiKey, current);
        }
      }
      if (outcome === "no_update") {
        await recordFailure(deps, listId, leadId, markerKey, marker);
        result.failed++;
        consecutiveFailures++;
        deps.log(`[SmartleadWithdrawal] list=${listId} lead=${leadId}: Smartlead changed nothing; will retry`);
      } else {
        await deps.writeMarker(listId, leadId, markerKey, { ...marker, state: "withdrawn", withdrawnAt: deps.now().toISOString() });
        result.withdrawn++;
        consecutiveFailures = 0;
      }
    } catch (error) {
      result.failed++;
      consecutiveFailures++;
      deps.log(`[SmartleadWithdrawal] list=${listId} lead=${leadId}: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
      const status = error instanceof SmartleadApiError ? error.status : undefined;
      // A rejected key fails every lead the same way, and a rate limit means "stop for now": leave the list for the next pass.
      if (status === 401 || status === 403) {
        void deps.reportFailure(resolved, error).catch(() => undefined);
        break;
      }
      if (status === 429) break;
      await recordFailure(deps, listId, leadId, markerKey, marker);
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
  }
  return result;
}

/** Notes a failed attempt on the marker (best effort), so the lead moves to the back of the queue. */
async function recordFailure(deps: WithdrawalDeps, listId: string, leadId: string, markerKey: string, marker: SmartleadMarker): Promise<void> {
  try {
    await deps.writeMarker(listId, leadId, markerKey, { ...marker, withdrawAttempts: (marker.withdrawAttempts ?? 0) + 1, withdrawAttemptedAt: deps.now().toISOString() });
  } catch {
    /* it will be tried again next pass anyway */
  }
}
