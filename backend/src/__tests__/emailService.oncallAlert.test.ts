// Unit tests for oncall alert functionality

// Mock nodemailer before importing emailService
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });
const mockTransporter = {
  sendMail: mockSendMail
};

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => mockTransporter)
}));

import { emailService } from '../services/emailService';

describe('EmailService - sendOncallAlert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockClear();
    // Set default oncall email
    process.env.ONCALL_EMAIL_LIST = 'test@example.com,test2@example.com';
    process.env.FROM_EMAIL = 'noreply@example.com';
  });

  afterEach(() => {
    delete process.env.ONCALL_EMAIL_LIST;
  });

  it('should send oncall alert with default email when ONCALL_EMAIL_LIST is not set', async () => {
    delete process.env.ONCALL_EMAIL_LIST;

    await emailService.sendOncallAlert(
      'Test Alert',
      'This is a test alert message',
      {
        'Context Key': 'Context Value',
        'Another Key': { nested: 'object' }
      }
    );
    
    expect(mockSendMail).toHaveBeenCalled();
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.to).toEqual(['ruiw@agentweb.pro']);
    expect(callArgs.subject).toBe('[URGENT] Test Alert');
    expect(callArgs.text).toContain('Test Alert');
    expect(callArgs.text).toContain('This is a test alert message');
    expect(callArgs.html).toContain('Test Alert');
  });

  it('should send oncall alert to configured emails', async () => {
    process.env.ONCALL_EMAIL_LIST = 'oncall1@example.com,oncall2@example.com';

    await emailService.sendOncallAlert(
      'Critical Error',
      'Something went wrong',
      {
        'Error Code': 'ERR001',
        'Timestamp': '2026-01-08T12:00:00Z'
      }
    );
    
    expect(mockSendMail).toHaveBeenCalled();
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.to).toEqual(['oncall1@example.com', 'oncall2@example.com']);
    expect(callArgs.subject).toBe('[URGENT] Critical Error');
  });

  it('should include context in HTML format', async () => {
    await emailService.sendOncallAlert(
      'Test Alert',
      'Test message',
      {
        'Session ID': 'session123',
        'iShare Link': 'https://example.com/ishare/session123',
        'Error Details': 'Failed to extract asset URL'
      }
    );

    expect(mockSendMail).toHaveBeenCalled();
    const callArgs = mockSendMail.mock.calls[0][0];
    
    expect(callArgs.html).toContain('Session ID');
    expect(callArgs.html).toContain('session123');
    expect(callArgs.html).toContain('iShare Link');
    expect(callArgs.html).toContain('https://example.com/ishare/session123');
  });

  it('should handle errors gracefully without throwing', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));

    // Should not throw
    await expect(emailService.sendOncallAlert(
      'Test Alert',
      'Test message'
    )).resolves.not.toThrow();
  });
});
