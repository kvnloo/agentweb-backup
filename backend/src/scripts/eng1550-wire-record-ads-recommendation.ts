/**
 * ENG-1550 — wire `record_ads_recommendation` into the ads skills that make
 * falsifiable Meta performance predictions.
 *
 * WHY A SCRIPT AND NOT THE PORTAL'S DEV->PROD SYNC. `skillService.syncSkill(id,
 * 'dev-to-prod')` is a wholesale Dev->Prod `put` — the exact mechanism behind the
 * RULE 8.5 deletion ENG-917 documents. It also cannot help here at all for two of
 * the three targets: Cross-Channel Budget Engine and Weekly Executive Ads Report
 * do not exist in Dev (checked 2026-09-16), so there is nothing to sync from.
 * This script instead issues an atomic `ADD toolNames` per skill, which adds one
 * member to the string set and is incapable of dropping a tool, renaming a skill,
 * or overwriting a systemPrompt.
 *
 * WHY THESE THREE SKILLS. The tool is Meta-only and records a prediction with a
 * metric, a direction, a magnitude and an evaluation date, so it only belongs in
 * skills that actually produce that:
 *   - Meta Creative Fatigue Detector  — pure Meta, rates ads and estimates wasted
 *     spend, hands off refresh briefs. Already carries `get_ads_thresholds`, so it
 *     is also the proven precedent for adding a tool to an ads skill (ENG-918).
 *   - Cross-Channel Budget Engine     — "recommends where the next dollar should
 *     go" via marginal-return reallocation; the most directly falsifiable of the set.
 *   - Weekly Executive Ads Report     — emits "5 owner-assignable action items"
 *     with dollar impact, which are predictions that currently evaporate.
 *
 * ⚠ DELIBERATELY EXCLUDED — Conversion Tracking Validator. It fixes broken
 * pixel/CAPI tracking, so after it acts, measured CPL moves BECAUSE THE MEASUREMENT
 * CHANGED, not because performance did. Logging that as a prediction would write
 * confounded wins into the ledger and is exactly the "confident wrong scores"
 * failure mode ENG-885's L4b must not be fed. Landing Page Checker (Ads) is also
 * excluded: it is primarily a Google audit, and page-change effects are slow and
 * confounded. Do not add either without re-deciding this on purpose.
 *
 * ⚠ RUN ONLY AFTER THE TOOL IS DEPLOYED. Adding the name to a live skill before
 * the code ships leaves that skill referencing a tool the runtime cannot resolve.
 * Conversely, do not leave a long gap: until the tool is associated with a
 * published skill, `getUnassociatedTools` sweeps it into the `__other_skills__`
 * bundle, which every real production tier enables — so wiring it here is also
 * what removes it from that catch-all.
 *
 * ⚠ SKILLS ARE KEYED BY ID, NEVER BY NAME. Production contains genuine duplicate
 * skill NAMES (e.g. "LinkedIn Post Writing", "Luma Event Lead Engagement Engine",
 * "LinkedIn Wealth Management Intent Signal Harvester" each appear twice, checked
 * 2026-09-16). A name-keyed edit would be ambiguous. These ids were read from the
 * live tables, and the script verifies the name still matches before writing.
 *
 * ⚠ CACHED READ PATH. `skillService.getPublishedSkills()` memoises, so a skill
 * edited here is not visible to running sessions until that cache expires or the
 * backend restarts. Expect a lag; it is not a failed write.
 *
 * Usage:
 *   # Dry run — prints exactly what would change, writes nothing
 *   NODE_ENV=production npx ts-node src/scripts/eng1550-wire-record-ads-recommendation.ts
 *
 *   # Apply
 *   NODE_ENV=production npx ts-node src/scripts/eng1550-wire-record-ads-recommendation.ts --apply --confirmed-by "Harsha"
 */

import AWS from 'aws-sdk';

export const TOOL_NAME = 'record_ads_recommendation';

export interface TargetSkill {
  skillId: string;
  expectedName: string;
}

/** Ids read from the live tables 2026-09-16. `expectedName` is a guard, not a lookup key. */
export const TARGET_SKILLS: TargetSkill[] = [
  { skillId: 'b86c5c13-b423-456c-9c72-3266f2026aed', expectedName: 'Meta Creative Fatigue Detector' },
  { skillId: 'ca99eb0c-5d69-41d4-8997-516b5bb2d228', expectedName: 'Cross-Channel Budget Engine' },
  { skillId: '6abd9a7f-55b0-428c-8b7f-aa107829407d', expectedName: 'Weekly Executive Ads Report (Cross-Platform)' },
];

export interface WireResult {
  skillId: string;
  name?: string;
  applied: boolean;
  skippedReason?: string;
  toolsBefore?: number;
  toolsAfter?: number;
}

