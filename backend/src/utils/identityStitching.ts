/**
 * ENG-2687 (ENG-2682 slice): read-time identity stitching over tracker session rows.
 *
 * Browser SDK rows carry the anonymous `visitorId`; the server's `acct-<userId>` row carries
 * `accountId` (the server-generated user id) and, once linked on lead_identified /
 * registration_completed, the visitorId of the browser that identified. A visitorId seen on a row
 * that also carries an accountId maps to that account, and every row of that visitor — before and
 * after signup — resolves to the same person.
 *
 * Pure and in-memory, like utils/visitorRollup: no table, index or persisted mapping record.
 * Uses only fields the rows already have (customFields.visitorId / accountId / sessionId /
 * forwardedAt).
 */
import type { SessionRowLike } from './visitorRollup';

export interface PersonView {
  /** `acct:<accountId>` when identified, else `visitor:<visitorId>`. */
  personId: string;
  accountId?: string;
  visitorIds: string[];
  sessionIds: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * visitorId -> accountId from rows that carry both. If one browser was linked to two accounts
 * (a shared machine), the most recently written link (visitorLinkedAt) wins, so the result does not
 * depend on row order.
 */
export function buildVisitorAccountMap(rows: SessionRowLike[]): Map<string, string> {
  const best = new Map<string, { accountId: string; at: string }>();
  for (const r of rows) {
    const f = r.customFields || {};
    const vid = str(f.visitorId);
    const acct = str(f.accountId);
    if (!vid || !acct) continue;
    // visitorLinkedAt is restamped on every link; forwardedAt is the row's first-capture time and
    // never moves, so it is only a fallback for rows written before visitorLinkedAt existed.
    const at = str(f.visitorLinkedAt) || str(f.forwardedAt);
    const cur = best.get(vid);
    if (!cur || at > cur.at || (at === cur.at && acct < cur.accountId)) best.set(vid, { accountId: acct, at });
  }
  return new Map([...best].map(([vid, v]) => [vid, v.accountId]));
}

/** Groups rows into people. Rows with neither a visitorId nor an accountId are skipped. */
export function resolvePersons(rows: SessionRowLike[]): PersonView[] {
  const map = buildVisitorAccountMap(rows);
  const people = new Map<string, PersonView>();
  for (const r of rows) {
    const f = r.customFields || {};
    const vid = str(f.visitorId);
    const acct = str(f.accountId) || (vid ? map.get(vid) || '' : '');
    if (!acct && !vid) continue;
    const personId = acct ? `acct:${acct}` : `visitor:${vid}`;
    let p = people.get(personId);
    if (!p) {
      p = { personId, ...(acct ? { accountId: acct } : {}), visitorIds: [], sessionIds: [] };
      people.set(personId, p);
    }
    // A visitor shared across accounts belongs only to the view its latest link selects.
    const ownsVid = !!vid && (!str(f.accountId) || map.get(vid) === acct);
    if (ownsVid && !p.visitorIds.includes(vid)) p.visitorIds.push(vid);
    const sid = str(f.sessionId);
    if (sid && !p.sessionIds.includes(sid)) p.sessionIds.push(sid);
  }
  return [...people.values()];
}
