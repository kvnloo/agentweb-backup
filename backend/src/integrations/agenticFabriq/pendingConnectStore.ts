/**
 * Process-local, bounded OAuth state for the default-off spike. A restart
 * invalidates outstanding links. Multi-worker callback routing must fail closed
 * until a shared atomic store is separately reviewed; no persistent data changes.
 */
import crypto from 'crypto';

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONNECTS = 1_000;

interface PendingConnectRecord {
  userId: string;
  accountId: string;
  provider: 'gmail';
  connectionId: string;
  createdAt: number;
}
interface StoredConnect extends PendingConnectRecord { stateDigest: Buffer }
export interface PendingConnectChallenge { connectionId: string; state: string }
const pending = new Map<string, StoredConnect>();

function validIdentity(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f]/.test(value);
}

/** Length-delimited serialization prevents ambiguous user/account concatenation. */
export function connectionIdForAccount(accountId: string, userId: string): string {
  if (!validIdentity(accountId) || !validIdentity(userId)) throw new Error('Invalid connection binding');
  return crypto.createHash('sha256').update(JSON.stringify(['agentic-fabriq', 'gmail', userId, accountId]), 'utf8').digest('hex').slice(0, 32);
}

function expired(record: PendingConnectRecord, nowMs: number): boolean {
  return !Number.isFinite(nowMs) || nowMs < record.createdAt || nowMs - record.createdAt >= PENDING_TTL_MS;
}
function matches(record: StoredConnect, state: string): boolean {
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) return false;
  return crypto.timingSafeEqual(record.stateDigest, crypto.createHash('sha256').update(state).digest());
}

export async function createPendingConnect(
  userId: string, accountId: string, provider: string, nowMs: number = Date.now(),
): Promise<PendingConnectChallenge> {
  if (provider !== 'gmail' || !Number.isFinite(nowMs)) throw new Error('Invalid connect request');
  const connectionId = connectionIdForAccount(accountId, userId);
  for (const [id, record] of pending) if (expired(record, nowMs)) pending.delete(id);
  if (pending.has(connectionId)) throw new Error('Connect already pending');
  if (pending.size >= MAX_PENDING_CONNECTS) throw new Error('Pending connect capacity reached');
  const state = crypto.randomBytes(32).toString('hex');
  pending.set(connectionId, { userId, accountId, provider, connectionId, createdAt: nowMs, stateDigest: crypto.createHash('sha256').update(state).digest() });
  return { connectionId, state };
}

/** Conditional cleanup cannot remove a newer or another caller's attempt. */
export async function deletePendingConnect(connectionId: string, state: string): Promise<void> {
  const record = pending.get(connectionId);
  if (record && matches(record, state)) pending.delete(connectionId);
}

/** No await between lookup, constant-time comparison and deletion: atomic in this process. */
export async function consumePendingConnect(
  connectionId: string, state: string, nowMs: number = Date.now(),
): Promise<PendingConnectRecord | null> {
  const record = pending.get(connectionId);
  if (!record) return null;
  if (expired(record, nowMs)) { pending.delete(connectionId); return null; }
  if (!matches(record, state)) return null;
  pending.delete(connectionId);
  const { stateDigest: _secret, ...binding } = record;
  return binding;
}

export function clearPendingConnectsForTest(): void { pending.clear(); }
