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
} from '../services/enrichSoLeadValidation';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

beforeEach(() => {
  jest.clearAllMocks();
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

  it('returns silently (does not throw) when service errors', async () => {
    mockEnrichSo.validateEmail.mockRejectedValue(new Error('rate limit'));
    await expect(validateLeadEmailInBackground('L1', 'LD1', 'a@b.com')).resolves.toBeUndefined();
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
