jest.mock('../services/db', () => ({
  ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS,
  crmDb: { getLeadListById: jest.fn(), getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/subscriptionService', () => ({
  SUBSCRIPTION_FEATURES: { HOT_LEAD_CALL: 'hot_lead_call' },
  getUserSubscriptionResolution: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
}));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(),
  startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/emailService', () => ({ emailService: { sendEmail: jest.fn(), escapeHtml: (t: string) => t } }));
/** A lead's consent record bound to ITS number (ENG-2783): a lead copy with another phone must carry consent for that phone. */
const consentFor = (phone: string) => ({ callConsent: callConsentRecord({ phoneDigits: phone.replace(/\D/g, '').replace(/^(\d{10})$/, '1$1') }) });
const callerless = { on: false };
jest.mock('../services/voice/hotLeadCallContext', () => ({
  resolveHotLeadCallContext: async (listId: string) => {
    const ctx = await jest.requireActual('../services/voice/hotLeadCallContext').resolveHotLeadCallContext(listId);
    // The validator guarantees a caller number on an enabled config; this simulates that guarantee breaking.
    return ctx && callerless.on ? { ...ctx, config: { ...ctx.config, twilioNumber: undefined } } : ctx;
  },
}));
import * as leadLocalHours from '../services/voice/leadLocalHours';
import * as capNotices from '../services/voice/hotLeadCallCapNotices';
import { crmDb, userDb, orgDb } from '../services/db';
import * as queue from '../services/asyncJobQueue';
import { emailService } from '../services/emailService';
import { getSubscriptionTypeConfig, getUserSubscriptionResolution } from '../services/subscriptionService';
import { dispatchHotLeadCall, processHotLeadCallJob, registerHotLeadCallProcessor } from '../services/hotLeadCallService';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { setLeadCallStoreForTests } from '../services/voice/leadCallStore';
import { FakeLimitStore } from './helpers/fakeLimitStore';
import { setLimitStoreForTests } from '../services/voice/limitStore';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { FakeLeadCallStore } from './helpers/fakeLeadCallStore';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
import { dncKey, isNumberDoNotCall, markNumberDoNotCall } from '../services/voice/hotLeadCallDnc';
import { teamMember, callRecord, callConsentRecord, MEMBER_ID } from './helpers/hotLeadCallFixtures';

const mock = (fn: unknown) => fn as jest.Mock;
const MEMBER_PHONE = '+14155550100';
const TWILIO_NUMBER = '+14155550111';
const LEAD_PHONE = '(212) 555-0142';
const NOW = '2026-10-19T17:00:00.000Z';

const config = {
  enabled: true, team: [teamMember(MEMBER_PHONE)],
  twilioNumber: TWILIO_NUMBER, announcedName: 'Acme Plumbing',
  callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};

let provider: FakeVoiceProvider;
let store: FakeLeadCallStore;
let limits: FakeLimitStore;
let lead: Record<string, unknown>;
let org: Record<string, unknown>;
const submission = { submissionId: 'sub-1', submittedAt: NOW };

const jobOf = (extra: Record<string, unknown> = {}) => ({ orgId: 'org-a', listId: 'list-a', leadId: 'lead-a', origin: 'form_fill' as const, ...extra });
const enqueueCalls = () => mock(queue.enqueueJob).mock.calls;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.setSystemTime(new Date(NOW));
  process.env.BACKEND_URL = 'https://api.example.com';
  callerless.on = false;
  setHotLeadCallEnabledOverride(true);
  setHotLeadCallEntitledOverride(true);
  provider = new FakeVoiceProvider();
  setVoiceProviderForTests(provider);
  store = new FakeLeadCallStore();
  setLeadCallStoreForTests(store);
  limits = new FakeLimitStore();
  setLimitStoreForTests(limits);
  process.env.JWT_SECRET = 'test-secret';
  lead = { listId: 'list-a', leadId: 'lead-a', phone: LEAD_PHONE, email: 'jane@example.com', createdAt: '2026-10-19T16:58:00.000Z', customFields: { stage: 'complete' }, system: { callConsent: callConsentRecord() } };
  org = { orgId: 'org-a', hotLeadCall: config };
  mock(crmDb.getLeadListById).mockResolvedValue({ listId: 'list-a', userId: 'owner-a' });
  mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-a' });
  mock(orgDb.getOrgById).mockImplementation(async () => org);
  mock(crmDb.getLeadById).mockImplementation(async () => lead);
  mock(queue.enqueueJob).mockResolvedValue('enqueued');
  mock(queue.startHeartbeat).mockReturnValue(jest.fn());
});
afterEach(() => {
  jest.useRealTimers();
  setHotLeadCallEnabledOverride(null);
  setHotLeadCallEntitledOverride(null);
  setVoiceProviderForTests(null);
  setLeadCallStoreForTests(null);
  setLimitStoreForTests(null);
});

