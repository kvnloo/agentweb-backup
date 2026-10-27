/**
 * ENG-673: the worker loop of a Smartlead push run. It walks a CRM lead list with a cursor and adds the eligible leads to the
 * customer's own Smartlead campaign in batches, resumably. Everything it touches is injected (the run store, the lead reads, the
 * marker writes, the Smartlead calls, the clock), so the loop is tested without a network or a database and the HTTP layer and
 * the resumer cron stay thin.
 *
 * How it stays safe (see decision-slice-2-design):
 *  - The per-lead MARKER (`system.smartlead_<campaignId>`) is the state of a lead; the run only keeps a cursor and counts. A batch
 *    is POSTed, then every lead is marked, and only then is the cursor advanced by a write fenced on the run's lease epoch. After a
 *    crash the batch is rebuilt and sent again; Smartlead says per lead which already exist in the campaign, so they are marked and
 *    the run converges. The markers, not the lock, are what stop a lead being pushed twice.
 *  - Before every POST the run is read strongly and the leads about to be sent are re-read with a consistent read, so an opt-out
 *    recorded a moment ago is honoured, and a run that was paused or canceled sends nothing more.
 *  - Before every batch the campaign and its sequence are read again: a change of status, a missing campaign or an edited sequence
 *    pauses the run for a human decision. Smartlead's own block, unsubscribe and bounce lists still apply (the four override flags
 *    stay false in `addLeadsToCampaign`).
 *  - A store error (table missing, access denied) propagates: the caller fails closed and nothing more is sent.
 */

import { isDoNotContact } from "../utils/leadContactStatus";
import { analyseSequence } from "./smartleadSequence";
import { campaignStatusDecision } from "./smartleadPreflight";
import { isMarkedForCampaign, buildSmartleadMarker, smartleadMarkerKey, type SmartleadMarker } from "./smartleadMarkers";
import { selectSmartleadLeads } from "./smartleadEligibility";
import type { TagMapping } from "./smartleadPayload";
import type { LeadCursor, PushRun, SmartleadPushRunDb } from "./smartleadPushRunDb";
import { SMARTLEAD_LEADS_PER_REQUEST, SmartleadApiError, type SmartleadAddLeadsResult, type SmartleadCampaignDetail, type SmartleadLeadInput } from "./smartleadService";

type Lead = Record<string, any>;

/** What the user approved, stored on the run (`run.options`). Read defensively: it is data from a table. */
export interface PushRunOptions {
  includeUnverified: boolean;
  mapping: TagMapping;
  /** The campaign's status when the run was approved: DRAFTED or PAUSED runs stop if the campaign is started under them. */
  startStatus: string;
}

export function readPushOptions(raw: Record<string, unknown> | undefined): PushRunOptions {
  const mapping: TagMapping = {};
  const m = raw?.mapping;
  if (m && typeof m === "object" && !Array.isArray(m)) for (const [k, v] of Object.entries(m)) if (typeof v === "string") mapping[k] = v;
  return { includeUnverified: raw?.includeUnverified === true, mapping, startStatus: typeof raw?.startStatus === "string" ? raw.startStatus.toUpperCase() : "" };
}

