import { ulid } from "ulid";
import {
  LEASE_MS,
  MAX_BATCH_ATTEMPTS,
  LIVE_STATUSES,
  SmartleadPushRunStoreError,
  type AdvanceStep,
  type NewPushRun,
  type PushRun,
  type PushRunSummary,
  type StartResult,
} from "../../smartleadPushRunDb";

/**
 * An in-memory stand-in for SmartleadPushRunDb, so the service's own logic (access, approval, start, control, the worker, the resumer)
 * is tested in EVERY environment, not only where DynamoDB Local runs. It follows the real store's rules (a lock per list and campaign,
 * a lease epoch fencing every worker write, a lock re-taken on resume) in simplified form; the real conditional writes are proven by
 * smartleadPushRunDb.dynamodbLocal.test.ts, and the service suite also runs on the real store when DYNAMODB_LOCAL_ENDPOINT is set.
 */
export class InMemoryPushRunDb {
  runs = new Map<string, PushRun>();
  locks = new Map<string, string>();
  tokens = new Map<string, { runId?: string }>();
  constructor(private readonly nowMs: () => number) {}

  private clone = (r: PushRun): PushRun => JSON.parse(JSON.stringify(r));
  private lockKey = (listId: string, campaignId: number) => `${listId}#${campaignId}`;
  private live = (r: PushRun) => (LIVE_STATUSES as readonly string[]).includes(r.status);
  private fenced(runId: string, epoch: number): PushRun | null {
    const r = this.runs.get(runId);
    return r && r.leaseEpoch === epoch && r.status === "running" ? r : null;
  }

  async getRun(runId: string) { const r = this.runs.get(runId); return r ? this.clone(r) : null; }
  async getRunEvents(runId: string) { const e = this.runs.get(runId)?.events; return e ? { ...e } : undefined; }
  async countContactEvent(runId: string, kind: "replied" | "bounced" | "unsubscribed") {
    const r = this.runs.get(runId);
    if (!r) return false;
    r.events = { replied: 0, bounced: 0, unsubscribed: 0, ...(r.events ?? {}) };
    r.events[kind]++;
    return true;
  }
  async getLock(listId: string, campaignId: number) { const id = this.locks.get(this.lockKey(listId, campaignId)); return id ? { runId: id } : null; }

  async startRun(input: NewPushRun, workerId: string): Promise<StartResult> {
    if (!Number.isInteger(input.campaignId) || input.campaignId <= 0 || !input.listId) throw new SmartleadPushRunStoreError("invalid_input", "bad");
    if (!input.ownerId || !input.pushedBy || !input.keyOwnerId || !workerId) throw new SmartleadPushRunStoreError("invalid_input", "bad");
    const key = this.lockKey(input.listId, input.campaignId);
    const heldBy = this.locks.get(key);
    if (heldBy) {
      const holder = this.runs.get(heldBy);
      if (!holder) return { started: false, existing: null, lockHeldBy: heldBy };
      if (this.live(holder)) return { started: false, existing: this.clone(holder) };
    }
    const now = this.nowMs();
    const iso = new Date(now).toISOString();
    const run: PushRun = {
      runId: ulid(now), schemaVersion: 1, status: "running", ownerId: input.ownerId, pushedBy: input.pushedBy, keyOwnerId: input.keyOwnerId, smartleadAccountId: input.smartleadAccountId,
      channel: input.channel, listId: input.listId, campaignId: input.campaignId, campaignName: input.campaignName, campaignSource: input.campaignSource, options: input.options,
      sequenceHash: input.sequenceHash, previewEligible: input.previewEligible, counts: { examined: 0, added: 0, alreadyInCampaign: 0, unconfirmed: 0, withdrawn: 0, skippedByReason: {} },
      cursor: null, listExhausted: false, batchAttempts: 0, leaseOwner: workerId, leaseEpoch: 1, leaseUntil: now + LEASE_MS, createdAt: iso, startedAt: iso, startUnconfirmed: true,
    };
    this.runs.set(run.runId, run);
    this.locks.set(key, run.runId);
    return { started: true, run: this.clone(run) };
  }

  async heartbeat(runId: string, epoch: number) {
    const r = this.fenced(runId, epoch);
    if (!r) return false;
    r.leaseUntil = this.nowMs() + LEASE_MS;
    return true;
  }

  async advance(runId: string, epoch: number, step: AdvanceStep) {
    const r = this.fenced(runId, epoch);
    if (!r) return false;
    if (!step.cursor?.listId && !step.listExhausted) throw new SmartleadPushRunStoreError("invalid_input", "advance needs a cursor");
    if (step.cursor?.listId) r.cursor = step.cursor;
    for (const [k, v] of Object.entries(step.counts)) (r.counts as any)[k] += v ?? 0;
    for (const [reason, n] of Object.entries(step.skipped ?? {})) if (n) r.counts.skippedByReason[reason] = (r.counts.skippedByReason[reason] ?? 0) + n;
    if (step.listExhausted) r.listExhausted = true;
    r.batchAttempts = 0;
    r.leaseUntil = this.nowMs() + LEASE_MS;
    return true;
  }

