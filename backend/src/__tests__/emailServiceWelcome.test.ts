import { emailService } from '../services/emailService';

// Mock nodemailer
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-message-id' })
  }))
}));

// Mock environment variables
process.env.SMTP_HOST = 'test-smtp-host';
process.env.SMTP_PORT = '587';
process.env.SMTP_USER = 'test-user';
process.env.SMTP_PASS = 'test-pass';
process.env.FROM_EMAIL = 'test@example.com';
process.env.CUSTOMER_FRONTEND_URL = 'https://customer.example.com';

describe('Email Service Welcome Email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sendWelcomeEmail', () => {
    it('should send welcome email for new user with temporary password', async () => {
      const email = 'newuser@example.com';
      const tempPassword = 'temp123456';

      await emailService.sendWelcomeEmail(email, tempPassword);

      // Verify sendEmail was called with correct parameters
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        email,
        'Welcome to AgentWeb - Your Account is Ready!',
        expect.stringContaining('Welcome to AgentWeb'),
        expect.stringContaining('Temporary Password: temp123456')
      );
    });

    it('should send upgrade email for existing free user without password', async () => {
      const email = 'freeuser@example.com';

      await emailService.sendWelcomeEmail(email);

      // Verify sendEmail was called with upgrade content
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        email,
        'Welcome to AgentWeb - Your Account is Ready!',
        expect.stringContaining('Welcome to AgentWeb'),
        expect.not.stringContaining('Temporary Password:')
      );
    });

    it('should include login credentials section for new users', async () => {
      const email = 'newuser@example.com';
      const tempPassword = 'temp123456';

      await emailService.sendWelcomeEmail(email, tempPassword);

      const callArgs = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const htmlContent = callArgs[2];
      const textContent = callArgs[3];

      expect(htmlContent).toContain('Login Credentials');
      expect(htmlContent).toContain('Email: newuser@example.com');
      expect(htmlContent).toContain('Temporary Password: temp123456');
      expect(textContent).toContain('Email: newuser@example.com');
      expect(textContent).toContain('Temporary Password: temp123456');
    });

    it('should include upgrade features section for existing users', async () => {
      const email = 'freeuser@example.com';

      await emailService.sendWelcomeEmail(email);

      const callArgs = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const htmlContent = callArgs[2];
      const textContent = callArgs[3];

      expect(htmlContent).toContain('What\'s New with Your Upgrade');
      expect(htmlContent).toContain('AI-powered marketing automation tools');
      expect(textContent).toContain('What\'s New with Your Upgrade');
      expect(textContent).toContain('AI-powered marketing automation tools');
    });

    it('should include Getting Started section for both new and existing users', async () => {
      const email = 'testuser@example.com';

      await emailService.sendWelcomeEmail(email);

      const callArgs = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const htmlContent = callArgs[2];
      const textContent = callArgs[3];

      expect(htmlContent).toContain('Getting Started with AgentWeb');
      expect(htmlContent).toContain('Release Notes');
      expect(htmlContent).toContain('User Guide');
      expect(textContent).toContain('Getting Started with AgentWeb');
      expect(textContent).toContain('Release Notes');
      expect(textContent).toContain('User Guide');
    });

    it('should include password reminder for new users', async () => {
      const email = 'newuser@example.com';
      const tempPassword = 'temp123456';

      await emailService.sendWelcomeEmail(email, tempPassword);

      const callArgs = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const htmlContent = callArgs[2];
      const textContent = callArgs[3];

      expect(htmlContent).toContain('Important: Change Your Password');
      expect(htmlContent).toContain('Please change your temporary password');
      expect(textContent).toContain('Important: Change Your Password');
      expect(textContent).toContain('Please change your temporary password');
    });

    it('should not include password reminder for existing users', async () => {
      const email = 'freeuser@example.com';

      await emailService.sendWelcomeEmail(email);

      const callArgs = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const htmlContent = callArgs[2];
      const textContent = callArgs[3];

      expect(htmlContent).not.toContain('Important: Change Your Password');
      expect(textContent).not.toContain('Important: Change Your Password');
    });

    it('should use correct subject line', async () => {
      const email = 'testuser@example.com';

      await emailService.sendWelcomeEmail(email);

      const callArgs = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const subject = callArgs[1];

      expect(subject).toBe('Welcome to AgentWeb - Your Account is Ready!');
    });

    it('should handle email sending errors gracefully', async () => {
      const email = 'testuser@example.com';
      const error = new Error('SMTP Error');
      
      (emailService.sendEmail as jest.Mock).mockRejectedValueOnce(error);

      await expect(emailService.sendWelcomeEmail(email)).rejects.toThrow('SMTP Error');
    });
  });
});
