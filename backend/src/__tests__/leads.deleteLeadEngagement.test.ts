/**
 * ENG-3051 — delete_lead_engagement: one custom engagement removed through the
 * same guard and db call as the portal DELETE route. Mocks only.
 */
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
    deleteLeadEngagement: jest.fn(),
    getLeadEngagements: jest.fn(),
    getLeadEngagementCount: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/crmAccessControl', () => ({
  canDestructiveCrmList: jest.fn(),
  CRM_EDITOR_REQUIRED_MESSAGE: 'EDITOR_REQUIRED',
}));

import { deleteLeadEngagement, getLeadEngagements } from '../emma/impl/leads';
import { crmDb } from '../services/db';
import { canDestructiveCrmList } from '../services/crmAccessControl';
import { emmaToolRegistry } from '../emma/registry';
import { CRM_MUTATING_TOOLS } from '../emma/crmMutationEvents';

const db = crmDb as any;
const canEdit = canDestructiveCrmList as jest.Mock;
const list = { listId: 'L1', userId: 'owner' };
const custom = { eventId: 'custom_1', eventType: 'custom.linkedin_invite_sent', eventData: {}, createdAt: '2026-09-17T00:00:00Z' };
const other = { eventId: 'custom_2', eventType: 'custom.note', eventData: {}, createdAt: '2026-09-18T00:00:00Z' };
const system = { eventId: 'linkedin_sent_9_LD1', eventType: 'linkedin.message_sent', eventData: {}, createdAt: '2026-09-19T00:00:00Z' };
const lead = () => ({ leadId: 'LD1', listId: 'L1', firstName: 'Qixuan', lastName: 'Xiao', engagements: [custom, other, system] });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  db.getLeadListById.mockResolvedValue(list);
  canEdit.mockResolvedValue(true);
  db.getLeadById.mockResolvedValue(lead());
  db.deleteLeadEngagement.mockResolvedValue({ ...lead(), engagements: [other, system] });
});

describe('deleteLeadEngagement (ENG-3051)', () => {
  it('AC1: deletes exactly the named custom engagement and returns the remaining count', async () => {
    const result = await deleteLeadEngagement('L1', 'LD1', 'custom_1', 'u1');
    expect(db.deleteLeadEngagement).toHaveBeenCalledTimes(1);
    expect(db.deleteLeadEngagement).toHaveBeenCalledWith('L1', 'LD1', 'custom_1');
    expect(result).toMatchObject({
      success: true, deleted: true, eventId: 'custom_1',
      eventType: 'custom.linkedin_invite_sent', remainingEngagementCount: 2,
    });
  });

  it('AC2: a caller without editor rights is refused and nothing is written', async () => {
    canEdit.mockResolvedValue(false);
    const result = await deleteLeadEngagement('L1', 'LD1', 'custom_1', 'viewer');
    expect(canEdit).toHaveBeenCalledWith('viewer', list);
    expect(result).toEqual({ success: false, message: 'Access denied', error: 'EDITOR_REQUIRED' });
    expect(db.deleteLeadEngagement).not.toHaveBeenCalled();
    expect(db.getLeadById).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown list', () => db.getLeadListById.mockResolvedValue(null), 'list'],
    ['unknown lead', () => db.getLeadById.mockResolvedValue(null), 'lead'],
    ['unknown event_id', () => {}, 'engagement'],
  ])('AC3: %s is a not-found answer pointing at get_lead_engagements, not a failure', async (_name, arrange, what) => {
    arrange();
    const result = await deleteLeadEngagement('L1', 'LD1', what === 'engagement' ? 'nope' : 'custom_1', 'u1');
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.found).toBe(false);
    expect(result.notFound).toBe(what);
    expect(result.hint).toContain('get_lead_engagements');
    expect(result.error).toBeUndefined();
    expect(db.deleteLeadEngagement).not.toHaveBeenCalled();
  });

  it('AC3: an engagement that vanishes between the read and the write is also not-found', async () => {
    db.deleteLeadEngagement.mockRejectedValue(new Error('Engagement not found'));
    const result = await deleteLeadEngagement('L1', 'LD1', 'custom_1', 'u1');
    expect(result).toMatchObject({ success: true, deleted: false, found: false, notFound: 'engagement' });
  });

  it('AC4: a system-recorded engagement is refused and left in place', async () => {
    const result = await deleteLeadEngagement('L1', 'LD1', 'linkedin_sent_9_LD1', 'u1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('custom.');
    expect(db.deleteLeadEngagement).not.toHaveBeenCalled();
  });

  it('a db error other than not-found is reported as a failure', async () => {
    db.deleteLeadEngagement.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    const result = await deleteLeadEngagement('L1', 'LD1', 'custom_1', 'u1');
    expect(result).toMatchObject({ success: false, message: 'Failed to delete lead engagement' });
  });

  it('AC5: get_lead_engagements already returns each eventId', async () => {
    db.canOrgMemberAccessList.mockResolvedValue(true);
    db.getLeadEngagementCount.mockResolvedValue({ total: 3 });
    db.getLeadEngagements.mockResolvedValue({ engagements: [custom, other, system] });
    const result = await getLeadEngagements('L1', 'LD1', 'u1');
    expect(result.engagements.map((e: any) => e.eventId)).toEqual(['custom_1', 'custom_2', 'linkedin_sent_9_LD1']);
  });
});

describe('delete_lead_engagement registration (ENG-3051)', () => {
  it('is registered, requires list_id/lead_id/event_id, and refreshes the CRM page', async () => {
    await import('../emma/tools');
    const tool = emmaToolRegistry.getTool('delete_lead_engagement')!;
    expect(tool).toBeDefined();
    expect((tool.definition as any).inputSchema.required).toEqual(['list_id', 'lead_id', 'event_id']);
    expect(CRM_MUTATING_TOOLS.has('delete_lead_engagement')).toBe(true);
  });
});
