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
  }
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
import { crmDb } from '../services/db';
import { resendService } from '../services/resendService';
import { gmailService } from '../services/gmailService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
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
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);

      const result = await service.addLeadsToList(listId, [newLead], userId);

      expect(result.success).toBe(true);
      expect(mockCrmDb.canOrgMemberAccessList).toHaveBeenCalledWith(userId, mockList);
      expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledWith(listId, [
        {
          email: 'kyle@example.com',
          firstName: 'Kyle',
          lastName: 'Bimm',
          company: 'Acme',
          customFields: { dinnerSeat: 'confirmed' },
        },
      ]);
    });

    it('allows a same-org member with write access to add leads to an org-shared list', async () => {
      const listOwnerId = 'list-owner-id';
      const orgMemberId = 'org-member-id';
      const orgSharedList = { ...mockList, userId: listOwnerId };
      mockCrmDb.getLeadListById.mockResolvedValue(orgSharedList as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);

      const result = await service.addLeadsToList(listId, [newLead], orgMemberId);

      expect(result.success).toBe(true);
      expect(result.newCount).toBe(1);
      expect(mockCrmDb.canOrgMemberAccessList).toHaveBeenCalledWith(orgMemberId, orgSharedList);
      expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledTimes(1);
    });

    it('denies users who fail the org-aware list access check', async () => {
      const outsiderList = { ...mockList, userId: 'other-user' };
      mockCrmDb.getLeadListById.mockResolvedValue(outsiderList as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);

      const result = await service.addLeadsToList(listId, [newLead], userId);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access denied');
      expect(mockCrmDb.canOrgMemberAccessList).toHaveBeenCalledWith(userId, outsiderList);
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

    it('should use list owner senders when org member sends email', async () => {
      const orgMemberUserId = 'org-member-id';
      const listOwnerId = 'list-owner-id';
      const orgMemberList = { ...mockList, userId: listOwnerId };
      mockCrmDb.getLeadListById.mockResolvedValue(orgMemberList as any);
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
      mockCrmDb.getLeadById.mockResolvedValue(leadWithDraft as any);
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      const getCrmSendersSpy = jest.spyOn(service as any, 'getCrmSenders').mockResolvedValue({
        success: true,
        senders: [{ id: 'sender-1', email: 'owner@acme.com', fromName: 'Owner' }],
        defaultSenderId: 'sender-1',
      });
      mockResend.sendEmail.mockResolvedValue({ id: 'email-789' } as any);

      const result = await service.sendEmailToLead(listId, leadId, orgMemberUserId);

      expect(result.success).toBe(true);
      // Should fetch senders using the list owner's userId, not the caller's
      expect(getCrmSendersSpy).toHaveBeenCalledWith(listOwnerId);
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

  // ─── org-shared access: non-owner org member (PR #1895 follow-up) ──────────
  // Every CRM list method must gate on the org-aware canOrgMemberAccessList, not
  // a raw `list.userId !== userId` owner check. A same-org member who is NOT the
  // list owner must be allowed to operate on a shared list; an outsider must be
  // denied. Covers the 9 methods migrated alongside addLeadsToList.
  describe('org-shared access — non-owner org member (PR #1895)', () => {
    const listOwnerId = 'list-owner-id';
    const orgMemberId = 'org-member-id';
    const sharedList = { ...mockList, userId: listOwnerId, statusConfig: undefined };

    type AccessCase = {
      name: string;
      run: (svc: AgentModeService, caller: string) => Promise<any>;
      denyError?: string;
      writeMock?: jest.Mock;
    };

    const cases: AccessCase[] = [
      { name: 'setLeadContactStatus',
        run: (s, u) => s.setLeadContactStatus(listId, [leadId], 'do-not-contact', undefined, undefined, u),
        writeMock: mockCrmDb.updateLead as jest.Mock },
      { name: 'deleteLeads',
        run: (s, u) => s.deleteLeads(listId, [leadId], u),
        denyError: 'You do not have permission to delete leads from this list',
        writeMock: mockCrmDb.deleteLead as jest.Mock },
      { name: 'deleteLeadsByFilter',
        run: (s, u) => s.deleteLeadsByFilter(listId, [{ field: 'status', operator: 'equals', value: 'lost' }], u, true),
        denyError: 'You do not have permission to delete leads from this list',
        writeMock: mockCrmDb.deleteLead as jest.Mock },
      { name: 'updateLeadList',
        run: (s, u) => s.updateLeadList(listId, { description: 'updated by org member' }, u),
        denyError: 'You do not have permission to modify this list',
        writeMock: mockCrmDb.updateLeadList as jest.Mock },
      { name: 'getLeadListStatuses',
        run: (s, u) => s.getLeadListStatuses(listId, u),
        denyError: 'You do not have permission to view this list' },
      { name: 'configureLeadStatuses',
        run: (s, u) => s.configureLeadStatuses(listId, [{ value: 'new', label: 'New', color: 'gray', type: 'active' }], u),
        denyError: 'You do not have permission to modify this list',
        writeMock: mockCrmDb.updateLeadList as jest.Mock },
      { name: 'deleteLeadList',
        run: (s, u) => s.deleteLeadList(listId, u),
        denyError: 'You do not have permission to delete this list',
        writeMock: mockCrmDb.deleteLeadList as jest.Mock },
      { name: 'getLeadEngagements',
        run: (s, u) => s.getLeadEngagements(listId, leadId, u),
        denyError: 'You do not have permission to access this list' },
      { name: 'addLeadEngagement',
        run: (s, u) => s.addLeadEngagement(listId, leadId, 'custom.call', u),
        denyError: 'You do not have permission to modify leads in this list',
        writeMock: mockCrmDb.addLeadEngagement as jest.Mock },
    ];

    cases.forEach(({ name, run, denyError, writeMock }) => {
      it(`${name} allows a same-org member who is not the list owner`, async () => {
        mockCrmDb.getLeadListById.mockResolvedValue({ ...sharedList } as any);
        (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
        // Downstream mocks so each method can proceed past the access gate.
        mockCrmDb.getLeadById.mockResolvedValue({ ...mockLead } as any);
        mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: undefined } as any);
        (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue(0);
        mockCrmDb.getLeadEngagements.mockResolvedValue([] as any);

        const result = await run(service, orgMemberId);

        // The bug returned a hard 'Access denied' for non-owner members. The
        // downstream outcome may vary, but it must NOT be the permission denial,
        // and the org-aware check must have been consulted with the caller + list.
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
        if (denyError) expect(result.error).toBe(denyError);
        if (writeMock) expect(writeMock).not.toHaveBeenCalled();
      });
    });
  });
});
