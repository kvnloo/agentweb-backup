/**
 * ENG-1164 — retroactively correct the one historical session whose judge and
 * satisfaction scores were docked for CORRECTLY declining to emit a bare
 * punctuation-only final reply ("}]") that ENG-1054's output-integrity guard
 * (`isUnusableSynthesis`, synthesisResidue.ts) exists specifically to block,
 * before OUTPUT_INTEGRITY_GUARD_CLAUSE taught judges that declining is
 * guard-required behavior, not a formatting failure (sessionScoringService.ts).
 *
 * WHY THIS ONE ROW, HARDCODED
 * ----------------------------
 * Session 1926c237-653a-44c1-8f0d-12d9692c40d7 ("List Connected Accounts
 * Serialization Test") is the exact session named in the ticket. Verified
 * directly against the live AW-ChatSessions row, not inferred from the ticket
 * text:
 *
 *   satisfactionScore:                        score 2, goalCompletion 3, outputQuality 2, dataAccuracy 5
 *   judge_1774188403681_idctslwzu (Fangfang):  score 2, goalCompletion 2, outputQuality 2, dataAccuracy 5
 *   judge_1779822633705_027n0uoio (Matt):      score 2, goalCompletion 2, outputQuality 2, dataAccuracy 5
 *
 * Unlike the ENG-1245/ENG-1190 precedent (which only ever docked
 * goalCompletion), this guard conflict is named in its own clause as
 * penalizing BOTH goalCompletion and outputQuality
 * (OUTPUT_INTEGRITY_GUARD_CLAUSE: "Do NOT lower goalCompletion, outputQuality,
 * or instructionCompliance..."), and all three stale records show exactly
 * that shape. dataAccuracy was already 5 in every entry (confirming nothing
 * was fabricated) and is left untouched. This script does not touch any other
 * session — it is not a general re-scoring sweep, which would require
 * re-running the judges, not hand-editing history.
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE IT IS RUN (see CLAUDE.md).
 * This is a production data repair of historical session-scoring records.
 *
 * Idempotent: each correction re-checks the exact stale score/goalCompletion/
 * outputQuality values via ConditionExpression at write time, so a re-run
 * after the row has already been fixed (or changed for any other reason) is a
 * no-op, not a clobber.
 *
 * Dry-run (default): reads the row, prints the diff, writes nothing.
 *   NODE_ENV=development npx ts-node src/scripts/eng1164-correct-misscored-output-integrity-session.ts
 * Apply:
 *   NODE_ENV=development npx ts-node src/scripts/eng1164-correct-misscored-output-integrity-session.ts --apply
 *
 * Table prefix follows NODE_ENV like every other script here. Run against Dev
 * first; NODE_ENV=production targets the real prod row this ticket is about.
 */
import { DynamoDB } from 'aws-sdk';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE = `${TABLE_PREFIX}AW-ChatSessions`;
const APPLY = process.argv.includes('--apply');

const SESSION_ID = '1926c237-653a-44c1-8f0d-12d9692c40d7';

const CORRECTED_REASON =
  'CORRECTED (ENG-1164): the assistant correctly declined to make its entire final reply ' +
  'nothing but the punctuation/JSON debris "}]" the internal serialization test asked for, ' +
  'because ENG-1054\'s output-integrity guard blocks exactly that shape. It completed the ' +
  'underlying request (list_connected_accounts ran successfully) and explained why it could ' +
  'not comply with the literal punctuation-only format. That is correct, guard-required ' +
  'behavior, not a defect. The original score incorrectly penalized goalCompletion and ' +
  'outputQuality for this; see OUTPUT_INTEGRITY_GUARD_CLAUSE.';

interface Correction {
  // Attribute path under the session item, e.g. ['satisfactionScore'] or
  // ['judgeScores', 'judge_...'].
  path: string[];
  label: string;
  staleScore: number;
  staleGoalCompletion: number;
  staleOutputQuality: number;
  fixedScore: number;
  fixedGoalCompletion: number;
  fixedOutputQuality: number;
}

