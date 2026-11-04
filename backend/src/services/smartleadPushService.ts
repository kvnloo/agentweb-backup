import { executeRun, type EngineDeps } from "./smartleadPushEngine";
import { buildPreview, PreviewError, type PreviewDeps, type PreviewResult } from "./smartleadPushPreview";
import { verifyPushToken } from "./smartleadPushToken";
import { campaignStatusDecision, preflightSequence } from "./smartleadPreflight";
import { analyseSequence } from "./smartleadSequence";
import type { ResolvedSmartlead } from "./smartleadConnection";
import {
  SmartleadPushRunStoreError,
  newWorkerId,
  type LeadCursor,
  type PushRun,
  type PushRunSummary,
  type SmartleadPushRunDb,
} from "./smartleadPushRunDb";
import type { SmartleadAddLeadsResult, SmartleadCampaignAnalytics, SmartleadCampaignDetail, SmartleadCampaignSummary, SmartleadEmailAccount, SmartleadLeadInput } from "./smartleadService";
import { SmartleadApiError, scrubSmartleadSecrets, type UnsubscribeOutcome, type UpdateLeadEmailOutcome } from "./smartleadService";
import { listSmartleadMarkers } from "./smartleadMarkers";
import { withdrawalSweep, type SweepResult } from "./smartleadWithdrawal";
import { isDoNotContact } from "../utils/leadContactStatus";

/**
 * The service behind the Smartlead push routes and the resumer (ENG-673): who may push, which key is used, starting a run, controlling it,
 * and the background worker. Every outside dependency is injected (smartleadPushRuntime.ts builds the real ones), so it is tested without
 * a network or a database. Results are plain `{ok}` objects that carry an HTTP status; the routes only translate them.
 *
 * The push uses the pusher's own Smartlead connection, else the one a teammate shared with the org (owner decision 2026-10-28); `keyOwnerId`
 * on the run records whose connection it was, and the worker and the withdrawal sweep keep using that owner's key.
 */

type Lead = Record<string, any>;
type Fail = { ok: false; status: number; code: string; message: string; details?: unknown };
type Ok<T> = { ok: true } & T;
export type Result<T> = Ok<T> | Fail;

const fail = (status: number, code: string, message: string, details?: unknown): Fail => ({ ok: false, status, code, message, ...(details !== undefined ? { details } : {}) });

export interface SmartleadApi {
  listCampaigns(apiKey: string): Promise<SmartleadCampaignSummary[]>;
  getCampaign(apiKey: string, campaignId: number): Promise<SmartleadCampaignDetail | null>;
  getCampaignAnalytics(apiKey: string, campaignId: number): Promise<SmartleadCampaignAnalytics | null>;
  getSequences(apiKey: string, campaignId: number): Promise<unknown[]>;
  getMailboxes(apiKey: string, campaignId: number): Promise<SmartleadEmailAccount[]>;
  addLeads(apiKey: string, campaignId: number, leads: SmartleadLeadInput[]): Promise<SmartleadAddLeadsResult>;
  unsubscribeLead(apiKey: string, smartleadLeadId: string): Promise<UnsubscribeOutcome>;
  updateLeadEmail(apiKey: string, campaignId: number, smartleadLeadId: string, email: string): Promise<UpdateLeadEmailOutcome>;
  findLeadId(apiKey: string, email: string): Promise<string | null>;
}

export interface PushServiceDeps {
  db: SmartleadPushRunDb;
  getList(listId: string): Promise<Lead | null>;
  canEdit(userId: string, list: Lead): Promise<boolean>;
  resolveKey(userId: string, accountId?: string): Promise<ResolvedSmartlead>;
  reportFailure(resolved: Extract<ResolvedSmartlead, { ok: true }>, error: unknown): Promise<unknown>;
  crm: {
    readLeads(listId: string, after: LeadCursor | null, limit: number): Promise<{ items: Lead[]; hasMore: boolean }>;
    readLeadConsistent(listId: string, leadId: string): Promise<Lead | null>;
    writeMarker: EngineDeps["writeMarker"];
  };
  smartlead: SmartleadApi;
  /**
   * Puts AgentWeb's event webhook (replies, bounces, unsubscribes) on the campaign before a run starts adding contacts (ENG-673, slice 3). Optional
   * and best effort: it never delays or stops a push, and the opt-out sweep and the hourly fallback cover a missed registration.
   */
  registerEvents?(apiKey: string, accountId: string, campaignId: number): Promise<unknown>;
  secret: string;
  /** The kill switch. When false nothing starts, resumes or runs; pausing and canceling stay possible. */
  enabled(): boolean;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Keeps a background job visible to the shutdown drain (cronJobRegistry.track). */
  track<T>(name: string, job: Promise<T>): Promise<T>;
  log(line: string): void;
  workerId?: string;
  /** Runs one process works at once; a run past this waits for the resumer. */
  maxConcurrentWorkers?: number;
}

