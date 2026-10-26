jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
jest.mock('../services/usageRecorderService', () => ({ recordVendorUsage: jest.fn().mockResolvedValue(undefined) }));
import { spokenCode } from './helpers/spokenCode';
import { orgDb } from '../services/db';
import { recordVendorUsage } from '../services/usageRecorderService';
import { confirmMemberVerification, startMemberVerification } from '../services/hotLeadCallSettingsService';
import {
  ConflictError, ForbiddenError, NotEntitledError, NotFoundError, RateLimitedError, StoredStateInvalidError, ValidationError, VerificationCodeError,
} from '../services/hotLeadCallErrors';
import { VERIFICATION_CODE_TTL_MS, verificationAfterTeamEdit } from '../services/voice/memberVerification';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { installFakeOrgTable, type FakeOrgTable } from './helpers/fakeOrgTable';
import { storedConfigFixture, teamMember } from './helpers/hotLeadCallFixtures';

const OWNER = { userId: 'owner', orgRole: 'owner' };
const T0 = Date.parse('2026-10-19T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ids = ['maaaaaaa', 'mbbbbbbb', 'mcccccccc'.slice(0, 8), 'mddddddd', 'meeeeeee'];
const phone = (i: number) => `+1415555${String(100 + i).padStart(4, '0')}`;

const config = (count = 2) => storedConfigFixture(
  { enabled: false, twilioNumber: '+14155550999' },
  ids.slice(0, count).map((id, i) => teamMember(phone(i), { id, name: `Person ${i}`, verifiedAt: undefined })),
);

let table: FakeOrgTable;
let fake: FakeVoiceProvider;
const logs: jest.SpyInstance[] = [];
const snapshot = () => JSON.parse(JSON.stringify(table.org));
// null means "no memberId sent"; omitted means the first member.
const start = (memberId: string | null = ids[0]) => startMemberVerification(snapshot(), OWNER, memberId ?? undefined);
const confirm = (code: string, memberId: string = ids[0]) => confirmMemberVerification(snapshot(), OWNER, memberId, code);
const codeOfCall = (index: number) => spokenCode(fake.placedCalls[index]);
const wrong = (code: string) => (code === '000000' ? '000001' : '000000');
const verificationState = () => table.org.hotLeadCallVerification as { members: Record<string, { codeHash: string | null; attempts: number; startedAt: number[]; phone: string }>; orgStartedAt: number[] };
const team = () => (table.org.hotLeadCall as { team: Array<{ id: string; verifiedAt?: string }> }).team;

const TOOL_NAME = /[a-z]+_hot_lead_call_[a-z]+|hot_lead_call_[a-z_]+/;

describe('refusals worded for the portal', () => {
  it('says plainly, without a tool name, that no caller number exists', async () => {
    delete (table.org.hotLeadCall as { twilioNumber?: string }).twilioNumber;
    delete (table.org.hotLeadCall as { twilioNumberSid?: string }).twilioNumberSid;
    const err = await start().catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toContain('phone number for calls');
    expect(err.message).not.toMatch(TOOL_NAME);
  });
  it('says plainly, without a tool name, that nothing is saved yet', async () => {
    delete table.org.hotLeadCall;
    const err = await start().catch(e => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).not.toMatch(TOOL_NAME);
  });
});

describe('a placement the provider did not confirm', () => {
  it('is reported without a charge being recorded, because no call sid exists to key one by', async () => {
    fake.failNextPlaceCall('unknown');
    await expect(start()).rejects.toThrow('did not confirm');
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });
});

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-not-real'; });
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
  setHotLeadCallEntitledOverride(true);
  table = { org: { orgId: 'org-a', ownerUserId: 'owner', hotLeadCall: config() }, writes: [], beforeWrite: null };
  installFakeOrgTable(orgDb as never, table);
  fake = new FakeVoiceProvider();
  setVoiceProviderForTests(fake);
  logs.splice(0, logs.length, ...(['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => undefined)));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  setVoiceProviderForTests(null);
  setHotLeadCallEntitledOverride(null);
});

describe('start', () => {
  it('rings the member\'s saved phone, keeps one record per member and reports the limits', async () => {
    const result = await start(ids[1]);
    expect(fake.placedCalls).toHaveLength(1);
    expect(fake.placedCalls[0]).toMatchObject({ to: phone(1), from: '+14155550999' });
    expect(result).toMatchObject({ memberId: ids[1], memberPhone: '***0101', expiresInSeconds: VERIFICATION_CODE_TTL_MS / 1000, nextStartAllowedInSeconds: 120, startsLeftToday: 4 });
    expect(Object.keys(verificationState().members)).toEqual([ids[1]]);
    expect(verificationState().orgStartedAt).toEqual([T0]);
    expect(verificationState().members[ids[1]].phone).toBe(phone(1));
  });
  it('stores only a hash of the code and never logs or returns it', async () => {
    const result = await start();
    const code = codeOfCall(0);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(table.org)).not.toContain(code);
    expect(JSON.stringify(result)).not.toContain(code);
    expect(logs.flatMap(s => s.mock.calls).map(c => c.map(String).join(' ')).join('\n')).not.toContain(code);
  });
  it('meters the call as a verify leg', async () => {
    await start();
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
    expect((recordVendorUsage as jest.Mock).mock.calls[0][0]).toMatchObject({ userId: 'owner', quantity: 1, idempotencyKey: expect.stringMatching(/^twilio:voice:CA\w+:verify$/) });
  });
  it('refuses an unknown member, a team of several without a memberId, a missing number and a plan without the feature', async () => {
    await expect(start('mzzzzzzz')).rejects.toBeInstanceOf(NotFoundError);
    await expect(start(null)).rejects.toBeInstanceOf(ValidationError);
    delete (table.org.hotLeadCall as Record<string, unknown>).twilioNumber;
    delete (table.org.hotLeadCall as Record<string, unknown>).twilioNumberSid;
    await expect(start()).rejects.toBeInstanceOf(ForbiddenError);
    table.org.hotLeadCall = config();
    setHotLeadCallEntitledOverride(false);
    await expect(start()).rejects.toBeInstanceOf(NotEntitledError);
    expect(fake.placedCalls).toEqual([]);
    expect(table.writes).toEqual([]);
  });
  it('refuses callers without org:configure', async () => {
    await expect(startMemberVerification(snapshot(), { userId: 'm', orgRole: 'member' }, ids[0])).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.placedCalls).toEqual([]);
  });
  it('a rejected placement still counts against the limits', async () => {
    fake.failNextPlaceCall('no');
    await expect(start()).rejects.toThrow('no call was placed');
    expect(verificationState().members[ids[0]].startedAt).toEqual([T0]);
  });
});

