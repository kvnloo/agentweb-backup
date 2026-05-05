/**
 * Per-user daily quota tracker for enrich.so API calls.
 *
 * Counters reset at midnight UTC (the date string is YYYY-MM-DD in UTC).
 * Increments only happen on successful API calls — cache hits are free.
 *
 * Two implementations:
 *   - InMemoryQuotaTracker: process-local map, used for tests + small deployments
 *   - DynamoQuotaTracker:   backed by AW-Configs (configId = 'system:enrichSoUsage')
 */

import type { EnrichSoEndpoint } from './enrichSoCacheKeys';

export interface DailyLimits {
  validate: number;
  find: number;
  reverse: number;
}

export const DEFAULT_DAILY_LIMITS: DailyLimits = {
  validate: 1000,
  find: 1000,
  reverse: 1000,
};

/**
 * Separate, much tighter cap for the user-facing "lookup-by-email" route.
 * The underlying reverseLookup API has its own 1000/day quota, but the route
 * accepts arbitrary user-supplied emails — without a tighter gate, a single
 * logged-in user could dump up to 1000 enrich.so profiles/day. 50 is enough
 * for legitimate "Quick Add" workflow but small enough that abuse is bounded.
 */
export const DEFAULT_LOOKUP_BY_EMAIL_DAILY_LIMIT = 50;

export interface UsageRow {
  date: string;            // YYYY-MM-DD (UTC)
  validateCount: number;
  findCount: number;
  reverseCount: number;
  /** Counts user-facing lookup-by-email route hits independently of reverse API quota. */
  lookupByEmailCount?: number;
}

export class QuotaExceededError extends Error {
  constructor(public endpoint: EnrichSoEndpoint, public limit: number) {
    super(`Email lookup daily limit reached for ${endpoint}: ${limit}/day`);
    this.name = 'QuotaExceededError';
  }
}

export interface QuotaTracker {
  checkQuota(userId: string, endpoint: EnrichSoEndpoint): Promise<void>;
  recordUsage(userId: string, endpoint: EnrichSoEndpoint): Promise<void>;
  getUsage(userId: string): Promise<UsageRow>;
  /** Tighter route-level cap for the user-facing lookup-by-email endpoint. */
  checkLookupByEmailQuota(userId: string): Promise<void>;
  recordLookupByEmailUsage(userId: string): Promise<void>;
}

export class LookupByEmailQuotaExceededError extends Error {
  constructor(public limit: number) {
    super(`Email lookup daily limit reached: ${limit}/day`);
    this.name = 'LookupByEmailQuotaExceededError';
  }
}

function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

type EndpointCounterKey = `${EnrichSoEndpoint}Count`;

function counterKey(endpoint: EnrichSoEndpoint): EndpointCounterKey {
  return `${endpoint}Count`;
}

// ─── In-memory implementation ────────────────────────────────────────────────

export class InMemoryQuotaTracker implements QuotaTracker {
  private limits: DailyLimits;
  private lookupLimit: number;
  // Public via cast for tests — they swap the now() function to test day rollover.
  _now: () => Date;
  private store = new Map<string, UsageRow>();

  constructor(opts: {
    limits?: Partial<DailyLimits>;
    lookupByEmailLimit?: number;
    now?: () => Date;
  } = {}) {
    this.limits = { ...DEFAULT_DAILY_LIMITS, ...opts.limits };
    this.lookupLimit = opts.lookupByEmailLimit ?? DEFAULT_LOOKUP_BY_EMAIL_DAILY_LIMIT;
    this._now = opts.now ?? (() => new Date());
  }

  private getOrInit(userId: string): UsageRow {
    const today = todayUtc(this._now());
    const existing = this.store.get(userId);
    if (existing && existing.date === today) return existing;
    const fresh: UsageRow = {
      date: today,
      validateCount: 0,
      findCount: 0,
      reverseCount: 0,
      lookupByEmailCount: 0,
    };
    this.store.set(userId, fresh);
    return fresh;
  }

