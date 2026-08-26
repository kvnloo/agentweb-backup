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
}

let cachedClient: AWS.DynamoDB.DocumentClient | null = null;
function client(): AWS.DynamoDB.DocumentClient {
  if (!cachedClient) cachedClient = new AWS.DynamoDB.DocumentClient();
  return cachedClient;
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
 * Create or replace the pending batch for this list. Preserves the original createdAt
 * (and, via the caller, totalOriginal/cumulative sentSoFar) across repeated resumes —
 * see crm.ts's group-email/send route for how those are accumulated before calling this.
 */
export async function upsertPendingBatch(
  userId: string,
  batch: Omit<GroupEmailPendingBatch, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getPendingBatch(userId, batch.listId).catch(() => null);
  const { listId, ...fields } = batch;
  await client()
    .put({
      TableName: CONFIGS_TABLE,
      Item: {
        userId,
        configId: pendingBatchConfigId(listId),
        ...fields,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
    })
    .promise();
}

export async function deletePendingBatch(userId: string, listId: string): Promise<void> {
  await client()
    .delete({ TableName: CONFIGS_TABLE, Key: { userId, configId: pendingBatchConfigId(listId) } })
    .promise();
}
