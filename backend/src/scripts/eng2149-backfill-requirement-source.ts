/**
 * OPS-4 (ENG-2149) backfill for ENG-2143: record the CURRENT ads requirement on existing
 * AW-AccountCapabilityRequirements `ad_platform_integration` rows.
 *
 * Fields written (see AccountCapabilityRequirementSource in accountCapabilityRequirementsDb.ts):
 *   requirementSource      'contracted' | 'onboarding_intent'  ('recent_ads_action' is never backfilled)
 *   requirementVerifiedAt  ISO time: now for contracted, the row's requiredSince for onboarding_intent
 *   requirementSetBy       'eng-2149-backfill' (or --set-by=<admin email>)
 *
 * Every existing row was created from onboarding intent, so that is what each row gets unless the
 * operator names it as contracted. A row that already has a requirementSource is never touched.
 *
 *   npx ts-node src/scripts/eng2149-backfill-requirement-source.ts                        # dry run (default)
 *   npx ts-node src/scripts/eng2149-backfill-requirement-source.ts --contracted=<id>,<id>  # dry run with contracted ids
 *   ENG2149_BACKFILL_APPLY=AW-AccountCapabilityRequirements \
 *     npx ts-node src/scripts/eng2149-backfill-requirement-source.ts --apply [--contracted=...]
 *   ENG2149_BACKFILL_APPLY=AW-AccountCapabilityRequirements \
 *     npx ts-node src/scripts/eng2149-backfill-requirement-source.ts --rollback --apply     # remove what this script wrote
 *   (rollback matches requirementSetBy exactly: pass the same --set-by the apply run used)
 *
 * `--apply` refuses to run unless ENG2149_BACKFILL_APPLY equals the exact target table name, so a
 * wrong NODE_ENV cannot write to the other environment's table. Output is counts only.
 */
import AWS from "aws-sdk";
import type { AccountCapabilityRequirementSource } from "../services/accountCapabilityRequirementsDb";

export const BACKFILL_SET_BY = "eng-2149-backfill";
export const APPLY_ENV_VAR = "ENG2149_BACKFILL_APPLY";
const TABLE_NAME = `${process.env.NODE_ENV === "development" ? "Dev-" : ""}AW-AccountCapabilityRequirements`;

/** A scanned row. The table also holds `account_health_signal` rows, hence the plain string. */
export interface ScannedCapabilityRow {
  userId: string;
  capability: string;
  requiredSince?: string;
  requirementSource?: AccountCapabilityRequirementSource;
  requirementSetBy?: string;
}

export interface RequirementBackfillWrite {
  userId: string;
  requirementSource: AccountCapabilityRequirementSource;
  requirementVerifiedAt: string;
  requirementSetBy: string;
}

export interface RequirementBackfillPlan {
  writes: RequirementBackfillWrite[];
  alreadySet: number;
  /** --contracted ids with no ad_platform_integration row. */
  unknownContracted: string[];
}

export function planRequirementBackfill(
  rows: ReadonlyArray<ScannedCapabilityRow>,
  contracted: ReadonlySet<string>,
  nowIso: string,
  setBy: string = BACKFILL_SET_BY,
): RequirementBackfillPlan {
  const adRows = rows.filter((row) => row.capability === "ad_platform_integration");
  const known = new Set(adRows.map((row) => row.userId));
  const plan: RequirementBackfillPlan = {
    writes: [],
    alreadySet: 0,
    unknownContracted: [...contracted].filter((id) => !known.has(id)),
  };
  for (const row of adRows) {
    if (row.requirementSource) {
      plan.alreadySet++;
      continue;
    }
    const isContracted = contracted.has(row.userId);
    plan.writes.push({
      userId: row.userId,
      requirementSource: isContracted ? "contracted" : "onboarding_intent",
      requirementVerifiedAt: isContracted || !row.requiredSince ? nowIso : row.requiredSince,
      requirementSetBy: setBy,
    });
  }
  return plan;
}

/** Rows whose requirement fields were written by a run with this `setBy` (exact match). */
export function planRequirementRollback(rows: ReadonlyArray<ScannedCapabilityRow>, setBy: string): ScannedCapabilityRow[] {
  return rows.filter((row) => row.capability === "ad_platform_integration" && row.requirementSetBy === setBy);
}

/** Throws unless the operator named the exact table in the apply env var. */
export function assertApplyAllowed(env: NodeJS.ProcessEnv, tableName: string): void {
  if (env[APPLY_ENV_VAR] !== tableName) {
    throw new Error(`--apply refused: set ${APPLY_ENV_VAR}=${tableName} to write to ${tableName}`);
  }
}

function argValue(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function scanRows(dynamodb: AWS.DynamoDB.DocumentClient): Promise<ScannedCapabilityRow[]> {
  const rows: ScannedCapabilityRow[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await dynamodb
      .scan({ TableName: TABLE_NAME, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) })
      .promise();
    rows.push(...((page.Items ?? []) as ScannedCapabilityRow[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return rows;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const rollback = argv.includes("--rollback");
  const contracted = new Set((argValue(argv, "--contracted") ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  const setBy = argValue(argv, "--set-by") ?? BACKFILL_SET_BY;
  if (apply) assertApplyAllowed(process.env, TABLE_NAME);

  const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
  const rows = await scanRows(dynamodb);
  console.log(`[eng2149] ${TABLE_NAME}: ${rows.length} row(s) ${JSON.stringify(countBy(rows, (r) => r.capability))}`);
  console.log(`[eng2149] requirementSource today: ${JSON.stringify(countBy(rows, (r) => r.requirementSource ?? "(absent)"))}`);

  if (rollback) {
    const mine = planRequirementRollback(rows, setBy);
    console.log(`[eng2149] rollback: ${mine.length} row(s) carry fields written by --set-by=${setBy} (apply=${apply})`);
    if (!apply) return;
    for (const row of mine) {
      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { userId: row.userId, capability: row.capability },
          UpdateExpression: "REMOVE requirementSource, requirementVerifiedAt, requirementSetBy",
          ConditionExpression: "requirementSetBy = :setBy",
          ExpressionAttributeValues: { ":setBy": row.requirementSetBy },
        })
        .promise();
    }
    console.log(`[eng2149] rollback applied to ${mine.length} row(s)`);
    return;
  }

  const plan = planRequirementBackfill(rows, contracted, new Date().toISOString(), setBy);
  if (plan.unknownContracted.length > 0) {
    throw new Error(`${plan.unknownContracted.length} --contracted id(s) have no ad_platform_integration row; nothing written`);
  }
  console.log(
    `[eng2149] plan: ${plan.writes.length} write(s) ${JSON.stringify(countBy(plan.writes, (w) => w.requirementSource))}, ` +
      `${plan.alreadySet} already set (untouched), apply=${apply}`,
  );
  if (!apply) {
    console.log("[eng2149] dry run: nothing written");
    return;
  }
  let written = 0;
  for (const write of plan.writes) {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { userId: write.userId, capability: "ad_platform_integration" },
        UpdateExpression: "SET requirementSource = :source, requirementVerifiedAt = :verifiedAt, requirementSetBy = :setBy",
        // Never create a row and never overwrite a source someone set after the scan.
        ConditionExpression: "attribute_exists(userId) AND attribute_not_exists(requirementSource)",
        ExpressionAttributeValues: {
          ":source": write.requirementSource,
          ":verifiedAt": write.requirementVerifiedAt,
          ":setBy": write.requirementSetBy,
        },
      })
      .promise();
    written++;
  }
  console.log(`[eng2149] applied ${written} write(s)`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[eng2149] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
