/**
 * ENG-2276 — remove the one stray generic-SaaS ICP persona left over in Gloco
 * AI's (demo@gloco.ai) `marketStrategy.icp` list after a partial manual
 * correction.
 *
 * BACKGROUND
 * ----------
 * The outreach onboarding race (ENG-2276) caused `marketStrategy` to be
 * seeded with 5 generic SaaS/GTM personas instead of Gloco's actual
 * trade-compliance niche. At 2026-10-02T20:17:02.462Z — about 2 hours after
 * the bug was reported, and independent of this ticket's code fix — someone
 * (most likely John Lu continuing to chat with Emma, who has access to
 * `update_market_strategy`/`regenerate_market_strategy` outside the
 * restricted autonomous brand-build session) added a correct
 * `businessOverview`, 15 real compliance competitors (Zonos, Avalara,
 * Flexport, Descartes, ...), and 7 correct compliance ICPs (Cross-Border
 * Marketplace Sellers, IP & Compliance Managers, Customs Brokers, AI-Agent
 * Builders, ...).
 *
 * That edit appended to the list rather than replacing it, so the original
 * bad persona survived at index 0:
 *   id: "1790971620577-icp-0", title: "🚀 Growth-Stage SaaS Founder"
 * sitting alongside the 7 correct entries. Verified directly against the
 * live `AW-Users` row for demo@gloco.ai — not inferred from the ticket text.
 *
 * This script removes only that one list entry. It does not touch the other
 * 7 ICPs, the 15 competitors, or businessOverview, and it does not re-run
 * generation — it is a one-off list-item removal, not a regeneration sweep.
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE IT IS RUN (see CLAUDE.md).
 * This is a production data repair of a specific customer's stored market
 * strategy.
 *
 * Idempotent: re-checks both `id` and `title` of the item at the expected
 * index via ConditionExpression at write time, so a re-run after the entry
 * has already been removed (or the list changed for any other reason) is a
 * no-op, not a clobber.
 *
 * Table prefix follows NODE_ENV like every other script here, but there is no
 * dev copy of this row to rehearse against — demo@gloco.ai does not exist in
 * Dev-AW-Users (verified), so a NODE_ENV=development run is a guaranteed
 * no-op, not a dry-run of the real logic. Both commands below must target
 * production; the dry-run is still safe because it only reads and prints —
 * it performs no write regardless of environment.
 *
 * Dry-run (default): reads the row, prints the diff, writes nothing.
 *   NODE_ENV=production npx ts-node src/scripts/eng2276-remove-stray-icp-persona.ts
 * Apply:
 *   NODE_ENV=production npx ts-node src/scripts/eng2276-remove-stray-icp-persona.ts --apply
 */
import { DynamoDB } from 'aws-sdk';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE = `${TABLE_PREFIX}AW-Users`;
const APPLY = process.argv.includes('--apply');

const TARGET_EMAIL = 'demo@gloco.ai';
const STRAY_ICP_ID = '1790971620577-icp-0';
const STRAY_ICP_TITLE = '🚀 Growth-Stage SaaS Founder';

async function main(): Promise<void> {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run'} | Table: ${TABLE} (NODE_ENV=${process.env.NODE_ENV || 'production'})`);

  const res = await doc.get({ TableName: TABLE, Key: { email: TARGET_EMAIL } }).promise();
  const item = res.Item;
  if (!item) {
    console.log(`[${TARGET_EMAIL}] user not found — skipping.`);
    return;
  }

  const icps: Array<{ id?: string; title?: string }> = item.marketStrategy?.icp ?? [];
  const index = icps.findIndex((e) => e?.id === STRAY_ICP_ID && e?.title === STRAY_ICP_TITLE);

  console.log(`[${TARGET_EMAIL}] marketStrategy.icp has ${icps.length} entries.`);
  if (index === -1) {
    console.log(
      `  entry {id: ${STRAY_ICP_ID}, title: "${STRAY_ICP_TITLE}"} not found — already removed, or list changed. Skipping.`,
    );
    return;
  }
  console.log(`  found stray entry at index ${index}: "${icps[index].title}" (id ${icps[index].id})`);
  console.log(`  remaining entries after removal: ${icps.length - 1}`);

  if (!APPLY) {
    console.log('  [dry-run] no write performed.');
    return;
  }

  try {
    await doc
      .update({
        TableName: TABLE,
        Key: { email: TARGET_EMAIL },
        ConditionExpression: `marketStrategy.icp[${index}].#id = :id AND marketStrategy.icp[${index}].#title = :title`,
        UpdateExpression: `REMOVE marketStrategy.icp[${index}] SET marketStrategy.icpUpdatedAt = :now, marketStrategy.updatedAt = :now`,
        ExpressionAttributeNames: {
          '#id': 'id',
          '#title': 'title',
        },
        ExpressionAttributeValues: {
          ':id': STRAY_ICP_ID,
          ':title': STRAY_ICP_TITLE,
          ':now': new Date().toISOString(),
        },
      })
      .promise();
    console.log('  [applied] stray ICP removed.');
  } catch (err) {
    if ((err as { code?: string }).code === 'ConditionalCheckFailedException') {
      console.log('  [skipped] row changed since read — already fixed or edited concurrently.');
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
