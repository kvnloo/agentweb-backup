/**
 * Tests for notifyNewConnections — sends an email notification to the list owner
 * when a CRM lead's LinkedIn connection request is accepted.
 */

jest.mock('openai', () => {
  const createMock = jest.fn().mockResolvedValue({
    choices: [{ message: { content: '{"content":"Hi, thanks for connecting!"}' } }],
  });
  (global as any).__linkedInCronOpenAICreate = createMock;
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: createMock,
      },
    },
  }));
});

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    readBrandGuidelines: jest.fn().mockResolvedValue(null),
    readMarketStrategy: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { listConnections: jest.fn() },
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: jest.fn(),
  getLatestConnectedAt: jest.fn().mockResolvedValue(null),
  // Mirror the real normalizer: lowercase + force a trailing slash.
  normalizeLinkedInUrl: jest.fn((url: string) => {
    let u = url.trim().toLowerCase();
    if (!u.endsWith('/')) u += '/';
    return u;
  }),
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
    updateLead: jest.fn().mockResolvedValue(undefined),
    getLeadEngagements: jest.fn().mockResolvedValue({ engagements: [] }),
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
import { agentModeService } from '../services/agentModeService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockAlertService = leadListAlertService as jest.Mocked<typeof leadListAlertService>;
const mockReadBrandGuidelines = agentModeService.readBrandGuidelines as jest.Mock;
const mockReadMarketStrategy = agentModeService.readMarketStrategy as jest.Mock;
const getOpenAICreate = () => (global as any).__linkedInCronOpenAICreate as jest.Mock;

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

