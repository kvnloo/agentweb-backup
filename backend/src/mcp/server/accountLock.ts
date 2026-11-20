/**
 * ENG-2840 wave 1 (PR C): one lock per ACCOUNT for the read, merge, write tools (market strategy and brand).
 *
 * An org's strategy and brand belong to the org, not to the member who happens to call: the owner and a listed editor each run their own agent, and their
 * two updates are a read, merge, write on the same stored lists. A lock keyed by the calling user would let the second write drop the first one's entries.
 * So the key is the org when the caller belongs to one, else the user. Calls are taken in arrival order, in this server process only (the same limit as
 * the lead tools: calls reaching different server instances are not serialized).
 */

import { withLeadLock } from './manageLeadsWrites';

/**
 * The lock key for `prefix` and the account the caller acts for. The caller's record is read consistently (the index read alone can be older than an org
 * switch). If it cannot be read, or the caller has no record, the call is refused: falling back to a per-user key would let two members of one org run
 * unserialized, which is the loss the lock exists to prevent.
 */
export async function accountLockKey(prefix: string, c: any): Promise<string> {
  const who: string = c?.userId || c?.agentUserId || 'unknown';
  let user: any;
  try {
    const { userDb } = await import('../../services/db');
    user = await userDb.getUserByIdConsistent(who);
  } catch (err) {
    throw new Error(`${prefix}: the account could not be identified (${(err as Error)?.message ?? 'lookup failed'}), so nothing was changed. Try again.`);
  }
  if (!user) throw new Error(`${prefix}: the account could not be identified, so nothing was changed. Try again.`);
  return user.orgId ? `${prefix}:org:${user.orgId}` : `${prefix}:user:${who}`;
}

/** Run `work` once every earlier call for the same account and `prefix` has finished. */
export async function withAccountLock<T>(prefix: string, c: any, work: (key: string) => Promise<T>): Promise<T> {
  const key = await accountLockKey(prefix, c);
  return withLeadLock(key, () => work(key));
}
