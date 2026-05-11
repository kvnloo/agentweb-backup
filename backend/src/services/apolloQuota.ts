/**
 * Per-user daily quota tracker for Apollo API calls.
 *
 * Distinct from enrich.so quota because Apollo reveals (personal email, phone)
 * cost 5–10× a basic match — we want a much tighter cap on those.
 *
 * Counters reset at midnight UTC. Increments only on successful API calls;
 * cache hits are free.
 */

export type ApolloEndpoint = 'match' | 'find' | 'org';

export interface ApolloDailyLimits {
  match: number;
  find: number;
  org: number;
}

export const DEFAULT_APOLLO_DAILY_LIMITS: ApolloDailyLimits = {
  match: 500,
  find: 500,
  org: 500,
};

export interface ApolloUsageRow {
  date: string;
  matchCount: number;
  findCount: number;
  orgCount: number;
}

export class ApolloQuotaExceededError extends Error {
  constructor(public endpoint: ApolloEndpoint, public limit: number) {
    super(`Apollo daily limit reached for ${endpoint}: ${limit}/day`);
    this.name = 'ApolloQuotaExceededError';
  }
}

export interface ApolloQuotaTracker {
  checkQuota(userId: string, endpoint: ApolloEndpoint): Promise<void>;
  recordUsage(userId: string, endpoint: ApolloEndpoint): Promise<void>;
  getUsage(userId: string): Promise<ApolloUsageRow>;
}

function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

type ApolloCounterKey = `${ApolloEndpoint}Count`;

function counterKey(endpoint: ApolloEndpoint): ApolloCounterKey {
  return `${endpoint}Count`;
}

// ─── In-memory implementation ────────────────────────────────────────────────

export class InMemoryApolloQuotaTracker implements ApolloQuotaTracker {
  private limits: ApolloDailyLimits;
  _now: () => Date;
  private store = new Map<string, ApolloUsageRow>();

  constructor(opts: {
    limits?: Partial<ApolloDailyLimits>;
    now?: () => Date;
  } = {}) {
    this.limits = { ...DEFAULT_APOLLO_DAILY_LIMITS, ...opts.limits };
    this._now = opts.now ?? (() => new Date());
  }

  private getOrInit(userId: string): ApolloUsageRow {
    const today = todayUtc(this._now());
    const existing = this.store.get(userId);
    if (existing && existing.date === today) return existing;
    const fresh: ApolloUsageRow = {
      date: today,
      matchCount: 0,
      findCount: 0,
      orgCount: 0,
    };
    this.store.set(userId, fresh);
    return fresh;
  }

  async checkQuota(userId: string, endpoint: ApolloEndpoint): Promise<void> {
    const row = this.getOrInit(userId);
    if (row[counterKey(endpoint)] >= this.limits[endpoint]) {
      throw new ApolloQuotaExceededError(endpoint, this.limits[endpoint]);
    }
  }

  async recordUsage(userId: string, endpoint: ApolloEndpoint): Promise<void> {
    const row = this.getOrInit(userId);
    row[counterKey(endpoint)] += 1;
  }

  async getUsage(userId: string): Promise<ApolloUsageRow> {
    return { ...this.getOrInit(userId) };
  }
}

// ─── DynamoDB implementation (AW-Configs) ────────────────────────────────────

const SYSTEM_CONFIG_ID = 'system:apolloUsage';

export class DynamoApolloQuotaTracker implements ApolloQuotaTracker {
  constructor(
    private deps: {
      readUsage(userId: string): Promise<ApolloUsageRow | null>;
      writeUsage(userId: string, row: ApolloUsageRow): Promise<void>;
      incrementUsage(userId: string, endpoint: ApolloEndpoint, today: string): Promise<void>;
    },
    private limits: ApolloDailyLimits = DEFAULT_APOLLO_DAILY_LIMITS,
    private now: () => Date = () => new Date(),
  ) {}

  private async getOrZero(userId: string): Promise<ApolloUsageRow> {
    const today = todayUtc(this.now());
    const row = await this.deps.readUsage(userId);
    if (!row || row.date !== today) {
      return { date: today, matchCount: 0, findCount: 0, orgCount: 0 };
    }
    return row;
  }

  async checkQuota(userId: string, endpoint: ApolloEndpoint): Promise<void> {
    const row = await this.getOrZero(userId);
    if (row[counterKey(endpoint)] >= this.limits[endpoint]) {
      throw new ApolloQuotaExceededError(endpoint, this.limits[endpoint]);
    }
  }

  async recordUsage(userId: string, endpoint: ApolloEndpoint): Promise<void> {
    await this.deps.incrementUsage(userId, endpoint, todayUtc(this.now()));
  }

  async getUsage(userId: string): Promise<ApolloUsageRow> {
    return this.getOrZero(userId);
  }
}

export { SYSTEM_CONFIG_ID as APOLLO_USAGE_CONFIG_ID };
