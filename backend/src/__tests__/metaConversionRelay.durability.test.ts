/**
 * ENG-926 §C — durable retry for the CRM → Meta conversion relay.
 *
 * Greptile P1 on #2412. The first version dispatched fire-and-forget with no retry, so a
 * relay that failed (Meta 5xx, a token that could not refresh) or was skipped for a purely
 * temporal reason (send budget exhausted, ad account throttled by Meta) lost that
 * conversion permanently — nothing re-dispatches it, because the only trigger is a status
 * CHANGE and a won deal sits at `won` forever.
 *
 * That is this card's own failure mode reproduced inside the fix for it, which is why the
 * distinction these tests pin — terminal skip vs. retryable skip — is the whole point.
 */

const enqueueJob = jest.fn();
const markJobComplete = jest.fn().mockResolvedValue(undefined);
const markJobFailed = jest.fn().mockResolvedValue(undefined);
const startHeartbeat: jest.Mock = jest.fn(() => jest.fn());
const registerProcessor = jest.fn();
const clearFailedJob = jest.fn().mockResolvedValue(false);

jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: (...a: any[]) => enqueueJob(...a),
  markJobComplete: (...a: any[]) => markJobComplete(...a),
  markJobFailed: (...a: any[]) => markJobFailed(...a),
  startHeartbeat: (...a: any[]) => startHeartbeat(...a),
  registerProcessor: (...a: any[]) => registerProcessor(...a),
  clearFailedJob: (...a: any[]) => clearFailedJob(...a),
}));

const getLeadById = jest.fn();
const getLeadListById = jest.fn();
const updateLead = jest.fn().mockResolvedValue({});
// Exposed rather than inlined: the inline-fallback path calls relayLeadStatusEvent directly,
// which reaches userDb.getUserById — NOT crmDb.getLeadById — so only this handle can make
// that path fail. Getting that wrong made an earlier version of the test assert nothing.
const getUserById = jest.fn().mockResolvedValue(null);
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: (...a: any[]) => getLeadById(...a),
    getLeadListById: (...a: any[]) => getLeadListById(...a),
    updateLead: (...a: any[]) => updateLead(...a),
    appendMetaConversionSent: jest.fn().mockResolvedValue(undefined),
  },
  userDb: { getUserById: (...a: any[]) => getUserById(...a) },
}));

import {
  dispatchLeadStatusConversion,
  processConversionRelayJob,
  registerConversionRelayProcessor,
  RELAY_QUEUE_SOURCE,
} from '../services/metaConversionRelay';

const STATUS_CONFIG = [
  { value: 'new', label: 'New', color: 'gray', type: 'active' as const },
  { value: 'won', label: 'Won', color: 'green', type: 'won' as const },
];

const LEAD = { leadId: 'lead-1', listId: 'list-1', email: 'a@b.com', status: 'won', dealValue: 100 };

beforeEach(() => {
  jest.clearAllMocks();
  enqueueJob.mockResolvedValue('enqueued');
  clearFailedJob.mockResolvedValue(false);
  getUserById.mockResolvedValue(null);
  getLeadById.mockResolvedValue(LEAD);
  getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1', statusConfig: STATUS_CONFIG });
});

const ctx = (overrides: Record<string, any> = {}) => ({
  listId: 'list-1',
  userId: 'user-1',
  lead: LEAD,
  statusConfig: STATUS_CONFIG,
  ...overrides,
});

