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
  const mockSendEmail = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock the sendEmail method
    mockSendEmail.mockResolvedValue(undefined);
    (emailService as any).sendEmail = mockSendEmail;
  });

  describe('sendWelcomeEmail', () => {
    it('should send welcome email for new user with temporary password', async () => {
      const email = 'newuser@example.com';
      const tempPassword = 'temp123456';

      await emailService.sendWelcomeEmail(email, tempPassword);

      // Verify sendEmail was called
      expect(mockSendEmail).toHaveBeenCalledWith(
        email,
        'Welcome to AgentWeb - Your Account is Ready!',
        expect.stringContaining('AgentWeb Customer Portal - Welcome!'),
        expect.stringContaining('Welcome to AgentWeb!')
      );
    });

    it('should send upgrade email for existing free user without password', async () => {
      const email = 'existinguser@example.com';

      await emailService.sendWelcomeEmail(email);

      // Verify sendEmail was called with upgrade content
      expect(mockSendEmail).toHaveBeenCalledWith(
        email,
        'Welcome to AgentWeb - Your Account is Upgraded!',
        expect.stringContaining('AgentWeb Customer Portal - Welcome!'),
        expect.stringContaining('Welcome to AgentWeb!')
      );
    });

    it('should include login credentials section for new users', async () => {
      const email = 'newuser@example.com';
      const tempPassword = 'temp123456';

      await emailService.sendWelcomeEmail(email, tempPassword);

      const callArgs = mockSendEmail.mock.calls[0];
      const htmlContent = callArgs[3]; // 4th argument is HTML
      const textContent = callArgs[2]; // 3rd argument is text

      expect(htmlContent).toContain('Your Login Credentials');
      expect(htmlContent).toContain(`<strong>Email:</strong> ${email}`);
      expect(htmlContent).toContain(`<strong>Temporary Password:</strong> <code`);
      expect(textContent).toContain(`Email: ${email}`);
      expect(textContent).toContain(`Temporary Password: ${tempPassword}`);
    });

    it('should include upgrade features section for existing users', async () => {
      const email = 'existinguser@example.com';

      await emailService.sendWelcomeEmail(email);

      const callArgs = mockSendEmail.mock.calls[0];
      const htmlContent = callArgs[3]; // 4th argument is HTML
      const textContent = callArgs[2]; // 3rd argument is text

      expect(htmlContent).toContain('What\'s New with Your Upgrade');
      expect(htmlContent).toContain('You now have access to our full suite of AI-powered marketing automation tools');
      expect(textContent).toContain('What\'s New with Your Upgrade');
      expect(textContent).toContain('You now have access to our full suite of AI-powered marketing automation tools');
    });

    it('should include Getting Started section for both new and existing users', async () => {
      const email = 'user@example.com';

      await emailService.sendWelcomeEmail(email);

      const callArgs = mockSendEmail.mock.calls[0];
      const htmlContent = callArgs[3]; // 4th argument is HTML
      const textContent = callArgs[2]; // 3rd argument is text

      expect(htmlContent).toContain('Getting Started with AgentWeb');
      expect(htmlContent).toContain('Check out these resources to help you get the most out of AgentWeb:');
      expect(htmlContent).toContain('Release Notes');
      expect(htmlContent).toContain('User Guide');
      expect(textContent).toContain('Getting Started with AgentWeb');
      expect(textContent).toContain('Check out these resources to help you get the most out of AgentWeb:');
      expect(textContent).toContain('Release Notes');
      expect(textContent).toContain('User Guide');
    });

    it('should include password reminder for new users', async () => {
      const email = 'newuser@example.com';
      const tempPassword = 'temp123456';

      await emailService.sendWelcomeEmail(email, tempPassword);

      const callArgs = mockSendEmail.mock.calls[0];
      const htmlContent = callArgs[3]; // 4th argument is HTML
      const textContent = callArgs[2]; // 3rd argument is text

      expect(htmlContent).toContain('Please change your password after your first login');
      expect(textContent).toContain('Please change your password after your first login');
    });

    it('should not include password reminder for existing users', async () => {
      const email = 'existinguser@example.com';

      await emailService.sendWelcomeEmail(email);

      const callArgs = mockSendEmail.mock.calls[0];
      const htmlContent = callArgs[3]; // 4th argument is HTML
      const textContent = callArgs[2]; // 3rd argument is text

      expect(htmlContent).not.toContain('Please change your password after your first login');
      expect(textContent).not.toContain('Please change your password after your first login');
    });

    it('should use correct subject line for new users', async () => {
      const email = 'newuser@example.com';
      const tempPassword = 'temp123456';

      await emailService.sendWelcomeEmail(email, tempPassword);

      const callArgs = mockSendEmail.mock.calls[0];
      const subject = callArgs[1]; // 2nd argument is subject

      expect(subject).toBe('Welcome to AgentWeb - Your Account is Ready!');
    });

    it('should use correct subject line for existing users', async () => {
      const email = 'existinguser@example.com';

      await emailService.sendWelcomeEmail(email);

      const callArgs = mockSendEmail.mock.calls[0];
      const subject = callArgs[1]; // 2nd argument is subject

      expect(subject).toBe('Welcome to AgentWeb - Your Account is Upgraded!');
    });

    it('should handle email sending errors gracefully', async () => {
      const email = 'user@example.com';
      const error = new Error('SMTP Error');

      mockSendEmail.mockRejectedValueOnce(error);

      await expect(emailService.sendWelcomeEmail(email)).rejects.toThrow('SMTP Error');
    });
  });
});