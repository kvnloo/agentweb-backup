import { emailService } from '../services/emailService';
import { chatbotDb } from '../services/chatbotService';

// Mock the chatbot service
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createOrReuseInteractiveShare: jest.fn(),
    getChatSession: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn()
  }
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
});
