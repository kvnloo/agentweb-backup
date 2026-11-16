/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- DynamoDB Local suite: the SDK must be required after the endpoint is configured, like leadCallStore.dynamodbLocal.test.ts */
/**
 * ENG-2271: the hot-lead call abuse-limit store against REAL DynamoDB semantics: the conditional counter
 * and claim expressions under truly concurrent writers.
 *
 * Opt-in: runs only when DYNAMODB_LOCAL_ENDPOINT points at a DynamoDB Local (e.g.
 *   docker run -d --rm -p 127.0.0.1:8123:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
 *   DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8123 npx jest src/__tests__/hotLeadCallLimits.dynamodbLocal.test.ts
 * ), otherwise the suite is skipped, so CI never needs a database. Stop the container afterwards.
 */
// backend/__mocks__ would stub aws-sdk for every test; this suite needs the real SDK.
jest.unmock('aws-sdk');

// A module (not a global script), so its top-level names cannot collide with other test files under tsc.
export {};

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;
const TABLE = require('../config/constants').tableName('AW-MCPSessions') as string;

suite('hot-lead call limit store against DynamoDB Local', () => {
  let ddb: any;
  let limits: import('../services/voice/limitStore').LimitStore;
  let reserveCallSlot: typeof import('../services/voice/hotLeadCallLimits').reserveCallSlot;
  let claimMemberCooldown: typeof import('../services/voice/hotLeadCallLimits').claimMemberCooldown;
  let n = 0;
  const key = () => `hlc#test#${++n}`;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    process.env.AWS_REGION = 'us-west-2';
    process.env.JWT_SECRET = 'test-secret';
    const AWS = require('aws-sdk');
    AWS.config.update({ region: 'us-west-2', endpoint: ENDPOINT, accessKeyId: 'local', secretAccessKey: 'local' });
    const raw = new AWS.DynamoDB();
    await raw.deleteTable({ TableName: TABLE }).promise().catch(() => undefined);
    await raw.createTable({
      TableName: TABLE, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'sessionId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
    }).promise();
    ddb = new AWS.DynamoDB.DocumentClient();
    limits = require('../services/voice/limitStore').getLimitStore();
    ({ reserveCallSlot, claimMemberCooldown } = require('../services/voice/hotLeadCallLimits'));
  }, 60_000);

  afterAll(async () => {
    const AWS = require('aws-sdk');
    await new AWS.DynamoDB().deleteTable({ TableName: TABLE }).promise().catch(() => undefined);
  });

  const item = async (k: string) => (await ddb.get({ TableName: TABLE, Key: { sessionId: k }, ConsistentRead: true }).promise()).Item;

  it('100 concurrent increments against a cap of 5 produce exactly 5 wins and a counter of 5', async () => {
    const k = key();
    const wins = await Promise.all(Array.from({ length: 100 }, () => limits.incrementBelow(k, 5, 1_900_000_000)));
    expect(wins.filter(Boolean)).toHaveLength(5);
    expect((await item(k)).calls).toBe(5);
    expect((await item(k)).ttl).toBe(1_900_000_000);
  });

  it('a cap below 1 admits nothing and writes nothing', async () => {
    const k = key();
    expect(await limits.incrementBelow(k, 0, 1_900_000_000)).toBe(false);
    expect(await item(k)).toBeUndefined();
  });

  it('decrement gives a slot back, never below zero, and a missing counter is a no-op', async () => {
    const k = key();
    await limits.incrementBelow(k, 1, 1_900_000_000);
    expect(await limits.incrementBelow(k, 1, 1_900_000_000)).toBe(false);
    await limits.decrement(k);
    await limits.decrement(k);
    expect((await item(k)).calls).toBe(0);
    expect(await limits.incrementBelow(k, 1, 1_900_000_000)).toBe(true);
    await limits.decrement(key());
  });

  it('100 concurrent claims of one key produce exactly one winner', async () => {
    const k = key();
    const wins = await Promise.all(Array.from({ length: 100 }, (_v, i) => limits.claim(k, `t${i}`, 2000, 1000)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('a claim is live while now < expiresAt and claimable again exactly at expiry', async () => {
    const k = key();
    expect(await limits.claim(k, 'a', 2000, 1000)).toBe(true);
    expect(await limits.claim(k, 'b', 3000, 1999)).toBe(false);
    expect(await limits.claim(k, 'c', 3000, 2000)).toBe(true);
    expect((await item(k)).token).toBe('c');
  });

  it('release drops only the claim it owns', async () => {
    const k = key();
    await limits.claim(k, 'a', 2000, 1000);
    await limits.claim(k, 'b', 4000, 2000);
    await limits.release(k, 'a');
    expect((await item(k)).token).toBe('b');
    await limits.release(k, 'b');
    expect(await item(k)).toBeUndefined();
    await limits.release(k, 'b');
  });

  it('holder returns the live token, and nothing once the claim expired', async () => {
    const k = key();
    expect(await limits.holder(k, 1000)).toBeNull();
    await limits.claim(k, 'list#lead#abc', 2000, 1000);
    expect(await limits.holder(k, 1999)).toBe('list#lead#abc');
    expect(await limits.holder(k, 2000)).toBeNull();
  });

  it('a burst of 50 reservations for distinct phones in one org never exceeds the cap', async () => {
    const config: any = { maxCallsPerHour: 3, maxCallsPerDay: 3, callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' } };
    const now = new Date('2026-10-19T17:00:00Z');
    const results = await Promise.all(Array.from({ length: 50 }, (_v, i) =>
      reserveCallSlot({ orgId: 'org-burst', listId: 'l', leadId: `lead${i}`, phoneE164: `+1555555${String(1000 + i)}`, config, now })));
    expect(results.filter(r => r.ok)).toHaveLength(3);
    expect(results.filter(r => !r.ok && r.reason === 'org_hourly_cap')).toHaveLength(47);
    const hour = await item('hlc#cap#h#org-burst#2026-10-19T17');
    expect(hour.calls).toBe(3); // every refused lead gave its claim back
  });

  it('a burst of 20 attempts for one member is admitted once by the cooldown', async () => {
    const config: any = { memberCooldownMinutes: 1 };
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      claimMemberCooldown({ orgId: 'org-cool', memberId: 'maaaaaaa', config, now: new Date('2026-10-19T17:00:00Z') })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('two dispatches of the same lead: one wins the phone marker and the other sees it in progress', async () => {
    const config: any = { maxCallsPerHour: 30, maxCallsPerDay: 30, callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' } };
    const now = new Date('2026-10-19T17:00:00Z');
    const results = await Promise.all([1, 2].map(() =>
      reserveCallSlot({ orgId: 'org-same', listId: 'l', leadId: 'lead-same', phoneE164: '+15555551234', config, now })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, reason: 'in_progress' }]);
  });
});