  async recordBatchFailure(runId: string, epoch: number) {
    const r = this.fenced(runId, epoch);
    if (!r) return null;
    r.batchAttempts++;
    if (r.batchAttempts >= MAX_BATCH_ATTEMPTS) { r.status = "partial"; r.pauseReason = "batch_failed"; return { attempts: r.batchAttempts, partial: true }; }
    return { attempts: r.batchAttempts, partial: false };
  }

  async pauseRun(runId: string, reason: string, epoch?: number) {
    const r = this.runs.get(runId);
    if (!r || r.status !== "running" || (epoch !== undefined && r.leaseEpoch !== epoch)) return false;
    r.status = "paused";
    r.pauseReason = reason;
    return true;
  }

  async resumeRun(runId: string, workerId: string, seenEpoch: number) {
    const r = this.runs.get(runId);
    if (!r || (r.status !== "paused" && r.status !== "partial") || r.startUnconfirmed || r.leaseEpoch !== seenEpoch) return null;
    const holder = this.locks.get(this.lockKey(r.listId, r.campaignId));
    if (holder && holder !== runId) return null;
    this.locks.set(this.lockKey(r.listId, r.campaignId), runId);
    r.status = "running"; r.batchAttempts = 0; r.leaseEpoch++; r.leaseOwner = workerId; r.leaseUntil = this.nowMs() + LEASE_MS;
    delete r.pauseReason;
    return this.clone(r);
  }

  private release(r: PushRun) {
    const key = this.lockKey(r.listId, r.campaignId);
    if (this.locks.get(key) === r.runId) this.locks.delete(key);
  }

  async cancelRun(runId: string) {
    const r = this.runs.get(runId);
    if (!r || !this.live(r)) return false;
    r.status = "canceled"; r.finishedAt = new Date(this.nowMs()).toISOString();
    this.release(r);
    return true;
  }

  async finishRun(runId: string, epoch: number, status: "completed" | "failed", failure?: { code: string; message: string }) {
    const r = this.fenced(runId, epoch);
    if (!r || (status === "completed" && !r.listExhausted)) return false;
    r.status = status; r.finishedAt = new Date(this.nowMs()).toISOString();
    if (failure) r.failure = failure;
    this.release(r);
    return true;
  }

  async claimLease(runId: string, workerId: string, seenEpoch: number, skewMs = 30_000) {
    const r = this.runs.get(runId);
    const now = this.nowMs();
    if (!r || r.status !== "running" || r.startUnconfirmed || r.leaseEpoch !== seenEpoch || !(r.leaseUntil < now - skewMs)) return null;
    if (this.locks.get(this.lockKey(r.listId, r.campaignId)) !== runId) return null; // never creates a missing lock (an orphan is cancelled instead)
    r.leaseEpoch++; r.leaseOwner = workerId; r.leaseUntil = now + LEASE_MS;
    return this.clone(r);
  }

  private summary = (r: PushRun): PushRunSummary => ({ runId: r.runId, status: r.status, listId: r.listId, campaignId: r.campaignId, campaignName: r.campaignName, counts: r.counts, startedAt: r.startedAt, createdAt: r.createdAt, leaseUntil: r.leaseUntil });
  async findExpiredLeases(limit = 50) { return [...this.runs.values()].filter(r => r.status === "running" && r.leaseUntil < this.nowMs()).slice(0, limit).map(this.summary); }
  async findStalePaused(olderThanMs: number, limit = 50) { return [...this.runs.values()].filter(r => (r.status === "paused" || r.status === "partial") && r.leaseUntil < this.nowMs() - olderThanMs).slice(0, limit).map(this.summary); }
  async listRunsForList(listId: string, limit = 25) { return [...this.runs.values()].filter(r => r.listId === listId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(this.summary); }

  async releaseLock(listId: string, campaignId: number, runId: string) { if (this.locks.get(this.lockKey(listId, campaignId)) === runId) this.locks.delete(this.lockKey(listId, campaignId)); }
  async confirmStart(runId: string) { const r = this.runs.get(runId); if (!r || r.status !== "running") return false; delete r.startUnconfirmed; return true; }
  async lockPointsAt(run: PushRun) { return this.locks.get(this.lockKey(run.listId, run.campaignId)) === run.runId; }

  async listRunsSince(sinceIso: string, limit = 100) { return [...this.runs.values()].filter(r => r.createdAt >= sinceIso).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(this.summary); }

  async claimToken(jti: string) { if (this.tokens.has(jti)) return false; this.tokens.set(jti, {}); return true; }
  async setTokenRun(jti: string, runId: string) { const t = this.tokens.get(jti); if (t) t.runId = runId; }
  async getTokenRun(jti: string) { return this.tokens.get(jti)?.runId ?? null; }
  async releaseToken(jti: string) { this.tokens.delete(jti); }
}
