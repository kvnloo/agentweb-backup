jest.mock('../services/db', () => ({
  ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS,
  crmDb: { getLeadListById: jest.fn(), getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(),
  startHeartbeat: jest.fn(), registerProcessor: jest.fn(),
}));
const callerless = { on: false };
jest.mock('../services/voice/hotLeadCallContext', () => ({
  resolveHotLeadCallContext: async (listId: string) => {
    const ctx = await jest.requireActual('../services/voice/hotLeadCallContext').resolveHotLeadCallContext(listId);
    // The validator guarantees a caller number on an enabled config; this simulates that guarantee breaking.
    return ctx && callerless.on ? { ...ctx, config: { ...ctx.config, twilioNumber: undefined } } : ctx;
  },
}));
import { crmDb, userDb, orgDb } from '../services/db';
import * as queue from '../services/asyncJobQueue';
import { dispatchHotLeadCall, processHotLeadCallJob, registerHotLeadCallProcessor } from '../services/hotLeadCallService';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { FakeVoiceProvider } from '../services/voice/fakeVoiceProvider';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { setLeadCallStoreForTests } from '../services/voice/leadCallStore';
import { FakeLimitStore } from '../services/voice/fakeLimitStore';
import { setLimitStoreForTests } from '../services/voice/limitStore';
import { FakeLeadCallStore } from '../services/voice/fakeLeadCallStore';

const mock = (fn: unknown) => fn as jest.Mock;
const OWNER_PHONE = '+14155550100';
const TWILIO_NUMBER = '+14155550111';
const LEAD_PHONE = '(212) 555-0142';
const NOW = '2026-10-19T17:00:00.000Z';

const config = {
  enabled: true, destinationPhone: OWNER_PHONE, destinationVerifiedAt: '2026-01-01T00:00:00.000Z',
  twilioNumber: TWILIO_NUMBER, announcedName: 'Acme Plumbing',
  quietHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
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
  provider = new FakeVoiceProvider();
  setVoiceProviderForTests(provider);
  store = new FakeLeadCallStore();
  setLeadCallStoreForTests(store);
  limits = new FakeLimitStore();
  setLimitStoreForTests(limits);
  process.env.JWT_SECRET = 'test-secret';
  lead = { listId: 'list-a', leadId: 'lead-a', phone: LEAD_PHONE, email: 'jane@example.com', createdAt: '2026-10-19T16:58:00.000Z', customFields: { stage: 'complete' } };
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
  setVoiceProviderForTests(null);
  setLeadCallStoreForTests(null);
  setLimitStoreForTests(null);
});

