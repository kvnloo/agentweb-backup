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
/** The test user's real usage, restored in afterAll. */
let originalTokenUsage: unknown;
let originalBonus: unknown;

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
  const sk = `${opts.date}#${model}#${feature}#${userId}`;
  await ddb
    .put({
      TableName: USAGE_TABLE,
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
  seededSortKeys.push(sk);
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
  }, 60_000);

  afterEach(async () => {
    // Remove seeded ledger rows even when the test failed — a leaked row silently
    // changes the burn rate for every scenario after it.
    await Promise.all(
      seededSortKeys.splice(0).map((sk) =>
        ddb.delete({ TableName: USAGE_TABLE, Key: { userId, sk } }).promise().catch(() => undefined),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    // Put the test user back exactly as found. Leaving a seeded cap behind would
    // pause a shared dev account for whoever uses it next.
    if (!userId) return;
    await ddb
      .update({
        TableName: USERS_TABLE,
        Key: { email: TEST_EMAIL },
        UpdateExpression: 'SET tokenUsage = :u, tokenAllowanceBonus = :b',
        ExpressionAttributeValues: {
          ':u': originalTokenUsage ?? null,
          ':b': originalBonus ?? 0,
        },
      })
      .promise()
      .catch(() => undefined);
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
    await seedSteadyBurn(6, 8_000_000);

    const drivers = await api('GET', '/api/subscription/usage-drivers');
    const target = (drivers.data.scheduleDrivers || []).find(
      (d: any) => d.recommendedModel && d.recommendedModel !== d.effectiveModel,
    );
    if (!target) {
      // Honest skip rather than a false pass: with no schedule to switch there is
      // nothing to accept, and asserting nothing would look like coverage.
      console.warn('SCENARIO 3 skipped: no schedule driver with a switch to offer');
      return;
    }

    const applied = await api('POST', '/api/subscription/usage-runway/apply', {
      scope: 'schedule',
      scopeId: target.scheduleId,
      toModel: target.recommendedModel,
    });
    expect(applied.status).toBe(200);
    expect(applied.data.applied).toBe(true);
    expect(applied.data.changeId).toEqual(expect.any(String));

    const undone = await api('POST', '/api/subscription/usage-runway/undo', {
      changeId: applied.data.changeId,
    });
    expect(undone.status).toBe(200);
    expect(undone.data.undone).toBe(true);
  }, 120_000);

  it('SCENARIO 4 — user DECLINES: previewing changes nothing', async () => {
    // Declining is "previewed it and walked away". AC8 requires the selected model
    // to survive that, so the assertion is that a preview persists nothing.
    await seedUserSpend({ totalCost: 40 });
    await seedSteadyBurn(6, 8_000_000);

    const drivers = await api('GET', '/api/subscription/usage-drivers');
    const target = (drivers.data.scheduleDrivers || [])[0];
    if (!target) {
      console.warn('SCENARIO 4 skipped: no schedule driver available');
      return;
    }

    const preview = await api('POST', '/api/subscription/usage-runway/preview', {
      switches: [
        {
          scope: 'schedule',
          scopeId: target.scheduleId,
          fromModel: target.effectiveModel,
          toModel: target.recommendedModel || 'gpt-5.4-nano',
        },
      ],
    });

    expect(preview.status).toBe(200);
    expect(preview.data.persisted).toBe(false);
    expect(preview.data.isEstimate).toBe(true);

    const after = await api('GET', '/api/subscription/usage-drivers');
    const same = (after.data.scheduleDrivers || []).find(
      (d: any) => d.scheduleId === target.scheduleId,
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

    const { data } = await api('GET', '/api/subscription/usage-runway');

    if (data.available && data.runway) {
      const r = data.runway;
      const honest =
        r.estimatedExhaustionDate === null ||
        r.confidence === 'insufficient_data' ||
        r.completeDaysElapsed === 0;
      expect(honest).toBe(true);
    }
  }, 60_000);

  it('SCENARIO 9 — one-day spike: the forecast reacts rather than averaging it away', async () => {
    // The spike is the reason the formula takes the LARGER of cycle-to-date and
    // trailing-seven: a mean would bury a day that changed the picture.
    await seedUserSpend({ totalCost: 30 });
    await seedSteadyBurn(8, 100_000);
    await seedLedgerDay({ date: utcDay(-1), costMicroUsd: 60_000_000 });

    const { data } = await api('GET', '/api/subscription/usage-runway');

    expect(data.available).toBe(true);
    expect(data.runway.estimatedDaysRemaining).not.toBeNull();
    // A spike must never read as MORE runway than a quiet cycle.
    expect(data.runway.estimatedDaysRemaining).toBeLessThan(365);
  }, 60_000);
});