describe('dispatchLeadStatusConversion — queueing', () => {
  it('enqueues under a key stable per (list, lead, CONVERSION KIND), not per attempt or event name', async () => {
    await dispatchLeadStatusConversion(ctx());

    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const [source, dedupeKey, payload, options] = enqueueJob.mock.calls[0];
    expect(source).toBe(RELAY_QUEUE_SOURCE);
    // Keyed on the kind, not the emitted name: a won deal can go out as Purchase or as
    // CRMWonDeal depending on whether its value is stateable, and both are the same
    // conversion — keying on the name would let one deal queue twice.
    expect(dedupeKey).toBe('list-1:lead-1:won');
    expect(payload).toEqual({
      listId: 'list-1',
      leadId: 'lead-1',
      userId: 'user-1',
      conversionKind: 'won',
    });
    expect(options).toEqual({ claimImmediately: true });
  });

  it('does not queue anything for a status that is not a conversion', async () => {
    await dispatchLeadStatusConversion(
      ctx({ lead: { ...LEAD, status: 'new' } }),
    );

    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('does nothing further when the job is genuinely still live', async () => {
    enqueueJob.mockResolvedValue('duplicate');
    clearFailedJob.mockResolvedValue(false); // pending / processing / completed

    await dispatchLeadStatusConversion(ctx());

    expect(getLeadById).not.toHaveBeenCalled();
    expect(markJobComplete).not.toHaveBeenCalled();
  });

  it('recovers a terminally-failed job so a later transition is not blocked forever', async () => {
    // The dedupe key comes from durable business state, so without this a job that
    // exhausted its attempts makes that lead+event permanently unreachable — every later
    // genuine transition rejected as a duplicate even after Meta recovers.
    enqueueJob.mockResolvedValueOnce('duplicate').mockResolvedValueOnce('enqueued');
    clearFailedJob.mockResolvedValue(true);

    await dispatchLeadStatusConversion(ctx());

    expect(clearFailedJob).toHaveBeenCalledWith('meta_conversion_relay', 'list-1:lead-1:won');
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(getLeadById).toHaveBeenCalled();
  });

  it('gives up if the re-enqueue after clearing still does not take', async () => {
    enqueueJob.mockResolvedValue('duplicate');
    clearFailedJob.mockResolvedValue(true);

    await dispatchLeadStatusConversion(ctx());

    expect(getLeadById).not.toHaveBeenCalled();
  });

  it('retries the enqueue once before giving up on a durable record', async () => {
    // A transient write blip is a different thing from the table being unreachable, and this
    // is the last chance to record the conversion anywhere retryable.
    enqueueJob.mockResolvedValueOnce('unavailable').mockResolvedValueOnce('enqueued');

    await dispatchLeadStatusConversion(ctx());

    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(getLeadById).toHaveBeenCalled();
  });

  it('still attempts an inline send when the queue stays unreachable', async () => {
    enqueueJob.mockResolvedValue('unavailable');

    await dispatchLeadStatusConversion(ctx());

    expect(markJobFailed).not.toHaveBeenCalled();
    expect(markJobComplete).not.toHaveBeenCalled();
  });

  it('reports an inline fallback failure loudly — a lost conversion must never be silent', async () => {
    enqueueJob.mockResolvedValue('unavailable');
    // relayLeadStatusEvent catches everything and returns { failed }, so throwing from the
    // owner lookup is what drives the inline path to a genuine failure.
    getUserById.mockRejectedValue(new Error('DynamoDB down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await dispatchLeadStatusConversion(ctx());

    const said = errSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(said).toContain('cannot be retried');
    expect(said).toContain('lost');
    errSpy.mockRestore();
  });
});

describe('dispatchLeadStatusConversion — completion vs retry', () => {
  it('marks the job failed (so the poller retries) when the relay throws', async () => {
    getLeadById.mockRejectedValue(new Error('DynamoDB down'));

    await dispatchLeadStatusConversion(ctx());

    expect(markJobFailed).toHaveBeenCalledTimes(1);
    expect(markJobComplete).not.toHaveBeenCalled();
  });

  it('releases the heartbeat even when the attempt fails', async () => {
    const stop = jest.fn();
    startHeartbeat.mockReturnValue(stop);
    getLeadById.mockRejectedValue(new Error('boom'));

    await dispatchLeadStatusConversion(ctx());

    expect(stop).toHaveBeenCalled();
  });
});

describe('processConversionRelayJob — a retry re-reads state, it does not replay', () => {
  it('drops the job when the lead has since been deleted', async () => {
    getLeadById.mockResolvedValue(null);

    await expect(processConversionRelayJob({ listId: 'list-1', leadId: 'lead-1', userId: 'user-1' }))
      .resolves.toBeUndefined();
  });

  it('re-reads the lead for current state (opt-out, already-sent, contact details)', async () => {
    await processConversionRelayJob({ listId: 'list-1', leadId: 'lead-1', userId: 'user-1' }).catch(() => {});

    expect(getLeadById).toHaveBeenCalledWith('list-1', 'lead-1');
  });

  it('honours the QUEUED conversion even if the status has since moved', async () => {
    // The closed-won happened. A later status edit does not un-happen it, and deriving the
    // conversion from current status would silently omit it forever — the exact failure this
    // card exists to eliminate. Over-sending is guarded twice (metaConversionsSent, plus
    // Meta's dedup on a deterministic event_id); omission has no guard at all.
    getLeadById.mockResolvedValue({ ...LEAD, status: 'lost' });

    await processConversionRelayJob({
      listId: 'list-1',
      leadId: 'lead-1',
      userId: 'user-1',
      conversionKind: 'won',
    }).catch(() => {});

    // Reached the owner lookup, i.e. it did not bail out at "not a conversion transition".
    expect(getLeadListById).toHaveBeenCalled();
  });

  it('falls back to current status for a job queued before conversionKind existed', async () => {
    getLeadById.mockResolvedValue({ ...LEAD, status: 'won' });

    await processConversionRelayJob({ listId: 'list-1', leadId: 'lead-1', userId: 'user-1' }).catch(() => {});

    expect(getLeadListById).toHaveBeenCalled();
  });

  it('throws on a terminal-looking failure so the queue records an attempt', async () => {
    getLeadById.mockResolvedValue({ ...LEAD, status: 'won' });
    // userDb.getUserById is mocked to null → relay skips as "owner not found", terminal.
    await expect(
      processConversionRelayJob({ listId: 'list-1', leadId: 'lead-1', userId: 'user-1' }),
    ).resolves.toBeUndefined();
  });
});

describe('registerConversionRelayProcessor', () => {
  it('registers at boot so jobs left pending by a restart are not stranded', () => {
    registerConversionRelayProcessor();

    // 15, not the global default of 5: five quick attempts can be consumed by one Meta
    // incident, after which nothing retries until a human touches the lead again.
    expect(registerProcessor).toHaveBeenCalledWith(
      RELAY_QUEUE_SOURCE,
      expect.any(Function),
      { maxAttempts: 15 },
    );
  });
});
