/**
 * The do-not-contact tool (`set_lead_contact_status`) updates leads with `crmDb.updateLead`, which is an upsert in DynamoDB: for a lead id
 * that is not in the list (already deleted, or mistyped) it created an empty stub lead. Found on 2026-11-23 while testing ENG-3170: a test
 * lead that had been deleted showed up as existing again after the tool ran on its id. A missing lead is now a failure that is reported.
 */
const mockDb = {
  getLeadListById: jest.fn(),
  getLeadById: jest.fn(),
  updateLead: jest.fn(),
};
jest.mock('../services/db', () => ({ crmDb: mockDb }));
jest.mock('../services/crmAccessControl', () => ({
  canDestructiveCrmList: jest.fn().mockResolvedValue(true),
  CRM_EDITOR_REQUIRED_MESSAGE: 'editor required',
}));

import { setLeadContactStatus } from '../emma/impl/leads';

describe('setLeadContactStatus: a lead that is not in the list is reported, never created', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.getLeadListById.mockResolvedValue({ listId: 'L1', userId: 'u1' });
    mockDb.updateLead.mockResolvedValue({});
  });

  it('updates a lead that exists', async () => {
    mockDb.getLeadById.mockResolvedValue({ listId: 'L1', leadId: 'A' });
    const r = await setLeadContactStatus('L1', ['A'], 'do-not-contact', 'opted-out', undefined, 'u1');
    expect(r).toMatchObject({ success: true, updated: 1, failed: 0, total: 1 });
    expect(mockDb.updateLead).toHaveBeenCalledTimes(1);
    expect(mockDb.updateLead.mock.calls[0][1]).toBe('A');
  });

  it('does NOT create a lead for an id that is missing: it writes nothing and reports the id', async () => {
    mockDb.getLeadById.mockResolvedValue(undefined);
    const r = await setLeadContactStatus('L1', ['GONE'], 'active', undefined, undefined, 'u1');
    expect(mockDb.updateLead).not.toHaveBeenCalled();
    expect(r).toMatchObject({ success: true, updated: 0, failed: 1, total: 1 });
    expect(r.errors).toEqual(['GONE: lead not found in this list']);
  });

  it('a mix: the lead that exists is updated, the missing one is reported, and neither stops the other', async () => {
    mockDb.getLeadById.mockImplementation(async (_list: string, id: string) => (id === 'A' ? { listId: 'L1', leadId: 'A' } : null));
    const r = await setLeadContactStatus('L1', ['A', 'GONE', 'ALSO_GONE'], 'unsubscribed', undefined, undefined, 'u1');
    expect(mockDb.updateLead).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ updated: 1, failed: 2, total: 3 });
    expect(r.errors).toEqual(['GONE: lead not found in this list', 'ALSO_GONE: lead not found in this list']);
  });

  it('reads the lead with a consistent read, so a lead just added is not reported missing by a stale read', async () => {
    mockDb.getLeadById.mockResolvedValue({ listId: 'L1', leadId: 'A' });
    await setLeadContactStatus('L1', ['A'], 'do-not-contact', undefined, undefined, 'u1');
    expect(mockDb.getLeadById).toHaveBeenCalledWith('L1', 'A', { consistentRead: true });
  });

  it('a failed lookup is a failure for that lead (nothing written), not a crash of the whole call', async () => {
    mockDb.getLeadById.mockRejectedValue(new Error('throttled'));
    const r = await setLeadContactStatus('L1', ['A'], 'do-not-contact', undefined, undefined, 'u1');
    expect(mockDb.updateLead).not.toHaveBeenCalled();
    expect(r).toMatchObject({ success: true, updated: 0, failed: 1 });
    expect(r.errors[0]).toContain('A: throttled');
  });

  it('everything else is unchanged: a bad status, no ids, too many ids, an unknown list and no access are refused before any lookup', async () => {
    expect(await setLeadContactStatus('L1', ['A'], 'nonsense', undefined, undefined, 'u1')).toMatchObject({ success: false });
    expect(await setLeadContactStatus('L1', [], 'active', undefined, undefined, 'u1')).toMatchObject({ success: false, message: 'No lead IDs provided' });
    expect(await setLeadContactStatus('L1', Array.from({ length: 201 }, (_, i) => `L${i}`), 'active', undefined, undefined, 'u1')).toMatchObject({ success: false });
    mockDb.getLeadListById.mockResolvedValue(null);
    expect(await setLeadContactStatus('L1', ['A'], 'active', undefined, undefined, 'u1')).toMatchObject({ success: false, message: 'Lead list not found' });
    expect(mockDb.getLeadById).not.toHaveBeenCalled();
  });
});
