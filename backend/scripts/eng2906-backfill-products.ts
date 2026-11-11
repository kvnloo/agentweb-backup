/**
 * ENG-2906 PR2 — infer product attribution (signupProduct, products, zomaStage) for users that
 * predate journey tracking, from MCP usage events and Zoma device-flow records.
 *
 * DRY-RUN BY DEFAULT: reads only, writes a CSV. `--apply` performs the conditional writes and is
 * a DATABASE/DATA-PLANE action: it needs Harsha's explicit approval before anyone runs it.
 *
 * Reads (all paginated):
 *   - AW-Users (scan, projected to the attribution fields; key = email)
 *   - Dev-AW-LoopEvents, loop `emma-mcp`, `mcp_*` events (prod writes this Dev- table too)
 *   - AW-ZomaDeviceAuth (scan, device#/token# userId + createdAt)
 * Planning + write safety live in src/services/journeyProductBackfill.ts (unit-tested): every
 * write is conditional (attribute_exists(email) + attributionConfidence absent-or-inferred +
 * if_not_exists on every field), never touches a tracked/verified row or any existing value, and
 * stamps `attributionConfidence: inferred` if absent. The CSV's accountFlag column marks
 * internal/test accounts so the dry run can be sanity-checked before --apply.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node scripts/eng2906-backfill-products.ts [--out <csv>]
 *   NODE_ENV=production npx ts-node scripts/eng2906-backfill-products.ts --apply   # APPROVAL REQUIRED
 *
 * NODE_ENV=development targets Dev-AW-Users / Dev-AW-ZomaDeviceAuth.
 */
/* eslint-disable no-console */
import AWS from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import {
  buildBackfillUpdates,
  csvRow,
  CSV_HEADER,
  planUserBackfill,
  zomaDeviceEvidence,
  type BackfillPlan,
  type BackfillUser,
} from '../src/services/journeyProductBackfill';

const LOOP_EVENTS_TABLE = 'Dev-AW-LoopEvents'; // same constant as loops/core/sensors/eventTableEventSource
const MCP_LOOP_ID = 'emma-mcp';
const DEFAULT_OUT = path.join(process.env.HOME || '.', '.hermes/cache/scratch/eng2906-backfill-dryrun.csv');

const USER_FIELDS = [
  'email', 'userId', 'createdAt', 'lastActiveAt', 'lastLoginTime', 'signupProduct', 'signupPath',
  'attributionConfidence', 'products', 'zomaStage', 'zomaStageAt', 'zomaFirstReadAt', 'zomaFirstWriteAt',
  'isAdmin',
];

type Doc = AWS.DynamoDB.DocumentClient;

async function scanAll(doc: Doc, params: AWS.DynamoDB.DocumentClient.ScanInput): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await doc.scan({ ...params, ExclusiveStartKey }).promise();
    items.push(...((page.Items ?? []) as Array<Record<string, unknown>>));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function queryMcpEvents(doc: Doc): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await doc
      .query({
        TableName: LOOP_EVENTS_TABLE,
        KeyConditionExpression: 'loopId = :loopId',
        FilterExpression: 'begins_with(eventType, :mcp)',
        ProjectionExpression: 'subjectId, eventType, ts, dimensions',
        ExpressionAttributeValues: { ':loopId': MCP_LOOP_ID, ':mcp': 'mcp_' },
        ExclusiveStartKey,
      })
      .promise();
    items.push(...((page.Items ?? []) as Array<Record<string, unknown>>));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Tool names only the Meta/Google toolkit gateway exposes: the toolkit-local definitions that
 * getMetaToolkitManifest() appends. The v1 Meta tools and the Google Ads tools are deliberately
 * excluded — Emma /mcp registers the same names, so they are not Zoma evidence on their own.
 */
