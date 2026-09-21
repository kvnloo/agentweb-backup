/**
 * ENG-1635/1644 PR2 — drain the pre-migration stale pendingUserQuestion
 * records so PR2's legacy-code deletion is safe to ship.
 *
 * The deck-of-one migration (ENG-1635/1644) shipped 2026-09-18 — since then,
 * nothing writes session.pendingUserQuestion anymore (confirmed via direct
 * code read: every remaining caller of buildPendingUserQuestion/
 * updateSessionAskUserQuestion only resolves an ALREADY-existing record,
 * never constructs a new one). A live scan of Dev-AW-ChatSessions found
 * exactly 40 sessions with pendingUserQuestion.status === 'awaiting', all
 * dated 2026-07-23 to 2026-09-14 — pre-dating the migration, a closed set
 * that will never grow. These don't self-resolve (resolveAwaitingUserQuestion's
 * legacy branch only fires on an active turn — nobody is going to reopen a
 * 2-month-old dev/test session) and would otherwise sit stuck forever once
 * PR2 deletes the read path that could still resolve them.
 *
 * Chosen fix: NULL pendingUserQuestion on these 40, rather than
 * force-answering them — they're dead dev/test sessions nobody will revisit,
 * and force-picking an option risks acting on stale/wrong context for a
 * session no one asked to resume. Scoped to Dev-AW-ChatSessions only — this
 * script refuses to run against anything but NODE_ENV=development by
 * construction; it is dev-data cleanup, not a production migration.
 *
 * ── What it changes ────────────────────────────────────────────────────────
 * Scans Dev-AW-ChatSessions for pendingUserQuestion.status === 'awaiting',
 * then REMOVEs (not sets to null — DynamoDB REMOVE, matching
 * chatbotDb.updateSessionAskUserQuestion's own null-clear convention) the
 * pendingUserQuestion attribute on each match. Touches no other field.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   NODE_ENV=development npx ts-node src/scripts/eng1635-null-stale-pending-user-questions.ts            # DRY RUN
 *   NODE_ENV=development npx ts-node src/scripts/eng1635-null-stale-pending-user-questions.ts --apply     # write
 */
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import '../config/aws';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (process.env.NODE_ENV !== 'development') {
  console.error(
    `Refusing to run: NODE_ENV is "${process.env.NODE_ENV}", not "development". ` +
    `This script is scoped to Dev-AW-ChatSessions dev-data cleanup only.`,
  );
  process.exit(1);
}

// '../config/aws' already configured region/credentials above, correctly
// guarded against masking a valid shared-profile/instance-role credential
// chain with unconditional undefined values — do not redo that here.
const dynamodb = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = 'Dev-AW-ChatSessions';
const APPLY = process.argv.includes('--apply');

async function scanStaleAwaiting(): Promise<Array<{ sessionId: string; createdAt: string }>> {
  const results: Array<{ sessionId: string; createdAt: string }> = [];
  let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await dynamodb
      .scan({
        TableName: TABLE_NAME,
        FilterExpression: 'pendingUserQuestion.#s = :awaiting',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':awaiting': 'awaiting' },
        ProjectionExpression: 'sessionId, pendingUserQuestion.createdAt',
        ExclusiveStartKey: lastEvaluatedKey,
      })
      .promise();
    for (const item of page.Items ?? []) {
      results.push({
        sessionId: item.sessionId,
        createdAt: item.pendingUserQuestion?.createdAt ?? 'unknown',
      });
    }
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return results;
}

async function main() {
  console.log('ENG-1635/1644 PR2 — null stale pendingUserQuestion records', {
    table: TABLE_NAME,
    mode: APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes — pass --apply to write)',
  });

  const stale = await scanStaleAwaiting();
  stale.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  console.log(`\nFound ${stale.length} session(s) with pendingUserQuestion.status === 'awaiting':`);
  for (const { sessionId, createdAt } of stale) {
    console.log(`  ${sessionId}  (created ${createdAt})`);
  }

  if (stale.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  if (!APPLY) {
    console.log(`\n[DRY RUN] Would REMOVE pendingUserQuestion on the ${stale.length} session(s) above. Re-run with --apply to write.`);
    return;
  }

  let succeeded = 0;
  let failed = 0;
  for (const { sessionId } of stale) {
    try {
      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { sessionId },
          UpdateExpression: 'REMOVE pendingUserQuestion',
        })
        .promise();
      succeeded += 1;
    } catch (error) {
      console.error(`  ${sessionId}: FAILED —`, (error as Error).message);
      failed += 1;
    }
  }

  console.log(`\nDone. cleared=${succeeded} failed=${failed}`);

  const remaining = await scanStaleAwaiting();
  console.log(`Re-scan: ${remaining.length} session(s) still awaiting.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal:', err);
      process.exit(1);
    });
}
