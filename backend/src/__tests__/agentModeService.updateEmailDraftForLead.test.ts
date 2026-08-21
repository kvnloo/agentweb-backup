// Unit tests for updateEmailDraftForLead in agentModeService

// Mock OpenAI before importing agentModeService (which creates module-level openai instance)
// Create the mock function inside the factory to ensure it's accessible
const mockChatCompletionsCreate = jest.fn();

jest.mock('openai', () => {
  // Create mock function that will be shared
  const createMock = jest.fn();
  // Store it globally so tests can access it
  (global as any).__openaiMockCreate = createMock;
  
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => {
      return {
        chat: {
          completions: {
            create: createMock,
          },
        },
      };
    }),
  };
});

// Mock dependencies
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
    getLeadEngagements: jest.fn(),
    updateLead: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb, userDb, orgDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;

// Get the mock function from global scope
const getMockCreate = () => (global as any).__openaiMockCreate as jest.Mock;

describe('AgentModeService - updateEmailDraftForLead', () => {
  let agentModeService: AgentModeService;
  let mockReadBrandGuidelines: jest.Mock;
  let mockReadMarketStrategy: jest.Mock;
  let mockGetSenderForLead: jest.Mock;
  let mockCreate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    agentModeService = new AgentModeService();
    // Use jest.spyOn to properly mock private methods
    mockReadBrandGuidelines = jest.spyOn(agentModeService as any, 'readBrandGuidelines') as jest.Mock;
    mockReadMarketStrategy = jest.spyOn(agentModeService as any, 'readMarketStrategy') as jest.Mock;
    mockGetSenderForLead = jest.spyOn(agentModeService as any, 'getSenderForLead') as jest.Mock;

    // Default: allow access (most tests use list owned by userId)
    mockCrmDb.canOrgMemberAccessList.mockResolvedValue(true);

    // Get and clear the OpenAI mock
    mockCreate = getMockCreate();
    if (mockCreate) {
      mockCreate.mockClear();
    } else {
      // If mockCreate is not available, create a fallback
      console.warn('OpenAI mock not found, tests may fail');
    }
  });

  describe('Success cases', () => {
    it('should create email draft with engagement history including email content', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create a welcome email';

      const mockList = {
        listId,
        name: 'Test List',
        userId,
      };

      const mockLead = {
        leadId,
        listId,
        email: 'lead@example.com',
        firstName: 'John',
        lastName: 'Doe',
        company: 'Test Company',
        title: 'CEO',
        notes: 'Test notes',
        customFields: { 'Lead Score': '85' },
      };

      const mockEngagements = [
        {
          eventType: 'email.received',
          createdAt: '2024-01-01T00:00:00Z',
          source: 'email',
          eventData: {
            subject: 'Previous Email',
            from: 'lead@example.com',
            to: ['sender@example.com'],
          },
          emailContent: {
            text: 'This is a long email content that should be included in the prompt. '.repeat(20), // ~1000 chars
            html: '<p>This is a long email content</p>',
          },
        },
        {
          eventType: 'email.sent',
          createdAt: '2024-01-02T00:00:00Z',
          source: 'email',
          eventData: {
            subject: 'Sent Email',
          },
        },
      ];

      const mockBrandGuidelines = {
        exists: true,
        formattedContent: 'Brand guidelines content',
      };

      const mockMarketStrategy = {
        exists: true,
        formattedContent: 'Market strategy content',
      };

      const mockSenderInfo = {
        fromName: 'Sender Name',
        notes: 'Meeting link: https://calendly.com/meeting',
      };

      const mockLLMResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: 'Welcome to Our Platform',
                htmlContent: '<p>Welcome John!</p>',
              }),
            },
          },
        ],
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
        engagements: mockEngagements,
      });
      mockReadBrandGuidelines.mockResolvedValue(mockBrandGuidelines);
      mockReadMarketStrategy.mockResolvedValue(mockMarketStrategy);
      mockGetSenderForLead.mockResolvedValue(mockSenderInfo);

      // Mock OpenAI client (module-level instance)
      mockCreate.mockResolvedValue(mockLLMResponse);

      (crmDb.updateLead as jest.Mock).mockResolvedValue({
        ...mockLead,
        emailDraft: {
          subject: 'Welcome to Our Platform',
          htmlContent: '<p>Welcome John!</p>',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          sessionId,
        },
      });

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId,
        'html' // Specify HTML format since mock returns htmlContent
      );

      expect(result.success).toBe(true);
      expect(crmDb.getLeadEngagements).toHaveBeenCalledWith(listId, leadId, userId);
      expect(mockReadBrandGuidelines).toHaveBeenCalledWith(userId);
      // ENG-945: this prompt embeds formattedContent wholesale, so it must ask
      // for the pre-ENG-945 coverage (40 competitors in full) and must NOT be
      // given the tool-result paging instructions — there is no tool to call
      // here, and offset chatter could leak into customer-facing copy.
      expect(mockReadMarketStrategy).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ minCompetitorsInFull: 40, pagingHints: false }),
      );
      // list.userId === userId here (same user), so listOwnerId === userId
      expect(mockGetSenderForLead).toHaveBeenCalledWith(userId, undefined, undefined, userId);
      expect(crmDb.updateLead).toHaveBeenCalled();
    });

    it('should include first 1k characters of email content from engagements', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Follow up email';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = { leadId, listId, email: 'lead@example.com', firstName: 'John' };

      const longEmailContent = 'A'.repeat(2000); // 2000 characters
      const mockEngagements = [
        {
          eventType: 'email.received',
          createdAt: '2024-01-01T00:00:00Z',
          source: 'email',
          eventData: { subject: 'Previous Email' },
          emailContent: {
            text: longEmailContent,
          },
        },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
        engagements: mockEngagements,
      });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      // Mock OpenAI client (module-level instance)
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Follow Up',
              htmlContent: '<p>Content</p>',
            }),
          },
        }],
      });

      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId,
        'html' // Specify HTML format since mock returns htmlContent
      );

      // Verify that the prompt includes email content (first 1k chars)
      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0];
      const prompt = callArgs[0].messages[1].content;
      
      expect(prompt).toContain('Email Content (first 1k characters)');
      expect(prompt).toContain('A'.repeat(1000)); // First 1000 characters
      expect(prompt).toContain('...'); // Truncation indicator
    });

    it('should extract text from HTML content if text is not available', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Follow up';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = { leadId, listId, email: 'lead@example.com' };

      const mockEngagements = [
        {
          eventType: 'email.received',
          createdAt: '2024-01-01T00:00:00Z',
          source: 'email',
          eventData: { subject: 'Previous Email' },
          emailContent: {
            html: '<p>This is HTML content with <strong>formatting</strong> and <em>styles</em>.</p>',
          },
        },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
        engagements: mockEngagements,
      });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      // Mock OpenAI client (module-level instance)
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Follow Up',
              htmlContent: '<p>Content</p>',
            }),
          },
        }],
      });

      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId,
        'html' // Specify HTML format since mock returns htmlContent
      );

      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0];
      const prompt = callArgs[0].messages[1].content;
      
      // Should extract text from HTML (strip tags)
      expect(prompt).toContain('Email Content (first 1k characters)');
      expect(prompt).toContain('This is HTML content with formatting and styles');
      expect(prompt).not.toContain('<p>');
      expect(prompt).not.toContain('<strong>');
    });

    it('should update existing draft when one exists', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Update the email';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = {
        leadId,
        listId,
        email: 'lead@example.com',
        emailDraft: {
          subject: 'Old Subject',
          htmlContent: '<p>Old content</p>',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
        engagements: [],
      });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      // Mock OpenAI client (module-level instance)
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Updated Subject',
              htmlContent: '<p>Updated content</p>',
            }),
          },
        }],
      });

      (crmDb.updateLead as jest.Mock).mockResolvedValue({
        ...mockLead,
        emailDraft: {
          ...mockLead.emailDraft,
          subject: 'Updated Subject',
          htmlContent: '<p>Updated content</p>',
          updatedAt: expect.any(String),
        },
      });

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId,
        'html' // Specify HTML format since mock returns htmlContent
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('updated');
      
      // Verify existing draft is included in prompt
      expect(mockCreate).toHaveBeenCalled();
      const callArgs = mockCreate.mock.calls[0];
      const prompt = callArgs[0].messages[1].content;
      expect(prompt).toContain('Existing Email Draft');
      expect(prompt).toContain('Old Subject');
    });
  });

  describe('Error cases', () => {
    it('should return error if list not found', async () => {
      const listId = 'nonexistent';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create email';

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error if user does not own the list and is not an org member', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create email';

      const mockList = { listId, name: 'Test List', userId: 'other-user' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      mockCrmDb.canOrgMemberAccessList.mockResolvedValue(false);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should allow access when user is a listed crm.editor of the list owner (ENG-1049)', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create a welcome email';

      // List belongs to a different user in the same org
      const mockList = { listId, name: 'Org List', userId: 'other-org-member' };
      const mockLead = { leadId, listId, email: 'lead@example.com', firstName: 'John' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      mockUserDb.getUserById.mockImplementation((id: string) =>
        Promise.resolve(id === 'other-org-member' ? { userId: 'other-org-member', orgId: 'org-A' } as any : { userId: id, orgId: 'org-A' } as any)
      );
      mockOrgDb.getOrgById.mockResolvedValue({
        orgId: 'org-A',
        ownerUserId: 'org-owner-id',
        shareSettings: { crm: { enabled: true, editors: [userId] } },
      } as any);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ subject: 'Welcome', textContent: 'Hi John!' }) } }],
      });
      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId, leadId, instruction, sessionId, userId
      );

      expect(result.success).toBe(true);
      // Should use the list owner's userId for sender lookup, not the org member's
      expect(mockGetSenderForLead).toHaveBeenCalledWith(userId, undefined, undefined, 'other-org-member');
    });

    it('should deny access when user is a same-org member but not a CRM editor (ENG-1049)', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create a welcome email';

      const mockList = { listId, name: 'Org List', userId: 'other-org-member' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      mockUserDb.getUserById.mockImplementation((id: string) =>
        Promise.resolve(id === 'other-org-member' ? { userId: 'other-org-member', orgId: 'org-A' } as any : { userId: id, orgId: 'org-A' } as any)
      );
      mockOrgDb.getOrgById.mockResolvedValue({
        orgId: 'org-A',
        ownerUserId: 'org-owner-id',
        shareSettings: { crm: { enabled: true, editors: [] } },
      } as any);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId, leadId, instruction, sessionId, userId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should return error if lead not found', async () => {
      const listId = 'list1';
      const leadId = 'nonexistent';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create email';

      const mockList = {
        listId,
        name: 'Test List',
        userId,
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should handle LLM API errors gracefully', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create email';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = { leadId, listId, email: 'lead@example.com' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
        engagements: [],
      });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      // Mock OpenAI client to throw error
      mockCreate.mockRejectedValue(
        new Error('LLM API error')
      );

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed');
    });
  });

  describe('Email format support', () => {
    it('should generate text content when emailFormat is "text"', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create a welcome email';
      const emailFormat = 'text';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = { leadId, listId, email: 'lead@example.com', firstName: 'John', lastName: 'Doe' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      // Mock OpenAI to return text content
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Welcome',
              textContent: 'This is plain text content without HTML tags.',
            }),
          },
        }],
      });

      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId,
        emailFormat
      );

      expect(result.success).toBe(true);
      expect(result.data.email.textContent).toBe('This is plain text content without HTML tags.');
      expect(result.data.email.htmlContent).toBeUndefined();

      // Verify updateLead was called with textContent and format
      expect(crmDb.updateLead).toHaveBeenCalledWith(
        listId,
        leadId,
        expect.objectContaining({
          emailDraft: expect.objectContaining({
            textContent: 'This is plain text content without HTML tags.',
            subject: 'Welcome',
          }),
          emailDraftFormat: 'text',
        })
      );

      // Verify the prompt instructs for text format
      const callArgs = mockCreate.mock.calls[0];
      const prompt = callArgs[0].messages[1].content;
      expect(prompt).toContain('plain text');
      expect(prompt).toContain('textContent');
      expect(prompt).not.toContain('htmlContent');
    });

    it('should generate HTML content when emailFormat is "html"', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create a welcome email';
      const emailFormat = 'html';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = { leadId, listId, email: 'lead@example.com', firstName: 'John', lastName: 'Doe' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      // Mock OpenAI to return HTML content
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Welcome',
              htmlContent: '<p>This is HTML content with <strong>formatting</strong>.</p>',
            }),
          },
        }],
      });

      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId,
        emailFormat
      );

      expect(result.success).toBe(true);
      expect(result.data.email.htmlContent).toBe('<p>This is HTML content with <strong>formatting</strong>.</p>');
      expect(result.data.email.textContent).toBeUndefined();

      // Verify updateLead was called with htmlContent and format
      expect(crmDb.updateLead).toHaveBeenCalledWith(
        listId,
        leadId,
        expect.objectContaining({
          emailDraft: expect.objectContaining({
            htmlContent: '<p>This is HTML content with <strong>formatting</strong>.</p>',
            subject: 'Welcome',
          }),
          emailDraftFormat: 'html',
        })
      );

      // Verify the prompt instructs for HTML format
      const callArgs = mockCreate.mock.calls[0];
      const prompt = callArgs[0].messages[1].content;
      expect(prompt).toContain('HTML');
      expect(prompt).toContain('htmlContent');
    });

    it('should default to text format when emailFormat is not provided and lead has no format preference', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create a welcome email';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = { leadId, listId, email: 'lead@example.com', firstName: 'John', lastName: 'Doe' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Welcome',
              textContent: 'Plain text content',
            }),
          },
        }],
      });

      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId
      );

      expect(result.success).toBe(true);
      expect(crmDb.updateLead).toHaveBeenCalledWith(
        listId,
        leadId,
        expect.objectContaining({
          emailDraftFormat: 'text',
        })
      );
    });

    it('should use lead\'s saved format preference when emailFormat is not provided', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create a welcome email';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = { 
        leadId, 
        listId, 
        email: 'lead@example.com', 
        firstName: 'John', 
        lastName: 'Doe',
        emailDraftFormat: 'html' // Lead has saved preference
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Welcome',
              htmlContent: '<p>HTML content</p>',
            }),
          },
        }],
      });

      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId
      );

      expect(result.success).toBe(true);
      // Should use lead's saved format preference
      expect(crmDb.updateLead).toHaveBeenCalledWith(
        listId,
        leadId,
        expect.objectContaining({
          emailDraftFormat: 'html',
          emailDraft: expect.objectContaining({
            htmlContent: '<p>HTML content</p>',
          }),
        })
      );
    });

    it('should prioritize provided emailFormat over lead\'s saved preference', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create a welcome email';
      const emailFormat = 'text'; // Explicitly provided

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = { 
        leadId, 
        listId, 
        email: 'lead@example.com', 
        firstName: 'John', 
        lastName: 'Doe',
        emailDraftFormat: 'html' // Lead has saved preference, but should be overridden
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });

      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              subject: 'Welcome',
              textContent: 'Plain text content',
            }),
          },
        }],
      });

      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId,
        emailFormat
      );

      expect(result.success).toBe(true);
      // Should use provided format, not lead's preference
      expect(crmDb.updateLead).toHaveBeenCalledWith(
        listId,
        leadId,
        expect.objectContaining({
          emailDraftFormat: 'text', // Should use provided format
          emailDraft: expect.objectContaining({
            textContent: 'Plain text content',
          }),
        })
      );
    });

    it('should create both email draft and message draft', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Create an outreach message';

      const mockList = {
        listId,
        name: 'Test List',
        userId,
      };

      const mockLead = {
        leadId,
        listId,
        email: 'lead@example.com',
        linkedin: 'https://www.linkedin.com/in/leadprofile',
        firstName: 'Jane',
        lastName: 'Smith',
        company: 'Tech Corp',
        title: 'VP Engineering',
      };

      const mockBrandGuidelines = {
        exists: true,
        formattedContent: 'Brand guidelines content',
      };

      const mockMarketStrategy = {
        exists: true,
        formattedContent: 'Market strategy content',
      };

      const mockSenderInfo = {
        fromName: 'Sender Name',
        notes: 'Meeting link: https://calendly.com/meeting',
      };

      // Mock email draft response
      const mockEmailDraftResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: 'Collaboration Opportunity',
                htmlContent: '<p>Hi Jane,</p><p>I noticed your work at Tech Corp and wanted to reach out about a potential collaboration. Our platforms could complement each other well.</p><p>Would you be open to a quick call?</p>',
              }),
            },
          },
        ],
      };

      // Mock message draft response (must be JSON format)
      const mockMessageDraftResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: 'Hi Jane! Noticed your work at Tech Corp. Would love to chat about a potential collaboration. Open to a quick call?',
              }),
            },
          },
        ],
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
        engagements: [],
      });
      mockReadBrandGuidelines.mockResolvedValue(mockBrandGuidelines);
      mockReadMarketStrategy.mockResolvedValue(mockMarketStrategy);
      mockGetSenderForLead.mockResolvedValue(mockSenderInfo);

      // Mock OpenAI responses: first for email draft, second for message draft
      mockCreate
        .mockResolvedValueOnce(mockEmailDraftResponse)
        .mockResolvedValueOnce(mockMessageDraftResponse);

      (crmDb.updateLead as jest.Mock).mockResolvedValue({
        ...mockLead,
        emailDraft: {
          subject: 'Collaboration Opportunity',
          htmlContent: '<p>Hi Jane,</p><p>I noticed your work at Tech Corp and wanted to reach out about a potential collaboration. Our platforms could complement each other well.</p><p>Would you be open to a quick call?</p>',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          sessionId,
        },
        messageDraft: {
          content: 'Hi Jane! Noticed your work at Tech Corp. Would love to chat about a potential collaboration. Open to a quick call?',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          sessionId,
        },
      });

      const result = await (agentModeService as any).updateEmailDraftForLead(
        listId,
        leadId,
        instruction,
        sessionId,
        userId,
        'html'
      );

      expect(result.success).toBe(true);

      // Should call OpenAI twice: once for email draft, once for message draft
      expect(mockCreate).toHaveBeenCalledTimes(2);

      // Verify first call is for email draft
      const firstCall = mockCreate.mock.calls[0][0];
      expect(firstCall.messages[0].content).toContain('email marketing strategist');

      // Verify second call is for message draft
      const secondCall = mockCreate.mock.calls[1][0];
      const secondUserMsg = secondCall.messages.find((m: any) => m.role === 'user');
      expect(secondUserMsg.content).toContain('LinkedIn connection request note');
      expect(secondUserMsg.content).toContain('LinkedIn');

      // Should update lead with both email and message drafts
      expect(crmDb.updateLead).toHaveBeenCalledWith(
        listId,
        leadId,
        expect.objectContaining({
          emailDraft: expect.objectContaining({
            subject: 'Collaboration Opportunity',
            htmlContent: expect.any(String),
          }),
          messageDraft: expect.objectContaining({
            content: expect.any(String),
          }),
        })
      );

      // Verify message draft is concise (should be under 500 chars)
      const updateCall = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
      expect(updateCall.messageDraft.content.length).toBeLessThanOrEqual(500);
    });
  });

  describe('Message draft activity history', () => {
    const listId = 'list-1';
    const leadId = 'lead-1';
    const sessionId = 'session-1';
    const userId = 'user-1';
    const instruction = 'Write a follow-up';

    const mockLead = {
      leadId,
      listId,
      email: 'jane@techcorp.com',
      firstName: 'Jane',
      lastName: 'Smith',
      company: 'Tech Corp',
      title: 'CTO',
    };
    const mockList = { listId, userId, name: 'Test List' };
    const mockBrandGuidelines = { exists: false };
    const mockMarketStrategy = { exists: false };
    const mockSenderInfo = { fromName: 'Test Sender' };

    const emailDraftResponse = {
      choices: [{ message: { content: JSON.stringify({ subject: 'Follow up', textContent: 'Hi Jane, following up.' }) } }],
    };
    const messageDraftResponse = {
      choices: [{ message: { content: JSON.stringify({ content: 'Hi Jane, quick follow up!' }) } }],
    };

    it('includes activity history in the message draft prompt', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({
        engagements: [
          { eventType: 'email.sent', createdAt: '2026-05-01T10:00:00.000Z', eventData: { subject: 'Intro email' }, emailContent: null, text: null },
          { eventType: 'linkedin.message.received', createdAt: '2026-05-03T09:00:00.000Z', eventData: {}, text: 'Thanks, interested!' },
        ],
      });
      mockReadBrandGuidelines.mockResolvedValue(mockBrandGuidelines);
      mockReadMarketStrategy.mockResolvedValue(mockMarketStrategy);
      mockGetSenderForLead.mockResolvedValue(mockSenderInfo);
      (crmDb.updateLead as jest.Mock).mockResolvedValue({});
      mockCreate.mockResolvedValueOnce(emailDraftResponse).mockResolvedValueOnce(messageDraftResponse);

      await (agentModeService as any).updateEmailDraftForLead(listId, leadId, instruction, sessionId, userId, 'text');

      const messageCall = mockCreate.mock.calls[1][0];
      const userMsg = messageCall.messages.find((m: any) => m.role === 'user');
      expect(userMsg.content).toContain('Activity History');
      expect(userMsg.content).toContain('email.sent');
      expect(userMsg.content).toContain('Intro email');
      expect(userMsg.content).toContain('linkedin.message.received');
    });

    it('omits activity history section from message prompt when no engagements', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue(mockBrandGuidelines);
      mockReadMarketStrategy.mockResolvedValue(mockMarketStrategy);
      mockGetSenderForLead.mockResolvedValue(mockSenderInfo);
      (crmDb.updateLead as jest.Mock).mockResolvedValue({});
      mockCreate.mockResolvedValueOnce(emailDraftResponse).mockResolvedValueOnce(messageDraftResponse);

      await (agentModeService as any).updateEmailDraftForLead(listId, leadId, instruction, sessionId, userId, 'text');

      const messageCall = mockCreate.mock.calls[1][0];
      const userMsg = messageCall.messages.find((m: any) => m.role === 'user');
      expect(userMsg.content).not.toContain('Activity History');
    });

    it('re-generates a shorter LinkedIn note when the message draft exceeds the limit, then trims', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue(mockBrandGuidelines);
      mockReadMarketStrategy.mockResolvedValue(mockMarketStrategy);
      mockGetSenderForLead.mockResolvedValue(mockSenderInfo);
      (crmDb.updateLead as jest.Mock).mockResolvedValue({});

      const overLimitNote = 'x'.repeat(260); // > 200 free-account limit
      const reworked = 'Jane, your Tech Corp platform work is the kind of thing I keep an eye on — wanted to be in your network.';
      expect(reworked.length).toBeLessThanOrEqual(200);
      mockCreate
        .mockResolvedValueOnce(emailDraftResponse) // 1: email draft
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ content: overLimitNote }) } }] }) // 2: over-limit message draft
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ content: reworked }) } }] }); // 3: capped re-gen (fits)

      await (agentModeService as any).updateEmailDraftForLead(listId, leadId, instruction, sessionId, userId, 'text');

      // email + over-limit draft + one re-gen attempt that fits
      expect(mockCreate).toHaveBeenCalledTimes(3);
      const updateCall = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
      expect(updateCall.messageDraft.content).toBe(reworked);
    });
  });
});
