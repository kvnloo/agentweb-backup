/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- DynamoDB Local suite: the SDK must be required after the endpoint is configured, like sessionTrackingService.dynamodbLocal.test.ts */
/**
 * ENG-2271 — hot-lead call state store and its two crmDb primitives against REAL DynamoDB semantics
 * (expression syntax, nested-path conditions, concurrent conditional writes).
 *
 * Opt-in: runs only when DYNAMODB_LOCAL_ENDPOINT points at a DynamoDB Local (e.g.
 *   docker run -d --rm -p 127.0.0.1:8123:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
 *   DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8123 npx jest src/__tests__/leadCallStore.dynamodbLocal.test.ts
 * ), otherwise the suite is skipped, so CI never needs a database. Stop the container afterwards.
 */
// backend/__mocks__ would stub aws-sdk for every test; this suite needs the real SDK.
jest.unmock('aws-sdk');

// A module (not a global script), so its top-level names cannot collide with other test files under tsc.
export {};

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;

const LIST = 'list-1';
const SID_A = 'CA' + 'a1b2c3d4'.repeat(4);
const SID_B = 'CA' + '12345678'.repeat(4);

suite('hot-lead call store against DynamoDB Local', () => {
  let ddb: any;
  let crmDb: any;
  let store: import('../services/voice/leadCallStore.types').LeadCallStore;
  let n = 0;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    process.env.AWS_REGION = 'us-west-2';
    const AWS = require('aws-sdk');
    AWS.config.update({ region: 'us-west-2', endpoint: ENDPOINT, accessKeyId: 'local', secretAccessKey: 'local' });
    const raw = new AWS.DynamoDB();
    await raw.deleteTable({ TableName: 'AW-Leads' }).promise().catch(() => undefined);
    await raw.createTable({
      TableName: 'AW-Leads', BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'listId', AttributeType: 'S' }, { AttributeName: 'leadId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'listId', KeyType: 'HASH' }, { AttributeName: 'leadId', KeyType: 'RANGE' }],
    }).promise();
    ddb = new AWS.DynamoDB.DocumentClient();
    ({ crmDb } = require('../services/db'));
    store = require('../services/voice/leadCallStore').getLeadCallStore();
  }, 60_000);

  afterAll(async () => {
    const AWS = require('aws-sdk');
    await new AWS.DynamoDB().deleteTable({ TableName: 'AW-Leads' }).promise().catch(() => undefined);
  });

  const newLead = async (item: Record<string, unknown> = {}) => {
    const leadId = `lead-${++n}`;
    await ddb.put({ TableName: 'AW-Leads', Item: { listId: LIST, leadId, ...item } }).promise();
    return leadId;
  };
  const rowOf = async (leadId: string) => (await ddb.get({ TableName: 'AW-Leads', Key: { listId: LIST, leadId } }).promise()).Item;
  const baseRecord = {
    state: 'dialing' as const, jobKey: 'job-1', startedAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:00.000Z',
    attemptNo: 1, memberId: 'maaaaaaa', triedMemberIds: ['maaaaaaa'], leadPhoneMac: 'mac-1',
  };

  it('creates on a lead with no system map, then refuses a second create without overwriting', async () => {
    const leadId = await newLead();
    expect(await store.create(LIST, leadId, baseRecord)).toBe(true);
    expect(await store.create(LIST, leadId, { ...baseRecord, jobKey: 'job-2' })).toBe(false);
    expect(await store.get(LIST, leadId)).toMatchObject({ state: 'dialing', jobKey: 'job-1', meteredLegs: [], lastSequence: {} });
  });

  it('removes the call sid and outcome when a transition clears them, and keeps everything else', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, { ...baseRecord, state: 'dialing', memberCallSid: SID_A, outcome: 'member_no_answer' });
    await store.transition(LIST, leadId, ['dialing'], { state: 'between_attempts' });
    expect(await store.transition(LIST, leadId, ['between_attempts'], {
      state: 'dialing', attemptNo: 2, memberId: 'mbbbbbbb', triedMemberIds: ['mbbbbbbb'], clear: ['memberCallSid', 'outcome'],
    })).toBe(true);
    const system = (await rowOf(leadId)).system.hot_lead_call;
    expect(system).not.toHaveProperty('memberCallSid');
    expect(system).not.toHaveProperty('outcome');
    expect(system).toMatchObject({ state: 'dialing', attemptNo: 2, memberId: 'mbbbbbbb', triedMemberIds: ['maaaaaaa', 'mbbbbbbb'], leadPhoneMac: 'mac-1' });
  });

  it('clears nothing when the state condition fails, and tolerates clearing fields that are absent', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, { ...baseRecord, memberCallSid: SID_A });
    expect(await store.transition(LIST, leadId, ['member_ringing'], { state: 'dialing', clear: ['memberCallSid'] })).toBe(false);
    expect((await store.get(LIST, leadId))?.memberCallSid).toBe(SID_A);
    expect(await store.transition(LIST, leadId, ['dialing'], { state: 'dialing', clear: ['outcome'] })).toBe(true);
    expect((await store.get(LIST, leadId))?.memberCallSid).toBe(SID_A);
  });

  it('refuses to set and clear the same field in one patch', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, baseRecord);
    await expect(store.transition(LIST, leadId, ['dialing'], { state: 'dialing', memberCallSid: SID_B, clear: ['memberCallSid'] })).rejects.toThrow('both set and removed');
  });

  it('applies a patch that names an attempt only while the record is on that attempt (a real equality condition)', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, baseRecord);
    expect(await store.transition(LIST, leadId, ['dialing'], { state: 'between_attempts', ifAttemptNo: 2 })).toBe(false);
    expect((await store.get(LIST, leadId))?.state).toBe('dialing');
    expect(await store.transition(LIST, leadId, ['dialing'], { state: 'between_attempts', ifAttemptNo: 1 })).toBe(true);
  });

  it('keeps sibling system keys when creating', async () => {
    const leadId = await newLead({ system: { linkedInConnectionNotifiedAt: 'x' } });
    expect(await store.create(LIST, leadId, baseRecord)).toBe(true);
    expect((await rowOf(leadId)).system.linkedInConnectionNotifiedAt).toBe('x');
  });

  it('returns false for a missing lead and leaves no ghost item', async () => {
    expect(await store.create(LIST, 'nope', baseRecord)).toBe(false);
    expect(await rowOf('nope')).toBeUndefined();
    expect(await crmDb.updateLeadSystemRecordIf(LIST, 'nope', 'hot_lead_call', { stateIn: ['dialing'], set: { state: 'failed' } })).toBe(false);
    expect(await rowOf('nope')).toBeUndefined();
  });

  it('accepts the first sequence when lastSequence is empty, rejects the replay, accepts a higher one', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, baseRecord);
    expect(await store.transition(LIST, leadId, ['dialing'], { state: 'member_ringing', lastSequence: { [SID_A]: 1 } })).toBe(true);
    expect(await store.transition(LIST, leadId, ['member_ringing'], { state: 'member_answered', lastSequence: { [SID_A]: 1 } })).toBe(false);
    expect((await store.get(LIST, leadId))?.state).toBe('member_ringing');
    expect(await store.transition(LIST, leadId, ['member_ringing'], { state: 'member_answered', lastSequence: { [SID_A]: 2 } })).toBe(true);
  });

  it('applies two CallSid entries in one transition', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, baseRecord);
    expect(await store.transition(LIST, leadId, ['dialing'], { state: 'bridging', lastSequence: { [SID_A]: 4, [SID_B]: 1 } })).toBe(true);
    expect((await store.get(LIST, leadId))?.lastSequence).toEqual({ [SID_A]: 4, [SID_B]: 1 });
    // One stale entry fails the whole patch.
    expect(await store.transition(LIST, leadId, ['bridging'], { state: 'connected', lastSequence: { [SID_A]: 5, [SID_B]: 1 } })).toBe(false);
    expect((await store.get(LIST, leadId))?.state).toBe('bridging');
  });

  it('meters each leg once', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, baseRecord);
    expect(await store.transition(LIST, leadId, ['dialing'], { state: 'member_ringing', meteredLegs: ['member:1'] })).toBe(true);
    expect(await store.transition(LIST, leadId, ['member_ringing'], { state: 'finished', meteredLegs: ['member:1'] })).toBe(false);
    expect(await store.transition(LIST, leadId, ['member_ringing'], { state: 'member_answered', meteredLegs: ['lead'] })).toBe(true);
    expect((await store.get(LIST, leadId))?.meteredLegs).toEqual(['member:1', 'lead']);
  });

  it('stores attempt, member and tried members, and appends a tried member only once', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, { ...baseRecord, attemptNo: 1, memberId: 'maaaaaaa', triedMemberIds: ['maaaaaaa'] });
    expect(await store.get(LIST, leadId)).toMatchObject({ attemptNo: 1, memberId: 'maaaaaaa', triedMemberIds: ['maaaaaaa'] });
    expect(await store.transition(LIST, leadId, ['dialing'], { state: 'between_attempts', attemptNo: 2, memberId: 'mbbbbbbb', triedMemberIds: ['mbbbbbbb'] })).toBe(true);
    expect(await store.transition(LIST, leadId, ['between_attempts'], { state: 'member_ringing', triedMemberIds: ['mbbbbbbb'] })).toBe(false);
    expect(await store.get(LIST, leadId)).toMatchObject({ state: 'between_attempts', attemptNo: 2, memberId: 'mbbbbbbb', triedMemberIds: ['maaaaaaa', 'mbbbbbbb'] });
  });

  it('exposes only one winner among concurrent creates', async () => {
    const leadId = await newLead();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(LIST, leadId, { ...baseRecord, jobKey: `job-${i}` })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('exposes only one winner among concurrent identical transitions and one metering', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, baseRecord);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.transition(LIST, leadId, ['dialing'], { state: 'member_ringing', meteredLegs: ['member:1'], lastSequence: { [SID_A]: 1 } })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.get(LIST, leadId))?.meteredLegs).toEqual(['member:1']);
  });

  it('takes a transition from the wrong state as a clean no-op', async () => {
    const leadId = await newLead();
    await store.create(LIST, leadId, baseRecord);
    expect(await store.transition(LIST, leadId, ['bridging'], { state: 'connected' })).toBe(false);
    expect((await store.get(LIST, leadId))?.state).toBe('dialing');
  });

  it('the timeline write does not mark the lead engaged', async () => {
    const leadId = await newLead();
    await store.addEvent(LIST, leadId, 'call.connected', { leg: 'lead', seconds: 12 });
    const row = await rowOf(leadId);
    expect(row.engagements).toHaveLength(1);
    expect(row.engagements[0]).toMatchObject({ eventType: 'call.connected', eventData: { leg: 'lead', seconds: 12 } });
    expect(row.isEngaged).toBeUndefined();
  });

  it('claimLeadStepOnce still claims once after sharing the bootstrap helper', async () => {
    const leadId = await newLead();
    expect(await crmDb.claimLeadStepOnce(LIST, leadId, 'step')).toBe(true);
    expect(await crmDb.claimLeadStepOnce(LIST, leadId, 'step')).toBe(false);
    expect(await crmDb.claimLeadStepOnce(LIST, 'nope', 'step')).toBe(false);
    expect(await rowOf('nope')).toBeUndefined();
  });

  it('findLeadsBySystemRecord returns the old live records only, newest first, and stops at its read bound', async () => {
    const list = 'list-find';
    const put = (leadId: string, state: string, updatedAt: string) => ddb.put({
      TableName: 'AW-Leads', Item: { listId: list, leadId, system: { hot_lead_call: { ...baseRecord, state, updatedAt } } },
    }).promise();
    await put('lead-1', 'connected', '2026-10-19T10:00:00.000Z'); // stuck
    await put('lead-2', 'finished', '2026-10-19T10:00:00.000Z'); // terminal
    await put('lead-3', 'dialing', '2026-10-19T13:00:00.000Z'); // too young
    await put('lead-4', 'between_attempts', '2026-10-19T09:00:00.000Z'); // stuck
    await ddb.put({ TableName: 'AW-Leads', Item: { listId: list, leadId: 'lead-5' } }).promise(); // no record
    const op = { states: ['dialing', 'connected', 'between_attempts'], updatedBefore: '2026-10-19T12:00:00.000Z' };

    expect(await crmDb.findLeadsBySystemRecord(list, 'hot_lead_call', { ...op, maxRead: 100 })).toEqual({ leadIds: ['lead-4', 'lead-1'], read: 5, truncated: false });
    // The two newest leads are lead-5 and lead-4: only lead-4 matches, and the list is reported as cut short.
    expect(await crmDb.findLeadsBySystemRecord(list, 'hot_lead_call', { ...op, maxRead: 2 })).toEqual({ leadIds: ['lead-4'], read: 2, truncated: true });
    // Reading exactly the whole list: DynamoDB still answers with a continuation key, so `truncated` is a false positive here (documented).
    expect(await crmDb.findLeadsBySystemRecord(list, 'hot_lead_call', { ...op, maxRead: 5 })).toEqual({ leadIds: ['lead-4', 'lead-1'], read: 5, truncated: true });
  });
});