// List has an assigned LinkedIn sender matching the connection's account, so
// notifications fire (the sender-gate requirement).
const LIST = { listId: 'list-1', name: 'Outreach List', userId: 'user-1', linkedInAccountId: 'account-1' };

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

  it('skips notification when lead already has linkedInConnectionNotifiedAt set', async () => {
    const alreadyNotifiedLead = {
      ...MATCHING_LEAD,
      system: { linkedInConnectionNotifiedAt: '2026-05-27T00:00:00.000Z' },
    };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([alreadyNotifiedLead] as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockCrmDb.getLeadListById).not.toHaveBeenCalled();
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    expect(mockAlertService.notifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
  });

  it('skips notification when the list has no assigned LinkedIn sender', async () => {
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([MATCHING_LEAD] as any);
    mockCrmDb.getLeadListById.mockResolvedValue({ ...LIST, linkedInAccountId: null } as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    expect(mockAlertService.notifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
  });

  it('skips notification when the list sender differs from the connection account', async () => {
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([MATCHING_LEAD] as any);
    mockCrmDb.getLeadListById.mockResolvedValue({ ...LIST, linkedInAccountId: 'other-account' } as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    expect(mockAlertService.notifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
  });

  it('matches leads stored without a trailing slash even though the connection URL has one', async () => {
    // Connection URL is normalized with a trailing slash; the lead was stored
    // WITHOUT one (CSV import / enrichment strip it). Both variants must be queried.
    const connWithSlash = { ...NEW_CONNECTION, publicProfileUrl: 'https://www.linkedin.com/in/john-prospect/' };
    const leadNoSlash = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };

    mockCrmDb.findLeadsByLinkedin.mockImplementation(async (url: string) =>
      (url === 'https://www.linkedin.com/in/john-prospect' ? [leadNoSlash] : []) as any,
    );
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);

    await notifyNewConnections([connWithSlash]);

    expect(mockCrmDb.findLeadsByLinkedin).toHaveBeenCalledWith('https://www.linkedin.com/in/john-prospect');
    expect(mockAlertService.notifyLinkedInConnectionAccepted).toHaveBeenCalledWith(LIST, leadNoSlash);
  });

  it('does not notify twice when both URL variants return the same lead', async () => {
    // findLeadsByLinkedin returns the same lead for both the slash and no-slash
    // lookups — the helper must dedup so the owner is notified only once.
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([MATCHING_LEAD] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockAlertService.notifyLinkedInConnectionAccepted).toHaveBeenCalledTimes(1);
  });

  it('marks lead with linkedInConnectionNotifiedAt before sending notification', async () => {
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([MATCHING_LEAD] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockCrmDb.updateLead).toHaveBeenCalledWith(
      MATCHING_LEAD.listId,
      MATCHING_LEAD.leadId,
      expect.objectContaining({
        system: expect.objectContaining({ linkedInConnectionNotifiedAt: expect.any(String) }),
        skipFieldNamesUpdate: true,
      }),
    );
    expect(mockAlertService.notifyLinkedInConnectionAccepted).toHaveBeenCalledWith(LIST, MATCHING_LEAD);
  });
});

describe('generateConnectionFollowUpDraft — activity history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAlertService.notifyLinkedInConnectionAccepted.mockResolvedValue(undefined);
    // Reset OpenAI mock to default success response
    getOpenAICreate().mockResolvedValue({
      choices: [{ message: { content: '{"content":"Hi, thanks for connecting!"}' } }],
    });
  });

  it('fetches lead engagements and passes them to the AI prompt when activity exists', async () => {
    const leadWithLinkedIn = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithLinkedIn] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);
    mockCrmDb.getLeadEngagements.mockResolvedValue({
      engagements: [
        { eventType: 'email.sent', createdAt: '2026-05-01T10:00:00.000Z', eventData: { subject: 'Quick intro' }, text: null },
        { eventType: 'email.opened', createdAt: '2026-05-02T08:00:00.000Z', eventData: {}, text: null },
      ],
    } as any);

    await notifyNewConnections([NEW_CONNECTION]);

    const createMock = getOpenAICreate();
    expect(createMock).toHaveBeenCalled();
    const callArgs = createMock.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: any) => m.role === 'user');
    expect(userMessage.content).toContain('email.sent');
    expect(userMessage.content).toContain('Quick intro');
    expect(userMessage.content).toContain('prior touchpoints');
  });

  it('generates draft without activity section when no engagements exist', async () => {
    const leadWithLinkedIn = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithLinkedIn] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);
    mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);

    await notifyNewConnections([NEW_CONNECTION]);

    const createMock = getOpenAICreate();
    expect(createMock).toHaveBeenCalled();
    const callArgs = createMock.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: any) => m.role === 'user');
    // No activity section should appear
    expect(userMessage.content).not.toContain('Past activity');
    // Should still be a valid draft prompt
    expect(userMessage.content).toContain('LinkedIn lead just accepted');
  });

  it('saves the generated draft content to the lead record', async () => {
    const leadWithLinkedIn = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithLinkedIn] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);
    mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);

    await notifyNewConnections([NEW_CONNECTION]);

    // updateLead should be called twice: once for notifiedAt, once for messageDraft
    const draftCall = (mockCrmDb.updateLead as jest.Mock).mock.calls.find(
      (args: any[]) => args[2]?.messageDraft,
    );
    expect(draftCall).toBeDefined();
    expect(draftCall![2].messageDraft.content).toBe('Hi, thanks for connecting!');
  });

  it('skips draft generation when lead already has a messageDraft', async () => {
    const leadWithDraft = {
      ...MATCHING_LEAD,
      linkedin: 'https://www.linkedin.com/in/john-prospect',
      messageDraft: { content: 'Existing draft', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
    };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithDraft] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);

    await notifyNewConnections([NEW_CONNECTION]);

    // getLeadEngagements should NOT be called since we short-circuit early
    expect(mockCrmDb.getLeadEngagements).not.toHaveBeenCalled();
  });
});