/** A run left paused or partial this long is canceled by the resumer, so it cannot hold its lock for ever. */
export const STALE_PAUSED_MS = 7 * 24 * 60 * 60 * 1000;
const RESUMER_BATCH = 100;
/** A run with no lock is only called an orphan once its lease lapsed by this much. */
const ORPHAN_GRACE_MS = 30_000;
const MAX_CONCURRENT_PREVIEWS = 3;
const MAX_RELEASE_LEADS = 500;
/** How long a consumed approval is remembered: longer than the token itself, so an expired token can never be claimed again. */
const TOKEN_MEMORY_SECONDS = 2 * 60 * 60;

/** Which Smartlead account a screen or card is about: its saved name, and whether it is a teammate's shared connection rather than the caller's own. */
export interface ConnectionView {
  accountId: string;
  name: string;
  shared: boolean;
}

export interface RunView {
  runId: string;
  status: string;
  pauseReason?: string;
  listId: string;
  campaignId: number;
  campaignName: string;
  counts: PushRun["counts"];
  /** What Smartlead later reported about this run's contacts; absent until something was reported. */
  events?: PushRun["events"];
  approved: number;
  startedAt: string;
  finishedAt?: string;
  failure?: PushRun["failure"];
  warnings: string[];
}

export function toRunView(run: PushRun): RunView {
  const warnings = Array.isArray((run.options as any)?.warnings) ? ((run.options as any).warnings as unknown[]).filter((w): w is string => typeof w === "string") : [];
  return {
    runId: run.runId, status: run.status, ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}), listId: run.listId, campaignId: run.campaignId, campaignName: run.campaignName,
    counts: run.counts, ...(run.events ? { events: run.events } : {}), approved: run.previewEligible, startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), ...(run.failure ? { failure: run.failure } : {}), warnings,
  };
}

/** A preview could not take one of the few whole-list slots. */
class BusyError extends Error {}

export class SmartleadPushService {
  private active = 0;
  private previewsRunning = 0;
  /** Runs whose start failed ambiguously and which must be cancelled; retried every resumer tick until confirmed (even while switched off). */
  private readonly pendingCancels = new Set<string>();
  private readonly workerId: string;

  constructor(private readonly deps: PushServiceDeps) {
    this.workerId = deps.workerId ?? newWorkerId();
  }

  // ── access

  private async ownList(userId: string, listId: unknown): Promise<Result<{ list: Lead }>> {
    if (typeof listId !== "string" || !listId) return fail(400, "bad_request", "A list is required.");
    const list = await this.deps.getList(listId);
    if (!list) return fail(404, "list_not_found", "That list does not exist.");
    if (!(await this.deps.canEdit(userId, list))) return fail(403, "forbidden", "You need edit access to this list to push it to Smartlead.");
    return { ok: true, list };
  }

  /** Whether the user may push this list (edit access), and its name; used to refuse before an approval is asked for. */
  async canUseList(userId: string, listId: unknown): Promise<Result<{ listName: string }>> {
    return this.guard(async () => {
      const list = await this.ownList(userId, listId);
      if (!list.ok) return list;
      return { ok: true as const, listName: typeof list.list.name === "string" ? list.list.name : "" };
    });
  }

  /** A few of the contacts' email addresses, for an approval card that must show WHO it is about. Edit access to the list is required. */
  async sampleLeads(userId: string, listId: unknown, leadIds: string[], max = 3): Promise<Result<{ emails: string[] }>> {
    return this.guard(async () => {
      const list = await this.ownList(userId, listId);
      if (!list.ok) return list;
      const emails: string[] = [];
      for (const id of [...new Set(leadIds)]) {
        if (emails.length >= max) break;
        const lead = await this.deps.crm.readLeadConsistent(String(listId), id);
        if (lead && typeof lead.email === "string" && lead.email.trim()) emails.push(lead.email.trim());
      }
      return { ok: true as const, emails };
    });
  }

  /**
   * The Smartlead connection a push uses: the caller's own first, else the single one a teammate shared with the org (owner decision
   * 2026-10-28: a key is stored per user and shareable among the org, so anybody in the org may push, release and control pushes through
   * the portal and Emma). Several candidates and none clearly the caller's are never guessed between: the caller picks one by `accountId`.
   */
  private async resolveConnection(userId: string, accountId?: string): Promise<Result<{ key: Extract<ResolvedSmartlead, { ok: true }> }>> {
    let resolved = await this.deps.resolveKey(userId, accountId);
    if (!resolved.ok && resolved.reason === "choose") {
      // Several connections: only a single OWN one is unambiguous. Never pick between several (the user chooses by account id).
      const own = resolved.candidates.filter(c => c.ownerUserId === userId);
      if (own.length === 1) resolved = await this.deps.resolveKey(userId, own[0].accountId);
    }
    if (!resolved.ok) {
      if (resolved.reason === "not_connected") return fail(409, "not_connected", resolved.message);
      if (resolved.reason === "choose") return fail(409, "choose_connection", resolved.message, resolved.candidates.map(c => ({ accountId: c.accountId, accountName: c.accountName ?? "", shared: c.ownerUserId !== userId })));
      return fail(422, resolved.reason, resolved.message);
    }
    return { ok: true, key: resolved };
  }

  /** What the screen and the approval card say about the connection in use. */
  private connectionOf(userId: string, key: Extract<ResolvedSmartlead, { ok: true }>): ConnectionView {
    return { accountId: key.accountId, name: key.accountName, shared: key.ownerUserId !== userId };
  }