export interface EngineDeps {
  store: Pick<SmartleadPushRunDb, "getRun" | "heartbeat" | "advance" | "recordBatchFailure" | "pauseRun" | "finishRun">;
  /** One page of the list, newest first, strictly AFTER `after` (null = from the start). `items` empty means the end. */
  readLeads(listId: string, after: LeadCursor | null, limit: number): Promise<{ items: Lead[]; hasMore: boolean }>;
  /** One lead with a CONSISTENT read (the page query is eventually consistent), or null if it is gone. */
  readLeadConsistent(listId: string, leadId: string): Promise<Lead | null>;
  writeMarker(listId: string, leadId: string, markerKey: string, marker: SmartleadMarker): Promise<void>;
  smartlead: {
    addLeads(leads: SmartleadLeadInput[]): Promise<SmartleadAddLeadsResult>;
    getCampaign(): Promise<SmartleadCampaignDetail | null>;
    getSequences(): Promise<unknown[]>;
  };
  /** Told about a failed Smartlead call, so the caller can flag a rejected key (reportSmartleadFailure). Must not throw. */
  onSmartleadError?(error: unknown): void;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export type RunOutcome =
  | { outcome: "completed" }
  | { outcome: "paused"; reason: string }
  /** Stopped after repeated batch failures; holds its lock until someone resumes or cancels it. */
  | { outcome: "partial" }
  /** This worker no longer owns the run (paused, canceled, or taken over). Nothing more was done. */
  | { outcome: "lost" };

const PAGE_SIZE = 100;
const MARKER_CONCURRENCY = 5;
const MARKER_ATTEMPTS = 3;
const MARKER_BACKOFF_MS = [50, 250];
const BATCH_BACKOFF_MS = [1_000, 5_000, 15_000];
const MAX_PAGES_PER_BATCH = 200;

class LostLease extends Error {}

const add = (into: Record<string, number>, reason: string, n = 1) => {
  if (n > 0) into[reason] = (into[reason] ?? 0) + n;
};

/** Runs `fn` over `items` with at most `limit` in flight, in chunks, calling `between` after each chunk (the lease is renewed there). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, between?: () => Promise<void>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const chunk = limit * 5;
  for (let from = 0; from < items.length; from += chunk) {
    const end = Math.min(items.length, from + chunk);
    let next = from;
    await Promise.all(
      Array.from({ length: Math.min(limit, end - from) }, async () => {
        while (next < end) {
          const i = next++;
          out[i] = await fn(items[i]);
        }
      }),
    );
    if (between) await between();
  }
  return out;
}

export async function executeRun(run: PushRun, deps: EngineDeps): Promise<RunOutcome> {
  const { store, smartlead } = deps;
  const epoch = run.leaseEpoch;
  const options = readPushOptions(run.options);
  const markerKey = smartleadMarkerKey(run.campaignId);

  let cursor: LeadCursor | null = run.cursor;
  let added = run.counts.added;
  let already = run.counts.alreadyInCampaign;
  // Emails taken so far in this execution. A batch works on COPIES and they are kept only once the batch is recorded: a batch that
  // fails is rebuilt from the same leads, and must not find them already "seen".
  let seenEmails = new Set<string>();
  let suppressedEmails = new Set<string>();

  const beat = async () => {
    if (!(await store.heartbeat(run.runId, epoch))) throw new LostLease();
  };
  // After a POST the leads are in Smartlead whatever happens to the lease, so they are ALWAYS marked: an unmarked lead would be missed
  // by AgentWeb's own-sender skip and by the opt-out withdrawal. This renews the lease when it can and never stops the marking.
  const beatQuiet = async () => {
    await store.heartbeat(run.runId, epoch);
  };
  const pause = async (reason: string): Promise<RunOutcome> => {
    await store.pauseRun(run.runId, reason, epoch);
    return { outcome: "paused", reason };
  };

  try {
    for (;;) {
      await beat();

      // The approved count is a hard ceiling: a lead that became eligible after the preview can never widen the approved set.
      const remaining = run.previewEligible - (added + already);
      if (remaining <= 0 || run.listExhausted) {
        // `listExhausted` is the store's "the walk is over": set here for a ceiling stop too, so the run can be completed.
        const ok = await store.advance(run.runId, epoch, { cursor: null, counts: {}, listExhausted: true });
        if (!ok) return { outcome: "lost" };
        return (await store.finishRun(run.runId, epoch, "completed")) ? { outcome: "completed" } : { outcome: "lost" };
      }

      // ── the campaign and its sequence, read fresh
      let campaign: SmartleadCampaignDetail | null;
      let sequenceReply: unknown[];
      try {
        campaign = await smartlead.getCampaign();
        sequenceReply = campaign ? await smartlead.getSequences() : [];
      } catch (error) {
        deps.onSmartleadError?.(error);
        const authFailure = error instanceof SmartleadApiError && (error.status === 401 || error.status === 403);
        if (authFailure) return await pause("key_rejected");
        const failure = await store.recordBatchFailure(run.runId, epoch);
        if (!failure) return { outcome: "lost" };
        if (failure.partial) return { outcome: "partial" };
        await deps.sleep(BATCH_BACKOFF_MS[Math.min(failure.attempts - 1, BATCH_BACKOFF_MS.length - 1)]);
        continue;
      }
      if (!campaign) return await pause("campaign_missing");
      if (campaignStatusDecision(campaign.status) === "refused") return await pause("campaign_not_pushable");
      if (options.startStatus !== "ACTIVE" && campaign.status === "ACTIVE") return await pause("campaign_started");
      const analysis = analyseSequence(sequenceReply);
      if (!analysis.readable) return await pause("sequence_unreadable");
      if (analysis.hash !== run.sequenceHash) return await pause("sequence_changed");

      // ── build one batch: whole pages only, so the cursor is exactly the last lead examined
      const cap = Math.min(SMARTLEAD_LEADS_PER_REQUEST, remaining);
      const seen = new Set(seenEmails);
      const suppressed = new Set(suppressedEmails);
      const eligible: ReturnType<typeof selectSmartleadLeads>["eligible"] = [];
      const skipped: Record<string, number> = {};
      let examined = 0;
      let batchCursor = cursor;
      let exhausted = false;
      for (let pages = 0; eligible.length < cap && !exhausted; pages++) {
        if (pages >= MAX_PAGES_PER_BATCH) break; // a huge run of skipped leads: record the progress and come back
        const page = await deps.readLeads(run.listId, batchCursor, Math.min(PAGE_SIZE, cap - eligible.length));
        if (page.items.length === 0) { exhausted = true; break; }
        const result = selectSmartleadLeads(page.items, {
          campaignId: run.campaignId,
          tags: analysis.tags,
          mapping: options.mapping,
          includeUnverified: options.includeUnverified,
          runStartedAt: run.startedAt,
          seenEmails: seen,
          suppressedEmails: suppressed,
        });
        eligible.push(...result.eligible);
        for (const [reason, n] of Object.entries(result.counts)) add(skipped, reason, n);
        examined += page.items.length;
        const last = page.items[page.items.length - 1];
        batchCursor = { listId: run.listId, leadId: String(last.leadId) };
        if (!page.hasMore) exhausted = true;
      }

      // ── just before sending: honour an opt-out recorded a moment ago, and a concurrent push of the same lead
      await beat();
      const fresh = await mapWithConcurrency(eligible, 10, e => deps.readLeadConsistent(run.listId, String(e.lead.leadId)));
      const toSend: typeof eligible = [];
      eligible.forEach((e, i) => {
        const current = fresh[i];
        if (!current) add(skipped, "lead_missing");
        else if (isDoNotContact(current)) add(skipped, "do_not_contact");
        else if (isMarkedForCampaign(current, run.campaignId)) add(skipped, "already_pushed");
        else toSend.push(e);
      });

      let batchAdded = 0;
      let batchAlready = 0;
      let unconfirmed = 0;
      let limitExhausted = false;

      if (toSend.length > 0) {
        // The run is read strongly right before the POST: a pause or cancel between the last fenced write and now is seen here.
        const live = await store.getRun(run.runId);
        if (!live || live.status !== "running" || live.leaseEpoch !== epoch) return { outcome: "lost" };

        let result: SmartleadAddLeadsResult;
        try {
          result = await smartlead.addLeads(toSend.map(e => e.input));
        } catch (error) {
          deps.onSmartleadError?.(error);
          if (error instanceof SmartleadApiError && (error.status === 401 || error.status === 403)) return await pause("key_rejected");
          // Not applied, or applied and unknown: either way the batch is rebuilt and sent again, and Smartlead's per-lead answer converges it.
          const failure = await store.recordBatchFailure(run.runId, epoch);
          if (!failure) return { outcome: "lost" };
          if (failure.partial) return { outcome: "partial" };
          await deps.sleep(BATCH_BACKOFF_MS[Math.min(failure.attempts - 1, BATCH_BACKOFF_MS.length - 1)]);
          continue;
        }
        await beatQuiet();

        // Without the per-lead map nothing can be marked, and an unmarked lead would be pushed again: stop for a human.
        if (!result.leads) return await pause("no_lead_map");

        const idByEmail = new Map<string, string>();
        for (const group of [result.leads.existingInOtherCampaigns, result.leads.existingInCampaign, result.leads.newlyAdded]) {
          for (const [email, id] of Object.entries(group ?? {})) idByEmail.set(email.toLowerCase(), String(id));
        }
        const invalid = new Set(result.invalidEmails.map(e => e.toLowerCase()));
        const unsubscribed = new Set(result.unsubscribedEmails.map(e => e.toLowerCase()));

        const toMark: Array<{ leadId: string; marker: SmartleadMarker }> = [];
        for (const e of toSend) {
          const email = e.input.email.toLowerCase();
          const smartleadLeadId = idByEmail.get(email);
          if (smartleadLeadId) toMark.push({ leadId: String(e.lead.leadId), marker: buildSmartleadMarker({ runId: run.runId, payloadHash: e.payloadHash, smartleadLeadId, now: deps.now() }) });
          else if (invalid.has(email)) add(skipped, "smartlead_invalid");
          else if (unsubscribed.has(email)) add(skipped, "smartlead_unsubscribed");
          else unconfirmed++; // Smartlead did not account for this lead: no marker, counted, and never blocks the run
        }

        // Mark every lead BEFORE the cursor moves, even if this worker lost the run meanwhile (only the cursor write is fenced). One that cannot be marked stops the batch: it is rebuilt and resent next time,
        // which Smartlead answers as "already in the campaign", so nothing is added twice.
        let markFailed = false;
        await mapWithConcurrency(
          toMark,
          MARKER_CONCURRENCY,
          async ({ leadId, marker }) => {
            if (markFailed) return;
            for (let attempt = 0; attempt < MARKER_ATTEMPTS; attempt++) {
              try {
                await deps.writeMarker(run.listId, leadId, markerKey, marker);
                return;
              } catch {
                if (attempt < MARKER_ATTEMPTS - 1) await deps.sleep(MARKER_BACKOFF_MS[attempt]);
              }
            }
            markFailed = true;
          },
          beatQuiet,
        );
        if (markFailed) {
          const failure = await store.recordBatchFailure(run.runId, epoch);
          if (!failure) return { outcome: "lost" };
          if (failure.partial) return { outcome: "partial" };
          await deps.sleep(BATCH_BACKOFF_MS[Math.min(failure.attempts - 1, BATCH_BACKOFF_MS.length - 1)]);
          continue;
        }
        batchAdded = result.added;
        batchAlready = result.alreadyInCampaign;
        limitExhausted = result.limitExhausted;
      }

      // ── record the batch: this fenced write is what moves the run on
      const finished = exhausted || added + batchAdded + already + batchAlready >= run.previewEligible;
      const ok = await store.advance(run.runId, epoch, {
        cursor: batchCursor,
        counts: { examined, added: batchAdded, alreadyInCampaign: batchAlready, unconfirmed },
        skipped,
        ...(finished ? { listExhausted: true } : {}),
      });
      if (!ok) return { outcome: "lost" };
      cursor = batchCursor;
      seenEmails = seen;
      suppressedEmails = suppressed;
      added += batchAdded;
      already += batchAlready;

      if (limitExhausted && !finished) return await pause("smartlead_lead_limit");
      if (finished) return (await store.finishRun(run.runId, epoch, "completed")) ? { outcome: "completed" } : { outcome: "lost" };
    }
  } catch (error) {
    if (error instanceof LostLease) return { outcome: "lost" };
    throw error; // a store error: fail closed, the lease lapses and the resumer decides
  }
}
