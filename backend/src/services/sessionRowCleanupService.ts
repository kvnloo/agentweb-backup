/**
 * Admin dry-run-first cleanup of LP session rows (ENG-2314, epic ENG-2309).
 *
 * WHY: the forward-lead race wrote two (occasionally three) rows for ONE landing-page
 * session into the `LP Sessions - …` lists, a few ms apart. The duplicates SPLIT the
 * session — one row holds lp_view + dwellSec, the other play_start with a longer
 * `journey` — so deleting "the duplicate" naively loses part of the journey. This
 * service MERGES first (into the earliest row, the keeper) and only then deletes the
 * donors. It also supports deleting explicitly-named junk/test rows.
 *
 * Everything is two-phase: `previewDedupe` / `previewExplicitDelete` are read-only and
 * return a plan plus a deterministic `planHash`; `applyDedupe` / `applyExplicitDelete`
 * RECOMPUTE the plan and refuse unless the hash, the delete count and `confirm === true`
 * all match, so a list that changed between preview and apply cannot be mutated on the
 * strength of a stale review.
 *
 * Safety invariants (tested): preview writes nothing; the keeper is never deleted; rows
 * with no session identity are never touched; leadCount drops by exactly the number of
 * rows really deleted; every read/write is keyed by the requested listId.
 *
 * No persistent audit store exists in this repo for admin actions (adminAuditLog.ts is
 * console-only and a new table is a data-plane change), so apply also logs a
 * write-ahead backup of every row to the console before deleting it, and returns the
 * same backup in the response.
 */
import { createHash } from 'crypto';
import { crmDb } from './db';

/**
 * Synthetic-email domain the LP session writer uses for the dramabreak tenant.
 * NOTE: other tenants' session lists use a different domain; generalising this
 * (per-list/tenant domain) is deliberately deferred to S5 — do not widen it here.
 */
export const SESSION_EMAIL_DOMAIN = 'sessions.go.dramabreak.ai';
export const SESSION_EMAIL_RE = new RegExp(
  `^s-(.+)@${SESSION_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`,
  'i',
);
export const SESSION_SOURCE = 'lp-session';
/** Max rows deleted by one apply call; the caller must re-preview to continue. */
export const MAX_DELETES_PER_APPLY = 500;
export const MAX_EXPLICIT_LEAD_IDS = 200;
const DEFAULT_PAGE_SIZE = 200;

export class SessionCleanupError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionCleanupError';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, so equal content always hashes equal. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const isBlank = (v: unknown) => v === undefined || v === null || v === '';
const deepEqual = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/** Finite number from a number or numeric string (engagement fields are strings). */
function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Epoch ms from an ISO string, an epoch-ms number or numeric string. */
function toMs(v: unknown): number | undefined {
  const n = toNum(v);
  if (n !== undefined) return n;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/**
 * Session identity of a row, or null. customFields.sessionId wins; the synthetic email
 * `s-<id>@sessions.go.dramabreak.ai` is the fallback. If both exist and disagree the
 * row is ambiguous and is reported as a conflict (never touched). A row without
 * customFields.source === 'lp-session' is never treated as a session row.
 */
export function sessionIdentity(
  row: any,
): { sessionId: string } | { conflict: true } | null {
  // Destructive grouping needs a POSITIVE marker: the LP writer sets
  // customFields.source = 'lp-session'. A blank source is not enough, and a top-level
  // source that says anything else also disqualifies the row.
  if (row?.customFields?.source !== SESSION_SOURCE) return null;
  if (!isBlank(row?.source) && row.source !== SESSION_SOURCE) return null;
  const cfId = row?.customFields?.sessionId;
  const fromField = typeof cfId === 'string' && cfId.trim() ? cfId.trim() : undefined;
  const m = typeof row?.email === 'string' ? SESSION_EMAIL_RE.exec(row.email.trim()) : null;
  const fromEmail = m ? m[1] : undefined;
  if (fromField && fromEmail && fromField !== fromEmail) return { conflict: true };
  const id = fromField ?? fromEmail;
  return id ? { sessionId: id } : null;
}

/** Keeper order: earliest createdAt, then smallest leadId; no createdAt sorts last. */
export function sortKeeperFirst<T extends { createdAt?: string; leadId: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = toMs(a.createdAt) ?? Number.POSITIVE_INFINITY;
    const tb = toMs(b.createdAt) ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0;
  });
}

