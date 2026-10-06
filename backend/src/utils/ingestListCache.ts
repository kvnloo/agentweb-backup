/**
 * ENG-2325: a short-lived, in-process cache of the lead-list row the PUBLIC tracker ingest
 * (POST /api/track/event) needs, so N events for one list cost ~1 DynamoDB read per TTL window
 * instead of N (+1 per matching routing child, per event).
 *
 * Used by the ingest ONLY (routes/trackIngest.ts and trackerIngestService's child lookups); every
 * other reader of a list row still reads the database.
 *
 * WHAT IS CACHED: a frozen PROJECTION of the row (listId, userId, listType, publicAccessEnabled,
 * trackingConfig), the only fields the ingest reads. A cached copy therefore never serves a stale
 * leadCount / fieldNames (nothing here reads them) and a row is a few hundred bytes, not the whole item.
 *
 * STALENESS (read this before changing the TTL):
 *  - Writes through crmDb in THIS process (updateLeadList, deleteLeadList, transferLeadListOwner,
 *    createLeadList) invalidate the entry immediately, and an in-flight load that started before the
 *    write is discarded, so on the instance that took the write the change applies at once.
 *  - Other instances (the Elastic Beanstalk environment runs 2+) and out-of-process writers
 *    (scripts, the console) are NOT told: their change applies within INGEST_LIST_CACHE_TTL_MS
 *    (default 20s) at the latest. That includes the security gates the ingest evaluates against the
 *    cached row: a list that is DISABLED (publicAccessEnabled false / no longer a session list),
 *    removed, or whose allowedOrigins shrink keeps being accepted by another instance for up to one
 *    TTL (negative entries: up to INGEST_LIST_CACHE_NEGATIVE_TTL_MS for a list that was created or
 *    re-enabled), and a deleted child may take up to a TTL to stop receiving rows. No gate is
 *    skipped: Origin / publicAccess / session-list are still evaluated on every request, against a
 *    row that is at most one TTL old.
 *  - A transient read error is never cached (it propagates exactly as before).
 *
 * BOUNDED MEMORY (the endpoint is public and listIds come from the request body): at most
 * INGEST_LIST_CACHE_MAX_ENTRIES positive entries and INGEST_LIST_CACHE_MAX_NEGATIVE "no such list"
 * entries, oldest evicted first; negative entries live at most 5s. Concurrent misses for one id share
 * a single read (single-flight), which is itself bounded by request concurrency.
 *
 * INGEST_LIST_CACHE_TTL_MS env (TRACK_INGEST_LIST_CACHE_TTL_MS): integer ms, clamped to [0, 60000];
 * 0 turns the cache off (every event reads, as before this change). Unparseable -> the default.
 */

export const INGEST_LIST_CACHE_DEFAULT_TTL_MS = 20_000;
export const INGEST_LIST_CACHE_MAX_TTL_MS = 60_000;
export const INGEST_LIST_CACHE_MAX_ENTRIES = 500;
export const INGEST_LIST_CACHE_MAX_NEGATIVE = 256;
const NEGATIVE_TTL_CEILING_MS = 5_000;

export function parseIngestListCacheTtl(raw: string | undefined): number {
  if (raw === undefined || !/^\s*\d{1,9}\s*$/.test(raw)) return INGEST_LIST_CACHE_DEFAULT_TTL_MS;
  return Math.min(INGEST_LIST_CACHE_MAX_TTL_MS, Number(raw));
}

export const INGEST_LIST_CACHE_TTL_MS = parseIngestListCacheTtl(process.env.TRACK_INGEST_LIST_CACHE_TTL_MS);
export const INGEST_LIST_CACHE_NEGATIVE_TTL_MS = Math.min(INGEST_LIST_CACHE_TTL_MS, NEGATIVE_TTL_CEILING_MS);

export type IngestList = Readonly<Record<string, any>>;

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as any)[k]);
  }
  return v;
};

