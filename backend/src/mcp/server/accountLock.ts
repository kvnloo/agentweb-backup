/**
 * ENG-2840 wave 1 (PR C): one lock per ACCOUNT for the read, merge, write tools (market strategy, brand).
 *
 * An org's strategy and brand belong to the org, not to the member who happens to call: the owner and a listed editor each run their own agent, and their
 * two updates are a read, merge, write on the same stored lists. A lock keyed by the calling user would let the second write drop the first one's entries.
 * So the key is the org when the caller belongs to one, else the user. Calls are taken in arrival order, in this server process only (the same limit as
 * the lead tools: calls reaching different server instances are not serialized).
 */

import { withLeadLock } from './manageLeadsWrites';

/** The lock key for `prefix` and the account the caller acts for. If the caller's record cannot be read the key falls back to the user. */
export async function accountLockKey(prefix: string, c: any): Promise<string> {
  const who: string = c?.userId || c?.agentUserId || 'unknown';
  try {
    const { userDb } = await import('../../services/db');
    const user: any = await userDb.getUserById(who);
    if (user?.orgId) return `${prefix}:org:${user.orgId}`;
  } catch {
    // Fall through: a lock per user still serializes one agent's own parallel calls.
  }
  return `${prefix}:user:${who}`;
}

/** Run `work` once every earlier call for the same account and `prefix` has finished. */
export async function withAccountLock<T>(prefix: string, c: any, work: (key: string) => Promise<T>): Promise<T> {
  const key = await accountLockKey(prefix, c);
  return withLeadLock(key, () => work(key));
}
