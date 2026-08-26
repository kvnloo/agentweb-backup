/**
 * Per-sender daily send-volume tracker (ENG-265).
 *
 * Distinct from apolloQuota.ts/enrichSoQuota.ts (API-cost caps) — this guards
 * against silently over-sending cold email out of one inbox/domain, a
 * deliverability/reputation risk rather than a cost risk. Same lazy
 * day-rollover, race-safe-increment shape as those trackers, and reuses the
 * existing AW-Configs table rather than provisioning a new one.
 *
 * reserveSend() atomically checks the limit AND consumes one send in a single
 * operation — not a separate check-then-record pair, which would let N
 * concurrent sends all pass the check before any of them records, exceeding
 * the cap by up to N-1 sends. releaseSend() undoes a reservation when the
 * provider call definitively fails afterwards, so quota is still only
 * consumed by a send that actually went out — same end intent as
 * Apollo/enrich.so's "quota only consumed on success," just made atomic
 * instead of split across two round-trips.
 *
 * Kept free of AWS imports so unit tests for the reserve/release logic don't
 * need to mock aws-sdk — the DynamoDB wiring lives in
 * senderUsageTrackerFactory.ts, mirroring how apolloServiceFactory.ts wires
 * apolloQuota.ts.
 */

export interface SenderUsageRow {
  date: string;
  sentCount: number;
}

export class SenderDailyLimitExceededError extends Error {
  constructor(public senderId: string, public limit: number) {
    super(`This sender has reached its daily sending limit (${limit}/day). Try another sender or resume tomorrow.`);
    this.name = 'SenderDailyLimitExceededError';
  }
}

export interface SenderUsageTracker {
  /** Atomically checks the limit and reserves one send. Throws SenderDailyLimitExceededError if already at/over limit. */
  reserveSend(userId: string, senderId: string, limit: number): Promise<void>;
  /** Undoes a reservation — call only when the provider call definitively failed after a successful reserveSend. */
  releaseSend(userId: string, senderId: string): Promise<void>;
  getUsage(userId: string, senderId: string): Promise<SenderUsageRow>;
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function senderUsageConfigId(senderId: string): string {
  return `senderUsage:${senderId}`;
}

// ─── Warmup ramp (ENG-265) ────────────────────────────────────────────────────
//
// Conservative default schedule for a sender that opted into warmup: day 1-3
// caps at 10/day, day 4-7 at 20, day 8-14 at 35, day 15+ uses the sender's own
// dailyLimit (or 50 if unset). Matches the volume Baldwin — the customer who
// requested this feature — described as their own target cadence.
const WARMUP_RAMP: Array<{ throughDay: number; limit: number }> = [
  { throughDay: 3, limit: 10 },
  { throughDay: 7, limit: 20 },
  { throughDay: 14, limit: 35 },
];
export const DEFAULT_POST_WARMUP_DAILY_LIMIT = 50;

/**
 * Today's effective send cap for a sender, or null if the sender has no cap
 * configured at all (legacy behavior — unlimited, unchanged for senders that
 * never opted into dailyLimit/warmupStartedAt).
 */
export function effectiveDailyLimit(
  sender: { dailyLimit?: number; warmupStartedAt?: string },
  now: Date = new Date(),
): number | null {
  if (!sender.warmupStartedAt) {
    return sender.dailyLimit ?? null;
  }
  const start = new Date(sender.warmupStartedAt);
  const dayNumber = Math.max(1, Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1);
  const step = WARMUP_RAMP.find((s) => dayNumber <= s.throughDay);
  if (step) {
    // A configured dailyLimit is a hard cap, not just a post-warmup default — the ramp
    // must never exceed it (e.g. dailyLimit: 5 should stay 5/day even on ramp day 1-3,
    // where the step would otherwise offer 10/day).
    return sender.dailyLimit != null ? Math.min(step.limit, sender.dailyLimit) : step.limit;
  }
  return sender.dailyLimit ?? DEFAULT_POST_WARMUP_DAILY_LIMIT;
}

// ─── In-memory implementation (tests / small deployments) ───────────────────

export class InMemorySenderUsageTracker implements SenderUsageTracker {
  _now: () => Date;
  private store = new Map<string, SenderUsageRow>();

  constructor(opts: { now?: () => Date } = {}) {
    this._now = opts.now ?? (() => new Date());
  }

  private getOrInit(userId: string, senderId: string): SenderUsageRow {
    const today = todayUtc(this._now());
    const key = `${userId}:${senderId}`;
    const existing = this.store.get(key);
    if (existing && existing.date === today) return existing;
    const fresh: SenderUsageRow = { date: today, sentCount: 0 };
    this.store.set(key, fresh);
    return fresh;
  }

  async reserveSend(userId: string, senderId: string, limit: number): Promise<void> {
    const row = this.getOrInit(userId, senderId);
    if (row.sentCount >= limit) {
      throw new SenderDailyLimitExceededError(senderId, limit);
    }
    row.sentCount += 1;
  }

  async releaseSend(userId: string, senderId: string): Promise<void> {
    const row = this.getOrInit(userId, senderId);
    if (row.sentCount > 0) {
      row.sentCount -= 1;
    }
  }

  async getUsage(userId: string, senderId: string): Promise<SenderUsageRow> {
    return { ...this.getOrInit(userId, senderId) };
  }
}

// ─── DynamoDB implementation (AW-Configs, deps injected) ────────────────────

export class DynamoSenderUsageTracker implements SenderUsageTracker {
  constructor(
    private deps: {
      readUsage(userId: string, senderId: string): Promise<SenderUsageRow | null>;
      /** Atomic: increments sentCount only if today's row is under limit (or creates it at 1). Throws SenderDailyLimitExceededError otherwise. */
      reserveUsage(userId: string, senderId: string, today: string, limit: number): Promise<void>;
      releaseUsage(userId: string, senderId: string, today: string): Promise<void>;
    },
    private now: () => Date = () => new Date(),
  ) {}

  private async getOrZero(userId: string, senderId: string): Promise<SenderUsageRow> {
    const today = todayUtc(this.now());
    const row = await this.deps.readUsage(userId, senderId);
    if (!row || row.date !== today) {
      return { date: today, sentCount: 0 };
    }
    return row;
  }

  async reserveSend(userId: string, senderId: string, limit: number): Promise<void> {
    await this.deps.reserveUsage(userId, senderId, todayUtc(this.now()), limit);
  }

  async releaseSend(userId: string, senderId: string): Promise<void> {
    await this.deps.releaseUsage(userId, senderId, todayUtc(this.now()));
  }

  async getUsage(userId: string, senderId: string): Promise<SenderUsageRow> {
    return this.getOrZero(userId, senderId);
  }
}