describe('dispatchHotLeadCall gates', () => {
  it('places the member call for an eligible form fill (control for every refusal below)', async () => {
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'member_ringing', memberCallSid: 'CA00000001' });
    expect(store.eventTypes()).toEqual(['call.initiated']);
    expect(queue.markJobComplete).toHaveBeenCalledTimes(1);
  });

  const silent: Array<[string, () => void, ('form_fill' | 'manual' | 'none')?]> = [
    ['mode off', () => setHotLeadCallEnabledOverride(false)],
    ['origin missing', () => undefined, 'none'],
    ['origin not form_fill', () => undefined, 'manual'],
    ['org has no config', () => { delete org.hotLeadCall; }],
    ['config disabled', () => { org.hotLeadCall = { ...config, enabled: false }; }],
    ['config invalid', () => { org.hotLeadCall = { ...config, maxAgeMinutes: 9999 }; }],
    ['origin not in config leadTypes', () => { org.hotLeadCall = { ...config, leadTypes: ['booking'] }; }],
    ['lead missing', () => { mock(crmDb.getLeadById).mockResolvedValue(undefined); }],
    ['lead id mismatch', () => { lead.leadId = 'other'; }],
    ['smoke-test lead', () => { lead.email = 'smoke-test+1760000000000@agentweb.pro'; }],
    ['progressive-capture draft', () => { lead.customFields = { stage: 'email' }; }],
    ['lead without a phone', () => { lead.phone = '  '; }],
  ];
  it.each(silent)('does nothing and records nothing: %s', async (_name, arrange, origin = 'form_fill') => {
    arrange();
    await dispatchHotLeadCall('list-a', 'lead-a', origin === 'none' ? undefined : origin);
    expect(enqueueCalls()).toHaveLength(0);
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.events).toEqual([]);
  });

  const skipped: Array<[string, string, () => void]> = [
    ['unparseable phone', 'invalid_phone', () => { lead.phone = '12345'; }],
    ['toll-free phone', 'invalid_phone', () => { lead.phone = '+18002752273'; }],
    ['non US/CA phone', 'invalid_phone', () => { lead.phone = '+442071838750'; }],
    ['country outside allowedCountries', 'country_not_allowed', () => { org.hotLeadCall = { ...config, allowedCountries: ['CA'] }; }],
    ['lead older than maxAgeMinutes', 'too_old', () => { lead.createdAt = '2026-10-19T16:49:00.000Z'; }],
    ['lead without a createdAt', 'too_old', () => { delete lead.createdAt; }],
    ['lead with an unparseable createdAt', 'too_old', () => { lead.createdAt = 'yesterday'; }],
  ];
  it.each([['@'], ['+'], [' ']])('skips with unsafe_id, before any record, for a lead id containing %j', async (ch) => {
    const leadId = `lead${ch}1`;
    lead.leadId = leadId;
    await dispatchHotLeadCall('list-a', leadId, 'form_fill');
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'unsafe_id' } }]);
    expect(limits.keysTouched).toEqual([]); // refused before any slot is reserved
    expect(enqueueCalls()).toHaveLength(0);
    expect(provider.placedCalls).toHaveLength(0);
  });

  it.each(skipped)('records call.skipped and stops: %s', async (_name, reason, arrange) => {
    arrange();
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason } }]);
    expect(enqueueCalls()).toHaveLength(0);
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('accepts a lead exactly at the age limit and a national-format US number', async () => {
    lead.createdAt = '2026-10-19T16:50:00.000Z';
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('refuses a Canadian number as country_not_allowed even when CA is allowed (Canada is off in code, ENG-2783)', async () => {
    org.hotLeadCall = { ...config, allowedCountries: ['US', 'CA'] };
    lead.phone = '+14165550142';
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'country_not_allowed' } }]);
  });

  it('measures a repeat submission by its own submittedAt, not by the old lead row', async () => {
    lead.createdAt = '2025-01-01T00:00:00.000Z';
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill', submission);
    expect(provider.placedCalls).toHaveLength(1);
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill', { submissionId: 'sub-2', submittedAt: '2026-10-19T15:00:00.000Z' });
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.events.at(-1)).toEqual({ type: 'call.skipped', detail: { reason: 'too_old' } });
  });

  it('stops quietly when the queue already holds the job', async () => {
    mock(queue.enqueueJob).mockResolvedValue('duplicate');
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(0);
    expect(queue.startHeartbeat).not.toHaveBeenCalled();
  });

  it('never rejects, even when the queue is unavailable or the db throws', async () => {
    mock(queue.enqueueJob).mockResolvedValue('unavailable');
    await expect(dispatchHotLeadCall('list-a', 'lead-a', 'form_fill')).resolves.toBeUndefined();
    mock(crmDb.getLeadListById).mockRejectedValue(new Error('boom'));
    await expect(dispatchHotLeadCall('list-a', 'lead-a', 'form_fill')).resolves.toBeUndefined();
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('marks the job failed (and dials nothing) when processing throws before the record is created', async () => {
    delete process.env.BACKEND_URL;
    Object.assign(process.env, { NODE_ENV: 'production' });
    try {
      await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    } finally {
      Object.assign(process.env, { NODE_ENV: 'test' });
    }
    expect(queue.markJobFailed).toHaveBeenCalledTimes(1);
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
  });

  it('enqueues with a stable payload and a source-specific key, no phone number inside', async () => {
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill', submission);
    const [source, key, payload, options] = enqueueCalls()[0];
    expect(source).toBe('hot_lead_call');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(options).toEqual({ claimImmediately: true });
    expect(payload).toEqual({ orgId: 'org-a', listId: 'list-a', leadId: 'lead-a', origin: 'form_fill', ...submission });
    expect(JSON.stringify(payload)).not.toMatch(/415/);
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill', { ...submission, submissionId: 'sub-2' });
    expect(enqueueCalls()[1][1]).not.toBe(key);
  });
});

describe('team routing', () => {
  const SECOND_PHONE = '+14155550122';
  const morning = teamMember(MEMBER_PHONE, { id: 'mmorning', name: 'Early Bird', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '12:00' }] });
  const afternoon = teamMember(SECOND_PHONE, { id: 'mafterno', name: 'Late Lark', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '12:00', end: '21:00' }] });
  // NOW is 12:00 CDT: the morning window has just closed and the afternoon one has just opened.
  const useTeam = (team: unknown[]) => { org.hotLeadCall = { ...config, team }; };
  const placedTo = () => provider.placedCalls.map(c => c.to);

  it('records the attempt, the member and the members tried on the new record', async () => {
    await processHotLeadCallJob(jobOf());
    expect(store.record).toMatchObject({ attemptNo: 1, memberId: MEMBER_ID, triedMemberIds: [MEMBER_ID] });
  });

  it('rings the member whose window is open now, not the first on the team', async () => {
    useTeam([morning, afternoon]);
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([SECOND_PHONE]);
    expect(store.record).toMatchObject({ memberId: 'mafterno', triedMemberIds: ['mafterno'] });
  });

  it('rings the highest-priority member among those available', async () => {
    useTeam([afternoon, teamMember('+14155550133', { id: 'mbackup0', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '20:00' }] })]);
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([SECOND_PHONE]);
  });

  it('skips with no_one_available, at dispatch and in the job, when nobody has a window open', async () => {
    useTeam([morning]);
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    await processHotLeadCallJob(jobOf());
    expect(enqueueCalls()).toHaveLength(0);
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect(limits.keysTouched).toEqual([]);
    expect(store.events.map(e => e.detail?.reason)).toEqual(['no_one_available', 'no_one_available']);
  });

  it('never rings an unverified member', async () => {
    useTeam([teamMember(MEMBER_PHONE, { verifiedAt: undefined }), teamMember(SECOND_PHONE, { id: 'mverifie', windows: afternoon.windows })]);
    await processHotLeadCallJob(jobOf());
    expect(placedTo()).toEqual([SECOND_PHONE]);
  });

  it('uses the next candidate when the first is in cooldown, and skips once all are', async () => {
    useTeam([teamMember(MEMBER_PHONE), teamMember(SECOND_PHONE, { id: 'mother00' })]);
    lead = { ...lead, leadId: 'lead-1' };
    await processHotLeadCallJob(jobOf({ leadId: 'lead-1' }));
    store.record = null; // the fake holds one record at a time
    lead = { ...lead, leadId: 'lead-2', phone: '+12125550143', system: consentFor('+12125550143') };
    await processHotLeadCallJob(jobOf({ leadId: 'lead-2' }));
    expect(placedTo()).toEqual([MEMBER_PHONE, SECOND_PHONE]);
    store.record = null;
    lead = { ...lead, leadId: 'lead-3', phone: '+12125550144', system: consentFor('+12125550144') };
    await processHotLeadCallJob(jobOf({ leadId: 'lead-3' }));
    expect(placedTo()).toHaveLength(2);
    expect(store.events.at(-1)).toEqual({ type: 'call.skipped', detail: { reason: 'member_cooldown' } });
  });
});

