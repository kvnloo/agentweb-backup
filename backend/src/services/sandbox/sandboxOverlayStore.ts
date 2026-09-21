import { activeEvaluationCondition } from '../evaluationPersistence';
import AWS from 'aws-sdk';
import { randomUUID } from 'crypto';
import { EvaluationDenied, isEvaluationUser } from '../evaluationPolicy';
import { EMPTY_OVERLAY, SandboxOverlay } from './types';

/**
 * Per-account mutable overlay (ENG-1909). One CAS item per sandbox principal in the SAME
 * AW-Evaluations table evaluationStore.ts already owns — no new table, no new IAM. Same key
 * family as the policy row (evaluation/<userId>) and its audit rows
 * (evaluation/<userId>/audit/<uuid>): this row lives at evaluation/<userId>/sim.
 *
 * Optimistic concurrency, same shape as settingsService.ts's setSettingIfValueMatches (ENG-965):
 * read the current revision, compute the next overlay, write conditioned on the exact revision
 * just read, transactionally fenced by the root evaluation. An overlay condition failure means
 * the read was stale; a root condition failure denies the mutation without retrying.
 */
export interface SandboxOverlayStore {
  /** Returns EMPTY_OVERLAY (revision 0) when no row exists yet — never null, never throws for a missing row. */
  load(userId: string): Promise<SandboxOverlay>;
  /**
   * Applies mutateFn to the current overlay and writes the result back. mutateFn receives the
   * FRESHLY RE-READ overlay on every retry attempt, so it must be a pure function of its input
   * (no closing over a stale snapshot) — callers that need to know what they actually did (e.g.
   * the id a create was assigned) should read it off the RETURNED overlay, which reflects the
   * attempt that actually persisted.
   */
  mutate(userId: string, mutateFn: (current: SandboxOverlay) => SandboxOverlay, audit?: SandboxOverlayAudit): Promise<SandboxOverlay>;
}

export interface SandboxOverlayAudit { action: string; details?: Record<string, unknown> }

/** All MAX_RETRIES attempts hit a write conflict — sustained contention, not a one-off race. */
export class SandboxOverlayMutationFailed extends Error {
  constructor(userId: string, attempts: number) {
    super(`Could not write the sandbox overlay for ${userId} after ${attempts} attempts (persistent write conflict)`);
  }
}

const MAX_RETRIES = 5;

function isOverlayConflict(error: unknown): boolean {
  const err = error as { code?: string; CancellationReasons?: { Code?: string }[] };
  if (err?.code === 'TransactionConflictException') return true;
  if (err?.code !== 'TransactionCanceledException' || !Array.isArray(err.CancellationReasons)) return false;
  const [root, overlay] = err.CancellationReasons;
  if (root?.Code === 'ConditionalCheckFailed') throw new EvaluationDenied();
  return err.CancellationReasons.every(reason => reason?.Code === 'None' || reason?.Code === 'TransactionConflict' ||
    (reason === overlay && reason.Code === 'ConditionalCheckFailed')) &&
    err.CancellationReasons.some(reason => reason?.Code === 'TransactionConflict' || reason?.Code === 'ConditionalCheckFailed');
}

class DynamoSandboxOverlayStore implements SandboxOverlayStore {
  private prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  private table = `${this.prefix}AW-Evaluations`;
  constructor(private db: AWS.DynamoDB.DocumentClient) {}

  private key(userId: string): { evaluationKey: string } {
    if (!isEvaluationUser(userId) || !/^eval_[a-zA-Z0-9-]+$/.test(userId)) throw new EvaluationDenied();
    return { evaluationKey: `evaluation/${userId}/sim` };
  }

  async load(userId: string): Promise<SandboxOverlay> {
    const result = await this.db.get({ TableName: this.table, Key: this.key(userId), ConsistentRead: true }).promise();
    if (!result.Item) return { ...EMPTY_OVERLAY };
    const { evaluationKey, userId: _u, ...overlay } = result.Item as Record<string, unknown>;
    // Normalize onto EMPTY_OVERLAY: a row written before a field existed on SandboxOverlay
    // (exactly what happened here — customAudiences was added after this store shipped)
    // would otherwise come back missing that field, and merge()'s Object.values(overlay.X)
    // throws on undefined. Every future field addition gets the same forward-compatibility
    // for free.
    return { ...EMPTY_OVERLAY, ...overlay } as SandboxOverlay;
  }

  async mutate(userId: string, mutateFn: (current: SandboxOverlay) => SandboxOverlay, audit?: SandboxOverlayAudit): Promise<SandboxOverlay> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const current = await this.load(userId);
      const next = mutateFn(current);
      const item = { ...next, revision: current.revision + 1, evaluationKey: this.key(userId).evaluationKey, userId };
      try {
        await this.db.transactWrite({ TransactItems: [
          activeEvaluationCondition(userId, this.prefix),
          { Put: {
            TableName: this.table, Item: item,
            ConditionExpression: current.revision === 0
              ? 'attribute_not_exists(evaluationKey) OR revision = :expected' : 'revision = :expected',
            ExpressionAttributeValues: { ':expected': current.revision },
          } },
        ] }).promise();
      } catch (error) {
        if (isOverlayConflict(error)) continue;
        throw error;
      }
      // The overlay write is what matters for correctness; a failed audit append is a
      // logged, best-effort side note, not a reason to report the mutation itself as failed.
      if (audit) {
        try {
          await this.db.put({
            TableName: this.table,
            Item: { evaluationKey: `evaluation/${userId}/audit/${randomUUID()}`, userId, actor: userId, action: audit.action, at: new Date().toISOString(), ...audit.details },
            ConditionExpression: 'attribute_not_exists(evaluationKey)',
          }).promise();
        } catch (error) {
          console.error('[sandboxOverlayStore] audit append failed (overlay write already succeeded):', error);
        }
      }
      const { evaluationKey, userId: _u2, ...rest } = item;
      return rest as unknown as SandboxOverlay;
    }
    throw new SandboxOverlayMutationFailed(userId, MAX_RETRIES);
  }
}

let overlayStore: SandboxOverlayStore | null = null;
export function getSandboxOverlayStore(db?: AWS.DynamoDB.DocumentClient): SandboxOverlayStore {
  if (db) return new DynamoSandboxOverlayStore(db);
  if (!overlayStore) overlayStore = new DynamoSandboxOverlayStore(new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' }));
  return overlayStore;
}
