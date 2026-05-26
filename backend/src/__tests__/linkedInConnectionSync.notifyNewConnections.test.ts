/**
 * Tests for notifyNewConnections — sends an email notification to the list owner
 * when a CRM lead's LinkedIn connection request is accepted.
 */

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { listConnections: jest.fn() },
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: jest.fn(),
  getLatestConnectedAt: jest.fn().mockResolvedValue(null),
  normalizeLinkedInUrl: jest.fn((url: string) => url.replace(/\/$/, '').toLowerCase()),
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getAllSequencesByTriggerType: jest.fn().mockResolvedValue([]),
    getExistingEnrollment: jest.fn(),
    enrollLead: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    findLeadsByLinkedin: jest.fn(),
    getLeadListById: jest.fn(),
    getLeadListsByUserId: jest.fn(),
    getLeadsByListId: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyLinkedInConnectionAccepted: jest.fn(),
  },
}));

import { notifyNewConnections } from '../cron/linkedInConnectionSyncCron';
import { crmDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockAlertService = leadListAlertService as jest.Mocked<typeof leadListAlertService>;

const NEW_CONNECTION = {
  accountId: 'account-1',
  memberId: 'member-abc',
  publicProfileUrl: 'https://www.linkedin.com/in/john-prospect',
  memberUrn: '',
  connectionUrn: '',
  firstName: 'John',
  lastName: 'Prospect',
  headline: 'CTO',
  connectedAt: Date.now(),
  syncedAt: new Date().toISOString(),
};

const MATCHING_LEAD = {
  leadId: 'lead-1',
  listId: 'list-1',
  email: 'john@example.com',
  firstName: 'John',
  lastName: 'Prospect',
  linkedin: 'https://www.linkedin.com/in/john-prospect',
};

const LIST = { listId: 'list-1', name: 'Outreach List', userId: 'user-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockAlertService.notifyLinkedInConnectionAccepted.mockResolvedValue(undefined);
});

describe('notifyNewConnections', () => {
  it('sends notification for each matched lead', async () => {
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([MATCHING_LEAD] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockCrmDb.findLeadsByLinkedin).toHaveBeenCalledWith(NEW_CONNECTION.publicProfileUrl);
    expect(mockCrmDb.getLeadListById).toHaveBeenCalledWith('list-1');
    expect(mockAlertService.notifyLinkedInConnectionAccepted).toHaveBeenCalledWith(LIST, MATCHING_LEAD);
  });

  it('does nothing when no leads match the LinkedIn URL', async () => {
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([] as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockAlertService.notifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
  });

  it('skips lead when list is not found', async () => {
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([MATCHING_LEAD] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(null as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockAlertService.notifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
  });

  it('skips lead missing listId', async () => {
    const leadNoList = { ...MATCHING_LEAD, listId: undefined };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadNoList] as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockAlertService.notifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
  });

  it('continues processing other connections if one lookup fails', async () => {
    const secondConnection = { ...NEW_CONNECTION, publicProfileUrl: 'https://www.linkedin.com/in/jane-doe' };
    const secondLead = { ...MATCHING_LEAD, leadId: 'lead-2', linkedin: secondConnection.publicProfileUrl };
    const secondList = { ...LIST, listId: 'list-2' };

    mockCrmDb.findLeadsByLinkedin
      .mockRejectedValueOnce(new Error('DynamoDB timeout'))
      .mockResolvedValueOnce([secondLead] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(secondList as any);

    await notifyNewConnections([NEW_CONNECTION, secondConnection]);

    expect(mockAlertService.notifyLinkedInConnectionAccepted).toHaveBeenCalledTimes(1);
    expect(mockAlertService.notifyLinkedInConnectionAccepted).toHaveBeenCalledWith(secondList, secondLead);
  });

  it('continues processing other leads if one notification fails', async () => {
    const lead2 = { ...MATCHING_LEAD, leadId: 'lead-2', listId: 'list-2' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([MATCHING_LEAD, lead2] as any);
    mockCrmDb.getLeadListById
      .mockResolvedValueOnce(LIST as any)
      .mockResolvedValueOnce({ ...LIST, listId: 'list-2' } as any);
    mockAlertService.notifyLinkedInConnectionAccepted
      .mockRejectedValueOnce(new Error('email send failed'))
      .mockResolvedValueOnce(undefined);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockAlertService.notifyLinkedInConnectionAccepted).toHaveBeenCalledTimes(2);
  });

  it('does nothing when newConnections array is empty', async () => {
    await notifyNewConnections([]);

    expect(mockCrmDb.findLeadsByLinkedin).not.toHaveBeenCalled();
    expect(mockAlertService.notifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
  });
});
