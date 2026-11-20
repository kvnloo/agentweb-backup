type Tool = { name: string; definition: { description: string; inputSchema: { properties: object } }; execute: (args: unknown, context: unknown) => Promise<Record<string, unknown>> };
const handlers = new Map<string, Tool>();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { register: (tool: Tool) => handlers.set(tool.name, tool) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn() }, orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() } }));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: jest.fn(), getMessagesFromMessagesTable: jest.fn(), claimMetaWriteManifestDigest: jest.fn() },
}));
jest.mock('../services/hotLeadCallBillingService', () => ({ ...jest.requireActual('../services/hotLeadCallBillingService'), addHotLeadCallBilling: jest.fn() }));
jest.mock('../services/usageRecorderService', () => ({ recordVendorUsage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/voice/hotLeadCallMode', () => ({ isHotLeadCallEnabled: jest.fn().mockResolvedValue(false) }));
import { spokenCode } from './helpers/spokenCode';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { orgDb, userDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import { deckHalt, deckReply, type DeckMessage } from './helpers/approvalDeckHistory';
import { addHotLeadCallBilling, HotLeadCallBillingError } from '../services/hotLeadCallBillingService';
import { recordVendorUsage } from '../services/usageRecorderService';
import { isHotLeadCallEnabled } from '../services/voice/hotLeadCallMode';
import '../emma/hotLeadCallTools';
import '../emma/hotLeadCallSetupTools';
import { teamMember, MEMBER_ID, VERIFIED_AT, storedConfigFixture } from './helpers/hotLeadCallFixtures';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { getRecordingUnit } from '../utils/vendorRateCard';
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';

const run = (name: string, args: unknown = {}, context: unknown = { userId: 'owner' }) => handlers.get(name)!.execute(args, context);
const SESSION = 'sess-1';
const attended = (extra: Record<string, unknown> = {}) => ({ userId: 'owner', sessionId: SESSION, ...extra });
type Halt = { awaitingUserConfirmation?: boolean; questionDeckPayload?: Array<{ kind: string; question: string; options: Array<{ id: string }> }> };

// In-memory chat sessions: the history the approval gate reads and the single-use map it claims in.
type FakeSession = { sessionType?: string; consumedMetaWriteManifestDigests: Record<string, string>; messages: DeckMessage[] };
let sessions: Map<string, FakeSession>;
let deckCounter: number;
const sessionOf = (id: string) => { if (!sessions.has(id)) sessions.set(id, { sessionType: 'chat', consumedMetaWriteManifestDigests: {}, messages: [] }); return sessions.get(id)!; };
function installChatDb() {
  sessions = new Map();
  deckCounter = 0;
  (chatbotDb.getChatSession as jest.Mock).mockImplementation(async (id: string) => clone(sessionOf(id)));
  // The default read is eventually consistent: it can miss the newest message.
  (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockImplementation(async (id: string) => clone(sessionOf(id).messages.slice(0, -1)));
  (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockImplementation(async (id: string, key: string) => {
    const map = sessionOf(id).consumedMetaWriteManifestDigests;
    if (key in map) return false;
    map[key] = new Date().toISOString();
    return true;
  });
}
/** Records a halt the way the deck seam stores it, and returns the deck id. */
function recordHalt(result: unknown, sessionId = SESSION): string {
  const item = (result as Halt).questionDeckPayload![0];
  const deckId = `deck-${++deckCounter}`;
  sessionOf(sessionId).messages.push(deckHalt(item.kind, deckId, item.question));
  return deckId;
}
function answerCard(deckId: string, verdict: string, sessionId = SESSION, extra: { answeredBy?: 'user' | 'delegation'; at?: string } = {}) {
  sessionOf(sessionId).messages.push(deckReply(deckId, verdict, extra.answeredBy ?? 'user', extra.at ?? new Date().toISOString()));
}
/** Calls the tool, and when it halts with a card, has the user approve it and calls again. */
async function withApproval(name: string, args: unknown, ctx: { sessionId?: string } = attended()) {
  const first = await run(name, args, ctx);
  if (!(first as Halt).awaitingUserConfirmation) return first;
  answerCard(recordHalt(first, ctx.sessionId), 'approve', ctx.sessionId);
  return run(name, args, ctx);
}
/** Gets a card and has the user approve it, without running the tool a second time. */
async function approveFresh(name: string, args: unknown, sessionId = SESSION) {
  const halt = await run(name, args, attended({ sessionId }));
  answerCard(recordHalt(halt, sessionId), 'approve', sessionId);
}
const provision = (args: unknown = {}, ctx: { sessionId?: string } = attended()) => withApproval('provision_hot_lead_call_number', args, ctx);
const release = (ctx: { sessionId?: string } = attended()) => withApproval('release_hot_lead_call_number', {}, ctx);
const start = (args: unknown = {}, ctx?: unknown) => run('start_hot_lead_call_verification', args, ctx);
const confirm = (code: unknown, ctx?: unknown, memberId?: string) => run('confirm_hot_lead_call_verification', { code, ...(memberId ? { memberId } : {}) }, ctx);
const SETUP_TOOLS = ['provision_hot_lead_call_number', 'release_hot_lead_call_number', 'start_hot_lead_call_verification', 'confirm_hot_lead_call_verification'];
const VALID_ARGS: Record<string, unknown> = { provision_hot_lead_call_number: { confirm: true }, release_hot_lead_call_number: {}, start_hot_lead_call_verification: {}, confirm_hot_lead_call_verification: { code: '123456' } };

const T0 = Date.parse('2026-10-19T12:00:00.000Z');
const MIN = 60_000;
const SID = 'PN' + 'b'.repeat(32);
const NEW_SID = 'PN' + 'c'.repeat(32);
const NEW_SID_2 = 'PN' + 'd'.repeat(32);
const NEW_NUMBER = '+14155550123';
const NEW_NUMBER_2 = '+14155550124';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stored verification state is deliberately replaced by malformed shapes in some tests
let org: Record<string, unknown> & { orgId: string; hotLeadCall?: Record<string, unknown>; hotLeadCallVerification?: Record<string, any> };
let fake: FakeVoiceProvider;
let writes: Array<{ updates: Record<string, unknown>; condition?: { expression: string } }>;
let beforeWrite: ((index: number) => void) | null;
let afterWriteThrows: Error | null;
// structuredClone/isDeepStrictEqual compare prototypes across jest's vm realm, so use JSON for the fake table.
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const logSpies: jest.SpyInstance[] = [];

// `verified` stamps the (only) member's verifiedAt and `phone` sets their phone; everything else is config.
const configured = ({ verified, phone, ...extra }: Record<string, unknown> = {}) => clone(storedConfigFixture(
  // Undefined overrides drop the caller number the shared config carries; withNumber adds it back.
  { enabled: false, twilioNumber: undefined, twilioNumberSid: undefined, ...extra },
  [teamMember(typeof phone === 'string' ? phone : '+14155550100', verified ? {} : { verifiedAt: undefined })],
));
const firstMember = () => (org.hotLeadCall as { team: Array<Record<string, unknown>> }).team[0];
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
const codeFromCall = (index = 0) => spokenCode(fake.placedCalls[index]);
const setTime = (ms: number) => jest.setSystemTime(ms);
const allLogs = () => logSpies.flatMap(s => s.mock.calls).map(c => c.map(String).join(' ')).join('\n');

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-not-real'; });
beforeEach(() => {
  // The consistent re-read (ENG-3152) answers what the indexed read answers in these tests.
  (userDb.getUserByIdConsistent as jest.Mock).mockImplementation((id: string) => (userDb.getUserById as jest.Mock)(id));
  jest.clearAllMocks();
  setHotLeadCallEntitledOverride(true);
  jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
  writes = [];
  beforeWrite = null;
  afterWriteThrows = null;
  org = { orgId: 'org-a', ownerUserId: 'owner', hotLeadCall: configured() };
  fake = new FakeVoiceProvider();
  setVoiceProviderForTests(fake);
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner', orgId: 'org-a', orgRole: 'owner' });
  installOrgDb();
  installChatDb();
  logSpies.splice(0, logSpies.length, ...(['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => undefined)));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  setVoiceProviderForTests(null);
  setHotLeadCallEntitledOverride(null);
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
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce({ userId: 'owner' }); // the consistent re-read also shows no org
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
    for (const name of SETUP_TOOLS) await expect(run(name, VALID_ARGS[name])).rejects.toThrow(/Save the hot lead call settings first \(update_hot_lead_call_settings\)/);
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
  it.each(['provision_hot_lead_call_number', 'release_hot_lead_call_number', 'start_hot_lead_call_verification'])('%s refuses an unattended run before touching anything', async name => {
    org.hotLeadCall = withNumber();
    await expect(run(name, VALID_ARGS[name], { userId: 'owner', isUnattendedRun: true })).rejects.toThrow('This needs a person to confirm in an interactive chat');
    expect(userDb.getUserById).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(fake.placedCalls.length + fake.boughtNumbers.length + fake.releasedNumbers.length).toBe(0);
  });
  it.each([false, undefined])('provision and start still work when isUnattendedRun is %s (only an explicit true is refused)', async flag => {
    org.hotLeadCall = withNumber();
    await expect(start({}, { userId: 'owner', isUnattendedRun: flag })).resolves.toMatchObject({ success: true });
    org.hotLeadCall = configured();
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    await expect(provision({ confirm: true }, attended({ isUnattendedRun: flag }))).resolves.toMatchObject({ success: true });
  });
  it('works while the platform kill switch is off, without consulting it', async () => {
    org.hotLeadCall = withNumber();
    await expect(start()).resolves.toMatchObject({ success: true });
    expect(isHotLeadCallEnabled).not.toHaveBeenCalled();
  });
  it('describes the approval card, that confirm authorizes nothing, the cost without a hard-coded price, and the irreversible release', () => {
    const buy = handlers.get('provision_hot_lead_call_number')!.definition.description;
    expect(buy).toMatch(/approval card/);
    expect(buy).toMatch(/confirm is ignored and authorizes nothing/);
    expect(buy).not.toMatch(/\$\d/);
    expect(handlers.get('release_hot_lead_call_number')!.definition.description).toMatch(/cannot be recovered/);
    expect(handlers.get('start_hot_lead_call_verification')!.definition.description).toMatch(/voicemail.*Twilio call log/);
  });
  it('does not expose the system fields or a phone argument on any setup tool', () => {
    for (const name of SETUP_TOOLS) {
      const props = Object.keys(handlers.get(name)!.definition.inputSchema.properties);
      for (const forbidden of ['to', 'phone', 'memberPhone', 'twilioNumber', 'twilioNumberSid', 'verifiedAt', 'team', 'orgId', 'userId']) expect(props).not.toContain(forbidden);
    }
  });
});

describe('provision_hot_lead_call_number', () => {
  it('refuses, before reserving or buying anything, when the org’s plan does not include hot lead calls', async () => {
    setHotLeadCallEntitledOverride(false);
    await expect(provision()).rejects.toThrow('not included in your organization’s current plan');
    expect(fake.boughtNumbers).toEqual([]);
    expect(writes).toEqual([]);
  });
  it.each(['41', '4155', 'abc', '41a', '', 415, ' 415'])('rejects area code %j before buying', async areaCode => {
    await expect(provision({ areaCode })).rejects.toThrow('areaCode must be exactly 3 digits');
    expect(fake.boughtNumbers).toEqual([]);
  });
  it('refuses when the org already has a number, or only a sid', async () => {
    org.hotLeadCall = withNumber();
    await expect(provision()).rejects.toThrow('already has a caller number');
    org.hotLeadCall = configured({ twilioNumberSid: SID });
    await expect(provision()).rejects.toThrow('already has a caller number');
    expect(fake.boughtNumbers).toEqual([]);
  });
  it('with no BACKEND_URL in a deployed environment, fails before reserving or buying anything', async () => {
    const saved = { url: process.env.BACKEND_URL, env: process.env.NODE_ENV };
    delete process.env.BACKEND_URL;
    Object.assign(process.env, { NODE_ENV: 'production' });
    try {
      await expect(provision({ confirm: true })).rejects.toThrow('BACKEND_URL');
    } finally {
      Object.assign(process.env, { NODE_ENV: saved.env });
      if (saved.url !== undefined) process.env.BACKEND_URL = saved.url;
    }
    expect(fake.boughtNumbers).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('buys a US number, stores it conditionally, meters the first month and reveals neither number nor sid', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    const result = await provision({ confirm: true, areaCode: '415' });
    // A new number is pointed at the inbound-callback endpoint at purchase.
    expect(fake.boughtNumbers).toEqual([{ countryCode: 'US', areaCode: '415', voiceUrl: 'http://localhost:3001/api/webhooks/twilio-voice/inbound' }]);
    expect(org.hotLeadCall).toMatchObject({ twilioNumber: NEW_NUMBER, twilioNumberSid: NEW_SID, enabled: false, team: [{ phone: '+14155550100' }] });
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
  it('charges the first month to the org owner even when an admin buys', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'a', orgId: 'org-a', orgRole: 'admin' });
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    await withApproval('provision_hot_lead_call_number', { confirm: true }, attended({ userId: 'a' }));
    expect((recordVendorUsage as jest.Mock).mock.calls[0][0].userId).toBe('owner');
  });
  it('falls back to the acting user, loudly, when the org has no owner', async () => {
    delete org.ownerUserId;
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'a', orgId: 'org-a', orgRole: 'admin' });
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    await withApproval('provision_hot_lead_call_number', { confirm: true }, attended({ userId: 'a' }));
    expect((recordVendorUsage as jest.Mock).mock.calls[0][0].userId).toBe('a');
    expect(allLogs()).toContain('has no owner');
  });
  it('omits areaCode when none is given and treats null as omitted', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    await provision({ confirm: true, areaCode: null });
    expect(fake.boughtNumbers).toEqual([{ countryCode: 'US', voiceUrl: 'http://localhost:3001/api/webhooks/twilio-voice/inbound' }]);
  });
  it('keeps verification and the enabled flag as they were', async () => {
    org.hotLeadCall = configured({ verified: true });
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    await provision();
    expect(org.hotLeadCall).toMatchObject({ team: [{ verifiedAt: VERIFIED_AT }], enabled: false });
  });

  it('two racing provisions reach Twilio once: the reservation is conditional, so the loser never buys', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    fake.queueBuyNumberResult({ numberSid: NEW_SID_2, phoneNumber: NEW_NUMBER_2 });
    const results = await Promise.allSettled([provision({}, attended()), provision({}, attended({ sessionId: 'sess-2' }))]);
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
  it('a rejecting rent meter cannot skip saving the number', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    (recordVendorUsage as jest.Mock).mockRejectedValueOnce(new Error('ledger down'));
    await expect(provision()).resolves.toMatchObject({ success: true });
    expect(org.hotLeadCall!.twilioNumberSid).toBe(NEW_SID);
    expect(allLogs()).toContain(`sid ${NEW_SID}`);
    expect(allLogs()).not.toContain('4155550123');
  });
  it('takes the unit and the price text from the rate card', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER });
    const halt = await run('provision_hot_lead_call_number', {}, attended());
    expect((halt as Halt).questionDeckPayload![0].question).toMatch(/\$1\.15 per month/);
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
    await approveFresh('provision_hot_lead_call_number', {});
    (orgDb.getOrgById as jest.Mock).mockResolvedValueOnce(clone(org)).mockRejectedValueOnce(new Error('db down'));
    await expect(run('provision_hot_lead_call_number', {}, attended())).rejects.toThrow('could not be confirmed');
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
  it('releases a purchased number that fails validation (here: equals a team phone) instead of storing it', async () => {
    fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: '+14155550100' });
    await expect(provision()).rejects.toThrow('was released');
    expect(fake.releasedNumbers).toEqual([NEW_SID]);
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumberSid');
  });
});

describe('release_hot_lead_call_number', () => {
  beforeEach(() => { org.hotLeadCall = withNumber({ enabled: true, verified: true }); });

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
    expect(org.hotLeadCall).toEqual(configured({ verified: true }));
    expect(result).toMatchObject({ success: true, callerNumberReleased: true, callingEnabled: false });
    expect(JSON.stringify(result)).not.toMatch(/4155550111|PN/);
  });
  it('re-reads with a consistent read after the disabling write, so a stale replica cannot fail the final write', async () => {
    const stale = clone(org);
    (orgDb.getOrgById as jest.Mock).mockImplementation(async (_id: string, _fields: unknown, consistent?: boolean) => clone(consistent ? org : stale));
    await release();
    expect(org.hotLeadCall).not.toHaveProperty('twilioNumberSid');
    expect(orgDb.getOrgById).toHaveBeenLastCalledWith('org-a', undefined, true);
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
    org.hotLeadCall = withNumber({ enabled: true, verified: true });
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

describe('human approval for provision and release', () => {
  const PROVISION = 'provision_hot_lead_call_number';
  const RELEASE = 'release_hot_lead_call_number';
  const ARGS: Record<string, unknown> = { [PROVISION]: { areaCode: '415' }, [RELEASE]: {} };
  const spent = () => fake.boughtNumbers.length + fake.releasedNumbers.length;
  const call = (name: string, ctx: Record<string, unknown> = attended()) => run(name, ARGS[name], ctx) as Promise<Halt & Record<string, unknown>>;
  // Provision needs an org without a number; release needs one with a number.
  const prepare = (name: string) => { org.hotLeadCall = name === PROVISION ? configured() : withNumber(); };

  describe.each([PROVISION, RELEASE])('%s', name => {
    beforeEach(() => { prepare(name); fake.queueBuyNumberResult({ numberSid: NEW_SID, phoneNumber: NEW_NUMBER }); });

    it('halts with an approval card on the first call and does not act', async () => {
      const result = await call(name);
      expect(result).toMatchObject({ success: true, awaitingUserConfirmation: true, type: 'ask_user_question', sessionId: SESSION });
      const [card] = result.questionDeckPayload as Array<Record<string, unknown>>;
      expect(card).toMatchObject({ allowEmmaDecide: false, immutable: true });
      expect(String(card.kind)).toMatch(new RegExp(`^hot_lead_call_approval:${name === PROVISION ? 'provision' : 'release'}:[0-9a-f]{64}:[0-9a-f]+$`));
      expect(spent()).toBe(0);
      expect(writes).toEqual([]);
      expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
    });
    it('states the monthly rent from the rate card on the card', async () => {
      expect(((await call(name)).questionDeckPayload![0]).question).toContain('$1.15 per month');
    });
    it('acts exactly once after the user approves, and a second call needs a new approval', async () => {
      answerCard(recordHalt(await call(name)), 'approve');
      const done = await call(name);
      expect(done).toMatchObject({ success: true });
      expect(done.awaitingUserConfirmation).toBeUndefined();
      expect(spent()).toBe(1);
      prepare(name);
      const again = await call(name);
      expect(again.awaitingUserConfirmation).toBe(true);
      expect(spent()).toBe(1);
    });
    it('refuses and does not act when the claim is lost', async () => {
      answerCard(recordHalt(await call(name)), 'approve');
      (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValueOnce(false);
      await expect(call(name)).rejects.toThrow('already used');
      expect(spent()).toBe(0);
    });
    it('claims the approval before acting and under the namespaced key', async () => {
      const halt = await call(name);
      answerCard(recordHalt(halt), 'approve');
      const order: string[] = [];
      (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockImplementationOnce(async () => { order.push('claim'); return true; });
      jest.spyOn(fake, 'buyNumber').mockImplementation(async () => { order.push('act'); return { numberSid: NEW_SID, phoneNumber: NEW_NUMBER }; });
      jest.spyOn(fake, 'releaseNumber').mockImplementation(async () => { order.push('act'); });
      await call(name);
      expect(order).toEqual(['claim', 'act']);
      expect((chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mock.calls[0]).toEqual([SESSION, `hotlead:${halt.questionDeckPayload![0].kind}`]);
    });
    it('does not act on a decline, a delegated answer, an unanswered card or an expired approval', async () => {
      const decline = recordHalt(await call(name)); answerCard(decline, 'decline');
      expect((await call(name)).awaitingUserConfirmation).toBe(true);
      sessions.clear();
      answerCard(recordHalt(await call(name)), 'approve', SESSION, { answeredBy: 'delegation' });
      expect((await call(name)).awaitingUserConfirmation).toBe(true);
      sessions.clear();
      recordHalt(await call(name));
      expect((await call(name)).awaitingUserConfirmation).toBe(true);
      sessions.clear();
      answerCard(recordHalt(await call(name)), 'approve', SESSION, { at: new Date(T0 - 16 * MIN).toISOString() });
      expect((await call(name)).awaitingUserConfirmation).toBe(true);
      expect(spent()).toBe(0);
    });
    it('does not accept an approval given in another chat session (a branched session starts without one)', async () => {
      answerCard(recordHalt(await call(name), 'sess-old'), 'approve', 'sess-old');
      expect((await call(name, attended({ sessionId: 'sess-new' }))).awaitingUserConfirmation).toBe(true);
      expect(spent()).toBe(0);
    });
    it('does not accept an approval that was given for a different user', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'admin2', orgId: 'org-a', orgRole: 'admin' });
      answerCard(recordHalt(await call(name, attended({ userId: 'admin2' }))), 'approve');
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner', orgId: 'org-a', orgRole: 'owner' });
      expect((await call(name)).awaitingUserConfirmation).toBe(true);
    });
    it('ignores confirm:true: it never acts without an approved card', async () => {
      const args = name === PROVISION ? { confirm: true } : {};
      const result = await run(name, args, attended());
      expect((result as Halt).awaitingUserConfirmation).toBe(true);
      expect(spent()).toBe(0);
    });
    it.each([
      ['an unattended run', { isUnattendedRun: true }, 'This needs a person to confirm'],
      ['a delegated (support) session', { isDelegatedAccess: true }, 'customer in their own chat'],
      ['a delegated admin session', { isDelegatedAdmin: true }, 'customer in their own chat'],
      ['a call without a chat session', { sessionId: undefined }, 'attended chat session'],
    ])('refuses %s without showing a card', async (_label, extra, message) => {
      await expect(call(name, attended(extra))).rejects.toThrow(message);
      expect(spent()).toBe(0);
    });
    it('refuses a scheduled session without showing a card', async () => {
      sessionOf(SESSION).sessionType = 'scheduled';
      await expect(call(name)).rejects.toThrow('not a scheduled run');
      expect(spent()).toBe(0);
    });
    it('refuses when the session cannot be read', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockRejectedValueOnce(new Error('db down'));
      await expect(call(name)).rejects.toThrow('could not be read');
    });
    it('refuses a non-admin caller before any card is shown', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'm', orgId: 'org-a', orgRole: 'member' });
      await expect(call(name, attended({ userId: 'm' }))).rejects.toThrow('owners and admins');
      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
    });
    it('refuses missing settings before any card is shown', async () => {
      delete org.hotLeadCall;
      await expect(call(name)).rejects.toThrow('Save the hot lead call settings first');
      expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
    });
  });

  it('refuses an org without the entitlement before any card is shown', async () => {
    prepare(PROVISION);
    setHotLeadCallEntitledOverride(false);
    await expect(call(PROVISION)).rejects.toThrow('not included');
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
  });
  it('reads the history consistently: a newer card the default read has not seen yet still stops the purchase', async () => {
    prepare(PROVISION);
    const first = await call(PROVISION);
    answerCard(recordHalt(first), 'approve');
    // Only the newer halt is added, with no reply. The stale default read drops this newest message and would
    // show the older, unused approval; the consistent read sees an unanswered newer card.
    const newerKind = String(first.questionDeckPayload![0].kind).replace(/:[0-9a-f]+$/, ':newer');
    sessionOf(SESSION).messages.push(deckHalt(newerKind, 'deck-newer'));
    expect((await call(PROVISION)).awaitingUserConfirmation).toBe(true);
    expect(fake.boughtNumbers).toEqual([]);
    expect(chatbotDb.getChatSession).toHaveBeenCalledWith(SESSION, true);
  });
  it('an approval for one area code does not buy another', async () => {
    prepare(PROVISION);
    answerCard(recordHalt(await call(PROVISION)), 'approve');
    const other = await run(PROVISION, { areaCode: '212' }, attended());
    expect((other as Halt).awaitingUserConfirmation).toBe(true);
    expect(fake.boughtNumbers).toEqual([]);
  });
  it('an approval does not survive a change of the stored settings', async () => {
    prepare(PROVISION);
    answerCard(recordHalt(await call(PROVISION)), 'approve');
    org.hotLeadCall = configured({ maxCallsPerHour: 3 });
    expect((await call(PROVISION)).awaitingUserConfirmation).toBe(true);
    expect(fake.boughtNumbers).toEqual([]);
  });
  it('does not show a card when the org already has a number (provision) or has none (release)', async () => {
    org.hotLeadCall = withNumber();
    await expect(call(PROVISION)).rejects.toThrow('already has a caller number');
    org.hotLeadCall = configured();
    await expect(call(RELEASE)).rejects.toThrow('no caller number');
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
  });
  it('does not gate verification or confirm: they still run without a card', async () => {
    org.hotLeadCall = withNumber();
    await expect(start({}, attended())).resolves.toMatchObject({ success: true });
  });
  it('a release approval cannot be used to buy', async () => {
    prepare(RELEASE);
    answerCard(recordHalt(await call(RELEASE)), 'approve');
    prepare(PROVISION);
    expect((await call(PROVISION)).awaitingUserConfirmation).toBe(true);
  });
});

describe('human approval for turning calling on', () => {
  const UPDATE = 'update_hot_lead_call_settings';
  const ENABLE = { enabled: true };
  const call = (args: unknown = ENABLE, ctx: Record<string, unknown> = attended()) => run(UPDATE, args, ctx) as Promise<Halt & Record<string, unknown>>;
  const isOn = () => (org.hotLeadCall as { enabled: boolean }).enabled;
  beforeEach(() => { org.hotLeadCall = withNumber({ verified: true }); });

  it('halts with an approval card that says what turning calling on does, and does not enable', async () => {
    const result = await call();
    expect(result).toMatchObject({ success: true, awaitingUserConfirmation: true, type: 'ask_user_question', sessionId: SESSION });
    const [card] = result.questionDeckPayload as Array<{ kind: string; question: string; options: Array<{ id: string }>; allowEmmaDecide: boolean; immutable: boolean }>;
    expect(card).toMatchObject({ allowEmmaDecide: false, immutable: true });
    expect(card.kind).toMatch(/^hot_lead_call_approval:enable:[0-9a-f]{64}:[0-9a-f]+$/);
    expect(card.options.map(o => o.id)).toEqual(['decline', 'approve']);
    expect(card.question).toContain('lead arrives from your landing page');
    expect(card.question).toContain('Dana Lee (***0100)');
    expect(card.question).toContain('from your number ***0111');
    expect(card.question).toContain('Both calls are billed to the organization owner per minute at the current rate of $0.014 per minute, each rounded up to a whole minute');
    expect(card.question).toContain('6 leads per hour, 20 per day, 200 per month, at most 3 call attempts per lead, only 08:00-21:00 America/Chicago');
    expect(card.question).toContain('turn it off at any time');
    expect(card.question).not.toMatch(/4155550100|4155550111/);
    expect(isOn()).toBe(false);
    expect(writes).toEqual([]);
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
  });
  it('builds identical cards for identical calls in one reply (same kind but for the nonce), and another card for another change', async () => {
    const [first, second, other] = [await call(), await call(), await call({ enabled: true, maxCallsPerHour: 3 })];
    const prefixOf = (halt: Halt) => halt.questionDeckPayload![0].kind.replace(/:[0-9a-f]+$/, '');
    expect(prefixOf(first)).toBe(prefixOf(second));
    expect(prefixOf(other)).not.toBe(prefixOf(first));
  });
  it('a second identical call after the first one enabled succeeds without a card or another approval', async () => {
    answerCard(recordHalt(await call()), 'approve');
    await call();
    const again = await call();
    expect(again).toMatchObject({ success: true, enabled: true });
    expect(again.awaitingUserConfirmation).toBeUndefined();
    expect(chatbotDb.claimMetaWriteManifestDigest).toHaveBeenCalledTimes(1);
  });
  it('names every verified member, also with an apostrophe, ampersand or accent in the name', async () => {
    org.hotLeadCall = withNumber({ team: [
      teamMember('+14155550100', { name: "Dana O'Neil & Sons" }),
      teamMember('+14155550122', { id: 'mzzzzzz2', name: 'José Núñez' }),
    ] });
    expect((await call()).questionDeckPayload![0].question).toContain("Dana O'Neil & Sons (***0100), José Núñez (***0122)");
  });
  it('shows the caps that will be in force, including the ones sent in the same call', async () => {
    org.hotLeadCall = withNumber({ verified: true, maxCallsPerDay: 9, maxAttemptsPerLead: 2 });
    expect((await call({ enabled: true, maxCallsPerHour: 3 })).questionDeckPayload![0].question).toContain('3 leads per hour, 9 per day, 200 per month, at most 2 call attempts per lead');
  });
  it('uses a different digest when a stored cap differs', async () => {
    const digestOf = async () => String((await call()).questionDeckPayload![0].kind).split(':')[2];
    const before = await digestOf();
    org.hotLeadCall = withNumber({ verified: true, maxCallsPerDay: 9 });
    expect(await digestOf()).not.toBe(before);
  });
  it('enables with exactly the approved patch when the same call also changes a cap', async () => {
    const args = { enabled: true, maxCallsPerHour: 3 };
    answerCard(recordHalt(await call(args)), 'approve');
    await expect(call(args)).resolves.toMatchObject({ success: true, enabled: true, maxCallsPerHour: 3 });
    expect(writes).toHaveLength(1);
    expect(writes[0].updates.hotLeadCall).toEqual(withNumber({ verified: true, enabled: true, maxCallsPerHour: 3 }));
  });
  it('reuses the approval when the same patch comes with its keys in another order', async () => {
    answerCard(recordHalt(await call({ enabled: true, maxCallsPerHour: 3 })), 'approve');
    await expect(call({ maxCallsPerHour: 3, enabled: true })).resolves.toMatchObject({ enabled: true });
    expect(isOn()).toBe(true);
  });
  it('names only the verified members, the ones that can be called', async () => {
    org.hotLeadCall = withNumber({ team: [teamMember('+14155550100'), teamMember('+14155550122', { id: 'mzzzzzz2', name: 'Sam Ortiz', verifiedAt: undefined })] });
    const question = (await call()).questionDeckPayload![0].question;
    expect(question).toContain('Dana Lee (***0100)');
    expect(question).not.toContain('Sam Ortiz');
  });
  it('enables only on the call after the user approved, claiming the approval first under the namespaced key', async () => {
    const halt = await call();
    answerCard(recordHalt(halt), 'approve');
    await expect(call()).resolves.toMatchObject({ success: true, enabled: true });
    expect(isOn()).toBe(true);
    expect(writes).toHaveLength(1);
    expect((chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mock.calls).toEqual([[SESSION, `hotlead:${halt.questionDeckPayload![0].kind}`]]);
  });
  it('is single use: after calling was switched off again, enabling needs a new card', async () => {
    answerCard(recordHalt(await call()), 'approve');
    await call();
    await expect(call({ enabled: false })).resolves.toMatchObject({ enabled: false });
    expect((await call()).awaitingUserConfirmation).toBe(true);
    expect(isOn()).toBe(false);
  });
  it('refuses and does not enable when the claim is lost', async () => {
    answerCard(recordHalt(await call()), 'approve');
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValueOnce(false);
    await expect(call()).rejects.toThrow('already used');
    expect(isOn()).toBe(false);
    expect(writes).toEqual([]);
  });
  it('does not enable on a decline, a delegated answer, an unanswered card or an expired approval', async () => {
    answerCard(recordHalt(await call()), 'decline');
    expect((await call()).awaitingUserConfirmation).toBe(true);
    sessions.clear();
    answerCard(recordHalt(await call()), 'approve', SESSION, { answeredBy: 'delegation' });
    expect((await call()).awaitingUserConfirmation).toBe(true);
    sessions.clear();
    recordHalt(await call());
    expect((await call()).awaitingUserConfirmation).toBe(true);
    sessions.clear();
    answerCard(recordHalt(await call()), 'approve', SESSION, { at: new Date(T0 - 16 * MIN).toISOString() });
    expect((await call()).awaitingUserConfirmation).toBe(true);
    expect(isOn()).toBe(false);
    expect(writes).toEqual([]);
  });
  it('does not accept an approval given in another chat session', async () => {
    answerCard(recordHalt(await call(ENABLE, attended({ sessionId: 'sess-old' })), 'sess-old'), 'approve', 'sess-old');
    expect((await call(ENABLE, attended({ sessionId: 'sess-new' }))).awaitingUserConfirmation).toBe(true);
    expect(isOn()).toBe(false);
  });
  it('needs a new card when the stored settings changed between the card and the click', async () => {
    answerCard(recordHalt(await call()), 'approve');
    org.hotLeadCall = withNumber({ verified: true, maxCallsPerHour: 3 });
    expect((await call()).awaitingUserConfirmation).toBe(true);
    expect(isOn()).toBe(false);
  });
  it('needs a new card when the same call carries other settings than the approved one', async () => {
    answerCard(recordHalt(await call()), 'approve');
    expect((await call({ enabled: true, maxCallsPerHour: 3 })).awaitingUserConfirmation).toBe(true);
    expect(isOn()).toBe(false);
  });
  it('does not accept an approval for another action', async () => {
    org.hotLeadCall = withNumber({ verified: true });
    answerCard(recordHalt(await run('release_hot_lead_call_number', {}, attended())), 'approve');
    expect((await call()).awaitingUserConfirmation).toBe(true);
  });
  it.each([
    ['an unattended run', { isUnattendedRun: true }, 'interactive chat'],
    ['a delegated (support) session', { isDelegatedAccess: true }, 'customer in their own chat'],
    ['a call without a chat session', { sessionId: undefined }, 'attended chat session'],
  ])('refuses %s without showing a card', async (_label, extra, message) => {
    await expect(call(ENABLE, attended(extra))).rejects.toThrow(message);
    expect(isOn()).toBe(false);
  });
  it('refuses an unattended run before the session is even read', async () => {
    await call(ENABLE, attended({ isUnattendedRun: true })).catch(() => undefined);
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
  });
  it.each([
    ['plan does not include hot lead calls', () => setHotLeadCallEntitledOverride(false), 'not included'],
    ['no verified member', () => { org.hotLeadCall = withNumber(); }, 'Verify the phone'],
    ['no caller number', () => { org.hotLeadCall = configured({ verified: true }); }, 'phone number for calls'],
  ])('refuses, before any card, when %s', async (_label, arrange, message) => {
    arrange();
    await expect(call()).rejects.toThrow(message);
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
  });
  it('does not gate turning calling off, other edits, lowering limits, or enabled:true on a setup that is already on', async () => {
    org.hotLeadCall = withNumber({ verified: true, enabled: true });
    await expect(call({ maxCallsPerHour: 3 })).resolves.toMatchObject({ maxCallsPerHour: 3, enabled: true });
    await expect(call(ENABLE)).resolves.toMatchObject({ enabled: true });
    await expect(call({ enabled: false })).resolves.toMatchObject({ enabled: false });
    await expect(call({ maxCallsPerHour: 2, announcedName: 'Other Co' })).resolves.toMatchObject({ enabled: false, maxCallsPerHour: 2 });
    expect(writes).toHaveLength(4);
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
  });
});

describe('start_hot_lead_call_verification', () => {
  beforeEach(() => { org.hotLeadCall = withNumber(); });

  it('refuses, before placing a call, when the org’s plan does not include hot lead calls', async () => {
    setHotLeadCallEntitledOverride(false);
    await expect(start()).rejects.toThrow('not included in your organization’s current plan');
    expect(fake.placedCalls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('needs a provisioned caller number and places no call without one', async () => {
    org.hotLeadCall = configured();
    await expect(start()).rejects.toThrow('Provision a caller number first (provision_hot_lead_call_number)');
    expect(fake.placedCalls).toEqual([]);
    expect(writes).toEqual([]);
  });
  it.each([[{ to: '+14155550199' }], [{ memberPhone: '+14155550199' }], [{ phone: '+14155550199' }]])('never takes a number from arguments (%j)', async args => {
    await expect(start(args)).rejects.toThrow('Invalid');
    expect(fake.placedCalls).toEqual([]);
  });

  it('places one call to the stored member phone from the caller number with inline TwiML and stores only a hash', async () => {
    const result = await start();
    expect(fake.placedCalls).toHaveLength(1);
    const call = fake.placedCalls[0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ to: '+14155550100', from: '+14155550111', timeoutSeconds: 30 });
    expect(call).not.toHaveProperty('url');
    expect(call).not.toHaveProperty('statusCallbackUrl');
    const code = codeFromCall();
    expect(call.twiml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?><Response><Pause length="1"\/><Say>Your Agent Web verification code is (\d \d \d \d \d \d)\. Again, your code is \1\. Goodbye\.<\/Say><\/Response>$/);
    expect(Object.keys(org.hotLeadCallVerification!.members)).toEqual([MEMBER_ID]);
    expect(org.hotLeadCallVerification!.orgStartedAt).toEqual([T0]);
    const record = org.hotLeadCallVerification!.members[MEMBER_ID];
    expect(record).toMatchObject({ phone: '+14155550100', expiresAt: T0 + 10 * MIN, attempts: 0, callSid: 'CA00000001', startedAt: [T0] });
    expect(record.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(record).sort()).toEqual(['attempts', 'callSid', 'codeHash', 'expiresAt', 'phone', 'startedAt']);
    expect(Object.values(record)).not.toContain(code);
    expect(result).toMatchObject({ success: true, memberId: MEMBER_ID, memberPhone: '***0100', expiresInSeconds: 600, nextStartAllowedInSeconds: 120, startsLeftToday: 4, maxAttempts: 5 });
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
    expect(org.hotLeadCallVerification!.members[MEMBER_ID].startedAt).toHaveLength(5);
  });
  it('a restart replaces the code and resets attempts, but not the rate history', async () => {
    await start();
    const first = codeFromCall(0);
    await expect(confirm(wrongCode(first))).rejects.toThrow('not correct');
    setTime(T0 + 3 * MIN);
    await start();
    expect(org.hotLeadCallVerification!.members[MEMBER_ID]).toMatchObject({ attempts: 0, startedAt: [T0, T0 + 3 * MIN], expiresAt: T0 + 13 * MIN });
  });
  it('fails closed on a corrupt stored record instead of replacing it (which would reset the limits)', async () => {
    org.hotLeadCallVerification = { garbage: true };
    await expect(start()).rejects.toThrow('Contact support');
    expect(fake.placedCalls).toEqual([]);
    expect(org.hotLeadCallVerification).toEqual({ garbage: true });
  });
  it('hashes the code under a labelled HMAC bound to org, phone and code (known answer)', async () => {
    jest.spyOn(crypto, 'randomInt').mockImplementation((() => 123456) as unknown as typeof crypto.randomInt);
    await start();
    const expected = crypto.createHmac('sha256', 'test-secret-not-real').update('hlc-verify-v2\x00org-a\x00maaaaaaa\x00+14155550100\x00123456').digest('hex');
    expect(org.hotLeadCallVerification!.members[MEMBER_ID].codeHash).toBe(expected);
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

  it('verifies, writes the member’s verifiedAt, clears the pending record and keeps other settings', async () => {
    await start();
    const code = codeFromCall();
    setTime(T0 + MIN);
    const result = await confirm(code);
    expect(org.hotLeadCall).toEqual(withNumber({ team: [teamMember('+14155550100', { verifiedAt: new Date(T0 + MIN).toISOString() })] }));
    expect(org.hotLeadCallVerification).toEqual({ members: { [MEMBER_ID]: { phone: '+14155550100', codeHash: null, expiresAt: 0, attempts: 0, startedAt: [T0] } }, orgStartedAt: [T0] });
    expect(result).toMatchObject({ success: true, memberVerified: true, memberId: MEMBER_ID, memberPhone: '***0100', verifiedAt: new Date(T0 + MIN).toISOString() });
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
  it('lets the org admin enable calling afterwards through the existing settings tool', async () => {
    await start();
    await confirm(codeFromCall());
    await expect(withApproval('update_hot_lead_call_settings', { enabled: true })).resolves.toMatchObject({ enabled: true, team: [{ verified: true }] });
  });
  it('a confirm does not reset the start history: alternating phones cannot dodge the gap or the daily cap', async () => {
    await start();
    await confirm(codeFromCall());
    setTime(T0 + MIN);
    await expect(start()).rejects.toThrow('just placed');
    const phones = ['+16475550123', '+14155550100'];
    for (let i = 1; i <= 4; i++) {
      setTime(T0 + 2 * i * MIN);
      firstMember().phone = phones[i % 2];
      delete firstMember().verifiedAt;
      await start();
      await confirm(codeFromCall(i));
    }
    firstMember().phone = '+16475550123';
    setTime(T0 + 12 * MIN);
    await expect(start()).rejects.toThrow('limit of 5');
    expect(fake.placedCalls).toHaveLength(5);
  });
  it('a hash issued for one org or phone does not verify under another (the MAC binds both)', async () => {
    await start();
    const code = codeFromCall();
    const record = clone(org.hotLeadCallVerification)!;
    org.hotLeadCall = withNumber({ phone: '+16475550123' });
    org.hotLeadCallVerification = { ...record, members: { [MEMBER_ID]: { ...record.members[MEMBER_ID], phone: '+16475550123' } } };
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
    expect(firstMember().verifiedAt).toBeUndefined();
  });
  it('parallel guesses cannot exceed the attempt budget: only one concurrent confirm is counted', async () => {
    await start();
    const code = codeFromCall();
    const results = await Promise.allSettled([confirm(wrongCode(code)), confirm(wrongCode(code)), confirm(wrongCode(code))]);
    expect(org.hotLeadCallVerification!.members[MEMBER_ID].attempts).toBe(1);
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
  it('refuses when the member’s phone changed between start and confirm, and never verifies the new phone', async () => {
    await start();
    const code = codeFromCall();
    org.hotLeadCall = withNumber({ phone: '+16475550123' });
    await expect(confirm(code)).rejects.toThrow('different phone');
    expect(firstMember().verifiedAt).toBeUndefined();
  });
  it('refuses when the settings change between the check and the write (conditional write)', async () => {
    await start();
    const code = codeFromCall();
    writes.length = 0;
    beforeWrite = i => { if (i === 1) org.hotLeadCall = withNumber({ phone: '+16475550123' }); };
    await expect(confirm(code)).rejects.toThrow('settings changed');
    expect(firstMember().verifiedAt).toBeUndefined();
    expect(firstMember().phone).toBe('+16475550123');
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
    await expect(confirm(wrongCode(codeFromCall()))).rejects.toThrow('That code is not correct');
    await confirm(codeFromCall());
    await release();
    expect(writes.length).toBeGreaterThanOrEqual(6);
    for (const w of writes) expect(w.condition?.expression).toMatch(/attribute_not_exists|#previous\w+ = :previous\w+/);
  });
  it('no setup tool ever writes the system fields from arguments: update_hot_lead_call_settings still refuses them', async () => {
    await expect(run('update_hot_lead_call_settings', { verifiedAt: '2026-02-02T00:00:00.000Z' })).rejects.toThrow('settings arguments');
  });
});

describe('verification on a team of several members', () => {
  const SECOND_ID = 'mzzzzzz2';
  const SECOND_PHONE = '+14155550122';
  beforeEach(() => {
    org.hotLeadCall = withNumber({ team: [teamMember('+14155550100', { verifiedAt: undefined }), teamMember(SECOND_PHONE, { id: SECOND_ID, name: 'Sam Ortiz', verifiedAt: undefined })] });
  });
  const teamOf = () => (org.hotLeadCall as { team: Array<Record<string, unknown>> }).team;

  it('refuses to start without a memberId and places no call', async () => {
    await expect(start()).rejects.toThrow('say which one to verify');
    expect(fake.placedCalls).toEqual([]);
    expect(writes).toEqual([]);
  });
  it('refuses an unknown memberId', async () => {
    await expect(start({ memberId: 'mnobody0' })).rejects.toThrow('does not exist');
    expect(fake.placedCalls).toEqual([]);
  });
  it.each(['MABCDEFG', 'm123', 'x1234567', 5])('rejects a malformed memberId %j', async memberId => {
    await expect(start({ memberId })).rejects.toThrow('Invalid');
  });
  it('rings the chosen member and verifies only that member', async () => {
    const started = await start({ memberId: SECOND_ID });
    expect(fake.placedCalls[0]).toMatchObject({ to: SECOND_PHONE });
    expect(started).toMatchObject({ memberId: SECOND_ID, memberPhone: '***0122' });
    setTime(T0 + MIN);
    await expect(confirm(codeFromCall(), undefined, SECOND_ID)).resolves.toMatchObject({ memberVerified: true, memberId: SECOND_ID });
    expect(teamOf()[0].verifiedAt).toBeUndefined();
    expect(teamOf()[1].verifiedAt).toBe(new Date(T0 + MIN).toISOString());
  });
  it('refuses to confirm without a memberId on a larger team', async () => {
    await start({ memberId: SECOND_ID });
    await expect(confirm(codeFromCall())).rejects.toThrow('say which one to verify');
    expect(teamOf()[1].verifiedAt).toBeUndefined();
  });
  it('does not let a code sent to one member verify another', async () => {
    await start({ memberId: SECOND_ID });
    const code = codeFromCall();
    await expect(confirm(code, undefined, MEMBER_ID)).rejects.toThrow('No verification is in progress');
    expect(teamOf().every(m => m.verifiedAt === undefined)).toBe(true);
  });
});

describe('hot lead calls add-on (ENG-2783)', () => {
  const UPDATE = 'update_hot_lead_call_settings';
  const PRICE = '$70 per month, includes one calling number and 150 lead calls per month, billed to your subscription';
  const call = (args: unknown = { enabled: true }) => run(UPDATE, args, attended()) as Promise<Halt & Record<string, unknown>>;
  const isOn = () => (org.hotLeadCall as { enabled: boolean }).enabled;
  const card = (halt: Halt) => halt.questionDeckPayload![0];
  beforeEach(() => {
    process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
    (isHotLeadCallEnabled as jest.Mock).mockResolvedValue(true);
    org.hotLeadCall = withNumber({ verified: true });
  });
  afterEach(() => { delete process.env.HOT_LEAD_CALL_BILLING_REQUIRED; });

  it('states the $70 price on the card, binds it into the digest, and buys nothing before approval', async () => {
    const halt = await call();
    expect(card(halt).question).toContain(PRICE);
    expect(card(halt).question).not.toContain('per minute');
    expect(addHotLeadCallBilling).not.toHaveBeenCalled();
    // Without the requirement the same call yields a different digest (the per-minute price), so a price change needs a new card.
    delete process.env.HOT_LEAD_CALL_BILLING_REQUIRED;
    const digestOf = (h: Halt) => card(h).kind.split(':')[2];
    expect(digestOf(await call())).not.toBe(digestOf(halt));
  });
  it('adds the add-on only after approval, then turns calling on', async () => {
    answerCard(recordHalt(await call()), 'approve');
    await expect(call()).resolves.toMatchObject({ success: true, enabled: true });
    expect(addHotLeadCallBilling).toHaveBeenCalledWith('org-a');
    expect(isOn()).toBe(true);
  });
  it('leaves calling off when Stripe refuses', async () => {
    (addHotLeadCallBilling as jest.Mock).mockRejectedValue(new HotLeadCallBillingError('card declined, nothing turned on'));
    answerCard(recordHalt(await call()), 'approve');
    await expect(call()).rejects.toThrow('nothing turned on');
    expect(isOn()).toBe(false);
    expect(writes).toEqual([]);
  });
  it('asks nothing extra and buys nothing when the add-on is already active', async () => {
    org.hotLeadCallBilling = { itemId: 'si_1', status: 'active', updatedAt: '2026-11-13T00:00:00.000Z' };
    const halt = await call();
    // The wording follows the billing model, not whether a purchase is needed: no per-minute terms, no new charge.
    expect(card(halt).question).toContain('already covers these calls');
    expect(card(halt).question).not.toContain('per minute');
    expect(JSON.stringify(card(halt).options)).not.toContain('Adds the add-on');
    answerCard(recordHalt(halt), 'approve');
    await call();
    expect(addHotLeadCallBilling).not.toHaveBeenCalled();
  });
  it('an approval given while the add-on was active does not authorize buying it if it lapses before the answer', async () => {
    org.hotLeadCallBilling = { itemId: 'si_1', status: 'active', updatedAt: '2026-11-13T00:00:00.000Z' };
    answerCard(recordHalt(await call()), 'approve'); // card said: already covered
    org.hotLeadCallBilling = { itemId: 'si_1', status: 'canceled', updatedAt: '2026-11-13T01:00:00.000Z' };
    const halt = await call();                        // now a purchase is needed: a new card, nothing bought
    expect(card(halt).question).toContain('This costs');
    expect(addHotLeadCallBilling).not.toHaveBeenCalled();
  });
  it('does not sell the add-on while the global calling switch is off: no card, no charge', async () => {
    (isHotLeadCallEnabled as jest.Mock).mockResolvedValue(false);
    await expect(call()).rejects.toThrow(/not open for your organization yet/);
    expect(addHotLeadCallBilling).not.toHaveBeenCalled();
    expect(isOn()).toBe(false);
  });
  it('looks at the switch again after the approval, right before charging', async () => {
    answerCard(recordHalt(await call()), 'approve');
    (isHotLeadCallEnabled as jest.Mock).mockResolvedValue(false); // turned off while the card was open
    await expect(call()).rejects.toThrow(/not open for your organization yet/);
    expect(addHotLeadCallBilling).not.toHaveBeenCalled();
    expect(isOn()).toBe(false);
  });
  it('does not block an org that already has the add-on from enabling while the switch is off', async () => {
    (isHotLeadCallEnabled as jest.Mock).mockResolvedValue(false);
    org.hotLeadCallBilling = { itemId: 'si_1', status: 'active', updatedAt: '2026-11-13T00:00:00.000Z' };
    expect(card(await call()).question).toContain('already covers these calls');
  });
  it('the number card says the rent is part of the $70 price', async () => {
    org.hotLeadCall = configured({ verified: true });
    const halt = (await run('provision_hot_lead_call_number', {}, attended())) as Halt;
    expect(card(halt).question).toContain('this rent is part of that price');
  });
});
