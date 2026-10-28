import { isDoNotContact } from "../utils/leadContactStatus";
import { getSmartleadMarker, smartleadMarkerKey, type SmartleadMarker } from "./smartleadMarkers";
import type { ResolvedSmartlead } from "./smartleadConnection";
import type { LeadCursor, PushRun, PushRunSummary } from "./smartleadPushRunDb";
import { SmartleadApiError, scrubSmartleadSecrets, type UnsubscribeOutcome, type UpdateLeadEmailOutcome } from "./smartleadService";
import { isAcceptableEmail } from "./smartleadPayload";

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
 * marker there; a lead deleted in the CRM stays in Smartlead; a run older than the window (400 days) is no longer swept, and lists of finished campaigns are still read every hour.
 *
 * Policy, stated on purpose: EVERY do-not-contact status triggers the account-wide unsubscribe, bounces included. Smartlead's unsubscribe is
 * permanent and cannot be undone through its API, so a lead withdrawn here and later re-subscribed in AgentWeb stays blocked in Smartlead.
 */

type Lead = Record<string, any>;

/** As long as the runs themselves are kept (the run table's retention): a long-running campaign's opt-outs must not stop being sent after 60 days. */
export const WITHDRAWAL_WINDOW_DAYS = 400;
export const WITHDRAWALS_PER_LIST = 200;
const RUNS_PER_SWEEP = 1000;
const PAGE = 200;
/** Stop a list after this many failures in a row (an outage): the next pass continues, trying other leads first. */
const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Which leads failed before, per process: they are tried LAST next time, so a lead that always fails cannot block the ones behind it. Kept in
 * memory, not on the marker: writing it to the marker would rewrite the whole marker from a possibly stale read and could undo a release
 * made meanwhile. A restart forgets it, which only costs fairness.
 */
const failedBefore = new Map<string, { attempts: number; at: number }>();
/** A failure older than this no longer pushes a lead to the back: it may well work now, and must not starve behind fresh ones. */
const FAILURE_DECAY_MS = 6 * 60 * 60 * 1000;
/** A message about the same lead is logged at most this often (a lead that needs a person would otherwise log every hour). */
const LOG_EVERY_MS = 24 * 60 * 60 * 1000;
const loggedAt = new Map<string, number>();
export const __resetWithdrawalAttempts = () => { failedBefore.clear(); loggedAt.clear(); };
const noteFailure = (listId: string, leadId: string, nowMs: number) => {
  const key = `${listId}#${leadId}`;
  const before = failedBefore.get(key);
  failedBefore.set(key, { attempts: (before && nowMs - before.at < FAILURE_DECAY_MS ? before.attempts : 0) + 1, at: nowMs });
  if (failedBefore.size > 50_000) failedBefore.clear(); // never grows without bound
  if (loggedAt.size > 50_000) loggedAt.clear();
};
const logOnce = (deps: { log(line: string): void; now(): Date }, key: string, line: string) => {
  const nowMs = deps.now().getTime();
  const last = loggedAt.get(key);
  if (last !== undefined && nowMs - last < LOG_EVERY_MS) return;
  loggedAt.set(key, nowMs);
  deps.log(line);
};

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
    /** Whether this key can SEE the campaign. A key from another Smartlead account answers 404 to everything, which must not be read as "the leads are gone". */
    campaignVisible(apiKey: string, campaignId: number): Promise<boolean>;
    unsubscribe(apiKey: string, smartleadLeadId: string): Promise<UnsubscribeOutcome>;
    /** Changes the address of a lead already in the campaign, in place (the same Smartlead lead id keeps its place and its opt-out). */
    updateLeadEmail(apiKey: string, campaignId: number, smartleadLeadId: string, email: string): Promise<UpdateLeadEmailOutcome>;
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
  /** Leads whose edited address was pushed to Smartlead (the pushed address is replaced, so it is no longer emailed). */
  synced: number;
  /** Leads whose unsubscribe did not go through; they stay as they were and are retried (after the others) next pass. */
  failed: number;
  /** Pairs left alone because no Smartlead key of theirs could be used. */
  keyUnavailable: number;
  /** Pairs that threw (a bad run row, an unreadable list): logged, and the pass went on to the next. */
  targetErrors: number;
}

