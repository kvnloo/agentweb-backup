/**
 * ENG-926 §F — send-side CAPI identity-key coverage, queryable and trending.
 *
 * ─── Why this exists, and why it is NOT "Event Match Quality" ────────────────────────
 *
 * The card asks to "track Event Match Quality over time". Meta does not sell that number:
 * `event_match_quality` is not a valid `/stats` aggregation (Meta enumerates the valid ones
 * in its own error when given a bogus one), and the only EMQ surface that exists —
 * `GET /{dataset}?fields=event_stats`, which is what the `DATASET GET_MATCH_QUALITY` tool
 * calls — returns `"{}"` on live, busy pixels. Probed on two pixels, two tokens, two
 * Business Managers.
 *
 * So this measures the half we own: of the conversions we actually sent, what fraction
 * carried each identity key. That is deliberately a NARROWER claim than EMQ, and callers
 * must not present it as Meta's score. What Meta does with the identity is invisible to us
 * — `/stats?aggregation=match_keys` reports which keys ARRIVED, never which MATCHED, and
 * never reports `fbc`/`fbp` at all.
 *
 * ─── Why it is worth having anyway ──────────────────────────────────────────────────
 *
 * `fn`/`ln` were hashed wrong for 24 days — every CAPI event we ever sent before
 * 2026-08-17 carried names Meta could not match — and nothing could see it, because the
 * only symptom is a number quietly lower than it should be. This is the instrument whose
 * absence let that run. A drop in send-side coverage is OUR bug; healthy coverage with
 * conversions still unattributed points at Meta or at traffic. Two different fixes, today
 * indistinguishable.
 *
 * ─── Scope ──────────────────────────────────────────────────────────────────────────
 *
 * Per PIXEL, never per ad account. A pixel IS its own dataset in Graph v25, it is the unit
 * Meta scores, and this domain has been burned by account-scoped evidence behind a
 * pixel-scoped claim: a busy pixel's traffic vouching for a dead one. A per-customer view
 * resolves that customer's pixels at READ time, so `userId` never has to be threaded
 * through the send path.
 */

const TAG = '[CAPI Key Coverage]';

/**
 * The identity fields `sendCapiLeadEvent` can put on the wire, and the only names promoted
 * into counters. An unrecognised key is dropped rather than stored: this list is the schema,
 * and letting an arbitrary string create an attribute would make the table's shape depend on
 * whatever a caller happened to pass.
 *
 * Known absentees, deliberately: `external_id` and the geo fields (`ct`/`st`/`zp`/`country`)
 * are recommended by Meta and are not sent today. When they ship, add them here — historical
 * rows will not carry the attribute, and an absent counter correctly reads as 0.
 */
export const CAPI_IDENTITY_KEYS = [
  'em',
  'ph',
  'fn',
  'ln',
  'fbc',
  'fbp',
  'client_ip_address',
  'client_user_agent',
] as const;

export type CapiIdentityKey = (typeof CAPI_IDENTITY_KEYS)[number];

const IDENTITY_KEY_SET: ReadonlySet<string> = new Set(CAPI_IDENTITY_KEYS);

/** One stored row: a pixel's sends for one event name on one UTC day. */
export interface CapiKeyCoverageRow {
  pixelId: string;
  date: string;
  eventName: string;
  sends: number;
  /** Per-key counters. Absent means zero — see the migration note above. */
  em?: number;
  ph?: number;
  fn?: number;
  ln?: number;
  fbc?: number;
  fbp?: number;
  client_ip_address?: number;
  client_user_agent?: number;
}

export interface KeyCoverageBucket {
  sends: number;
  keys: Record<CapiIdentityKey, number>;
  /** null, not 0, when nothing was sent — see `finalizeBucket`. */
  coverage: Record<CapiIdentityKey, number | null>;
}