async function toolkitOnlyToolNames(): Promise<Set<string>> {
  const modules = await Promise.all([
    import('../src/mcp/metaToolkitSignals').then((m) => m.SIGNAL_READ_DEFINITIONS),
    import('../src/mcp/metaToolkitExperiments').then((m) => m.EXPERIMENT_READ_DEFINITIONS),
    import('../src/mcp/metaToolkitDiagnostics').then((m) => m.DIAGNOSTICS_READ_DEFINITIONS),
    import('../src/mcp/metaToolkitHealth').then((m) => m.META_HEALTH_TOOL_DEFINITIONS),
    import('../src/mcp/metaToolkitCatalogs').then((m) => m.META_CATALOG_TOOL_DEFINITIONS),
    import('../src/mcp/metaToolkitCatalogWrites').then((m) => m.META_CATALOG_WRITE_TOOL_DEFINITIONS),
    import('../src/mcp/metaToolkitEventSources').then((m) => m.META_EVENT_SOURCE_TOOL_DEFINITIONS),
    import('../src/mcp/metaToolkitCatalogFeeds').then((m) => m.META_CATALOG_FEED_TOOL_DEFINITIONS),
    import('../src/mcp/metaToolkitPages').then((m) => m.META_PAGES_TOOL_DEFINITIONS),
    import('../src/mcp/zomaToolDefinitions').then((m) => m.ZOMA_TOOL_DEFINITIONS),
  ]);
  const names = new Set<string>();
  for (const defs of modules) for (const def of defs as ReadonlyArray<{ name?: unknown }>) if (typeof def.name === 'string') names.add(def.name);
  if (names.size === 0) throw new Error('toolkit manifest produced no tool names');
  return names;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : DEFAULT_OUT;
  const prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const usersTable = `${prefix}AW-Users`;
  const devicesTable = `${prefix}AW-ZomaDeviceAuth`;
  const doc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });

  console.log(`[eng2906-backfill] ${apply ? 'APPLY' : 'dry-run'} users=${usersTable} events=${LOOP_EVENTS_TABLE} devices=${devicesTable}`);
  const toolkitOnly = await toolkitOnlyToolNames();
  const [rawUsers, events, devices] = await Promise.all([
    scanAll(doc, {
      TableName: usersTable,
      ProjectionExpression: USER_FIELDS.map((_, i) => `#f${i}`).join(', '),
      ExpressionAttributeNames: Object.fromEntries(USER_FIELDS.map((f, i) => [`#f${i}`, f])),
    }),
    queryMcpEvents(doc),
    scanAll(doc, {
      TableName: devicesTable,
      ProjectionExpression: 'pk, userId, createdAt, #status, #ref',
      ExpressionAttributeNames: { '#status': 'status', '#ref': 'ref' },
    }),
  ]);

  const eventsByUser = new Map<string, Array<Record<string, unknown>>>();
  for (const e of events) {
    if (typeof e.subjectId !== 'string') continue;
    const list = eventsByUser.get(e.subjectId) ?? [];
    list.push(e);
    eventsByUser.set(e.subjectId, list);
  }
  const deviceByUser = zomaDeviceEvidence(devices);
  const now = new Date();

  const users = rawUsers.filter(
    (u): u is Record<string, unknown> & BackfillUser =>
      typeof u.email === 'string' && typeof u.userId === 'string' && !u.userId.startsWith('deleted_'),
  );
  const plans: Array<{ plan: BackfillPlan; user: BackfillUser }> = users.map((user) => ({
    user,
    plan: planUserBackfill(user, eventsByUser.get(user.userId) ?? [], deviceByUser.get(user.userId), { now, toolkitOnlyNames: toolkitOnly }),
  }));

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, [CSV_HEADER, ...plans.map(({ plan }) => csvRow(plan))].join('\n') + '\n');

  let planned = 0;
  let applied = 0;
  let skipped = 0;
  const blockedUsers = new Set<string>();
  for (const { plan, user } of plans) {
    const updates = buildBackfillUpdates(plan, user, usersTable);
    planned += updates.length;
    if (!apply) continue;
    for (const update of updates) {
      try {
        await doc.update(update).promise();
        applied++;
      } catch (error) {
        // Legacy rows with NULL orgId violate the existing OrgId GSI. Do not repair
        // unrelated data in an attribution backfill; report and continue other users.
        if ((error as { code?: string })?.code === 'ValidationException' && (error as Error).message.includes('secondary index key to unsupported type')) {
          blockedUsers.add(user.email);
          console.error(`[eng2906-backfill] legacy index violation: ${user.email}`);
          break;
        }
        if ((error as { code?: string })?.code !== 'ConditionalCheckFailedException') {
          console.error(`[eng2906-backfill] update failed email=${user.email} applied=${applied} skipped=${skipped}`);
          throw error;
        }
        skipped++; // the value appeared since the read: never overwrite it
      }
    }
  }

  const count = (pred: (p: BackfillPlan) => boolean) => plans.filter(({ plan }) => pred(plan)).length;
  console.log(
    JSON.stringify({
      users: plans.length,
      mcpEvents: events.length,
      zomaDeviceUsers: deviceByUser.size,
      toolkitOnlyToolNames: toolkitOnly.size,
      signupProduct: {
        zoma: count((p) => p.signupProduct === 'zoma'),
        emma_mcp: count((p) => p.signupProduct === 'emma_mcp'),
        emma_web: count((p) => p.signupProduct === 'emma_web'),
        none: count((p) => !p.signupProduct),
      },
      products: {
        zoma: count((p) => !!p.products.zoma),
        emma_mcp: count((p) => !!p.products.emma_mcp),
        emma_web: count((p) => !!p.products.emma_web),
      },
      zomaStage: {
        connected: count((p) => p.zomaStage === 'connected'),
        first_read: count((p) => p.zomaStage === 'first_read'),
        first_write: count((p) => p.zomaStage === 'first_write'),
      },
      accountFlag: {
        internal: count((p) => p.accountFlag === 'internal'),
        test: count((p) => p.accountFlag === 'test'),
      },
      plannedWrites: planned,
      ...(apply ? { applied, skippedConditional: skipped, blockedUsers: [...blockedUsers] } : {}),
      csv: out,
    }),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[eng2906-backfill] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
