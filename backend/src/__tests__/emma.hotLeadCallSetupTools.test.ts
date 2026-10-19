type Tool = { name: string; definition: { description: string; inputSchema: { properties: object } }; execute: (args: unknown, context: unknown) => Promise<Record<string, unknown>> };
const handlers = new Map<string, Tool>();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { register: (tool: Tool) => handlers.set(tool.name, tool) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
jest.mock('../services/usageRecorderService', () => ({ recordVendorUsage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/voice/hotLeadCallMode', () => ({ isHotLeadCallEnabled: jest.fn().mockResolvedValue(false) }));
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { orgDb, userDb } from '../services/db';
import { recordVendorUsage } from '../services/usageRecorderService';
import { isHotLeadCallEnabled } from '../services/voice/hotLeadCallMode';
import '../emma/hotLeadCallTools';
import '../emma/hotLeadCallSetupTools';
import { FakeVoiceProvider } from '../services/voice/fakeVoiceProvider';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { getRecordingUnit } from '../utils/vendorRateCard';
import { verificationCodeTwiml as verificationTwiml } from '../services/voice/twiml';
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';

const run = (name: string, args: unknown = {}, context: unknown = { userId: 'owner' }) => handlers.get(name)!.execute(args, context);
const provision = (args: unknown = { confirm: true }, ctx?: unknown) => run('provision_hot_lead_call_number', args, ctx);
const release = (ctx?: unknown) => run('release_hot_lead_call_number', {}, ctx);
const start = (args: unknown = {}, ctx?: unknown) => run('start_hot_lead_call_verification', args, ctx);
const confirm = (code: unknown, ctx?: unknown) => run('confirm_hot_lead_call_verification', { code }, ctx);
const SETUP_TOOLS = ['provision_hot_lead_call_number', 'release_hot_lead_call_number', 'start_hot_lead_call_verification', 'confirm_hot_lead_call_verification'];
const VALID_ARGS: Record<string, unknown> = { provision_hot_lead_call_number: { confirm: true }, release_hot_lead_call_number: {}, start_hot_lead_call_verification: {}, confirm_hot_lead_call_verification: { code: '123456' } };

const T0 = Date.parse('2026-10-19T12:00:00.000Z');
const MIN = 60_000;
const SID = 'PN' + 'b'.repeat(32);
const NEW_SID = 'PN' + 'c'.repeat(32);
const NEW_SID_2 = 'PN' + 'd'.repeat(32);
const NEW_NUMBER = '+14155550123';
const NEW_NUMBER_2 = '+14155550124';

let org: Record<string, unknown> & { orgId: string; hotLeadCall?: Record<string, unknown>; hotLeadCallVerification?: Record<string, unknown> };
let fake: FakeVoiceProvider;
let writes: Array<{ updates: Record<string, unknown>; condition?: { expression: string } }>;
let beforeWrite: ((index: number) => void) | null;
let afterWriteThrows: Error | null;
// structuredClone/isDeepStrictEqual compare prototypes across jest's vm realm, so use JSON for the fake table.
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const logSpies: jest.SpyInstance[] = [];

const configured = (extra: Record<string, unknown> = {}) => ({
  enabled: false, destinationPhone: '+14155550100', leadTypes: ['form_fill'], maxAgeMinutes: 10, maxCallsPerHour: 6, maxCallsPerDay: 20,
  ownerCooldownMinutes: 2, announcedName: 'Acme Plumbing', quietHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
  allowedCountries: ['US', 'CA'], ...extra,
});
const withNumber = (extra: Record<string, unknown> = {}) => configured({ twilioNumber: '+14155550111', twilioNumberSid: SID, ...extra });

/** In-memory org table that evaluates the conditions the tools generate, merging aliases like the real orgDb.updateOrg. */
function installOrgDb() {
  (orgDb.getOrgById as jest.Mock).mockImplementation(async () => clone(org));
  (orgDb.updateOrg as jest.Mock).mockImplementation(async (orgId: string, updates: Record<string, unknown>, options?: { condition?: { expression: string; names?: Record<string, string>; values?: Record<string, unknown> } }) => {
    const index = writes.length;
    writes.push({ updates, condition: options?.condition });
    beforeWrite?.(index);
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) values[`:${k}`] = v;
    Object.assign(values, options?.condition?.values ?? {});
    const names = options?.condition?.names ?? {};
    for (const clause of (options?.condition?.expression ?? '').split(' AND ').filter(Boolean)) {
      const absent = /^attribute_not_exists\((#\w+)\)$/.exec(clause);
      const equal = /^(#\w+) = (:\w+)$/.exec(clause);
      if (!absent && !equal) throw new Error(`test db cannot evaluate: ${clause}`);
      const holds = absent ? org[names[absent[1]]] === undefined : sameValue(org[names[equal![1]]], values[equal![2]]);
      if (!holds) throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
    }
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) delete org[k];
      else org[k] = clone(values[`:${k}`]);
    }
    if (afterWriteThrows) {
      const err = afterWriteThrows;
      afterWriteThrows = null;
      throw err;
    }
    return org;
  });
}

const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');
const codeFromCall = (index = 0) => {
  const twiml = (fake.placedCalls[index] as { twiml: string }).twiml;
  return /code is ((?:\d ){5}\d)\./.exec(twiml)![1].replace(/ /g, '');
};
const setTime = (ms: number) => jest.setSystemTime(ms);
const allLogs = () => logSpies.flatMap(s => s.mock.calls).map(c => c.map(String).join(' ')).join('\n');

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-not-real'; });
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
  writes = [];
  beforeWrite = null;
  afterWriteThrows = null;
  org = { orgId: 'org-a', ownerUserId: 'owner', hotLeadCall: configured() };
  fake = new FakeVoiceProvider();
  setVoiceProviderForTests(fake);
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner', orgId: 'org-a', orgRole: 'owner' });
  installOrgDb();
  logSpies.splice(0, logSpies.length, ...(['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => undefined)));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  setVoiceProviderForTests(null);
});

describe('permissions and registration', () => {
  it.each(SETUP_TOOLS)('%s refuses members and global admins without org:configure', async name => {
    org.hotLeadCall = withNumber();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'm', orgId: 'org-a', orgRole: 'member', isAdmin: true });
    await expect(run(name, VALID_ARGS[name], { userId: 'm' })).rejects.toThrow('owners and admins');
    expect(writes).toEqual([]);
    expect(fake.placedCalls.length + fake.boughtNumbers.length + fake.releasedNumbers.length).toBe(0);
  });
  it.each(SETUP_TOOLS)('%s allows an org admin past the permission check', async name => {
    org.hotLeadCall = withNumber();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'a', orgId: 'org-a', orgRole: 'admin' });
    const outcome = await run(name, VALID_ARGS[name], { userId: 'a' }).catch((e: Error) => e);
    expect(String(outcome instanceof Error ? outcome.message : '')).not.toMatch(/owners and admins|Authentication|membership/);
  });
  it.each(SETUP_TOOLS)('%s needs authentication, a persisted membership and cannot reach another org', async name => {
    await expect(run(name, VALID_ARGS[name], {})).rejects.toThrow('Authentication');
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ userId: 'owner' });
    await expect(run(name, VALID_ARGS[name])).rejects.toThrow('membership');
    org.orgId = 'org-b';
    await expect(run(name, VALID_ARGS[name])).rejects.toThrow('Organization not found');
    org.orgId = 'org-a';
    await expect(run(name, { ...(VALID_ARGS[name] as object), orgId: 'org-b' })).rejects.toThrow('Invalid');
    await expect(run(name, { ...(VALID_ARGS[name] as object), userId: 'victim' })).rejects.toThrow('Invalid');
    expect(writes).toEqual([]);
    expect(fake.placedCalls.length + fake.boughtNumbers.length + fake.releasedNumbers.length).toBe(0);
  });
  it('requires saved settings first', async () => {
    delete org.hotLeadCall;
    for (const name of SETUP_TOOLS) await expect(run(name, VALID_ARGS[name])).rejects.toThrow('Save the hot lead call settings first');
  });
  it('fails closed on malformed stored settings', async () => {
    (org.hotLeadCall as Record<string, unknown>).maxCallsPerDay = 9999;
    await expect(provision()).rejects.toThrow('invalid');
    await expect(start()).rejects.toThrow('invalid');
  });
  it('is registered in tools.ts and blocked in shared sessions', () => {
    expect(readFileSync(join(__dirname, '../emma/tools.ts'), 'utf8')).toContain("import './hotLeadCallSetupTools';");
    for (const name of SETUP_TOOLS) expect(SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS.has(name)).toBe(true);
  });
  it('works while the platform kill switch is off, without consulting it', async () => {
    org.hotLeadCall = withNumber();
    await expect(start()).resolves.toMatchObject({ success: true });
    expect(isHotLeadCallEnabled).not.toHaveBeenCalled();
  });
  it('describes confirm as advisory, the cost without a hard-coded price, and the irreversible release', () => {
    const buy = handlers.get('provision_hot_lead_call_number')!.definition.description;
    expect(buy).toMatch(/confirm is advisory/);
    expect(buy).not.toMatch(/1\.15/);
    expect(handlers.get('release_hot_lead_call_number')!.definition.description).toMatch(/cannot be recovered/);
    expect(handlers.get('start_hot_lead_call_verification')!.definition.description).toMatch(/voicemail.*Twilio call log/);
  });
  it('does not expose the system fields or a destination argument on any setup tool', () => {
    for (const name of SETUP_TOOLS) {
      const props = Object.keys(handlers.get(name)!.definition.inputSchema.properties);
      for (const forbidden of ['to', 'phone', 'destinationPhone', 'twilioNumber', 'twilioNumberSid', 'destinationVerifiedAt', 'orgId', 'userId']) expect(props).not.toContain(forbidden);
    }
  });
});

