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
 *    pauses the run for a human decision. Smartlead's own block, unsubscribe and bounce lists still apply (those override flags
 *    stay false in `addLeadsToCampaign`), and a lead already in another campaign is skipped and reported, never added a second time.
 *  - A store error (table missing, access denied) propagates: the caller fails closed and nothing more is sent.
 */

import { isDoNotContact } from "../utils/leadContactStatus";
import { analyseSequence } from "./smartleadSequence";
import { campaignStatusDecision } from "./smartleadPreflight";
import { buildSmartleadMarker, getSmartleadMarker, smartleadMarkerKey, type SmartleadMarker } from "./smartleadMarkers";
import { selectSmartleadLeads } from "./smartleadEligibility";
import type { TagMapping } from "./smartleadPayload";
import type { LeadCursor, PushRun, SmartleadPushRunDb } from "./smartleadPushRunDb";
import { SMARTLEAD_LEADS_PER_REQUEST, SmartleadApiError, type SmartleadAddLeadsResult, type SmartleadCampaignDetail, type SmartleadLeadInput } from "./smartleadService";

type Lead = Record<string, any>;

/** What the user approved, stored on the run (`run.options`). Read defensively: it is data from a table. */
export interface PushRunOptions {
  includeUnverified: boolean;
  mapping: TagMapping;
  /** When the user previewed (the approval token's issue time): leads created after this were never part of what they saw. Falls back to the run start. */
  approvedAt?: string;
  /** The campaign's status when the run was approved: DRAFTED or PAUSED runs stop if the campaign is started under them. */
  startStatus: string;
}

