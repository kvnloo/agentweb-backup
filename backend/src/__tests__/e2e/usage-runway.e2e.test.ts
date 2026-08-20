/**
 * ENG-1210 AC11 / ENG-1214 AC7 / ENG-1215 AC3 — fake-user E2E for the usage runway.
 *
 * AC11 names nine scenarios: on-track, projected early exhaustion, user accepts a
 * switch, user declines, hard pause, top-up resume, reset, insufficient history,
 * and a large one-day spike. Five are reachable by an ordinary customer and were
 * verified by hand against production on 2026-08-20; four are NOT reachable by
 * clicking at all, because the state they need cannot be produced through the API:
 *
 *   - hard pause      needs spend >= the threshold, and the threshold lives on the
 *                     SUBSCRIPTION TYPE, so lowering it would pause every customer
 *                     on that plan
 *   - top-up resume   needs a real Stripe purchase
 *   - reset           needs a billing month to roll over
 *   - one-day spike   needs fabricated burn history
 *
 * There is no admin endpoint that sets a user's usage, credits or bonus — checked.
 * So this suite seeds state directly and drives the REAL HTTP API over it. That is
 * what "fake-user" has to mean here.
 *
 * WHY THIS SUITE EXISTS AT ALL, given the unit tests are green:
 * on 2026-08-20 the unread-page notice shipped completely INERT to production while
 * every unit test passed, because those tests built the tool ledger by hand and
 * never crossed `extractMinimalToolResult`. It was caught by a human running the
 * product, not by CI. Six defects that day were found in review or in production;
 * none by the suite. Tests that construct their own inputs cannot see the seams
 * between real components, and the seams are where the bugs were.
 *
 * SAFETY. Seeding writes to the ledger and to a user record, so it must never run
 * against production:
 *   - the table prefix defaults to `Dev-`;
 *   - a guard below REFUSES to run against a prod-looking base URL;
 *   - the IAM user this runs as is denied PutItem on the un-prefixed tables, so
 *     the wrong target fails closed rather than corrupting a billing ledger;
 *   - every seeded row is tracked and removed in afterEach, and the test user's
 *     original tokenUsage/bonus is snapshotted and restored in afterAll.
 *
 * Usage:
 *   RUN_E2E_TESTS=true E2E_BASE_URL=http://chat-14...:3001 \
 *     npx jest --testPathPattern=e2e/usage-runway --forceExit
 */

// `src/__mocks__/aws-sdk.ts` is a MANUAL MOCK, and `roots: ['<rootDir>/src']` makes Jest
// apply it AUTOMATICALLY to every suite in this project — no `jest.mock('aws-sdk')` call
// required. That is correct for the 240 unit suites and fatal here: an E2E suite whose
// whole job is to seed real rows and read them back through a real API was writing into a
// mock that returns `{}` for everything.
//
// This is not hypothetical. The first live run against staging passed two scenarios and
// failed seven, and every one of those results was meaningless: `percentUsed` never moved
// off the account's real 58% because no seed ever reached DynamoDB. The two passes were
// accidents of the account's existing state, not evidence.
//
// `requireActual` is used rather than `jest.unmock` because it cannot be undone by hoisting
// order or by another module re-registering the mock — this binding is the real SDK by
// construction.
// Keeps this file a MODULE. Replacing the `import` with `requireActual` removed the only
// top-level import, and TypeScript then treats the file as a global script: its top-level
// `const`s collide with `landing-page-happy-path.e2e.test.ts` (which is also script-scoped
// and also declares `authToken`/`describeE2E`), and a top-level `AWS` binding shadows the
// aws-sdk types' own global `AWS` namespace for every other file in the program. Both
// showed up as errors in unrelated files, which is a long way from the cause.
export {};

const realAws = jest.requireActual('aws-sdk') as typeof import('aws-sdk');
const { DynamoDB } = realAws;

const RUN = process.env.RUN_E2E_TESTS === 'true';
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3001';
const TEST_EMAIL = process.env.E2E_TEST_EMAIL || 'test@example.com';
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || 'Test123!';
const PREFIX = process.env.E2E_TABLE_PREFIX ?? 'Dev-';
const REGION = process.env.AWS_REGION || 'us-west-2';