export interface CapiKeyCoverageResult {
  windowDays: number;
  totals: KeyCoverageBucket;
  /** Oldest-first, so a trend reads left to right. Same contract as click-ID coverage. */
  daily: Array<{ date: string } & KeyCoverageBucket>;
  /** One bad event type is invisible inside a healthy total. */
  byEvent: Array<{ eventName: string } & KeyCoverageBucket>;
  /** Pixels whose rows could not be read this run. Named so a partial answer is never
   *  mistaken for a complete one — a failed read is not a zero. */
  unreadablePixels: string[];
}

/* ─────────────────────────── keys ─────────────────────────── */

/**
 * `<date>#<eventName>`.
 *
 * Date leads so the sort key orders chronologically and a windowed Query is a plain range
 * over the sort key rather than a filter over the whole partition.
 */
export function buildCoverageSortKey(date: string, eventName: string): string {
  return `${date}#${eventName}`;
}

/**
 * Split on the FIRST separator only. Custom-conversion event names are customer-defined and
 * can contain `#`; splitting on the last one would corrupt them.
 */
export function parseCoverageSortKey(sortKey: string): { date: string; eventName: string } {
  const at = sortKey.indexOf('#');
  if (at === -1) return { date: sortKey, eventName: '' };
  return { date: sortKey.slice(0, at), eventName: sortKey.slice(at + 1) };
}

/**
 * UTC day bucket.
 *
 * Ours is our own clock, unlike Meta's `/stats` buckets, which are stamped in the AD
 * ACCOUNT's timezone and have caused real per-day comparison errors. Stating this in UTC is
 * what keeps a day boundary meaningful to every reader.
 */
export function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/* ─────────────────────────── aggregation ─────────────────────────── */

function emptyKeyCounts(): Record<CapiIdentityKey, number> {
  const out = {} as Record<CapiIdentityKey, number>;
  for (const key of CAPI_IDENTITY_KEYS) out[key] = 0;
  return out;
}

/**
 * `coverage` is null rather than 0 when nothing was sent. 0% reads as "every send is missing
 * this key", which is an alarm; "no sends yet" is not, and the two must not render
 * identically on a dashboard someone glances at.
 *
 * The ratio is also clamped to 1: a corrupted or double-counted row would otherwise report
 * >100% coverage, which reads as nonsense rather than as the data problem it is.
 */
function finalizeBucket(sends: number, keys: Record<CapiIdentityKey, number>): KeyCoverageBucket {
  const coverage = {} as Record<CapiIdentityKey, number | null>;
  for (const key of CAPI_IDENTITY_KEYS) {
    coverage[key] = sends === 0 ? null : Math.min(1, keys[key] / sends);
  }
  return { sends, keys, coverage };
}

interface Accumulator {
  sends: number;
  keys: Record<CapiIdentityKey, number>;
}

function newAccumulator(): Accumulator {
  return { sends: 0, keys: emptyKeyCounts() };
}

function addRow(acc: Accumulator, row: CapiKeyCoverageRow): void {
  acc.sends += Number(row.sends) || 0;
  for (const key of CAPI_IDENTITY_KEYS) {
    // An absent attribute is zero, which is the correct answer for a key we were not
    // sending when the row was written.
    acc.keys[key] += Number((row as any)[key]) || 0;
  }
}

/**
 * Pure aggregation. Rows older than the window are excluded here rather than assumed
 * excluded by the caller, so a read that over-fetches cannot silently widen the answer.
 */
export function aggregateCoverageRows(
  rows: CapiKeyCoverageRow[],
  windowDays: number,
  nowMs: number,
  unreadablePixels: string[] = [],
): CapiKeyCoverageResult {
  const oldest = utcDateKey(nowMs - (windowDays - 1) * 86_400_000);

  const totals = newAccumulator();
  const byDate = new Map<string, Accumulator>();
  const byEvent = new Map<string, Accumulator>();

  for (const row of rows) {
    if (!row || typeof row.date !== 'string' || row.date < oldest) continue;

    addRow(totals, row);

    let dateAcc = byDate.get(row.date);
    if (!dateAcc) byDate.set(row.date, (dateAcc = newAccumulator()));
    addRow(dateAcc, row);

    const name = row.eventName || '';
    let eventAcc = byEvent.get(name);
    if (!eventAcc) byEvent.set(name, (eventAcc = newAccumulator()));
    addRow(eventAcc, row);
  }

  return {
    windowDays,
    totals: finalizeBucket(totals.sends, totals.keys),
    daily: [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, acc]) => ({ date, ...finalizeBucket(acc.sends, acc.keys) })),
    byEvent: [...byEvent.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([eventName, acc]) => ({ eventName, ...finalizeBucket(acc.sends, acc.keys) })),
    unreadablePixels,
  };
}