/** Only what the ingest reads, detached from the caller's object (a copy, so the cache cannot be mutated through it). */
const project = (row: Record<string, any>): IngestList =>
  deepFreeze(JSON.parse(JSON.stringify({
    listId: row.listId, userId: row.userId, listType: row.listType,
    publicAccessEnabled: row.publicAccessEnabled, trackingConfig: row.trackingConfig,
  })));

export class IngestListCache {
  private readonly positive = new Map<string, { value: IngestList; expiresAt: number }>();
  private readonly negative = new Map<string, number>();
  private readonly loading = new Map<string, Promise<IngestList | null>>();
  /** Bumped by every invalidate: a load that started before one must not store its (possibly pre-write) row. */
  private epoch = 0;

  constructor(private readonly opts: {
    ttlMs: number; negativeTtlMs: number; maxEntries: number; maxNegative: number; now?: () => number;
  }) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** The list row (projected), or null when the list does not exist. `load` is the database read. */
  async get(listId: string, load: (listId: string) => Promise<Record<string, any> | null | undefined>): Promise<IngestList | null> {
    if (this.opts.ttlMs <= 0) {
      const row = await load(listId);
      return row ? project(row) : null;
    }
    const now = this.now();
    const hit = this.positive.get(listId);
    if (hit && hit.expiresAt > now) return hit.value;
    const miss = this.negative.get(listId);
    if (miss !== undefined && miss > now) return null;

    const inFlight = this.loading.get(listId);
    if (inFlight) return inFlight;

    const epoch = this.epoch;
    const p: Promise<IngestList | null> = Promise.resolve()
      .then(() => load(listId))
      .then((row) => {
        const value = row ? project(row) : null;
        if (epoch === this.epoch) this.store(listId, value);
        return value;
      })
      .finally(() => { if (this.loading.get(listId) === p) this.loading.delete(listId); });
    this.loading.set(listId, p);
    return p;
  }

  /** Drops the entry and any in-flight read for `listId` (called after this process writes the list). */
  invalidate(listId: string): void {
    this.epoch++;
    this.positive.delete(listId);
    this.negative.delete(listId);
    this.loading.delete(listId);
  }

  clear(): void {
    this.epoch++;
    this.positive.clear();
    this.negative.clear();
    this.loading.clear();
  }

  /** Test/diagnostic view of the memory bound. */
  size(): { positive: number; negative: number; loading: number } {
    return { positive: this.positive.size, negative: this.negative.size, loading: this.loading.size };
  }

  private store(listId: string, value: IngestList | null): void {
    const now = this.now();
    if (value) {
      this.negative.delete(listId);
      this.positive.delete(listId); // re-insert: Map order = age
      this.positive.set(listId, { value, expiresAt: now + this.opts.ttlMs });
      this.trim(this.positive, this.opts.maxEntries, (e) => e.expiresAt <= now);
    } else {
      this.positive.delete(listId);
      this.negative.delete(listId);
      this.negative.set(listId, now + this.opts.negativeTtlMs);
      this.trim(this.negative, this.opts.maxNegative, (exp) => exp <= now);
    }
  }

  /** Over the bound: drop expired entries first, then the oldest, until it fits. */
  private trim<V>(m: Map<string, V>, max: number, expired: (v: V) => boolean): void {
    if (m.size <= max) return;
    for (const [k, v] of m) if (expired(v)) m.delete(k);
    for (const k of m.keys()) {
      if (m.size <= max) break;
      m.delete(k);
    }
  }
}

export const ingestListCache = new IngestListCache({
  ttlMs: INGEST_LIST_CACHE_TTL_MS,
  negativeTtlMs: INGEST_LIST_CACHE_NEGATIVE_TTL_MS,
  maxEntries: INGEST_LIST_CACHE_MAX_ENTRIES,
  maxNegative: INGEST_LIST_CACHE_MAX_NEGATIVE,
});