const USERS_TABLE = `${PREFIX}AW-Users`;
const USAGE_TABLE = `${PREFIX}AW-UsageRecords`;
const SCHEDULES_TABLE = `${PREFIX}AW-TaskSchedules`;

/**
 * A nonce that makes every seeded ledger key unique to THIS run.
 *
 * The natural sort key -- `{date}#{model}#{feature}#{billingUserId}` -- is
 * deterministic, so two concurrent runs, or a run against an account that already
 * has a real row for that date/model/feature, would silently overwrite a row we do
 * not own and then DELETE it in cleanup. Uniqueness plus a conditional write turns
 * that from silent data loss into a loud failure.
 *
 * Safe to append: `usageRecordDb` documents that nothing parses `sk` -- readers use
 * the `date`/`model`/`feature` ATTRIBUTES -- and range queries run
 * `sk BETWEEN :start AND :end~`. Base36 sorts below `~`, so the extra segment
 * cannot fall outside a date range that should have matched.
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Refuse to seed against production, whatever the caller passed.
 *
 * Belt and braces with the IAM denial: a suite that CAN write is one command-line
 * flag away from writing to the wrong place, and the ledger it would corrupt is
 * the same one ENG-1247 is already trying to reconcile.
 */
/**
 * Refuse to run against a MOCKED DynamoDB.
 *
 * The failure this prevents is silent and total: every seed succeeds, every read returns
 * `{}`, and the suite reports on the account's pre-existing state while appearing to test
 * the state it seeded. A suite that cannot write is not a suite that found nothing — it is
 * a suite that measured nothing, and it must say so loudly rather than pass.
 */
function assertRealDynamoClient(): void {
  const put = (ddb as unknown as { put?: { _isMockFunction?: boolean } }).put;
  if (put && put._isMockFunction) {
    throw new Error(
      'Refusing to run: the DynamoDB client is Jest\'s manual mock from src/__mocks__/aws-sdk.ts, ' +
        'so every seed would be discarded and every assertion would read the account\'s ' +
        'pre-existing state instead. Obtain the client via jest.requireActual("aws-sdk").',
    );
  }
}

function assertNotProduction(): void {
  const looksProd =
    /api\.agentweb\.pro/i.test(BASE_URL) || PREFIX === '' || /^AW-/.test(USAGE_TABLE);
  if (looksProd) {
    throw new Error(
      `Refusing to run: E2E seeds usage data and this target looks like production ` +
        `(BASE_URL=${BASE_URL}, table=${USAGE_TABLE}). Set E2E_TABLE_PREFIX=Dev- and a non-prod URL.`,
    );
  }
}

/**
 * Resolve credentials explicitly instead of trusting the SDK's default chain.
 *
 * `backend/.env` carries placeholder `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, and
 * dotenv loads them into `process.env` before this file runs. The default chain reads
 * ENVIRONMENT credentials first, so those placeholders shadow the working credentials in
 * `~/.aws/credentials` and every call dies with `UnrecognizedClientException` — which
 * reads like an IAM problem and is not one.
 *
 * The shared file is the source of truth for an operator-run suite; `E2E_AWS_*` is the
 * escape hatch for a runner with no `~/.aws`.
 */
function e2eCredentials(): InstanceType<typeof realAws.Credentials> | undefined {
  if (process.env.E2E_AWS_ACCESS_KEY_ID && process.env.E2E_AWS_SECRET_ACCESS_KEY) {
    return new realAws.Credentials({
      accessKeyId: process.env.E2E_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.E2E_AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.E2E_AWS_SESSION_TOKEN,
    });
  }
  try {
    return new realAws.SharedIniFileCredentials({ profile: process.env.AWS_PROFILE || 'default' });
  } catch {
    return undefined;
  }
}

const ddb = new DynamoDB.DocumentClient({ region: REGION, credentials: e2eCredentials() });

let authToken = '';
let userId = '';
/** Everything seeded this test, removed in afterEach even if the test throws. */
const seededSortKeys: string[] = [];
/** Schedules created by this suite, removed in afterAll. */
const createdScheduleIds: string[] = [];
/**
 * Model changes applied but not yet undone.
 *
 * Tracked separately from the test body because an assertion that fails BETWEEN
 * apply and undo would otherwise leave the schedule switched -- and `afterAll`
 * restores only usage counters, not schedule state.
 */