describe('provision_hot_lead_call_number', () => {
  it.each([[{}], [{ confirm: false }], [{ confirm: 'true' }], [{ confirm: 1 }], [{ confirm: null }]])('does not spend without confirm:true (%j)', async args => {
    await expect(provision(args)).rejects.toThrow('costs money');
    expect(fake.boughtNumbers).toEqual([]);
  });
  it.each(['41', '4155', 'abc', '41a', '', 415, ' 415'])('rejects area code %j before buying', async areaCode => {
    await expect(provision({ confirm: true, areaCode })).rejects.toThrow('areaCode must be exactly 3 digits');
    expect(fake.boughtNumbers).toEqual([]);
  });
  it('refuses when the org already has a number, or only a sid', async () => {
    org.hotLeadCall = withNumber();
    await expect(provision()).rejects.toThrow('already has a caller number');
    org.hotLeadCall = configured({ twilioNumberSid: SID });
    await expect(provision()).rejects.toThrow('already has a caller number');
    expect(fake.boughtNumbers).toEqual([]);
  });

  it('buys a US number, stores it conditionally, meters the first month and reveals neither number nor sid', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    const result = await provision({ confirm: true, areaCode: '415' });
    expect(fake.boughtNumbers).toEqual([{ countryCode: 'US', areaCode: '415' }]);
    expect(org.hotLeadCall).toMatchObject({ twilioNumber: NEW_NUMBER, twilioNumberSid: NEW_SID, enabled: false, destinationPhone: '+14155550100' });
    expect(result).toMatchObject({ success: true, callerNumber: '***0123' });
    expect(JSON.stringify(result)).not.toMatch(/4155550123|\+1415|PN/);
    expect(writes).toHaveLength(2);
    expect(writes[0].updates.hotLeadCallProvisioning).toEqual({ purchases: [T0], releases: [] });
    expect(writes[0].condition!.expression).toBe('attribute_not_exists(#previousHotLeadCallProvisioning) AND #previousHotLeadCall = :previousHotLeadCall');
    expect(writes[1].condition!.expression).toBe('#previousHotLeadCall = :previousHotLeadCall');
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
    expect(recordVendorUsage).toHaveBeenCalledWith({
      userId: 'owner', provider: 'twilio', operation: 'number_monthly_rent', feature: 'hot_lead_call', unit: 'number_month',
      quantity: 1, rateKey: 'number_monthly_rent', idempotencyKey: `twilio:number:${NEW_SID}:2026-10`,
    });
    expect(allLogs()).not.toContain('4155550123');
  });
  it('omits areaCode when none is given and treats null as omitted', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    await provision({ confirm: true, areaCode: null });
    expect(fake.boughtNumbers).toEqual([{ countryCode: 'US' }]);
  });
  it('keeps verification and the enabled flag as they were', async () => {
    org.hotLeadCall = configured({ destinationVerifiedAt: '2026-01-01T00:00:00.000Z' });
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    await provision();
    expect(org.hotLeadCall).toMatchObject({ destinationVerifiedAt: '2026-01-01T00:00:00.000Z', enabled: false });
  });

  it('two racing provisions reach Twilio once: the reservation is conditional, so the loser never buys', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    fake.queueBuyNumberResult({ numberSid: NEW_SID_2, phoneNumber: NEW_NUMBER_2 });
    const results = await Promise.allSettled([provision(), provision()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message).toContain('in progress');
    expect(fake.boughtNumbers).toHaveLength(1);
    expect(fake.releasedNumbers).toEqual([]);
    expect(org.hotLeadCall!.twilioNumberSid).toBe(NEW_SID);
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
  });
  it('caps purchases at 2 per rolling 24h and a release/provision loop cannot get around it', async () => {
    for (let i = 0; i < 2; i++) {
      fake.queueBuyNumberResult({ numberSid: i ? NEW_SID_2 : NEW_SID, phoneNumber: i ? NEW_NUMBER_2 : NEW_NUMBER });
      setTime(T0 + i * MIN);
      await provision();
      await release();
    }
    setTime(T0 + 5 * MIN);
    await expect(provision()).rejects.toThrow('limit of 2 number purchases per day');
    expect(fake.boughtNumbers).toHaveLength(2);
    expect((org.hotLeadCallProvisioning as { purchases: number[] }).purchases).toEqual([T0, T0 + MIN]);
    setTime(T0 + 24 * 60 * MIN - 1);
    await expect(provision()).rejects.toThrow('limit of 2');
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    setTime(T0 + 24 * 60 * MIN);
    await expect(provision()).resolves.toMatchObject({ success: true });
    expect(fake.boughtNumbers).toHaveLength(3);
  });
  it('a failed purchase still uses a reservation, and a malformed history fails closed', async () => {
    fake.failNextBuyNumber('no');
    await expect(provision()).rejects.toThrow('nothing was bought');
    expect((org.hotLeadCallProvisioning as { purchases: number[] }).purchases).toEqual([T0]);
    org.hotLeadCallProvisioning = { purchases: 'x', releases: [] } as never;
    await expect(provision()).rejects.toThrow('Contact support');
    expect(fake.boughtNumbers).toHaveLength(1);
  });
  it('takes the unit and the price text from the rate card', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    await expect(provision({})).rejects.toThrow(/\$1\.15 per month/);
    await provision();
    expect((recordVendorUsage as jest.Mock).mock.calls[0][0].unit).toBe(getRecordingUnit('twilio', 'number_monthly_rent'));
  });
  it('releases the purchase when a concurrent settings edit wins, and does not meter rent', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    beforeWrite = i => { if (i === 1) org.hotLeadCall = configured({ maxCallsPerHour: 3 }); };
    await expect(provision()).rejects.toThrow('released');
    expect(fake.releasedNumbers).toEqual([NEW_SID]);
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumberSid');
    // The discarded purchase was still billed, so its rent is metered (idempotent per sid and month).
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
    expect(recordVendorUsage).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `twilio:number:${NEW_SID}:2026-10` }));
  });
  it('logs an ORPHAN (sid, no number) and tells the user to contact support when the loser cannot be released', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    fake.failNextReleaseNumber('unknown');
    beforeWrite = i => { if (i === 1) org.hotLeadCall = configured({ maxCallsPerHour: 3 }); };
    await expect(provision()).rejects.toThrow('Contact support');
    const logged = allLogs();
    expect(logged).toContain(`ORPHAN number: org org-a sid ${NEW_SID}`);
    expect(logged).not.toContain('4155550123');
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
  });
  it('treats an ambiguous write failure that actually landed as success (no release)', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    beforeWrite = i => { if (i === 1) afterWriteThrows = new Error('socket hang up'); };
    await expect(provision()).resolves.toMatchObject({ success: true });
    expect(fake.releasedNumbers).toEqual([]);
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
  });
  it('releases when an ambiguous write failure did not land', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    beforeWrite = i => { if (i === 1) throw new Error('socket hang up'); };
    await expect(provision()).rejects.toThrow('released');
    expect(fake.releasedNumbers).toEqual([NEW_SID]);
    // The ambiguity check must not read a stale replica.
    expect(orgDb.getOrgById).toHaveBeenLastCalledWith('org-a', undefined, true);
  });
  it('does NOT release when it cannot tell whether the write landed, and logs the orphan risk', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    beforeWrite = i => { if (i === 1) throw new Error('socket hang up'); };
    (orgDb.getOrgById as jest.Mock).mockResolvedValueOnce(clone(org)).mockRejectedValueOnce(new Error('db down'));
    await expect(provision()).rejects.toThrow('could not be confirmed');
    expect(fake.releasedNumbers).toEqual([]);
    expect(allLogs()).toContain(`ORPHAN number: org org-a sid ${NEW_SID}`);
  });
  it('does not retry an ambiguous purchase and reports a possible orphan', async () => {
    fake.failNextBuyNumber('unknown', 'timeout');
    await expect(provision()).rejects.toThrow('Do not retry');
    expect(fake.boughtNumbers).toHaveLength(1);
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumberSid');
    expect(recordVendorUsage).not.toHaveBeenCalled();
    expect(allLogs()).toContain('ORPHAN RISK');
  });
  it('reports a definite rejection as nothing bought', async () => {
    fake.failNextBuyNumber('no', 'No voice-enabled number available for US/415');
    await expect(provision({ confirm: true, areaCode: '415' })).rejects.toThrow('nothing was bought or charged');
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumberSid');
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });
  it('releases a purchased number that fails validation (here: equals the destination phone) instead of storing it', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: '+14155550100' });
    await expect(provision()).rejects.toThrow('was released');
    expect(fake.releasedNumbers).toEqual([NEW_SID]);
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumberSid');
  });
});

