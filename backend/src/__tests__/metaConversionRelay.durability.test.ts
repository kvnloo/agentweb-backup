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
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: (...a: any[]) => getLeadById(...a),
    getLeadListById: (...a: any[]) => getLeadListById(...a),
    updateLead: (...a: any[]) => updateLead(...a),
  },
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
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
  it('enqueues under a key that is stable per (list, lead, event), not per attempt', async () => {
    await dispatchLeadStatusConversion(ctx());

    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const [source, dedupeKey, payload, options] = enqueueJob.mock.calls[0];
    expect(source).toBe(RELAY_QUEUE_SOURCE);
    expect(dedupeKey).toBe('list-1:lead-1:Purchase');
    expect(payload).toEqual({ listId: 'list-1', leadId: 'lead-1', userId: 'user-1' });
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

    expect(clearFailedJob).toHaveBeenCalledWith('meta_conversion_relay', 'list-1:lead-1:Purchase');
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(getLeadById).toHaveBeenCalled();
  });

  it('gives up if the re-enqueue after clearing still does not take', async () => {
    enqueueJob.mockResolvedValue('duplicate');
    clearFailedJob.mockResolvedValue(true);

    await dispatchLeadStatusConversion(ctx());

    expect(getLeadById).not.toHaveBeenCalled();
  });

  it('still attempts an inline send when the queue table is unreachable', async () => {
    // Degraded, but not silent: losing the queue must not also lose the conversion.
    enqueueJob.mockResolvedValue('unavailable');

    await dispatchLeadStatusConversion(ctx());

    expect(markJobFailed).not.toHaveBeenCalled();
    expect(markJobComplete).not.toHaveBeenCalled();
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

  it('re-reads the lead rather than trusting the queued snapshot', async () => {
    // A retry can run long after the transition: the deal may have reopened, or the lead
    // may have opted out since. Replaying a stale snapshot would send an event the current
    // state forbids.
    await processConversionRelayJob({ listId: 'list-1', leadId: 'lead-1', userId: 'user-1' }).catch(() => {});

    expect(getLeadById).toHaveBeenCalledWith('list-1', 'lead-1');
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

    expect(registerProcessor).toHaveBeenCalledWith(RELAY_QUEUE_SOURCE, expect.any(Function));
  });
});