const appliedChangeIds: string[] = [];
/** The test user's real usage, restored in afterAll. */
let originalTokenUsage: unknown;
let originalBonus: unknown;
/**
 * The account's real credit ledger.
 *
 * Captured because the COST ceiling is lifted by `llmUsageCredits`, not by
 * `tokenAllowanceBonus` — see `seedCreditGrant`. The shared test account already carries a
 * $200 admin grant, and overwriting it without restoring would silently change what every
 * later reader of this account sees.
 */
let originalCredits: unknown;
let hadCredits = false;
/** Whether those attributes EXISTED. Absent is not the same as null or zero, and
 *  restoring the wrong one of the three leaves the account subtly rewritten. */
let hadTokenUsage = false;
let hadBonus = false;

/** The account's live cost ceiling in USD, read rather than assumed. */
async function readCostState(): Promise<{ used: number; allowance: number; allowed: boolean }> {
  const { status, data } = await api('GET', '/api/subscription/usage');
  if (status !== 200 || typeof data?.costAllowance !== 'number') {
    throw new Error(`Could not read the cost ceiling (${status}): ${JSON.stringify(data)}`);
  }
  return { used: data.costUsed, allowance: data.costAllowance, allowed: data.allowed };
}

/**
 * Lift the COST ceiling by writing a credit grant.
 *
 * `tokenAllowanceBonus` does NOT do this, which is what the first live run showed: the
 * effective threshold is `hardCostThresholdMicroUsd + purchased + adminGranted` from
 * `llmUsageCredits`, while `tokenAllowanceBonus` feeds the TOKEN allowance — null on a
 * cost-enforced policy. Seeding the bonus and expecting admission to resume tested a lever
 * that is not connected to the thing being measured.
 */
async function seedCreditGrant(amountMicroUsd: number): Promise<void> {
  await ddb
    .update({
      TableName: USERS_TABLE,
      Key: { email: TEST_EMAIL },
      UpdateExpression: 'SET llmUsageCredits = :c',
      ExpressionAttributeValues: {
        ':c': {
          month: currentMonth(),
          version: 1,
          grants: [],
          grantIds: [],
          reversals: [],
          reversalIds: [],
          totalPurchasedMicroUsd: 0,
          totalPurchasedReversedMicroUsd: 0,
          totalAdminGrantedMicroUsd: amountMicroUsd,
          totalMigrationOffsetMicroUsd: 0,
        },
      },
    })
    .promise();
}

async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const utcDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const currentMonth = (): string => new Date().toISOString().slice(0, 7);

/** Set the AUTHORITATIVE cycle-to-date counter. This, not the ledger, is what
 *  `costUsedMicroUsd` is read from — a fact that is easy to get wrong, because the
 *  ledger is what the drivers are built from. */
async function seedUserSpend(opts: {
  totalCost: number;
  totalTokens?: number;
  month?: string;
  bonus?: number;
}): Promise<void> {
  await ddb
    .update({
      TableName: USERS_TABLE,
      Key: { email: TEST_EMAIL },
      UpdateExpression: 'SET tokenUsage = :u, tokenAllowanceBonus = :b',
      ExpressionAttributeValues: {
        ':u': {
          month: opts.month ?? currentMonth(),
          totalTokens: opts.totalTokens ?? 100_000,
          totalCost: opts.totalCost,
        },
        ':b': opts.bonus ?? 0,
      },
    })
    .promise();
}