describe('processHotLeadCallJob', () => {
  it('passes member and status URLs with ids only, and member and from numbers from config, never from the lead', async () => {
    await processHotLeadCallJob(jobOf());
    const [call] = provider.placedCalls;
    expect(call.to).toBe(MEMBER_PHONE);
    expect(call.from).toBe(TWILIO_NUMBER);
    expect(call.timeoutSeconds).toBe(25);
    const key = store.record!.jobKey;
    const member = new URL(call.url!);
    const status = new URL(call.statusCallbackUrl!);
    expect(member.origin + member.pathname).toBe('https://api.example.com/api/webhooks/twilio-voice/owner');
    expect(status.origin + status.pathname).toBe('https://api.example.com/api/webhooks/twilio-voice/status');
    for (const url of [member, status]) {
      expect(Object.fromEntries(url.searchParams)).toEqual({ listId: 'list-a', leadId: 'lead-a', jobKey: key });
    }
    const everything = JSON.stringify([call, store.record, store.events]);
    expect(everything).not.toMatch(/0142/);
    expect(everything).not.toContain(encodeURIComponent(LEAD_PHONE));
  });

  it('records a terminal place_rejected for a definite rejection and does not retry', async () => {
    provider.failNextPlaceCall('no');
    await processHotLeadCallJob(jobOf());
    expect(store.record).toMatchObject({ state: 'failed', outcome: 'place_rejected' });
    expect(store.events).toEqual([{ type: 'call.failed', detail: { reason: 'place_rejected', attempt: 1, memberId: MEMBER_ID } }]);
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(1);
  });

  it.each([
    ['an unknown placement failure', () => provider.failNextPlaceCall('unknown')],
    ['a non-Voice error', () => { provider.placeCall = async (p) => { provider.placedCalls.push(p); throw new TypeError('socket hang up'); }; }],
  ])('keeps the record non-terminal as placement_unknown for %s and never dials again', async (_name, arrange) => {
    arrange();
    await processHotLeadCallJob(jobOf());
    expect(store.record).toMatchObject({ state: 'dialing', outcome: 'placement_unknown' });
    expect(store.events).toEqual([{ type: 'call.failed', detail: { reason: 'placement_unknown', attempt: 1, memberId: MEMBER_ID } }]);
    await processHotLeadCallJob(jobOf());
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('moves the record dialing -> member_ringing with the CallSid once the call is placed', async () => {
    const states: string[] = [];
    const place = provider.placeCall.bind(provider);
    provider.placeCall = async (p) => { states.push(store.record!.state); return place(p); };
    await processHotLeadCallJob(jobOf());
    expect(states).toEqual(['dialing']);
    expect(store.record).toMatchObject({ state: 'member_ringing', memberCallSid: 'CA00000001' });
  });

  it('does not overwrite a record a fast webhook already moved past dialing', async () => {
    const place = provider.placeCall.bind(provider);
    provider.placeCall = async (p) => { store.record!.state = 'member_answered'; return place(p); };
    await processHotLeadCallJob(jobOf());
    expect(store.record!.state).toBe('member_answered');
    expect(store.events).toEqual([]);
  });

  it('never dials when the record cannot be created (create throws)', async () => {
    store.create = async () => { throw new Error('ddb down'); };
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('never dials for a lead that already has a record, whatever the job key', async () => {
    store.record = callRecord({ state: 'member_ringing', jobKey: 'old', startedAt: NOW, updatedAt: NOW });
    await processHotLeadCallJob(jobOf());
    await processHotLeadCallJob(jobOf({ submissionId: 'sub-2', submittedAt: NOW }));
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.events).toEqual([]);
    expect(store.record.jobKey).toBe('old');
  });

  it('treats a create that answers false as a lost race when the record carries another claim token: nothing is dialled', async () => {
    store.record = callRecord({ state: 'dialing', jobKey: 'other-dispatch', claimToken: 'someone-elses' });
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(0);
    expect({ counters: [...limits.counters.values()], claims: limits.claims.size }).toEqual({ counters: [0, 0, 0, 0], claims: 0 });
  });

  it('goes on when a create that answers false actually committed this dispatch\'s own record (an SDK retry lost its response)', async () => {
    const create = store.create.bind(store);
    store.create = async (listId, leadId, record) => {
      await create(listId, leadId, record);
      return false;
    };
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'member_ringing', attemptNo: 1 });
    expect([...limits.counters.values()]).toEqual([1, 1, 1, 1]);
  });

  it.each([
    ['the same job key', {}],
    ['different job keys', { submissionId: 'sub-2', submittedAt: NOW }],
  ])('places exactly one call when two jobs race for the same lead with %s', async (_name, second) => {
    await Promise.all([processHotLeadCallJob(jobOf()), processHotLeadCallJob(jobOf(second))]);
    expect(provider.placedCalls).toHaveLength(1);
    // The loser finds its own lead holding the phone marker and stays silent.
    expect(store.eventTypes()).toEqual(['call.initiated']);
  });

  it('stays silent when a repeat submission of an already-called lead trips the phone marker', async () => {
    await processHotLeadCallJob(jobOf());
    await processHotLeadCallJob(jobOf({ submissionId: 'sub-2', submittedAt: new Date().toISOString() }));
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.eventTypes()).toEqual(['call.initiated']);
  });

  it('after a crash between create and placeCall the stuck dialing record blocks every re-run', async () => {
    store.record = callRecord({ state: 'dialing', jobKey: 'crashed', startedAt: NOW, updatedAt: NOW });
    await processHotLeadCallJob(jobOf());
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toMatchObject({ state: 'dialing', jobKey: 'crashed' });
  });

  it('leaves the record in dialing, and warns, when the post-call transition fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.transitionError = new Error('ddb down');
    await expect(processHotLeadCallJob(jobOf())).resolves.toBeUndefined();
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record!.state).toBe('dialing');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('skips with no_caller_number, before any record exists, when the config has no caller number', async () => {
    callerless.on = true;
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'no_caller_number' } }]);
  });

  it('skips when the switch was turned off after enqueue, before any read', async () => {
    setHotLeadCallEnabledOverride(false);
    await processHotLeadCallJob(jobOf());
    expect(crmDb.getLeadListById).not.toHaveBeenCalled();
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('re-checks state at processing time: config disabled, then lead too old, since enqueue', async () => {
    org.hotLeadCall = { ...config, enabled: false };
    await processHotLeadCallJob(jobOf());
    org.hotLeadCall = config;
    lead.createdAt = '2026-10-19T14:00:00.000Z';
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'too_old' } }]);
  });

  it('refuses a job whose orgId no longer owns the list', async () => {
    await processHotLeadCallJob(jobOf({ orgId: 'org-b' }));
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('throws on a malformed job without touching anything', async () => {
    await expect(processHotLeadCallJob({ ...jobOf(), leadId: '' })).rejects.toThrow('Invalid hot lead call job');
    expect(crmDb.getLeadListById).not.toHaveBeenCalled();
  });

  it('scrubs phone numbers from the logged error of a failed record update', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.transitionError = new Error(`ddb rejected update for ${MEMBER_PHONE}`);
    await processHotLeadCallJob(jobOf());
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).toContain('call record not updated');
    expect(logged).not.toContain('4155550100');
  });
});

describe('registerHotLeadCallProcessor', () => {
  it('registers the hot_lead_call source with a single attempt', () => {
    registerHotLeadCallProcessor();
    expect(queue.registerProcessor).toHaveBeenCalledWith('hot_lead_call', processHotLeadCallJob, { maxAttempts: 1 });
  });
});

