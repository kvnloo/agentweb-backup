// Mock nodemailer
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-message-id' })
  }))
}));

// Mock database services
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
}));

// Mock resend service
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));

import { emailService } from '../services/emailService';
import { taskDb, userDb } from '../services/db';
import { resendService } from '../services/resendService';

// Mock environment variables
process.env.SMTP_HOST = 'test-smtp-host';
process.env.SMTP_PORT = '587';
process.env.SMTP_USER = 'test-user';
process.env.SMTP_PASS = 'test-pass';
process.env.FROM_EMAIL = 'test@example.com';
process.env.CUSTOMER_FRONTEND_URL = 'https://customer.agentweb.pro';

describe('EmailService - Subscriber Welcome Email', () => {
  const mockSendEmail = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
    (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'resend-email-id' });
    (emailService as any).sendEmail = mockSendEmail;
  });

  describe('sendSubscriberWelcomeEmail', () => {
    const taskId = 'test-task-123';
    const email = 'subscriber@example.com';
    const taskName = 'My Test Task';

    it('should send welcome email using SMTP when no custom sender configured', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: taskName,
        emailSender: null,
        fromName: null,
        sendHtmlReportOnly: false,
      };

      const mockUser = {
        userId: 'user-123',
        emailDomain: null,
        defaultSenderUsername: null,
        fromName: null,
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await emailService.sendSubscriberWelcomeEmail(email, taskId);

      expect(taskDb.getTaskById).toHaveBeenCalledWith(taskId);
      expect(userDb.getUserById).toHaveBeenCalledWith('user-123');
      expect(mockSendEmail).toHaveBeenCalledWith(
        email,
        `Welcome! You've subscribed to ${taskName}`,
        expect.stringContaining(taskName),
        expect.stringContaining(taskName)
      );
      expect(resendService.sendEmail).not.toHaveBeenCalled();
    });

    it('should send welcome email using Resend when task has custom sender', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: taskName,
        emailSender: 'noreply@customdomain.com',
        fromName: 'Custom Name',
        sendHtmlReportOnly: false,
      };

      const mockUser = {
        userId: 'user-123',
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await emailService.sendSubscriberWelcomeEmail(email, taskId);

      expect(resendService.sendEmail).toHaveBeenCalledWith({
        from: 'Custom Name <noreply@customdomain.com>',
        to: email,
        subject: `Welcome! You've subscribed to ${taskName}`,
        html: expect.stringContaining(taskName),
        text: expect.stringContaining(taskName),
      });
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('should send welcome email using Resend when account has default sender', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: taskName,
        emailSender: null,
        fromName: null,
        sendHtmlReportOnly: false,
      };

      const mockUser = {
        userId: 'user-123',
        emailDomain: 'customdomain.com',
        defaultSenderUsername: 'noreply',
        fromName: 'Account Name',
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await emailService.sendSubscriberWelcomeEmail(email, taskId);

      expect(resendService.sendEmail).toHaveBeenCalledWith({
        from: 'Account Name <noreply@customdomain.com>',
        to: email,
        subject: `Welcome! You've subscribed to ${taskName}`,
        html: expect.stringContaining(taskName),
        text: expect.stringContaining(taskName),
      });
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('should include unsubscribe link in email', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: taskName,
        emailSender: null,
        fromName: null,
        sendHtmlReportOnly: false,
      };

      const mockUser = {
        userId: 'user-123',
        emailDomain: null,
        defaultSenderUsername: null,
        fromName: null,
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await emailService.sendSubscriberWelcomeEmail(email, taskId);

      const callArgs = mockSendEmail.mock.calls[0];
      const htmlContent = callArgs[3];
      const textContent = callArgs[2];

      expect(htmlContent).toContain('/unsubscribe?taskId=');
      expect(htmlContent).toContain(`taskId=${taskId}`);
      expect(htmlContent).toContain(`email=${encodeURIComponent(email)}`);
      expect(textContent).toContain('/unsubscribe?taskId=');
    });

    it('should not include AgentWeb branding in email', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: taskName,
        emailSender: null,
        fromName: null,
        sendHtmlReportOnly: false,
      };

      const mockUser = {
        userId: 'user-123',
        emailDomain: null,
        defaultSenderUsername: null,
        fromName: null,
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await emailService.sendSubscriberWelcomeEmail(email, taskId);

      const callArgs = mockSendEmail.mock.calls[0];
      const htmlContent = callArgs[3];
      const textContent = callArgs[2];

      expect(htmlContent).not.toContain('AgentWeb');
      expect(htmlContent).not.toContain('The AgentWeb Team');
      expect(textContent).not.toContain('AgentWeb');
      expect(textContent).not.toContain('The AgentWeb Team');
    });

    it('should handle task not found gracefully', async () => {
      (taskDb.getTaskById as jest.Mock).mockResolvedValue(null);

      await emailService.sendSubscriberWelcomeEmail(email, taskId);

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(resendService.sendEmail).not.toHaveBeenCalled();
    });

    it('should handle user not found gracefully', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: taskName,
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      await emailService.sendSubscriberWelcomeEmail(email, taskId);

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(resendService.sendEmail).not.toHaveBeenCalled();
    });
  });
});

