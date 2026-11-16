/**
 * ENG-2991: find a task's subscriber by address in any letter case. Rows are stored as typed (`Jane@X.com` and `jane@x.com` are different
 * rows) while the confirmation link carries the lower-cased address, so confirming must also look for another spelling of the same person or
 * they would be added twice. That needs the task's address list, which can be large and which anyone holding a confirmation link can ask for
 * again and again, so it is read with a narrow projection, shared between simultaneous callers, and kept for a short time.
 */
import { subscriberDb } from './db';

type Row = { email: string; unsubscribed?: boolean; unsubscribedAt?: string };
const TTL_MS = 30 * 1000;
const MAX_TASKS = 200;
const cache = new Map<string, { at: number; rows: Promise<Row[]> }>();

/** The stored row whose address equals `lowerEmail` ignoring case (as of the last read, at most 30 seconds old), or null. */
export async function findSubscriberAnyCase(taskId: string, lowerEmail: string, now = Date.now()): Promise<Row | null> {
  let entry = cache.get(taskId);
  if (!entry || now - entry.at > TTL_MS) {
    const rows = Promise.resolve(subscriberDb.getTaskSubscriberStates(taskId)).then((r) => r || []);
    entry = { at: now, rows };
    cache.set(taskId, entry);
    // a failed read is not kept
    rows.catch(() => {
      if (cache.get(taskId) === entry) cache.delete(taskId);
    });
    if (cache.size > MAX_TASKS) cache.delete(cache.keys().next().value as string);
  }
  const rows = await entry.rows;
  return rows.find((row) => typeof row?.email === 'string' && row.email.toLowerCase() === lowerEmail) || null;
}

/** Forget what was read for a task (after a row was added or changed here, so the next caller sees it). */
export function forgetSubscriberLookup(taskId: string): void {
  cache.delete(taskId);
}

/** For tests. */
export function clearSubscriberLookups(): void {
  cache.clear();
}