describe('calling hours gate', () => {
  // This block tests the ORG's window in isolation (many instants are night time in the lead's zone), so the
  // lead-local window (leadLocalHours, covered by its own tests and the e2e gates) is held open here.
  let leadWindow: jest.SpyInstance;
  beforeEach(() => { leadWindow = jest.spyOn(leadLocalHours, 'isInsideLeadCallWindow').mockReturnValue(true); });
  afterEach(() => leadWindow.mockRestore());

  // America/Chicago, window 08:00-21:00: CDT is UTC-5, CST is UTC-6.
  const at = async (iso: string) => {
    jest.setSystemTime(new Date(iso));
    lead.createdAt = iso;
    store.record = null;
    store.events = [];
    limits.claims.clear();
    limits.counters.clear();
    provider.placedCalls.length = 0;
    await processHotLeadCallJob(jobOf());
    return provider.placedCalls.length === 1 ? 'called' : store.events.map(e => e.detail?.reason).join();
  };

  it.each([
    ['07:59 CDT, one minute before the window', '2026-10-19T12:59:00Z', 'outside_calling_hours'],
    ['08:00 CDT, the start is inclusive', '2026-10-19T13:00:00Z', 'called'],
    ['20:59:59 CDT, still inside', '2026-10-20T01:59:59Z', 'called'],
    ['21:00 CDT, the end is exclusive', '2026-10-20T02:00:00Z', 'outside_calling_hours'],
    ['03:00 CDT at night', '2026-10-19T08:00:00Z', 'outside_calling_hours'],
    ['spring-forward day: 07:59 CDT (13:00 CST would be wrong)', '2026-03-08T12:59:00Z', 'outside_calling_hours'],
    ['spring-forward day: 08:00 CDT', '2026-03-08T13:00:00Z', 'called'],
    ['spring-forward day: 21:00 CDT', '2026-03-09T02:00:00Z', 'outside_calling_hours'],
    ['day before spring-forward: 08:00 CST', '2026-03-07T14:00:00Z', 'called'],
    ['day before spring-forward: 07:59 CST', '2026-03-07T13:59:00Z', 'outside_calling_hours'],
    ['fall-back day: 07:59 CST', '2026-11-01T13:59:00Z', 'outside_calling_hours'],
    ['fall-back day: 08:00 CST', '2026-11-01T14:00:00Z', 'called'],
    ['fall-back day: 21:00 CST', '2026-11-02T03:00:00Z', 'outside_calling_hours'],
    ['fall-back day: 20:59 CST', '2026-11-02T02:59:00Z', 'called'],
  ])('%s', async (_name, iso, expected) => {
    expect(await at(iso)).toBe(expected);
  });

  it('handles a window that wraps past midnight (22:00-06:00)', async () => {
    org.hotLeadCall = { ...config, callingHours: { start: '22:00', end: '06:00', timezone: 'America/Chicago' } };
    expect(await at('2026-10-20T02:59:00Z')).toBe('outside_calling_hours'); // 21:59 CDT
    expect(await at('2026-10-20T03:00:00Z')).toBe('called'); // 22:00 CDT
    expect(await at('2026-10-20T10:59:00Z')).toBe('called'); // 05:59 CDT
    expect(await at('2026-10-20T11:00:00Z')).toBe('outside_calling_hours'); // 06:00 CDT
    expect(await at('2026-10-19T17:00:00Z')).toBe('outside_calling_hours'); // noon
  });

  it('uses the stored zone, not the server zone or the lead', async () => {
    org.hotLeadCall = { ...config, callingHours: { start: '08:00', end: '21:00', timezone: 'Asia/Kolkata' } };
    expect(await at('2026-10-19T17:00:00Z')).toBe('outside_calling_hours'); // 22:30 IST (noon in Chicago)
    expect(await at('2026-10-19T07:00:00Z')).toBe('called'); // 12:30 IST (02:00 in Chicago)
  });

  it('skips at dispatch (before queueing) and in the job, with no limit store I/O', async () => {
    jest.setSystemTime(new Date('2026-10-19T08:00:00Z'));
    lead.createdAt = '2026-10-19T08:00:00Z';
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    await processHotLeadCallJob(jobOf());
    expect(enqueueCalls()).toHaveLength(0);
    expect(store.events).toEqual([
      { type: 'call.skipped', detail: { reason: 'outside_calling_hours' } },
      { type: 'call.skipped', detail: { reason: 'outside_calling_hours' } },
    ]);
    expect(limits.keysTouched).toEqual([]);
    expect(store.record).toBeNull();
  });
});

describe('lead-local hours gate (ENG-2783)', () => {
  // The org window (Chicago 08:00-21:00) is open; the lead (212, Eastern/Pacific) is not: 14:00Z is 10:00 Eastern, before the 13:00 start.
  const CLOSED_FOR_LEAD = '2026-10-19T14:00:00Z';

  it('skips at dispatch (before queueing) and again in the job, with no limit store I/O', async () => {
    jest.setSystemTime(new Date(CLOSED_FOR_LEAD));
    lead.createdAt = CLOSED_FOR_LEAD;
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(enqueueCalls()).toHaveLength(0);
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'outside_lead_hours' } }]);
    await processHotLeadCallJob(jobOf());
    expect(store.events).toEqual([
      { type: 'call.skipped', detail: { reason: 'outside_lead_hours' } },
      { type: 'call.skipped', detail: { reason: 'outside_lead_hours' } },
    ]);
    expect(limits.keysTouched).toEqual([]);
    expect(store.record).toBeNull();
    expect(provider.placedCalls).toHaveLength(0);
  });
});