export function readPushOptions(raw: Record<string, unknown> | undefined): PushRunOptions {
  const mapping: TagMapping = {};
  const m = raw?.mapping;
  if (m && typeof m === "object" && !Array.isArray(m)) for (const [k, v] of Object.entries(m)) if (typeof v === "string") mapping[k] = v;
  const approvedAt = typeof raw?.approvedAt === "string" && !Number.isNaN(Date.parse(raw.approvedAt)) ? raw.approvedAt : undefined;
  return { includeUnverified: raw?.includeUnverified === true, mapping, startStatus: typeof raw?.startStatus === "string" ? raw.startStatus.toUpperCase() : "", ...(approvedAt ? { approvedAt } : {}) };
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
  /** The operator's kill switch: checked before every batch; a true answer pauses the run (`disabled_by_operator`), it can be resumed later. */
  isDisabled?(): boolean;
  /**
   * Checked before every batch, after the kill switch: a reason (for example `connection_unshared`) pauses the run with it, null lets it go on.
   * Used for a teammate pushing through a shared connection, so un-sharing stops the run at the next batch, not only at the next start.
   */
  stillPermitted?(): Promise<string | null>;
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
/** The opt-out pre-scan reads the whole list once per execution; a list beyond this many pages is refused rather than half-scanned. */
const PRESCAN_PAGE_SIZE = 200;
const PRESCAN_MAX_PAGES = 500;

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
  // Emails of opted-out leads ANYWHERE in the list (found by a pre-scan), so a second record with the same address is not emailed
  // whichever side of the cursor, or of a restart, it sits on. A batch works on a COPY and it is kept only once the batch is
  // recorded: a failed batch is rebuilt from the same leads and must not find them already taken.
  let suppressedEmails = new Set<string>();
  let seenEmails = new Set<string>();

  const beat = async () => {
    if (!(await store.heartbeat(run.runId, epoch))) throw new LostLease();
  };
  // After a POST the leads are in Smartlead whatever happens to the lease, so they are ALWAYS marked: an unmarked lead would be missed
  // by AgentWeb's own-sender skip and by the opt-out withdrawal. This renews the lease when it can and never stops the marking.
  const beatQuiet = async () => {
    try {
      await store.heartbeat(run.runId, epoch);
    } catch {
      /* the marking goes on; the fenced cursor write after it reports a real store problem */
    }
  };
  const pause = async (reason: string): Promise<RunOutcome> => {
    await store.pauseRun(run.runId, reason, epoch);
    return { outcome: "paused", reason };
  };
  const failBatch = async (): Promise<RunOutcome | undefined> => {
    const failure = await store.recordBatchFailure(run.runId, epoch);
    if (!failure) return { outcome: "lost" };
    if (failure.partial) return { outcome: "partial" };
    await deps.sleep(BATCH_BACKOFF_MS[Math.min(failure.attempts - 1, BATCH_BACKOFF_MS.length - 1)]);
    return undefined;
  };

  try {
    await beat();
    // ── pre-scan: every opted-out address in the whole list
    {
      let after: LeadCursor | null = null;
      for (let pages = 0; ; pages++) {
        if (pages >= PRESCAN_MAX_PAGES) return await pause("list_too_large");
        if (pages > 0 && pages % 10 === 0) await beat();
        const page = await deps.readLeads(run.listId, after, PRESCAN_PAGE_SIZE);
        if (page.items.length === 0) break;
        for (const lead of page.items) {
          if (isDoNotContact(lead) && typeof lead.email === "string" && lead.email.trim()) suppressedEmails.add(lead.email.trim().toLowerCase());
        }
        after = { listId: run.listId, leadId: String(page.items[page.items.length - 1].leadId) };
        if (!page.hasMore) break;
      }
    }

    for (;;) {
      await beat();
      if (deps.isDisabled?.()) return await pause("disabled_by_operator");
      const refused = deps.stillPermitted ? await deps.stillPermitted() : null;
      if (refused) return await pause(refused);

      // The approved count is a hard ceiling: a lead that became eligible after the preview can never widen the approved set.
      if (run.previewEligible - (added + already) <= 0 || run.listExhausted) {
        // `listExhausted` is the store's "the walk is over": set here for a ceiling stop too, so the run can be completed.
        if (!(await store.advance(run.runId, epoch, { cursor: null, counts: {}, listExhausted: true }))) return { outcome: "lost" };
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
        if (error instanceof SmartleadApiError && (error.status === 401 || error.status === 403)) return await pause("key_rejected");
        const stop = await failBatch();
        if (stop) return stop;
        continue;
      }
      if (!campaign) return await pause("campaign_missing");
      if (campaignStatusDecision(campaign.status) === "refused") return await pause("campaign_not_pushable");
      if (options.startStatus !== "ACTIVE" && campaign.status === "ACTIVE") return await pause("campaign_started");
      const analysis = analyseSequence(sequenceReply);
      if (!analysis.readable) return await pause("sequence_unreadable");
      if (analysis.hash !== run.sequenceHash) return await pause("sequence_changed");

      const ctx = {
        campaignId: run.campaignId,
        tags: analysis.tags,
        mapping: options.mapping,
        includeUnverified: options.includeUnverified,
        // Pinned to the PREVIEW, not the start: a lead created or imported in between was never shown to the user.
        runStartedAt: options.approvedAt ?? run.startedAt,
      };

      // ── build one batch: whole pages only, so the cursor is exactly the last lead examined
      const seen = new Set(seenEmails);
      const suppressed = new Set(suppressedEmails);
      const eligible: ReturnType<typeof selectSmartleadLeads>["eligible"] = [];
      const skipped: Record<string, number> = {};
      // Leads THIS run already pushed and marked but never recorded (a crash, a lost lease, a failed batch): they are in Smartlead, the
      // cursor has not passed them, so they count toward the ceiling now and are not sent again.
      let ownMarked = 0;
      const room = () => Math.min(SMARTLEAD_LEADS_PER_REQUEST, run.previewEligible - (added + already) - ownMarked);
      let examined = 0;
      let batchCursor = cursor;
      let exhausted = false;
      for (let pages = 0; eligible.length < room() && !exhausted; pages++) {
        if (pages >= MAX_PAGES_PER_BATCH) break; // a huge run of skipped leads: record the progress and come back
        const page = await deps.readLeads(run.listId, batchCursor, Math.min(PAGE_SIZE, room() - eligible.length));
        if (page.items.length === 0) { exhausted = true; break; }
        const byId = new Map(page.items.map(l => [String(l.leadId), l]));
        const result = selectSmartleadLeads(page.items, { ...ctx, seenEmails: seen, suppressedEmails: suppressed });
        eligible.push(...result.eligible);
        for (const [reason, n] of Object.entries(result.counts)) add(skipped, reason, n);
        for (const sk of result.skipped) {
          if (sk.reason !== "already_pushed") continue;
          const marker = getSmartleadMarker(byId.get(String(sk.leadId)), run.campaignId);
          if (marker?.runId === run.runId && marker.state === "pushed") {
            ownMarked++;
            skipped.already_pushed -= 1; // counted as "already in the campaign", not as a skip
          }
        }
        examined += page.items.length;
        const last = page.items[page.items.length - 1];
        batchCursor = { listId: run.listId, leadId: String(last.leadId) };
        if (!page.hasMore) exhausted = true;
      }
      if (skipped.already_pushed === 0) delete skipped.already_pushed;

      // ── just before sending: re-read the leads with a CONSISTENT read and run the whole eligibility check again on what is there
      // now, so an opt-out, a bounce, an edited address or a concurrent push recorded a moment ago is honoured.
      await beat();
      const fresh = await mapWithConcurrency(eligible, 10, e => deps.readLeadConsistent(run.listId, String(e.lead.leadId)));
      const present = fresh.filter((l): l is Lead => !!l);
      add(skipped, "lead_missing", fresh.length - present.length);
      const recheck = selectSmartleadLeads(present, { ...ctx, seenEmails: new Set<string>(), suppressedEmails: new Set(suppressed) });
      for (const [reason, n] of Object.entries(recheck.counts)) add(skipped, reason, n);
      // A lead THIS run marked between the page read and now (an older worker of the same run finishing its marking) is in Smartlead:
      // it counts toward the ceiling like any other own marker, not as a skip.
      {
        const freshById = new Map(present.map(l => [String(l.leadId), l]));
        for (const sk of recheck.skipped) {
          if (sk.reason !== "already_pushed") continue;
          const marker = getSmartleadMarker(freshById.get(String(sk.leadId)), run.campaignId);
          if (marker?.runId === run.runId && marker.state === "pushed") {
            ownMarked++;
            skipped.already_pushed -= 1;
          }
        }
        if (skipped.already_pushed === 0) delete skipped.already_pushed;
      }
      const toSend = recheck.eligible;

      let batchAdded = 0;
      let batchAlready = 0;

      if (toSend.length > 0) {
        // The run is read strongly right before the POST: a pause or cancel between the last fenced write and now is seen here.
        await beat();
        const live = await store.getRun(run.runId);
        if (!live || live.status !== "running" || live.leaseEpoch !== epoch) return { outcome: "lost" };

        let result: SmartleadAddLeadsResult;
        try {
          result = await smartlead.addLeads(toSend.map(e => e.input));
        } catch (error) {
          deps.onSmartleadError?.(error);
          if (error instanceof SmartleadApiError && (error.status === 401 || error.status === 403)) return await pause("key_rejected");
          // Not applied, or applied and unknown: either way the batch is rebuilt and sent again, and Smartlead's per-lead answer converges it.
          const stop = await failBatch();
          if (stop) return stop;
          continue;
        }
        await beatQuiet();

        // Without the per-lead map nothing can be marked, and an unmarked lead would be pushed again: stop for a human.
        if (!result.leads) return await pause("no_lead_map");

        // A lead is marked only when Smartlead names it as in THIS campaign.
        const idByEmail = new Map<string, string>();
        for (const group of [result.leads.newlyAdded, result.leads.existingInCampaign]) {
          for (const [email, id] of Object.entries(group ?? {})) idByEmail.set(email.toLowerCase(), String(id));
        }
        // The push asks Smartlead to SKIP a lead that is already in another of the account's campaigns (verified live 2026-10-28): such a
        // lead is listed under "existing in other campaigns" and counted in skipped_in_other_campaign_count, and it is NOT in this campaign.
        const otherMapEmails = new Set(Object.keys(result.leads.existingInOtherCampaigns ?? {}).map(e => e.toLowerCase()));
        const invalid = new Set(result.invalidEmails.map(e => e.toLowerCase()));
        const unsubscribed = new Set(result.unsubscribedEmails.map(e => e.toLowerCase()));

        const toMark: Array<{ leadId: string; marker: SmartleadMarker }> = [];
        let missing = 0;
        // Leads Smartlead listed under "other campaigns" and did not put in this one: skipped because they are in another campaign, as long
        // as its own tally covers every one of them. If it does not, whether they were added is unknown, and a lead that WAS added without a
        // marker would be invisible to the opt-out safeguards, so the run stops for a human.
        let inOther = 0;
        let namedInvalid = 0;
        let namedUnsubscribed = 0;
        for (const e of toSend) {
          const email = e.input.email.toLowerCase();
          const smartleadLeadId = idByEmail.get(email);
          if (smartleadLeadId) toMark.push({ leadId: String(e.lead.leadId), marker: buildSmartleadMarker({ runId: run.runId, payloadHash: e.payloadHash, smartleadLeadId, email: e.input.email, now: deps.now() }) });
          else if (invalid.has(email)) { add(skipped, "smartlead_invalid"); namedInvalid++; }
          else if (unsubscribed.has(email)) { add(skipped, "smartlead_unsubscribed"); namedUnsubscribed++; }
          else if (otherMapEmails.has(email)) inOther++;
          else missing++;
        }

        // Mark every lead BEFORE the cursor moves, even if this worker lost the run meanwhile (only the cursor write is fenced).
        // One that cannot be marked stops the batch: it is rebuilt and resent next time, which Smartlead answers as "already in the
        // campaign", so nothing is added twice.
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
          const stop = await failBatch();
          if (stop) return stop;
          continue;
        }

        // Smartlead stopped importing because the account's lead limit is used up: the leads it refused are not in the map and are
        // not recorded as skipped. Stop WITHOUT moving the cursor, so a resume (after the customer raises the limit) rebuilds the
        // batch, skips what is marked and sends the rest.
        if (result.limitExhausted) return await pause("smartlead_lead_limit");
        // Smartlead added (or found already here) more leads than it NAMED in this campaign: one of them is in the campaign without an id, so
        // it cannot be marked and the opt-out safeguards could not see it. Never explain that away with a tally: stop (a human looks when
        // "other campaigns" leads are involved), else retry the batch.
        const namedNew = Object.keys(result.leads.newlyAdded ?? {}).length;
        const namedExisting = Object.keys(result.leads.existingInCampaign ?? {}).length;
        if (result.added > namedNew || result.alreadyInCampaign > namedExisting) {
          if (inOther > 0) return await pause("other_campaign_leads");
          const stop = await failBatch();
          if (stop) return stop;
          continue;
        }
        // ...and only when Smartlead's own tally covers every lead it listed under "other campaigns" (verified live 2026-10-28: a lead that is
        // in THIS campaign as well is named under existing leads instead, so it is marked above).
        if (inOther > result.skippedBy.inOtherCampaign) return await pause("other_campaign_leads");
        if (inOther > 0) add(skipped, "smartlead_in_other_campaign", inOther);

        // A lead Smartlead did not name is only acceptable when its own tallies explain it (block list, bounce, duplicate...).
        // Otherwise it may be in the campaign without a marker, which the opt-out safeguards could not see: stop and retry.
        const tallies = result.skippedBy;
        const explained =
          // The other-campaign tally never explains an UNNAMED lead: Smartlead names every lead it skips for that (verified live), so it is matched
          // to those names above and is not room to excuse anything else.
          tallies.blockList + tallies.bounced + tallies.importStopped + tallies.duplicate +
          Math.max(0, tallies.unsubscribed - namedUnsubscribed) + Math.max(0, tallies.invalidEmail - namedInvalid);
        if (missing > explained) {
          const stop = await failBatch();
          if (stop) return stop;
          continue;
        }
        add(skipped, "smartlead_skipped", missing);

        batchAdded = result.added;
        batchAlready = result.alreadyInCampaign;
      }

      // ── record the batch: this fenced write is what moves the run on
      const finished = exhausted || added + batchAdded + already + batchAlready + ownMarked >= run.previewEligible;
      const ok = await store.advance(run.runId, epoch, {
        cursor: batchCursor,
        counts: { examined, added: batchAdded, alreadyInCampaign: batchAlready + ownMarked },
        skipped,
        ...(finished ? { listExhausted: true } : {}),
      });
      if (!ok) return { outcome: "lost" };
      cursor = batchCursor;
      seenEmails = seen;
      suppressedEmails = suppressed;
      added += batchAdded;
      already += batchAlready + ownMarked;

      if (finished) return (await store.finishRun(run.runId, epoch, "completed")) ? { outcome: "completed" } : { outcome: "lost" };
    }
  } catch (error) {
    if (error instanceof LostLease) return { outcome: "lost" };
    throw error; // a store error: fail closed, the lease lapses and the resumer decides
  }
}
