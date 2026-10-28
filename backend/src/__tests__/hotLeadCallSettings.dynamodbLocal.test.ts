/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- DynamoDB Local suite: the SDK must be required after the endpoint is configured, like hotLeadCallLimits.dynamodbLocal.test.ts */
/**
 * ENG-2271: the conditional writes of the team settings service and the per-member verification against REAL
 * DynamoDB semantics (map and list attribute equality, concurrent writers on the org item).
 *
 * Opt-in: runs only when DYNAMODB_LOCAL_ENDPOINT points at a DynamoDB Local (e.g.
 *   docker run -d --rm -p 127.0.0.1:8123:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
 *   DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8123 npx jest src/__tests__/hotLeadCallSettings.dynamodbLocal.test.ts
 * ), otherwise the suite is skipped. Stop the container afterwards.
 */
jest.unmock('aws-sdk');
jest.mock('../services/usageRecorderService', () => ({ recordVendorUsage: jest.fn().mockResolvedValue(undefined) }));

import { spokenCode } from './helpers/spokenCode';
import { storedConfigFixture } from './helpers/hotLeadCallFixtures';

export {};

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;
const OWNER = { userId: 'owner', orgRole: 'owner' };
const A = 'maaaaaaa';
const B = 'mbbbbbbb';
const EVERY_DAY = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' };

const stored = () => storedConfigFixture({ enabled: false }, [
  { id: A, name: 'Dana Lee', phone: '+14155550100', windows: [EVERY_DAY] },
  { id: B, name: 'Sam Ortiz', phone: '+14155550122', windows: [EVERY_DAY] },
]);

