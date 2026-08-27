/**
 * ENG-1190 — retroactively correct the two historical judge/satisfaction scores
 * that were docked for CORRECTLY withholding a publish under the ENG-827
 * account-level publish-authorization gate, before ENG-1245's
 * PUBLISH_APPROVAL_WITHHOLDING_CLAUSE taught judges that withholding is real
 * and correct rather than a fabrication (sessionScoringService.ts:404-411).
 *
 * WHY THESE TWO ROWS, HARDCODED
 * ------------------------------
 * Both sessions ran on the "Harsha Daily X Post (Autonomous)" schedule
 * (scheduleId 1d001fba-0fb7-4bcd-80f6-6041b244a442), which has never been
 * granted standing publish authorization (autopublishAuthorized absent,
 * requirePublishApproval=false — the "never granted" case). Verified directly
 * against the live AW-ChatSessions rows and AW-TaskSchedules record — this is
 * not inferred from the ticket text:
 *
 *   e2086608-8577-41b1-a26f-4ddb9f7dbabf (2026-08-13, "Tweet Drafted")
 *     - Fangfang Judge (judge_1774188403681_idctslwzu): score 3, goalCompletion 3
 *     - Matt Judge     (judge_1779822633705_027n0uoio): score 4, goalCompletion 4
 *     - General satisfaction score was already 5/5/5/5 — untouched.
 *
 *   a67e0667-5267-4b1e-8677-079754997c14 (2026-08-14, "Drafts Prepared")
 *     - General satisfaction score: score 4, goalCompletion 4
 *     - Fangfang Judge: score 4, goalCompletion 4
 *     - Matt Judge:     score 3, goalCompletion 3
 *
 * In every one of these five entries, outputQuality and dataAccuracy were
 * already 5 and are left untouched — only goalCompletion (and the mirrored
 * top-level score, which every entry on this ticket sets equal to
 * goalCompletion) was docked for the withheld publish. This script does not
 * touch any other session — it is not a general re-scoring sweep, which would
 * require re-running the judges, not hand-editing history.
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE IT IS RUN (see CLAUDE.md).
 * This is a production data repair of historical session-scoring records.
 *
 * Idempotent: each correction re-checks the exact stale score/goalCompletion
 * values via ConditionExpression at write time, so a re-run after the row has
 * already been fixed (or changed for any other reason) is a no-op, not a
 * clobber.
 *
 * Dry-run (default): reads each row, prints the diff, writes nothing.
 *   NODE_ENV=development npx ts-node src/scripts/eng1190-correct-misscored-publish-withholding-sessions.ts
 * Apply:
 *   NODE_ENV=development npx ts-node src/scripts/eng1190-correct-misscored-publish-withholding-sessions.ts --apply
 *
 * Table prefix follows NODE_ENV like every other script here. Run against Dev
 * first; NODE_ENV=production targets the real prod rows this ticket is about.
 */
import { DynamoDB } from 'aws-sdk';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE = `${TABLE_PREFIX}AW-ChatSessions`;
const APPLY = process.argv.includes('--apply');

const CORRECTED_REASON =
  'CORRECTED (ENG-1190): the assistant correctly withheld the publish because this schedule ' +
  'has never been granted standing publish authorization (autopublishAuthorized) — the ' +
  "schedule's prompt/title text asserting \"autonomous\"/\"no approval\" is not authoritative " +
  'over that account-level gate (ENG-827). Drafting the post, persisting it, and reporting ' +
  'the hold plainly is the correct terminal state for this run. The original score incorrectly ' +
  'penalized goalCompletion for this; see PUBLISH_APPROVAL_WITHHOLDING_CLAUSE (ENG-1245).';

interface Correction {
  sessionId: string;
  // Attribute path under the session item, e.g. ['satisfactionScore'] or
  // ['judgeScores', 'judge_...'].
  path: string[];
  label: string;
  staleScore: number;
  fixedScore: number;
}

