/**
 * ENG-2690 (ENG-2681 slice 3): read-time visitor rollup over tracker session rows.
 *
 * The tracker SDK writes one row per session, each carrying the browser's `visitorId`. This module
 * groups those rows by visitorId into a visitor view and folds visitor-level user properties in
 * session order, honouring each property's update type:
 *   - set       last write wins
 *   - set_once  first write wins; later values never overwrite
 *   - add       numeric accumulation
 *
 * Pure and in-memory by design: nothing here creates a table, index, or persisted visitor record
 * (that would be a data-plane change, gated separately).
 *
 * User-property operations are read from a session row's customFields under the keys
 * `user_set`, `user_set_once`, and `user_add` (plain objects of propertyName -> value).
 */

export type UserPropUpdateType = 'set' | 'set_once' | 'add';

export interface SessionRowLike {
  customFields?: Record<string, any> | null;
}

export interface VisitorView {
  visitorId: string;
  sessionCount: number;
  sessionIds: string[];
  firstSeenMs?: number;
  lastSeenMs?: number;
  userProperties: Record<string, string | number | boolean>;
}

/** Hard bounds: input comes from anonymous browsers. */
export const MAX_USER_PROPS = 64;
const MAX_KEY_LEN = 64;
const MAX_STR_LEN = 300;
const KEY_RE = /^[a-z0-9_.$-]+$/i;

const OP_KEYS: Array<[UserPropUpdateType, string]> = [
  ['set_once', 'user_set_once'],
  ['set', 'user_set'],
  ['add', 'user_add'],
];

function scalar(v: unknown): string | number | boolean | undefined {
  if (typeof v === 'string') return v.slice(0, MAX_STR_LEN);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  return undefined;
}

/** Own-property write that is safe for names like `__proto__`. */
function setOwn(props: Record<string, unknown>, name: string, v: unknown): void {
  Object.defineProperty(props, name, { value: v, writable: true, enumerable: true, configurable: true });
}

function startMs(row: SessionRowLike): number {
  const raw = row.customFields?.sessionStartMs;
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Apply one session's user-property operations to a visitor's property bag (mutates `props`).
 * `allowed`, when given, restricts property names (e.g. the sheet's '#user data' list).
 */
export function applyUserPropOps(
  props: Record<string, string | number | boolean>,
  fields: Record<string, any>,
  allowed?: ReadonlySet<string>,
): void {
  for (const [type, key] of OP_KEYS) {
    const ops = fields[key];
    if (!ops || typeof ops !== 'object' || Array.isArray(ops)) continue;
    for (const [name, raw] of Object.entries(ops)) {
      if (name.length > MAX_KEY_LEN || !KEY_RE.test(name)) continue;
      if (allowed && !allowed.has(name)) continue;
      const exists = Object.prototype.hasOwnProperty.call(props, name);
      if (!exists && Object.keys(props).length >= MAX_USER_PROPS) continue;
      if (type === 'add') {
        const delta =
          typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        if (!Number.isFinite(delta)) continue;
        const previous = exists ? props[name] : undefined;
        const prevNum =
          typeof previous === 'number' || typeof previous === 'string' ? Number(previous) : 0;
        const prev = Number.isFinite(prevNum) ? prevNum : 0;
        const sum = prev + delta;
        if (!Number.isFinite(sum)) continue;
        setOwn(props, name, sum);
        continue;
      }
      const v = scalar(raw);
      if (v === undefined) continue;
      if (type === 'set_once' && exists) continue;
      setOwn(props, name, v);
    }
  }
}

/** Group session rows by visitorId. Rows without a visitorId are skipped. */
export function rollupVisitors(
  rows: SessionRowLike[],
  opts: { allowedUserProps?: ReadonlySet<string> } = {},
): VisitorView[] {
  const ordered = rows
    .filter((r) => typeof r.customFields?.visitorId === 'string' && r.customFields.visitorId)
    .sort((a, b) => startMs(a) - startMs(b));

  const byId = new Map<string, VisitorView>();
  for (const row of ordered) {
    const f = row.customFields as Record<string, any>;
    const id = f.visitorId as string;
    let v = byId.get(id);
    if (!v) {
      v = { visitorId: id, sessionCount: 0, sessionIds: [], userProperties: {} };
      byId.set(id, v);
    }
    v.sessionCount += 1;
    if (typeof f.sessionId === 'string' && !v.sessionIds.includes(f.sessionId)) v.sessionIds.push(f.sessionId);
    const ms = startMs(row);
    if (Number.isFinite(ms)) {
      if (v.firstSeenMs === undefined || ms < v.firstSeenMs) v.firstSeenMs = ms;
      if (v.lastSeenMs === undefined || ms > v.lastSeenMs) v.lastSeenMs = ms;
    }
    applyUserPropOps(v.userProperties, f, opts.allowedUserProps);
  }
  return [...byId.values()];
}
