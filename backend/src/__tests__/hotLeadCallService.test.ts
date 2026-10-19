jest.mock('../services/db', () => ({
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
import type { HotLeadCallEventType, HotLeadCallRecord, LeadCallStore } from '../services/voice/leadCallStore.types';

const mock = (fn: unknown) => fn as jest.Mock;
const OWNER_PHONE = '+14155550100';
const TWILIO_NUMBER = '+14155550111';
const LEAD_PHONE = '(212) 555-0142';
const NOW = '2026-10-19T12:00:00.000Z';

const config = {
  enabled: true, destinationPhone: OWNER_PHONE, destinationVerifiedAt: '2026-01-01T00:00:00.000Z',
  twilioNumber: TWILIO_NUMBER, announcedName: 'Acme Plumbing',
  quietHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};

class MemoryStore implements LeadCallStore {
  record: HotLeadCallRecord | null = null;
  events: Array<{ type: HotLeadCallEventType; detail?: Record<string, unknown> }> = [];
  transitionError: Error | null = null;
  async get() { return this.record; }
  async create(_l: string, _i: string, record: HotLeadCallRecord) {
    if (this.record) return false;
    this.record = record;
    return true;
  }
  async transition(_l: string, _i: string, from: HotLeadCallRecord['state'][], patch: Partial<HotLeadCallRecord> & { state: HotLeadCallRecord['state'] }) {
    if (this.transitionError) throw this.transitionError;
    if (!this.record || !from.includes(this.record.state)) return false;
    this.record = { ...this.record, ...patch };
    return true;
  }
  async addEvent(_l: string, _i: string, type: HotLeadCallEventType, detail?: Record<string, unknown>) { this.events.push({ type, detail }); }
  types() { return this.events.map(e => e.type); }
}

let provider: FakeVoiceProvider;
let store: MemoryStore;
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
  store = new MemoryStore();
  setLeadCallStoreForTests(store);
  lead = { listId: 'list-a', leadId: 'lead-a', phone: LEAD_PHONE, email: 'jane@example.com', createdAt: '2026-10-19T11:58:00.000Z', customFields: { stage: 'complete' } };
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
});

describe('dispatchHotLeadCall gates', () => {
  it('places the owner call for an eligible form fill (control for every refusal below)', async () => {
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(provider.placedCalls).toHaveLength(1);
    expect(store.record).toMatchObject({ state: 'owner_ringing', ownerCallSid: 'CA00000001' });
    expect(store.types()).toEqual(['call.initiated']);
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
    ['lead older than maxAgeMinutes', 'too_old', () => { lead.createdAt = '2026-10-19T11:49:00.000Z'; }],
    ['lead without a createdAt', 'too_old', () => { delete lead.createdAt; }],
    ['lead with an unparseable createdAt', 'too_old', () => { lead.createdAt = 'yesterday'; }],
  ];
  it.each(skipped)('records call.skipped and stops: %s', async (_name, reason, arrange) => {
    arrange();
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill');
    expect(store.events).toEqual([{ type: 'call.skipped', detail: { reason } }]);
    expect(enqueueCalls()).toHaveLength(0);
    expect(provider.placedCalls).toHaveLength(0);
  });

  it('accepts a lead exactly at the age limit and a national-format US number', async () => {
    lead.createdAt = '2026-10-19T11:50:00.000Z';
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
    await dispatchHotLeadCall('list-a', 'lead-a', 'form_fill', { submissionId: 'sub-2', submittedAt: '2026-10-19T10:00:00.000Z' });
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
    expect(store.types()).toEqual(['call.initiated']);
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
    lead.createdAt = '2026-10-19T09:00:00.000Z';
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
