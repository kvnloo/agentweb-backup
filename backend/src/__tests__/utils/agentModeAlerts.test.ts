import { sendAgentModeOncallAlert } from '../../utils/agentModeAlerts';

// Mock the dependencies
jest.mock('../../services/chatbotService', () => ({
  chatbotDb: {
    createOrReuseInteractiveShare: jest.fn()
  }
}));

jest.mock('../../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn()
  }
}));

import { chatbotDb } from '../../services/chatbotService';
import { emailService } from '../../services/emailService';

describe('agentModeAlerts utils', () => {
  const mockedChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
  const mockedEmailService = emailService as jest.Mocked<typeof emailService>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.example.com';
  });

  afterEach(() => {
    delete process.env.CUSTOMER_FRONTEND_URL;
  });

  describe('sendAgentModeOncallAlert', () => {
    it('should send alert without session ID', async () => {
      mockedEmailService.sendOncallAlert.mockResolvedValue(undefined);

      await sendAgentModeOncallAlert({
        subject: 'Test Subject',
        message: 'Test Message'
      });

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Test Subject',
        'Test Message',
        expect.objectContaining({
          'Session ID': 'unknown',
          'iShare Link': 'N/A'
        })
      );
    });

    it('should create ishare link when session ID is provided', async () => {
      mockedChatbotDb.createOrReuseInteractiveShare.mockResolvedValue('https://share.example.com/abc123');
      mockedEmailService.sendOncallAlert.mockResolvedValue(undefined);

      await sendAgentModeOncallAlert({
        subject: 'Test Subject',
        message: 'Test Message',
        sessionId: 'session-123'
      });

      expect(mockedChatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith('session-123');
      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Test Subject',
        'Test Message',
        expect.objectContaining({
          'Session ID': 'session-123',
          'iShare Link': 'https://share.example.com/abc123'
        })
      );
    });

    it('should fallback to direct URL when ishare creation fails', async () => {
      mockedChatbotDb.createOrReuseInteractiveShare.mockRejectedValue(new Error('Failed to create share'));
      mockedEmailService.sendOncallAlert.mockResolvedValue(undefined);

      await sendAgentModeOncallAlert({
        subject: 'Test Subject',
        message: 'Test Message',
        sessionId: 'session-456'
      });

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Test Subject',
        'Test Message',
        expect.objectContaining({
          'Session ID': 'session-456',
          'iShare Link': 'https://app.example.com/agent-mode/session-456'
        })
      );
    });

    it('should use default frontend URL when env var is not set', async () => {
      delete process.env.CUSTOMER_FRONTEND_URL;
      mockedChatbotDb.createOrReuseInteractiveShare.mockRejectedValue(new Error('Failed'));
      mockedEmailService.sendOncallAlert.mockResolvedValue(undefined);

      await sendAgentModeOncallAlert({
        subject: 'Test',
        message: 'Test',
        sessionId: 'session-789'
      });

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Test',
        'Test',
        expect.objectContaining({
          'iShare Link': 'http://localhost:5174/agent-mode/session-789'
        })
      );
    });

    it('should include additional context in the alert', async () => {
      mockedEmailService.sendOncallAlert.mockResolvedValue(undefined);

      await sendAgentModeOncallAlert({
        subject: 'Test Subject',
        message: 'Test Message',
        context: {
          'User ID': 'user-123',
          'Error Type': 'timeout'
        }
      });

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Test Subject',
        'Test Message',
        expect.objectContaining({
          'User ID': 'user-123',
          'Error Type': 'timeout',
          'Session ID': 'unknown',
          'iShare Link': 'N/A'
        })
      );
    });

    it('should not override Session ID if provided in context', async () => {
      mockedEmailService.sendOncallAlert.mockResolvedValue(undefined);

      await sendAgentModeOncallAlert({
        subject: 'Test Subject',
        message: 'Test Message',
        context: {
          'Session ID': 'custom-session-id'
        }
      });

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Test Subject',
        'Test Message',
        expect.objectContaining({
          'Session ID': 'custom-session-id'
        })
      );
    });

    it('should not override iShare Link if provided in context', async () => {
      mockedEmailService.sendOncallAlert.mockResolvedValue(undefined);

      await sendAgentModeOncallAlert({
        subject: 'Test Subject',
        message: 'Test Message',
        context: {
          'iShare Link': 'custom-link'
        }
      });

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledWith(
        'Test Subject',
        'Test Message',
        expect.objectContaining({
          'iShare Link': 'custom-link'
        })
      );
    });
  });
});
