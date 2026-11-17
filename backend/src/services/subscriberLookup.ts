/**
 * ENG-2991: find a task's subscriber by address in any letter case. Rows are stored as typed (`Jane@X.com` and `jane@x.com` are different
 * rows) while the confirmation link carries the lower-cased address, so confirming must also look for another spelling of the same person or
 * they would be added twice. That needs the task's address list, which can be large and which anyone holding a confirmation link can ask for
 * again and again, so it is read with a narrow projection, shared between simultaneous callers, and kept for a short time under a total size
 * limit. A finished list is used for at most 10 seconds and is dropped the next time any lookup runs after that (so it can sit in memory,
 * within the size limit, until then); a read still under way is shared with later callers for at most 30 seconds, and a caller that joins a
 * read waits as long as that read takes (the database client's own timeouts bound it). Looking an address up scans the cached list, which
 * costs about 20 ms of processing at the 150,000-address limit; the join limits keep that to a few hundred an hour for one task.
 */
import { subscriberDb } from './db';

type Row = { email: string; unsubscribed?: boolean; unsubscribedAt?: string };
const TTL_MS = 10 * 1000;
const MAX_TASKS = 200;
/** A read still under way is shared with later callers, but only for this long: a read that never comes back must not hold every confirm for the task. */
const PENDING_MAX_MS = 30 * 1000;
/** Roughly 20 MB per 100,000 addresses: this bounds what the cache can hold to a few tens of megabytes. */
const MAX_CACHED_ROWS = 150_000;

type Entry = { at: number; rows: Promise<Row[]>; size: number; pending: boolean };
const cache = new Map<string, Entry>();
let cachedRows = 0;

/** Past its life: a finished read after the TTL; a read still under way after a longer ceiling, so callers meanwhile share it but a hung read cannot pin the entry. */
function isStale(entry: Entry, now: number): boolean {
  return now - entry.at > (entry.pending ? PENDING_MAX_MS : TTL_MS);
}

function drop(taskId: string) {
  const entry = cache.get(taskId);
  if (!entry) return;
  cachedRows -= entry.size;
  cache.delete(taskId);
}

/** Make room (for `room` more tasks): forget what has expired, then the least recently used, until the limits hold. */
function trim(now: number, room = 0) {
  for (const [taskId, entry] of cache) if (isStale(entry, now)) drop(taskId);
  while (cache.size + room > MAX_TASKS || cachedRows > MAX_CACHED_ROWS) {
    let victim: string | undefined;
    if (cache.size + room > MAX_TASKS) {
      victim = cache.keys().next().value as string | undefined;
    } else {
      // too many addresses held: dropping a list that holds none (a read still under way) frees nothing, so pass over those
      for (const [taskId, entry] of cache) {
        if (entry.size > 0) {
          victim = taskId;
          break;
        }
      }
    }
    if (victim === undefined) break;
    drop(victim);
  }
}

/** The stored row whose address equals `lowerEmail` ignoring case (as of the last read, at most 10 seconds old), or null. */
export async function findSubscriberAnyCase(taskId: string, lowerEmail: string, now = Date.now()): Promise<Row | null> {
  let entry = cache.get(taskId);
  if (entry && isStale(entry, now)) {
    drop(taskId);
    entry = undefined;
  }
  if (entry) {
    // least recently used goes last
    cache.delete(taskId);
    cache.set(taskId, entry);
  } else {
    const fresh: Entry = { at: now, rows: Promise.resolve([]), size: 0, pending: true };
    fresh.rows = Promise.resolve(subscriberDb.getTaskSubscriberStates(taskId)).then((r) => {
      const rows = r || [];
      fresh.pending = false;
      fresh.size = rows.length;
      if (cache.get(taskId) === fresh) {
        cachedRows += rows.length;
        // a list too big to keep is shared between the callers waiting for it and then dropped
        if (rows.length > MAX_CACHED_ROWS) drop(taskId);
        else trim(now);
      }
      return rows;
    });
    // a failed read is not kept
    fresh.rows.catch(() => {
      fresh.pending = false;
      if (cache.get(taskId) === fresh) cache.delete(taskId);
    });
    trim(now, 1);
    cache.set(taskId, fresh);
    entry = fresh;
  }
  const rows = await entry.rows;
  return rows.find((row) => typeof row?.email === 'string' && row.email.toLowerCase() === lowerEmail) || null;
}

/** Forget what was read for a task (after a row was added or changed, so the next caller sees it). */
export function forgetSubscriberLookup(taskId: string): void {
  drop(taskId);
}

/** For tests. */
export function clearSubscriberLookups(): void {
  cache.clear();
  cachedRows = 0;
}

/** For tests: how many task lists and how many rows are being kept. */
export function subscriberLookupStats(): { tasks: number; rows: number } {
  return { tasks: cache.size, rows: cachedRows };
}