describe('abuse limits (reservation)', () => {
  const FIRST = '(212) 555-0142';
  // A new lead row, same list: the record store is per lead, so reset it.
  const submit = async (leadId: string, phone: string, overrides: Record<string, unknown> = {}) => {
    lead = { ...lead, leadId, phone, system: consentFor(phone), createdAt: new Date().toISOString() };
    store.record = null;
    store.events = [];
    const before = provider.placedCalls.length;
    await processHotLeadCallJob(jobOf({ leadId, ...overrides }));
    return provider.placedCalls.length > before ? 'called' : store.events.map(e => e.detail?.reason).join();
  };
  const later = (minutes: number) => jest.setSystemTime(new Date(Date.parse(NOW) + minutes * 60_000));
  const slots = () => ({ counters: [...limits.counters.values()], claims: limits.claims.size });

  it('records a successful call against the phone marker, the cooldown and both counters', async () => {
    expect(await submit('l1', FIRST)).toBe('called');
    expect(slots()).toEqual({ counters: [1, 1, 1, 1], claims: 2 });
  });

  it('refuses the same phone for 24h on a different lead row, then allows it again', async () => {
    // Start at 15:00 Eastern: the 24h boundary must fall inside the lead-local window (13:00-18:00 Eastern, ENG-2783).
    const T0 = 120;
    later(T0);
    expect(await submit('l1', FIRST)).toBe('called');
    later(T0 + 3);
    expect(await submit('l2', '+12125550142')).toBe('duplicate_phone'); // same number, different spelling
    later(T0 + 24 * 60 - 1);
    expect(await submit('l3', FIRST)).toBe('duplicate_phone');
    later(T0 + 24 * 60);
    expect(await submit('l4', FIRST)).toBe('called');
  });

  it('does not treat another org\'s identical phone as a duplicate', async () => {
    expect(await submit('l1', FIRST)).toBe('called');
    later(3);
    org = { orgId: 'org-b', hotLeadCall: config };
    mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-b' });
    expect(await submit('l1', FIRST, { orgId: 'org-b' })).toBe('called');
  });

  it('refuses a second member call inside the cooldown and allows it at the boundary', async () => {
    expect(await submit('l1', FIRST)).toBe('called');
    later(1);
    expect(await submit('l2', '+12125550143')).toBe('member_cooldown');
    later(2);
    expect(await submit('l3', '+12125550144')).toBe('called');
  });

  it('enforces the hourly cap and gives the window back in the next hour', async () => {
    org.hotLeadCall = { ...config, maxCallsPerHour: 2, memberCooldownMinutes: 1 };
    expect(await submit('l1', '+12125550141')).toBe('called');
    later(2);
    expect(await submit('l2', '+12125550142')).toBe('called');
    later(4);
    expect(await submit('l3', '+12125550143')).toBe('org_hourly_cap');
    later(61);
    expect(await submit('l4', '+12125550144')).toBe('called');
  });

  it('enforces the daily cap in the org\'s local day', async () => {
    org.hotLeadCall = { ...config, maxCallsPerDay: 2, maxCallsPerHour: 30, memberCooldownMinutes: 1 };
    expect(await submit('l1', '+12125550141')).toBe('called');
    later(2);
    expect(await submit('l2', '+12125550142')).toBe('called');
    later(4);
    expect(await submit('l3', '+12125550143')).toBe('org_daily_cap');
    // Chicago midnight (05:00Z) starts a new local day, but the windows are closed overnight; use the next midday
    // (the lead-local window is 13:00-18:00 Eastern, so the next morning is too early).
    later(60 * 24);
    expect(await submit('l4', '+12125550144')).toBe('called');
  });

  it('keeps the lead\'s call slot when a limit refuses: no record is created', async () => {
    org.hotLeadCall = { ...config, maxCallsPerHour: 1, memberCooldownMinutes: 1 };
    await submit('l1', '+12125550141');
    later(2);
    store.record = null;
    store.events = [];
    lead = { ...lead, leadId: 'l2', phone: '+12125550142', system: consentFor('+12125550142'), createdAt: new Date().toISOString() };
    await processHotLeadCallJob(jobOf({ leadId: 'l2' }));
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'org_hourly_cap' } }]);
    // The same lead can still be called once the limit clears.
    later(61);
    lead.createdAt = new Date().toISOString();
    await processHotLeadCallJob(jobOf({ leadId: 'l2' }));
    expect(store.record).toMatchObject({ state: 'member_ringing' });
  });

  it('gives every slot back when a later limit refuses', async () => {
    org.hotLeadCall = { ...config, maxCallsPerHour: 1, maxCallsPerDay: 5, memberCooldownMinutes: 1 };
    await submit('l1', '+12125550141');
    later(2);
    expect(await submit('l2', '+12125550142')).toBe('org_hourly_cap');
    // l2's phone marker and cooldown claim were released; only l1's phone marker remains, and the counters did not move.
    expect(slots().counters).toEqual([1, 1, 1, 1]);
    expect([...limits.claims.keys()].filter(k => k.startsWith('hlc#phone#'))).toHaveLength(1);
  });

  it('gives every slot back when the lead loses store.create', async () => {
    store.record = callRecord({ state: 'member_ringing', jobKey: 'old', startedAt: NOW, updatedAt: NOW });
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(0);
    expect(slots()).toEqual({ counters: [0, 0, 0, 0], claims: 0 });
  });

  it('gives every slot back when store.create throws', async () => {
    store.create = async () => { throw new Error('ddb down'); };
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    expect(slots()).toEqual({ counters: [0, 0, 0, 0], claims: 0 });
  });

  it('keeps the slots when the call is placed and then rejected (the lead\'s call is spent)', async () => {
    provider.failNextPlaceCall('no');
    await processHotLeadCallJob(jobOf());
    expect(slots()).toEqual({ counters: [1, 1, 1, 1], claims: 2 });
  });

  it('fails the job closed, dialing nothing and creating no record, and shows limits_unavailable on the lead', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Only the reservation fails: the do-not-call read before it works, so this proves the reservation's own fail-closed path.
    limits.failKeyPrefix = { prefix: 'hlc#phone#', error: new Error('ddb down') };
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    warn.mockRestore();
    expect(limits.keysTouched.some((k) => k.startsWith('hlc#phone#'))).toBe(true);
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'limits_unavailable' } }]);
  });

  it('fails the job with the original error when the limits_unavailable event cannot be written', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    limits.failKeyPrefix = { prefix: 'hlc#phone#', error: new Error('ddb down') };
    store.addEvent = async () => { throw new Error('events down'); };
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    warn.mockRestore();
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('fails the job closed, dialing nothing and creating no record, when the do-not-call read fails (before any slot)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    limits.failKeyPrefix = { prefix: 'hlc#dnc#', error: new Error('ddb down') };
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    warn.mockRestore();
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'limits_unavailable' } }]);
    expect(limits.keysTouched.every((k) => k.startsWith('hlc#dnc#'))).toBe(true);
    expect(limits.counters.size).toBe(0);
  });

  it('fails the job closed when JWT_SECRET (the phone-hash key) is missing', async () => {
    delete process.env.JWT_SECRET;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('JWT_SECRET');
    warn.mockRestore();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'limits_unavailable' } }]);
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('a burst of 100 simultaneous leads dials once (the cooldown) and never more than the cap', async () => {
    org.hotLeadCall = { ...config, maxCallsPerHour: 3, memberCooldownMinutes: 1 };
    const created = new Set<string>();
    mock(crmDb.getLeadById).mockImplementation(async (_l: string, id: string) => ({ ...lead, leadId: id, phone: `+1212555${String(1000 + Number(id.slice(1)))}`, system: consentFor(`+1212555${String(1000 + Number(id.slice(1)))}`) }));
    setLeadCallStoreForTests({
      get: async () => null,
      create: async (_l, id) => { if (created.has(id)) return false; created.add(id); return true; },
      transition: async () => true,
      claimRetry: async () => false,
      rescheduleRetry: async () => false,
      releaseRetryClaim: async () => false,
      restartForRetry: async () => false,
      addEvent: async () => undefined,
    });
    await Promise.all(Array.from({ length: 100 }, (_v, i) => processHotLeadCallJob(jobOf({ leadId: `l${i}` }))));
    expect(provider.placedCalls).toHaveLength(1);
    expect(limits.counters.get(`hlc#cap#h#org-a#2026-10-19T17`)).toBe(1);
  });

  it('puts no phone number in any limit key or timeline event', async () => {
    await submit('l1', FIRST);
    later(3);
    await submit('l2', '+12125550142');
    const keys = JSON.stringify([...limits.keysTouched, store.events]);
    for (const spelling of ['2125550142', '+12125550142', '(212) 555-0142', '212-555-0142', '555-0142']) expect(keys).not.toContain(spelling);
    expect(keys).toMatch(/hlc#phone#[0-9a-f]{64}/);
  });
});

