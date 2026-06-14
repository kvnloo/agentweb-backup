import { sendAgentModeOncallAlert, __resetAgentModeAlertDedupeForTests } from '../../utils/agentModeAlerts';

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
    __resetAgentModeAlertDedupeForTests();
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.example.com';
  });

  afterEach(() => {
    delete process.env.CUSTOMER_FRONTEND_URL;
    __resetAgentModeAlertDedupeForTests();
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

  describe('dedupe / rate-limit (per user + errorClass window)', () => {
    beforeEach(() => {
      mockedEmailService.sendOncallAlert.mockResolvedValue(undefined);
    });

    // AC: a test firing N context-limit errors in the window files <=1 alert.
    it('fires at most one alert per dedupeKey within the window (N firings -> 1 email)', async () => {
      const N = 8;
      const baseTs = 1_700_000_000_000;
      for (let i = 0; i < N; i++) {
        await sendAgentModeOncallAlert({
          subject: 'Agent Mode: Context limit exceeded',
          message: `attempt ${i}`,
          dedupeKey: 'context_limit:user-123',
          dedupeWindowMs: 60_000,
          now: baseTs + i * 1_000, // all within the 60s window
        });
      }

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    });

    // AC: a later error after the window files again.
    it('fires again once the window has elapsed', async () => {
      const baseTs = 1_700_000_000_000;
      await sendAgentModeOncallAlert({
        subject: 'Agent Mode: Context limit exceeded',
        message: 'first',
        dedupeKey: 'context_limit:user-123',
        dedupeWindowMs: 60_000,
        now: baseTs,
      });
      // Suppressed inside the window.
      await sendAgentModeOncallAlert({
        subject: 'Agent Mode: Context limit exceeded',
        message: 'suppressed',
        dedupeKey: 'context_limit:user-123',
        dedupeWindowMs: 60_000,
        now: baseTs + 30_000,
      });
      // After the window -> fires again.
      await sendAgentModeOncallAlert({
        subject: 'Agent Mode: Context limit exceeded',
        message: 'second',
        dedupeKey: 'context_limit:user-123',
        dedupeWindowMs: 60_000,
        now: baseTs + 61_000,
      });

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledTimes(2);
    });

    it('does not suppress across different dedupeKeys (per user/errorClass isolation)', async () => {
      const ts = 1_700_000_000_000;
      await sendAgentModeOncallAlert({
        subject: 'Agent Mode: Context limit exceeded',
        message: 'user A',
        dedupeKey: 'context_limit:user-A',
        dedupeWindowMs: 60_000,
        now: ts,
      });
      await sendAgentModeOncallAlert({
        subject: 'Agent Mode: Context limit exceeded',
        message: 'user B',
        dedupeKey: 'context_limit:user-B',
        dedupeWindowMs: 60_000,
        now: ts + 1_000,
      });
      // Same user, different error class -> separate key.
      await sendAgentModeOncallAlert({
        subject: 'Agent Mode: Session limit exceeded',
        message: 'user A other class',
        dedupeKey: 'session_limit:user-A',
        dedupeWindowMs: 60_000,
        now: ts + 2_000,
      });

      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledTimes(3);
    });

    it('preserves existing behavior: no dedupeKey => every call fires (backwards compatible)', async () => {
      for (let i = 0; i < 3; i++) {
        await sendAgentModeOncallAlert({
          subject: 'Some other alert',
          message: `attempt ${i}`,
        });
      }
      expect(mockedEmailService.sendOncallAlert).toHaveBeenCalledTimes(3);
    });
  });
});