/* ─────────────────────────── Meta's own EMQ surface ─────────────────────────── */

/**
 * Is Meta's `event_stats` payload empty?
 *
 * `GET /{dataset}?fields=event_stats` is the ONLY EMQ surface Meta exposes, and it is what
 * the shipped `DATASET GET_MATCH_QUALITY` tool calls. On live, busy pixels it returns
 * empty — probed on two pixels, two tokens, two Business Managers — so that tool has been
 * answering nothing to every customer who asked Emma for match quality, while the docs
 * advertise it as returning "EMQ scores per event type".
 *
 * Detecting empty reliably is what lets us answer with real send-side coverage instead.
 * Meta returns this field as a JSON **string**, not an object, which is the shape most likely
 * to be missed.
 *
 * ⚠ An UNPARSEABLE string is deliberately treated as NON-empty. Failing the other way would
 * silently replace a response we merely could not read with our own numbers — presenting a
 * parse failure as a measurement, which is the mistake this whole area keeps making.
 */
export function isEmptyEventStats(value: unknown): boolean {
  if (value === null || value === undefined) return true;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return true;
    try {
      return isEmptyEventStats(JSON.parse(trimmed));
    } catch {
      return false;
    }
  }

  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;

  return false;
}

/* ─────────────────────────── recording ─────────────────────────── */

export interface RecordCapiKeySendInput {
  pixelId: string;
  eventName?: string;
  /** The `user_data` key names that actually went on the wire. Names only, never values. */
  keys: readonly string[];
  nowMs: number;
}

export interface RecordCapiKeySendDeps {
  addCounters: (args: {
    pixelId: string;
    sortKey: string;
    date: string;
    eventName: string;
    increments: Record<string, number>;
  }) => Promise<void>;
}

/**
 * Record one ACCEPTED CAPI send.
 *
 * ⚠ THIS FUNCTION MUST NEVER THROW, and that is the whole contract. It is called
 * immediately after Meta has accepted a conversion — the event is already delivered and
 * cannot be recalled. Throwing here would turn a successful send into a reported failure
 * and, on the relay path, provoke a retry of a conversion Meta already counted. A missing
 * table, an IAM denial or a throttle costs us a metrics row and nothing else.
 *
 * Only keys that were genuinely present are incremented. Writing an explicit 0 for an absent
 * key would be indistinguishable from a send that carried the key with an empty value.
 */
export async function recordCapiKeySend(
  input: RecordCapiKeySendInput,
  deps: RecordCapiKeySendDeps,
): Promise<void> {
  try {
    const date = utcDateKey(input.nowMs);
    // A conversion with no event name is a `Lead` everywhere else in this codebase; writing
    // an empty bucket instead would strand those sends in a row nobody queries.
    const eventName = input.eventName || 'Lead';

    const increments: Record<string, number> = { sends: 1 };
    for (const key of input.keys) {
      if (IDENTITY_KEY_SET.has(key)) increments[key] = 1;
    }

    await deps.addCounters({
      pixelId: input.pixelId,
      sortKey: buildCoverageSortKey(date, eventName),
      date,
      eventName,
      increments,
    });
  } catch (error: any) {
    console.warn(`${TAG} could not record send for pixel ${input.pixelId}: ${error?.message}`);
  }
}

/* ─────────────────────────── read ─────────────────────────── */