describe('do-not-call (a lead pressed 3, ENG-2783)', () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const listed = () => markNumberDoNotCall('org-a', '+12125550142');

  it('skips with do_not_call, before any slot or record, when the org marker holds the number (another lead, same number)', async () => {
    await listed();
    lead.leadId = 'lead-new';
    await dispatchHotLeadCall('list-a', 'lead-new', 'form_fill');
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'do_not_call' } }]);
    expect(enqueueCalls()).toHaveLength(0);
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect([...limits.counters.keys()]).toEqual([]);
    expect([...limits.claims.keys()]).toEqual([dncKey('org-a', '+12125550142')]);
  });

  it('keys the marker by org and a keyed digest of the number: another org is not affected, and the key holds no number', async () => {
    await listed();
    const [key] = [...limits.claims.keys()];
    expect(key).toMatch(/^hlc#dnc#[0-9a-f]{64}$/);
    expect(key).not.toContain('2125550142');
    expect(limits.claims.get(key)!.expiresAtS - nowS()).toBeGreaterThan(9 * 365 * 86400);
    expect(key).not.toBe(dncKey('org-b', '+12125550142'));
    expect(await isNumberDoNotCall('org-b', '+12125550142')).toBe(false);
  });

  it('skips with do_not_call when the lead itself is do-not-contact, taking no slot and no record', async () => {
    lead.contactStatus = 'do-not-contact';
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'do_not_call' } }]);
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect([...limits.counters.keys()]).toEqual([]);
    expect([...limits.claims.keys()].every((k) => k.startsWith('hlc#dnc#'))).toBe(true);
  });

  it.each([
    ['an email unsubscribe', { contactStatus: 'unsubscribed' }],
    ['the legacy group-email flag', { unsubscribedFromGroupEmail: true }],
    ['a bounce reason without do-not-contact', { contactStatus: 'active', contactStatusReason: 'bounced' }],
  ])('still calls a lead with %s (only do-not-contact and the org marker block)', async (_name, fields) => {
    Object.assign(lead, fields);
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('re-checks in the job, so a stop that landed after dispatch is honoured', async () => {
    await listed();
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'do_not_call' } }]);
  });

  it('is checked after the stateless gates and the plan: a lead outside the lead window does not read the store', async () => {
    jest.setSystemTime(new Date('2026-10-19T23:30:00.000Z'));
    await listed();
    limits.keysTouched.length = 0;
    await processHotLeadCallJob(jobOf());
    expect(limits.keysTouched).toEqual([]);
  });

  it('a lapsed marker no longer blocks (the store tests the expiry itself)', async () => {
    await listed();
    jest.setSystemTime(new Date(Date.now() + 11 * 365 * 86400 * 1000));
    expect(await isNumberDoNotCall('org-a', '+12125550142')).toBe(false);
  });
});

describe('plan entitlement', () => {
  it('skips with not_entitled, before any limit or record, when the org’s plan no longer includes calls', async () => {
    setHotLeadCallEntitledOverride(false);
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'not_entitled' } }]);
    expect(enqueueCalls()).toHaveLength(0);
    expect(provider.placedCalls).toHaveLength(0);
    expect(limits.keysTouched).toEqual([]);
    expect(store.record).toBeNull();
  });

  it('re-checks in the job, so an org that lost its plan after dispatch is not dialed', async () => {
    setHotLeadCallEntitledOverride(false);
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'not_entitled' } }]);
  });

  describe('the paid add-on (HOT_LEAD_CALL_BILLING_REQUIRED)', () => {
    afterEach(() => { delete process.env.HOT_LEAD_CALL_BILLING_REQUIRED; });

    it('required and not active: skips with not_entitled before any record, even though the plan includes calls', async () => {
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
      (org as Record<string, unknown>).hotLeadCallBilling = { itemId: 'si_1', status: 'past_due', updatedAt: 'x' };
      await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
      expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'not_entitled' } }]);
      expect(provider.placedCalls).toHaveLength(0);
      expect(store.record).toBeNull();
    });

    it('required and the org has never bought it: skips with not_entitled', async () => {
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
      await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
      expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'not_entitled' } }]);
    });

    it('required and active: calls as before', async () => {
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'true';
      (org as Record<string, unknown>).hotLeadCallBilling = { itemId: 'si_1', status: 'active', updatedAt: 'x' };
      await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
      expect(provider.placedCalls).toHaveLength(1);
    });

    it('not required (the default, also for any value but exactly "true"): never looks at the add-on', async () => {
      process.env.HOT_LEAD_CALL_BILLING_REQUIRED = 'TRUE';
      (org as Record<string, unknown>).hotLeadCallBilling = { itemId: 'si_1', status: 'canceled', updatedAt: 'x' };
      await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
      expect(provider.placedCalls).toHaveLength(1);
    });
  });

  it('reads the plan of the org’s billing owner, not of the list owner', async () => {
    setHotLeadCallEntitledOverride(null);
    org.ownerUserId = 'org-owner';
    mock(getUserSubscriptionResolution).mockResolvedValue({ subscriptionType: 'Pro', resolved: true });
    mock(getSubscriptionTypeConfig).mockResolvedValue({ name: 'Pro', allowedFeatures: ['hot_lead_call'] });
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(mock(getUserSubscriptionResolution).mock.calls.every(c => c[0] === 'org-owner')).toBe(true);
    expect(mock(getUserSubscriptionResolution)).toHaveBeenCalled();
    expect(provider.placedCalls).toHaveLength(1);
  });
});

describe('timeline events stay bounded per lead', () => {
  // The real store appends every event to the lead row, which the next review reads back.
  beforeEach(() => {
    const add = store.addEvent.bind(store);
    store.addEvent = async (listId, leadId, type, detail) => {
      await add(listId, leadId, type, detail);
      ((lead.engagements ??= []) as unknown[]).push({ eventType: type, eventData: detail });
    };
  });
  const repeat = async (times: number) => {
    for (let i = 0; i < times; i++) await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill', { submissionId: `sub-${i}`, submittedAt: NOW });
  };
  const skipEvents = () => store.events.filter(e => e.type === 'call.skipped');

  it('writes one call.skipped per reason however often the same lead is resubmitted', async () => {
    lead.phone = '12345';
    await repeat(1000);
    expect(skipEvents()).toEqual([{ type: 'call.skipped', detail: { reason: 'invalid_phone' } }]);
  });

  it('writes at most five call.skipped events in total, across different reasons', async () => {
    const reasons: Array<[string, () => void]> = [
      ['invalid_phone', () => { lead.phone = '12345'; }],
      ['too_old', () => { lead.createdAt = '2026-10-19T16:00:00.000Z'; }],
      ['outside_calling_hours', () => { jest.setSystemTime(new Date('2026-10-19T08:00:00.000Z')); lead.createdAt = '2026-10-19T07:59:00.000Z'; }],
      ['not_entitled', () => { setHotLeadCallEntitledOverride(false); }],
      ['no_caller_number', () => { callerless.on = true; }],
      ['country_not_allowed', () => { org.hotLeadCall = { ...config, allowedCountries: ['CA'] }; }],
    ];
    for (const [, arrange] of reasons) {
      jest.setSystemTime(new Date(NOW));
      lead.phone = LEAD_PHONE;
      lead.createdAt = '2026-10-19T16:58:00.000Z';
      org.hotLeadCall = config;
      callerless.on = false;
      setHotLeadCallEntitledOverride(true);
      arrange();
      await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill', { submissionId: `s-${reasons.length}`, submittedAt: String(lead.createdAt) });
    }
    expect(skipEvents().map(e => e.detail?.reason)).toEqual(reasons.slice(0, 5).map(([r]) => r));
  });

  it('does not count or write events for other lead rows', async () => {
    lead.phone = '12345';
    await repeat(2);
    lead.leadId = 'lead-b';
    lead.engagements = [];
    await dispatchHotLeadCall('list-a', 'lead-b', 'form_fill');
    expect(skipEvents()).toHaveLength(2);
  });
});