const CORRECTIONS: Correction[] = [
  {
    sessionId: 'e2086608-8577-41b1-a26f-4ddb9f7dbabf',
    path: ['judgeScores', 'judge_1774188403681_idctslwzu'],
    label: 'e2086608 / Fangfang Judge',
    staleScore: 3,
    fixedScore: 5,
  },
  {
    sessionId: 'e2086608-8577-41b1-a26f-4ddb9f7dbabf',
    path: ['judgeScores', 'judge_1779822633705_027n0uoio'],
    label: 'e2086608 / Matt Judge',
    staleScore: 4,
    fixedScore: 5,
  },
  {
    sessionId: 'a67e0667-5267-4b1e-8677-079754997c14',
    path: ['satisfactionScore'],
    label: 'a67e0667 / General satisfaction',
    staleScore: 4,
    fixedScore: 5,
  },
  {
    sessionId: 'a67e0667-5267-4b1e-8677-079754997c14',
    path: ['judgeScores', 'judge_1774188403681_idctslwzu'],
    label: 'a67e0667 / Fangfang Judge',
    staleScore: 4,
    fixedScore: 5,
  },
  {
    sessionId: 'a67e0667-5267-4b1e-8677-079754997c14',
    path: ['judgeScores', 'judge_1779822633705_027n0uoio'],
    label: 'a67e0667 / Matt Judge',
    staleScore: 3,
    fixedScore: 5,
  },
];

function getAtPath(obj: any, path: string[]): any {
  return path.reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function applyCorrection(c: Correction): Promise<void> {
  const res = await doc.get({ TableName: TABLE, Key: { sessionId: c.sessionId } }).promise();
  const item = res.Item;
  if (!item) {
    console.log(`[${c.label}] session not found — skipping.`);
    return;
  }

  const entry = getAtPath(item, c.path);
  if (!entry) {
    console.log(`[${c.label}] path ${c.path.join('.')} not found on session — skipping.`);
    return;
  }

  const currentScore = entry.score;
  const currentGoalCompletion = entry.dimensions?.goalCompletion;
  const matches = currentScore === c.staleScore && currentGoalCompletion === c.staleScore;

  console.log(`--- ${c.label} ---`);
  console.log(`  current: score=${currentScore}, goalCompletion=${currentGoalCompletion}`);
  if (!matches) {
    console.log('  does not match expected stale values — already fixed, or changed since. Skipping.');
    return;
  }
  console.log(`  fixed:   score=${c.fixedScore}, goalCompletion=${c.fixedScore} (outputQuality/dataAccuracy untouched)`);

  if (!APPLY) {
    console.log('  [dry-run] no write performed.');
    return;
  }

  // Build a nested update expression that works whether the path is one level
  // (satisfactionScore) or two (judgeScores.<judgeKey>).
  const namePlaceholders = c.path.map((_, i) => `#p${i}`);
  const names: Record<string, string> = {};
  c.path.forEach((key, i) => {
    names[`#p${i}`] = key;
  });
  const basePath = namePlaceholders.join('.');

  try {
    await doc
      .update({
        TableName: TABLE,
        Key: { sessionId: c.sessionId },
        ConditionExpression: `${basePath}.#score = :staleScore AND ${basePath}.dimensions.#goalCompletion = :staleScore`,
        UpdateExpression: `SET ${basePath}.#score = :fixedScore, ${basePath}.dimensions.#goalCompletion = :fixedScore, ${basePath}.#reason = :reason, ${basePath}.correctedAt = :now`,
        ExpressionAttributeNames: {
          ...names,
          '#score': 'score',
          '#goalCompletion': 'goalCompletion',
          '#reason': 'reason',
        },
        ExpressionAttributeValues: {
          ':staleScore': c.staleScore,
          ':fixedScore': c.fixedScore,
          ':reason': CORRECTED_REASON,
          ':now': new Date().toISOString(),
        },
      })
      .promise();
    console.log('  [applied] score corrected.');
  } catch (err) {
    if ((err as { code?: string }).code === 'ConditionalCheckFailedException') {
      console.log('  [skipped] row changed since read — already fixed or edited concurrently.');
    } else {
      throw err;
    }
  }
}

async function main(): Promise<void> {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run'} | Table: ${TABLE} (NODE_ENV=${process.env.NODE_ENV || 'production'})`);
  for (const c of CORRECTIONS) {
    await applyCorrection(c);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  });