  async checkQuota(userId: string, endpoint: EnrichSoEndpoint): Promise<void> {
    const row = this.getOrInit(userId);
    if (row[counterKey(endpoint)] >= this.limits[endpoint]) {
      throw new QuotaExceededError(endpoint, this.limits[endpoint]);
    }
  }

  async recordUsage(userId: string, endpoint: EnrichSoEndpoint): Promise<void> {
    const row = this.getOrInit(userId);
    row[counterKey(endpoint)] += 1;
  }

  async checkLookupByEmailQuota(userId: string): Promise<void> {
    const row = this.getOrInit(userId);
    if ((row.lookupByEmailCount ?? 0) >= this.lookupLimit) {
      throw new LookupByEmailQuotaExceededError(this.lookupLimit);
    }
  }

  async recordLookupByEmailUsage(userId: string): Promise<void> {
    const row = this.getOrInit(userId);
    row.lookupByEmailCount = (row.lookupByEmailCount ?? 0) + 1;
  }

  async getUsage(userId: string): Promise<UsageRow> {
    return { ...this.getOrInit(userId) };
  }
}

// ─── DynamoDB implementation (AW-Configs) ────────────────────────────────────
//
// Stored as a per-user row with configId = 'system:enrichSoUsage'.
// Reset behavior: when a read returns a row whose date != today, we treat it
// as zero locally and overwrite on the next recordUsage. Tiny race window on
// midnight rollover is acceptable — quota is advisory, not a hard billing
// boundary.

const SYSTEM_CONFIG_ID = 'system:enrichSoUsage';

export class DynamoQuotaTracker implements QuotaTracker {
  constructor(
    private deps: {
      // Lazy-bound to avoid pulling AWS into unit tests of consumers.
      readUsage(userId: string): Promise<UsageRow | null>;
      writeUsage(userId: string, row: UsageRow): Promise<void>;
      incrementUsage(userId: string, endpoint: EnrichSoEndpoint, today: string): Promise<void>;
      incrementLookupByEmail(userId: string, today: string): Promise<void>;
    },
    private limits: DailyLimits = DEFAULT_DAILY_LIMITS,
    private lookupLimit: number = DEFAULT_LOOKUP_BY_EMAIL_DAILY_LIMIT,
    private now: () => Date = () => new Date(),
  ) {}

  private async getOrZero(userId: string): Promise<UsageRow> {
    const today = todayUtc(this.now());
    const row = await this.deps.readUsage(userId);
    if (!row || row.date !== today) {
      return { date: today, validateCount: 0, findCount: 0, reverseCount: 0, lookupByEmailCount: 0 };
    }
    return row;
  }

  async checkQuota(userId: string, endpoint: EnrichSoEndpoint): Promise<void> {
    const row = await this.getOrZero(userId);
    if (row[counterKey(endpoint)] >= this.limits[endpoint]) {
      throw new QuotaExceededError(endpoint, this.limits[endpoint]);
    }
  }

  async recordUsage(userId: string, endpoint: EnrichSoEndpoint): Promise<void> {
    await this.deps.incrementUsage(userId, endpoint, todayUtc(this.now()));
  }

  async checkLookupByEmailQuota(userId: string): Promise<void> {
    const row = await this.getOrZero(userId);
    if ((row.lookupByEmailCount ?? 0) >= this.lookupLimit) {
      throw new LookupByEmailQuotaExceededError(this.lookupLimit);
    }
  }

  async recordLookupByEmailUsage(userId: string): Promise<void> {
    await this.deps.incrementLookupByEmail(userId, todayUtc(this.now()));
  }

  async getUsage(userId: string): Promise<UsageRow> {
    return this.getOrZero(userId);
  }
}

export { SYSTEM_CONFIG_ID as ENRICHSO_USAGE_CONFIG_ID };