export interface CapiKeyCoverageDeps {
  /** Rows for one pixel within the window. Throwing marks that pixel unreadable. */
  queryRows: (pixelId: string, oldestDate: string) => Promise<CapiKeyCoverageRow[]>;
  now?: number;
}

/**
 * Coverage across a set of pixels.
 *
 * A pixel whose read FAILS is reported in `unreadablePixels`, never folded into a zero —
 * "could not ask" is not "sent nothing", and conflating them is how a dead credential reads
 * as a tracking failure.
 */
export async function computeCapiKeyCoverage(
  pixelIds: string[],
  windowDays: number,
  deps: CapiKeyCoverageDeps,
): Promise<CapiKeyCoverageResult> {
  const nowMs = deps.now ?? Date.now();
  const oldest = utcDateKey(nowMs - (windowDays - 1) * 86_400_000);

  const rows: CapiKeyCoverageRow[] = [];
  const unreadablePixels: string[] = [];

  for (const pixelId of pixelIds) {
    try {
      rows.push(...(await deps.queryRows(pixelId, oldest)));
    } catch (error: any) {
      console.warn(`${TAG} pixel ${pixelId} unreadable: ${error?.message}`);
      unreadablePixels.push(pixelId);
    }
  }

  return aggregateCoverageRows(rows, windowDays, nowMs, unreadablePixels);
}

/**
 * Production wiring. Kept separate from the pure computation so the unit tests never pull in
 * the DynamoDB client — the same split `metaAttributionCoverage` uses.
 *
 * Resolves the customer's pixels FIRST, then reads coverage per pixel. That ordering is the
 * reason `userId` never has to be threaded through `sendCapiLeadEvent`: the send path knows
 * the pixel, and the pixel is the unit Meta actually scores.
 *
 * An account whose credential lookup fails is skipped rather than fatal — the same "never let
 * one bad account break everything" rule `/pixels` and `resolveMetaPixelForUser` already
 * follow. A pixel that resolves but cannot be READ is reported in `unreadablePixels`, because
 * "could not ask" is not "sent nothing".
 */
export async function computeCapiKeyCoverageForUser(
  userId: string,
  windowDays: number,
): Promise<CapiKeyCoverageResult> {
  const [{ userDb }, credentials, { metaService }, pixelsCache, coverageDb] = await Promise.all([
    import('./db'),
    import('./metaAccountCredentials'),
    import('./metaService'),
    import('./metaPixelsCache'),
    import('./metaCapiKeyCoverageDb'),
  ]);

  let pixelIds: string[] = [];

  const cached = pixelsCache.getCachedPixels(userId);
  if (cached) {
    pixelIds = cached.map((p: any) => String(p.pixelId));
  } else {
    const user = await userDb.getUserById(userId);
    if (!user) return aggregateCoverageRows([], windowDays, Date.now());

    const accounts = credentials.getConnectedMetaAccountsList(user);
    const perAccount = await Promise.all(
      accounts.map(async (acc: any) => {
        try {
          const { accountId, accessToken } = await credentials.getMetaAccountCredentials(
            user,
            userId,
            acc.accountId,
          );
          const pixels = await metaService.listPixels(accountId, accessToken);
          return (pixels || []).map((p: any) => ({
            pixelId: String(p.id),
            accountId,
            accountName: acc.accountName,
          }));
        } catch (error: any) {
          console.warn(`${TAG} skipping account ${acc.accountId}: ${error?.message}`);
          return [];
        }
      }),
    );

    const flat = perAccount.flat();
    pixelsCache.setCachedPixels(userId, flat);
    pixelIds = flat.map((p) => p.pixelId);
  }

  // One pixel can be reachable through more than one connected account; reading it twice
  // would double every counter it contributes.
  const unique = [...new Set(pixelIds)];

  return computeCapiKeyCoverage(unique, windowDays, {
    queryRows: (pixelId, oldestDate) => coverageDb.queryCapiKeyCoverageRows(pixelId, oldestDate),
  });
}
