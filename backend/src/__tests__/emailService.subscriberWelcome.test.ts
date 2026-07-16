// ENG-164: SMTP path deleted — all subscriber welcome emails go through
// resendService with a task-level -> account-level -> system-default sender.

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
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';

process.env.CUSTOMER_FRONTEND_URL = 'https://customer.agentweb.pro';

const SYSTEM_FROM = `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`;

describe('EmailService - Subscriber Welcome Email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'resend-email-id' });
  });

  describe('sendSubscriberWelcomeEmail', () => {
    const taskId = 'test-task-123';
    const email = 'subscriber@example.com';
    const taskName = 'My Test Task';

    it('should send via Resend with the system sender when no custom sender configured', async () => {
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
      expect(resendService.sendEmail).toHaveBeenCalledWith({
        from: SYSTEM_FROM,
        to: email,
        subject: `Welcome! You've subscribed to ${taskName}`,
        html: expect.stringContaining(taskName),
        text: expect.stringContaining(taskName),
        replyTo: 'support@agentweb.pro',
      });
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

      const sendArgs = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      const htmlContent = sendArgs.html;
      const textContent = sendArgs.text;

      expect(htmlContent).toContain('/unsubscribe?taskId=');
      expect(htmlContent).toContain(`taskId=${taskId}`);
      expect(htmlContent).toContain(`email=${encodeURIComponent(email)}`);
      expect(textContent).toContain('/unsubscribe?taskId=');
    });

    it('should not include AgentWeb branding in email body', async () => {
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

      const sendArgs = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
      const htmlContent = sendArgs.html;
      const textContent = sendArgs.text;

      expect(htmlContent).not.toContain('AgentWeb');
      expect(htmlContent).not.toContain('The AgentWeb Team');
      expect(textContent).not.toContain('AgentWeb');
      expect(textContent).not.toContain('The AgentWeb Team');
    });

    it('should handle task not found gracefully', async () => {
      (taskDb.getTaskById as jest.Mock).mockResolvedValue(null);

      await emailService.sendSubscriberWelcomeEmail(email, taskId);

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

      expect(resendService.sendEmail).not.toHaveBeenCalled();
    });

    it('does not throw when the Resend send fails (subscription must still succeed)', async () => {
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
      (resendService.sendEmail as jest.Mock).mockRejectedValue(new Error('Resend API error: down'));

      await expect(emailService.sendSubscriberWelcomeEmail(email, taskId)).resolves.toBeUndefined();
    });
  });
});
