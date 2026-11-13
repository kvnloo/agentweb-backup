/**
 * Durable record of an in-progress group-email campaign that stopped early on a sender's
 * daily cap (ENG-265).
 *
 * The in-session "Resend to the remaining leads" button (sendAsSender's
 * SenderDailyLimitExceededError, threaded through crm.ts's group-email/send route) is
 * correct but ephemeral — it lives in frontend React state, so it's lost the moment the
 * user closes the dialog, refreshes, or comes back the next day. A 1000-lead campaign
 * against a 50/day cap takes 20 days to finish; nobody stays on one screen for 20 days.
 * Without a durable record, that's 20 days of a real gap re-opening on every navigation.
 *
 * One record per (user, list) — same reuse-the-existing-AW-Configs-table trick as
 * senderUsageTrackerFactory.ts and emailDomainClaimService.ts, no new table.
 */

import AWS from 'aws-sdk';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

function pendingBatchConfigId(listId: string): string {
  return `groupEmailPendingBatch:${listId}`;
}

export interface GroupEmailPendingBatch {
  listId: string;
  senderId: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
  unsubscribeFooterHtml?: string;
  /** Leads from the original eligible set that have never been attempted. */
  skippedLeadIds: string[];
  /** Cumulative across every send/resume in this campaign's lifecycle, not just the latest call. */
  sentSoFar: number;
  /** The eligible-lead count as of the FIRST call that created this record — carried forward
   * on every resume so "X of Y contacted" stays accurate even as skippedLeadIds shrinks. */
  totalOriginal: number;
  createdAt: string;
  updatedAt: string;
  /** ENG-2929: set while a background mailbox send owns this campaign. A run checks it before
   * every send and stops if another run has taken over, so two runs never email the same lead. */
  backgroundRunId?: string;
  /** ENG-2929: ISO time of the background run's latest progress write; a run silent for longer
   * than the stale window is treated as dead (instance restart) and may be superseded. */
  backgroundHeartbeatAt?: string;
}

let cachedClient: AWS.DynamoDB.DocumentClient | null = null;
function client(): AWS.DynamoDB.DocumentClient {
  if (!cachedClient) cachedClient = new AWS.DynamoDB.DocumentClient();
  return cachedClient;
}

/**
 * Thrown by upsertPendingBatch when the record was modified by another write between the
 * caller's read and this write. Not a hard failure — the caller should reload the current
 * record, fold its own progress on top of it, and retry.
 */
export class PendingBatchConflictError extends Error {
  constructor(public listId: string) {
    super(`The pending group-email batch for list ${listId} was updated concurrently.`);
    this.name = 'PendingBatchConflictError';
  }
}

export async function getPendingBatch(userId: string, listId: string): Promise<GroupEmailPendingBatch | null> {
  const r = await client()
    .get({ TableName: CONFIGS_TABLE, Key: { userId, configId: pendingBatchConfigId(listId) } })
    .promise();
  if (!r.Item) return null;
  const { userId: _userId, configId: _configId, ...rest } = r.Item as Record<string, unknown>;
  return { listId, ...rest } as GroupEmailPendingBatch;
}

/**
 * Create or replace the pending batch for this list. `expectedUpdatedAt` must be the
 * `updatedAt` of the record the caller's new values were computed from — `null` if the
 * caller believes no record exists yet. The write is conditioned on that value still being
 * current, so two concurrent sends/resumes for the same list (e.g. a double-click, or a
 * resume racing a fresh send) can't silently clobber each other's skippedLeadIds/sentSoFar
 * via an unconditional last-writer-wins put. Throws PendingBatchConflictError on a lost
 * race — see crm.ts's group-email/send route for the reload-and-retry loop this drives.
 * Callers own createdAt (carry the existing record's value forward on a resume, or a fresh
 * timestamp for a brand-new batch) since they've already read the prior record to compute
 * expectedUpdatedAt anyway.
 */
export async function upsertPendingBatch(
  userId: string,
  batch: Omit<GroupEmailPendingBatch, 'updatedAt'>,
  expectedUpdatedAt: string | null,
): Promise<void> {
  const { listId, ...fields } = batch;
  // The CAS token IS updatedAt, and new Date() is millisecond-resolution — a write landing in
  // the same millisecond as the updatedAt it guards against could rewrite the identical value,
  // leaving the token unchanged and letting a second, still-stale writer's precondition also
  // pass against a record it never read. Force the replacement strictly past the precondition
  // so any successful write MOVES the token (same pattern as crmDb.addLeadEngagement /
  // orgDb.updateShareSettings in db.ts, ENG-787).
  let updatedAt = new Date().toISOString();
  if (expectedUpdatedAt !== null && updatedAt <= expectedUpdatedAt) {
    const bumped = new Date(new Date(expectedUpdatedAt).getTime() + 1);
    if (!Number.isNaN(bumped.getTime())) updatedAt = bumped.toISOString();
  }
  try {
    await client()
      .put({
        TableName: CONFIGS_TABLE,
        Item: {
          userId,
          configId: pendingBatchConfigId(listId),
          ...fields,
          updatedAt,
        },
        ...(expectedUpdatedAt === null
          ? { ConditionExpression: 'attribute_not_exists(configId)' }
          : {
              ConditionExpression: 'updatedAt = :expectedUpdatedAt',
              ExpressionAttributeValues: { ':expectedUpdatedAt': expectedUpdatedAt },
            }),
      })
      .promise();
  } catch (err: any) {
    if (err?.code === 'ConditionalCheckFailedException') {
      throw new PendingBatchConflictError(listId);
    }
    throw err;
  }
}

export async function deletePendingBatch(userId: string, listId: string): Promise<void> {
  await client()
    .delete({ TableName: CONFIGS_TABLE, Key: { userId, configId: pendingBatchConfigId(listId) } })
    .promise();
}