const BUNDLE_EVENTS = ['journey', 'eventCount'] as const;
const BUNDLE_CLICKS = ['clickLog', 'clickCount', 'showsClicked'] as const;
const MAX_NUMERIC_KEYS = ['dwellSec', 'activeSec', 'videoWatchSec', 'maxScrollPct'] as const;
/** `<event>_at` (snake) or `fooAt` (camel) timestamp fields (incl. capiLastSentAt). */
const TIMESTAMP_KEY_RE = /(_at|At)$/;
/** Top-level attribution: keeper wins, missing values filled from donors. */
const TOP_LEVEL_FILL_RE = /^(firstTouch|lastTouch|clickIds|utm.*)$/i;

export interface MergeResult {
  /** Full merged customFields (keeper's keys plus anything filled). */
  merged: Record<string, any>;
  /** Only the customFields keys whose merged value differs from the keeper's. */
  writes: Record<string, any>;
  /** Top-level attribution fields missing on the keeper that a donor has. */
  topLevelWrites: Record<string, any>;
}

/**
 * Merge a session's rows (keeper first) into the keeper's customFields.
 * Rules, each justified because the duplicates split ONE cumulative session:
 *  - journey/eventCount come from the row with the highest eventCount, and
 *    clickLog/clickCount/showsClicked from the row with the highest clickCount: these
 *    are cumulative snapshots, so the largest count is the most complete one, and each
 *    bundle is taken from ONE row so a journey is never stitched to a foreign count.
 *  - dwellSec/activeSec/videoWatchSec/maxScrollPct: numeric max (engagement only grows;
 *    values are strings, compared numerically so "9" < "10").
 *  - `<event>_at` / `*At` timestamps: LATEST (each event overwrites its timestamp, so the
 *    latest is what a non-raced row holds). forwardedAt: EARLIEST (first forward is kept).
 *  - every other scalar key (lastEvent, furthestStage, lastEp, lastClick*, capi status,
 *    channel, …): from the row with the highest eventCount (tie: latest updatedAt, then
 *    keeper order), blanks filled from the other rows in that same order.
 *  - top-level firstTouch/lastTouch/clickIds/utm*: keeper wins, filled when missing.
 */
