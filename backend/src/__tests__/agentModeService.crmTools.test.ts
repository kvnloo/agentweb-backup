/**
 * Unit tests for AgentModeService - CRM Management Tools
 * Tests cover: getLeads, searchLeads, getLeadDetails, updateLead, deleteLeads,
 *              updateLeadList, deleteLeadList, getLeadEngagements, addLeadEngagement, sendEmailToLead
 */

// Mock dependencies
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadsByICPFlag: jest.fn(),
    getLeadsByEngagedFlag: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    batchCreateLeads: jest.fn(),
    deleteLead: jest.fn(),
    updateLeadList: jest.fn(),
    deleteLeadList: jest.fn(),
    getLeadEngagementCount: jest.fn(),
    getLeadEngagements: jest.fn(),
    addLeadEngagement: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  }
}));

jest.mock('../services/gmailService', () => ({
  gmailService: {
    sendEmail: jest.fn(),
  }
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb, userDb, orgDb } from '../services/db';
import { resendService } from '../services/resendService';
import { gmailService } from '../services/gmailService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockResend = resendService as jest.Mocked<typeof resendService>;
const mockGmail = gmailService as jest.Mocked<typeof gmailService>;

describe('AgentModeService - CRM Tools', () => {
  let service: AgentModeService;
  const userId = 'user-123';
  const listId = 'list-abc';
  const leadId = 'lead-xyz';

  const mockList = {
    listId,
    userId,
    name: 'Test List',
    description: 'Test description',
    leadCount: 5,
    listSenderId: 'sender-default',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const mockLead = {
    leadId,
    listId,
    email: 'john@acme.com',
    firstName: 'John',
    lastName: 'Doe',
    company: 'Acme Corp',
    title: 'VP Engineering',
    phone: '555-0100',
    notes: 'Met at conference',
    linkedin: 'https://linkedin.com/in/johndoe',
    customFields: { industry: 'Tech', employees: '500' },
    icpMatch: { isMatch: true, score: 85 },
    isEngaged: true,
    engagementCount: 3,
    emailDraft: null,
    messageDraft: null,
    selectedSenderId: null,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };

  // Fixtures for canDestructiveCrmList (ENG-1049) — same-org users plus an org
  // fixture with a configurable `crm.editors` list and `ownerUserId`.
  const listOwnerId = 'list-owner-id';
  const orgMemberId = 'org-member-id';
  const orgId = 'org-A';
  function setSameOrgUsers() {
    mockUserDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(id === listOwnerId ? ({ userId: listOwnerId, orgId } as any) : ({ userId: id, orgId } as any))
    );
  }
  function orgWithCrm(overrides: Record<string, any> = {}) {
    return {
      orgId,
      ownerUserId: 'org-owner-id',
      shareSettings: { crm: { enabled: true, editors: [] as string[] } },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    // Default: caller has org access to the list (owner or same-org member).
    // clearAllMocks() does not reset implementations, so set this deterministically
    // on every test; deny tests override to false explicitly.
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
  });

  // ─── getLeads ──────────────────────────────────────────────────────────

  describe('getLeads', () => {
    beforeEach(() => {
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    });

    it('should return leads from a list', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, {});

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].email).toBe('john@acme.com');
      expect(result.leads[0].company).toBe('Acme Corp');
      expect(result.listName).toBe('Test List');
      expect(mockCrmDb.getLeadListById).toHaveBeenCalledWith(listId);
    });

    it('should filter by text search', async () => {
      const noMatchLead = { ...mockLead, leadId: 'lead-2', email: 'jane@other.com', firstName: 'Jane', lastName: 'Smith', company: 'Other Inc', title: 'Designer', customFields: {} };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, noMatchLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, { search: 'Acme' });

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].company).toBe('Acme Corp');
    });

    it('should filter by ICP using index', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByICPFlag.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, { icpOnly: true });

      expect(result.success).toBe(true);
      expect(mockCrmDb.getLeadsByICPFlag).toHaveBeenCalledWith(listId, 1, 200, undefined);
      expect(result.leads).toHaveLength(1);
    });

    it('should filter by engaged using index', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByEngagedFlag.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, { engagedOnly: true });

      expect(result.success).toBe(true);
      expect(mockCrmDb.getLeadsByEngagedFlag).toHaveBeenCalledWith(listId, 1, 200, undefined);
    });

    it('should return access denied for wrong user', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other-user' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);

      const result = await service.getLeads(listId, userId, {});

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
    });

    it('should return not found for missing list', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null as any);

      const result = await service.getLeads(listId, userId, {});

      expect(result.success).toBe(false);
      expect(result.message).toBe('Lead list not found');
    });

    it('should respect limit parameter', async () => {
      const leads = Array.from({ length: 5 }, (_, i) => ({ ...mockLead, leadId: `lead-${i}` }));
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: leads,
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, { limit: 2 });

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(2);
    });

    it('should cap limit at 100', async () => {
      const leads = Array.from({ length: 110 }, (_, i) => ({ ...mockLead, leadId: `lead-${i}` }));
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: leads,
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, { limit: 200 });

      expect(result.leads.length).toBeLessThanOrEqual(100);
    });

    it('should return next_cursor and has_more when more results exist', async () => {
      const dynKey = { pk: 'lead-xyz', sk: 'list-abc' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: dynKey,
      } as any);

      const result = await service.getLeads(listId, userId, { limit: 1 });

      expect(result.success).toBe(true);
      expect(result.has_more).toBe(true);
      expect(result.next_cursor).toBe(Buffer.from(JSON.stringify(dynKey)).toString('base64'));
    });

    it('should return has_more false and no next_cursor when no more results', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, {});

      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeUndefined();
    });

    it('should accept cursor input and pass decoded key to DB', async () => {
      const dynKey = { pk: 'lead-xyz' };
      const encodedCursor = Buffer.from(JSON.stringify(dynKey)).toString('base64');

      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, { cursor: encodedCursor });

      expect(result.success).toBe(true);
      expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledWith(listId, expect.any(Number), dynKey);
    });

    it('should ignore invalid cursor and start from beginning', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, { cursor: 'not-valid-base64!!!' });

      expect(result.success).toBe(true);
      expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledWith(listId, expect.any(Number), undefined);
    });

    it('should search custom fields', async () => {
      const leadWithCustom = { ...mockLead, firstName: 'Bob', company: 'XYZ', customFields: { sector: 'Healthcare' } };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [leadWithCustom],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.getLeads(listId, userId, { search: 'Healthcare' });

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
    });
  });

  // ─── searchLeads ───────────────────────────────────────────────────────

  describe('searchLeads', () => {
    beforeEach(() => {
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    });

    it('should filter by equals operator (case insensitive)', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', company: 'Other Inc' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'equals', value: 'acme corp' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].company).toBe('Acme Corp');
    });

    it('should filter by contains operator', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', title: 'Designer' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'title', operator: 'contains', value: 'VP' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
    });

    it('should filter by icpScore greater_than', async () => {
      const lowScoreLead = { ...mockLead, leadId: 'lead-2', icpMatch: { isMatch: false, score: 30 } };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, lowScoreLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'icpScore', operator: 'greater_than', value: 80 }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].icpScore).toBe(85);
    });

    it('should filter by custom field', async () => {
      const techLead = { ...mockLead, customFields: { industry: 'Tech' } };
      const financeLead = { ...mockLead, leadId: 'lead-2', customFields: { industry: 'Finance' } };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [techLead, financeLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'industry', operator: 'equals', value: 'Tech' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
    });

    it('should apply AND logic for multiple filters', async () => {
      const lead2 = { ...mockLead, leadId: 'lead-2', title: 'Designer', company: 'Acme Corp' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, lead2],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'equals', value: 'Acme Corp' },
        { field: 'title', operator: 'contains', value: 'VP' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].leadId).toBe(leadId);
    });

    // ─── in / not_in operators (Phase 1 infrastructure for v3.1 Req C) ───────

    it("should filter by 'in' operator against an array value (case insensitive)", async () => {
      const acmeLead = { ...mockLead, leadId: 'lead-1', company: 'Acme Corp' };
      const fintechLead = { ...mockLead, leadId: 'lead-2', company: 'Fintech Inc' };
      const otherLead = { ...mockLead, leadId: 'lead-3', company: 'Other Co' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [acmeLead, fintechLead, otherLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'in', value: ['acme corp', 'FINTECH INC'] },
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads.map((l: any) => l.leadId).sort()).toEqual(['lead-1', 'lead-2']);
    });

    it("'in' with an empty array matches no leads", async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'in', value: [] },
      ], userId);

      expect(result.leads).toHaveLength(0);
    });

    it("'in' with a non-array value matches no leads (malformed filter, fail safe)", async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'in', value: 'Acme Corp' as any },
      ], userId);

      expect(result.leads).toHaveLength(0);
    });

    it("should filter by 'not_in' operator (negation of in)", async () => {
      const acmeLead = { ...mockLead, leadId: 'lead-1', company: 'Acme Corp' };
      const otherLead = { ...mockLead, leadId: 'lead-2', company: 'Other Co' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [acmeLead, otherLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'not_in', value: ['Acme Corp'] },
      ], userId);

      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].leadId).toBe('lead-2');
    });

    it("'not_in' with empty array matches ALL leads (exclude list is empty)", async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', company: 'Other' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'not_in', value: [] },
      ], userId);

      expect(result.leads).toHaveLength(2);
    });

    it("'in' works on customFields too (industry in [SaaS, Tech])", async () => {
      const techLead = { ...mockLead, leadId: 'lead-1', customFields: { industry: 'Tech' } };
      const finLead = { ...mockLead, leadId: 'lead-2', customFields: { industry: 'Finance' } };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [techLead, finLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'industry', operator: 'in', value: ['SaaS', 'Tech'] },
      ], userId);

      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].leadId).toBe('lead-1');
    });

    it('should handle is_empty and is_not_empty operators', async () => {
      const noPhoneLead = { ...mockLead, leadId: 'lead-2', phone: '' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, noPhoneLead],
        lastEvaluatedKey: undefined,
      } as any);

      const emptyResult = await service.searchLeads(listId, [
        { field: 'phone', operator: 'is_empty' }
      ], userId);
      expect(emptyResult.leads).toHaveLength(1);
      expect(emptyResult.leads[0].leadId).toBe('lead-2');

      const notEmptyResult = await service.searchLeads(listId, [
        { field: 'phone', operator: 'is_not_empty' }
      ], userId);
      expect(notEmptyResult.leads).toHaveLength(1);
      expect(notEmptyResult.leads[0].leadId).toBe(leadId);
    });

    it('should return error when no filters provided', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);

      const result = await service.searchLeads(listId, [], userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('filter');
    });

    it('should handle starts_with operator', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', email: 'jane@other.com' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'email', operator: 'starts_with', value: 'john' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
    });

    it('should handle not_equals operator', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', company: 'Other Inc' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'not_equals', value: 'Acme Corp' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].company).toBe('Other Inc');
    });

    it('should handle less_than operator', async () => {
      const lowScoreLead = { ...mockLead, leadId: 'lead-2', icpMatch: { isMatch: false, score: 30 } };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, lowScoreLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'icpScore', operator: 'less_than', value: 50 }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].icpScore).toBe(30);
    });

    it('should support ilike operator with contains pattern (%text%)', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', company: 'Beta LLC' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'ilike', value: '%Acme%' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].company).toBe('Acme Corp');
    });

    it('should support ilike operator with starts_with pattern (text%)', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', email: 'jane@other.com' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'email', operator: 'ilike', value: 'john%' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].email).toBe('john@acme.com');
    });

    it('should support ilike operator with ends_with pattern (%text)', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', email: 'jane@gmail.com' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'email', operator: 'ilike', value: '%@acme.com' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].email).toBe('john@acme.com');
    });

    it('should support ilike operator case-insensitively', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, { ...mockLead, leadId: 'lead-2', company: 'Beta LLC' }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'ilike', value: '%acme%' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
    });

    it('should support cross-field keyword search', async () => {
      const lead2 = { ...mockLead, leadId: 'lead-2', email: 'jane@beta.com', firstName: 'Jane', company: 'Beta LLC' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, lead2],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'equals', value: 'Acme Corp' }
      ], userId, undefined, { search: 'Acme' });

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].company).toBe('Acme Corp');
    });

    it('should apply search AND filters together', async () => {
      const lead2 = { ...mockLead, leadId: 'lead-2', title: 'Designer', company: 'Acme Corp' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead, lead2],
        lastEvaluatedKey: undefined,
      } as any);

      // Search for "Acme" AND filter title contains "VP"
      const result = await service.searchLeads(listId, [
        { field: 'title', operator: 'contains', value: 'VP' }
      ], userId, undefined, { search: 'Acme' });

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].leadId).toBe(leadId);
    });

    it('should return next_cursor and has_more when more results exist', async () => {
      const dynKey = { pk: 'lead-xyz' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: dynKey,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'equals', value: 'Acme Corp' }
      ], userId, 1);

      expect(result.success).toBe(true);
      expect(result.has_more).toBe(true);
      // The cursor is anchored to the last scanned leadId (lead-level cursor),
      // not the underlying DynamoDB page-end key, so paging never skips leads.
      expect(result.next_cursor).toBe(
        Buffer.from(JSON.stringify({ listId, leadId: mockLead.leadId })).toString('base64')
      );
    });

    it('should return has_more false when no more results', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'company', operator: 'equals', value: 'Acme Corp' }
      ], userId);

      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeUndefined();
    });

    it('should accept cursor input and pass decoded key to DB', async () => {
      // Cursors emitted by searchLeads are anchored to the last-scanned leadId,
      // and DynamoDB ExclusiveStartKey is exactly {listId, leadId}.
      const cursorKey = { listId, leadId: 'lead-prev' };
      const encodedCursor = Buffer.from(JSON.stringify(cursorKey)).toString('base64');

      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [mockLead],
        lastEvaluatedKey: undefined,
      } as any);

      await service.searchLeads(listId, [
        { field: 'email', operator: 'contains', value: 'john' }
      ], userId, undefined, { cursor: encodedCursor });

      expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledWith(listId, 200, cursorKey);
    });

    it('should cap limit at 100', async () => {
      const leads = Array.from({ length: 110 }, (_, i) => ({ ...mockLead, leadId: `lead-${i}` }));
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: leads,
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'email', operator: 'is_not_empty' }
      ], userId, 200);

      expect(result.leads.length).toBeLessThanOrEqual(100);
    });

    it('should expose sanitized enrichmentMetadata so the agent can cite per-field provenance for list-wide queries', async () => {
      // Regression: list-wide "what is the funding stage for each lead?" routes
      // through search_leads, which returned customFields (values) but dropped
      // enrichmentMetadata — leaving Emma blind to source/confidence so it
      // reported bare values. get_lead_details already exposes it; search_leads
      // must too.
      const enrichedLead = {
        ...mockLead,
        customFields: { funding_stage: 'Series C', industry: 'Tech' },
        enrichmentMetadata: {
          funding_stage: {
            source: 'web_search',
            provider: 'llm_web_search',
            confidence: 'medium',
            sourceUrl: 'https://example.com/slashy',
            sourceQuote: 'Slashy raised a round',
            enrichedAt: '2026-06-18T00:00:00.000Z',
          },
          industry: {
            source: 'api',
            provider: 'apollo',
            confidence: 'high',
            enrichedAt: '2026-06-18T00:00:00.000Z',
          },
        },
      };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [enrichedLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'funding_stage', operator: 'is_not_empty' }
      ], userId);

      expect(result.success).toBe(true);
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].enrichmentMetadata).toBeDefined();
      expect(result.leads[0].enrichmentMetadata.funding_stage.provider).toBe('llm_web_search');
      expect(result.leads[0].enrichmentMetadata.funding_stage.confidence).toBe('medium');
      expect(result.leads[0].enrichmentMetadata.industry.provider).toBe('apollo');
      expect(result.leads[0].enrichmentMetadata.industry.confidence).toBe('high');
    });

    it('should strip cross-tenant CRM-history lineage from enrichmentMetadata in search_leads results', async () => {
      // Mirrors the get_lead_details sanitization guarantee: sibling IDs and the
      // internal 'crm-history' source must never reach the customer.
      const siblingEnrichedLead = {
        ...mockLead,
        customFields: { funding_stage: 'Seed' },
        enrichmentMetadata: {
          funding_stage: {
            source: 'crm-history',
            provider: 'agentweb',
            confidence: 'medium',
            siblingLeadId: 'other-tenant-lead',
            siblingListId: 'other-tenant-list',
            siblingUserId: 'other-tenant-user',
            enrichedAt: '2026-06-18T00:00:00.000Z',
          },
        },
      };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [siblingEnrichedLead],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'funding_stage', operator: 'is_not_empty' }
      ], userId);

      const meta = result.leads[0].enrichmentMetadata.funding_stage;
      expect(meta.source).toBe('agentweb');          // rewritten from 'crm-history'
      expect(meta.siblingLeadId).toBeUndefined();
      expect(meta.siblingListId).toBeUndefined();
      expect(meta.siblingUserId).toBeUndefined();
    });

    it('omits enrichmentMetadata for leads that were never enriched', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [{ ...mockLead, customFields: { industry: 'Tech' }, enrichmentMetadata: undefined }],
        lastEvaluatedKey: undefined,
      } as any);

      const result = await service.searchLeads(listId, [
        { field: 'industry', operator: 'is_not_empty' }
      ], userId);

      expect(result.leads[0].enrichmentMetadata).toBeUndefined();
    });
  });

  // ─── getLeadDetails ────────────────────────────────────────────────────

  describe('getLeadDetails', () => {
    beforeEach(() => {
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    });

    it('should return full lead details with engagements', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 3, last7Days: 1, totalAllMessages: 5 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({
        engagements: [
          { eventType: 'email.sent', createdAt: '2026-02-01T00:00:00.000Z', eventData: { subject: 'Hello' } },
        ]
      } as any);

      const result = await service.getLeadDetails(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.lead.email).toBe('john@acme.com');
      expect(result.lead.customFields.industry).toBe('Tech');
      expect(result.engagementSummary.total).toBe(3);
      expect(result.recentEngagements).toHaveLength(1);
    });

    it('should truncate HTML email draft to preview', async () => {
      const leadWithDraft = {
        ...mockLead,
        emailDraft: {
          subject: 'Hello John',
          format: 'html',
          htmlContent: '<p>' + 'A'.repeat(300) + '</p>',
          textContent: null,
        }
      };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithDraft as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 0, last7Days: 0, totalAllMessages: 0 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);

      const result = await service.getLeadDetails(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.lead.emailDraft.subject).toBe('Hello John');
      expect(result.lead.emailDraft.contentPreview.length).toBeLessThanOrEqual(210); // 200 + '...'
      expect(result.lead.emailDraft.hasFullContent).toBe(true);
    });

    it('should return not found for missing lead', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(null as any);

      const result = await service.getLeadDetails(listId, leadId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Lead not found');
    });

    it('should expose enrichmentMetadata provenance so the agent can cite data sources', async () => {
      // Mirrors the real bug: a user asks "where does funding_stage / ARR come
      // from?" The agent needs the per-field provenance sidecar to answer.
      const leadWithMeta = {
        ...mockLead,
        customFields: { funding_stage: 'Seed', arr: '$1.2M' },
        enrichmentMetadata: {
          funding_stage: {
            source: 'web_search',
            provider: 'llm_web_search',
            confidence: 'medium',
            sourceUrl: 'https://techcrunch.com/acme-seed',
            sourceQuote: 'Acme closed a $1.2M seed round',
            enrichedAt: '2026-06-17T00:00:00.000Z',
          },
          arr: {
            source: 'api',
            provider: 'apollo',
            confidence: 'low',
            enrichedAt: '2026-06-17T00:00:00.000Z',
          },
        },
      };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithMeta as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 0, last7Days: 0, totalAllMessages: 0 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);

      const result = await service.getLeadDetails(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.lead.enrichmentMetadata).toBeDefined();
      expect(result.lead.enrichmentMetadata.funding_stage.provider).toBe('llm_web_search');
      expect(result.lead.enrichmentMetadata.funding_stage.sourceUrl).toBe('https://techcrunch.com/acme-seed');
      expect(result.lead.enrichmentMetadata.funding_stage.confidence).toBe('medium');
      expect(result.lead.enrichmentMetadata.arr.provider).toBe('apollo');
      expect(result.lead.enrichmentMetadata.arr.confidence).toBe('low');
    });

    it('should sanitize cross-tenant lineage from enrichmentMetadata before returning', async () => {
      // crm-history fills carry sibling lineage that must never reach the
      // customer; sanitizeEnrichmentMetadataForResponse rewrites source and
      // strips sibling IDs.
      const leadWithSibling = {
        ...mockLead,
        customFields: { funding_stage: 'Series A' },
        enrichmentMetadata: {
          funding_stage: {
            source: 'crm-history',
            siblingLeadId: 'other-lead-999',
            siblingListId: 'other-list-888',
            siblingUserId: 'other-user-777',
            confidence: 'high',
            enrichedAt: '2026-06-17T00:00:00.000Z',
          },
        },
      };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithSibling as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 0, last7Days: 0, totalAllMessages: 0 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);

      const result = await service.getLeadDetails(listId, leadId, userId);

      expect(result.success).toBe(true);
      const meta = result.lead.enrichmentMetadata.funding_stage;
      expect(meta.source).toBe('agentweb');           // rewritten from crm-history
      expect(meta.siblingLeadId).toBeUndefined();
      expect(meta.siblingListId).toBeUndefined();
      expect(meta.siblingUserId).toBeUndefined();
    });

    it('omits enrichmentMetadata when the lead has none (manual/legacy lead)', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue({ ...mockLead, enrichmentMetadata: undefined } as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 0, last7Days: 0, totalAllMessages: 0 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);

      const result = await service.getLeadDetails(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.lead.enrichmentMetadata).toBeUndefined();
    });

    it('should handle emailContent object in recent engagements', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 2, last7Days: 2, totalAllMessages: 2 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({
        engagements: [
          {
            eventType: 'email.delivered',
            createdAt: '2026-02-01T00:00:00.000Z',
            eventData: { email_id: 'msg-123' },
            emailContent: {
              html: '<p>Welcome to our service!</p>',
              text: 'Welcome to our service!',
              headers: {}
            }
          },
          {
            eventType: 'email.received',
            createdAt: '2026-02-02T00:00:00.000Z',
            eventData: { email_id: 'msg-456' },
            emailContent: {
              text: 'Thanks for reaching out',
              headers: {}
            }
          },
        ]
      } as any);

      const result = await service.getLeadDetails(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.recentEngagements).toHaveLength(2);
      expect(result.recentEngagements[0].emailContentPreview).toBe('Welcome to our service!');
      expect(result.recentEngagements[1].emailContentPreview).toBe('Thanks for reaching out');
    });

  });

  // ─── updateLead ────────────────────────────────────────────────────────

  describe('updateLead', () => {
    beforeEach(() => {
      // Default: grant access (list owned by same user)
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    });

    it('should update standard fields', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.updateLead.mockResolvedValue({} as any);

      const result = await service.updateLead(listId, leadId, {
        company: 'New Corp',
        title: 'CTO'
      }, userId);

      expect(result.success).toBe(true);
      expect(mockCrmDb.updateLead).toHaveBeenCalledWith(listId, leadId, {
        company: 'New Corp',
        title: 'CTO'
      });
    });

    it('should merge custom fields with existing ones', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.updateLead.mockResolvedValue({} as any);

      const result = await service.updateLead(listId, leadId, {
        revenue: '10M'
      }, userId);

      expect(result.success).toBe(true);
      expect(mockCrmDb.updateLead).toHaveBeenCalledWith(listId, leadId, {
        customFields: { industry: 'Tech', employees: '500', revenue: '10M' }
      });
    });

    it('should handle mixed standard and custom fields', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.updateLead.mockResolvedValue({} as any);

      const result = await service.updateLead(listId, leadId, {
        company: 'New Corp',
        revenue: '10M'
      }, userId);

      expect(result.success).toBe(true);
      expect(mockCrmDb.updateLead).toHaveBeenCalledWith(listId, leadId, {
        company: 'New Corp',
        customFields: { industry: 'Tech', employees: '500', revenue: '10M' }
      });
      expect(result.updatedFields).toEqual(['company', 'revenue']);
    });

    it('should return error for empty updates', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);

      const result = await service.updateLead(listId, leadId, {}, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No updates');
    });

    it('should deny access for wrong user', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other-user' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);

      const result = await service.updateLead(listId, leadId, { company: 'X' }, userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
    });

    it('drops a corrupted (string) existing customFields and keeps only the patch', async () => {
      // Simulates a pre-fix corrupt lead whose customFields was stored as a
      // raw JSON string. Without the guard, `{ ...stringValue, ...patch }`
      // produces char-indexed keys. With mergeCustomFields, the corrupted
      // side is sanitized away and only the patch survives.
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue({
        ...mockLead,
        customFields: '{"firstName":"David"}' as any,
      });
      mockCrmDb.updateLead.mockResolvedValue({} as any);

      const result = await service.updateLead(listId, leadId, { newField: 'newValue' }, userId);

      expect(result.success).toBe(true);
      const callArgs = (mockCrmDb.updateLead as jest.Mock).mock.calls[0];
      const writtenCustomFields = callArgs[2].customFields;
      expect(writtenCustomFields).toEqual({ newField: 'newValue' });
      // No numeric-string keys from the corrupted string side
      expect(Object.keys(writtenCustomFields).some((k) => /^\d+$/.test(k))).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[customFieldsGuard]'),
        expect.objectContaining({ source: 'agentMode.updateLead', listId, leadId, type: 'string' }),
      );
      errorSpy.mockRestore();
    });
  });

  // ─── addLeadsToList ───────────────────────────────────────────────────

  describe('addLeadsToList', () => {
    const newLead = {
      email: 'kyle@example.com',
      firstName: 'Kyle',
      lastName: 'Bimm',
      company: 'Acme',
      dinnerSeat: 'confirmed',
    };

    beforeEach(() => {
      mockCrmDb.batchCreateLeads.mockResolvedValue({
        successCount: 1,
        newCount: 1,
        mergedCount: 0,
        errorCount: 0,
        errors: [],
      } as any);
    });

    it('allows the list owner to add leads through the shared access helper', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);

      const result = await service.addLeadsToList(listId, [newLead], userId);

      expect(result.success).toBe(true);
      expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledWith(listId, [
        {
          email: 'kyle@example.com',
          firstName: 'Kyle',
          lastName: 'Bimm',
          company: 'Acme',
          customFields: { dinnerSeat: 'confirmed' },
        },
      ], expect.objectContaining({ dedupeByNameCompany: true }));
    });

    it('allows a listed crm.editor to add leads to another member\'s list (ENG-1049)', async () => {
      const orgSharedList = { ...mockList, userId: listOwnerId };
      mockCrmDb.getLeadListById.mockResolvedValue(orgSharedList as any);
      setSameOrgUsers();
      mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm({ shareSettings: { crm: { enabled: true, editors: [orgMemberId] } } }) as any);

      const result = await service.addLeadsToList(listId, [newLead], orgMemberId);

      expect(result.success).toBe(true);
      expect(result.reconciliation.created).toBe(1);
      expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledTimes(1);
    });

    it('denies a same-org member who is not the owner and not a CRM editor (ENG-1049)', async () => {
      const orgSharedList = { ...mockList, userId: listOwnerId };
      mockCrmDb.getLeadListById.mockResolvedValue(orgSharedList as any);
      setSameOrgUsers();
      mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm() as any);

      const result = await service.addLeadsToList(listId, [newLead], orgMemberId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
      expect(result.error).toMatch(/CRM editor/i);
      expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
    });

    it('denies users who fail the org-aware list access check', async () => {
      const outsiderList = { ...mockList, userId: 'other-user' };
      mockCrmDb.getLeadListById.mockResolvedValue(outsiderList as any);

      const result = await service.addLeadsToList(listId, [newLead], userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
      expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
    });

    it('returns not found when the target list is missing', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null as any);

      const result = await service.addLeadsToList(listId, [newLead], userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Lead list not found');
      expect(mockCrmDb.canOrgMemberAccessList).not.toHaveBeenCalled();
      expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
    });

    // ENG-1133: a 97-row CSV imported in three 25-row calls stopped at 75 when
    // the whole-turn cap fired. Each call had reported only "25 new lead(s)
    // created", so the next turn could not tell which 75 of the 97 had landed
    // and told the user to retry the whole request instead of resuming.
    describe('resumable import reporting (ENG-1133)', () => {
      beforeEach(() => {
        mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      });

      it('names the rows it persisted so the next turn can resume from the remainder', async () => {
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 2,
          newCount: 1,
          mergedCount: 1,
          errorCount: 0,
          errors: [],
          rowOutcomes: ['created', 'merged'],
        } as any);

        const result = await service.addLeadsToList(
          listId,
          [
            { email: 'one@example.com', firstName: 'One' },
            { linkedin: 'https://www.linkedin.com/in/two', firstName: 'Two', lastName: 'Person' },
          ],
          userId,
        );

        expect(result.success).toBe(true);
        expect(result.complete).toBe(true);
        expect(result.attempted).toBe(2);
        expect(result.importedIdentifiers).toEqual([
          'one@example.com',
          'https://www.linkedin.com/in/two',
        ]);
        expect(result.unimportedRows).toBeUndefined();
      });

      it('returns an explicit resumable partial naming the rows that did not land', async () => {
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 1,
          newCount: 1,
          mergedCount: 0,
          errorCount: 1,
          errors: ['Row 2: b@example.com - ProvisionedThroughputExceeded'],
          rowOutcomes: ['created', 'failed', 'unprocessed'],
        } as any);

        const result = await service.addLeadsToList(
          listId,
          [
            { email: 'a@example.com' },
            { email: 'b@example.com' },
            { email: 'c@example.com' },
          ],
          userId,
        );

        // NOT success:false — the dispatch boundary turns a success:false result
        // into a structured tool error, which strips `unimportedRows` before the
        // model ever sees it and appends a "do NOT retry" verdict. Rows landed,
        // so the call succeeded; `complete: false` carries the incompleteness.
        expect(result.success).toBe(true);
        expect(result.complete).toBe(false);
        expect(result.resumable).toBe(true);
        expect(result.unimportedRows).toEqual([
          { row: 2, identifier: 'b@example.com', reason: 'failed' },
          { row: 3, identifier: 'c@example.com', reason: 'unprocessed' },
        ]);
        expect(result.message).toMatch(/1 of 3/);
        // The agent must be told to resume with the named rows, not to hand a
        // whole-request retry back to the user.
        expect(result.message).toMatch(/add_leads_to_list/);
      });

      it('still reports failure when the import landed nothing at all', async () => {
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 0,
          newCount: 0,
          mergedCount: 0,
          errorCount: 2,
          errors: ['Row 1: a@example.com - ProvisionedThroughputExceeded'],
          rowOutcomes: ['failed', 'failed'],
        } as any);

        const result = await service.addLeadsToList(
          listId,
          [{ email: 'a@example.com' }, { email: 'b@example.com' }],
          userId,
        );

        // Nothing is in the list, so this IS a tool failure — the dispatcher
        // should downgrade it and the CRM page has nothing to refresh for.
        expect(result.success).toBe(false);
        expect(result.complete).toBe(false);
        expect(result.resumable).toBe(true);
      });

      // The resume list is capped so a huge partial cannot blow the tool result
      // past the size at which the agent layer swaps it for a preview. Left
      // unsaid, that cap is silent data loss: the agent imports the 100 rows it
      // was named, gets a clean `complete: true`, and reports the import
      // finished while the rest are still missing.
      it('says so when the resume list is truncated, and that finishing it is not finishing the import', async () => {
        const rows = Array.from({ length: 250 }, (_, i) => ({ email: `row${i}@example.com` }));
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 50,
          newCount: 50,
          mergedCount: 0,
          errorCount: 0,
          errors: [],
          rowOutcomes: rows.map((_, i) => (i < 50 ? 'created' : 'unprocessed')),
        } as any);

        const result = await service.addLeadsToList(listId, rows, userId);

        expect(result.complete).toBe(false);
        // 200 ledger entries are ~14KB — inside the budget, so the resume list
        // names every missing row rather than a 100-row slice of them.
        expect(result.unimportedRows).toHaveLength(200);
        expect(result.unimportedRowsTruncated).toBeUndefined();
        expect(result.unimportedRowRanges).toBe('51-250');
        expect(result.message).not.toMatch(/FIRST/);
      });

      // The budget can still be exceeded by rows carrying long identifiers. A
      // trimmed resume list that does not say it is trimmed is silent data
      // loss: the agent imports the slice, reads `complete: true` and stops.
      it('says so when the resume list does not fit, and points at the untrimmed ranges', async () => {
        const rows = Array.from({ length: 400 }, (_, i) => ({
          email: `row${i}.${'x'.repeat(120)}@example.com`,
        }));
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 0,
          newCount: 0,
          mergedCount: 0,
          errorCount: 0,
          errors: [],
          rowOutcomes: rows.map((_, i) => (i < 1 ? 'created' : 'unprocessed')),
        } as any);

        const result = await service.addLeadsToList(listId, rows, userId);

        expect(result.unimportedRowsTruncated).toBeDefined();
        expect(result.unimportedRowsTruncated.total).toBe(399);
        expect(result.unimportedRows.length).toBe(result.unimportedRowsTruncated.shown);
        expect(result.unimportedRows.length).toBeLessThan(399);
        // The backstop still accounts for every missing row.
        expect(result.unimportedRowRanges).toBe('2-400');
        expect(result.message).toMatch(/FIRST \d+ of 399 missing rows/);
        expect(result.message).toMatch(/unimportedRowRanges \(2-400\) lists EVERY missing position/);
        expect(result.message).toMatch(/not done until a result comes back with complete: true/);
      });

      // A resume that only ever sees a slice of the missing rows imports it,
      // gets `complete: true` for that call, and stops — stranding the rest.
      // The ranges are what make the resume deterministic regardless.
      it('names every missing row position, including any past the detail budget', async () => {
        const rows = Array.from({ length: 250 }, (_, i) => ({ email: `row${i}@example.com` }));
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 50,
          newCount: 50,
          mergedCount: 0,
          errorCount: 0,
          errors: [],
          rowOutcomes: rows.map((_, i) => (i < 50 ? 'created' : 'unprocessed')),
        } as any);

        const result = await service.addLeadsToList(listId, rows, userId);

        const missing = new Set<number>();
        for (const part of (result.unimportedRowRanges as string).split(',')) {
          const [start, end] = part.split('-').map(Number);
          for (let row = start; row <= (end ?? start); row++) missing.add(row);
        }
        expect(missing.size).toBe(200);
        expect(missing.has(51)).toBe(true);
        expect(missing.has(250)).toBe(true);
        expect(missing.has(50)).toBe(false);
      });

      it('does not claim truncation when the whole resume list fits', async () => {
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 1,
          newCount: 1,
          mergedCount: 0,
          errorCount: 0,
          errors: [],
          rowOutcomes: ['created', 'unprocessed'],
        } as any);

        const result = await service.addLeadsToList(
          listId,
          [{ email: 'a@example.com' }, { email: 'b@example.com' }],
          userId,
        );

        expect(result.unimportedRowsTruncated).toBeUndefined();
        expect(result.message).not.toMatch(/FIRST/);
      });

      // When the list could not be read at all, resending the same rows hits
      // the same wall. This is the one incomplete import that must NOT be
      // offered as a resume, or the agent loops on it for the rest of the turn.
      it('reports an unreadable list as a blocker rather than a resume', async () => {
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 0,
          newCount: 0,
          mergedCount: 0,
          errorCount: 0,
          errors: ['Could not read the existing leads in this list within 120000ms, so no rows were imported.'],
          rowOutcomes: ['unprocessed', 'unprocessed'],
          dedupeIncomplete: true,
        } as any);

        const result = await service.addLeadsToList(
          listId,
          [{ email: 'a@example.com' }, { email: 'b@example.com' }],
          userId,
        );

        expect(result.success).toBe(false);
        expect(result.complete).toBe(false);
        expect(result.resumable).toBeUndefined();
        expect(result.message).toMatch(/Import not attempted/);
        expect(result.message).toMatch(/would duplicate rows already in the list/);
        expect(result.message).toMatch(/Do NOT retry the same call/);
        expect(result.message).not.toMatch(/RESUME by calling/);
      });

      it('reconciles attempted rows across created, merged, duplicate, skipped and failed', async () => {
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 2,
          newCount: 1,
          mergedCount: 1,
          alreadyPresentCount: 1,
          anonymizedSkipped: 1,
          errorCount: 1,
          errors: ['Row 4: Duplicate email "d@example.com" found in upload data'],
          rowOutcomes: ['created', 'merged', 'already_present', 'duplicate_in_request', 'anonymized_skipped'],
        } as any);

        const result = await service.addLeadsToList(
          listId,
          [
            { email: 'a@example.com' },
            { email: 'b@example.com' },
            { email: 'c@example.com' },
            { email: 'c@example.com' },
            { firstName: 'LinkedIn', lastName: 'Member' },
          ],
          userId,
        );

        expect(result.attempted).toBe(5);
        const { created, merged, alreadyPresent, duplicateInRequest, anonymizedSkipped, failed, unprocessed } =
          result.reconciliation;
        // Pin each bucket to the row it came from — the sum alone is a
        // tautology (every outcome tallies into exactly one bucket), so it
        // would still hold if two buckets were mislabelled.
        expect(created).toBe(1);
        expect(merged).toBe(1);
        expect(alreadyPresent).toBe(1);
        expect(duplicateInRequest).toBe(1);
        expect(anonymizedSkipped).toBe(1);
        expect(failed).toBe(0);
        expect(unprocessed).toBe(0);
        expect(created + merged + alreadyPresent + duplicateInRequest + anonymizedSkipped + failed + unprocessed)
          .toBe(result.attempted);
        expect(result.complete).toBe(true);
      });

      // Re-sending the full CSV after a partial import is the retry the user
      // was told to do. Every row already being present is a SUCCESSFUL
      // reconciliation, not "No leads were processed".
      it('reports success when every re-submitted row is already in the list', async () => {
        mockCrmDb.batchCreateLeads.mockResolvedValue({
          successCount: 0,
          newCount: 0,
          mergedCount: 0,
          alreadyPresentCount: 2,
          errorCount: 0,
          errors: [],
          rowOutcomes: ['already_present', 'already_present'],
        } as any);

        const result = await service.addLeadsToList(
          listId,
          [{ email: 'a@example.com' }, { email: 'b@example.com' }],
          userId,
        );

        expect(result.success).toBe(true);
        expect(result.complete).toBe(true);
        expect(result.message).toMatch(/already/i);
      });
    });
  });

  // ─── deleteLeads ───────────────────────────────────────────────────────

  describe('deleteLeads', () => {
    it('should delete multiple leads', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.deleteLead.mockResolvedValue({ success: true } as any);

      const result = await service.deleteLeads(listId, ['lead-1', 'lead-2', 'lead-3'], userId);

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(3);
      expect(result.failCount).toBe(0);
      expect(mockCrmDb.deleteLead).toHaveBeenCalledTimes(3);
    });

    it('should handle partial failures', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.deleteLead
        .mockResolvedValueOnce({ success: true } as any)
        .mockRejectedValueOnce(new Error('Not found'))
        .mockResolvedValueOnce({ success: true } as any);

      const result = await service.deleteLeads(listId, ['lead-1', 'lead-2', 'lead-3'], userId);

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
      expect(result.failCount).toBe(1);
      expect(result.errors).toHaveLength(1);
    });

    it('should reject empty lead IDs', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);

      const result = await service.deleteLeads(listId, [], userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No lead IDs');
    });

    it('should reject more than 100 leads', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      const ids = Array.from({ length: 101 }, (_, i) => `lead-${i}`);

      const result = await service.deleteLeads(listId, ids, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Too many');
    });
  });

  // ─── updateLeadList ────────────────────────────────────────────────────

  describe('updateLeadList', () => {
    it('should update list name and description', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.updateLeadList.mockResolvedValue({} as any);

      const result = await service.updateLeadList(listId, {
        name: 'Hot Leads',
        description: 'Priority leads'
      }, userId);

      expect(result.success).toBe(true);
      expect(mockCrmDb.updateLeadList).toHaveBeenCalledWith(listId, {
        name: 'Hot Leads',
        description: 'Priority leads'
      });
    });

    it('should update filter settings', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.updateLeadList.mockResolvedValue({} as any);

      const result = await service.updateLeadList(listId, {
        icpsOnly: true,
        engagedOnly: false
      }, userId);

      expect(result.success).toBe(true);
      expect(mockCrmDb.updateLeadList).toHaveBeenCalledWith(listId, {
        icpsOnly: true,
        engagedOnly: false
      });
    });

    it('should update auto-draft config', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.updateLeadList.mockResolvedValue({} as any);

      const result = await service.updateLeadList(listId, {
        autoDraftEnabled: true,
        autoDraftInstruction: 'Write a warm intro email'
      }, userId);

      expect(result.success).toBe(true);
      expect(result.updatedFields).toContain('autoDraftEnabled');
      expect(result.updatedFields).toContain('autoDraftInstruction');
    });

    it('should reject empty name', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);

      const result = await service.updateLeadList(listId, { name: '  ' }, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid name');
    });

    it('should reject when no updates provided', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);

      const result = await service.updateLeadList(listId, {}, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No updates');
    });
  });

  // ─── deleteLeadList ────────────────────────────────────────────────────

  describe('deleteLeadList', () => {
    it('should delete list and return info', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.deleteLeadList.mockResolvedValue({ success: true } as any);

      const result = await service.deleteLeadList(listId, userId);

      expect(result.success).toBe(true);
      expect(result.deletedListName).toBe('Test List');
      expect(result.deletedLeadCount).toBe(5);
      expect(mockCrmDb.deleteLeadList).toHaveBeenCalledWith(listId);
    });

    it('should deny access for wrong user', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other-user' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);

      const result = await service.deleteLeadList(listId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
    });
  });

  // ─── getLeadEngagements ────────────────────────────────────────────────

  describe('getLeadEngagements', () => {
    it('should return engagement history with summary', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 5, last7Days: 2, totalAllMessages: 8 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({
        engagements: [
          { eventId: 'e1', eventType: 'email.sent', createdAt: '2026-02-01T00:00:00.000Z', eventData: { subject: 'Hello' } },
          { eventId: 'e2', eventType: 'custom.phone_call', createdAt: '2026-01-28T00:00:00.000Z', eventData: { notes: 'Discussed pricing' } },
        ]
      } as any);

      const result = await service.getLeadEngagements(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.engagementSummary.total).toBe(5);
      expect(result.engagements).toHaveLength(2);
      expect(result.engagements[0].eventType).toBe('email.sent');
    });

    it('should truncate HTML email content in engagements (legacy string format)', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 1, last7Days: 1, totalAllMessages: 1 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({
        engagements: [
          { eventId: 'e1', eventType: 'email.sent', createdAt: '2026-02-01T00:00:00.000Z', eventData: {}, emailContent: '<p>' + 'X'.repeat(300) + '</p>' },
        ]
      } as any);

      const result = await service.getLeadEngagements(listId, leadId, userId);

      expect(result.engagements[0].emailContentPreview).toBeDefined();
      expect(result.engagements[0].emailContentPreview.length).toBeLessThanOrEqual(210);
    });

    it('should handle emailContent as object with html field', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 1, last7Days: 1, totalAllMessages: 1 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({
        engagements: [
          {
            eventId: 'e1',
            eventType: 'email.received',
            createdAt: '2026-02-01T00:00:00.000Z',
            eventData: {},
            emailContent: {
              html: '<p><strong>Hello</strong> World!</p>' + 'X'.repeat(300),
              text: 'Hello World!',
              headers: { 'From': 'test@example.com' }
            }
          },
        ]
      } as any);

      const result = await service.getLeadEngagements(listId, leadId, userId);

      expect(result.engagements[0].emailContentPreview).toBeDefined();
      expect(result.engagements[0].emailContentPreview).toContain('Hello World');
      expect(result.engagements[0].emailContentPreview).not.toContain('<p>');
      expect(result.engagements[0].emailContentPreview.length).toBeLessThanOrEqual(210);
    });

    it('should handle emailContent as object with text field only', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 1, last7Days: 1, totalAllMessages: 1 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({
        engagements: [
          {
            eventId: 'e1',
            eventType: 'email.received',
            createdAt: '2026-02-01T00:00:00.000Z',
            eventData: {},
            emailContent: {
              text: 'Plain text email content',
              headers: { 'From': 'test@example.com' }
            }
          },
        ]
      } as any);

      const result = await service.getLeadEngagements(listId, leadId, userId);

      expect(result.engagements[0].emailContentPreview).toBe('Plain text email content');
    });

    it('should handle empty emailContent object', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 1, last7Days: 1, totalAllMessages: 1 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({
        engagements: [
          {
            eventId: 'e1',
            eventType: 'email.received',
            createdAt: '2026-02-01T00:00:00.000Z',
            eventData: {},
            emailContent: {
              headers: { 'From': 'test@example.com' }
            }
          },
        ]
      } as any);

      const result = await service.getLeadEngagements(listId, leadId, userId);

      expect(result.engagements[0].emailContentPreview).toBeUndefined();
    });

    it('should handle missing emailContent', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 1, last7Days: 1, totalAllMessages: 1 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({
        engagements: [
          {
            eventId: 'e1',
            eventType: 'custom.meeting',
            createdAt: '2026-02-01T00:00:00.000Z',
            eventData: { notes: 'Had a great meeting' }
          },
        ]
      } as any);

      const result = await service.getLeadEngagements(listId, leadId, userId);

      expect(result.engagements[0].emailContentPreview).toBeUndefined();
    });

    it('should respect limit parameter', async () => {
      const engagements = Array.from({ length: 10 }, (_, i) => ({
        eventId: `e${i}`, eventType: 'email.sent', createdAt: `2026-02-0${i + 1}T00:00:00.000Z`, eventData: {}
      }));
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 10, last7Days: 5, totalAllMessages: 10 });
      mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements } as any);

      const result = await service.getLeadEngagements(listId, leadId, userId, 3);

      expect(result.engagements).toHaveLength(3);
    });
  });

  // ─── addLeadEngagement ─────────────────────────────────────────────────

  describe('addLeadEngagement', () => {
    it('should record a custom engagement', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.addLeadEngagement.mockResolvedValue({} as any);

      const result = await service.addLeadEngagement(
        listId, leadId, 'custom.phone_call', userId,
        { notes: 'Discussed pricing', duration: '30 min' }
      );

      expect(result.success).toBe(true);
      expect(result.eventType).toBe('custom.phone_call');
      expect(mockCrmDb.addLeadEngagement).toHaveBeenCalledWith(
        listId, leadId,
        expect.objectContaining({
          eventType: 'custom.phone_call',
          eventData: { notes: 'Discussed pricing', duration: '30 min' },
        })
      );
    });

    it('should use custom event date when provided', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.addLeadEngagement.mockResolvedValue({} as any);

      const eventDate = '2026-01-15T10:00:00.000Z';
      await service.addLeadEngagement(
        listId, leadId, 'custom.meeting', userId,
        { location: 'Office' }, eventDate
      );

      expect(mockCrmDb.addLeadEngagement).toHaveBeenCalledWith(
        listId, leadId,
        expect.objectContaining({ createdAt: eventDate })
      );
    });

    it('should reject event type without custom. prefix', async () => {
      const result = await service.addLeadEngagement(
        listId, leadId, 'email.sent', userId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid event type');
    });

    it('should deny access for wrong user', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other-user' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);

      const result = await service.addLeadEngagement(
        listId, leadId, 'custom.note', userId
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
    });
  });

  // ─── sendEmailToLead ───────────────────────────────────────────────────

  describe('sendEmailToLead', () => {
    beforeEach(() => {
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    });

    const leadWithDraft = {
      ...mockLead,
      emailDraft: {
        subject: 'Hello John',
        htmlContent: '<p>Hi John</p>',
        textContent: 'Hi John',
      },
      selectedSenderId: 'sender-1',
    };

    it('should send email and clear draft', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithDraft as any);
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [
          { id: 'sender-1', email: 'sales@acme.com', fromName: 'Sales Team' },
          { id: 'sender-2', email: 'info@acme.com', fromName: 'Info' },
        ],
        defaultSenderId: 'sender-2'
      });
      mockResend.sendEmail.mockResolvedValue({ id: 'email-123' } as any);

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.emailId).toBe('email-123');
      expect(result.from).toBe('sales@acme.com');
      expect(result.subject).toBe('Hello John');
      expect(mockResend.sendEmail).toHaveBeenCalledWith({
        from: 'Sales Team <sales@acme.com>',
        to: 'john@acme.com',
        subject: 'Hello John',
        html: '<p>Hi John</p>',
        text: 'Hi John'
      });
      // Should clear draft after sending
      expect(mockCrmDb.updateLead).toHaveBeenCalledWith(listId, leadId, { emailDraft: null });
    });

    it('should fall back to list sender when lead has no selected sender', async () => {
      const leadNoSender = { ...leadWithDraft, selectedSenderId: null };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadNoSender as any);
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [
          { id: 'sender-default', email: 'default@acme.com', fromName: 'Default' },
          { id: 'sender-other', email: 'other@acme.com', fromName: 'Other' },
        ],
        defaultSenderId: 'sender-other'
      });
      mockResend.sendEmail.mockResolvedValue({ id: 'email-456' } as any);

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.from).toBe('default@acme.com'); // Uses list sender (sender-default)
    });

    it('should return error when lead has no email', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue({ ...mockLead, email: '' } as any);

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No email address');
    });

    it('should return error when lead has no draft', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any); // emailDraft is null

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No email draft');
    });

    it('should return error when no senders configured', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithDraft as any);
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [],
        defaultSenderId: null
      });

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No senders configured');
    });

    it('should return error when Resend fails', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithDraft as any);
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [{ id: 'sender-1', email: 'sales@acme.com', fromName: 'Sales' }],
        defaultSenderId: 'sender-1'
      });
      mockResend.sendEmail.mockResolvedValue(null as any);

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Email send failed');
    });

    it('should send via Gmail when senderType is gmail', async () => {
      const gmailSender = {
        id: 'sender-g1',
        email: 'shopify@pmps.ai',
        fromName: 'PMPS Outreach',
        senderType: 'gmail' as const,
        gmailAccountId: 'shopify@pmps.ai',
      };
      const leadWithGmailSender = { ...leadWithDraft, selectedSenderId: 'sender-g1' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithGmailSender as any);
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [gmailSender],
        defaultSenderId: 'sender-g1',
      });
      mockGmail.sendEmail.mockResolvedValue({ messageId: 'gmail-msg-1', threadId: 'thread-1' } as any);

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(true);
      expect(result.emailId).toBe('gmail-msg-1');
      expect(result.from).toBe('shopify@pmps.ai');
      expect(mockGmail.sendEmail).toHaveBeenCalledWith(
        userId,
        'shopify@pmps.ai',
        expect.objectContaining({
          to: 'john@acme.com',
          subject: 'Hello John',
          body: '<p>Hi John</p>',
          isHtml: true,
        })
      );
      expect(mockResend.sendEmail).not.toHaveBeenCalled();
      expect(mockCrmDb.updateLead).toHaveBeenCalledWith(listId, leadId, { emailDraft: null });
    });

    it('should return error when Gmail sender is missing gmailAccountId', async () => {
      const brokenGmailSender = {
        id: 'sender-g-broken',
        email: 'x@x.com',
        fromName: 'X',
        senderType: 'gmail' as const,
        // gmailAccountId intentionally omitted
      };
      const leadWithBrokenSender = { ...leadWithDraft, selectedSenderId: 'sender-g-broken' };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithBrokenSender as any);
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [brokenGmailSender],
        defaultSenderId: 'sender-g-broken',
      });

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Gmail sender misconfigured');
      expect(mockGmail.sendEmail).not.toHaveBeenCalled();
    });

    it('should propagate Gmail send errors gracefully', async () => {
      const gmailSender = {
        id: 'sender-g2',
        email: 'test@gmail.com',
        fromName: 'Test',
        senderType: 'gmail' as const,
        gmailAccountId: 'test@gmail.com',
      };
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue({ ...leadWithDraft, selectedSenderId: 'sender-g2' } as any);
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [gmailSender],
        defaultSenderId: 'sender-g2',
      });
      mockGmail.sendEmail.mockRejectedValue(new Error('Token revoked'));

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token revoked');
    });

    it('should deny access when user is not an org member', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other-user' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);

      const result = await service.sendEmailToLead(listId, leadId, userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
    });

    it('should use list owner senders when a listed crm.editor sends email (ENG-1049)', async () => {
      const orgMemberList = { ...mockList, userId: listOwnerId };
      mockCrmDb.getLeadListById.mockResolvedValue(orgMemberList as any);
      setSameOrgUsers();
      mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm({ shareSettings: { crm: { enabled: true, editors: [orgMemberId] } } }) as any);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithDraft as any);
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      const getCrmSendersSpy = jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [{ id: 'sender-1', email: 'owner@acme.com', fromName: 'Owner' }],
        defaultSenderId: 'sender-1',
      });
      mockResend.sendEmail.mockResolvedValue({ id: 'email-789' } as any);

      const result = await service.sendEmailToLead(listId, leadId, orgMemberId);

      expect(result.success).toBe(true);
      // Should fetch senders using the list owner's userId, not the caller's
      expect(getCrmSendersSpy).toHaveBeenCalledWith(listOwnerId);
    });

    it('denies a same-org member who is not the owner and not a CRM editor from sending (ENG-1049)', async () => {
      const orgMemberList = { ...mockList, userId: listOwnerId };
      mockCrmDb.getLeadListById.mockResolvedValue(orgMemberList as any);
      setSameOrgUsers();
      mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm() as any);

      const result = await service.sendEmailToLead(listId, leadId, orgMemberId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
      expect(result.error).toMatch(/CRM editor/i);
    });
  });

  // ─── sendEmailFromConfiguredSender ─────────────────────────────────────
  // Ad-hoc / one-off email send using the user's configured CRM sender(s),
  // without needing a connected Gmail account or a CRM lead+draft. This is the
  // fix for "Configured email sender cannot send email from Emma chat".

  describe('sendEmailFromConfiguredSender', () => {
    const resendSenders = {
      success: true,
      senders: [
        { id: 'sender-1', email: 'sales@acme.com', fromName: 'Sales Team' },
        { id: 'sender-2', email: 'info@acme.com', fromName: 'Info' },
      ],
      defaultSenderId: 'sender-2',
    };

    it('should send via the default Resend sender (happy path)', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);
      mockResend.sendEmail.mockResolvedValue({ id: 'email-abc' } as any);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi there</p>',
      });

      expect(result.success).toBe(true);
      expect(result.emailId).toBe('email-abc');
      expect(result.from).toBe('info@acme.com'); // default sender (sender-2)
      expect(mockResend.sendEmail).toHaveBeenCalledWith({
        from: 'Info <info@acme.com>',
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi there</p>',
        text: undefined,
      });
    });

    it('should send via an explicitly requested senderId', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);
      mockResend.sendEmail.mockResolvedValue({ id: 'email-def' } as any);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        text: 'Hi there',
        senderId: 'sender-1',
      });

      expect(result.success).toBe(true);
      expect(result.from).toBe('sales@acme.com'); // explicit sender-1
    });

    it('should send via a gmail-type sender through gmailService', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [
          {
            id: 'sender-g1',
            email: 'shopify@pmps.ai',
            fromName: 'PMPS',
            senderType: 'gmail',
            gmailAccountId: 'shopify@pmps.ai',
          },
        ],
        defaultSenderId: 'sender-g1',
      });
      mockGmail.sendEmail.mockResolvedValue({ messageId: 'gmail-1', threadId: 't-1' } as any);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(true);
      expect(result.emailId).toBe('gmail-1');
      expect(result.from).toBe('shopify@pmps.ai');
      expect(mockGmail.sendEmail).toHaveBeenCalledWith(
        userId,
        'shopify@pmps.ai',
        expect.objectContaining({
          to: 'someone@external.com',
          subject: 'Hello',
          body: '<p>Hi</p>',
          isHtml: true,
        })
      );
      expect(mockResend.sendEmail).not.toHaveBeenCalled();
    });

    it('should return error when no senders are configured', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [],
        defaultSenderId: null,
      });

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('No senders configured');
      expect(mockResend.sendEmail).not.toHaveBeenCalled();
    });

    it('should return error when requested senderId does not exist', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
        senderId: 'does-not-exist',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Sender not found');
      expect(mockResend.sendEmail).not.toHaveBeenCalled();
      // The error should list the available senders so the model/user can pick one.
      expect(result.error).toContain('sales@acme.com');
      expect(result.error).toContain('info@acme.com');
      expect(Array.isArray(result.availableSenders)).toBe(true);
      expect(result.availableSenders).toHaveLength(2);
    });

    it('should resolve a sender by its email address', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);
      mockResend.sendEmail.mockResolvedValue({ id: 'email-by-email' } as any);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
        senderId: 'sales@acme.com', // email, not the internal id
      });

      expect(result.success).toBe(true);
      expect(result.from).toBe('sales@acme.com');
    });

    it('should resolve a sender by its from-name (case-insensitive)', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);
      mockResend.sendEmail.mockResolvedValue({ id: 'email-by-name' } as any);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
        senderId: 'sales team', // matches fromName "Sales Team"
      });

      expect(result.success).toBe(true);
      expect(result.from).toBe('sales@acme.com');
    });

    it('should resolve the Gmail-type sender when asked for the "gmail" sender', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [
          { id: 'sender-1', email: 'sales@acme.com', fromName: 'Sales Team' },
          { id: 'sender-g', email: 'me@gmail.com', fromName: 'Manan', senderType: 'gmail', gmailAccountId: 'me@gmail.com' },
        ],
        defaultSenderId: 'sender-1',
      });
      mockGmail.sendEmail.mockResolvedValue({ messageId: 'g-1', threadId: 't-1' } as any);

      // The user says "from my gmail sender" → sender_id resolves by senderType.
      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
        senderId: 'gmail',
      });

      expect(result.success).toBe(true);
      expect(result.from).toBe('me@gmail.com');
      expect(mockGmail.sendEmail).toHaveBeenCalled();
    });

    it('should include senderType in the availableSenders list on no match', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [
          { id: 'sender-1', email: 'sales@acme.com', fromName: 'Sales Team' },
          { id: 'sender-g', email: 'me@gmail.com', fromName: 'Manan', senderType: 'gmail', gmailAccountId: 'me@gmail.com' },
        ],
        defaultSenderId: 'sender-1',
      });

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
        senderId: 'no-such-sender',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Sender not found');
      const gmailEntry = result.availableSenders.find((s: any) => s.email === 'me@gmail.com');
      expect(gmailEntry.senderType).toBe('gmail');
      // The default/resend sender should be marked accordingly (not undefined).
      const resendEntry = result.availableSenders.find((s: any) => s.email === 'sales@acme.com');
      expect(resendEntry.senderType).toBe('resend');
    });

    it('should return a recipient-validation error when "to" is missing', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: '',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Recipient');
      expect(mockResend.sendEmail).not.toHaveBeenCalled();
    });

    it.each(['notanemail', 'foo@', 'foo@bar', 'a b@x.com', 'foo@@bar.com'])(
      'should reject a malformed recipient address "%s" before sending',
      async (badTo) => {
        jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);

        const result = await service.sendEmailFromConfiguredSender(userId, {
          to: badTo,
          subject: 'Hello',
          html: '<p>Hi</p>',
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain('Invalid recipient');
        expect(result.error).toContain(badTo);
        // Must not attempt a send for a clearly malformed address.
        expect(mockResend.sendEmail).not.toHaveBeenCalled();
        expect(mockGmail.sendEmail).not.toHaveBeenCalled();
      }
    );

    it('should accept a well-formed recipient and send normally', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);
      mockResend.sendEmail.mockResolvedValue({ id: 'ok-1' } as any);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'valid.person@example.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(true);
      expect(mockResend.sendEmail).toHaveBeenCalled();
    });

    it('should return error when subject is missing', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: '',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Subject');
    });

    it('should return error when body (html and text) is missing', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('body');
    });

    it('should return error when html body is whitespace-only', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Empty',
        html: '   ',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('body');
      expect(mockResend.sendEmail).not.toHaveBeenCalled();
    });

    it('should return error when text body is whitespace-only', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Empty',
        text: '   \n  ',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('body');
      expect(mockResend.sendEmail).not.toHaveBeenCalled();
    });

    it('should return error when both html and text are empty strings', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Empty',
        html: '',
        text: '',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('body');
      expect(mockResend.sendEmail).not.toHaveBeenCalled();
    });

    it('should accept a "body" alias as the email body (plain text)', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);
      mockResend.sendEmail.mockResolvedValue({ id: 'email-body-alias' } as any);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        body: 'Hi there from the body alias',
      } as any);

      expect(result.success).toBe(true);
      expect(mockResend.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'someone@external.com',
          subject: 'Hello',
          text: 'Hi there from the body alias',
        })
      );
    });

    it('should surface the failure when Resend returns null', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue(resendSenders);
      mockResend.sendEmail.mockResolvedValue(null as any);

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Email send failed');
    });

    it('should return error when gmail-type sender is missing gmailAccountId', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [
          { id: 'sender-gb', email: 'x@x.com', fromName: 'X', senderType: 'gmail' },
        ],
        defaultSenderId: 'sender-gb',
      });

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Gmail sender misconfigured');
      expect(mockGmail.sendEmail).not.toHaveBeenCalled();
    });

    it('should propagate gmail send errors gracefully', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [
          {
            id: 'sender-g2',
            email: 'test@gmail.com',
            fromName: 'Test',
            senderType: 'gmail',
            gmailAccountId: 'test@gmail.com',
          },
        ],
        defaultSenderId: 'sender-g2',
      });
      mockGmail.sendEmail.mockRejectedValue(new Error('Internal server error'));

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(false);
      // Non-auth Gmail errors surface as a "Gmail send failed" with the raw cause.
      expect(result.message).toContain('Gmail send failed');
      expect(result.error).toContain('Internal server error');
      expect(result.error).toContain('test@gmail.com');
    });

    it('should return an actionable reconnect message on a Gmail OAuth failure', async () => {
      jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [
          {
            id: 'sender-g3',
            email: 'broken@gmail.com',
            fromName: 'Broken',
            senderType: 'gmail',
            gmailAccountId: 'broken@gmail.com',
          },
        ],
        defaultSenderId: 'sender-g3',
      });
      // Google's token refresh surfaces raw OAuth errors like this one.
      mockGmail.sendEmail.mockRejectedValue(new Error('unauthorized_client'));

      const result = await service.sendEmailFromConfiguredSender(userId, {
        to: 'someone@external.com',
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Gmail');
      // Tell the user the sender's Gmail account needs reconnecting, and which one.
      expect(result.error).toContain('reconnect');
      expect(result.error).toContain('broken@gmail.com');
    });
  });

  // ─── Shared: ownership & error handling ────────────────────────────────

  describe('Shared ownership checks', () => {
    it('getLeadDetails denies access for wrong user', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);
      const result = await service.getLeadDetails(listId, leadId, userId);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
    });

    it('deleteLeads returns not found for missing list', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null as any);
      const result = await service.deleteLeads(listId, ['lead-1'], userId);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Lead list not found');
    });

    it('getLeadEngagements returns not found for missing lead', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(null as any);
      const result = await service.getLeadEngagements(listId, leadId, userId);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Lead not found');
    });

    it('updateLeadList denies access for wrong user', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);
      const result = await service.updateLeadList(listId, { name: 'X' }, userId);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
    });

    it('searchLeads denies access for wrong user', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);
      const result = await service.searchLeads(listId, [{ field: 'email', operator: 'contains', value: 'test' }], userId);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
    });
  });

  // ─── Error handling ────────────────────────────────────────────────────

  describe('Error handling', () => {
    beforeEach(() => {
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    });

    it('getLeads handles DB errors gracefully', async () => {
      mockCrmDb.getLeadListById.mockRejectedValue(new Error('DB connection failed'));
      const result = await service.getLeads(listId, userId, {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB connection failed');
    });

    it('searchLeads handles DB errors gracefully', async () => {
      mockCrmDb.getLeadListById.mockRejectedValue(new Error('DB timeout'));
      const result = await service.searchLeads(listId, [{ field: 'email', operator: 'contains', value: 'x' }], userId);
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB timeout');
    });

    it('updateLead handles DB errors gracefully', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.updateLead.mockRejectedValue(new Error('Write failed'));
      const result = await service.updateLead(listId, leadId, { company: 'X' }, userId);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Write failed');
    });

    it('deleteLeadList handles DB errors gracefully', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.deleteLeadList.mockRejectedValue(new Error('Delete failed'));
      const result = await service.deleteLeadList(listId, userId);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
    });

    it('addLeadEngagement handles DB errors gracefully', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadById.mockResolvedValue(mockLead as any);
      mockCrmDb.addLeadEngagement.mockRejectedValue(new Error('Write failed'));
      const result = await service.addLeadEngagement(listId, leadId, 'custom.note', userId);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Write failed');
    });

    it('sendEmailToLead handles errors gracefully', async () => {
      mockCrmDb.getLeadListById.mockRejectedValue(new Error('Network error'));
      const result = await service.sendEmailToLead(listId, leadId, userId);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  // ─── deleteLeadsByFilter ─────────────────────────────────────────────

  describe('deleteLeadsByFilter', () => {
    const makeLeads = (overrides: Array<Record<string, any>>) =>
      overrides.map((o, i) => ({
        leadId: `lead-${i}`,
        listId,
        email: `user${i}@test.com`,
        firstName: 'User',
        lastName: `${i}`,
        company: '',
        title: '',
        customFields: {},
        ...o,
      }));

    // ─── Preview Phase (confirm=false or undefined) ───────────────────────

    it('should return preview with count when confirm is not set', async () => {
      const leads = makeLeads([
        { customFields: { lead_source: 'google' } },
        { customFields: {} },                        // lead_source is empty
        { customFields: { lead_source: '' } },        // lead_source is empty string
      ]);
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null } as any);

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'lead_source', operator: 'is_empty' }],
        userId
      );

      expect(result.success).toBe(true);
      expect(result.matchCount).toBe(2);
      expect(result.scannedCount).toBe(3);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.sampleLeads).toHaveLength(2);
      expect(result.message).toContain('Found 2 lead(s)');
      expect(result.message).toContain('confirm=true');
      expect(mockCrmDb.deleteLead).not.toHaveBeenCalled();
    });

    it('should return preview with no confirmation needed when zero matches', async () => {
      const leads = makeLeads([
        { customFields: { lead_source: 'google' } },
      ]);
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null } as any);

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'lead_source', operator: 'is_empty' }],
        userId
      );

      expect(result.success).toBe(true);
      expect(result.matchCount).toBe(0);
      expect(result.requiresConfirmation).toBe(false);
      expect(result.message).toContain('No leads matched');
      expect(mockCrmDb.deleteLead).not.toHaveBeenCalled();
    });

    it('should limit sample leads to 5 in preview', async () => {
      const leads = makeLeads(Array(10).fill({ customFields: {} }));
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null } as any);

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'lead_source', operator: 'is_empty' }],
        userId
      );

      expect(result.success).toBe(true);
      expect(result.matchCount).toBe(10);
      expect(result.sampleLeads).toHaveLength(5);
    });

    // ─── Deletion Phase (confirm=true) ────────────────────────────────────

    it('should delete leads when confirm=true', async () => {
      const leads = makeLeads([
        { customFields: { lead_source: 'google' } },
        { customFields: {} },                        // lead_source is empty
        { customFields: { lead_source: '' } },        // lead_source is empty string
      ]);
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null } as any);
      mockCrmDb.deleteLead.mockResolvedValue({ success: true } as any);

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'lead_source', operator: 'is_empty' }],
        userId,
        true
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
      expect(result.scannedCount).toBe(3);
      expect(mockCrmDb.deleteLead).toHaveBeenCalledTimes(2);
    });

    it('should delete leads matching equals filter when confirmed', async () => {
      const leads = makeLeads([
        { company: 'Acme' },
        { company: 'Beta' },
        { company: 'acme' },  // case-insensitive match
      ]);
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null } as any);
      mockCrmDb.deleteLead.mockResolvedValue({ success: true } as any);

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'company', operator: 'equals', value: 'Acme' }],
        userId,
        true
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
    });

    it('should return success with zero deletes when no leads match and confirmed', async () => {
      const leads = makeLeads([
        { customFields: { lead_source: 'google' } },
      ]);
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null } as any);

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'lead_source', operator: 'is_empty' }],
        userId,
        true
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(0);
      expect(result.message).toContain('No leads matched');
    });

    it('should paginate through all leads when deleting', async () => {
      const page1Leads = makeLeads([{ customFields: {} }]);
      const page2Leads = makeLeads([{ customFields: {} }]).map(l => ({ ...l, leadId: 'lead-page2' }));

      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId
        .mockResolvedValueOnce({ items: page1Leads, lastEvaluatedKey: { id: 'cursor1' } } as any)
        .mockResolvedValueOnce({ items: page2Leads, lastEvaluatedKey: null } as any);
      mockCrmDb.deleteLead.mockResolvedValue({ success: true } as any);

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'lead_source', operator: 'is_empty' }],
        userId,
        true
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
      expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledTimes(2);
    });

    it('should handle delete failures gracefully', async () => {
      const leads = makeLeads([{ customFields: {} }, { customFields: {} }]);
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null } as any);
      mockCrmDb.deleteLead
        .mockResolvedValueOnce({ success: true } as any)
        .mockRejectedValueOnce(new Error('DB error'));

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'lead_source', operator: 'is_empty' }],
        userId,
        true
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(1);
      expect(result.failCount).toBe(1);
    });

    // ─── Error Cases (both phases) ────────────────────────────────────────

    it('should reject empty filters', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);

      const result = await service.deleteLeadsByFilter(listId, [], userId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('At least one filter');
    });

    it('should reject when list not owned by user', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ ...mockList, userId: 'other-user' } as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);

      const result = await service.deleteLeadsByFilter(
        listId,
        [{ field: 'email', operator: 'is_empty' }],
        userId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });
  });

  // ─── org-shared access: non-owner org member (PR #1895, tightened ENG-1049) ─
  // PR #1895 first made these methods org-aware, but gated destructive writes on
  // the READ-level canOrgMemberAccessList — any same-org member (not just the
  // owner/org-owner/crm.editors) could mutate another member's list or leads.
  // ENG-1049 moved the 7 write methods below onto canDestructiveCrmList. The 2
  // read methods (getLeadListStatuses, getLeadEngagements) are unchanged and
  // still allow any same-org member.
  describe('org-shared access — non-owner org member (PR #1895 / ENG-1049)', () => {
    const sharedList = { ...mockList, userId: listOwnerId, statusConfig: undefined };

    type AccessCase = {
      name: string;
      run: (svc: AgentModeService, caller: string) => Promise<any>;
      writeMock?: jest.Mock;
    };

    const destructiveCases: AccessCase[] = [
      { name: 'setLeadContactStatus',
        run: (s, u) => s.setLeadContactStatus(listId, [leadId], 'do-not-contact', undefined, undefined, u),
        writeMock: mockCrmDb.updateLead as jest.Mock },
      { name: 'deleteLeads',
        run: (s, u) => s.deleteLeads(listId, [leadId], u),
        writeMock: mockCrmDb.deleteLead as jest.Mock },
      { name: 'deleteLeadsByFilter',
        run: (s, u) => s.deleteLeadsByFilter(listId, [{ field: 'status', operator: 'equals', value: 'lost' }], u, true),
        writeMock: mockCrmDb.deleteLead as jest.Mock },
      { name: 'updateLeadList',
        run: (s, u) => s.updateLeadList(listId, { description: 'updated by org member' }, u),
        writeMock: mockCrmDb.updateLeadList as jest.Mock },
      { name: 'configureLeadStatuses',
        run: (s, u) => s.configureLeadStatuses(listId, [{ value: 'new', label: 'New', color: 'gray', type: 'active' }], u),
        writeMock: mockCrmDb.updateLeadList as jest.Mock },
      { name: 'deleteLeadList',
        run: (s, u) => s.deleteLeadList(listId, u),
        writeMock: mockCrmDb.deleteLeadList as jest.Mock },
      { name: 'addLeadEngagement',
        run: (s, u) => s.addLeadEngagement(listId, leadId, 'custom.call', u),
        writeMock: mockCrmDb.addLeadEngagement as jest.Mock },
    ];

    const readCases: AccessCase[] = [
      { name: 'getLeadListStatuses', run: (s, u) => s.getLeadListStatuses(listId, u) },
      { name: 'getLeadEngagements', run: (s, u) => s.getLeadEngagements(listId, leadId, u) },
    ];

    function setDownstreamMocks() {
      mockCrmDb.getLeadById.mockResolvedValue({ ...mockLead } as any);
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: undefined } as any);
      (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue(0);
      mockCrmDb.getLeadEngagements.mockResolvedValue([] as any);
    }

    destructiveCases.forEach(({ name, run, writeMock }) => {
      it(`${name} denies a same-org member who is not the owner and not a CRM editor`, async () => {
        mockCrmDb.getLeadListById.mockResolvedValue({ ...sharedList } as any);
        setSameOrgUsers();
        mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm() as any);

        const result = await run(service, orgMemberId);

        expect(result.success).toBe(false);
        expect(result.message).toBe('Access denied');
        expect(result.error).toMatch(/CRM editor/i);
        if (writeMock) expect(writeMock).not.toHaveBeenCalled();
      });

      it(`${name} allows a listed crm.editor`, async () => {
        mockCrmDb.getLeadListById.mockResolvedValue({ ...sharedList } as any);
        setSameOrgUsers();
        mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm({ shareSettings: { crm: { enabled: true, editors: [orgMemberId] } } }) as any);
        setDownstreamMocks();

        const result = await run(service, orgMemberId);

        expect(result.message).not.toBe('Access denied');
      });

      it(`${name} allows the org owner`, async () => {
        mockCrmDb.getLeadListById.mockResolvedValue({ ...sharedList } as any);
        setSameOrgUsers();
        mockOrgDb.getOrgById.mockResolvedValue(orgWithCrm({ ownerUserId: orgMemberId }) as any);
        setDownstreamMocks();

        const result = await run(service, orgMemberId);

        expect(result.message).not.toBe('Access denied');
      });
    });

    readCases.forEach(({ name, run }) => {
      it(`${name} allows a same-org member who is not the list owner (read-level, unchanged)`, async () => {
        mockCrmDb.getLeadListById.mockResolvedValue({ ...sharedList } as any);
        (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
        setDownstreamMocks();

        const result = await run(service, orgMemberId);

        expect(result.message).not.toBe('Access denied');
        expect(mockCrmDb.canOrgMemberAccessList).toHaveBeenCalledWith(
          orgMemberId, expect.objectContaining({ userId: listOwnerId })
        );
      });

      it(`${name} denies a user who fails the org access check`, async () => {
        mockCrmDb.getLeadListById.mockResolvedValue({ ...sharedList } as any);
        (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);

        const result = await run(service, 'outsider-id');

        expect(result.success).toBe(false);
        expect(result.message).toBe('Access denied');
      });
    });
  });
});