suite('team settings and member verification against DynamoDB Local', () => {
  let ddb: any;
  let orgDb: any;
  let svc: typeof import('../services/hotLeadCallSettingsService');
  let fake: import('./helpers/fakeVoiceProvider').FakeVoiceProvider;
  let n = 0;
  const TABLE = () => require('../config/constants').tableName('AW-Organizations') as string;

  const newOrg = async (extra: Record<string, unknown> = {}) => {
    const orgId = `org-${++n}`;
    await ddb.put({ TableName: TABLE(), Item: { orgId, ownerUserId: 'owner', createdAt: new Date().toISOString(), hotLeadCall: stored(), ...extra } }).promise();
    return orgId;
  };
  const read = async (orgId: string) => (await ddb.get({ TableName: TABLE(), Key: { orgId }, ConsistentRead: true }).promise()).Item;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    process.env.AWS_REGION = 'us-west-2';
    process.env.JWT_SECRET = 'test-secret';
    const AWS = require('aws-sdk');
    AWS.config.update({ region: 'us-west-2', endpoint: ENDPOINT, accessKeyId: 'local', secretAccessKey: 'local' });
    const raw = new AWS.DynamoDB();
    await raw.deleteTable({ TableName: TABLE() }).promise().catch(() => undefined);
    await raw.createTable({
      TableName: TABLE(), BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'orgId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'orgId', KeyType: 'HASH' }],
    }).promise();
    ddb = new AWS.DynamoDB.DocumentClient();
    orgDb = require('../services/db').orgDb;
    svc = require('../services/hotLeadCallSettingsService');
    require('../services/voice/hotLeadCallEntitlement').setHotLeadCallEntitledOverride(true);
    const { FakeVoiceProvider } = require('./helpers/fakeVoiceProvider');
    fake = new FakeVoiceProvider();
    require('../services/voice/voiceProvider').setVoiceProviderForTests(fake);
  }, 60_000);

  afterAll(async () => {
    require('../services/voice/voiceProvider').setVoiceProviderForTests(null);
    require('../services/voice/hotLeadCallEntitlement').setHotLeadCallEntitledOverride(null);
    const AWS = require('aws-sdk');
    await new AWS.DynamoDB().deleteTable({ TableName: TABLE() }).promise().catch(() => undefined);
  });

  const loaded = async (orgId: string) => (await orgDb.getOrgById(orgId, undefined, true));

  it('a save made from the revision just read is accepted, and the revision of the stored value matches the one returned', async () => {
    const orgId = await newOrg();
    const org = await loaded(orgId);
    const dto = await svc.updateHotLeadCallSettings(org, OWNER, { _revision: svc.hotLeadCallRevisionOf(org.hotLeadCall), maxAttemptsPerLead: 2 });
    expect(svc.hotLeadCallRevisionOf((await read(orgId)).hotLeadCall)).toBe(dto._revision);
  });

  it('ten saves racing from the same revision: exactly one wins, the others get a conflict (each a real change: none equals the stored 3)', async () => {
    const orgId = await newOrg();
    const org = await loaded(orgId);
    const revision = svc.hotLeadCallRevisionOf(org.hotLeadCall);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
      svc.updateHotLeadCallSettings(org, OWNER, { _revision: revision, maxAttemptsPerLead: [1, 2, 4, 5][i % 4] })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter(x => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason.name).toBe('ConflictError');
  });

  it('a stale read that passes the revision check still loses at the write when a concurrent save landed in between', async () => {
    const orgId = await newOrg();
    const stale = await loaded(orgId);
    const revision = svc.hotLeadCallRevisionOf(stale.hotLeadCall);
    await ddb.update({ TableName: TABLE(), Key: { orgId }, UpdateExpression: 'SET hotLeadCall.maxCallsPerDay = :v', ExpressionAttributeValues: { ':v': 50 } }).promise();
    await expect(svc.updateHotLeadCallSettings(stale, OWNER, { _revision: revision, maxAttemptsPerLead: 2 })).rejects.toMatchObject({ name: 'ConflictError' });
    expect((await read(orgId)).hotLeadCall.maxCallsPerDay).toBe(50);
  });

  it('removing a person and changing a phone write the settings and the verification record together', async () => {
    const verification = {
      members: {
        [A]: { phone: '+14155550100', codeHash: 'a'.repeat(64), expiresAt: Date.now() + 600_000, attempts: 1, startedAt: [Date.now() - 1000] },
        [B]: { phone: '+14155550122', codeHash: null, expiresAt: 0, attempts: 0, startedAt: [Date.now() - 2000] },
      },
      orgStartedAt: [Date.now() - 2000, Date.now() - 1000],
    };
    const orgId = await newOrg({ hotLeadCallVerification: verification });
    const org = await loaded(orgId);
    await svc.updateHotLeadCallSettings(org, OWNER, {
      _revision: svc.hotLeadCallRevisionOf(org.hotLeadCall),
      team: [{ id: A, name: 'Dana Lee', phone: '+16475550123', windows: [EVERY_DAY] }],
    });
    const after = await read(orgId);
    expect(Object.keys(after.hotLeadCallVerification.members)).toEqual([A]);
    expect(after.hotLeadCallVerification.members[A]).toMatchObject({ phone: '+16475550123', codeHash: null, attempts: 0 });
    expect(after.hotLeadCallVerification.orgStartedAt).toEqual(verification.orgStartedAt);
    expect(after.hotLeadCall.team[0].phone).toBe('+16475550123');
  });

  it('two starts for the same member race: one call is placed, the other request is told to retry', async () => {
    const orgId = await newOrg();
    const org = await loaded(orgId);
    const before = fake.placedCalls.length;
    const results = await Promise.allSettled([svc.startMemberVerification(org, OWNER, A), svc.startMemberVerification(org, OWNER, A)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(fake.placedCalls.length - before).toBe(1);
    const stateAfter = (await read(orgId)).hotLeadCallVerification;
    expect(stateAfter.members[A].startedAt).toHaveLength(1);
    expect(stateAfter.orgStartedAt).toHaveLength(1);
  });

  it('parallel wrong guesses cannot exceed the attempt budget, and the right code then verifies only that member', async () => {
    const orgId = await newOrg();
    await svc.startMemberVerification(await loaded(orgId), OWNER, A);
    const code = spokenCode(fake.placedCalls[fake.placedCalls.length - 1]);
    const wrong = code === '000000' ? '000001' : '000000';
    const org = await loaded(orgId);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => svc.confirmMemberVerification(org, OWNER, A, wrong)));
    expect(results.filter(r => r.status === 'rejected' && (r.reason as Error).name === 'VerificationCodeError')).toHaveLength(1);
    expect((await read(orgId)).hotLeadCallVerification.members[A].attempts).toBe(1);
    await expect(svc.confirmMemberVerification(await loaded(orgId), OWNER, A, code)).resolves.toMatchObject({ memberId: A });
    const after = (await read(orgId)).hotLeadCall.team;
    expect(after[0].verifiedAt).toEqual(expect.any(String));
    expect(after[1].verifiedAt).toBeUndefined();
  });

  it('a phone edited between the confirm read and its write is not marked verified', async () => {
    const orgId = await newOrg();
    await svc.startMemberVerification(await loaded(orgId), OWNER, A);
    const code = spokenCode(fake.placedCalls[fake.placedCalls.length - 1]);
    const org = await loaded(orgId);
    await ddb.update({ TableName: TABLE(), Key: { orgId }, UpdateExpression: 'SET hotLeadCall.team[0].phone = :p', ExpressionAttributeValues: { ':p': '+16475550123' } }).promise();
    await expect(svc.confirmMemberVerification(org, OWNER, A, code)).rejects.toThrow('settings changed');
    expect((await read(orgId)).hotLeadCall.team[0].verifiedAt).toBeUndefined();
  });
});