export function mergeSessionRows(rowsKeeperFirst: any[]): MergeResult {
  const keeper = rowsKeeperFirst[0];
  const cfs: Record<string, any>[] = rowsKeeperFirst.map((r) =>
    r?.customFields && typeof r.customFields === 'object' && !Array.isArray(r.customFields)
      ? r.customFields
      : {},
  );
  const merged: Record<string, any> = { ...cfs[0] };
  const allKeys = new Set<string>();
  cfs.forEach((cf) => Object.keys(cf).forEach((k) => allKeys.add(k)));

  // Rank rows: biggest primary count first, then secondary count, then the most
  // recently updated row, then keeper order (stable). The live writer OVERWRITES scalar
  // fields on every event (last write wins), so the row that saw the most events holds
  // the state a non-raced row would hold; ranking by it keeps lastEvent / furthestStage /
  // lastEp / lastClick* consistent with the journey they belong to.
  const rank = (primary: string, secondary?: string) =>
    rowsKeeperFirst
      .map((r, i) => ({ cf: cfs[i], i, upd: toMs(r?.updatedAt) ?? 0 }))
      .sort((a, b) => {
        const pa = toNum(a.cf[primary]) ?? 0;
        const pb = toNum(b.cf[primary]) ?? 0;
        if (pa !== pb) return pb - pa;
        if (secondary) {
          const sa = toNum(a.cf[secondary]) ?? 0;
          const sb = toNum(b.cf[secondary]) ?? 0;
          if (sa !== sb) return sb - sa;
        }
        if (a.upd !== b.upd) return b.upd - a.upd;
        return a.i - b.i;
      })
      .map((x) => x.cf);
  const eventRank = rank('eventCount');
  const clickRank = rank('clickCount', 'eventCount');
  const fromRank = (ranked: Record<string, any>[], key: string) =>
    ranked.find((cf) => !isBlank(cf[key]))?.[key];

  for (const key of allKeys) {
    let value: any;
    if ((BUNDLE_EVENTS as readonly string[]).includes(key)) {
      value = fromRank(eventRank, key);
    } else if ((BUNDLE_CLICKS as readonly string[]).includes(key)) {
      value = fromRank(clickRank, key);
    } else if ((MAX_NUMERIC_KEYS as readonly string[]).includes(key)) {
      let best: any;
      let bestN = Number.NEGATIVE_INFINITY;
      for (const cf of cfs) {
        const n = toNum(cf[key]);
        if (n !== undefined && n > bestN) {
          bestN = n;
          best = cf[key];
        }
      }
      value = best !== undefined ? best : fromRank(eventRank, key);
    } else if (key === 'forwardedAt' || TIMESTAMP_KEY_RE.test(key)) {
      // Each event overwrites `<event>_at` with its server time, so the latest wins;
      // forwardedAt is the one exception (forward-lead preserves the FIRST value).
      const wantLatest = key !== 'forwardedAt';
      let best: any;
      let bestT = wantLatest ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      for (const cf of cfs) {
        const t = toMs(cf[key]);
        if (t === undefined) continue;
        if (wantLatest ? t > bestT : t < bestT) {
          bestT = t;
          best = cf[key];
        }
      }
      value = best !== undefined ? best : fromRank(eventRank, key);
    } else {
      value = fromRank(eventRank, key);
    }
    if (value !== undefined) merged[key] = value;
  }

  const writes: Record<string, any> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (!deepEqual(v, cfs[0][k])) writes[k] = v;
  }

  const topLevelWrites: Record<string, any> = {};
  const topKeys = new Set<string>();
  rowsKeeperFirst.forEach((r) =>
    Object.keys(r ?? {}).forEach((k) => TOP_LEVEL_FILL_RE.test(k) && topKeys.add(k)),
  );
  for (const k of topKeys) {
    if (!isBlank(keeper?.[k])) continue;
    const donor = rowsKeeperFirst.find((r) => !isBlank(r?.[k]));
    if (donor) topLevelWrites[k] = donor[k];
  }

  return { merged, writes, topLevelWrites };
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface PlanRowRef {
  leadId: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GroupPlan {
  sessionId: string;
  keeper: PlanRowRef;
  /** Donors: merged into the keeper, then deleted. Never contains the keeper. */
  remove: PlanRowRef[];
  customFieldsWrites: Record<string, any>;
  topLevelWrites: Record<string, any>;
  /** Per-key before/after for the keeper, for human review. */
  diff: Record<string, { from: unknown; to: unknown }>;
}

export interface DedupePlan {
  mode: 'dedupe';
  listId: string;
  listName?: string;
  counts: {
    rowsScanned: number;
    rowsWithSessionIdentity: number;
    rowsWithoutIdentity: number;
    rowsWithConflictingIdentity: number;
    sessions: number;
    /** Duplicated sessions found, eligible or not. */
    duplicatedSessions: number;
    /** Duplicated sessions skipped because a row was updated within minIdleMinutes. */
    groupsSkippedActive: number;
    /** Rows to delete in ELIGIBLE (idle) groups only. */
    rowsToDelete: number;
    groupsWithKeeperWrites: number;
  };
  minIdleMinutes: number;
  /** Rows updated at/after this instant count as live. Informational, not hashed. */
  idleCutoff: string;
  /** Eligible (idle) groups: the only ones apply will touch. */
  groups: GroupPlan[];
  /** Possibly-live groups: reported, never mutated, excluded from rowsToDelete/planHash. */
  skippedActive: Array<{ sessionId: string; leadIds: string[]; newestUpdatedAt?: string }>;
  planHash: string;
}

const refOf = (r: any): PlanRowRef => ({
  leadId: r.leadId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

function buildGroupPlan(sessionId: string, rowsAny: any[]): GroupPlan {
  const rows = sortKeeperFirst(rowsAny);
  const { writes, topLevelWrites } = mergeSessionRows(rows);
  const keeperCf = rows[0].customFields ?? {};
  const diff: GroupPlan['diff'] = {};
  for (const [k, v] of Object.entries(writes)) diff[`customFields.${k}`] = { from: keeperCf[k], to: v };
  for (const [k, v] of Object.entries(topLevelWrites)) diff[k] = { from: rows[0][k], to: v };
  return {
    sessionId,
    keeper: refOf(rows[0]),
    remove: rows.slice(1).map(refOf),
    customFieldsWrites: writes,
    topLevelWrites,
    diff,
  };
}

/** Hash input per group: what will be written, to whom, and which row versions it saw. */
const groupFingerprint = (g: GroupPlan) =>
  stableStringify({
    s: g.sessionId,
    k: g.keeper,
    r: g.remove,
    w: g.customFieldsWrites,
    t: g.topLevelWrites,
  });

const hashGroups = (listId: string, mode: string, groups: GroupPlan[], extra: Record<string, unknown> = {}) =>
  sha256(stableStringify({ listId, mode, ...extra, groups: groups.map(groupFingerprint) }));

async function requireList(listId: string): Promise<any> {
  const list = await crmDb.getLeadListById(listId);
  if (!list) throw new SessionCleanupError(404, 'list_not_found', `Lead list ${listId} not found`);
  return list;
}

/** Every row of the list, following LastEvaluatedKey (the table pages at 1MB). */
async function scanAllRows(listId: string, pageSize: number): Promise<any[]> {
  const rows: any[] = [];
  let lastKey: any = undefined;
  let pages = 0;
  do {
    const page = await crmDb.getLeadsByListId(listId, pageSize, lastKey);
    for (const item of page.items) {
      // Per-list scoping: the query is keyed by listId, this is a belt-and-braces check.
      if (item.listId === listId || item.listId === undefined) rows.push(item);
    }
    lastKey = page.lastEvaluatedKey;
    if (++pages > 100000) throw new SessionCleanupError(500, 'scan_runaway', 'pagination did not terminate');
  } while (lastKey);
  return rows;
}

// ---------------------------------------------------------------------------
// Dedupe: preview / apply
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_IDLE_MINUTES = 30;
export const MIN_IDLE_MINUTES_RANGE = { min: 5, max: 1440 } as const;

export interface CleanupOptions {
  /** Query page size; tests force small pages to exercise LastEvaluatedKey. */
  pageSize?: number;
  /**
   * Idle guard: a duplicate group is only eligible when EVERY row's updatedAt is older
   * than this many minutes. Until the live LP writer is atomic (S2), a live session is
   * still written by a read-modify-write that overwrites the whole customFields map from
   * a stale read, which could clobber merged keeper values.
   */
  minIdleMinutes?: number;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
}

export function resolveMinIdleMinutes(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_MIN_IDLE_MINUTES;
  if (!Number.isInteger(v) || (v as number) < MIN_IDLE_MINUTES_RANGE.min || (v as number) > MIN_IDLE_MINUTES_RANGE.max) {
    throw new SessionCleanupError(
      400,
      'invalid_min_idle_minutes',
      `minIdleMinutes must be an integer between ${MIN_IDLE_MINUTES_RANGE.min} and ${MIN_IDLE_MINUTES_RANGE.max}`,
    );
  }
  return v as number;
}

export async function previewDedupe(listId: string, opts: CleanupOptions = {}): Promise<DedupePlan> {
  const minIdleMinutes = resolveMinIdleMinutes(opts.minIdleMinutes);
  const cutoffMs = (opts.now ?? Date.now)() - minIdleMinutes * 60_000;
  const list = await requireList(listId);
  const rows = await scanAllRows(listId, opts.pageSize ?? DEFAULT_PAGE_SIZE);
  const bySession = new Map<string, any[]>();
  let conflicts = 0;
  let withoutIdentity = 0;
  for (const row of rows) {
    const id = sessionIdentity(row);
    if (!id) {
      withoutIdentity++;
    } else if ('conflict' in id) {
      conflicts++;
    } else {
      const arr = bySession.get(id.sessionId) ?? [];
      arr.push(row);
      bySession.set(id.sessionId, arr);
    }
  }
  const groups: GroupPlan[] = [];
  const skippedActive: DedupePlan['skippedActive'] = [];
  for (const [sessionId, group] of [...bySession.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (group.length < 2) continue;
    // Strictly older than the cutoff is idle; exactly at the cutoff, or an
    // unparseable/missing updatedAt, is treated as possibly live (fail safe).
    const times = group.map((r) => toMs(r.updatedAt));
    const idle = times.every((t) => t !== undefined && t < cutoffMs);
    if (!idle) {
      const newest = group.map((r) => r.updatedAt).filter(Boolean).sort().pop();
      skippedActive.push({ sessionId, leadIds: group.map((r) => r.leadId).sort(), newestUpdatedAt: newest });
      continue;
    }
    groups.push(buildGroupPlan(sessionId, group));
  }
  const rowsToDelete = groups.reduce((n, g) => n + g.remove.length, 0);
  return {
    mode: 'dedupe',
    listId,
    listName: list.name ?? list.listName,
    counts: {
      rowsScanned: rows.length,
      rowsWithSessionIdentity: rows.length - withoutIdentity - conflicts,
      rowsWithoutIdentity: withoutIdentity,
      rowsWithConflictingIdentity: conflicts,
      sessions: bySession.size,
      duplicatedSessions: groups.length + skippedActive.length,
      groupsSkippedActive: skippedActive.length,
      rowsToDelete,
      groupsWithKeeperWrites: groups.filter(
        (g) => Object.keys(g.customFieldsWrites).length + Object.keys(g.topLevelWrites).length > 0,
      ).length,
    },
    minIdleMinutes,
    idleCutoff: new Date(cutoffMs).toISOString(),
    groups,
    skippedActive,
    // Hash covers ELIGIBLE groups + the idle setting only. A live group's updatedAt keeps
    // moving, so hashing it would make the plan unstable run-to-run; a group that turns
    // idle between preview and apply DOES change the hash, forcing a fresh review.
    planHash: hashGroups(listId, 'dedupe', groups, { minIdleMinutes }),
  };
}

export interface DeletedRowBackup {
  sessionId?: string;
  leadId: string;
  item: any;
}

export interface GroupResult {
  sessionId: string;
  keeperLeadId: string;
  status: 'merged_and_deleted' | 'deleted' | 'partial' | 'skipped_changed' | 'skipped_active' | 'error';
  keeperWritten: boolean;
  deletedLeadIds: string[];
  notDeleted: { leadId: string; reason: string }[];
  /** Keeper exactly as it was before the merge write, for hand-restore. */
  keeperBefore?: any;
  leadCountDriftRows: string[];
  error?: string;
}

export interface ApplyResult {
  mode: 'dedupe' | 'explicit';
  listId: string;
  planHash: string;
  deletedCount: number;
  /** Rows still to delete after this call; re-run preview, then apply, to continue. */
  remainingRowsToDelete: number;
  continuationRequired: boolean;
  groups: GroupResult[];
  backup: DeletedRowBackup[];
}

export interface ApplyRequest {
  listId: string;
  planHash: string;
  expectedRowsToDelete: number;
  confirm: boolean;
}

function assertConfirmed(req: ApplyRequest, plan: { planHash: string; rowsToDelete: number }) {
  if (req.confirm !== true) {
    throw new SessionCleanupError(400, 'confirm_required', 'confirm must be exactly true');
  }
  if (req.planHash !== plan.planHash || req.expectedRowsToDelete !== plan.rowsToDelete) {
    throw new SessionCleanupError(
      409,
      'plan_mismatch',
      'The list changed since preview, or the supplied hash/count is wrong. Re-run preview.',
      {
        expectedPlanHash: plan.planHash,
        suppliedPlanHash: req.planHash,
        currentRowsToDelete: plan.rowsToDelete,
        suppliedExpectedRowsToDelete: req.expectedRowsToDelete,
      },
    );
  }
}

async function readConsistent(listId: string, leadId: string) {
  return crmDb.getLeadById(listId, leadId, { consistentRead: true });
}

export async function applyDedupe(
  req: ApplyRequest,
  opts: CleanupOptions & { maxDeletes?: number; log?: (line: string) => void } = {},
): Promise<ApplyResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const cap = opts.maxDeletes ?? MAX_DELETES_PER_APPLY;
  const plan = await previewDedupe(req.listId, opts);
  assertConfirmed(req, { planHash: plan.planHash, rowsToDelete: plan.counts.rowsToDelete });

  const results: GroupResult[] = plan.skippedActive.map((a) => ({
    sessionId: a.sessionId,
    keeperLeadId: '',
    status: 'skipped_active' as const,
    keeperWritten: false,
    deletedLeadIds: [],
    notDeleted: [],
    leadCountDriftRows: [],
    error: `a row was updated within the last ${plan.minIdleMinutes} minutes (newest ${a.newestUpdatedAt ?? 'unknown'})`,
  }));
  const backup: DeletedRowBackup[] = [];
  let deleted = 0;
  let remaining = 0;

  for (const group of plan.groups) {
    if (deleted + group.remove.length > cap) {
      remaining += group.remove.length;
      continue; // explicit continuation: caller re-previews and applies again
    }
    const result: GroupResult = {
      sessionId: group.sessionId,
      keeperLeadId: group.keeper.leadId,
      status: 'error',
      keeperWritten: false,
      deletedLeadIds: [],
      notDeleted: [],
      leadCountDriftRows: [],
    };
    results.push(result);
    try {
      // 1. Re-read the group with consistent reads (the scan was eventually consistent)
      //    and recompute; if anything differs from what the admin reviewed, skip it.
      const fresh = await Promise.all(
        [group.keeper, ...group.remove].map((r) => readConsistent(req.listId, r.leadId)),
      );
      if (fresh.some((r) => !r)) {
        result.status = 'skipped_changed';
        result.error = 'a row of this group disappeared after preview';
        continue;
      }
      const freshPlan = buildGroupPlan(group.sessionId, fresh as any[]);
      if (groupFingerprint(freshPlan) !== groupFingerprint(group)) {
        result.status = 'skipped_changed';
        result.error = 'group content changed after preview';
        continue;
      }
      const keeperRow: any = fresh.find((r: any) => r.leadId === group.keeper.leadId);
      result.keeperBefore = keeperRow;

      // 2. Write-ahead backup to the console log (the only durable sink without a table).
      log(
        `[session-cleanup-backup] ${JSON.stringify({
          listId: req.listId,
          sessionId: group.sessionId,
          keeperBefore: keeperRow,
          donors: fresh.filter((r: any) => r.leadId !== group.keeper.leadId),
        })}`,
      );

      // 3. Atomic per-key writes to the keeper. setLeadFields escapes every attribute
      //    name. The top-level fill uses a per-key CONDITIONAL write that replaces the attribute
      //    only when it is absent, '' or NULL: the plan fills a keeper's BLANK attribute, which
      //    if_not_exists would leave in place (verification below would then fail, no donor would
      //    be deleted and every preview would repeat the plan), and an unconditional SET could
      //    overwrite a value a concurrent writer put there after the fingerprint read. Values are
      //    passed straight to the DocumentClient, so objects (firstTouch/clickIds) persist as Maps.
      if (Object.keys(group.topLevelWrites).length > 0) {
        await crmDb.setLeadTopLevelIfBlank(req.listId, group.keeper.leadId, group.topLevelWrites);
      }
      if (Object.keys(group.customFieldsWrites).length > 0) {
        await crmDb.setLeadFields(req.listId, group.keeper.leadId, {
          customFields: group.customFieldsWrites,
        });
      }

      // 4. setLeadFields swallows ConditionalCheckFailed (row vanished). Prove the
      //    merged values are really on the keeper before any donor is deleted.
      const after: any = await readConsistent(req.listId, group.keeper.leadId);
      const missing = [
        ...Object.entries(group.customFieldsWrites).filter(
          ([k, v]) => !deepEqual(after?.customFields?.[k], v),
        ),
        ...Object.entries(group.topLevelWrites).filter(([k]) => isBlank(after?.[k])),
      ].map(([k]) => k);
      if (!after || missing.length > 0) {
        result.status = 'error';
        result.error = `keeper verification failed (${after ? `keys not applied: ${missing.join(',')}` : 'keeper missing'}); no donors deleted`;
        continue;
      }
      result.keeperWritten = true;

      // 5. Delete donors. Never the keeper: remove[] excludes it by construction, and
      //    it is asserted here as well.
      for (const donor of group.remove) {
        if (donor.leadId === group.keeper.leadId) {
          result.notDeleted.push({ leadId: donor.leadId, reason: 'is_keeper' });
          continue;
        }
        try {
          const res = await crmDb.deleteLeadGuarded(req.listId, donor.leadId, donor.updatedAt);
          if (res.status === 'deleted') {
            result.deletedLeadIds.push(donor.leadId);
            backup.push({ sessionId: group.sessionId, leadId: donor.leadId, item: res.item });
            deleted++;
            if (!res.leadCountDecremented) result.leadCountDriftRows.push(donor.leadId);
          } else {
            result.notDeleted.push({ leadId: donor.leadId, reason: res.status });
          }
        } catch (e: any) {
          result.notDeleted.push({ leadId: donor.leadId, reason: `error: ${e?.message ?? e}` });
        }
      }
      result.status = result.notDeleted.length === 0 ? 'merged_and_deleted' : 'partial';
    } catch (e: any) {
      result.status = 'error';
      result.error = e?.message ?? String(e);
    }
  }

  return {
    mode: 'dedupe',
    listId: req.listId,
    planHash: plan.planHash,
    deletedCount: deleted,
    remainingRowsToDelete: remaining,
    continuationRequired: remaining > 0,
    groups: results,
    backup,
  };
}

// ---------------------------------------------------------------------------
// Explicit-ID mode (junk / test rows)
// ---------------------------------------------------------------------------

export interface ExplicitPlan {
  mode: 'explicit';
  listId: string;
  listName?: string;
  counts: { requested: number; rowsToDelete: number };
  rows: Array<PlanRowRef & { email?: string; sessionId?: string }>;
  planHash: string;
}

function normalizeLeadIds(leadIds: unknown): string[] {
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    throw new SessionCleanupError(400, 'invalid_lead_ids', 'leadIds must be a non-empty array');
  }
  if (leadIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new SessionCleanupError(400, 'invalid_lead_ids', 'every leadId must be a non-empty string');
  }
  const unique = [...new Set(leadIds as string[])].sort();
  if (unique.length > MAX_EXPLICIT_LEAD_IDS) {
    throw new SessionCleanupError(400, 'too_many_lead_ids', `at most ${MAX_EXPLICIT_LEAD_IDS} leadIds per call`);
  }
  return unique;
}

async function loadExplicitRows(listId: string, leadIds: string[]) {
  const rows: any[] = [];
  const unknown: string[] = [];
  for (const id of leadIds) {
    // Keyed read on (listId, leadId): a row of another list can never come back.
    const row: any = await readConsistent(listId, id);
    if (!row || row.listId !== listId) unknown.push(id);
    else rows.push(row);
  }
  if (unknown.length > 0) {
    throw new SessionCleanupError(
      422,
      'lead_ids_not_in_list',
      'Some leadIds do not belong to this list; nothing was planned or deleted.',
      { unknownLeadIds: unknown },
    );
  }
  return rows;
}

export async function previewExplicitDelete(listId: string, leadIdsRaw: unknown): Promise<ExplicitPlan> {
  const leadIds = normalizeLeadIds(leadIdsRaw);
  const list = await requireList(listId);
  const rows = await loadExplicitRows(listId, leadIds);
  const refs = rows.map((r) => ({
    ...refOf(r),
    email: r.email,
    sessionId: r.customFields?.sessionId,
  }));
  return {
    mode: 'explicit',
    listId,
    listName: list.name ?? list.listName,
    counts: { requested: leadIds.length, rowsToDelete: rows.length },
    rows: refs,
    planHash: sha256(
      stableStringify({ listId, mode: 'explicit', rows: refs.map((r) => ({ id: r.leadId, u: r.updatedAt })) }),
    ),
  };
}

export async function applyExplicitDelete(
  req: ApplyRequest & { leadIds: unknown },
  opts: { log?: (line: string) => void } = {},
): Promise<ApplyResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const plan = await previewExplicitDelete(req.listId, req.leadIds);
  assertConfirmed(req, { planHash: plan.planHash, rowsToDelete: plan.counts.rowsToDelete });

  const current = await loadExplicitRows(req.listId, plan.rows.map((r) => r.leadId));
  log(`[session-cleanup-backup] ${JSON.stringify({ listId: req.listId, explicit: true, rows: current })}`);

  const group: GroupResult = {
    sessionId: 'explicit',
    keeperLeadId: '',
    status: 'deleted',
    keeperWritten: false,
    deletedLeadIds: [],
    notDeleted: [],
    leadCountDriftRows: [],
  };
  const backup: DeletedRowBackup[] = [];
  for (const ref of plan.rows) {
    try {
      const res = await crmDb.deleteLeadGuarded(req.listId, ref.leadId, ref.updatedAt);
      if (res.status === 'deleted') {
        group.deletedLeadIds.push(ref.leadId);
        backup.push({ leadId: ref.leadId, item: res.item });
        if (!res.leadCountDecremented) group.leadCountDriftRows.push(ref.leadId);
      } else {
        group.notDeleted.push({ leadId: ref.leadId, reason: res.status });
      }
    } catch (e: any) {
      group.notDeleted.push({ leadId: ref.leadId, reason: `error: ${e?.message ?? e}` });
    }
  }
  group.status = group.notDeleted.length === 0 ? 'deleted' : 'partial';
  return {
    mode: 'explicit',
    listId: req.listId,
    planHash: plan.planHash,
    deletedCount: group.deletedLeadIds.length,
    remainingRowsToDelete: 0,
    continuationRequired: false,
    groups: [group],
    backup,
  };
}