describe('limits', () => {
  it('allows one start per member per 2 minutes and says how long to wait', async () => {
    await start();
    jest.setSystemTime(T0 + 30_000);
    const err = await start().catch(e => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe(90);
    jest.setSystemTime(T0 + 2 * MIN);
    await expect(start()).resolves.toBeDefined();
  });
  it('allows 5 starts per member per day, then reports when a slot frees', async () => {
    for (let i = 0; i < 5; i++) { jest.setSystemTime(T0 + i * 3 * MIN); await start(); }
    jest.setSystemTime(T0 + 20 * MIN);
    const err = await start().catch(e => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe((DAY - 20 * MIN) / 1000);
    expect(fake.placedCalls).toHaveLength(5);
    jest.setSystemTime(T0 + DAY);
    await expect(start()).resolves.toBeDefined();
  });
  it('the 2 minute gap and the daily count are per member: another person is not held up', async () => {
    await start(ids[0]);
    await expect(start(ids[1])).resolves.toBeDefined();
  });
  it('allows 20 starts per day for the whole organization', async () => {
    table.org.hotLeadCall = config(5);
    for (let round = 0; round < 4; round++) {
      for (const id of ids) { await start(id); }
      jest.setSystemTime(T0 + (round + 1) * 3 * MIN);
    }
    expect(fake.placedCalls).toHaveLength(20);
    const err = await start(ids[0]).catch(e => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.message).toContain('whole organization');
    expect(fake.placedCalls).toHaveLength(20);
  });
  it('removing and re-adding people does not reset the organization counter or a re-used phone\'s history', async () => {
    await start(ids[0]);
    const after = verificationAfterTeamEdit(table.org.hotLeadCallVerification, [{ id: ids[1], phone: phone(1) }]);
    expect(after).toEqual({ members: {}, orgStartedAt: [T0] });
  });
  it('a start history survives a successful confirm', async () => {
    await start();
    await confirm(codeOfCall(0));
    expect(verificationState().members[ids[0]].startedAt).toEqual([T0]);
    jest.setSystemTime(T0 + MIN);
    await expect(start()).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('confirm', () => {
  it('verifies only that member, stores the conditional result and keeps the other member\'s pending code', async () => {
    await start(ids[0]);
    jest.setSystemTime(T0 + 3 * MIN);
    await start(ids[1]);
    const result = await confirm(codeOfCall(0), ids[0]);
    expect(result).toMatchObject({ memberId: ids[0], memberPhone: '***0100', verifiedAt: new Date(T0 + 3 * MIN).toISOString() });
    expect(team().map(m => !!m.verifiedAt)).toEqual([true, false]);
    expect(verificationState().members[ids[0]].codeHash).toBeNull();
    expect(verificationState().members[ids[1]].codeHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('refuses a code heard by another member: replaying member A\'s code on member B fails and spends only B\'s attempt', async () => {
    await start(ids[0]);
    jest.setSystemTime(T0 + 3 * MIN);
    await start(ids[1]);
    const err = await confirm(codeOfCall(0), ids[1]).catch(e => e);
    expect(err).toBeInstanceOf(VerificationCodeError);
    expect(err.attemptsLeft).toBe(4);
    expect(team().every(m => !m.verifiedAt)).toBe(true);
    expect(verificationState().members[ids[0]].attempts).toBe(0);
    expect(verificationState().members[ids[1]].attempts).toBe(1);
  });
  it('binds a code to the member: the same code copied onto another member\'s record does not verify', async () => {
    await start(ids[0]);
    const state = verificationState();
    state.members[ids[1]] = { ...state.members[ids[0]], phone: phone(1) };
    const err = await confirm(codeOfCall(0), ids[1]).catch(e => e);
    expect(err).toBeInstanceOf(VerificationCodeError);
    expect(team().every(m => !m.verifiedAt)).toBe(true);
  });
  it('counts the attempt before comparing and stops after 5 wrong codes, even for the right one afterwards', async () => {
    await start();
    const code = codeOfCall(0);
    for (let i = 4; i >= 0; i--) {
      const err = await confirm(wrong(code)).catch(e => e);
      expect(err.attemptsLeft).toBe(i);
    }
    const spent = await confirm(code).catch(e => e);
    expect(spent).toBeInstanceOf(VerificationCodeError);
    expect(spent.attemptsLeft).toBe(0);
    expect(team()[0].verifiedAt).toBeUndefined();
  });
  it('parallel guesses cannot exceed the cap: only one of the concurrent confirms lands its count', async () => {
    await start();
    const code = codeOfCall(0);
    // Every request read the record before any of them wrote, as concurrent requests do.
    const reads = [snapshot(), snapshot(), snapshot()];
    const results = await Promise.allSettled(reads.map(read => confirmMemberVerification(read, OWNER, ids[0], wrong(code))));
    expect(verificationState().members[ids[0]].attempts).toBe(1);
    expect(results.filter(r => r.status === 'rejected' && r.reason instanceof RateLimitedError)).toHaveLength(2);
  });
  it('refuses after the code expires', async () => {
    await start();
    jest.setSystemTime(T0 + VERIFICATION_CODE_TTL_MS);
    await expect(confirm(codeOfCall(0))).rejects.toThrow('expired');
  });
  it('refuses when nothing was started for that member', async () => {
    await expect(confirm('123456')).rejects.toThrow('No verification is in progress');
    await start(ids[0]);
    await expect(confirm('123456', ids[1])).rejects.toThrow('No verification is in progress');
  });
  it('refuses when the member\'s phone changed after the code was sent', async () => {
    await start();
    const code = codeOfCall(0);
    (table.org.hotLeadCall as { team: Array<Record<string, unknown>> }).team[0].phone = '+16475550123';
    await expect(confirm(code)).rejects.toThrow('different phone');
    expect(team()[0].verifiedAt).toBeUndefined();
  });
  it('fails cleanly when the phone changes while the code is being checked: the conditional write loses and no one is marked verified', async () => {
    await start();
    const code = codeOfCall(0);
    // The first write of confirm counts the attempt; the change lands right before the verifying write.
    const before = table.writes.length;
    table.beforeWrite = index => {
      if (index === before + 1) (table.org.hotLeadCall as { team: Array<Record<string, unknown>> }).team[0].phone = '+16475550123';
    };
    await expect(confirm(code)).rejects.toBeInstanceOf(ConflictError);
    expect(team()[0].verifiedAt).toBeUndefined();
  });
  it('rejects a malformed code without spending an attempt and says how many are left', async () => {
    await start();
    const err = await confirmMemberVerification(snapshot(), OWNER, ids[0], '12ab').catch(e => e);
    expect(err).toBeInstanceOf(VerificationCodeError);
    expect(err.attemptsLeft).toBe(5);
    expect(verificationState().members[ids[0]].attempts).toBe(0);
    await expect(confirmMemberVerification(snapshot(), OWNER, ids[0], '123 456')).rejects.toThrow('not correct');
  });
  it('is available to org admins and refused to members', async () => {
    await start();
    await expect(confirmMemberVerification(snapshot(), { userId: 'm', orgRole: 'member' }, ids[0], codeOfCall(0))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(confirmMemberVerification(snapshot(), { userId: 'a', orgRole: 'admin' }, ids[0], codeOfCall(0))).resolves.toMatchObject({ memberId: ids[0] });
  });
  it('still works for an org that lost its plan (stopping is always possible)', async () => {
    await start();
    setHotLeadCallEntitledOverride(false);
    await expect(confirm(codeOfCall(0))).resolves.toBeDefined();
  });
});

describe('corrupt or legacy stored state fails closed', () => {
  it.each([
    ['a flat single-record shape', { phone: phone(0), codeHash: null, expiresAt: 0, attempts: 0, startedAt: [] }],
    ['a member record without start history', { members: { [ids[0]]: { phone: phone(0), codeHash: null, expiresAt: 0, attempts: 0 } }, orgStartedAt: [] }],
    ['a bad code hash', { members: { [ids[0]]: { phone: phone(0), codeHash: 'zz', expiresAt: 0, attempts: 0, startedAt: [] } }, orgStartedAt: [] }],
    ['a bad member id', { members: { nope: { phone: phone(0), codeHash: null, expiresAt: 0, attempts: 0, startedAt: [] } }, orgStartedAt: [] }],
    ['a non-list org counter', { members: {}, orgStartedAt: 'x' }],
    ['an unknown key', { members: {}, orgStartedAt: [], extra: 1 }],
    ['null', null],
  ])('start and confirm refuse %s and do not place a call or reset the limits', async (_label, raw) => {
    table.org.hotLeadCallVerification = raw;
    const before = JSON.stringify(raw);
    await expect(start()).rejects.toBeInstanceOf(StoredStateInvalidError);
    await expect(confirm('123456')).rejects.toBeInstanceOf(StoredStateInvalidError);
    expect(fake.placedCalls).toEqual([]);
    expect(JSON.stringify(table.org.hotLeadCallVerification)).toBe(before);
  });
});

describe('verificationAfterTeamEdit', () => {
  it('leaves an unchanged team alone and ignores unreadable state', () => {
    const state = { members: { [ids[0]]: { phone: phone(0), codeHash: null, expiresAt: 0, attempts: 0, startedAt: [5] } }, orgStartedAt: [5] };
    expect(verificationAfterTeamEdit(state, [{ id: ids[0], phone: phone(0) }])).toBeNull();
    expect(verificationAfterTeamEdit(undefined, [])).toBeNull();
    expect(verificationAfterTeamEdit({ garbage: true }, [])).toBeNull();
  });
});