describe('release_hot_lead_call_number', () => {
  beforeEach(() => { org.hotLeadCall = withNumber({ enabled: true, destinationVerifiedAt: '2026-01-01T00:00:00.000Z' }); });

  it('turns calling off before releasing, then clears the number and sid but keeps verification', async () => {
    const order: string[] = [];
    beforeWrite = () => order.push('write');
    const original = fake.releaseNumber.bind(fake);
    jest.spyOn(fake, 'releaseNumber').mockImplementation(async sid => { order.push('twilio'); return original(sid); });
    const result = await release();
    expect(order).toEqual(['write', 'write', 'twilio', 'write']);
    expect(writes[0].updates.hotLeadCallProvisioning).toEqual({ purchases: [], releases: [T0] });
    expect(writes[1].updates.hotLeadCall).toMatchObject({ enabled: false, twilioNumberSid: SID });
    expect(fake.releasedNumbers).toEqual([SID]);
    expect(org.hotLeadCall).toEqual(configured({ destinationVerifiedAt: '2026-01-01T00:00:00.000Z' }));
    expect(result).toMatchObject({ success: true, callerNumberReleased: true, callingEnabled: false });
    expect(JSON.stringify(result)).not.toMatch(/4155550111|PN/);
  });
  it('clears locally when Twilio says the number is already gone (404)', async () => {
    fake.failNextReleaseNumber('no', 'not found', 404);
    await release();
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumberSid');
  });
  it.each([[401], [429]])('keeps the number when Twilio refuses with %s, but calling stays off', async status => {
    fake.failNextReleaseNumber('no', 'refused', status);
    await expect(release()).rejects.toThrow(/Calling is now off.*still assigned/);
    expect(org.hotLeadCall).toMatchObject({ twilioNumberSid: SID, enabled: false });
  });
  it('keeps the number on an ambiguous failure and says to check Twilio before retrying', async () => {
    fake.failNextReleaseNumber('unknown');
    await expect(release()).rejects.toThrow(/did not confirm.*Check the Twilio console/);
    expect(org.hotLeadCall).toMatchObject({ twilioNumberSid: SID, enabled: false });
  });
  it('a stored number without a sid is cleared locally with calling off and no Twilio call', async () => {
    org.hotLeadCall = withNumber({ enabled: true, destinationVerifiedAt: '2026-01-01T00:00:00.000Z' });
    delete (org.hotLeadCall as Record<string, unknown>).twilioNumberSid;
    await release();
    expect(fake.releasedNumbers).toEqual([]);
    expect(org.hotLeadCall).toMatchObject({ enabled: false });
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumber');
  });
  it('caps releases per day so a loop cannot hammer Twilio, and keeps the history after success', async () => {
    org.hotLeadCallProvisioning = { purchases: [], releases: [1, 2, 3, 4, 5, 6].map(n => T0 - n) };
    await expect(release()).rejects.toThrow('limit of 6 number releases per day');
    expect(fake.releasedNumbers).toEqual([]);
  });
  it('refuses when there is no number', async () => {
    org.hotLeadCall = configured();
    await expect(release()).rejects.toThrow('no caller number');
    expect(fake.releasedNumbers).toEqual([]);
  });
  it('re-reads and retries once when a settings edit lands during the final write', async () => {
    beforeWrite = i => { if (i === 2) (org.hotLeadCall as Record<string, unknown>).maxCallsPerHour = 3; };
    await release();
    expect(org.hotLeadCall).toMatchObject({ maxCallsPerHour: 3 });
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumberSid');
  });
  it('gives up after a second conflict and leaves the sid so a retry (404) can finish', async () => {
    let bump = 3;
    beforeWrite = i => { if (i >= 2) (org.hotLeadCall as Record<string, unknown>).maxCallsPerHour = bump++; };
    await expect(release()).rejects.toThrow('Try again');
    expect(org.hotLeadCall).toHaveProperty('twilioNumberSid');
  });
});

