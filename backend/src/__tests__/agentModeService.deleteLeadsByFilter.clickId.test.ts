/**
 * ENG-1176 — the destructive filter path must resolve `clickIds` the same way
 * the search path does.
 *
 * `deleteLeadsByFilter` keeps its OWN copy of the standard-field list. When
 * `clickIds` was missing from it, a bare filter fell through to
 * `lead.customFields.clickIds` — undefined on essentially every lead — so
 * `is_empty` matched EVERYTHING.
 *
 * That inverts the intent of the most natural cleanup query a user can write.
 * "Delete the leads with no click ID" selects the whole list, including the
 * attributed leads that were the entire reason for keeping it. The two-phase
 * confirm gate is the only thing standing between that and data loss, and a
 * preview that says "3 of 3" for a list with one paid lead reads as correct.
 *
 * These assert on the PREVIEW phase (confirm omitted), so nothing is deleted.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
  }
}));

jest.mock('../services/crmAccessControl', () => ({
  canDestructiveCrmList: jest.fn().mockResolvedValue(true),
  CRM_EDITOR_REQUIRED_MESSAGE: 'editor required',
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

describe('AgentModeService.deleteLeadsByFilter — click-ID resolution (ENG-1176)', () => {
  let service: AgentModeService;
  const userId = 'user-1';
  const listId = 'list-1';

  const paidLead = {
    leadId: 'lead-paid', listId, email: 'paid@example.com', firstName: 'Paid',
    clickIds: { gclid: 'Cj0-real' }, customFields: {},
  };
  const organicLead = {
    leadId: 'lead-organic', listId, email: 'organic@example.com', firstName: 'Organic',
    customFields: {},
  };
  const decoyLead = {
    leadId: 'lead-decoy', listId, email: 'decoy@example.com', firstName: 'Decoy',
    customFields: { clickIds: 'a user-authored column' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId, userId, name: 'List' });
    (mockCrmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [paidLead, organicLead, decoyLead],
      lastEvaluatedKey: undefined,
    });
  });

  it('does not select the paid lead when deleting leads with no click ID', async () => {
    // The whole point. Before the fix this previewed 3 of 3.
    const res = await service.deleteLeadsByFilter(
      listId, [{ field: 'clickIds', operator: 'is_empty' }], userId
    );
    expect(res.matchCount).toBe(2);
    const emails = (res.sampleLeads as any[]).map((l) => l.email);
    expect(emails).not.toContain('paid@example.com');
  });

  it('selects exactly the paid lead on is_not_empty', async () => {
    const res = await service.deleteLeadsByFilter(
      listId, [{ field: 'clickIds', operator: 'is_not_empty' }], userId
    );
    expect(res.matchCount).toBe(1);
    expect((res.sampleLeads as any[])[0].email).toBe('paid@example.com');
  });

  it('never treats a same-named custom field as a real click ID', async () => {
    const res = await service.deleteLeadsByFilter(
      listId, [{ field: 'clickIds', operator: 'is_not_empty' }], userId
    );
    const emails = (res.sampleLeads as any[]).map((l) => l.email);
    expect(emails).not.toContain('decoy@example.com');
  });

  it('previews rather than deletes when confirm is omitted', async () => {
    const res = await service.deleteLeadsByFilter(
      listId, [{ field: 'clickIds', operator: 'is_empty' }], userId
    );
    expect(res.requiresConfirmation).toBe(true);
    expect(res.deletedCount).toBeUndefined();
  });

  it('resolves the per-platform dot path in the destructive path too', async () => {
    const res = await service.deleteLeadsByFilter(
      listId, [{ field: 'clickIds.gclid', operator: 'equals', value: 'Cj0-real' }], userId
    );
    expect(res.matchCount).toBe(1);
    expect((res.sampleLeads as any[])[0].email).toBe('paid@example.com');
  });
});