describe('two dispatches racing for the same lead', () => {
  it('stays silent, with no skip event, while the winner is still placing the call', async () => {
    // The winner stalls inside store.create: the loser reaches the phone marker long before any record exists.
    const create = store.create.bind(store);
    let release!: () => void;
    store.create = async (...args) => { await new Promise<void>(r => { release = r; }); return create(...args); };
    const winner = processHotLeadCallJob(jobOf());
    await jest.advanceTimersByTimeAsync(0);
    await processHotLeadCallJob(jobOf({ submissionId: 'sub-2', submittedAt: new Date().toISOString() }));
    expect(store.events).toEqual([]);
    release();
    await winner;
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.eventTypes()).toEqual(['call.initiated']);
  });

  it('a winner that then fails a cap releases the marker, so the lead can still be called', async () => {
    org.hotLeadCall = { ...config, maxCallsPerHour: 1 };
    limits.counters.set('hlc#cap#h#org-a#2026-10-19T17', 1);
    await processHotLeadCallJob(jobOf());
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'org_hourly_cap' } }]);
    expect([...limits.claims.keys()].filter(k => k.startsWith('hlc#phone#'))).toEqual([]);
    limits.counters.clear();
    store.events = [];
    await processHotLeadCallJob(jobOf({ submissionId: 'sub-2', submittedAt: NOW }));
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('still records duplicate_phone for a different lead that shares the number', async () => {
    await processHotLeadCallJob(jobOf());
    mock(crmDb.getLeadById).mockImplementation(async () => ({ ...lead, leadId: 'lead-b' }));
    store.record = null; // lead-b has no record of its own
    await processHotLeadCallJob(jobOf({ leadId: 'lead-b', submissionId: 'sub-b', submittedAt: new Date().toISOString() }));
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.events.at(-1)).toEqual({ type: 'call.skipped', detail: { reason: 'duplicate_phone' } });
  });
});

describe('a lead that already has a call record', () => {
  it('stops in review, before any job row, reservation or timeline read, on a repeat submission', async () => {
    lead.system = { hot_lead_call: { state: 'finished', jobKey: 'old' } };
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill', { submissionId: 'sub-9', submittedAt: NOW });
    expect(enqueueCalls()).toHaveLength(0);
    expect(limits.keysTouched).toEqual([]);
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.events).toEqual([]);
    expect(mock(crmDb.getLeadById)).toHaveBeenCalledTimes(1);
  });
});

describe('credentials that cannot be loaded', () => {
  it('skips with credentials_unavailable and leaves the lead\'s slot, the caps and the record untouched', async () => {
    provider.failNextEnsureCredentials('secret missing');
    await processHotLeadCallJob(jobOf());
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'credentials_unavailable' } }]);
    expect(store.record).toBeNull();
    // Only the read-only do-not-call check touched the store: no slot, no counter.
    expect(limits.keysTouched.filter((k) => !k.startsWith('hlc#dnc#'))).toEqual([]);
    expect(provider.placedCalls).toHaveLength(0);
    // The next submission of the same lead is dialed normally.
    await processHotLeadCallJob(jobOf({ submissionId: 'sub-2', submittedAt: NOW }));
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'member_ringing' });
  });
});

describe('the call record of the first attempt', () => {
  it('stores a keyed digest of the dispatch-time phone, never the phone', async () => {
    await processHotLeadCallJob(jobOf());
    expect(store.record!.leadPhoneMac).toBe(leadPhoneMacOf('org-a', '+12125550142'));
    expect(JSON.stringify(store.record)).not.toMatch(/2125550142/);
  });
});


