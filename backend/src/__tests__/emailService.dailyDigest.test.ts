import { emailService } from '../services/emailService';
import { chatbotDb } from '../services/chatbotService';
import { scheduleDb, userDb } from '../services/db';

// Mock the chatbot service
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createOrReuseInteractiveShare: jest.fn(),
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn()
  }
}));

// ENG-1552: the digest now runs the ENG-500 recipient guard, which reads the owner
// and each recipient's admin status, and records delivery state on the schedule.
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn() },
  scheduleDb: { appendDeliveryLogEntry: jest.fn().mockResolvedValue(undefined), getScheduleById: jest.fn() },
}));

// Mock the email sending function
jest.mock('../services/emailService', () => {
  const originalModule = jest.requireActual('../services/emailService');
  return {
    ...originalModule,
    emailService: {
      ...originalModule.emailService,
      sendEmail: jest.fn().mockResolvedValue(undefined)
    }
  };
});

describe('Daily Digest Email Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Ordinary runs: the guard can positively verify each session made no
    // cross-account tool call, so the digest goes to every configured address.
    (chatbotDb.getChatSession as jest.Mock).mockImplementation(async (sessionId: string) =>
      ({ sessionId, userId: 'owner-id', calledFunctions: {} }));
    (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner-id', email: 'owner@example.com', isAdmin: false });
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ isAdmin: false });
  });

  describe('sendDailyDigestEmail', () => {
    const mockResults = [
      {
        passed: true,
        actualResponse: 'Test response 1',
        keywordMatches: ['keyword1'],
        keywordMisses: [],
        functionCallMatches: ['function1'],
        functionCallMisses: [],
        executionTime: 5000,
        sessionId: 'session-1',
        attempt: 1,
        createdAt: '2024-01-15T10:00:00Z'
      },
      {
        passed: false,
        actualResponse: 'Test response 2',
        keywordMatches: [],
        keywordMisses: ['keyword2'],
        functionCallMatches: [],
        functionCallMisses: ['function2'],
        executionTime: 3000,
        sessionId: 'session-2',
        attempt: 2,
        createdAt: '2024-01-15T11:00:00Z'
      }
    ];

    it('should send daily digest email with today\'s date by default', async () => {
      const mockCreateOrReuseInteractiveShare = chatbotDb.createOrReuseInteractiveShare as jest.Mock;
      mockCreateOrReuseInteractiveShare
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-1?conversable=token1')
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-2?conversable=token2');

      await emailService.sendDailyDigestEmail(
        'test@example.com',
        'Test Schedule',
        mockResults,
        'schedule-1'
      );

      expect(emailService.sendEmail).toHaveBeenCalledWith(
        ['test@example.com'],
        expect.stringContaining('📊 Daily Digest: Test Schedule'),
        expect.any(String),
        expect.any(String)
      );

      // Check that the email contains today's date
      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const subject = emailCall[1];
      const html = emailCall[3];
      
      expect(subject).toContain('Daily Digest: Test Schedule');
      expect(html).toContain('Today\'s Summary');
    });

    it('should send daily digest email with custom date', async () => {
      const customDate = new Date('2024-01-10T12:00:00Z'); // Use noon UTC to avoid timezone issues
      const mockCreateOrReuseInteractiveShare = chatbotDb.createOrReuseInteractiveShare as jest.Mock;
      mockCreateOrReuseInteractiveShare
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-1?conversable=token1')
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-2?conversable=token2');

      await emailService.sendDailyDigestEmail(
        'test@example.com',
        'Test Schedule',
        mockResults,
        'schedule-1',
        customDate
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const subject = emailCall[1];
      const html = emailCall[3];
      
      expect(subject).toContain('January 10, 2024');
      expect(html).toContain('January 10, 2024 Summary');
    });

    it('should calculate correct statistics', async () => {
      const mockCreateOrReuseInteractiveShare = chatbotDb.createOrReuseInteractiveShare as jest.Mock;
      mockCreateOrReuseInteractiveShare
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-1?conversable=token1')
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-2?conversable=token2');

      await emailService.sendDailyDigestEmail(
        'test@example.com',
        'Test Schedule',
        mockResults,
        'schedule-1'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const html = emailCall[3];
      
      // Check statistics are calculated correctly
      expect(html).toContain('Total Runs</div>');
      expect(html).toContain('>2</div>'); // Total runs
      expect(html).toContain('>1</div>'); // Successful runs
      expect(html).toContain('>1</div>'); // Failed runs
      expect(html).toContain('>4s</div>'); // Average execution time (5000+3000)/2/1000 = 4s
    });

    it('should create interactive shares for all sessions', async () => {
      const mockCreateOrReuseInteractiveShare = chatbotDb.createOrReuseInteractiveShare as jest.Mock;
      mockCreateOrReuseInteractiveShare
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-1?conversable=token1')
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-2?conversable=token2');

      await emailService.sendDailyDigestEmail(
        'test@example.com',
        'Test Schedule',
        mockResults,
        'schedule-1'
      );

      expect(mockCreateOrReuseInteractiveShare).toHaveBeenCalledTimes(2);
      expect(mockCreateOrReuseInteractiveShare).toHaveBeenCalledWith('session-1');
      expect(mockCreateOrReuseInteractiveShare).toHaveBeenCalledWith('session-2');
    });

    it('should handle multiple email recipients', async () => {
      const mockCreateOrReuseInteractiveShare = chatbotDb.createOrReuseInteractiveShare as jest.Mock;
      mockCreateOrReuseInteractiveShare
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-1?conversable=token1')
        .mockResolvedValueOnce('http://localhost:5174/ishare/session-2?conversable=token2');

      await emailService.sendDailyDigestEmail(
        ['test1@example.com', 'test2@example.com'],
        'Test Schedule',
        mockResults,
        'schedule-1'
      );

      expect(emailService.sendEmail).toHaveBeenCalledWith(
        ['test1@example.com', 'test2@example.com'],
        expect.any(String),
        expect.any(String),
        expect.any(String)
      );
    });

    it('should handle empty results gracefully', async () => {
      await emailService.sendDailyDigestEmail(
        'test@example.com',
        'Test Schedule',
        [],
        'schedule-1'
      );

      expect(emailService.sendEmail).toHaveBeenCalledWith(
        ['test@example.com'],
        expect.stringContaining('0 runs'),
        expect.any(String),
        expect.any(String)
      );
    });

    it('should escape HTML content in responses', async () => {
      const resultsWithHtml = [{
        ...mockResults[0],
        actualResponse: '<script>alert("xss")</script>Test response'
      }];

      const mockCreateOrReuseInteractiveShare = chatbotDb.createOrReuseInteractiveShare as jest.Mock;
      mockCreateOrReuseInteractiveShare.mockResolvedValueOnce('http://localhost:5174/ishare/session-1?conversable=token1');

      await emailService.sendDailyDigestEmail(
        'test@example.com',
        'Test Schedule',
        resultsWithHtml,
        'schedule-1'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const html = emailCall[3];
      
      // Check that HTML is escaped
      expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;Test response');
    });
  });

  // ── ENG-1552: the digest runs the same recipient guard as a single report ──
  describe('recipient guard parity (ENG-1552)', () => {
    // ENG-1552 behavior is customer-visible only with enforcement on (shadow mode otherwise).
    beforeAll(() => { process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT = 'true'; });
    afterAll(() => { delete process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT; });
    const run = (sessionId: string, actualResponse = 'Client roster summary') => ({
      passed: true, actualResponse, keywordMatches: [], keywordMisses: [], functionCallMatches: [],
      functionCallMisses: [], executionTime: 1000, sessionId, attempt: 1, createdAt: '2024-01-15T10:00:00Z',
    });

    beforeEach(() => {
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('http://localhost:5174/ishare/x');
      // session-2 used a cross-account tool; session-1 is ordinary.
      (chatbotDb.getChatSession as jest.Mock).mockImplementation(async (sessionId: string) => ({
        sessionId, userId: 'owner-id', calledFunctions: sessionId === 'session-2' ? { list_all_clients: 1 } : {},
      }));
      (userDb.getUserByEmail as jest.Mock).mockImplementation(async (email: string) => ({ email, isAdmin: email === 'admin@example.com' }));
    });

    it('restricts the whole digest when ANY run in it is sensitive, with the withheld notice', async () => {
      (emailService.sendEmail as jest.Mock).mockResolvedValue('sent');
      await emailService.sendDailyDigestEmail(['admin@example.com', 'analyst@example.com'], 'Hourly', [run('session-1'), run('session-2')], 'schedule-1');

      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
      const [recipients, , text, html] = (emailService.sendEmail as jest.Mock).mock.calls[0];
      expect(recipients).toEqual(['admin@example.com']);
      expect(text).toContain('withheld');
      expect(html).toContain('analyst@example.com');
      expect(scheduleDb.appendDeliveryLogEntry).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ state: 'delivered', authorizedRecipients: ['admin@example.com'], withheldRecipients: ['analyst@example.com'] }),
        undefined,
      );
    });

    it('sends nothing to recipients when nobody is authorized, records withheld, and notifies the owner', async () => {
      const notify = jest.spyOn(emailService, 'notifyScheduledReportWithheld').mockResolvedValue(undefined);
      await emailService.sendDailyDigestEmail(['analyst@example.com'], 'Hourly', [run('session-2')], 'schedule-1');

      expect(emailService.sendEmail).not.toHaveBeenCalled();
      expect(chatbotDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 'schedule-1', stage: 'after_generation' }));
      expect(notify.mock.calls[0][0].emailOwner).toBeFalsy(); // oncall only, nothing to the customer
      expect(scheduleDb.appendDeliveryLogEntry).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ state: 'withheld', reason: 'no_authorized_recipients' }),
        undefined,
      );
      notify.mockRestore();
    });

    it('shows an empty run as "no report content" instead of a blank preview', async () => {
      await emailService.sendDailyDigestEmail(['a@example.com'], 'Hourly', [run('session-1', '   ')], 'schedule-1');
      const [, , text, html] = (emailService.sendEmail as jest.Mock).mock.calls[0];
      expect(html).toContain('This run produced no report content.');
      expect(text).toContain('This run produced no report content.');
    });

    it('records delivery_attempted/provider_error — never delivered — when the provider send fails', async () => {
      (emailService.sendEmail as jest.Mock).mockResolvedValue('failed');
      await emailService.sendDailyDigestEmail(['a@example.com'], 'Hourly', [run('session-1')], 'schedule-1');
      const states = (scheduleDb.appendDeliveryLogEntry as jest.Mock).mock.calls.map((c) => [c[1].state, c[1].reason]);
      expect(states).toEqual([['delivery_attempted', undefined], ['delivery_attempted', 'provider_error']]);
    });
  });

  describe('ENG-1552 shadow mode — digest goes to everyone, as before (enforcement unset)', () => {
    beforeEach(() => {
      delete process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT;
      (chatbotDb.createOrReuseInteractiveShare as jest.Mock).mockResolvedValue('http://localhost:5174/ishare/x');
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: 'session-2', userId: 'owner-id', calledFunctions: { list_all_clients: 1 } });
    });

    it('sends a sensitive digest to every configured recipient with no withheld notice', async () => {
      await emailService.sendDailyDigestEmail(['admin@example.com', 'analyst@example.com'], 'Hourly', [{
        passed: true, actualResponse: 'Client roster', keywordMatches: [], keywordMisses: [], functionCallMatches: [],
        functionCallMisses: [], executionTime: 1000, sessionId: 'session-2', attempt: 1, createdAt: '2024-01-15T10:00:00Z',
      }], 'schedule-1');
      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
      const [recipients, , text] = (emailService.sendEmail as jest.Mock).mock.calls[0];
      expect(recipients).toEqual(['admin@example.com', 'analyst@example.com']);
      expect(text).not.toContain('withheld');
    });
  });
});

