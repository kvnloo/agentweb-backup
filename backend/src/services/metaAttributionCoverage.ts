/**
 * ENG-926 §F / AC5 — click-ID coverage, queryable and trending.
 *
 * RankAI's post-mortem found zero of four CRM leads carried any `utm_*` or `fbclid`. That
 * number was true for weeks and nobody was counting it, so it surfaced only once the
 * client asked a question it made unanswerable. This turns it into a number you can ask
 * for on any day, per customer and per list.
 *
 * ─── Which field, and why it matters ────────────────────────────────────────────────
 *
 * Reads the TOP-LEVEL `clickIds` map, never `firstTouch.clickIds`. `leadSchema.ts` spells
 * out the difference: `clickIds` is written ONLY when at least one non-empty click
 * identifier was captured, which is exactly what makes `attribute_exists(clickIds)` mean
 * "a paid click acquired this lead". A `firstTouch` exists for organic visitors too, and
 * an empty `clickIds` map holds precisely as much attribution as no map at all — so
 * counting `{}` as covered would report organic leads as paid-acquired and make a lander
 * that stopped capturing look like one that still works.
 *
 * ─── Scope, stated plainly ──────────────────────────────────────────────────────────
 *
 * AC5 says "per account". Coverage here is per CUSTOMER and per LIST, not per ad account:
 * a lead record carries no ad-account id, and inventing a mapping from campaign names
 * would be a guess presented as a measurement. Per list is the breakdown that is actually
 * actionable anyway — it points at the specific lander that stopped capturing, which the
 * customer-wide number hides as a small dip.
 */

const TAG = '[Attribution Coverage]';

/** One page of leads per round trip. Matches the reconciliation sweep's page size. */
const LEAD_PAGE_SIZE = 200;

export interface CoverageBucket {
  leads: number;
  withClickId: number;
  /** null, not 0, when there are no leads — see `finalize`. */
  coverage: number | null;
}

export interface ClickIdCoverageResult {
  windowDays: number;
  totals: CoverageBucket & {
    /** Leads whose creation date could not be read. Reported rather than dropped: a
     *  silently-skipped lead overstates coverage. */
    undated: number;
  };
  /** Oldest-first, so a trend reads left to right. */
  daily: Array<{ date: string } & CoverageBucket>;
  lists: Array<{ listId: string; name?: string } & CoverageBucket>;
  /** Lists that could not be read this run. Named so a partial answer is never mistaken
   *  for a complete one. */
  unreadableLists: string[];
}

export interface CoverageDeps {
  getLeadLists: (userId: string) => Promise<any[]>;
  getLeads: (listId: string, limit: number, startKey: any) => Promise<any>;
  now?: number;
}

/**
 * True when this lead carries at least one real click identifier.
 *
 * An empty map, and a map whose every value is blank, both mean "no click" — the
 * distinction the whole measure rests on.
 */
export function hasClickId(lead: any): boolean {
  const clickIds = lead?.clickIds;
  if (!clickIds || typeof clickIds !== 'object' || Array.isArray(clickIds)) return false;
  return Object.values(clickIds).some((v) => typeof v === 'string' && v.trim() !== '');
}

/** `coverage` is null rather than 0 when nothing was measured. 0% reads as "every lead is
 *  unattributed", which is an alarm; "no leads yet" is not, and the two must not render
 *  identically on a dashboard someone glances at. */
function finalize(leads: number, withClickId: number): CoverageBucket {
  return { leads, withClickId, coverage: leads === 0 ? null : withClickId / leads };
}

export async function computeClickIdCoverage(
  userId: string,
  windowDays: number,
  deps: CoverageDeps,
): Promise<ClickIdCoverageResult> {
  const now = deps.now ?? Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

  const daily = new Map<string, { leads: number; withClickId: number }>();
  const lists: ClickIdCoverageResult['lists'] = [];
  const unreadableLists: string[] = [];
  let totalLeads = 0;
  let totalWith = 0;
  let undated = 0;

  let leadLists: any[];
  try {
    leadLists = (await deps.getLeadLists(userId)) || [];
  } catch (error: any) {
    console.error(`${TAG} could not list lead lists for ${userId}: ${error?.message}`);
    return {
      windowDays,
      totals: { ...finalize(0, 0), undated: 0 },
      daily: [],
      lists: [],
      unreadableLists: [],
    };
  }

  for (const list of leadLists) {
    // Everything this list contributes is buffered until it has been read IN FULL.
    //
    // A list that fails on page 2 has already yielded page 1, and folding those leads
    // straight into the running totals leaves an undercounted list inside a number that
    // reads as complete — while the list itself is separately reported as unreadable. The
    // daily buckets and the undated tally are separate accumulators and would each carry
    // the same partial data, so all three are buffered together (Greptile on #2413).
    let listLeads = 0;
    let listWith = 0;
    let listUndated = 0;
    const listDaily = new Map<string, { leads: number; withClickId: number }>();
    let startKey: any = undefined;
    let failed = false;

    do {
      let page: any;
      try {
        page = await deps.getLeads(list.listId, LEAD_PAGE_SIZE, startKey);
      } catch (error: any) {
        // A partial answer is fine; a partial answer that looks complete is not.
        console.error(`${TAG} could not read leads for list ${list.listId}: ${error?.message}`);
        unreadableLists.push(list.listId);
        failed = true;
        break;
      }

      for (const lead of (page?.items || []) as any[]) {
        const created = Date.parse(lead?.createdAt ?? '');
        if (!Number.isFinite(created)) {
          listUndated++;
          continue;
        }
        if (created < cutoff) continue;

        const covered = hasClickId(lead);
        const day = new Date(created).toISOString().slice(0, 10);
        const bucket = listDaily.get(day) || { leads: 0, withClickId: 0 };
        bucket.leads++;
        if (covered) bucket.withClickId++;
        listDaily.set(day, bucket);

        listLeads++;
        if (covered) listWith++;
      }

      startKey = page?.lastEvaluatedKey;
    } while (startKey);

    // Commit only a list that was read end to end.
    if (!failed) {
      for (const [day, bucket] of listDaily) {
        const running = daily.get(day) || { leads: 0, withClickId: 0 };
        running.leads += bucket.leads;
        running.withClickId += bucket.withClickId;
        daily.set(day, running);
      }
      totalLeads += listLeads;
      totalWith += listWith;
      undated += listUndated;
      lists.push({ listId: list.listId, name: list.name, ...finalize(listLeads, listWith) });
    }
  }

  return {
    windowDays,
    totals: { ...finalize(totalLeads, totalWith), undated },
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, b]) => ({ date, ...finalize(b.leads, b.withClickId) })),
    lists,
    unreadableLists,
  };
}

/** Production wiring. Kept separate from the pure computation so the unit tests never
 *  pull in the DynamoDB client. */
export async function computeClickIdCoverageForUser(
  userId: string,
  windowDays: number,
): Promise<ClickIdCoverageResult> {
  const { crmDb } = await import('./db');
  return computeClickIdCoverage(userId, windowDays, {
    getLeadLists: (id) => crmDb.getLeadListsByUserId(id),
    getLeads: (listId, limit, startKey) => crmDb.getLeadsByListId(listId, limit, startKey),
  });
}