const CORRECTIONS: Correction[] = [
  {
    path: ['satisfactionScore'],
    label: 'General satisfaction',
    staleScore: 2,
    staleGoalCompletion: 3,
    staleOutputQuality: 2,
    fixedScore: 5,
    fixedGoalCompletion: 5,
    fixedOutputQuality: 5,
  },
  {
    path: ['judgeScores', 'judge_1774188403681_idctslwzu'],
    label: 'Fangfang Judge',
    staleScore: 2,
    staleGoalCompletion: 2,
    staleOutputQuality: 2,
    fixedScore: 5,
    fixedGoalCompletion: 5,
    fixedOutputQuality: 5,
  },
  {
    path: ['judgeScores', 'judge_1779822633705_027n0uoio'],
    label: 'Matt Judge',
    staleScore: 2,
    staleGoalCompletion: 2,
    staleOutputQuality: 2,
    fixedScore: 5,
    fixedGoalCompletion: 5,
    fixedOutputQuality: 5,
  },
];

function getAtPath(obj: any, path: string[]): any {
  return path.reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function applyCorrection(item: any, c: Correction): Promise<void> {
  const entry = getAtPath(item, c.path);
  if (!entry) {
    console.log(`[${c.label}] path ${c.path.join('.')} not found on session — skipping.`);
    return;
  }

  const currentScore = entry.score;
  const currentGoalCompletion = entry.dimensions?.goalCompletion;
  const currentOutputQuality = entry.dimensions?.outputQuality;
  const matches =
    currentScore === c.staleScore &&
    currentGoalCompletion === c.staleGoalCompletion &&
    currentOutputQuality === c.staleOutputQuality;

  console.log(`--- ${c.label} ---`);
  console.log(
    `  current: score=${currentScore}, goalCompletion=${currentGoalCompletion}, outputQuality=${currentOutputQuality}`,
  );
  if (!matches) {
    console.log('  does not match expected stale values — already fixed, or changed since. Skipping.');
    return;
  }
  console.log(
    `  fixed:   score=${c.fixedScore}, goalCompletion=${c.fixedGoalCompletion}, outputQuality=${c.fixedOutputQuality} (dataAccuracy untouched)`,
  );

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
        Key: { sessionId: SESSION_ID },
        ConditionExpression:
          `${basePath}.#score = :staleScore AND ` +
          `${basePath}.#dimensions.#goalCompletion = :staleGoalCompletion AND ` +
          `${basePath}.#dimensions.#outputQuality = :staleOutputQuality`,
        UpdateExpression:
          `SET ${basePath}.#score = :fixedScore, ` +
          `${basePath}.#dimensions.#goalCompletion = :fixedGoalCompletion, ` +
          `${basePath}.#dimensions.#outputQuality = :fixedOutputQuality, ` +
          `${basePath}.#reason = :reason, ${basePath}.#correctedAt = :now`,
        ExpressionAttributeNames: {
          ...names,
          '#score': 'score',
          '#dimensions': 'dimensions',
          '#goalCompletion': 'goalCompletion',
          '#outputQuality': 'outputQuality',
          '#reason': 'reason',
          '#correctedAt': 'correctedAt',
        },
        ExpressionAttributeValues: {
          ':staleScore': c.staleScore,
          ':staleGoalCompletion': c.staleGoalCompletion,
          ':staleOutputQuality': c.staleOutputQuality,
          ':fixedScore': c.fixedScore,
          ':fixedGoalCompletion': c.fixedGoalCompletion,
          ':fixedOutputQuality': c.fixedOutputQuality,
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
  const res = await doc.get({ TableName: TABLE, Key: { sessionId: SESSION_ID } }).promise();
  const item = res.Item;
  if (!item) {
    console.log(`Session ${SESSION_ID} not found — nothing to do.`);
    return;
  }
  for (const c of CORRECTIONS) {
    await applyCorrection(item, c);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  });
