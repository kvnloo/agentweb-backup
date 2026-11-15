// Tests for enrichSoLeadValidation — background validation helper used by
// single-lead create and the opt-in CSV-import flow.

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    setLeadEmailValidation: jest.fn(),
  },
}));

const mockEnrichSo = {
  validateEmail: jest.fn(),
};
jest.mock('../services/enrichSoService', () => ({
  getEnrichSoService: () => mockEnrichSo,
}));

import {
  validateLeadEmailInBackground,
  validateLeadsInBackground,
  isEnrichSoCreditsExhausted,
  isEnrichSoCreditsRecentlyExhausted,
  setEnrichSoCreditsAlertSink,
  __resetEnrichSoCreditsStateForTesting,
  ENRICHSO_CREDITS_EXHAUSTED,
  ENRICHSO_CREDITS_EXHAUSTED_USER_MESSAGE,
} from '../services/enrichSoLeadValidation';
import { startEmailJob, getJob, __resetJobsForTesting } from '../services/emailJobTracker';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const alertSink = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  __resetEnrichSoCreditsStateForTesting();
  setEnrichSoCreditsAlertSink(alertSink);
});

describe('validateLeadEmailInBackground', () => {
  // FAIL paths
  it('returns silently when email is empty', async () => {
    await validateLeadEmailInBackground('L1', 'LD1', '');
    expect(mockEnrichSo.validateEmail).not.toHaveBeenCalled();
  });

  it('returns silently when email is whitespace', async () => {
    await validateLeadEmailInBackground('L1', 'LD1', '   ');
    expect(mockEnrichSo.validateEmail).not.toHaveBeenCalled();
  });

  it('returns null (does not throw) when service errors', async () => {
    // Returns null on service error instead of undefined so upstream callers
    // (validateLeadsInBackground) can distinguish success/failure when feeding
    // the per-lead email-job tracker counters.
    mockEnrichSo.validateEmail.mockRejectedValue(new Error('rate limit'));
    await expect(validateLeadEmailInBackground('L1', 'LD1', 'a@b.com')).resolves.toBeNull();
    expect(mockCrmDb.setLeadEmailValidation).not.toHaveBeenCalled();
  });

  it('lead-deleted case is handled by the targeted DB method (silent no-op via ConditionExpression)', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'deliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-04',
    });
    // setLeadEmailValidation swallows ConditionalCheckFailedException internally,
    // so the helper just calls it and the DB layer no-ops.
    mockCrmDb.setLeadEmailValidation.mockResolvedValue(undefined);

    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com');

    expect(mockCrmDb.setLeadEmailValidation).toHaveBeenCalledTimes(1);
  });

  // SUCCESS path — uses targeted DB write (M4 fix)
  it('persists email_validation via setLeadEmailValidation (avoids clobbering customFields)', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'undeliverable', confidence: 'high', isCatchAll: false,
      provider: 'GOOGLE', message: 'mailbox not found',
      fromCache: false, checkedAt: '2026-05-04T00:00:00Z',
    });
    mockCrmDb.setLeadEmailValidation.mockResolvedValue(undefined);

    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com');

    expect(mockEnrichSo.validateEmail).toHaveBeenCalledWith('a@b.com', {});
    expect(mockCrmDb.setLeadEmailValidation).toHaveBeenCalledTimes(1);
    const [listId, leadId, validation, metadata] =
      mockCrmDb.setLeadEmailValidation.mock.calls[0] as any;
    expect(listId).toBe('L1');
    expect(leadId).toBe('LD1');
    expect(validation).toMatchObject({ status: 'undeliverable', confidence: 'high' });
    expect(metadata).toMatchObject({ source: 'web_search', confidence: 'high' });
  });

  it('does NOT do a read-modify-write on customFields (M4 regression check)', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'deliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-04',
    });
    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com');
    // The whole point of the M4 fix: no getLeadById, no full updateLead.
    expect(mockCrmDb.getLeadById).not.toHaveBeenCalled();
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });
});

