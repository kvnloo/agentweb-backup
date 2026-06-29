// Unit tests for oncall alert functionality

// Mock nodemailer before importing emailService
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });
const mockTransporter = {
  sendMail: mockSendMail
};

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => mockTransporter)
}));

// Mock notionService
const mockCreateOncallItem = jest.fn();
jest.mock('../services/notionService', () => ({
  createOncallItem: (...args: any[]) => mockCreateOncallItem(...args),
}));

import { emailService } from '../services/emailService';

describe('EmailService - sendOncallAlert', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockClear();
    mockCreateOncallItem.mockClear();
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
    expect(mockCreateOncallItem).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('should send slim email when Notion item is created successfully', async () => {
    mockCreateOncallItem.mockResolvedValueOnce({
      pageId: 'page-123',
      notionUrl: 'https://notion.so/page123',
    });

    await emailService.sendOncallAlert(
      'Test Alert',
      'This is a test alert message',
      { 'Context Key': 'Context Value' }
    );

    // Oncall alerts now route through intakeService.fileAutoIssue, which (flag off) calls
    // createOncallItem with notionTags [] (createOncallItem still adds its internal Oncall tag).
    expect(mockCreateOncallItem).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Test Alert',
      description: 'This is a test alert message',
      context: { 'Context Key': 'Context Value' },
    }));

    expect(mockSendMail).toHaveBeenCalled();
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.html).toContain('View in Notion');
    expect(callArgs.html).toContain('https://notion.so/page123');
    // Slim email should NOT contain the full context table
    expect(callArgs.html).not.toContain('Additional Context');
    expect(callArgs.text).toContain('Notion: https://notion.so/page123');
  });

  it('should send full detail email when Notion creation fails', async () => {
    mockCreateOncallItem.mockRejectedValueOnce(new Error('Notion API error'));

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

    expect(mockCreateOncallItem).not.toHaveBeenCalled();
    expect(mockSendMail).toHaveBeenCalled();
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.html).toContain('View in Notion');
    expect(callArgs.html).toContain('https://notion.so/existing-page');
  });

  it('should send oncall alert with default email when ONCALL_EMAIL_LIST is not set', async () => {
    delete process.env.ONCALL_EMAIL_LIST;
    mockCreateOncallItem.mockRejectedValueOnce(new Error('skip'));

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
    mockCreateOncallItem.mockResolvedValueOnce({
      pageId: 'p1',
      notionUrl: 'https://notion.so/p1',
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
    mockCreateOncallItem.mockRejectedValueOnce(new Error('Notion error'));

    // Should not throw
    await expect(emailService.sendOncallAlert(
      'Test Alert',
      'Test message'
    )).resolves.not.toThrow();
  });
});
