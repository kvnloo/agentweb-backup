/**
 * Tests for linkedInConnectionStatus field in AgentModeService.getLeadDetails().
 * Verifies that the AW-UnipileConnections cache is consulted when a lead has a
 * LinkedIn URL, scoped to the account assigned to the list (list.linkedInAccountId),
 * falling back to the user's own connected LinkedIn account when the list has none.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
    getLeadEngagementCount: jest.fn(),
    getLeadEngagements: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  }
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  getConnectionByProfileUrlAndAccount: jest.fn(),
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { resolveUserOwnedAccountId: jest.fn() },
}));

// Minimal stubs for transitive dependencies pulled in by agentModeService
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/gmailService',  () => ({ gmailService:  { sendEmail: jest.fn() } }));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';
import * as unipileConnectionsDb from '../services/unipileConnectionsDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockGetConnection = unipileConnectionsDb.getConnectionByProfileUrlAndAccount as jest.Mock;
const mockResolveUserOwnedAccountId = linkedInOutreachService.resolveUserOwnedAccountId as jest.Mock;

describe('AgentModeService.getLeadDetails – linkedInConnectionStatus', () => {
  let service: AgentModeService;
  const userId  = 'user-111';
  const listId  = 'list-aaa';
  const leadId  = 'lead-zzz';
  const linkedInAccountId = 'unipile-acc-1';

  const mockList = { listId, userId, name: 'Outreach List', linkedInAccountId };
  const mockListNoAccount = { listId, userId, name: 'Outreach List', linkedInAccountId: null };

  const baseLead = {
    leadId,
    listId,
    email:        'jerry@insightful.com',
    firstName:    'Jerry',
    lastName:     'Shan',
    company:      'Insightful-Tech',
    title:        'CEO',
    phone:        '',
    notes:        '',
    linkedin:     'https://www.linkedin.com/in/jerryshan/',
    customFields: {},
    icpMatch:     null,
    isEngaged:    false,
    emailDraft:   null,
    messageDraft: null,
    selectedSenderId: null,
    createdAt:    '2026-01-01T00:00:00.000Z',
    updatedAt:    '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
    mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 0, last7Days: 0, totalAllMessages: 0 });
    mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);
    mockResolveUserOwnedAccountId.mockResolvedValue(null);
  });

  it('returns isConnected:true with connectedAt when lead LinkedIn URL is in the cache', async () => {
    mockCrmDb.getLeadById.mockResolvedValue(baseLead as any);
    mockGetConnection.mockResolvedValue({
      accountId:        linkedInAccountId,
      memberId:         'jerry123',
      publicProfileUrl: 'https://www.linkedin.com/in/jerryshan/',
      memberUrn:        'urn:li:member:jerry123',
      connectionUrn:    'urn:li:connection:abc',
      firstName:        'Jerry',
      lastName:         'Shan',
      headline:         'CEO',
      connectedAt:      1746057600, // 2025-04-01T00:00:00.000Z
      syncedAt:         '2026-04-01T01:00:00.000Z',
    });

    const result = await service.getLeadDetails(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.lead.linkedInConnectionStatus).toBeDefined();
    expect(result.lead.linkedInConnectionStatus.isConnected).toBe(true);
    expect(result.lead.linkedInConnectionStatus.connectedAt).toBe(
      new Date(1746057600 * 1000).toISOString()
    );
    expect(result.lead.linkedInConnectionStatus.connectedAtTimestamp).toBe(1746057600);
    expect(mockGetConnection).toHaveBeenCalledWith(baseLead.linkedin, linkedInAccountId);
  });

  it('returns isConnected:false when lead LinkedIn URL is NOT in the cache', async () => {
    mockCrmDb.getLeadById.mockResolvedValue(baseLead as any);
    mockGetConnection.mockResolvedValue(null);

    const result = await service.getLeadDetails(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.lead.linkedInConnectionStatus).toEqual({ isConnected: false });
    expect(mockGetConnection).toHaveBeenCalledWith(baseLead.linkedin, linkedInAccountId);
  });

  it('returns null linkedInConnectionStatus when lead has no LinkedIn URL', async () => {
    const leadNoLinkedIn = { ...baseLead, linkedin: '' };
    mockCrmDb.getLeadById.mockResolvedValue(leadNoLinkedIn as any);

    const result = await service.getLeadDetails(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.lead.linkedInConnectionStatus).toBeNull();
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it('returns isConnected:false and does not throw when cache lookup fails', async () => {
    mockCrmDb.getLeadById.mockResolvedValue(baseLead as any);
    mockGetConnection.mockRejectedValue(new Error('DynamoDB timeout'));

    const result = await service.getLeadDetails(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.lead.linkedInConnectionStatus).toEqual({ isConnected: false });
  });

  it('does NOT call resolveUserOwnedAccountId when the list has an assigned account', async () => {
    mockCrmDb.getLeadById.mockResolvedValue(baseLead as any);
    mockGetConnection.mockResolvedValue(null);

    await service.getLeadDetails(listId, leadId, userId);

    expect(mockResolveUserOwnedAccountId).not.toHaveBeenCalled();
    expect(mockGetConnection).toHaveBeenCalledWith(baseLead.linkedin, linkedInAccountId);
  });

  it('falls back to the user\'s own LinkedIn account when the list has no linkedInAccountId', async () => {
    const fallbackAccountId = 'unipile-user-own';
    mockCrmDb.getLeadListById.mockResolvedValue(mockListNoAccount as any);
    mockCrmDb.getLeadById.mockResolvedValue(baseLead as any);
    mockResolveUserOwnedAccountId.mockResolvedValue(fallbackAccountId);
    mockGetConnection.mockResolvedValue({
      accountId:        fallbackAccountId,
      memberId:         'jerry123',
      publicProfileUrl: 'https://www.linkedin.com/in/jerryshan/',
      memberUrn:        'urn:li:member:jerry123',
      connectionUrn:    'urn:li:connection:abc',
      firstName:        'Jerry',
      lastName:         'Shan',
      headline:         'CEO',
      connectedAt:      1746057600,
      syncedAt:         '2026-04-01T01:00:00.000Z',
    });

    const result = await service.getLeadDetails(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.lead.linkedInConnectionStatus.isConnected).toBe(true);
    expect(mockResolveUserOwnedAccountId).toHaveBeenCalledWith(userId);
    expect(mockGetConnection).toHaveBeenCalledWith(baseLead.linkedin, fallbackAccountId);
  });

  it('returns isConnected:false when list has no account and user has no connected LinkedIn account', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(mockListNoAccount as any);
    mockCrmDb.getLeadById.mockResolvedValue(baseLead as any);
    mockResolveUserOwnedAccountId.mockResolvedValue(null);

    const result = await service.getLeadDetails(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.lead.linkedInConnectionStatus).toEqual({ isConnected: false });
    expect(mockResolveUserOwnedAccountId).toHaveBeenCalledWith(userId);
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it('returns isConnected:false and does not throw when the fallback account lookup fails', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(mockListNoAccount as any);
    mockCrmDb.getLeadById.mockResolvedValue(baseLead as any);
    mockResolveUserOwnedAccountId.mockRejectedValue(new Error('DynamoDB timeout'));

    const result = await service.getLeadDetails(listId, leadId, userId);

    expect(result.success).toBe(true);
    expect(result.lead.linkedInConnectionStatus).toEqual({ isConnected: false });
    expect(mockResolveUserOwnedAccountId).toHaveBeenCalledWith(userId);
    expect(mockGetConnection).not.toHaveBeenCalled();
  });
});
