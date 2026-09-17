/**
 * Process-local, bounded OAuth callback state for the default-off ENG-1685
 * spike. It intentionally avoids a new persistent settings key: persistent
 * data-plane changes require separate approval. A process restart invalidates
 * an outstanding link, which is safe and acceptable for this draft spike.
 */

import crypto from 'crypto';

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONNECTS = 1_000;

interface PendingConnectRecord {
  userId: string;
  accountId: string;
  provider: string;
  createdAt: number;
}

const pending = new Map<string, PendingConnectRecord>();

/** Derives the stable, opaque 32-hex Fabriq connection binding for a mailbox. */
export function connectionIdForAccount(accountId: string): string {
  return crypto.createHash('sha256').update(`agentic-fabriq:gmail:${accountId}`, 'utf8').digest('hex').slice(0, 32);
}

function prune(nowMs: number): void {
  for (const [id, record] of pending) {
    if (nowMs - record.createdAt > PENDING_TTL_MS) pending.delete(id);
  }
}

/**
 * Atomically records one bounded callback state keyed by the exact mailbox
 * connection binding. Throws when the process-local cap is exhausted.
 */
export async function createPendingConnect(
  userId: string,
  accountId: string,
  provider: string,
  nowMs: number = Date.now(),
): Promise<string> {
  prune(nowMs);
  if (pending.size >= MAX_PENDING_CONNECTS) throw new Error('Pending connect capacity reached');
  const connectionId = connectionIdForAccount(accountId);
  pending.set(connectionId, { userId, accountId, provider, createdAt: nowMs });
  return connectionId;
}

/** Deletes a pending state after a failed initiation attempt. */
export async function deletePendingConnect(connectionId: string): Promise<void> {
  pending.delete(connectionId);
}

/**
 * Atomically consumes a callback state. Deleting before returning guarantees a
 * second concurrent callback cannot observe the same state.
 */
export async function consumePendingConnect(
  connectionId: string,
  nowMs: number = Date.now(),
): Promise<PendingConnectRecord | null> {
  const record = pending.get(connectionId);
  pending.delete(connectionId);
  if (!record || nowMs - record.createdAt > PENDING_TTL_MS) return null;
  return record;
}

/** Clears process-local state for isolated tests only. */
export function clearPendingConnectsForTest(): void {
  pending.clear();
}