function tableName(): string {
  // Mirrors db.ts's TABLE_PREFIX convention: only the exact string "development"
  // is treated as dev; everything else is production.
  return process.env.NODE_ENV === 'development' ? 'Dev-AW-Skills' : 'AW-Skills';
}

export async function wireToolIntoSkills(opts: {
  apply: boolean;
  docClient?: AWS.DynamoDB.DocumentClient;
  table?: string;
}): Promise<WireResult[]> {
  const table = opts.table ?? tableName();
  const doc = opts.docClient ?? new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  const results: WireResult[] = [];

  for (const target of TARGET_SKILLS) {
    const existing = await doc.get({ TableName: table, Key: { skillId: target.skillId } }).promise();
    const item = existing.Item;

    if (!item) {
      results.push({ skillId: target.skillId, applied: false, skippedReason: 'skill not found' });
      continue;
    }

    // Fail closed if the id no longer points at the skill this script was written
    // against, rather than silently editing some other skill.
    if (item.name !== target.expectedName) {
      results.push({
        skillId: target.skillId,
        name: item.name,
        applied: false,
        skippedReason: `name mismatch — expected "${target.expectedName}", found "${item.name}"`,
      });
      continue;
    }

    // `toolNames` is a DynamoDB string SET, not a list (ENG-917 established this).
    const currentTools: string[] = item.toolNames?.values ?? (Array.isArray(item.toolNames) ? item.toolNames : []);

    if (currentTools.includes(TOOL_NAME)) {
      results.push({
        skillId: target.skillId,
        name: item.name,
        applied: false,
        skippedReason: 'already wired',
        toolsBefore: currentTools.length,
        toolsAfter: currentTools.length,
      });
      continue;
    }

    if (!opts.apply) {
      results.push({
        skillId: target.skillId,
        name: item.name,
        applied: false,
        toolsBefore: currentTools.length,
        toolsAfter: currentTools.length + 1,
      });
      continue;
    }

    // ADD on a string set is additive and idempotent: it cannot remove a tool and
    // cannot touch systemPrompt, name, or any other attribute.
    const updated = await doc
      .update({
        TableName: table,
        Key: { skillId: target.skillId },
        UpdateExpression: 'ADD toolNames :t',
        ExpressionAttributeValues: { ':t': doc.createSet([TOOL_NAME]) },
        ConditionExpression: 'attribute_exists(skillId)',
        ReturnValues: 'UPDATED_NEW',
      })
      .promise();

    const after: string[] = (updated.Attributes?.toolNames as any)?.values ?? [];
    results.push({
      skillId: target.skillId,
      name: item.name,
      applied: true,
      toolsBefore: currentTools.length,
      toolsAfter: after.length,
    });
  }

  return results;
}

/* istanbul ignore next -- CLI wrapper, run by hand */
async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const confirmedByIndex = argv.indexOf('--confirmed-by');
  const confirmedBy = confirmedByIndex >= 0 ? argv[confirmedByIndex + 1] : '';

  // db.ts's TABLE_PREFIX treats anything other than the exact string "development"
  // as production, so an unset or mistyped NODE_ENV silently targets the live
  // table. Same guard, and for the same reason, as the ENG-1880 seed script.
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'production') {
    console.error(
      `NODE_ENV must be exactly 'development' or 'production' (got: ${JSON.stringify(process.env.NODE_ENV)}). ` +
        `Any other value falls through to the unprefixed production table.`
    );
    process.exit(1);
  }

  if (apply && !confirmedBy) {
    console.error('Refusing to apply without --confirmed-by "<name of the person approving this>".');
    process.exit(1);
  }

  const table = tableName();
  console.log(`Table: ${table}  (NODE_ENV=${process.env.NODE_ENV})`);
  console.log(`Tool:  ${TOOL_NAME}\n`);

  const results = await wireToolIntoSkills({ apply });

  for (const r of results) {
    console.log(`${r.name ?? r.skillId}`);
    console.log(`  skillId: ${r.skillId}`);
    if (r.toolsBefore !== undefined) {
      console.log(`  toolNames: ${r.toolsBefore} -> ${r.toolsAfter}`);
    }
    if (r.skippedReason) {
      console.log(`  SKIPPED: ${r.skippedReason}`);
    } else {
      console.log(apply ? `  APPLIED by ${confirmedBy}.` : '  DRY RUN — nothing written.');
    }
    console.log('');
  }

  const failures = results.filter((r) => r.skippedReason && r.skippedReason !== 'already wired');
  if (failures.length > 0) {
    console.error(`${failures.length} skill(s) could not be wired — see SKIPPED reasons above.`);
    process.exit(1);
  }

  if (!apply) {
    console.log('Re-run with --apply --confirmed-by "<name>" to write.');
  } else {
    console.log('Done. Note: getPublishedSkills() is cached — running sessions pick this up after');
    console.log('the cache expires or the backend restarts.');
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    console.error('Wiring failed:', err);
    process.exit(1);
  });
}
