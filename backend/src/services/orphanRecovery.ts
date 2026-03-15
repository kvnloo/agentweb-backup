/**
 * Orphan recovery — resets sessions stuck in 'generating' status
 * for longer than the threshold back to 'error'.
 *
 * Called on server startup to clean up sessions that were left
 * in a generating state due to server crashes or restarts.
 */

import { chatbotDb } from './chatbotService';

/** Sessions stuck in 'generating' for more than 1 hour are considered orphaned. */
export const ORPHAN_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

interface OrphanCandidate {
  sessionId: string;
  userId: string;
  generationStatus: 'generating';
  generationStartedAt?: string;
}

/**
 * Recover orphaned sessions by resetting their generationStatus to 'error'.
 *
 * @param candidates - Sessions currently in 'generating' status to evaluate.
 * @returns Number of sessions that were recovered.
 */
export async function recoverOrphanedSessions(
  candidates: OrphanCandidate[]
): Promise<number> {
  if (candidates.length === 0) return 0;

  let recovered = 0;
  const now = Date.now();

  for (const session of candidates) {
    const startedAt = session.generationStartedAt
      ? new Date(session.generationStartedAt).getTime()
      : 0; // No timestamp = treat as very old (safety net)

    const elapsed = now - startedAt;

    // Skip sessions that are within the threshold (still legitimately generating)
    if (session.generationStartedAt && elapsed < ORPHAN_THRESHOLD_MS) {
      continue;
    }

    try {
      await chatbotDb.updateGenerationStatus(session.sessionId, 'error');
      console.log(
        `Orphan recovery: Reset session ${session.sessionId} ` +
        `(stuck for ${Math.round(elapsed / 60000)}min) to 'error'`
      );
      recovered++;
    } catch (error) {
      console.error(
        `Orphan recovery: Failed to reset session ${session.sessionId}:`,
        error
      );
    }
  }

  if (recovered > 0) {
    console.log(`Orphan recovery: Recovered ${recovered} orphaned session(s)`);
  }

  return recovered;
}

/**
 * Scan all users' sessions for orphaned generations and recover them.
 * This is the startup entry point — it scans the DB for any sessions
 * stuck in 'generating' status and resets them.
 *
 * Note: This does a broad scan which may be slow for large user bases.
 * Consider adding a GSI on generationStatus in the future.
 */
export async function runOrphanRecoveryOnStartup(): Promise<void> {
  try {
    console.log('Orphan recovery: Scanning for stuck sessions...');

    // We need to find all sessions with generationStatus = 'generating'
    // Since we don't have a GSI for this, we use a DynamoDB scan
    // This is acceptable on startup as it happens once
    const AWS = require('aws-sdk');
    const dynamodb = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-2',
    });

    const tableName = process.env.DYNAMODB_TABLE_PREFIX
      ? `${process.env.DYNAMODB_TABLE_PREFIX}AW-ChatSessions`
      : 'AW-ChatSessions';

    const params = {
      TableName: tableName,
      FilterExpression: 'generationStatus = :status',
      ExpressionAttributeValues: {
        ':status': 'generating',
      },
      ProjectionExpression: 'sessionId, userId, generationStatus, generationStartedAt',
    };

    let candidates: OrphanCandidate[] = [];
    let lastEvaluatedKey: any;

    do {
      const scanParams = lastEvaluatedKey
        ? { ...params, ExclusiveStartKey: lastEvaluatedKey }
        : params;

      const result = await dynamodb.scan(scanParams).promise();
      if (result.Items) {
        candidates = candidates.concat(result.Items as OrphanCandidate[]);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (candidates.length === 0) {
      console.log('Orphan recovery: No stuck sessions found');
      return;
    }

    console.log(`Orphan recovery: Found ${candidates.length} session(s) in 'generating' state`);
    await recoverOrphanedSessions(candidates);
  } catch (error) {
    // Non-fatal — log and continue server startup
    console.error('Orphan recovery: Failed to scan for stuck sessions:', error);
  }
}
