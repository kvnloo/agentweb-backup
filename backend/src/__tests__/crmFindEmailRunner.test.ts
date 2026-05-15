// Tests for the extracted background bulk find-email runner.
// The runner was previously a non-exported async function inside
// routes/crmEnrichSo.ts; pulling it into services/ lets other services
// (e.g. agentModeService.autoEnrich) call it without a route → service
// import smell.

jest.mock('../services/db', () => ({
  crmDb: {
    setLeadFields: jest.fn(),
    mergeFieldNames: jest.fn(),
  },
}));

jest.mock('../services/enrichmentIdentityResolver', () => ({
  resolveIdentity: jest.fn(),
}));

jest.mock('../services/enrichmentV3RealDeps', () => ({
  buildIdentityDeps: jest.fn().mockReturnValue({}),
}));

jest.mock('../services/emailJobTracker', () => ({
  startEmailJob: jest.fn(),
  recordResult: jest.fn(),
  completeJob: jest.fn(),
  getJob: jest.fn(),
}));
jest.mock('../services/enrichSoLeadValidation', () => ({
  validateLeadEmailInBackground: jest.fn(),
}));

import { findEmailsForLeadsInBackground } from '../services/crmFindEmailRunner';
import { crmDb } from '../services/db';
import { resolveIdentity } from '../services/enrichmentIdentityResolver';
import { recordResult, completeJob } from '../services/emailJobTracker';
import { validateLeadEmailInBackground } from '../services/enrichSoLeadValidation';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockResolve = resolveIdentity as jest.Mock;
const mockRecord = recordResult as jest.Mock;
const mockComplete = completeJob as jest.Mock;
const mockValidate = validateLeadEmailInBackground as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('findEmailsForLeadsInBackground', () => {
  it('exports a callable async function', () => {
    expect(typeof findEmailsForLeadsInBackground).toBe('function');
  });

  it('completes the job with no work when leads array is empty', async () => {
    await findEmailsForLeadsInBackground('list1', [], 'u1', 'job_a');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockCrmDb.mergeFieldNames).toHaveBeenCalledWith('list1', new Set());
    expect(mockComplete).toHaveBeenCalledWith('job_a');
  });

  it('records found:false and skips resolver for leads without name+org or linkedin', async () => {
    const leads = [
      { leadId: 'l1', firstName: '', lastName: '', company: '', linkedin: '' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_b');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith('job_b', { found: false });
    expect(mockComplete).toHaveBeenCalledWith('job_b');
  });

  it('records found:true and validates email when resolver returns an email', async () => {
    mockResolve.mockResolvedValueOnce({
      ok: true,
      resolved: { email: 'jane@acme.com', firstName: 'Jane' },
      siblings: [],
    });
    const leads = [
      { leadId: 'l1', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_c');
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'enrich', listId: 'list1', leadHint: { listId: 'list1', leadId: 'l1' } }),
      expect.any(Object),
    );
    expect(mockCrmDb.mergeFieldNames).toHaveBeenCalledWith('list1', new Set(['email', 'firstName']));
    expect(mockValidate).toHaveBeenCalledWith('list1', 'l1', 'jane@acme.com', 'u1');
    expect(mockRecord).toHaveBeenCalledWith('job_c', { found: true, tier: undefined });
    expect(mockComplete).toHaveBeenCalledWith('job_c');
  });

  it('records found:false when resolver returns ok:false', async () => {
    mockResolve.mockResolvedValueOnce({ ok: false, reason: 'identity_unresolvable' });
    const leads = [
      { leadId: 'l1', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_d');
    expect(mockRecord).toHaveBeenCalledWith('job_d', { found: false });
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('records found:false when resolver returns ok:true but no email', async () => {
    mockResolve.mockResolvedValueOnce({ ok: true, resolved: { firstName: 'Jane' }, siblings: [] });
    const leads = [
      { leadId: 'l1', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_e');
    expect(mockRecord).toHaveBeenCalledWith('job_e', { found: false });
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('continues when an individual lead errors and completes the job', async () => {
    mockResolve
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: false, reason: 'identity_unresolvable' });
    const leads = [
      { leadId: 'l1', firstName: 'A', lastName: 'B', company: 'X' },
      { leadId: 'l2', firstName: 'C', lastName: 'D', company: 'Y' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_f');
    expect(mockComplete).toHaveBeenCalledWith('job_f');
    expect(mockRecord).toHaveBeenCalledWith('job_f', { found: false, error: true });
  });

  it('runs without a jobId (uses null/undefined and skips tracker calls)', async () => {
    mockResolve.mockResolvedValueOnce({ ok: false, reason: 'identity_unresolvable' });
    const leads = [
      { leadId: 'l1', firstName: 'Z', lastName: 'Z', company: 'Z' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('excludes emailDomain from populatedFieldNames', async () => {
    mockResolve.mockResolvedValueOnce({
      ok: true,
      resolved: { email: 'jane@acme.com', emailDomain: 'acme.com' },
      siblings: [],
    });
    const leads = [{ leadId: 'l1', firstName: 'Jane', lastName: 'Doe', company: 'Acme' }];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_g');
    expect(mockCrmDb.mergeFieldNames).toHaveBeenCalledWith('list1', new Set(['email']));
  });
});