describe('generateConnectionFollowUpDraft — brand voice & market strategy context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAlertService.notifyLinkedInConnectionAccepted.mockResolvedValue(undefined);
    getOpenAICreate().mockResolvedValue({
      choices: [{ message: { content: '{"content":"Hi, thanks for connecting!"}' } }],
    });
    mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);
  });

  it('injects brand voice from readBrandGuidelines().formattedContent into the prompt', async () => {
    const leadWithLinkedIn = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithLinkedIn] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);
    mockReadBrandGuidelines.mockResolvedValue({
      exists: true,
      formattedContent: 'Tone of voice: warm, concise, founder-led. We never use buzzwords.',
    });
    mockReadMarketStrategy.mockResolvedValue(null);

    await notifyNewConnections([NEW_CONNECTION]);

    const userMessage = getOpenAICreate().mock.calls[0][0].messages.find((m: any) => m.role === 'user');
    expect(userMessage.content).toContain('warm, concise, founder-led');
  });

  it('injects market strategy from readMarketStrategy().formattedContent into the prompt', async () => {
    const leadWithLinkedIn = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithLinkedIn] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);
    mockReadBrandGuidelines.mockResolvedValue(null);
    mockReadMarketStrategy.mockResolvedValue({
      exists: true,
      formattedContent: 'We sell browser-isolation security to mid-market CISOs.',
    });

    await notifyNewConnections([NEW_CONNECTION]);

    const userMessage = getOpenAICreate().mock.calls[0][0].messages.find((m: any) => m.role === 'user');
    expect(userMessage.content).toContain('browser-isolation security to mid-market CISOs');
  });

  it('omits brand/strategy lines when neither exists', async () => {
    const leadWithLinkedIn = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithLinkedIn] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);
    mockReadBrandGuidelines.mockResolvedValue({ exists: false });
    mockReadMarketStrategy.mockResolvedValue({ exists: false });

    await notifyNewConnections([NEW_CONNECTION]);

    const userMessage = getOpenAICreate().mock.calls[0][0].messages.find((m: any) => m.role === 'user');
    expect(userMessage.content).not.toContain('Brand voice:');
    expect(userMessage.content).not.toContain('Offer/market fit:');
  });
});

describe('generateConnectionFollowUpDraft — message direction labelling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAlertService.notifyLinkedInConnectionAccepted.mockResolvedValue(undefined);
    getOpenAICreate().mockResolvedValue({
      choices: [{ message: { content: '{"content":"Hi, thanks for connecting!"}' } }],
    });
    mockReadBrandGuidelines.mockResolvedValue(null);
    mockReadMarketStrategy.mockResolvedValue(null);
  });

  it('labels sent vs received messages so the model can tell direction', async () => {
    const leadWithLinkedIn = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithLinkedIn] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);
    mockCrmDb.getLeadEngagements.mockResolvedValue({
      engagements: [
        { eventType: 'linkedin.message.sent', createdAt: '2026-05-01T10:00:00.000Z', text: 'Saw your work on isolation' },
        { eventType: 'linkedin.message.received', createdAt: '2026-05-02T08:00:00.000Z', text: 'Thanks, appreciate it!' },
      ],
    } as any);

    await notifyNewConnections([NEW_CONNECTION]);

    const userMessage = getOpenAICreate().mock.calls[0][0].messages.find((m: any) => m.role === 'user');
    // Outbound (sent/opened) → "You", inbound (received/replied) → "Them"
    expect(userMessage.content).toContain('You sent');
    expect(userMessage.content).toContain('They sent');
  });
});

describe('generateConnectionFollowUpDraft — prompt quality guardrails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAlertService.notifyLinkedInConnectionAccepted.mockResolvedValue(undefined);
    getOpenAICreate().mockResolvedValue({
      choices: [{ message: { content: '{"content":"Hi, thanks for connecting!"}' } }],
    });
    mockReadBrandGuidelines.mockResolvedValue(null);
    mockReadMarketStrategy.mockResolvedValue(null);
    mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);
  });

  it('includes a banned-words list and a good/bad example in the prompt', async () => {
    const leadWithLinkedIn = { ...MATCHING_LEAD, linkedin: 'https://www.linkedin.com/in/john-prospect' };
    mockCrmDb.findLeadsByLinkedin.mockResolvedValue([leadWithLinkedIn] as any);
    mockCrmDb.getLeadListById.mockResolvedValue(LIST as any);

    await notifyNewConnections([NEW_CONNECTION]);

    const userMessage = getOpenAICreate().mock.calls[0][0].messages.find((m: any) => m.role === 'user');
    expect(userMessage.content).toContain('synergy');
    expect(userMessage.content.toLowerCase()).toContain('good:');
    expect(userMessage.content.toLowerCase()).toContain('bad:');
  });
});
