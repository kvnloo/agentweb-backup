/**
 * ENG-1176 — a bare `clickIds` filter must resolve to the denormalized
 * top-level attribute, not to a custom field.
 *
 * The filter engine resolves a field name in three ways: a known standard
 * field, a dot path, or — failing both — `lead.customFields[name]`. So a bare
 * `clickIds` silently read `customFields.clickIds` and matched nothing, which
 * is the failure mode this whole feature exists to eliminate: not an error, a
 * confidently wrong answer. "0% of your leads carry a click ID" reads exactly
 * like a broken tag when it is really a broken lookup.
 *
 * The dot form (`clickIds.gclid`) always worked, which is what made the bare
 * form's silence easy to miss.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  }
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

describe('AgentModeService.searchLeads — click-ID filter resolution (ENG-1176)', () => {
  let service: AgentModeService;
  const userId = 'user-1';
  const listId = 'list-1';

  const paidLead = {
    leadId: 'lead-paid',
    listId,
    email: 'paid@example.com',
    firstName: 'Paid',
    clickIds: { gclid: 'Cj0-real' },
    utmSource: 'google',
    customFields: {},
  };

  const organicLead = {
    leadId: 'lead-organic',
    listId,
    email: 'organic@example.com',
    firstName: 'Organic',
    utmSource: 'newsletter',
    customFields: {},
  };

  /**
   * A lead whose CUSTOM field is called clickIds. Before the fix this was the
   * only thing a bare `clickIds` filter could ever match — so the one lead that
   * genuinely had no paid click was the one lead that matched.
   */
  const decoyLead = {
    leadId: 'lead-decoy',
    listId,
    email: 'decoy@example.com',
    firstName: 'Decoy',
    customFields: { clickIds: 'a user-authored column that means nothing' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId, userId, name: 'List' });
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    (mockCrmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [paidLead, organicLead, decoyLead],
      lastEvaluatedKey: undefined,
    });
  });

  const emails = (r: any) => (r.leads as any[]).map((l) => l.email).sort();

  it('matches the lead carrying a real click ID on a bare clickIds filter', async () => {
    const res = await service.searchLeads(
      listId, [{ field: 'clickIds', operator: 'is_not_empty' }], userId
    );
    expect(res.success).toBe(true);
    expect(emails(res)).toEqual(['paid@example.com']);
  });

  it('does not match an organic lead', async () => {
    const res = await service.searchLeads(
      listId, [{ field: 'clickIds', operator: 'is_empty' }], userId
    );
    expect(emails(res)).toEqual(['decoy@example.com', 'organic@example.com']);
  });

  it('never mistakes a same-named custom field for a real click ID', async () => {
    const res = await service.searchLeads(
      listId, [{ field: 'clickIds', operator: 'is_not_empty' }], userId
    );
    expect(emails(res)).not.toContain('decoy@example.com');
  });

  it('still resolves the per-platform dot path', async () => {
    const hit = await service.searchLeads(
      listId, [{ field: 'clickIds.gclid', operator: 'equals', value: 'Cj0-real' }], userId
    );
    expect(emails(hit)).toEqual(['paid@example.com']);

    const miss = await service.searchLeads(
      listId, [{ field: 'clickIds.fbclid', operator: 'is_not_empty' }], userId
    );
    expect(miss.leads).toHaveLength(0);
  });

  it('supports the coverage question ENG-926 §F asks', async () => {
    // "What share of this account's leads carry a click ID?" — answerable by
    // filter, without reading a single firstTouch blob.
    const paid = await service.searchLeads(
      listId, [{ field: 'clickIds', operator: 'is_not_empty' }], userId
    );
    const all = await service.searchLeads(
      listId, [{ field: 'email', operator: 'is_not_empty' }], userId
    );
    expect(paid.matchCount).toBe(1);
    expect(all.matchCount).toBe(3);
  });
});