export async function withdrawalSweep(deps: WithdrawalDeps): Promise<SweepResult> {
  const out: SweepResult = { targets: 0, withdrawn: 0, synced: 0, failed: 0, keyUnavailable: 0, targetErrors: 0 };
  const windowMs = (deps.windowDays ?? WITHDRAWAL_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const cap = deps.maxPerList ?? WITHDRAWALS_PER_LIST;
  const rows = await deps.db.listRunsSince(new Date(deps.now().getTime() - windowMs).toISOString(), RUNS_PER_SWEEP); // newest first

  // One target per list and campaign, with EVERY run for it (newest first): a Smartlead campaign belongs to one account, so any run's
  // key can reach it, and a newest run whose key is gone must not hide the others.
  if (rows.length >= RUNS_PER_SWEEP) logOnce(deps, "run-limit", `[SmartleadWithdrawal] WARNING: ${rows.length} runs in the window, the limit: the OLDEST list and campaign pairs are not being swept`);
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
        logOnce(deps, `${first.listId}#${first.campaignId}#nokey#${lastReason}`, `[SmartleadWithdrawal] list=${first.listId} campaign=${first.campaignId}: NO usable Smartlead key (${lastReason}); opt-outs on this list are NOT being sent to Smartlead`);
        continue;
      }
      const result = await sweepTarget(deps, resolved, first.listId!, first.campaignId!, cap);
      out.withdrawn += result.withdrawn;
      out.synced += result.synced;
      out.failed += result.failed;
      if (result.invisible) {
        out.keyUnavailable++;
        logOnce(deps, `${first.listId}#${first.campaignId}#invisible`, `[SmartleadWithdrawal] list=${first.listId} campaign=${first.campaignId}: the connected key cannot see this campaign (it was deleted in Smartlead, or the key belongs to another Smartlead account); nothing was changed for this list, and if the campaign still exists for the customer its opt-outs are NOT being sent`);
      }
    } catch (error) {
      out.targetErrors++;
      logOnce(deps, `${first.listId}#${first.campaignId}#error#${error instanceof SmartleadApiError ? error.status ?? "net" : "other"}#${(error instanceof Error ? error.message : String(error)).slice(0, 40)}`, `[SmartleadWithdrawal] list=${first.listId} campaign=${first.campaignId}: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }
  if (out.withdrawn || out.synced || out.failed || out.keyUnavailable || out.targetErrors) {
    // Every pass that DID something is logged; a pass that only repeats the same problems is logged once a day.
    const line = `[SmartleadWithdrawal] pass: targets=${out.targets} withdrawn=${out.withdrawn} synced=${out.synced} failed=${out.failed} keyUnavailable=${out.keyUnavailable} targetErrors=${out.targetErrors}`;
    if (out.withdrawn || out.synced) deps.log(line);
    else logOnce(deps, `pass#${out.targets}#${out.failed}#${out.keyUnavailable}#${out.targetErrors}`, line);
  }
  return out;
}

const needsWithdrawal = (lead: Lead, campaignId: number): SmartleadMarker | undefined => {
  const marker = getSmartleadMarker(lead, campaignId);
  return marker && (marker.state === "pushed" || marker.state === "released") && isDoNotContact(lead) ? marker : undefined;
};

/** A pushed lead whose address was edited in the CRM after the push, to an address that would be accepted: Smartlead still has the OLD one. */
const needsAddressSync = (lead: Lead, campaignId: number): SmartleadMarker | undefined => {
  const marker = getSmartleadMarker(lead, campaignId);
  if (!marker || (marker.state !== "pushed" && marker.state !== "released") || !marker.smartleadLeadId || !marker.email) return undefined;
  // An opted-out lead is STOPPED, never moved: moving it to a new address first would leave Smartlead emailing that address if the stop then failed.
  if (isDoNotContact(lead)) return undefined;
  const email = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
  return isAcceptableEmail(email) && email !== marker.email ? marker : undefined;
};

type Outcome = { kind: "withdrawn" } | { kind: "synced" } | { kind: "skipped" } | { kind: "failed"; why: string; quiet?: boolean };