describe('start_hot_lead_call_verification', () => {
  beforeEach(() => { org.hotLeadCall = withNumber(); });

  it('needs a provisioned caller number and places no call without one', async () => {
    org.hotLeadCall = configured();
    await expect(start()).rejects.toThrow('Provision a caller number first');
    expect(fake.placedCalls).toEqual([]);
    expect(writes).toEqual([]);
  });
  it.each([[{ to: '+14155550199' }], [{ destinationPhone: '+14155550199' }], [{ phone: '+14155550199' }]])('never takes a number from arguments (%j)', async args => {
    await expect(start(args)).rejects.toThrow('Invalid');
    expect(fake.placedCalls).toEqual([]);
  });

  it('places one call to the stored destination from the caller number with inline TwiML and stores only a hash', async () => {
    const result = await start();
    expect(fake.placedCalls).toHaveLength(1);
    const call = fake.placedCalls[0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ to: '+14155550100', from: '+14155550111', timeoutSeconds: 30 });
    expect(call).not.toHaveProperty('url');
    expect(call).not.toHaveProperty('statusCallbackUrl');
    const code = codeFromCall();
    expect(call.twiml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?><Response><Pause length="1"\/><Say>Your Agent Web verification code is (\d \d \d \d \d \d)\. Again, your code is \1\. Goodbye\.<\/Say><\/Response>$/);
    const record = org.hotLeadCallVerification!;
    expect(record).toMatchObject({ phone: '+14155550100', expiresAt: T0 + 10 * MIN, attempts: 0, callSid: 'CA00000001', startedAt: [T0] });
    expect(record.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(record).sort()).toEqual(['attempts', 'callSid', 'codeHash', 'expiresAt', 'phone', 'startedAt']);
    expect(Object.values(record)).not.toContain(code);
    expect(result).toMatchObject({ success: true, destinationPhone: '***0100', expiresInMinutes: 10, maxAttempts: 5 });
    expect(writes.every(w => !!w.condition?.expression)).toBe(true);
  });
  it('never returns or logs the code, or full phone numbers', async () => {
    const result = await start();
    const code = codeFromCall();
    const output = JSON.stringify(result);
    expect(output).not.toContain(code);
    expect(output).not.toMatch(/4155550100|4155550111/);
    expect(allLogs()).not.toContain(code);
    expect(allLogs()).not.toMatch(/4155550100/);
    await expect(confirm(wrongCode(code))).rejects.toThrow('not correct');
    expect(allLogs()).not.toContain(code);
  });
  it('draws the code from crypto.randomInt and keeps leading zeros', async () => {
    const spy = jest.spyOn(crypto, 'randomInt').mockImplementation((() => 42) as unknown as typeof crypto.randomInt);
    await start();
    expect(spy).toHaveBeenCalledWith(0, 1_000_000);
    expect(codeFromCall()).toBe('000042');
    await expect(confirm('000042')).resolves.toMatchObject({ success: true });
  });
  it('only builds TwiML from exactly six digits', () => {
    for (const bad of ['12345', '1234567', '12&456', '<1234>', '12 456', '１２３４５６']) expect(() => verificationTwiml(bad)).toThrow('6 digits');
  });
  it('meters the call as a one-minute verify leg, idempotent per call sid', async () => {
    await start();
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
    expect(recordVendorUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner', provider: 'twilio', operation: 'voice_minute_outbound', unit: 'minute', quantity: 1,
      rateKey: 'voice_minute_outbound', idempotencyKey: 'twilio:voice:CA00000001:verify',
    }));
  });

  it('allows one start per 2 minutes: rejected just before, allowed exactly at 2 minutes', async () => {
    await start();
    setTime(T0 + 2 * MIN - 1);
    await expect(start()).rejects.toThrow('Wait 1 minute');
    expect(fake.placedCalls).toHaveLength(1);
    setTime(T0 + 2 * MIN);
    await expect(start()).resolves.toMatchObject({ success: true });
    expect(fake.placedCalls).toHaveLength(2);
  });
  it('allows 5 starts per rolling day and frees a slot when the oldest is 24h old', async () => {
    for (let i = 0; i < 5; i++) { setTime(T0 + i * 3 * MIN); await start(); }
    setTime(T0 + 20 * MIN);
    await expect(start()).rejects.toThrow('limit of 5');
    expect(fake.placedCalls).toHaveLength(5);
    setTime(T0 + 24 * 60 * MIN - 1);
    await expect(start()).rejects.toThrow('limit of 5');
    setTime(T0 + 24 * 60 * MIN);
    await expect(start()).resolves.toMatchObject({ success: true });
    expect(org.hotLeadCallVerification!.startedAt).toHaveLength(5);
  });
  it('a restart replaces the code and resets attempts, but not the rate history', async () => {
    await start();
    const first = codeFromCall(0);
    await expect(confirm(wrongCode(first))).rejects.toThrow('not correct');
    setTime(T0 + 3 * MIN);
    await start();
    expect(org.hotLeadCallVerification).toMatchObject({ attempts: 0, startedAt: [T0, T0 + 3 * MIN], expiresAt: T0 + 13 * MIN });
  });
  it('ignores a corrupt stored record (no trusted history) but replaces it conditionally', async () => {
    org.hotLeadCallVerification = { garbage: true };
    await start();
    expect(org.hotLeadCallVerification).toHaveProperty('codeHash');
    expect(writes[0].condition!.expression).toBe('#previousHotLeadCallVerification = :previousHotLeadCallVerification');
  });
  it('two simultaneous starts place exactly one call', async () => {
    const results = await Promise.allSettled([start(), start()]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(fake.placedCalls).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message).toContain('same moment');
  });
  it('places no call when the record cannot be stored', async () => {
    (orgDb.updateOrg as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await expect(start()).rejects.toThrow('db down');
    expect(fake.placedCalls).toEqual([]);
  });
  it('reports a rejected placement as not charged and does not meter', async () => {
    fake.failNextPlaceCall('no');
    await expect(start()).rejects.toThrow('nothing was charged');
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });
  it('reports an ambiguous placement without claiming either outcome, and does not meter', async () => {
    fake.failNextPlaceCall('unknown');
    await expect(start()).rejects.toThrow('did not confirm');
    expect(fake.placedCalls).toHaveLength(1);
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });
  it('still succeeds and meters when only the CallSid trace write fails', async () => {
    (orgDb.updateOrg as jest.Mock).mockImplementationOnce(async (...a: unknown[]) => { writes.push({ updates: {} }); return a; }).mockRejectedValueOnce(new Error('db blip'));
    await expect(start()).resolves.toMatchObject({ success: true });
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
  });
});