describe('dispatchHotLeadCall gates', () => {
  it('places the owner call for an eligible form fill (control for every refusal below)', async () => {
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'owner_ringing', ownerCallSid: 'CA00000001' });
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

  it('accepts a Canadian number when CA is allowed', async () => {
    lead.phone = '+14165550142';
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(1);
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

describe('processHotLeadCallJob', () => {
  it('passes owner and status URLs with ids only, and destination/from from config, never from the lead', async () => {
    await processHotLeadCallJob(jobOf());
    const [call] = provider.placedCalls;
    expect(call.to).toBe(OWNER_PHONE);
    expect(call.from).toBe(TWILIO_NUMBER);
    expect(call.timeoutSeconds).toBe(25);
    const key = store.record!.jobKey;
    const owner = new URL(call.url!);
    const status = new URL(call.statusCallbackUrl!);
    expect(owner.origin + owner.pathname).toBe('https://api.example.com/api/webhooks/twilio-voice/owner');
    expect(status.origin + status.pathname).toBe('https://api.example.com/api/webhooks/twilio-voice/status');
    for (const url of [owner, status]) {
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
    expect(store.events).toEqual([{ type: 'call.failed', detail: { reason: 'place_rejected' } }]);
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
    expect(store.events).toEqual([{ type: 'call.failed', detail: { reason: 'placement_unknown' } }]);
    await processHotLeadCallJob(jobOf());
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(1);
  });

  it('moves the record dialing -> owner_ringing with the CallSid once the call is placed', async () => {
    const states: string[] = [];
    const place = provider.placeCall.bind(provider);
    provider.placeCall = async (p) => { states.push(store.record!.state); return place(p); };
    await processHotLeadCallJob(jobOf());
    expect(states).toEqual(['dialing']);
    expect(store.record).toMatchObject({ state: 'owner_ringing', ownerCallSid: 'CA00000001' });
  });

  it('does not overwrite a record a fast webhook already moved past dialing', async () => {
    const place = provider.placeCall.bind(provider);
    provider.placeCall = async (p) => { store.record!.state = 'owner_answered'; return place(p); };
    await processHotLeadCallJob(jobOf());
    expect(store.record!.state).toBe('owner_answered');
    expect(store.events).toEqual([]);
  });

  it('never dials when the record cannot be created (create throws)', async () => {
    store.create = async () => { throw new Error('ddb down'); };
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('never dials for a lead that already has a record, whatever the job key', async () => {
    store.record = { state: 'owner_ringing', jobKey: 'old', startedAt: NOW, updatedAt: NOW };
    await processHotLeadCallJob(jobOf());
    await processHotLeadCallJob(jobOf({ submissionId: 'sub-2', submittedAt: NOW }));
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.events).toEqual([]);
    expect(store.record.jobKey).toBe('old');
  });

  it.each([
    ['the same job key', {}],
    ['different job keys', { submissionId: 'sub-2', submittedAt: NOW }],
  ])('places exactly one call when two jobs race for the same lead with %s', async (_name, second) => {
    await Promise.all([processHotLeadCallJob(jobOf()), processHotLeadCallJob(jobOf(second))]);
    expect(provider.placedCalls).toHaveLength(1);
    // The loser may record a duplicate_phone skip if it trips the marker before the winner's record exists.
    expect(store.eventTypes().filter(t => t === 'call.initiated')).toHaveLength(1);
    expect(store.events.filter(e => e.type === 'call.skipped').every(e => e.detail?.reason === 'duplicate_phone')).toBe(true);
  });

  it('stays silent when a repeat submission of an already-called lead trips the phone marker', async () => {
    await processHotLeadCallJob(jobOf());
    await processHotLeadCallJob(jobOf({ submissionId: 'sub-2', submittedAt: new Date().toISOString() }));
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.eventTypes()).toEqual(['call.initiated']);
  });

  it('after a crash between create and placeCall the stuck dialing record blocks every re-run', async () => {
    store.record = { state: 'dialing', jobKey: 'crashed', startedAt: NOW, updatedAt: NOW };
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
    store.transitionError = new Error(`ddb rejected update for ${OWNER_PHONE}`);
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

describe('quiet hours gate', () => {
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
    ['07:59 CDT, one minute before the window', '2026-10-19T12:59:00Z', 'outside_quiet_hours'],
    ['08:00 CDT, the start is inclusive', '2026-10-19T13:00:00Z', 'called'],
    ['20:59:59 CDT, still inside', '2026-10-20T01:59:59Z', 'called'],
    ['21:00 CDT, the end is exclusive', '2026-10-20T02:00:00Z', 'outside_quiet_hours'],
    ['03:00 CDT at night', '2026-10-19T08:00:00Z', 'outside_quiet_hours'],
    ['spring-forward day: 07:59 CDT (13:00 CST would be wrong)', '2026-03-08T12:59:00Z', 'outside_quiet_hours'],
    ['spring-forward day: 08:00 CDT', '2026-03-08T13:00:00Z', 'called'],
    ['spring-forward day: 21:00 CDT', '2026-03-09T02:00:00Z', 'outside_quiet_hours'],
    ['day before spring-forward: 08:00 CST', '2026-03-07T14:00:00Z', 'called'],
    ['day before spring-forward: 07:59 CST', '2026-03-07T13:59:00Z', 'outside_quiet_hours'],
    ['fall-back day: 07:59 CST', '2026-11-01T13:59:00Z', 'outside_quiet_hours'],
    ['fall-back day: 08:00 CST', '2026-11-01T14:00:00Z', 'called'],
    ['fall-back day: 21:00 CST', '2026-11-02T03:00:00Z', 'outside_quiet_hours'],
    ['fall-back day: 20:59 CST', '2026-11-02T02:59:00Z', 'called'],
  ])('%s', async (_name, iso, expected) => {
    expect(await at(iso)).toBe(expected);
  });

  it('handles a window that wraps past midnight (22:00-06:00)', async () => {
    org.hotLeadCall = { ...config, quietHours: { start: '22:00', end: '06:00', timezone: 'America/Chicago' } };
    expect(await at('2026-10-20T02:59:00Z')).toBe('outside_quiet_hours'); // 21:59 CDT
    expect(await at('2026-10-20T03:00:00Z')).toBe('called'); // 22:00 CDT
    expect(await at('2026-10-20T10:59:00Z')).toBe('called'); // 05:59 CDT
    expect(await at('2026-10-20T11:00:00Z')).toBe('outside_quiet_hours'); // 06:00 CDT
    expect(await at('2026-10-19T17:00:00Z')).toBe('outside_quiet_hours'); // noon
  });

  it('uses the stored zone, not the server zone or the lead', async () => {
    org.hotLeadCall = { ...config, quietHours: { start: '08:00', end: '21:00', timezone: 'Asia/Kolkata' } };
    expect(await at('2026-10-19T17:00:00Z')).toBe('outside_quiet_hours'); // 22:30 IST (noon in Chicago)
    expect(await at('2026-10-19T07:00:00Z')).toBe('called'); // 12:30 IST (02:00 in Chicago)
  });

  it('skips at dispatch (before queueing) and in the job, with no limit store I/O', async () => {
    jest.setSystemTime(new Date('2026-10-19T08:00:00Z'));
    lead.createdAt = '2026-10-19T08:00:00Z';
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    await processHotLeadCallJob(jobOf());
    expect(enqueueCalls()).toHaveLength(0);
    expect(store.events).toEqual([
      { type: 'call.skipped', detail: { reason: 'outside_quiet_hours' } },
      { type: 'call.skipped', detail: { reason: 'outside_quiet_hours' } },
    ]);
    expect(limits.keysTouched).toEqual([]);
    expect(store.record).toBeNull();
  });
});

describe('abuse limits (reservation)', () => {
  const FIRST = '(212) 555-0142';
  // A new lead row, same list: the record store is per lead, so reset it.
  const submit = async (leadId: string, phone: string, overrides: Record<string, unknown> = {}) => {
    lead = { ...lead, leadId, phone, createdAt: new Date().toISOString() };
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
    expect(slots()).toEqual({ counters: [1, 1], claims: 2 });
  });

  it('refuses the same phone for 24h on a different lead row, then allows it again', async () => {
    expect(await submit('l1', FIRST)).toBe('called');
    later(3);
    expect(await submit('l2', '+12125550142')).toBe('duplicate_phone'); // same number, different spelling
    later(24 * 60 - 1);
    expect(await submit('l3', FIRST)).toBe('duplicate_phone');
    later(24 * 60);
    expect(await submit('l4', FIRST)).toBe('called');
  });

  it('does not treat another org\'s identical phone as a duplicate', async () => {
    expect(await submit('l1', FIRST)).toBe('called');
    later(3);
    org = { orgId: 'org-b', hotLeadCall: config };
    mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-b' });
    expect(await submit('l1', FIRST, { orgId: 'org-b' })).toBe('called');
  });

  it('refuses a second owner call inside the cooldown and allows it at the boundary', async () => {
    expect(await submit('l1', FIRST)).toBe('called');
    later(1);
    expect(await submit('l2', '+12125550143')).toBe('owner_cooldown');
    later(2);
    expect(await submit('l3', '+12125550144')).toBe('called');
  });

  it('enforces the hourly cap and gives the window back in the next hour', async () => {
    org.hotLeadCall = { ...config, maxCallsPerHour: 2, ownerCooldownMinutes: 1 };
    expect(await submit('l1', '+12125550141')).toBe('called');
    later(2);
    expect(await submit('l2', '+12125550142')).toBe('called');
    later(4);
    expect(await submit('l3', '+12125550143')).toBe('org_hourly_cap');
    later(61);
    expect(await submit('l4', '+12125550144')).toBe('called');
  });

  it('enforces the daily cap in the org\'s local day', async () => {
    org.hotLeadCall = { ...config, maxCallsPerDay: 2, maxCallsPerHour: 30, ownerCooldownMinutes: 1 };
    expect(await submit('l1', '+12125550141')).toBe('called');
    later(2);
    expect(await submit('l2', '+12125550142')).toBe('called');
    later(4);
    expect(await submit('l3', '+12125550143')).toBe('org_daily_cap');
    // Chicago midnight (05:00Z) starts a new local day, but the window is closed overnight; use the next morning.
    later(60 * 20);
    expect(await submit('l4', '+12125550144')).toBe('called');
  });

  it('keeps the lead\'s call slot when a limit refuses: no record is created', async () => {
    org.hotLeadCall = { ...config, maxCallsPerHour: 1, ownerCooldownMinutes: 1 };
    await submit('l1', '+12125550141');
    later(2);
    store.record = null;
    store.events = [];
    lead = { ...lead, leadId: 'l2', phone: '+12125550142', createdAt: new Date().toISOString() };
    await processHotLeadCallJob(jobOf({ leadId: 'l2' }));
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'org_hourly_cap' } }]);
    // The same lead can still be called once the limit clears.
    later(61);
    lead.createdAt = new Date().toISOString();
    await processHotLeadCallJob(jobOf({ leadId: 'l2' }));
    expect(store.record).toMatchObject({ state: 'owner_ringing' });
  });

  it('gives every slot back when a later limit refuses', async () => {
    org.hotLeadCall = { ...config, maxCallsPerHour: 1, maxCallsPerDay: 5, ownerCooldownMinutes: 1 };
    await submit('l1', '+12125550141');
    later(2);
    expect(await submit('l2', '+12125550142')).toBe('org_hourly_cap');
    // l2's phone marker and cooldown claim were released; only l1's phone marker remains, and the counters did not move.
    expect(slots().counters).toEqual([1, 1]);
    expect([...limits.claims.keys()].filter(k => k.startsWith('hlc#phone#'))).toHaveLength(1);
  });

  it('gives every slot back when the lead loses store.create', async () => {
    store.record = { state: 'owner_ringing', jobKey: 'old', startedAt: NOW, updatedAt: NOW };
    await processHotLeadCallJob(jobOf());
    expect(provider.placedCalls).toHaveLength(0);
    expect(slots()).toEqual({ counters: [0, 0], claims: 0 });
  });

  it('gives every slot back when store.create throws', async () => {
    store.create = async () => { throw new Error('ddb down'); };
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    expect(slots()).toEqual({ counters: [0, 0], claims: 0 });
  });

  it('keeps the slots when the call is placed and then rejected (the lead\'s call is spent)', async () => {
    provider.failNextPlaceCall('no');
    await processHotLeadCallJob(jobOf());
    expect(slots()).toEqual({ counters: [1, 1], claims: 2 });
  });

  it('fails the job closed, dialing nothing and creating no record, and shows limits_unavailable on the lead', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    limits.failNext = new Error('ddb down');
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    warn.mockRestore();
    expect(provider.placedCalls).toHaveLength(0);
    expect(store.record).toBeNull();
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason: 'limits_unavailable' } }]);
  });

  it('fails the job with the original error when the limits_unavailable event cannot be written', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    limits.failNext = new Error('ddb down');
    store.addEvent = async () => { throw new Error('events down'); };
    await expect(processHotLeadCallJob(jobOf())).rejects.toThrow('ddb down');
    warn.mockRestore();
    expect(provider.placedCalls).toHaveLength(0);
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
    org.hotLeadCall = { ...config, maxCallsPerHour: 3, ownerCooldownMinutes: 1 };
    const created = new Set<string>();
    mock(crmDb.getLeadById).mockImplementation(async (_l: string, id: string) => ({ ...lead, leadId: id, phone: `+1212555${String(1000 + Number(id.slice(1)))}` }));
    setLeadCallStoreForTests({
      get: async () => null,
      create: async (_l, id) => { if (created.has(id)) return false; created.add(id); return true; },
      transition: async () => true,
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