async function sweepTarget(
  deps: WithdrawalDeps,
  resolved: Extract<ResolvedSmartlead, { ok: true }>,
  listId: string,
  campaignId: number,
  cap: number,
): Promise<{ withdrawn: number; synced: number; failed: number; invisible?: boolean }> {
  const markerKey = smartleadMarkerKey(campaignId);
  const result: { withdrawn: number; synced: number; failed: number; invisible?: boolean } = { withdrawn: 0, synced: 0, failed: 0 };

  // What needs doing in this list: leads whose address was edited since the push, and leads that opted out here and are still live in
  // Smartlead. Leads that failed before are tried last.
  const order = (ids: Array<{ leadId: string; attempts: number; at: number }>) => ids.sort((a, b) => a.attempts - b.attempts || a.at - b.at);
  const entry = (lead: Lead) => {
    const before = failedBefore.get(`${listId}#${lead.leadId}`);
    const recent = before && deps.now().getTime() - before.at < FAILURE_DECAY_MS ? before : undefined;
    return { leadId: String(lead.leadId), attempts: recent?.attempts ?? 0, at: recent?.at ?? 0 };
  };
  const found: Array<{ leadId: string; attempts: number; at: number }> = [];
  const drifted: Array<{ leadId: string; attempts: number; at: number }> = [];
  let after: LeadCursor | null = null;
  for (;;) {
    const page = await deps.readLeads(listId, after, PAGE);
    if (page.items.length === 0) break;
    for (const lead of page.items) {
      if (needsAddressSync(lead, campaignId)) drifted.push(entry(lead));
      if (needsWithdrawal(lead, campaignId)) found.push(entry(lead));
    }
    after = { listId, leadId: String(page.items[page.items.length - 1].leadId) };
    if (!page.hasMore) break;
  }
  order(found);
  order(drifted);
  if (found.length === 0 && drifted.length === 0) return result; // nothing to do here: no Smartlead call at all

  // The key must be able to SEE the campaign (a connection whose key was replaced by one from another Smartlead account answers 404 to every
  // lead, which would be read as "gone" and closed as withdrawn while the person is still live in the old account). Checked only when there
  // is something to do, so a quiet pass costs no Smartlead calls.
  try {
    if (!(await deps.smartlead.campaignVisible(resolved.apiKey, campaignId))) return { ...result, invisible: true };
  } catch (error) {
    // A key revoked since the last pass is found here first: report it (flagged after a confirming probe) before the pass moves on.
    const status = error instanceof SmartleadApiError ? error.status : undefined;
    if (status === 401 || status === 403) void deps.reportFailure(resolved, error).catch(() => undefined);
    throw error;
  }

  let hardStop = false; // a rate limit or a rejected key: nothing more is tried in this list this pass

  /** Runs `attempt` over leads with the shared bookkeeping: failures are remembered, a rate limit or a rejected key stops the list, an outage stops it too. */
  const runAll = async (ids: Array<{ leadId: string }>, attempt: (leadId: string) => Promise<Outcome>) => {
    let consecutiveFailures = 0; // per phase: a run of refused address changes must not stop the opt-outs that come after
    for (const { leadId } of ids.slice(0, cap)) {
      if (hardStop) return;
      let kind: Outcome["kind"];
      try {
        const outcome = await attempt(leadId);
        kind = outcome.kind;
        if (outcome.kind === "failed") {
          noteFailure(listId, leadId, deps.now().getTime());
          result.failed++;
          const line = `[SmartleadWithdrawal] list=${listId} lead=${leadId}: ${outcome.why}`;
          if (outcome.quiet) logOnce(deps, `${listId}#${leadId}#${outcome.why}`, line);
          else deps.log(line);
        } else if (outcome.kind === "withdrawn") {
          result.withdrawn++;
        } else if (outcome.kind === "synced") {
          result.synced++;
        }
      } catch (error) {
        kind = "failed";
        noteFailure(listId, leadId, deps.now().getTime());
        result.failed++;
        deps.log(`[SmartleadWithdrawal] list=${listId} lead=${leadId}: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
        const status = error instanceof SmartleadApiError ? error.status : undefined;
        // A rejected key fails every lead the same way, and a rate limit means "stop for now": leave the list for the next pass.
        if (status === 401 || status === 403) {
          void deps.reportFailure(resolved, error).catch(() => undefined);
          hardStop = true;
          return;
        }
        if (status === 429) { hardStop = true; return; }
      }
      // Every failure counts, refused addresses too: Smartlead answers a refusal and an outage alike with HTTP 500, so ten in a row ends the
      // edits for this pass (the opt-outs already ran first, and leads that failed are tried last next time, so others get their turn).
      consecutiveFailures = kind === "failed" ? consecutiveFailures + 1 : kind === "skipped" ? consecutiveFailures : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
    }
  };

  // Push edited addresses to Smartlead FIRST. Update Lead changes the address on the same lead id, so the pushed (old) address stops
  // being emailed, the stored id belongs to the CURRENT address again, and an opt-out below can use it safely.
  const syncOne = async (leadId: string): Promise<Outcome> => {
    const lead = await deps.readLeadConsistent(listId, leadId);
    const marker = lead ? needsAddressSync(lead, campaignId) : undefined;
    if (!lead || !marker) return { kind: "skipped" };
    const email = String(lead.email).trim().toLowerCase();
    const outcome = await deps.smartlead.updateLeadEmail(resolved.apiKey, campaignId, marker.smartleadLeadId!, email);
    if (outcome === "ok") {
      await deps.writeMarker(listId, leadId, markerKey, { ...marker, email });
      return { kind: "synced" };
    }
    if (outcome === "not_found") {
      // The stored id is gone. The customer may have deleted and re-imported the lead (a NEW id, still at the pushed address and still emailed):
      // look the pushed address up before deciding there is nothing live to correct.
      const current = await deps.smartlead.findLeadId(resolved.apiKey, marker.email!);
      if (current) {
        const again = await deps.smartlead.updateLeadEmail(resolved.apiKey, campaignId, current, email);
        if (again !== "ok") return { kind: "failed", why: "its pushed address is still in Smartlead under another lead id and the edited address could not be applied; will retry" };
        await deps.writeMarker(listId, leadId, markerKey, { ...marker, email, smartleadLeadId: current });
        return { kind: "synced" };
      }
      // Neither the id nor the pushed address is in Smartlead: nothing live to correct. Remember the new address so this stops being retried.
      await deps.writeMarker(listId, leadId, markerKey, { ...marker, email });
      return { kind: "skipped" };
    }
    if (outcome === "rejected") return { kind: "failed", quiet: true, why: "its address was edited but Smartlead refused the new one (it may already be another lead), so the pushed address is still live there" };
    return { kind: "failed", why: "Smartlead changed nothing for the edited address; will retry" };
  };

  // Stop opted-out leads.
  const withdrawOne = async (leadId: string): Promise<Outcome> => {
    // Decide on a CONSISTENT read taken now: the unsubscribe cannot be undone, and the page read can be stale (a lead re-subscribed, or
    // already withdrawn, in the meantime). A failed read throws and is a failure like any other, not a reason to abandon the list.
    const lead = await deps.readLeadConsistent(listId, leadId);
    const marker = lead ? needsWithdrawal(lead, campaignId) : undefined;
    if (!lead || !marker) return { kind: "skipped" };
    const email = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
    const withdrawn = async (): Promise<Outcome> => {
      await deps.writeMarker(listId, leadId, markerKey, { ...marker, state: "withdrawn", withdrawnAt: deps.now().toISOString() });
      return { kind: "withdrawn" };
    };

    const stored = marker.smartleadLeadId;
    const drift = !!stored && !!marker.email && marker.email !== email;

    if (drift) {
      // The address was edited and could NOT be pushed to Smartlead (it refused the new address, or the lead has no address now). This record
      // opted out, so its Smartlead counterpart (the stored id, which still has the PUSHED address) is stopped, and so is whatever lead has
      // the new address, if that is a different one.
      // The PUSHED address is looked up too: if the customer deleted and re-imported the lead, it is live under a NEW id that the stored id does not reach.
      const ids = [stored!];
      for (const address of [marker.email!, email]) {
        const found = address ? await deps.smartlead.findLeadId(resolved.apiKey, address) : null;
        if (found && !ids.includes(found)) ids.push(found);
      }
      for (const id of ids) {
        const outcome = await deps.smartlead.unsubscribe(resolved.apiKey, id);
        if (outcome === "no_update") return { kind: "failed", why: "Smartlead changed nothing; will retry" };
        // The stored id may be gone (deleted); an id that was JUST looked up and then 404s is Smartlead disagreeing with itself.
        if (outcome === "not_found" && id !== stored) return { kind: "failed", why: "Smartlead returned this lead's id and then said it does not exist; will retry" };
      }
      return withdrawn();
    }

    // No edited address: the stored id is the lead (a marker without an address is an older one and is trusted); with no id the lead is
    // looked up by its address.
    const looked = stored ? undefined : email ? (await deps.smartlead.findLeadId(resolved.apiKey, email)) ?? undefined : undefined;
    const target = stored ?? looked;
    if (!target) return withdrawn(); // never had a Smartlead id and the address is not there: nothing to unsubscribe

    let outcome = await deps.smartlead.unsubscribe(resolved.apiKey, target);
    if (outcome === "not_found") {
      if (stored && email) {
        // A 404 on a stored id can mean the customer deleted and re-imported the lead, which changes its id: look the address up before
        // deciding the lead is gone. The SAME id again means the lead exists and Smartlead refused: a failure, not "gone".
        const current = await deps.smartlead.findLeadId(resolved.apiKey, email);
        if (current === target) return { kind: "failed", why: "Smartlead says the lead is gone yet finds it by address; will retry" };
        if (current) {
          outcome = await deps.smartlead.unsubscribe(resolved.apiKey, current);
          if (outcome === "not_found") return { kind: "failed", why: "Smartlead says the lead is gone yet returned its id; will retry" };
        }
      } else if (looked) {
        // This id was JUST returned by the lookup, so a 404 on it is Smartlead disagreeing with itself, not a lead that is gone.
        return { kind: "failed", why: "Smartlead returned this lead's id and then said it does not exist; will retry" };
      }
    }
    if (outcome === "no_update") return { kind: "failed", why: "Smartlead changed nothing; will retry" };
    return withdrawn();
  };

  // Opt-outs come FIRST: a rate limit or a long backlog of address edits must never delay stopping somebody who said stop.
  await runAll(found, withdrawOne);
  await runAll(drifted, syncOne);
  return result;
}
