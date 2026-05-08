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

jest.mock('../services/enrichmentWaterfall', () => ({
  waterfallFindEmail: jest.fn(),
}));

jest.mock('../services/applyApolloMatchToLead', () => ({
  applyApolloMatchToLead: jest.fn(),
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
import { waterfallFindEmail } from '../services/enrichmentWaterfall';
import { applyApolloMatchToLead } from '../services/applyApolloMatchToLead';
import { recordResult, completeJob } from '../services/emailJobTracker';
import { validateLeadEmailInBackground } from '../services/enrichSoLeadValidation';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockWaterfall = waterfallFindEmail as jest.Mock;
const mockApply = applyApolloMatchToLead as jest.Mock;
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
    expect(mockWaterfall).not.toHaveBeenCalled();
    expect(mockCrmDb.setLeadFields).not.toHaveBeenCalled();
    expect(mockCrmDb.mergeFieldNames).toHaveBeenCalledWith('list1', new Set());
    expect(mockComplete).toHaveBeenCalledWith('job_a');
  });

  it('records found:false and skips waterfall for leads without name+org or linkedin', async () => {
    const leads = [
      { leadId: 'l1', firstName: '', lastName: '', company: '', linkedin: '' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_b');
    expect(mockWaterfall).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith('job_b', { found: false });
    expect(mockComplete).toHaveBeenCalledWith('job_b');
  });

  it('writes the email when waterfall returns a non-Apollo hit', async () => {
    mockWaterfall.mockResolvedValueOnce({
      found: true,
      email: 'jane@acme.com',
      provider: 'enrich.so',
      confidence: 'high',
      tier: 1,
    });
    const leads = [
      { leadId: 'l1', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_c');
    expect(mockWaterfall).toHaveBeenCalledTimes(1);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockCrmDb.setLeadFields).toHaveBeenCalledWith(
      'list1',
      'l1',
      expect.objectContaining({
        topLevel: { email: 'jane@acme.com' },
        enrichmentMetadata: expect.objectContaining({
          email: expect.objectContaining({
            source: 'web_search',
            provider: 'enrich.so',
            confidence: 'high',
          }),
        }),
      }),
    );
    expect(mockCrmDb.mergeFieldNames).toHaveBeenCalledWith('list1', new Set(['email']));
    expect(mockValidate).toHaveBeenCalledWith('list1', 'l1', 'jane@acme.com', 'u1');
    expect(mockRecord).toHaveBeenCalledWith('job_c', { found: true, tier: 1 });
    expect(mockComplete).toHaveBeenCalledWith('job_c');
  });

  it('projects Apollo match payload onto the lead when waterfall returns apolloMatch', async () => {
    mockWaterfall.mockResolvedValueOnce({
      found: true,
      email: 'jane@acme.com',
      apolloMatch: { person: { name: 'Jane Doe' } },
      emailStatus: 'verified',
      tier: 2,
    });
    mockApply.mockReturnValueOnce({
      updates: { email: 'jane@acme.com', title: 'CTO' },
      enrichmentMetadata: { email: { source: 'web_search', sourceQuote: 'Apollo' } },
      customFields: {},
      changed: ['email', 'title'],
    });
    const leads = [
      { leadId: 'l2', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_d');
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockCrmDb.setLeadFields).toHaveBeenCalledWith(
      'list1',
      'l2',
      {
        topLevel: { email: 'jane@acme.com', title: 'CTO' },
        enrichmentMetadata: { email: { source: 'web_search', sourceQuote: 'Apollo (verified)' } },
        customFields: {},
      },
    );
    expect(mockCrmDb.mergeFieldNames).toHaveBeenCalledWith('list1', new Set(['email', 'title']));
    expect(mockValidate).toHaveBeenCalledWith('list1', 'l2', 'jane@acme.com', 'u1');
  });

  it('continues when an individual lead errors and completes the job', async () => {
    mockWaterfall
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ found: false });
    const leads = [
      { leadId: 'l1', firstName: 'A', lastName: 'B', company: 'X' },
      { leadId: 'l2', firstName: 'C', lastName: 'D', company: 'Y' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_e');
    expect(mockComplete).toHaveBeenCalledWith('job_e');
    expect(mockRecord).toHaveBeenCalledWith('job_e', { found: false, error: true });
  });

  it('runs without a jobId (uses null/undefined and skips tracker calls)', async () => {
    mockWaterfall.mockResolvedValueOnce({ found: false });
    const leads = [
      { leadId: 'l1', firstName: 'Z', lastName: 'Z', company: 'Z' },
    ];
    await findEmailsForLeadsInBackground('list1', leads, 'u1');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('falls back to waterfall email if Apollo projection misses email', async () => {
    mockWaterfall.mockResolvedValueOnce({
      found: true,
      email: 'fallback@acme.com',
      apolloMatch: { person: { name: 'Jane Doe' } },
      tier: 2,
    });
    mockApply.mockReturnValueOnce({
      updates: { title: 'CTO' },
      enrichmentMetadata: {},
      customFields: {},
      changed: ['title'],
    });
    const leads = [{ leadId: 'l3', firstName: 'Jane', lastName: 'Doe', company: 'Acme' }];

    await findEmailsForLeadsInBackground('list1', leads, 'u1', 'job_f');

    expect(mockCrmDb.setLeadFields).toHaveBeenCalledWith(
      'list1',
      'l3',
      expect.objectContaining({ topLevel: { title: 'CTO', email: 'fallback@acme.com' } }),
    );
    expect(mockValidate).toHaveBeenCalledWith('list1', 'l3', 'fallback@acme.com', 'u1');
  });
});