describe('validateLeadsInBackground', () => {
  it('skips leads without email', async () => {
    await validateLeadsInBackground('L1', [
      { leadId: 'LD1', email: '' },
      { leadId: 'LD2', email: undefined as any },
    ]);
    expect(mockEnrichSo.validateEmail).not.toHaveBeenCalled();
  });

  it('validates all leads with email in parallel', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'deliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-04',
    });
    mockCrmDb.setLeadEmailValidation.mockResolvedValue(undefined);

    await validateLeadsInBackground('L1', [
      { leadId: 'LD1', email: 'a@b.com' },
      { leadId: 'LD2', email: 'c@d.com' },
      { leadId: 'LD3', email: '' },  // skipped
    ]);

    expect(mockEnrichSo.validateEmail).toHaveBeenCalledTimes(2);
    expect(mockCrmDb.setLeadEmailValidation).toHaveBeenCalledTimes(2);
  });

  it('one lead failure does not block the others', async () => {
    mockEnrichSo.validateEmail
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        status: 'deliverable', confidence: 'high', isCatchAll: false,
        fromCache: false, checkedAt: '2026-05-04',
      });
    mockCrmDb.setLeadEmailValidation.mockResolvedValue(undefined);

    await validateLeadsInBackground('L1', [
      { leadId: 'LD1', email: 'a@b.com' },
      { leadId: 'LD2', email: 'c@d.com' },
    ]);

    // First call failed → no DB write; second succeeded → 1 DB write
    expect(mockCrmDb.setLeadEmailValidation).toHaveBeenCalledTimes(1);
  });
});

// ─── auto-DNC plumbed through opts ───────────────────────────────────────────
// Bulk route passes autoDncOnFailure: true; worker should mark each
// undeliverable/risky lead as do-not-contact (unless already DNC/unsub).

describe('validateLeadEmailInBackground — autoDncOnFailure', () => {
  beforeEach(() => {
    mockCrmDb.setLeadEmailValidation.mockResolvedValue(undefined);
  });

  it('undeliverable + autoDnc=true → fetches lead and marks DNC', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'undeliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-08',
    });
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', contactStatus: 'active' } as any);

    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com', 'u1', { autoDncOnFailure: true });

    expect(mockCrmDb.updateLead).toHaveBeenCalledTimes(1);
    const [, , updates] = mockCrmDb.updateLead.mock.calls[0] as any;
    expect(updates).toMatchObject({
      contactStatus: 'do-not-contact',
      contactStatusReason: 'bounced',
      contactStatusUpdatedBy: 'u1',
    });
  });

  it('risky + autoDnc=true → does NOT mark DNC (risky is intentionally excluded)', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'risky', confidence: 'medium', isCatchAll: true,
      fromCache: false, checkedAt: '2026-05-08',
    });

    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com', 'u1', { autoDncOnFailure: true });

    expect(mockCrmDb.getLeadById).not.toHaveBeenCalled();
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('deliverable + autoDnc=true → does NOT touch lead', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'deliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-08',
    });

    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com', 'u1', { autoDncOnFailure: true });

    expect(mockCrmDb.getLeadById).not.toHaveBeenCalled();
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('undeliverable + autoDnc not set → does NOT touch lead (preserves existing callers)', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'undeliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-08',
    });

    // No opts → CSV import / single-create callers don't trip on this.
    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com', 'u1');

    expect(mockCrmDb.getLeadById).not.toHaveBeenCalled();
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('lead already DNC → preserves it (no overwrite)', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'undeliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-08',
    });
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1',
      contactStatus: 'do-not-contact',
      contactStatusReason: 'requested-removal',
    } as any);

    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com', 'u1', { autoDncOnFailure: true });

    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('lead already unsubscribed → preserves it (no overwrite)', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'undeliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-08',
    });
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1',
      contactStatus: 'unsubscribed',
    } as any);

    await validateLeadEmailInBackground('L1', 'LD1', 'a@b.com', 'u1', { autoDncOnFailure: true });

    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('updateLead failure does not throw — DNC flip is best-effort', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'undeliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-08',
    });
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1' } as any);
    mockCrmDb.updateLead.mockRejectedValue(new Error('throttled'));

    await expect(
      validateLeadEmailInBackground('L1', 'LD1', 'a@b.com', 'u1', { autoDncOnFailure: true }),
    ).resolves.toEqual({ status: 'undeliverable' });
  });
});

describe('validateLeadsInBackground — autoDncOnFailure plumbed', () => {
  it('passes autoDncOnFailure through to per-lead worker', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'undeliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-08',
    });
    mockCrmDb.setLeadEmailValidation.mockResolvedValue(undefined);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', contactStatus: 'active' } as any);

    await validateLeadsInBackground(
      'L1',
      [{ leadId: 'LD1', email: 'a@b.com' }],
      'u1',
      undefined,
      { autoDncOnFailure: true },
    );

    expect(mockCrmDb.updateLead).toHaveBeenCalledTimes(1);
    expect((mockCrmDb.updateLead.mock.calls[0] as any)[2]).toMatchObject({
      contactStatus: 'do-not-contact',
    });
  });

  it('without opts → no DNC flips (back-compat with existing callers)', async () => {
    mockEnrichSo.validateEmail.mockResolvedValue({
      status: 'undeliverable', confidence: 'high', isCatchAll: false,
      fromCache: false, checkedAt: '2026-05-08',
    });
    mockCrmDb.setLeadEmailValidation.mockResolvedValue(undefined);

    await validateLeadsInBackground('L1', [{ leadId: 'LD1', email: 'a@b.com' }]);

    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });
});

