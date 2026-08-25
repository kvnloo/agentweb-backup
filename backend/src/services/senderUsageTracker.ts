/**
 * Per-sender daily send-volume tracker (ENG-265).
 *
 * Distinct from apolloQuota.ts/enrichSoQuota.ts (API-cost caps) — this guards
 * against silently over-sending cold email out of one inbox/domain, a
 * deliverability/reputation risk rather than a cost risk. Same lazy
 * day-rollover, race-safe-increment shape as those trackers, and reuses the
 * existing AW-Configs table rather than provisioning a new one.
 *
 * checkQuota() and recordSend() are separate calls, not one atomic
 * check-and-record — mirrors Apollo/enrich.so's semantics of "quota is only
 * consumed by a send that actually happened," so a failed provider call
 * doesn't burn a day's budget. The caller (sendAsSender.ts) checks before
 * dispatching and records only after the provider confirms the send.
 *
 * Kept free of AWS imports so unit tests for the check/record logic don't
 * need to mock aws-sdk — the DynamoDB wiring lives in sendAsSender.ts, the
 * sole caller, mirroring how apolloServiceFactory.ts wires apolloQuota.ts.
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
  checkQuota(userId: string, senderId: string, limit: number): Promise<void>;
  recordSend(userId: string, senderId: string): Promise<void>;
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
  if (step) return step.limit;
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

  async checkQuota(userId: string, senderId: string, limit: number): Promise<void> {
    const row = this.getOrInit(userId, senderId);
    if (row.sentCount >= limit) {
      throw new SenderDailyLimitExceededError(senderId, limit);
    }
  }

  async recordSend(userId: string, senderId: string): Promise<void> {
    const row = this.getOrInit(userId, senderId);
    row.sentCount += 1;
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
      incrementUsage(userId: string, senderId: string, today: string): Promise<void>;
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

  async checkQuota(userId: string, senderId: string, limit: number): Promise<void> {
    const row = await this.getOrZero(userId, senderId);
    if (row.sentCount >= limit) {
      throw new SenderDailyLimitExceededError(senderId, limit);
    }
  }

  async recordSend(userId: string, senderId: string): Promise<void> {
    await this.deps.incrementUsage(userId, senderId, todayUtc(this.now()));
  }

  async getUsage(userId: string, senderId: string): Promise<SenderUsageRow> {
    return this.getOrZero(userId, senderId);
  }
}