  private async runFor(userId: string, runId: unknown): Promise<Result<{ run: PushRun }>> {
    if (typeof runId !== "string" || !runId) return fail(400, "bad_request", "A run is required.");
    const run = await this.deps.db.getRun(runId);
    if (!run) return fail(404, "run_not_found", "That push run does not exist.");
    if (run.ownerId !== userId) {
      const list = await this.deps.getList(run.listId);
      if (!list || !(await this.deps.canEdit(userId, list))) return fail(404, "run_not_found", "That push run does not exist."); // never confirm it exists
    }
    return { ok: true, run };
  }

  private guard<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    return fn().catch((error: unknown): Fail => {
      if (error instanceof SmartleadPushRunStoreError) {
        this.deps.log(`[SmartleadPush] store ${error.code}: ${error.message}`);
        return fail(503, "unavailable", "Smartlead pushing is temporarily unavailable. Nothing was sent. Try again shortly.");
      }
      if (error instanceof PreviewError) {
        const status = error.code === "campaign_not_found" ? 404 : error.code === "campaign_not_pushable" ? 409 : 400;
        return fail(status, error.code, error.message);
      }
      if (error instanceof BusyError) return fail(429, "busy", "Several previews are running. Try again in a moment.");
      if (error instanceof SmartleadApiError) {
        // Tell a bad key from a refusal from an outage; nothing was sent in any case.
        if (error.status === 401) return fail(422, "key_rejected", "Smartlead rejected the saved API key (revoked, or the plan no longer includes API access). Replace the key in Settings, Login Credentials.");
        if (error.status === 403) return fail(422, "smartlead_forbidden", "Smartlead refused this request: the key may not have access to that campaign, or the plan may not include API access.");
        if (error.status === 429) return fail(429, "smartlead_rate_limited", "Smartlead is rate-limiting requests. Try again in a minute.");
        if (error.status !== undefined && error.status >= 400 && error.status < 500) return fail(422, "smartlead_rejected_request", "Smartlead did not accept the request. Check the campaign and try again.");
        return fail(502, "smartlead_unavailable", "Smartlead could not be reached or answered unexpectedly. Nothing was sent. Try again shortly.");
      }
      throw error;
    });
  }

  private disabled = (): Fail => fail(503, "disabled", "Pushing to Smartlead is switched off at the moment.");

  // ── preview

  preview(userId: string, body: Record<string, any>): Promise<Result<{ preview: PreviewResult & { connection: ConnectionView } }>> {
    return this.guard(async () => {
      if (!this.deps.enabled()) return this.disabled();
      const campaignId = Number(body.campaignId);
      const list = await this.ownList(userId, body.listId);
      if (!list.ok) return list;
      const key = await this.resolveConnection(userId, typeof body.accountId === "string" ? body.accountId : undefined);
      if (!key.ok) return key;
      const apiKey = key.key.apiKey;
      if (!Number.isInteger(campaignId) || campaignId <= 0) return fail(400, "bad_request", "A campaign is required.");
      // Turn a preview away BEFORE it spends the customer's Smartlead quota when every whole-list slot is taken (the slot itself is taken at the read).
      if (this.previewsRunning >= MAX_CONCURRENT_PREVIEWS) throw new BusyError();
      let slotHeld = false;
      const previewDeps: PreviewDeps = {
        // A preview holds a whole list in memory: only a few at once per process. The slot is taken at the first list read, so slow
        // Smartlead calls before it do not occupy one.
        readLeads: async (l, a, n) => {
          if (!slotHeld) {
            if (this.previewsRunning >= MAX_CONCURRENT_PREVIEWS) throw new BusyError();
            this.previewsRunning++;
            slotHeld = true;
          }
          return this.deps.crm.readLeads(l, a, n);
        },
        getCampaign: () => this.smartleadCall(key.key, () => this.deps.smartlead.getCampaign(apiKey, campaignId)),
        getSequences: () => this.smartleadCall(key.key, () => this.deps.smartlead.getSequences(apiKey, campaignId)),
        getCampaignMailboxes: () => this.deps.smartlead.getMailboxes(apiKey, campaignId),
        now: () => this.deps.now(),
        secret: this.deps.secret,
      };
      const preview = await buildPreview(previewDeps, {
        listId: body.listId, campaignId, userId, accountId: key.key.accountId, includeUnverified: body.includeUnverified === true, mapping: body.mapping && typeof body.mapping === "object" ? body.mapping : undefined,
        acknowledgedTags: Array.isArray(body.acknowledgedTags) ? body.acknowledgedTags : undefined, acknowledgeUnreadable: body.acknowledgeUnreadable === true,
        cohort: body.cohort === undefined || body.cohort === null ? undefined : Number(body.cohort),
      }).finally(() => { if (slotHeld) this.previewsRunning--; });
      return { ok: true, preview: { ...preview, connection: this.connectionOf(userId, key.key) } };
    });
  }

  /** A Smartlead call on the user's screen: a rejected key is reported (and flagged after a confirming probe), then the error goes on. */
  private async smartleadCall<T>(key: Extract<ResolvedSmartlead, { ok: true }>, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      void this.deps.reportFailure(key, error).catch(() => undefined);
      throw error;
    }
  }

  /** The user's own Smartlead campaigns for the picker, each marked with whether leads can be added to it. */
  campaigns(userId: string, accountId?: string): Promise<Result<{ connection: ConnectionView; campaigns: Array<{ id: number; name: string; status: string; pushable: boolean; needsConfirmation: boolean }> }>> {
    return this.guard(async () => {
      if (!this.deps.enabled()) return this.disabled();
      const key = await this.resolveConnection(userId, accountId);
      if (!key.ok) return key;
      const rows = await this.smartleadCall(key.key, () => this.deps.smartlead.listCampaigns(key.key.apiKey));
      return {
        ok: true,
        connection: this.connectionOf(userId, key.key),
        campaigns: rows.map(c => {
          const decision = campaignStatusDecision(c.status);
          return { id: c.id, name: c.name, status: c.status, pushable: decision !== "refused", needsConfirmation: decision === "needs_confirmation" };
        }),
      };
    });
  }

  /** Read-only counters for one of the user's campaigns (ENG-2737). Nothing is changed in Smartlead or in the CRM. */
  campaignStats(userId: string, campaignId: number, accountId?: string): Promise<Result<{ connection: ConnectionView; stats: SmartleadCampaignAnalytics }>> {
    return this.guard(async () => {
      if (!this.deps.enabled()) return this.disabled();
      if (!Number.isInteger(campaignId) || campaignId <= 0) return fail(400, "bad_request", "A campaign is required.");
      const key = await this.resolveConnection(userId, accountId);
      if (!key.ok) return key;
      const stats = await this.smartleadCall(key.key, () => this.deps.smartlead.getCampaignAnalytics(key.key.apiKey, campaignId));
      if (!stats) return fail(404, "campaign_not_found", "That campaign was not found in the connected Smartlead account.");
      return { ok: true, connection: this.connectionOf(userId, key.key), stats };
    });
  }

  // ── releasing leads, and the withdrawal sweep

  /**
   * A list editor clears the Smartlead marker of leads, so AgentWeb's own senders may email them again (a mistaken push must not block a contact
   * for ever). It changes nothing in Smartlead: a lead still in an ACTIVE campaign is then emailed from two places, and the dialog says so.
   */
  release(userId: string, body: Record<string, any>): Promise<Result<{ released: number; skipped: { notFound: number; nothingToRelease: number; doNotContact: number } }>> {
    return this.guard(async () => {
      const list = await this.ownList(userId, body.listId);
      if (!list.ok) return list;
      const ids = body.leadIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_RELEASE_LEADS || ids.some((id: unknown) => typeof id !== "string" || !id || id.length > 200)) {
        return fail(400, "bad_request", `Give between 1 and ${MAX_RELEASE_LEADS} lead ids.`);
      }
      const only = body.campaignId === undefined || body.campaignId === null ? undefined : Number(body.campaignId);
      if (only !== undefined && (!Number.isInteger(only) || only <= 0)) return fail(400, "bad_request", "The campaign must be a positive whole number.");
      const result = { released: 0, skipped: { notFound: 0, nothingToRelease: 0, doNotContact: 0 } };
      const at = this.deps.now().toISOString();
      for (const leadId of ids as string[]) {
        const lead = await this.deps.crm.readLeadConsistent(String(body.listId), leadId);
        if (!lead) { result.skipped.notFound++; continue; }
        // A lead that is do-not-contact is not released: AgentWeb's own senders skip it anyway, and the withdrawal sweep must keep stopping it
        // in Smartlead (releasing would only churn the marker, and a withdrawn marker keeps AgentWeb off a lead that is later re-subscribed).
        if (isDoNotContact(lead)) { result.skipped.doNotContact++; continue; }
        const live = listSmartleadMarkers(lead).filter(m => (only === undefined || m.campaignId === only) && (m.marker.state === "pushed" || m.marker.state === "withdrawn"));
        if (live.length === 0) { result.skipped.nothingToRelease++; continue; }
        for (const m of live) await this.deps.crm.writeMarker(String(body.listId), leadId, m.key, { ...m.marker, state: "released", releasedAt: at, releasedBy: userId });
        result.released++;
      }
      this.deps.log(`[SmartleadPush] released ${result.released} lead(s) in list=${body.listId} by=${userId}`);
      return { ok: true, ...result };
    });
  }

  /** The hourly withdrawal sweep (smartleadWithdrawal.ts). Runs whether or not pushing is switched on: stopping pushes must never stop opt-outs. Never throws. */
  async sweepWithdrawals(): Promise<SweepResult | null> {
    try {
      return await withdrawalSweep({
        db: this.deps.db,
        resolveKey: (u, a) => this.deps.resolveKey(u, a),
        reportFailure: (r, e) => this.deps.reportFailure(r, e),
        readLeads: (l, a, n) => this.deps.crm.readLeads(l, a, n),
        readLeadConsistent: (l, id) => this.deps.crm.readLeadConsistent(l, id),
        writeMarker: (l, id, k, m) => this.deps.crm.writeMarker(l, id, k, m),
        smartlead: {
          campaignVisible: async (apiKey, campaignId) => (await this.deps.smartlead.getCampaign(apiKey, campaignId)) !== null,
          unsubscribe: (apiKey, id) => this.deps.smartlead.unsubscribeLead(apiKey, id),
          updateLeadEmail: (apiKey, campaignId, id, email) => this.deps.smartlead.updateLeadEmail(apiKey, campaignId, id, email),
          findLeadId: (apiKey, email) => this.deps.smartlead.findLeadId(apiKey, email),
        },
        now: () => this.deps.now(),
        log: line => this.deps.log(line),
      });
    } catch (error) {
      this.deps.log(`[SmartleadWithdrawal] sweep error: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
      return null;
    }
  }

  // ── start

  start(userId: string, body: Record<string, any>, opts: { channel?: "ui" | "agent" } = {}): Promise<Result<{ run: RunView; started: true } | { run: RunView; started: false }>> {
    return this.guard(async () => {
      if (!this.deps.enabled()) return this.disabled();
      const token = verifyPushToken(this.deps.secret, body.token, this.deps.now().getTime());
      if (!token || token.userId !== userId) return fail(400, "invalid_token", "This approval has expired or is not valid. Preview the push again.");
      if (body.acknowledgements?.lawfulBasis !== true) return fail(400, "acknowledgement_required", "Confirm that you have a lawful basis to email these contacts.");

      const list = await this.ownList(userId, token.listId);
      if (!list.ok) return list;
      // The connection the preview used, never one named in the start request.
      const key = await this.resolveConnection(userId, token.accountId);
      if (!key.ok) return key;
      if (key.key.accountId !== token.accountId) return fail(409, "connection_changed", "Your Smartlead connection changed after you previewed. Preview again.");
      const apiKey = key.key.apiKey;

      // What was approved must still be true: the same sequence, a campaign that was not started under a draft approval, no new blocks.
      const campaign = await this.smartleadCall(key.key, () => this.deps.smartlead.getCampaign(apiKey, token.campaignId));
      if (!campaign) return fail(404, "campaign_not_found", "That campaign no longer exists in Smartlead.");
      const decision = campaignStatusDecision(campaign.status);
      if (decision === "refused") return fail(409, "campaign_not_pushable", `Leads cannot be added to a ${campaign.status || "unknown"} campaign.`);
      if (token.startStatus !== "ACTIVE" && campaign.status === "ACTIVE") return fail(409, "campaign_started_since_preview", "This campaign was started after you previewed. Preview again and confirm.");
      if (campaign.status === "ACTIVE" && body.acknowledgements?.activeConfirmed !== true) return fail(400, "active_confirmation_required", "This campaign is already sending. Confirm that leads should start receiving mail at once.");
      const analysis = analyseSequence(await this.smartleadCall(key.key, () => this.deps.smartlead.getSequences(apiKey, token.campaignId)));
      if (analysis.hash !== token.sequenceHash) return fail(409, "sequence_changed", "The campaign's sequence changed after you previewed. Preview again.");
      const preflight = preflightSequence(analysis, { status: campaign.status, mapping: token.mapping, acknowledgedTags: token.acknowledgedTags, acknowledgeUnreadable: token.acknowledgeUnreadable, addUnsubscribeTag: campaign.addUnsubscribeTag, unsubscribeText: campaign.unsubscribeText });
      if (preflight.blocks.length > 0) return fail(409, "blocked", "The campaign cannot be pushed to as it stands.", preflight.blocks);
      // A campaign that is already sending and whose emails carry no unsubscribe link: people would be emailed with no way to opt out, so the user accepts that in words.
      if (decision === "needs_confirmation" && preflight.missingUnsubscribe && body.acknowledgements?.noUnsubscribeAccepted !== true) {
        return fail(400, "unsubscribe_acknowledgement_required", "This campaign is already sending and its emails have no unsubscribe link. Confirm that contacts may receive them without one, or set the unsubscribe text in Smartlead first.");
      }
      if (token.eligible < 1) return fail(400, "nothing_to_push", "There is nothing to push.");

      // The approval is single use: replaying it would push another cohort (earlier runs' markers do not count toward a new run's ceiling).
      if (!(await this.deps.db.claimToken(token.jti, TOKEN_MEMORY_SECONDS))) {
        // A double submit: the winner may not have recorded its run yet, so wait a moment, then fall back to the run holding the lock.
        let spentOn = await this.deps.db.getTokenRun(token.jti);
        for (let i = 0; i < 5 && !spentOn; i++) {
          await this.deps.sleep(100);
          spentOn = await this.deps.db.getTokenRun(token.jti);
        }
        if (!spentOn) spentOn = (await this.deps.db.getLock(token.listId, token.campaignId))?.runId ?? null;
        const existing = spentOn ? await this.deps.db.getRun(spentOn) : null;
        if (existing) return { ok: true, started: false, run: toRunView(existing) };
        return fail(409, "token_used", "This approval was already used. Preview again to push more.");
      }
      // Another run on this list and campaign since the preview (a second preview approved too, or an editor pushed) makes the approval stale:
      // it was sized for a list in which nothing had been pushed yet.
      const since = new Date(token.iat).toISOString();
      let recent;
      try {
        recent = await this.deps.db.listRunsForList(token.listId, 25);
      } catch (error) {
        await this.deps.db.releaseToken(token.jti).catch(() => undefined); // nothing has started, so the approval can safely be given back
        throw error;
      }
      if (recent.some(r => r.campaignId === token.campaignId && (r.createdAt ?? "") >= since)) {
        return fail(409, "changed_since_preview", "Another push to this campaign started after you previewed. Preview again.");
      }
      let started: Awaited<ReturnType<SmartleadPushRunDb["startRun"]>>;
      try {
        started = await this.deps.db.startRun(
        {
          ownerId: String(list.list.userId ?? userId), pushedBy: userId, keyOwnerId: key.key.ownerUserId, smartleadAccountId: key.key.accountId, channel: opts.channel === "agent" ? "agent" : "ui", listId: token.listId,
          campaignId: token.campaignId, campaignName: campaign.name, campaignSource: "selected",
          options: {
            includeUnverified: token.includeUnverified, mapping: token.mapping, acknowledgedTags: token.acknowledgedTags, startStatus: token.startStatus, warnings: token.warnings,
            approvedAt: new Date(token.iat).toISOString(),
            acknowledgements: { lawfulBasis: true, ...(campaign.status === "ACTIVE" ? { activeConfirmed: true } : {}), ...(decision === "needs_confirmation" && preflight.missingUnsubscribe ? { noUnsubscribeAccepted: true } : {}) },
          },
          sequenceHash: token.sequenceHash, previewEligible: token.eligible,
        },
        this.workerId,
      );
      } catch (error) {
        // A start that could not settle whether its run is live: keep cancelling THAT run until it is confirmed dead.
        if (error instanceof SmartleadPushRunStoreError && error.runId) this.pendingCancels.add(error.runId);
        // NOT released: a store error can arrive after the run was written (the reply was lost), and handing the approval back would let it
        // start a second run. Losing an approval is the safe direction: the user previews again.
        throw error;
      }
      if (!started.started) {
        await this.deps.db.releaseToken(token.jti).catch(() => undefined);
        if (started.existing) return { ok: true, started: false, run: toRunView(started.existing) };
        return fail(409, "lock_held", "A previous push left this list and campaign locked. Ask support to release it.");
      }
      // The start is now known to have succeeded: only from here may the run be claimed like any other. If this write fails the run stays
      // unconfirmed, the resumer will cancel it once its lease lapses, and the user simply previews again (the safe direction).
      // Retried a few times. If it still can not be confirmed the user is told the start FAILED, no worker is started, and the run is
      // cancelled (now if possible, else by the resumer): "told failed" and "cancelled" are the only combination.
      let confirmed = false;
      for (let attempt = 0; attempt < 4 && !confirmed; attempt++) {
        try {
          confirmed = await this.deps.db.confirmStart(started.run.runId); // false: the run is no longer running (the resumer cancelled it)
          if (!confirmed) break;
        } catch (error) {
          this.deps.log(`[SmartleadPush] could not confirm start of run=${started.run.runId}: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
          if (attempt < 3) await this.deps.sleep(50 * 4 ** attempt);
        }
      }
      if (!confirmed) {
        this.pendingCancels.add(started.run.runId);
        await this.deps.db.cancelRun(started.run.runId).then(() => this.pendingCancels.delete(started.run.runId)).catch(() => undefined);
        return fail(503, "unavailable", "Smartlead pushing is temporarily unavailable. Nothing was sent. Try again shortly.");
      }
      await this.deps.db.setTokenRun(token.jti, started.run.runId).catch(() => undefined);
      this.deps.log(`[SmartleadPush] started run=${started.run.runId} user=${userId} list=${token.listId} campaign=${token.campaignId} approved=${token.eligible} status=${campaign.status}`);
      this.spawn(started.run);
      return { ok: true, started: true, run: toRunView(started.run) };
    });
  }

  // ── status and control

  status(userId: string, runId: unknown): Promise<Result<{ run: RunView }>> {
    return this.guard(async () => {
      const r = await this.runFor(userId, runId);
      return r.ok ? { ok: true, run: toRunView(r.run) } : r;
    });
  }

  history(userId: string, listId: unknown): Promise<Result<{ runs: PushRunSummary[] }>> {
    return this.guard(async () => {
      const list = await this.ownList(userId, listId);
      if (!list.ok) return list;
      const runs = await this.deps.db.listRunsForList(String(listId), 25);
      // The history indexes do not carry the event counters (a projection cannot change on a table that exists), so they are read from the
      // runs themselves, one small read each. Display only: a run whose read fails is listed without them, never dropped.
      const withEvents = await Promise.all(runs.map(async (r) => {
        try {
          const events = await this.deps.db.getRunEvents(r.runId);
          return events ? { ...r, events } : r;
        } catch {
          return r;
        }
      }));
      return { ok: true, runs: withEvents };
    });
  }

  pause(userId: string, runId: unknown): Promise<Result<{ run: RunView }>> {
    return this.guard(async () => {
      const r = await this.runFor(userId, runId);
      if (!r.ok) return r;
      if (!(await this.deps.db.pauseRun(r.run.runId, "user"))) return fail(409, "not_running", "This push is not running.");
      return { ok: true, run: toRunView((await this.deps.db.getRun(r.run.runId)) ?? r.run) };
    });
  }

  resume(userId: string, runId: unknown): Promise<Result<{ run: RunView }>> {
    return this.guard(async () => {
      if (!this.deps.enabled()) return this.disabled();
      const r = await this.runFor(userId, runId);
      if (!r.ok) return r;
      if (r.run.status !== "paused" && r.run.status !== "partial") return fail(409, "not_paused", "This push is not paused.");
      if (r.run.startUnconfirmed) {
        // A start that was never confirmed to anyone (it was reported as failed): resuming it would send what the user was told did not start.
        await this.deps.db.cancelRun(r.run.runId);
        return fail(409, "start_unconfirmed", "This push never finished starting, so it was cancelled. Preview again to push.");
      }
      // A teammate's push whose connection is no longer shared with that teammate cannot be resumed by anyone (the worker would pause it again at
      // once): share it again, or cancel and push afresh.
      if ((await this.sharingVerdict(r.run)) === "connection_unshared") {
        return fail(409, "connection_unshared", "This push was started through a Smartlead account that is no longer shared with the person who started it. Share it again, or cancel the push.");
      }
      // Resuming sends with the connection the push started with: its owner may resume it, and so may anyone in the org that connection is shared
      // with (they could have started it). Anyone else cannot, but can still pause and cancel.
      if (userId !== r.run.keyOwnerId) {
        const usable = await this.deps.resolveKey(userId, r.run.smartleadAccountId);
        if (!usable.ok || usable.ownerUserId !== r.run.keyOwnerId) {
          return fail(403, "resume_requires_connection", "This push sends with a Smartlead connection you cannot use, so it cannot be resumed by you. You can cancel it and start again with your own.");
        }
      }
      const resumed = await this.deps.db.resumeRun(r.run.runId, this.workerId, r.run.leaseEpoch);
      if (!resumed) return fail(409, "not_paused", "This push was changed by someone else. Reload and try again.");
      this.deps.log(`[SmartleadPush] resumed run=${resumed.runId} by=${userId}`);
      this.spawn(resumed);
      return { ok: true, run: toRunView(resumed) };
    });
  }

  cancel(userId: string, runId: unknown): Promise<Result<{ run: RunView }>> {
    return this.guard(async () => {
      const r = await this.runFor(userId, runId);
      if (!r.ok) return r;
      if (!(await this.deps.db.cancelRun(r.run.runId))) return fail(409, "already_finished", "This push has already finished.");
      this.deps.log(`[SmartleadPush] canceled run=${r.run.runId} by=${userId}`);
      return { ok: true, run: toRunView((await this.deps.db.getRun(r.run.runId)) ?? r.run) };
    });
  }

  // ── the worker and the resumer

  private capacity(): number {
    return Math.max(0, (this.deps.maxConcurrentWorkers ?? 4) - this.active);
  }

  /** Starts the background worker for a run this process holds the lease of. At capacity it does nothing: the lease lapses and the resumer retries. */
  private spawn(run: PushRun): void {
    if (this.capacity() === 0) return;
    this.active++;
    void this.deps.track(`SmartleadPush:${run.runId}`, this.work(run).finally(() => { this.active--; })).catch(() => undefined);
  }

  /**
   * For a run a teammate started through a shared connection: null while that connection is still usable by the pusher, else the pause reason.
   * Un-shared (or resolving to another owner's connection) is `connection_unshared`; an unreadable key is `key_unavailable`; a rejected key is
   * left to the key owner's own check (the connection is still shared, the key is what failed). The key owner's own run is never refused here.
   */
  private async sharingVerdict(run: PushRun): Promise<string | null> {
    if (run.pushedBy === run.keyOwnerId) return null;
    const usable = await this.deps.resolveKey(run.pushedBy, run.smartleadAccountId);
    if (usable.ok) return usable.ownerUserId === run.keyOwnerId ? null : "connection_unshared";
    if (usable.reason === "key_rejected") return null;
    if (usable.reason === "key_unreadable") return "key_unavailable";
    return "connection_unshared";
  }

  /** Runs one run to its end. Never throws: a store error leaves the lease to lapse, and the resumer decides. */
  async work(run: PushRun): Promise<void> {
    try {
      // The pusher must STILL have edit access to the list (they may have left the org or lost the role since the run started or was paused).
      const list = await this.deps.getList(run.listId);
      if (!list || !(await this.deps.canEdit(run.pushedBy, list))) {
        await this.deps.db.pauseRun(run.runId, "access_revoked", run.leaseEpoch);
        this.deps.log(`[SmartleadPush] run=${run.runId} paused: the pusher no longer has edit access to the list`);
        return;
      }
      // A teammate pushing through a shared connection: it must STILL be shared with them. Un-sharing a connection stops the pushes that use it
      // (the key owner's own resolution below ignores sharing, so it would carry on otherwise); the engine asks again before every batch.
      const refused = await this.sharingVerdict(run);
      if (refused) {
        await this.deps.db.pauseRun(run.runId, refused, run.leaseEpoch);
        this.deps.log(`[SmartleadPush] run=${run.runId} paused (${refused}): the Smartlead connection is no longer usable by the pusher`);
        return;
      }
      const resolved = await this.deps.resolveKey(run.keyOwnerId, run.smartleadAccountId);
      if (!resolved.ok) {
        await this.deps.db.pauseRun(run.runId, resolved.reason === "key_rejected" ? "key_rejected" : "key_unavailable", run.leaseEpoch);
        return;
      }
      const apiKey = resolved.apiKey;
      await this.registerEvents(apiKey, run);
      const engineDeps: EngineDeps = {
        store: this.deps.db,
        readLeads: (l, a, n) => this.deps.crm.readLeads(l, a, n),
        readLeadConsistent: (l, id) => this.deps.crm.readLeadConsistent(l, id),
        writeMarker: (l, id, k, m) => this.deps.crm.writeMarker(l, id, k, m),
        smartlead: {
          // One quick retry: a POST that backs off for minutes would outlive the lease, and the markers make a resend safe anyway.
          addLeads: leads => this.deps.smartlead.addLeads(apiKey, run.campaignId, leads),
          getCampaign: () => this.deps.smartlead.getCampaign(apiKey, run.campaignId),
          getSequences: () => this.deps.smartlead.getSequences(apiKey, run.campaignId),
        },
        isDisabled: () => !this.deps.enabled(),
        ...(run.pushedBy !== run.keyOwnerId ? { stillPermitted: () => this.sharingVerdict(run) } : {}),
        onSmartleadError: error => { void this.deps.reportFailure(resolved, error).catch(() => undefined); },
        sleep: ms => this.deps.sleep(ms),
        now: () => this.deps.now(),
      };
      const outcome = await executeRun(run, engineDeps);
      this.deps.log(`[SmartleadPush] run=${run.runId} ${outcome.outcome}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
    } catch (error) {
      this.deps.log(`[SmartleadPush] run=${run.runId} worker error: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
    }
  }

  /** Registers the event webhook for this run's campaign; every failure is logged and swallowed. */
  private async registerEvents(apiKey: string, run: PushRun): Promise<void> {
    if (!this.deps.registerEvents) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.deps.registerEvents(apiKey, run.smartleadAccountId, run.campaignId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), 15_000); }),
      ]);
      this.deps.log(`[SmartleadPush] run=${run.runId} event webhook: ${String(result)}`);
    } catch (error) {
      this.deps.log(`[SmartleadPush] run=${run.runId} event webhook not registered: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One pass of the resumer (every minute): claims runs whose worker is gone, and cancels runs nobody resumed for a week. */
  async resumerTick(): Promise<{ claimed: number; canceled: number }> {
    const out = { claimed: 0, canceled: 0 };
    for (const runId of [...this.pendingCancels]) {
      try {
        await this.deps.db.cancelRun(runId); // false means it is already finished, which is just as good
        this.pendingCancels.delete(runId);
        this.deps.log(`[SmartleadPush] resumer canceled run=${runId} from an unsettled start`);
      } catch {
        /* try again next tick */
      }
    }
    if (!this.deps.enabled()) return out;
    try {
      for (const row of await this.deps.db.findExpiredLeases(RESUMER_BATCH)) {
        if (this.capacity() === 0) break;
        const run = await this.deps.db.getRun(row.runId); // the index is eventually consistent: act only on the strong read
        if (!run || run.status !== "running") continue;
        // A run whose start was never confirmed to the user is cancelled once its lease lapsed, never claimed (it may have been reported as failed).
        if (run.startUnconfirmed) {
          if (run.leaseUntil + ORPHAN_GRACE_MS > this.deps.now().getTime()) continue;
          if (await this.deps.db.cancelRun(run.runId)) { out.canceled++; this.deps.log(`[SmartleadPush] resumer canceled unconfirmed run=${run.runId}`); }
          continue;
        }
        // A running run whose lock does not point at it never really started (a crash between a start's two writes): cancel it, never run it.
        if (!(await this.deps.db.lockPointsAt(run))) {
          // Only once its lease has lapsed: a run in the middle of starting has a valid lease and no lock for a moment.
          if (run.leaseUntil + ORPHAN_GRACE_MS > this.deps.now().getTime()) continue;
          if (await this.deps.db.cancelRun(run.runId)) { out.canceled++; this.deps.log(`[SmartleadPush] resumer canceled orphan run=${run.runId}`); }
          continue;
        }
        const claimed = await this.deps.db.claimLease(run.runId, this.workerId, run.leaseEpoch);
        if (!claimed) continue;
        out.claimed++;
        this.deps.log(`[SmartleadPush] resumer claimed run=${run.runId}`);
        this.spawn(claimed);
      }
      for (const row of await this.deps.db.findStalePaused(STALE_PAUSED_MS, RESUMER_BATCH)) {
        // A run the operator's kill switch paused is the operator's to release: it ages while the switch is off, and (since the switch is
        // an environment variable) a long outage would otherwise cancel every one the moment the switch came back. Its owner can cancel it.
        const stale = await this.deps.db.getRun(row.runId);
        if (!stale || stale.pauseReason === "disabled_by_operator") continue;
        if (await this.deps.db.cancelRun(row.runId)) {
          out.canceled++;
          this.deps.log(`[SmartleadPush] resumer canceled stale run=${row.runId}`);
        }
      }
    } catch (error) {
      this.deps.log(`[SmartleadPush] resumer error: ${scrubSmartleadSecrets(error instanceof Error ? error.message : String(error))}`);
    }
    return out;
  }
}
