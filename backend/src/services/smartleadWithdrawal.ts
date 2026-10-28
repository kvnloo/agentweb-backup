import { isDoNotContact } from "../utils/leadContactStatus";
import { getSmartleadMarker, smartleadMarkerKey, type SmartleadMarker } from "./smartleadMarkers";
import type { ResolvedSmartlead } from "./smartleadConnection";
import type { LeadCursor, PushRun, PushRunSummary } from "./smartleadPushRunDb";
import { SmartleadApiError, scrubSmartleadSecrets, type UnsubscribeOutcome } from "./smartleadService";

/**
 * The withdrawal sweep (ENG-673): an opt-out recorded in AgentWeb must reach Smartlead too. Smartlead sends on its own schedule, so a lead
 * that opts out in AgentWeb after it was pushed would keep receiving the customer's sequence. Hourly, for every list and campaign a run
 * touched in the last WINDOW_DAYS, this finds the leads whose marker is still `pushed` and that are now do-not-contact here, unsubscribes
 * them account-wide in Smartlead (`POST /leads/{id}/unsubscribe`: idempotent, verified live) and sets the marker to `withdrawn`.
 *
 * It runs whether or not pushing is switched on: stopping pushes must never stop opt-outs. A failure leaves the marker `pushed`, so the next
 * pass tries again. Known limits (tracker): it reads whole lists every hour (an event hook on contact-status changes should replace it);
 * the same address in another list carries no marker there; a lead deleted in the CRM stays in Smartlead; a run older than the window is no
 * longer swept.
 */

type Lead = Record<string, any>;

export const WITHDRAWAL_WINDOW_DAYS = 60;
export const WITHDRAWALS_PER_LIST = 200;
const RUNS_PER_SWEEP = 500;
const PAGE = 200;
/** Stop a list after this many failures in a row (a rate limit or an outage): the next pass continues. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface WithdrawalDeps {
  db: {
    listRunsSince(sinceIso: string, limit?: number): Promise<PushRunSummary[]>;
    getRun(runId: string): Promise<PushRun | null>;
  };
  resolveKey(userId: string, accountId?: string): Promise<ResolvedSmartlead>;
  reportFailure(resolved: Extract<ResolvedSmartlead, { ok: true }>, error: unknown): Promise<unknown>;
  readLeads(listId: string, after: LeadCursor | null, limit: number): Promise<{ items: Lead[]; hasMore: boolean }>;
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
  /** Leads whose unsubscribe did not go through; they stay `pushed` and are retried next pass. */
  failed: number;
  /** Pairs left alone because the pusher's Smartlead key could not be used. */
  keyUnavailable: number;
}

export async function withdrawalSweep(deps: WithdrawalDeps): Promise<SweepResult> {
  const out: SweepResult = { targets: 0, withdrawn: 0, failed: 0, keyUnavailable: 0 };
  const windowMs = (deps.windowDays ?? WITHDRAWAL_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const cap = deps.maxPerList ?? WITHDRAWALS_PER_LIST;
  const rows = await deps.db.listRunsSince(new Date(deps.now().getTime() - windowMs).toISOString(), RUNS_PER_SWEEP); // newest first

  // One target per list and campaign: the newest run says whose key to use.
  const targets = new Map<string, PushRunSummary>();
  for (const row of rows) {
    if (!row.listId || !row.campaignId) continue;
    const key = `${row.listId}#${row.campaignId}`;
    if (!targets.has(key)) targets.set(key, row);
  }

  const keys = new Map<string, ResolvedSmartlead>();
  for (const row of targets.values()) {
    out.targets++;
    const run = await deps.db.getRun(row.runId);
    if (!run) continue;
    const identity = `${run.keyOwnerId}#${run.smartleadAccountId}`;
    let resolved = keys.get(identity);
    if (!resolved) {
      resolved = await deps.resolveKey(run.keyOwnerId, run.smartleadAccountId);
      keys.set(identity, resolved);
    }
    if (!resolved.ok) {
      out.keyUnavailable++;
      deps.log(`[SmartleadWithdrawal] list=${run.listId} campaign=${run.campaignId}: key unavailable (${resolved.reason})`);
      continue;
    }
    const result = await sweepTarget(deps, resolved, run.listId, run.campaignId, cap);
    out.withdrawn += result.withdrawn;
    out.failed += result.failed;
  }
  if (out.withdrawn || out.failed || out.keyUnavailable) {
    deps.log(`[SmartleadWithdrawal] pass: targets=${out.targets} withdrawn=${out.withdrawn} failed=${out.failed} keyUnavailable=${out.keyUnavailable}`);
  }
  return out;
}

async function sweepTarget(
  deps: WithdrawalDeps,
  resolved: Extract<ResolvedSmartlead, { ok: true }>,
  listId: string,
  campaignId: number,
  cap: number,
): Promise<{ withdrawn: number; failed: number }> {
  const markerKey = smartleadMarkerKey(campaignId);
  const result = { withdrawn: 0, failed: 0 };

  // Find the leads that opted out here and are still live in Smartlead.
  const candidates: Array<{ lead: Lead; marker: SmartleadMarker }> = [];
  let after: LeadCursor | null = null;
  scan: for (;;) {
    const page = await deps.readLeads(listId, after, PAGE);
    if (page.items.length === 0) break;
    for (const lead of page.items) {
      const marker = getSmartleadMarker(lead, campaignId);
      if (marker?.state === "pushed" && isDoNotContact(lead)) {
        candidates.push({ lead, marker });
        if (candidates.length >= cap) break scan; // the rest wait for the next pass
      }
    }
    after = { listId, leadId: String(page.items[page.items.length - 1].leadId) };
    if (!page.hasMore) break;
  }

  let consecutiveFailures = 0;
  for (const { lead, marker } of candidates) {
    try {
      let smartleadLeadId = marker.smartleadLeadId;
      if (!smartleadLeadId && typeof lead.email === "string" && lead.email.trim()) smartleadLeadId = (await deps.smartlead.findLeadId(resolved.apiKey, lead.email)) ?? undefined;
      // Smartlead has no such lead (or it is gone): nothing to unsubscribe, and the marker can stop saying "pushed".
      const outcome: UnsubscribeOutcome = smartleadLeadId ? await deps.smartlead.unsubscribe(resolved.apiKey, smartleadLeadId) : "not_found";
      if (outcome === "no_update") {
        result.failed++;
        consecutiveFailures++;
        deps.log(`[SmartleadWithdrawal] list=${listId} lead=${lead.leadId}: Smartlead changed nothing; will retry`);
      } else {
        await deps.writeMarker(listId, String(lead.leadId), markerKey, { ...marker, state: "withdrawn", withdrawnAt: deps.now().toISOString() });
        result.withdrawn++;
        consecutiveFailures = 0;
      }
    } catch (error) {
      result.failed++;
      consecutiveFailures++;
      deps.log(`[SmartleadWithdrawal] list=${listId} lead=${lead.leadId}: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
      // A rejected key will fail every lead the same way: report it (flagged after a confirming probe) and leave this list for the next pass.
      if (error instanceof SmartleadApiError && (error.status === 401 || error.status === 403)) {
        void deps.reportFailure(resolved, error).catch(() => undefined);
        break;
      }
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
  }
  return result;
}