describe('monthly cap and its owner notices (ENG-2783)', () => {
  const submit = async (n: number) => {
    lead = { ...lead, leadId: `m${n}`, phone: `+1212555${String(1000 + n)}`, system: consentFor(`+1212555${String(1000 + n)}`), createdAt: new Date().toISOString() };
    store.record = null;
    store.events = [];
    const before = provider.placedCalls.length;
    await processHotLeadCallJob(jobOf({ leadId: `m${n}` }));
    return provider.placedCalls.length > before ? 'called' : store.events.map(e => e.detail?.reason).join();
  };
  const later = (minutes: number) => jest.setSystemTime(new Date(Date.parse(NOW) + minutes * 60_000));
  // The notices are fire-and-forget; the spy passes through to the real function and keeps each returned promise (which
  // never rejects), so flush() awaits the actual notice work instead of guessing how many ticks it needs.
  let pending: Array<Promise<void>>;
  const flush = async () => { await Promise.all(pending.splice(0)); };
  const send = () => mock(emailService.sendEmail);
  const markers = (warn: jest.SpyInstance) => warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('monthly cap'));
  let warn: jest.SpyInstance;

  const arrange = (cap: number) => {
    org = { orgId: 'org-a', ownerUserId: 'owner-a', hotLeadCall: { ...config, maxCallsPerMonth: cap, maxCallsPerHour: 30, maxCallsPerDay: 100, memberCooldownMinutes: 1 } };
    mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-a', email: 'owner@example.com' });
    send().mockResolvedValue('sent');
  };
  // Submits leads 1..n two minutes apart (past the member cooldown), all expected to be called.
  const callLeads = async (n: number, from = 1) => {
    for (let i = from; i < from + n; i++) { later(i * 2); expect(await submit(i)).toBe('called'); await flush(); }
  };
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    pending = [];
    const real = capNotices.notifyMonthlyCap;
    jest.spyOn(capNotices, 'notifyMonthlyCap').mockImplementation(input => { const p = real(input); pending.push(p); return p; });
  });
  afterEach(() => { warn.mockRestore(); jest.restoreAllMocks(); });

  it('calls up to the cap, then skips as org_monthly_cap with a timeline event and no record; the other counters are given back', async () => {
    arrange(2);
    await callLeads(2);
    later(4);
    expect(await submit(3)).toBe('org_monthly_cap');
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'org_monthly_cap' } }]);
    expect([...limits.counters.entries()].map(([k, v]) => [k.split('#')[2], v]).sort()).toEqual([['d', 2], ['g', 2], ['h', 2], ['m', 2]]);
  });

  it('sends the 80% notice once at ceil(0.8 * cap) and the 100% notice once at the first refusal, with the approved copy', async () => {
    arrange(5);
    await callLeads(3);
    expect(send()).not.toHaveBeenCalled();
    await callLeads(1, 4);
    expect(send()).toHaveBeenCalledTimes(1);
    expect(send().mock.calls[0].slice(0, 3)).toEqual([
      'owner@example.com',
      'Your hot-lead calling is at 80% of this month\'s limit',
      'Hot-lead calling has used 4 of your 5 automatic calls this month. Calls pause at 5 and resume on the 1st. Leads are still captured and you still get the usual alerts.',
    ]);
    await callLeads(1, 5);
    expect(send()).toHaveBeenCalledTimes(1); // the second crossing does not resend
    later(12); expect(await submit(6)).toBe('org_monthly_cap'); await flush();
    expect(send()).toHaveBeenCalledTimes(2);
    expect(send().mock.calls[1].slice(0, 3)).toEqual([
      'owner@example.com',
      'Automatic hot-lead calls are paused until the 1st',
      'Your organization reached its 5 automatic hot-lead calls for this month, so automatic calls are paused until the 1st. New leads are still captured and you will still get the alert, so you can call them yourself. Contact AgentWeb support if you need a higher limit.',
    ]);
    later(14); expect(await submit(7)).toBe('org_monthly_cap'); await flush();
    expect(send()).toHaveBeenCalledTimes(2);
    expect(markers(warn)).toEqual(['[hotLeadCall] org monthly cap 80% org-a', '[hotLeadCall] org monthly cap 100% org-a']);
    expect([...limits.claims.keys()].filter(k => k.startsWith('hlc#notify#')).sort()).toEqual(['hlc#notify#100#org-a#2026-10', 'hlc#notify#80#org-a#2026-10']);
  });

  it('a cap of 1 sends no 80% email (it would be the cap itself): the first refusal sends the 100% email only', async () => {
    arrange(1);
    await callLeads(1);
    expect(send()).not.toHaveBeenCalled();
    later(4); expect(await submit(2)).toBe('org_monthly_cap'); await flush();
    expect(send()).toHaveBeenCalledTimes(1);
    expect(send().mock.calls[0][1]).toBe('Automatic hot-lead calls are paused until the 1st');
    expect(markers(warn)).toEqual(['[hotLeadCall] org monthly cap 100% org-a']);
  });

  it('sends the notices again in the next month', async () => {
    arrange(5);
    await callLeads(4);
    later(12); expect(await submit(5)).toBe('called'); await flush();
    later(14); expect(await submit(6)).toBe('org_monthly_cap'); await flush();
    expect(send()).toHaveBeenCalledTimes(2);
    for (const [i, at] of ['2026-11-02T18:00:00.000Z', '2026-11-02T18:02:00.000Z', '2026-11-02T18:04:00.000Z', '2026-11-02T18:06:00.000Z'].entries()) {
      jest.setSystemTime(new Date(at)); expect(await submit(10 + i)).toBe('called'); await flush();
    }
    expect(send()).toHaveBeenCalledTimes(3); // the new month's 80% (4 of 5)
  });

  it('a failing 80% email does not fail the call and is retried at the next crossing', async () => {
    arrange(5);
    send().mockRejectedValue(new Error('smtp exploded for owner@example.com'));
    await callLeads(4);
    expect(provider.placedCalls).toHaveLength(4);
    expect(send()).toHaveBeenCalledTimes(1);
    expect(limits.claims.has('hlc#notify#80#org-a#2026-10')).toBe(false); // given back, so a later crossing retries
    expect(JSON.stringify(warn.mock.calls)).not.toContain('owner@example.com');
    send().mockResolvedValue('sent');
    await callLeads(1, 5);
    expect(send()).toHaveBeenCalledTimes(2);
    expect(markers(warn).filter(m => m === '[hotLeadCall] org monthly cap 80% org-a')).toHaveLength(2); // marker repeats with the retry
  });

  it('a failed send reported by the email service (not thrown) also gives the 80% claim back', async () => {
    arrange(5);
    send().mockResolvedValue('failed');
    await callLeads(4);
    expect(limits.claims.has('hlc#notify#80#org-a#2026-10')).toBe(false);
  });

  it.each([
    ['thrown', () => send().mockRejectedValue(new Error('smtp exploded for owner@example.com'))],
    ['reported as failed', () => send().mockResolvedValue('failed')],
  ])('a 100%% send that fails (%s) keeps the claim, logs the fallback alarm and is not retried on the next refusal', async (_n, fail) => {
    arrange(2);
    await callLeads(2);
    fail();
    later(8); expect(await submit(3)).toBe('org_monthly_cap'); await flush();
    expect(limits.claims.has('hlc#notify#100#org-a#2026-10')).toBe(true);
    expect(markers(warn)).toContain('[hotLeadCall] monthly cap 100% notice failed org-a');
    later(10); expect(await submit(4)).toBe('org_monthly_cap'); await flush();
    expect(send()).toHaveBeenCalledTimes(1); // only the first refusal tried to send
    expect(JSON.stringify(warn.mock.calls)).not.toContain('owner@example.com');
  });

  it('an email that never completes does not delay the call', async () => {
    arrange(5);
    send().mockReturnValue(new Promise(() => undefined));
    for (let i = 1; i <= 4; i++) { later(i * 2); expect(await submit(i)).toBe('called'); }
    expect(provider.placedCalls).toHaveLength(4);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    expect(send()).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['80%', 5, 4, 1, '80%'],
    ['100%', 2, 2, 1, '100%'],
  ])('sends no %s email and still logs the marker when the owner has no email', async (_n, cap, calls, refusals, pct) => {
    arrange(cap);
    mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-a' });
    await callLeads(calls);
    if (pct === '100%') { later(20); expect(await submit(99)).toBe('org_monthly_cap'); await flush(); }
    expect(refusals).toBe(1);
    expect(send()).not.toHaveBeenCalled();
    expect(markers(warn)).toContain(`[hotLeadCall] org monthly cap ${pct} org-a`);
  });

  it('sends no email and still logs the marker when the org has no owner', async () => {
    arrange(5);
    delete org.ownerUserId;
    await callLeads(4);
    expect(send()).not.toHaveBeenCalled();
    expect(markers(warn)).toContain('[hotLeadCall] org monthly cap 80% org-a');
  });

  it('logs the 100% marker after a monthly refusal', async () => {
    arrange(2);
    await callLeads(2);
    later(8); expect(await submit(3)).toBe('org_monthly_cap'); await flush();
    expect(markers(warn)).toContain('[hotLeadCall] org monthly cap 100% org-a');
  });

  it('sends nothing for a refusal by another limit', async () => {
    arrange(50);
    org.hotLeadCall = { ...(org.hotLeadCall as object), maxCallsPerHour: 1 };
    expect(await submit(1)).toBe('called');
    later(2);
    expect(await submit(2)).toBe('org_hourly_cap'); await flush();
    expect(send()).not.toHaveBeenCalled();
  });
});