// ─── ENG-2983: 402 / out-of-credits is surfaced, not swallowed ──────────────

function axiosErr(status: number): any {
  const e: any = new Error(`Request failed with status code ${status}`);
  e.response = { status };
  return e;
}

describe('ENG-2983 enrich.so credit exhaustion', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    __resetJobsForTesting();
  });
  afterEach(() => errSpy.mockRestore());

  it('classifies 402 (incl. cached plain-Error rethrow) but not 5xx/429', () => {
    expect(isEnrichSoCreditsExhausted(axiosErr(402))).toBe(true);
    expect(isEnrichSoCreditsExhausted(new Error('Request failed with status code 402'))).toBe(true);
    expect(isEnrichSoCreditsExhausted(new Error('Insufficient credits'))).toBe(true);
    expect(isEnrichSoCreditsExhausted(axiosErr(503))).toBe(false);
    expect(isEnrichSoCreditsExhausted(axiosErr(429))).toBe(false);
  });

  it('402: logs at error level with the stable class, alerts once, returns null (no throw)', async () => {
    mockEnrichSo.validateEmail.mockRejectedValue(axiosErr(402));
    await expect(validateLeadEmailInBackground('L1', 'LD1', 'a@b.com')).resolves.toBeNull();
    await expect(validateLeadEmailInBackground('L1', 'LD2', 'c@d.com')).resolves.toBeNull();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes(ENRICHSO_CREDITS_EXHAUSTED))).toBe(true);
    expect(alertSink).toHaveBeenCalledTimes(1); // deduped, not per-lead
    expect(alertSink.mock.calls[0][0].errorClass).toBe(ENRICHSO_CREDITS_EXHAUSTED);
    expect(isEnrichSoCreditsRecentlyExhausted()).toBe(true);
    expect(mockCrmDb.setLeadEmailValidation).not.toHaveBeenCalled();
  });

  it('transient 5xx: no alert, no credits latch, still returns null', async () => {
    mockEnrichSo.validateEmail.mockRejectedValue(axiosErr(503));
    await expect(validateLeadEmailInBackground('L1', 'LD1', 'a@b.com')).resolves.toBeNull();
    expect(alertSink).not.toHaveBeenCalled();
    expect(isEnrichSoCreditsRecentlyExhausted()).toBe(false);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes(ENRICHSO_CREDITS_EXHAUSTED))).toBe(false);
  });

  it('bulk job: 402 stops further calls and completes the job with an explicit error', async () => {
    mockEnrichSo.validateEmail.mockRejectedValue(axiosErr(402));
    const leads = Array.from({ length: 30 }, (_, i) => ({ leadId: `LD${i}`, email: `x${i}@b.com` }));
    const job = startEmailJob({ kind: 'validate', listId: 'L1', userId: 'u1', total: leads.length });
    await validateLeadsInBackground('L1', leads, 'u1', job.jobId);
    const state = getJob(job.jobId)!;
    expect(state.status).toBe('error');
    expect(state.errorMessage).toBe(ENRICHSO_CREDITS_EXHAUSTED_USER_MESSAGE);
    // at most one in-flight call per concurrency runner, not all 30
    expect(mockEnrichSo.validateEmail.mock.calls.length).toBeLessThan(leads.length);
    expect(alertSink).toHaveBeenCalledTimes(1);
  });

  it('bulk job: transient 5xx keeps going and completes without error', async () => {
    mockEnrichSo.validateEmail.mockRejectedValue(axiosErr(500));
    const leads = [{ leadId: 'A', email: 'a@b.com' }, { leadId: 'B', email: 'c@d.com' }];
    const job = startEmailJob({ kind: 'validate', listId: 'L1', userId: 'u1', total: 2 });
    await validateLeadsInBackground('L1', leads, 'u1', job.jobId);
    expect(getJob(job.jobId)!.status).toBe('completed');
    expect(mockEnrichSo.validateEmail).toHaveBeenCalledTimes(2);
  });
});
