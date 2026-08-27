/**
 * ENG-1190 — strip stale autonomy wording from one specific, already-identified
 * schedule: "Harsha Daily X Post (Autonomous)" (scheduleId
 * 1d001fba-0fb7-4bcd-80f6-6041b244a442).
 *
 * WHY THIS ONE ROW, HARDCODED
 * ----------------------------
 * This is not a general sweep. ENG-1190's investigation confirmed this specific
 * schedule's name and prompt both assert autonomous, no-approval publishing
 * ("Harsha Daily X Post (Autonomous)", "...no approval — autonomous run") while
 * its actual DB state is requirePublishApproval=false, autopublishAuthorized
 * absent (never granted) — i.e. the ENG-827/ENG-1245 account-level publish gate
 * has never authorized this schedule to publish unattended, and the prompt text
 * is not authoritative over that gate (schedulePublishAuthorization.ts). Every
 * run to date has drafted and withheld, contradicting what the name/prompt tell
 * the owner to expect. A general content sweep for "autonomous"/"no approval"
 * wording across all schedules is a separate, much larger exercise (the ticket's
 * fix recommendation #3) and is out of scope here — this script only repairs
 * the one row this ticket's two reported sessions came from.
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE IT IS RUN (see CLAUDE.md).
 * This is a production data repair of a live customer schedule row.
 *
 * WHAT IT CHANGES
 * ----------------
 *  - scheduleName: "Harsha Daily X Post (Autonomous)" -> "Harsha Daily X Post"
 *    (drops the false autonomy claim from the name itself).
 *  - startingMessage: replaces the final instruction line's "no approval —
 *    autonomous run" claim with wording that matches actual behavior — attempt
 *    the post, but if withheld by the real publish-authorization gate, say so
 *    and do not treat the prompt as authorization to override it.
 *  - promptRevisions: the previous startingMessage is snapshotted first, the
 *    same way agentModeController.ts's normal edit path does it, so the change
 *    is revertible and consistent with every other prompt edit on this row.
 *
 * It deliberately does NOT touch requirePublishApproval or autopublishAuthorized.
 * Whether this schedule SHOULD be granted standing publish authorization is the
 * owner's decision (see grant-schedule-autopublish.ts) — this script only stops
 * the prompt from lying about a decision that has not been made.
 *
 * Idempotent: only writes if the row's scheduleName/startingMessage still match
 * the exact stale strings this script expects (checked in code and re-asserted
 * with a ConditionExpression at write time), so a re-run after someone else has
 * already edited the row is a no-op, not a clobber.
 *
 * Dry-run (default): reads the row, prints the diff, writes nothing.
 *   NODE_ENV=development npx ts-node src/scripts/eng1190-fix-harsha-x-schedule-wording.ts
 * Apply:
 *   NODE_ENV=development npx ts-node src/scripts/eng1190-fix-harsha-x-schedule-wording.ts --apply
 *
 * Table prefix follows NODE_ENV like every other script here. Run against Dev
 * first; NODE_ENV=production targets the real prod table this ticket is about.
 */
import { DynamoDB } from 'aws-sdk';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE = `${TABLE_PREFIX}AW-TaskSchedules`;
const APPLY = process.argv.includes('--apply');

const SCHEDULE_ID = '1d001fba-0fb7-4bcd-80f6-6041b244a442';
const SCHEDULE_PROMPT_REVISION_LIMIT = 10;

const STALE_NAME = 'Harsha Daily X Post (Autonomous)';
const FIXED_NAME = 'Harsha Daily X Post';

const STALE_TAIL =
  'On posting days, post directly with post_on_connected_account(platform="twitter", content=...). One tweet, no thread, no approval — autonomous run. If posting fails with an auth error, report that X needs reconnecting.';

const FIXED_TAIL =
  'On posting days, attempt to post directly with post_on_connected_account(platform="twitter", content=...), one tweet, no thread. This schedule is NOT currently authorized to publish unattended — if the post is withheld for that reason, that is expected and correct: save the draft, report the hold plainly, and do not treat this prompt as authorization to override that account-level setting. If posting fails with an auth error instead, report that X needs reconnecting.';

async function main(): Promise<void> {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run'} | Table: ${TABLE} (NODE_ENV=${process.env.NODE_ENV || 'production'})`);

  const res = await doc.get({ TableName: TABLE, Key: { scheduleId: SCHEDULE_ID } }).promise();
  const item = res.Item;
  if (!item) {
    console.log(`No schedule found with scheduleId=${SCHEDULE_ID} in ${TABLE}. Nothing to do.`);
    return;
  }

  const currentName: string = item.scheduleName || '';
  const currentPrompt: string = item.startingMessage || '';
  const nameMatches = currentName === STALE_NAME;
  const promptMatches = currentPrompt.includes(STALE_TAIL);

  if (!nameMatches && !promptMatches) {
    console.log('Row does not match the expected stale wording (already fixed, or edited since). Nothing to do.');
    console.log(`  current scheduleName: ${JSON.stringify(currentName)}`);
    return;
  }

  const nextName = nameMatches ? FIXED_NAME : currentName;
  const nextPrompt = promptMatches ? currentPrompt.replace(STALE_TAIL, FIXED_TAIL) : currentPrompt;

  console.log('--- scheduleName ---');
  console.log(`  before: ${JSON.stringify(currentName)}`);
  console.log(`  after:  ${JSON.stringify(nextName)}`);
  console.log('--- startingMessage tail ---');
  console.log(`  before: ...${STALE_TAIL}`);
  console.log(`  after:  ...${FIXED_TAIL}`);

  if (!APPLY) {
    console.log('[dry-run] no write performed. Re-run with --apply to write these changes.');
    return;
  }

  const existingRevisions: Array<{ startingMessage: string; updatedAt: string }> = Array.isArray(item.promptRevisions)
    ? item.promptRevisions
    : [];
  const nextRevisions = promptMatches
    ? [...existingRevisions, { startingMessage: currentPrompt, updatedAt: new Date().toISOString() }].slice(
        -SCHEDULE_PROMPT_REVISION_LIMIT
      )
    : existingRevisions;

  try {
    await doc
      .update({
        TableName: TABLE,
        Key: { scheduleId: SCHEDULE_ID },
        ConditionExpression: 'scheduleName = :beforeName AND startingMessage = :beforePrompt',
        UpdateExpression: 'SET scheduleName = :afterName, startingMessage = :afterPrompt, promptRevisions = :revisions, updatedAt = :now',
        ExpressionAttributeValues: {
          ':beforeName': currentName,
          ':beforePrompt': currentPrompt,
          ':afterName': nextName,
          ':afterPrompt': nextPrompt,
          ':revisions': nextRevisions,
          ':now': new Date().toISOString(),
        },
      })
      .promise();
    console.log('[applied] schedule wording fixed.');
  } catch (err) {
    if ((err as { code?: string }).code === 'ConditionalCheckFailedException') {
      console.log('[skipped] row changed since read — already fixed or edited concurrently. Re-run to check current state.');
    } else {
      throw err;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  });
