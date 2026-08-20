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

import { DynamoDB } from 'aws-sdk';

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

const ddb = new DynamoDB.DocumentClient({ region: REGION });

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
/** Whether those attributes EXISTED. Absent is not the same as null or zero, and
 *  restoring the wrong one of the three leaves the account subtly rewritten. */
let hadTokenUsage = false;
let hadBonus = false;

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

    const existing = await ddb
      .get({ TableName: USERS_TABLE, Key: { email: TEST_EMAIL } })
      .promise();
    originalTokenUsage = existing.Item?.tokenUsage;
    originalBonus = existing.Item?.tokenAllowanceBonus;
    hadTokenUsage = existing.Item ? 'tokenUsage' in existing.Item : false;
    hadBonus = existing.Item ? 'tokenAllowanceBonus' in existing.Item : false;
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
    await seedUserSpend({ totalCost: 40 });
    await seedSteadyBurn(6, 8_000_000);

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
    await seedUserSpend({ totalCost: 1_000_000 });
    const paused = await api('GET', '/api/subscription/usage');
    expect(paused.data.allowed).toBe(false);

    // `tokenAllowanceBonus` IS the credit mechanism — no Stripe round-trip needed
    // to prove the admission side of a top-up.
    await seedUserSpend({ totalCost: 1_000_000, bonus: 500_000_000 });
    const resumed = await api('GET', '/api/subscription/usage');

    expect(resumed.status).toBe(200);
    // The scenario is named "resume". A bigger allowance that still refuses the
    // next call is the bug this would be written to catch, so the admission
    // decision is the assertion — the numbers are corroboration.
    expect(resumed.data.allowed).toBe(true);
    expect(resumed.data.bonus).toBeGreaterThan(0);
    expect(resumed.data.effectiveAllowance).toBeGreaterThan(paused.data.effectiveAllowance ?? 0);
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
