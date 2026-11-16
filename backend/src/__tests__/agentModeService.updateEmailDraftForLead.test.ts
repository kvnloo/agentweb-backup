// Unit tests for updateEmailDraftForLead in agentModeService

// Mock OpenAI before importing agentModeService (which creates module-level openai instance)
// Create the mock function inside the factory to ensure it's accessible
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
// ENG-2103 (F2 design-decision-list follow-up, Pattern A): updateEmailDraftForLead's
// body now lives in emma/impl/leads.ts, which calls readBrandGuidelines/
// readMarketStrategy directly (they are already fully decoupled, plain
// exported functions in emma/impl/brandMarketStrategy.ts) rather than via
// `this.readBrandGuidelines`/`this.readMarketStrategy` — so the spies below
// target the module's real exports instead of the class methods. TypeScript
// compiles leads.ts's named imports of these functions to property access on
// this same module object at each call site, so jest.spyOn here still
// intercepts them correctly (same mechanism this series' `jest.spyOn(<impl
// module>, '<fn>')` retargets have relied on throughout). `getSenderForLead`
// is NOT retargeted — it stays injected as `this.getSenderForLead.bind(this)`
// from the class wrapper (see leads.ts's own header comment on why it wasn't
// promoted to a shared module this round), so spying on the class method is
// still correct and unchanged.
import * as brandMarketStrategyImpl from '../emma/impl/brandMarketStrategy';

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
    // ENG-2103 (F2 follow-up): readBrandGuidelines/readMarketStrategy are now
    // called directly from emma/impl/brandMarketStrategy.ts by the moved
    // updateEmailDraftForLead body, not via `this.` — spy on the module's
    // real exports (see the import comment above), not the class methods.
    mockReadBrandGuidelines = jest.spyOn(brandMarketStrategyImpl, 'readBrandGuidelines') as jest.Mock;
    mockReadMarketStrategy = jest.spyOn(brandMarketStrategyImpl, 'readMarketStrategy') as jest.Mock;
    // getSenderForLead is still injected via `this.getSenderForLead.bind(this)`
    // from the class wrapper — the class-method spy is still correct here.
    mockGetSenderForLead = jest.spyOn(agentModeService as any, 'getSenderForLead') as jest.Mock;
    jest.spyOn(agentModeService, 'getReportGenerationDefaultModel').mockResolvedValue('gpt-5.5');

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
    jest.spyOn(agentModeService, 'callLLM').mockImplementation(
      (model: string, messages: any[], options: any) =>
        mockCreate({ model, messages, ...options }),
    );
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
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.5' }));
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
    // ENG-2082: lead capture now accepts phone-only submissions, and this runs
    // fire-and-forget from the forward-lead webhook when the list has autoDraftEnabled.
    // Unguarded it spends two billed LLM calls writing a polished email to someone with no
    // address — and a LinkedIn note for a lead with no LinkedIn — then persists both and
    // reports success. send_email_to_lead already refuses on this exact condition.
    // This function ALSO writes the LinkedIn connection-request note, and
    // linkedInInviteCrmMirror creates leads with a linkedin and no email. Gating on email
    // alone deleted a working feature to fix a new one.
    // Widening the guard to `!email && !linkedin` let the LinkedIn note through — but left
    // the EMAIL path running for those leads too: two billed LLM calls producing a polished
    // draft addressed to nobody, the exact harm the guard was added to prevent.
    it('a LinkedIn-only lead gets NO email draft, and no email is written to the lead', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list1', userId: 'user1' });
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead1', listId: 'list1', linkedin: 'https://linkedin.com/in/ada',
        firstName: 'Ada', lastName: 'Lovelace',
      });

      await (agentModeService as any).updateEmailDraftForLead(
        'list1', 'lead1', 'Create email', 'session1', 'user1'
      );

      // Assert on the LLM CALLS, not on the result. Both the gated and ungated versions
      // return a similar-looking object once the mocked LLM yields nothing usable, so a
      // result-shaped assertion cannot tell them apart — it passes either way. The billed
      // call is the harm, so that is what to measure.
      const systemPrompts = (agentModeService.callLLM as jest.Mock).mock.calls
        .flatMap((c: any[]) => (c[1] ?? []))
        .filter((m: any) => m?.role === 'system')
        .map((m: any) => String(m.content));
      expect(systemPrompts.some((p) => p.includes('email marketing strategist'))).toBe(false);

      // The name says "and no email is written to the lead" — assert it, rather than
      // leaving half the name unverified.
      const written = (crmDb.updateLead as jest.Mock).mock.calls.map((c: any[]) => c[2] ?? {});
      expect(written.some((w: any) => 'emailDraft' in w || 'emailDraftFormat' in w)).toBe(false);
    });

    it('still drafts for a LinkedIn-only lead (no email)', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list1', userId: 'user1' });
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead1', listId: 'list1', linkedin: 'https://linkedin.com/in/ada',
        firstName: 'Ada', lastName: 'Lovelace',
      });

      const result = await (agentModeService as any).updateEmailDraftForLead(
        'list1', 'lead1', 'Create email', 'session1', 'user1'
      );

      expect(result?.message).not.toBe('No email address');
      expect(crmDb.getLeadEngagements).toHaveBeenCalled();
    });

    // Found on env2, NOT here. The two assertions above both pass while the function
    // throws: one measures a prompt that was never sent, the other a call made before the
    // throw. The gating change set `emailData` to null for a LinkedIn-only lead, and the
    // note builder dereferenced `emailData.textContent` one line ABOVE the ternary that
    // handles null — so the lead this whole branch exists to serve got a TypeError and no
    // note at all. Assert the outcome, not the absence of a side effect.
    it('a LinkedIn-only lead REACHES the note builder without throwing on the null email draft', async () => {
      // Mocked HERE, not inherited. jest.config sets clearMocks, which clears calls but not
      // implementations, so this test previously survived on a mockResolvedValue leaked
      // from a test ~100 lines above and threw when run with -t in isolation.
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue([]);
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list1', userId: 'user1' });
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead1', listId: 'list1', linkedin: 'https://linkedin.com/in/ada',
        firstName: 'Ada', lastName: 'Lovelace', title: 'CTO', company: 'Analytical Engines',
      });

      const result = await (agentModeService as any).updateEmailDraftForLead(
        'list1', 'lead1', 'Create email', 'session1', 'user1'
      );

      // The TypeError surfaced as a failure result with that exact text.
      expect(String(result?.error ?? '')).not.toMatch(/Cannot read properties of null/);
      expect(String(result?.error ?? '')).not.toMatch(/textContent/);

      // And the note prompt must actually have been built and sent — the note is the only
      // thing a LinkedIn-only lead can get, so "no email prompt" alone is not success.
      const systemPrompts = (agentModeService.callLLM as jest.Mock).mock.calls
        .flatMap((c: any[]) => (c[1] ?? []))
        .map((m: any) => String(m?.content ?? ''));
      const userPrompts = (agentModeService.callLLM as jest.Mock).mock.calls
        .flatMap((c: any[]) => (c[1] ?? []))
        .filter((m: any) => m?.role === 'user')
        .map((m: any) => String(m.content));
      const all = [...systemPrompts, ...userPrompts].join('\n');
      expect(all).toMatch(/LinkedIn connection request note/i);
      // With no draft to quote it must fall back to the profile-only wording, not to
      // "Subject: undefined".
      expect(all).toMatch(/no address on file/i);
      expect(all).not.toMatch(/Subject: undefined/);
    });

    // The other half of "the two drafts are independent". A commit claimed the note was
    // gated on lead.linkedin; only the email gate existed, so every ordinary email-only
    // lead paid a second billed LLM call to write a LinkedIn note for a lead with no
    // LinkedIn URL — the mirror image of the harm the guard was added to stop.
    it('an EMAIL-ONLY lead does not pay for a LinkedIn note it can never send', async () => {
      // A real email draft, so the run reaches persistence and `success` means something.
      (agentModeService.callLLM as jest.Mock).mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({
          subject: 'Hello Ada', textContent: 'Hi Ada, quick note.',
        }) } }],
      });
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue([]);
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list1', userId: 'user1' });
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead1', listId: 'list1', email: 'ada@example.com',
        firstName: 'Ada', lastName: 'Lovelace',
      });

      const result = await (agentModeService as any).updateEmailDraftForLead(
        'list1', 'lead1', 'Create email', 'session1', 'user1'
      );

      // FIRST: the run has to have SUCCEEDED. Without this the test cannot tell "the note
      // was gated off" from "the note path threw before building its prompt" — the
      // absence-only version passed under a mutation that forced the gate open, because
      // resolving the LinkedIn account then failed and the prompt was never reached.
      expect(result?.success).toBe(true);
      const written = (crmDb.updateLead as jest.Mock).mock.calls.map((c: any[]) => c[2] ?? {});
      expect(written.some((w: any) => 'emailDraft' in w)).toBe(true);

      const prompts = (agentModeService.callLLM as jest.Mock).mock.calls
        .flatMap((c: any[]) => (c[1] ?? []))
        .map((m: any) => String(m?.content ?? ''));
      const all = prompts.join('\n');
      // The email draft is the whole job for this lead...
      expect(all).toMatch(/email marketing strategist/i);
      // ...and the note prompt must never be built.
      expect(all).not.toMatch(/LinkedIn connection request note/i);
      // Measure the billed calls directly, not just the prompt text.
      const features = (agentModeService.callLLM as jest.Mock).mock.calls
        .map((c: any[]) => c[2]?.usageContext?.feature).filter(Boolean);
      expect(features).not.toContain('invite_message');
      // And nothing is persisted as a message draft for a lead with no LinkedIn.
      expect(written.some((w: any) => 'messageDraft' in w)).toBe(false);
      expect(result?.data?.message ?? null).toBeNull();
    });

    it('marks a lead with no contact channel as SKIPPED, not failed', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list1', userId: 'user1' });
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead1', listId: 'list1', phone: '2125559876', firstName: '', lastName: '',
      });

      const result = await (agentModeService as any).updateEmailDraftForLead(
        'list1', 'lead1', 'Create email', 'session1', 'user1'
      );

      // `skipped` is what stops webhooks.ts reporting autoDraftStatus='failed' and putting
      // the reason into the owner alert on every phone-only capture.
      expect(result.success).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('no_contact_channel');
      expect(crmDb.getLeadEngagements).not.toHaveBeenCalled();
    });

    it('refuses to draft for a lead with no email address, before any LLM call', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list1', userId: 'user1' });
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead1', listId: 'list1', phone: '2125559876', firstName: '', lastName: '',
      });

      const result = await (agentModeService as any).updateEmailDraftForLead(
        'list1', 'lead1', 'Create email', 'session1', 'user1'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('No contact channel');
      // nothing drafted, nothing billed
      expect(crmDb.getLeadEngagements).not.toHaveBeenCalled();
    });

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
      // Required now that the note is gated on it. These three tests are ABOUT the
      // LinkedIn connection-request note, and a note for a lead with no profile URL
      // cannot be sent — sendInvitation needs one — so the fixture was describing a
      // lead the feature does not apply to.
      linkedin: 'https://linkedin.com/in/jane-smith',
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

  // ENG-1388: this draft is generated FOR the external lead/prospect — a
  // customFields JSON dump was being embedded straight into the LLM prompt,
  // which could put Enigma card revenue (internal-use-only) into content sent
  // outside the company. Unlike the other ENG-1388 fixes, this strip is
  // unconditional: it doesn't matter whether the requesting user is
  // Enigma-allowlisted, because the allowlist governs internal visibility,
  // not what may inform outward-facing copy.
  describe('card revenue exclusion from the email prompt (ENG-1388)', () => {
    it('never includes card-revenue fields in the LLM prompt, even for an allowlisted requester', async () => {
      const listId = 'list1';
      const leadId = 'lead1';
      const userId = 'user1';
      const sessionId = 'session1';
      const instruction = 'Follow up email';

      const mockList = { listId, name: 'Test List', userId };
      const mockLead = {
        leadId,
        listId,
        email: 'lead@example.com',
        firstName: 'John',
        customFields: { card_revenue_12m: '41999657', card_revenue_period_end: '2026-06-30', industry: 'Software' },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      mockReadBrandGuidelines.mockResolvedValue({ exists: false });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ subject: 'Follow Up', htmlContent: '<p>Content</p>' }) } }],
      });
      (crmDb.updateLead as jest.Mock).mockResolvedValue(mockLead);

      await (agentModeService as any).updateEmailDraftForLead(listId, leadId, instruction, sessionId, userId, 'html');

      expect(mockCreate).toHaveBeenCalled();
      const prompt = mockCreate.mock.calls[0][0].messages[1].content;
      expect(prompt).not.toContain('card_revenue_12m');
      expect(prompt).not.toContain('41999657');
      expect(prompt).not.toContain('card_revenue_period_end');
      expect(prompt).toContain('industry');
      expect(prompt).toContain('Software');
    });
  });
  // ENG-3067: the shadow claim check runs on both server-side draft paths and
  // can neither change nor fail the draft.
  describe('shadow claim check (ENG-3067)', () => {
    const run = async () => {
      const listId = 'list-shadow';
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId, name: 'L', userId: 'user1' });
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead1', listId, email: 'lead@example.com', firstName: 'John', linkedin: 'https://linkedin.com/in/john',
      });
      (crmDb.getLeadEngagements as jest.Mock).mockResolvedValue({ engagements: [] });
      (crmDb.updateLead as jest.Mock).mockResolvedValue({});
      mockReadBrandGuidelines.mockResolvedValue({ exists: true, brandData: { brandName: 'Acme' }, formattedContent: 'Acme' });
      mockReadMarketStrategy.mockResolvedValue({ exists: false });
      mockGetSenderForLead.mockResolvedValue({ fromName: 'Sender' });
      mockCreate.mockImplementation(async ({ messages }: any) => ({
        choices: [{
          message: {
            content: String(messages[messages.length - 1].content).includes('LinkedIn connection request note')
              ? JSON.stringify({ content: 'John, we cut onboarding by 70% last year.' })
              : JSON.stringify({ subject: 'Idea', textContent: 'We cut reporting time by 40%.' }),
          },
        }],
      }));
      const result = await (agentModeService as any).updateEmailDraftForLead(listId, 'lead1', 'Draft it', 's1', 'user1', 'text');
      return { result, saved: (crmDb.updateLead as jest.Mock).mock.calls.at(-1)?.[2] };
    };
    const strip = (v: any) => JSON.stringify(v, (k, val) => (k === 'createdAt' || k === 'updatedAt' ? undefined : val));
    const shadowLines = (spy: jest.SpyInstance) => spy.mock.calls
      .map(c => String(c[0]))
      .filter(l => l.includes('outreach_claim_check_shadow'));

    it('logs one count-only line per draft with the lead list id', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const { result } = await run();
        expect(result.success).toBe(true);
        const lines = shadowLines(logSpy);
        expect(lines.map(l => JSON.parse(l))).toEqual([
          expect.objectContaining({ channel: 'email', listId: 'list-shadow', status: 'checked', unsupportedTotal: 1 }),
          expect.objectContaining({ channel: 'linkedin_note', listId: 'list-shadow', status: 'checked', unsupportedTotal: 1 }),
        ]);
        for (const line of lines) {
          expect(line).not.toContain('reporting');
          expect(line).not.toContain('onboarding');
        }
      } finally {
        logSpy.mockRestore();
      }
    });

    it('returns and saves the same drafts when the check blows up', async () => {
      const quiet = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const ok = await run();
      quiet.mockRestore();
      const failing = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
        if (String(args[0]).includes('outreach_claim_check_shadow')) throw new Error('shadow check failed');
      });
      try {
        const broken = await run();
        expect(shadowLines(failing).length).toBeGreaterThan(0);
        expect(broken.result.success).toBe(true);
        expect(strip(broken.result)).toBe(strip(ok.result));
        expect(strip(broken.saved)).toBe(strip(ok.saved));
        expect(broken.saved.emailDraft.textContent).toBe('We cut reporting time by 40%.');
      } finally {
        failing.mockRestore();
      }
    });
  });
});