/** Ledger rows, which drive the daily burn rate and the driver breakdown. */
async function seedLedgerDay(opts: {
  date: string;
  costMicroUsd: number;
  model?: string;
  feature?: string;
}): Promise<void> {
  const model = opts.model ?? 'anthropic.claude-opus-5';
  const feature = opts.feature ?? 'agent_task:interactive';
  // `seq` distinguishes two rows seeded for the SAME day within one run -- the
  // spike scenario deliberately adds a second row on top of a quiet one.
  const seq = seededSortKeys.length;
  const sk = `${opts.date}#${model}#${feature}#${userId}#e2e-${RUN_ID}-${seq}`;
  await ddb
    .put({
      TableName: USAGE_TABLE,
      // Never overwrite: if this key somehow exists it is not ours to replace, and
      // cleanup would then delete a row we did not create.
      ConditionExpression: 'attribute_not_exists(sk)',
      Item: {
        userId,
        sk,
        date: opts.date,
        model,
        feature,
        billingUserId: userId,
        costMicroUsd: opts.costMicroUsd,
        callCount: 10,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
    .promise();
  // Recorded only after the write SUCCEEDS -- tracking a key we failed to create
  // would make cleanup delete someone else's row.
  seededSortKeys.push(sk);
}

/**
 * Create a schedule, pin it to an expensive model, and give it schedule-tagged
 * spend -- so a driver with a REAL switch on offer exists rather than being hoped
 * for.
 *
 * A schedule driver only appears when a ledger row's `feature` carries the
 * `...:scheduled:<scheduleId>` qualifier, and it only offers a switch when the
 * model it runs on has a cheaper ranked alternative. Both are seedable, so the
 * accept path can be proven on any environment instead of skipping wherever the
 * account happens to have no schedules.
 *
 * The pin is written straight to DynamoDB because `PUT /api/schedules/:id` accepts
 * only `frequency` and `status` -- there is no API surface for setting `llmModel`
 * except the very endpoint under test, and using that to build the precondition
 * would make the test prove itself.
 */
async function seedSwitchableSchedule(pinnedModel: string): Promise<string> {
  const created = await api('POST', '/api/schedules', {
    taskId: `e2e-usage-runway-${RUN_ID}`,
    frequency: 'daily',
  });
  if (created.status !== 201 || !created.data?.scheduleId) {
    throw new Error(
      `Could not create the schedule this scenario needs (${created.status}). ` +
        `Without one there is no switch to accept and the scenario would prove nothing.`,
    );
  }
  const scheduleId: string = created.data.scheduleId;
  createdScheduleIds.push(scheduleId);

  await ddb
    .update({
      TableName: SCHEDULES_TABLE,
      Key: { scheduleId },
      UpdateExpression: 'SET llmModel = :m',
      ExpressionAttributeValues: { ':m': pinnedModel },
    })
    .promise();

  // Spend on the pinned model, tagged to this schedule, across enough complete
  // days for the recommendation ranking to have something to rank.
  for (let i = 6; i >= 1; i--) {
    await seedLedgerDay({
      date: utcDay(-i),
      costMicroUsd: 8_000_000,
      model: pinnedModel,
      feature: `agent_task:scheduled:${scheduleId}`,
    });
  }
  return scheduleId;
}

/** A steady burn across `days` complete days, ending yesterday. */
async function seedSteadyBurn(days: number, perDayMicroUsd: number): Promise<void> {
  for (let i = days; i >= 1; i--) {
    await seedLedgerDay({ date: utcDay(-i), costMicroUsd: perDayMicroUsd });
  }
}

const describeE2E = RUN ? describe : describe.skip;

describeE2E('ENG-1210 AC11 — usage runway, fake-user E2E', () => {
  beforeAll(async () => {
    assertNotProduction();
    assertRealDynamoClient();

    const login = await api('POST', '/api/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (login.status !== 200 || !login.data?.token) {
      throw new Error(`Login failed (${login.status}). E2E cannot run without a session.`);
    }
    authToken = login.data.token;
    userId = JSON.parse(
      Buffer.from(authToken.split('.')[1], 'base64').toString('utf8'),
    ).userId;

    // Also the credential/table preflight: a failure here means the suite cannot see the
    // data plane at all, and every scenario below would otherwise report on the account's
    // pre-existing state while appearing to test what it seeded.
    const existing = await ddb
      .get({ TableName: USERS_TABLE, Key: { email: TEST_EMAIL } })
      .promise()
      .catch((error: Error) => {
        throw new Error(
          `Cannot read ${USERS_TABLE} (${error.message}). The suite seeds through the data ` +
            `plane, so it must not run without it. Check AWS credentials — note that ` +
            `backend/.env's placeholder AWS keys shadow ~/.aws/credentials unless ` +
            `E2E_AWS_ACCESS_KEY_ID/E2E_AWS_SECRET_ACCESS_KEY are set.`,
        );
      });
    if (!existing.Item) {
      throw new Error(`${TEST_EMAIL} does not exist in ${USERS_TABLE}; nothing to seed against.`);
    }
    originalTokenUsage = existing.Item?.tokenUsage;
    originalBonus = existing.Item?.tokenAllowanceBonus;
    hadTokenUsage = existing.Item ? 'tokenUsage' in existing.Item : false;
    hadBonus = existing.Item ? 'tokenAllowanceBonus' in existing.Item : false;
    originalCredits = existing.Item?.llmUsageCredits;
    hadCredits = existing.Item ? 'llmUsageCredits' in existing.Item : false;
  }, 60_000);

  afterEach(async () => {
    // Remove seeded ledger rows even when the test failed — a leaked row silently
    // changes the burn rate for every scenario after it.
    //
    // Failures are COLLECTED, not swallowed. A cleanup that quietly fails leaves
    // seeded spend behind and the next scenario forecasts against it; the run then
    // reports green while measuring something nobody intended.
    const failures: string[] = [];

    // Undo before deleting the ledger: an applied change outlives the rows that
    // justified it, and `afterAll` restores usage counters only.
    for (const changeId of appliedChangeIds.splice(0)) {
      const undone = await api('POST', '/api/subscription/usage-runway/undo', { changeId });
      if (undone.status !== 200 || undone.data?.undone !== true) {
        failures.push(`undo ${changeId} -> ${undone.status} ${JSON.stringify(undone.data)}`);
      }
    }

    await Promise.all(
      seededSortKeys.splice(0).map((sk) =>
        ddb
          .delete({ TableName: USAGE_TABLE, Key: { userId, sk } })
          .promise()
          .catch((error: Error) => {
            failures.push(`delete ${sk} -> ${error.message}`);
          }),
      ),
    );

    if (failures.length > 0) {
      throw new Error(`E2E cleanup failed, environment is now dirty:\n  ${failures.join('\n  ')}`);
    }
  }, 60_000);

  afterAll(async () => {
    // Put the test user back exactly as found. Leaving a seeded cap behind would
    // pause a shared dev account for whoever uses it next.
    if (!userId) return;
    const failures: string[] = [];

    // ABSENT, null and 0 are three different states. `?? null` / `?? 0` would write
    // an attribute onto an account that never had one — restoring the account into
    // a shape it was never in is not a restore.
    const sets: string[] = [];
    const removes: string[] = [];
    const values: Record<string, unknown> = {};
    if (hadTokenUsage) {
      sets.push('tokenUsage = :u');
      values[':u'] = originalTokenUsage;
    } else {
      removes.push('tokenUsage');
    }
    if (hadBonus) {
      sets.push('tokenAllowanceBonus = :b');
      values[':b'] = originalBonus;
    } else {
      removes.push('tokenAllowanceBonus');
    }
    if (hadCredits) {
      sets.push('llmUsageCredits = :c');
      values[':c'] = originalCredits;
    } else {
      removes.push('llmUsageCredits');
    }
    const expression = [
      sets.length ? `SET ${sets.join(', ')}` : '',
      removes.length ? `REMOVE ${removes.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    if (expression) {
      await ddb
        .update({
          TableName: USERS_TABLE,
          Key: { email: TEST_EMAIL },
          UpdateExpression: expression,
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        })
        .promise()
        .catch((error: Error) => {
          failures.push(`restore user -> ${error.message}`);
        });
    }

    for (const scheduleId of createdScheduleIds.splice(0)) {
      await ddb
        .delete({ TableName: SCHEDULES_TABLE, Key: { scheduleId } })
        .promise()
        .catch((error: Error) => {
          failures.push(`delete schedule ${scheduleId} -> ${error.message}`);
        });
    }

    if (failures.length > 0) {
      throw new Error(
        `E2E teardown failed — the test account was NOT fully restored:\n  ${failures.join('\n  ')}`,
      );
    }
  }, 60_000);

  it('SCENARIO 1 — on track: says so plainly and names the reset date', async () => {
    await seedUserSpend({ totalCost: 1 });
    await seedSteadyBurn(5, 200_000); // trivial burn against the cap

    const { status, data } = await api('GET', '/api/subscription/usage-runway');

    expect(status).toBe(200);
    expect(data.available).toBe(true);
    expect(data.runway.onTrack).toBe(true);
    expect(data.runway.resetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // AC4: never an internal dollar figure.
    expect(JSON.stringify(data)).not.toMatch(/MicroUsd|hardCostThreshold/);
  }, 60_000);

  it('SCENARIO 2 — projected early exhaustion: an exhaustion date, before reset', async () => {
    // The case a percentage alone cannot express: a modest percent used, burning
    // fast enough to run out before the cycle ends.
    // Derived from the LIVE ceiling, not from constants. The first live run failed here
    // with onTrack=true because the numbers were written against an assumed $150 cap and an
    // empty ledger; the real account had a $350 effective ceiling (policy + credits) and
    // $118 of pre-existing spend, so a $48 burn was comfortably on track. The correct
    // answer was the product's, and the test was wrong.
    const ceiling = await readCostState();
    const usedTarget = ceiling.allowance * 0.5;
    await seedUserSpend({ totalCost: usedTarget });

    // Burn hard enough that the remaining half cannot survive the cycle: three times the
    // rate that would exactly last until reset. Seeded across the trailing-seven window so
    // it dominates `max(cycleToDate, trailingSeven)` regardless of what the account already
    // spent earlier in the month.
    const runwayNow = await api('GET', '/api/subscription/usage-runway');
    const daysLeft = Math.max(1, runwayNow.data?.runway?.daysUntilReset ?? 12);
    const perDayUsd = ((ceiling.allowance - usedTarget) / daysLeft) * 3;
    await seedSteadyBurn(7, Math.round(perDayUsd * 1_000_000));

    const { data } = await api('GET', '/api/subscription/usage-runway');

    expect(data.available).toBe(true);
    expect(data.runway.onTrack).toBe(false);
    expect(data.runway.estimatedExhaustionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.runway.estimatedDaysRemaining).toBeGreaterThanOrEqual(0);
    expect(data.runway.estimatedExhaustionDate <= data.runway.resetDate).toBe(true);
  }, 60_000);

  it('SCENARIO 3 — user ACCEPTS a switch: it persists and is auditable', async () => {
    await seedUserSpend({ totalCost: 40 });
    const scheduleId = await seedSwitchableSchedule('anthropic.claude-opus-5');

    const drivers = await api('GET', '/api/subscription/usage-drivers');
    const target = (drivers.data.scheduleDrivers || []).find(
      (d: any) =>
        d.scheduleId === scheduleId && d.recommendedModel && d.recommendedModel !== d.effectiveModel,
    );
    // No skip. The precondition is SEEDED above, so its absence means the
    // recommendation engine did not offer a switch on spend that should have
    // produced one — which is the failure this scenario exists to catch. An early
    // return here would report green having exercised nothing.
    expect(target).toBeDefined();
    expect(target.effectiveModel).toBe('anthropic.claude-opus-5');

    const applied = await api('POST', '/api/subscription/usage-runway/apply', {
      scope: 'schedule',
      scopeId: scheduleId,
      toModel: target.recommendedModel,
    });
    expect(applied.status).toBe(200);
    expect(applied.data.applied).toBe(true);
    expect(applied.data.changeId).toEqual(expect.any(String));
    // Tracked the moment it succeeds: if an assertion below fails, `afterEach`
    // still undoes it rather than leaving the schedule switched.
    appliedChangeIds.push(applied.data.changeId);

    // The point of the scenario. "applied: true" is the endpoint's own account of
    // itself; reading the driver back is the independent one.
    const after = await api('GET', '/api/subscription/usage-drivers');
    const switched = (after.data.scheduleDrivers || []).find(
      (d: any) => d.scheduleId === scheduleId,
    );
    expect(switched?.effectiveModel).toBe(target.recommendedModel);
    expect(switched?.pinnedModel).toBe(target.recommendedModel);
  }, 120_000);

  it('SCENARIO 4 — user DECLINES: previewing changes nothing', async () => {
    // Declining is "previewed it and walked away". AC8 requires the selected model
    // to survive that, so the assertion is that a preview persists nothing.
    await seedUserSpend({ totalCost: 40 });
    const scheduleId = await seedSwitchableSchedule('anthropic.claude-opus-5');
    const drivers = await api('GET', '/api/subscription/usage-drivers');
    const target = (drivers.data.scheduleDrivers || []).find(
      (d: any) => d.scheduleId === scheduleId,
    );
    // Same reasoning as scenario 3: seeded, so required. And the previewed model is
    // the one actually RECOMMENDED — previewing an arbitrary fallback would test the
    // preview endpoint against a switch the product never offered.
    expect(target).toBeDefined();
    expect(target.recommendedModel).toEqual(expect.any(String));
    expect(target.recommendedModel).not.toBe(target.effectiveModel);

    const preview = await api('POST', '/api/subscription/usage-runway/preview', {
      switches: [
        {
          scope: 'schedule',
          scopeId: scheduleId,
          fromModel: target.effectiveModel,
          toModel: target.recommendedModel,
        },
      ],
    });

    expect(preview.status).toBe(200);
    expect(preview.data.persisted).toBe(false);
    expect(preview.data.isEstimate).toBe(true);

    const after = await api('GET', '/api/subscription/usage-drivers');
    const same = (after.data.scheduleDrivers || []).find(
      (d: any) => d.scheduleId === scheduleId,
    );
    expect(same?.effectiveModel).toBe(target.effectiveModel);
  }, 120_000);

  it('SCENARIO 5 — hard pause: admission stops at the ceiling', async () => {
    // Seeded rather than clicked: the threshold lives on the subscription TYPE, so
    // the only click-path to this state would pause every customer on the plan.
    await seedUserSpend({ totalCost: 1_000_000 });

    const { data } = await api('GET', '/api/subscription/usage');

    expect(data.allowed).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/hardCostThresholdMicroUsd/);
  }, 60_000);

  it('SCENARIO 6 — top-up resume: verified credits lift the ceiling', async () => {
    // Overshoot the ceiling by a KNOWN margin rather than by a huge constant. The first
    // live run seeded $1,000,000 of spend and then expected a $500 top-up to resume
    // admission — it cannot, and the failure said more about the arithmetic than the
    // product.
    const before = await readCostState();
    const overshootUsd = before.allowance * 1.5;
    await seedUserSpend({ totalCost: overshootUsd });
    const paused = await api('GET', '/api/subscription/usage');
    expect(paused.data.allowed).toBe(false);

    // `llmUsageCredits` is the mechanism that lifts a COST ceiling —
    // `effectiveHardThreshold = hardCostThreshold + purchased + adminGranted`. The token
    // bonus this scenario used to seed is a different lever entirely, and is null on a
    // cost-enforced policy, so no top-up could ever have shown up here.
    // Sized against the SPEND, not against `before.allowance`. The ceiling read above
    // already contains the account's existing $200 grant, and `seedCreditGrant` REPLACES
    // the credit ledger rather than adding to it — so subtracting the old allowance while
    // discarding the old grant under-funded the top-up and left the account paused. Since
    // `effective = policyBase + granted` and `policyBase >= 0`, granting more than the
    // whole seeded spend clears the ceiling whatever the base happens to be.
    const grantMicroUsd = Math.ceil(overshootUsd * 1_000_000) + 50_000_000;
    await seedCreditGrant(grantMicroUsd);
    const resumed = await api('GET', '/api/subscription/usage');

    expect(resumed.status).toBe(200);
    // The scenario is named "resume". A bigger allowance that still refuses the
    // next call is the bug this would be written to catch, so the admission
    // decision is the assertion — the numbers are corroboration.
    expect(resumed.data.allowed).toBe(true);
    // Corroboration on the COST fields, which are the ones this policy enforces.
    expect(resumed.data.costAllowance).toBeGreaterThan(paused.data.costAllowance);
    expect(resumed.data.costAllowance).toBeGreaterThan(resumed.data.costUsed);
  }, 60_000);

  it('SCENARIO 7 — reset: a new cycle starts from zero', async () => {
    // A stale `tokenUsage.month` is exactly how the product models a reset — the
    // counter is treated as zero rather than migrated, so no clock control needed.
    await seedUserSpend({ totalCost: 1_000_000, month: '2020-01' });

    const { data } = await api('GET', '/api/subscription/usage');

    expect(data.allowed).toBe(true);
    expect(data.percentUsed).toBe(0);
  }, 60_000);

  it('SCENARIO 8 — insufficient history: refuses to invent a date', async () => {
    // AC5: "no false-precision date". Under one complete day there is nothing to
    // extrapolate from, and guessing would be worse than saying so.
    await seedUserSpend({ totalCost: 5 });

    // PRECONDITION, checked rather than assumed. "Insufficient history" is the one scenario
    // that cannot be seeded INTO existence — it requires the absence of ledger rows, and no
    // amount of writing produces an absence. The shared test account carries real spend
    // across many days of the cycle, so on that account this scenario is unrunnable.
    //
    // Checked and failed loudly rather than skipped: a skip here would read as coverage of
    // AC5's "no false-precision date", which is exactly the claim that would then be
    // untrue. The remedy is an account whose ledger this suite owns, via E2E_TEST_EMAIL.
    const cycleStart = `${currentMonth()}-01`;
    const existingRows = await ddb
      .query({
        TableName: USAGE_TABLE,
        KeyConditionExpression: 'userId = :u AND sk BETWEEN :s AND :e',
        ExpressionAttributeValues: { ':u': userId, ':s': cycleStart, ':e': `${currentMonth()}-31~` },
        Select: 'COUNT',
      })
      .promise();
    if ((existingRows.Count || 0) > 0) {
      throw new Error(
        `SCENARIO 8 cannot run against ${TEST_EMAIL}: it has ${existingRows.Count} ledger ` +
          `row(s) in the current cycle, so the forecast has history to work from and ` +
          `"insufficient history" is unreachable. Point E2E_TEST_EMAIL at an account whose ` +
          `ledger this suite owns. Failing rather than skipping — a skip would look like ` +
          `AC5 was covered when it was not.`,
      );
    }

    const { status, data } = await api('GET', '/api/subscription/usage-runway');

    // The old form guarded the assertions behind `if (data.available && data.runway)`,
    // so an error response — or a plan with no ceiling — walked straight past them
    // and the scenario reported green having checked nothing.
    //
    // `available` is false only when the account has NO configured policy, in which
    // case there is no ceiling to forecast against and this scenario is meaningless.
    // Failing loudly is the correct outcome: it says the account is wrong for the
    // suite, rather than pretending the behaviour was verified.
    expect(status).toBe(200);
    expect(data.available).toBe(true);
    expect(data.runway).not.toBeNull();

    // With no ledger rows in the cycle the burn is zero, so the forecast is withheld
    // outright. Asserted exactly rather than as a disjunction of "any of these three
    // would be acceptable" — a disjunction passes as soon as one term holds, which
    // hides which behaviour actually shipped.
    expect(data.runway.confidence).toBe('insufficient_data');
    expect(data.runway.estimatedExhaustionDate).toBeNull();
    expect(data.runway.estimatedDaysRemaining).toBeNull();
  }, 60_000);

  it('SCENARIO 9 — one-day spike: the forecast reacts rather than averaging it away', async () => {
    // The spike is the reason the formula takes the LARGER of cycle-to-date and
    // trailing-seven: a mean would bury a day that changed the picture.
    await seedUserSpend({ totalCost: 30 });
    await seedSteadyBurn(8, 100_000);

    // Read the QUIET cycle first. Comparing the spike against a fixed 365-day bound
    // proved nothing: a calculator that averaged the spike away — or ignored it
    // entirely — would still land under 365 and pass. The baseline is what makes
    // this scenario about the spike at all.
    const quiet = await api('GET', '/api/subscription/usage-runway');
    expect(quiet.status).toBe(200);
    expect(quiet.data.available).toBe(true);
    expect(quiet.data.runway.estimatedDaysRemaining).not.toBeNull();

    await seedLedgerDay({ date: utcDay(-1), costMicroUsd: 60_000_000 });

    const { data } = await api('GET', '/api/subscription/usage-runway');

    expect(data.available).toBe(true);
    expect(data.runway.estimatedDaysRemaining).not.toBeNull();
    expect(data.runway.estimatedDaysRemaining).toBeLessThan(
      quiet.data.runway.estimatedDaysRemaining,
    );
  }, 60_000);
});