describe('confirm_hot_lead_call_verification', () => {
  beforeEach(() => {
    org.hotLeadCall = withNumber({ enabled: false });
  });

  it('verifies, writes destinationVerifiedAt, clears the pending record and keeps other settings', async () => {
    await start();
    const code = codeFromCall();
    setTime(T0 + MIN);
    const result = await confirm(code);
    expect(org.hotLeadCall).toEqual(withNumber({ destinationVerifiedAt: new Date(T0 + MIN).toISOString() }));
    expect(org.hotLeadCallVerification).toEqual({ phone: '+14155550100', codeHash: null, expiresAt: 0, attempts: 0, startedAt: [T0] });
    expect(result).toMatchObject({ success: true, destinationVerified: true, destinationPhone: '***0100' });
    expect(JSON.stringify(result)).not.toMatch(/4155550100/);
    expect(JSON.stringify(result)).not.toContain(code);
  });
  it('accepts the code typed with spaces or dashes', async () => {
    await start();
    const code = codeFromCall();
    await expect(confirm(`${code.slice(0, 3)} ${code.slice(3)}`)).resolves.toMatchObject({ success: true });
  });
  it.each(['12345', '1234567', 'abcdef', '', 123456, null, undefined, { a: 1 }])('rejects a malformed code %j without counting an attempt', async bad => {
    await start();
    const before = clone(org.hotLeadCallVerification);
    await expect(confirm(bad)).rejects.toThrow(/6 digits|Invalid/);
    expect(org.hotLeadCallVerification).toEqual(before);
  });
  it('lets the owner enable calling afterwards through the existing settings tool', async () => {
    await start();
    await confirm(codeFromCall());
    await expect(run('update_hot_lead_call_settings', { enabled: true })).resolves.toMatchObject({ enabled: true, destinationVerified: true });
  });
  it('a confirm does not reset the start history: alternating phones cannot dodge the gap or the daily cap', async () => {
    await start();
    await confirm(codeFromCall());
    setTime(T0 + MIN);
    await expect(start()).rejects.toThrow('just placed');
    const phones = ['+16475550123', '+14155550100'];
    for (let i = 1; i <= 4; i++) {
      setTime(T0 + 2 * i * MIN);
      (org.hotLeadCall as Record<string, unknown>).destinationPhone = phones[i % 2];
      delete (org.hotLeadCall as Record<string, unknown>).destinationVerifiedAt;
      await start();
      await confirm(codeFromCall(i));
    }
    (org.hotLeadCall as Record<string, unknown>).destinationPhone = '+16475550123';
    setTime(T0 + 12 * MIN);
    await expect(start()).rejects.toThrow('limit of 5');
    expect(fake.placedCalls).toHaveLength(5);
  });
  it('a hash issued for one org or phone does not verify under another (the MAC binds both)', async () => {
    await start();
    const code = codeFromCall();
    const record = clone(org.hotLeadCallVerification);
    org.hotLeadCall = withNumber({ destinationPhone: '+16475550123' });
    org.hotLeadCallVerification = { ...record, phone: '+16475550123' };
    await expect(confirm(code)).rejects.toThrow('not correct');
    org.hotLeadCall = withNumber();
    org.hotLeadCallVerification = clone(record);
    org.orgId = 'org-b';
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner', orgId: 'org-b', orgRole: 'owner' });
    await expect(confirm(code)).rejects.toThrow('not correct');
  });
  it('needs a verification in progress, and a code cannot be replayed', async () => {
    await expect(confirm('123456')).rejects.toThrow('No verification is in progress');
    await start();
    const code = codeFromCall();
    await confirm(code);
    await expect(confirm(code)).rejects.toThrow('No verification is in progress');
  });
  it('counts wrong attempts, allows the fifth try to succeed, and locks after five wrong ones', async () => {
    await start();
    const code = codeFromCall();
    for (let i = 1; i <= 4; i++) await expect(confirm(wrongCode(code))).rejects.toThrow(`${5 - i} attempt(s) left`);
    await expect(confirm(code)).resolves.toMatchObject({ success: true });

    org.hotLeadCall = withNumber();
    setTime(T0 + 3 * MIN);
    await start();
    const second = codeFromCall(1);
    for (let i = 1; i <= 4; i++) await expect(confirm(wrongCode(second))).rejects.toThrow('not correct');
    await expect(confirm(wrongCode(second))).rejects.toThrow('no attempts are left');
    await expect(confirm(second)).rejects.toThrow('Too many incorrect attempts');
    expect(org.hotLeadCall).not.toHaveProperty('destinationVerifiedAt');
  });
  it('parallel guesses cannot exceed the attempt budget: only one concurrent confirm is counted', async () => {
    await start();
    const code = codeFromCall();
    const results = await Promise.allSettled([confirm(wrongCode(code)), confirm(wrongCode(code)), confirm(wrongCode(code))]);
    expect(org.hotLeadCallVerification!.attempts).toBe(1);
    expect(results.filter(r => r.status === 'rejected' && /Another confirmation/.test(r.reason.message))).toHaveLength(2);
  });
  it('expires exactly at expiresAt: valid 1ms before, rejected at the boundary', async () => {
    await start();
    const code = codeFromCall();
    setTime(T0 + 10 * MIN);
    await expect(confirm(code)).rejects.toThrow('expired');
    setTime(T0 + 10 * MIN - 1);
    await expect(confirm(code)).resolves.toMatchObject({ success: true });
  });
  it('refuses when the destination phone changed between start and confirm, and never verifies the new phone', async () => {
    await start();
    const code = codeFromCall();
    org.hotLeadCall = withNumber({ destinationPhone: '+16475550123' });
    await expect(confirm(code)).rejects.toThrow('phone changed');
    expect(org.hotLeadCall).not.toHaveProperty('destinationVerifiedAt');
  });
  it('refuses when the settings change between the check and the write (conditional write)', async () => {
    await start();
    const code = codeFromCall();
    writes.length = 0;
    beforeWrite = i => { if (i === 1) org.hotLeadCall = withNumber({ destinationPhone: '+16475550123' }); };
    await expect(confirm(code)).rejects.toThrow('settings changed');
    expect(org.hotLeadCall).not.toHaveProperty('destinationVerifiedAt');
    expect(org.hotLeadCall).toMatchObject({ destinationPhone: '+16475550123' });
  });
  it('compares the hash in constant time, on equal-length buffers', async () => {
    await start();
    const code = codeFromCall();
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    await expect(confirm(wrongCode(code))).rejects.toThrow('not correct');
    await confirm(code);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });
  it('a verification record issued under another secret does not verify (the hash is keyed)', async () => {
    await start();
    const code = codeFromCall();
    process.env.JWT_SECRET = 'a-different-secret';
    try {
      await expect(confirm(code)).rejects.toThrow('not correct');
    } finally {
      process.env.JWT_SECRET = 'test-secret-not-real';
    }
  });
  it('writes only through conditional updates across the whole flow', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    org.hotLeadCall = configured();
    await provision();
    setTime(T0 + MIN);
    await start();
    await expect(confirm(wrongCode(codeFromCall()))).rejects.toThrow();
    await confirm(codeFromCall());
    await release();
    expect(writes.length).toBeGreaterThanOrEqual(6);
    for (const w of writes) expect(w.condition?.expression).toMatch(/attribute_not_exists|#previous\w+ = :previous\w+/);
  });
  it('no setup tool ever writes the system fields from arguments: update_hot_lead_call_settings still refuses them', async () => {
    await expect(run('update_hot_lead_call_settings', { destinationVerifiedAt: '2026-02-02T00:00:00.000Z' })).rejects.toThrow('managed by the system');
  });
});
