// Unit tests for oncall alert functionality

// Mock nodemailer before importing emailService
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });
const mockTransporter = {
  sendMail: mockSendMail
};

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => mockTransporter)
}));

// ENG-6: oncall alerts route through the shared intake service (fileAutoIssue) — a private Linear
// issue, no Notion fallback. Mock that boundary; the email link text is derived from result.url.
const mockFileAutoIssue = jest.fn();
jest.mock('../services/intakeService', () => ({
  fileAutoIssue: (...args: any[]) => mockFileAutoIssue(...args),
}));

import { emailService } from '../services/emailService';

describe('EmailService - sendOncallAlert', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockClear();
    mockFileAutoIssue.mockClear();
    // Set default oncall email
    process.env.ONCALL_EMAIL_LIST = 'test@example.com,test2@example.com';
    process.env.FROM_EMAIL = 'noreply@example.com';
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    delete process.env.ONCALL_EMAIL_LIST;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should suppress alert in non-production environments', async () => {
    process.env.NODE_ENV = 'development';
    await emailService.sendOncallAlert('Test Alert', 'Test message');
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('should send slim email with the tracker link when the intake item is created successfully', async () => {
    mockFileAutoIssue.mockResolvedValueOnce({
      pageId: 'ENG-123',
      url: 'https://linear.app/emmabyaw/issue/ENG-123',
      deduped: false,
      tracker: 'Linear',
    });

    await emailService.sendOncallAlert(
      'Test Alert',
      'This is a test alert message',
      { 'Context Key': 'Context Value' }
    );

    // Oncall alerts route through intakeService.fileAutoIssue (title/description/context passthrough).
    expect(mockFileAutoIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Test Alert',
      description: 'This is a test alert message',
      notionContext: { 'Context Key': 'Context Value' },
    }));

    expect(mockSendMail).toHaveBeenCalled();
    const callArgs = mockSendMail.mock.calls[0][0];
    // The slim email links to the filed tracker item (url from fileAutoIssue).
    expect(callArgs.html).toContain('https://linear.app/emmabyaw/issue/ENG-123');
    // Slim email should NOT contain the full context table
    expect(callArgs.html).not.toContain('Additional Context');
    expect(callArgs.text).toContain('https://linear.app/emmabyaw/issue/ENG-123');
  });

  it('should send full detail email when intake filing fails', async () => {
    mockFileAutoIssue.mockRejectedValueOnce(new Error('Notion API error'));

    await emailService.sendOncallAlert(
      'Test Alert',
      'Test message',
      { 'Session ID': 'sess-123' }
    );

    expect(mockSendMail).toHaveBeenCalled();
    const callArgs = mockSendMail.mock.calls[0][0];
    // Full email should contain the context table
    expect(callArgs.html).toContain('Session ID');
    expect(callArgs.html).toContain('sess-123');
    expect(callArgs.html).toContain('Additional Context');
    expect(callArgs.text).toContain('Test message');
  });

  it('should skip Notion creation when notionUrl is provided', async () => {
    await emailService.sendOncallAlert(
      'Test Alert',
      'Test message',
      { 'Key': 'Value' },
      'https://notion.so/existing-page'
    );

    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    expect(mockSendMail).toHaveBeenCalled();
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.html).toContain('View in Linear');
    expect(callArgs.html).toContain('https://notion.so/existing-page');
  });

  it('should send oncall alert with default email when ONCALL_EMAIL_LIST is not set', async () => {
    delete process.env.ONCALL_EMAIL_LIST;
    mockFileAutoIssue.mockRejectedValueOnce(new Error('skip'));

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
    expect(callArgs.subject).toBe('[PROD] Test Alert');
    expect(callArgs.text).toContain('Test Alert');
    expect(callArgs.text).toContain('This is a test alert message');
    expect(callArgs.html).toContain('Test Alert');
  });

  it('should send oncall alert to configured emails', async () => {
    process.env.ONCALL_EMAIL_LIST = 'oncall1@example.com,oncall2@example.com';
    mockFileAutoIssue.mockResolvedValueOnce({
      pageId: 'ENG-1',
      url: 'https://linear.app/emmabyaw/issue/ENG-1',
      deduped: false,
      tracker: 'Linear',
    });

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
    expect(callArgs.subject).toBe('[PROD] Critical Error');
  });

  it('should handle errors gracefully without throwing', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));
    mockFileAutoIssue.mockRejectedValueOnce(new Error('Notion error'));

    // Should not throw
    await expect(emailService.sendOncallAlert(
      'Test Alert',
      'Test message'
    )).resolves.not.toThrow();
  });
});
