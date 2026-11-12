// Unit tests for oncall alert functionality

// ENG-164: SMTP is gone — mock resendService, the single send path.
const mockSendMail = jest.fn().mockResolvedValue({ id: 'resend-email-id' });

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: (...args: any[]) => mockSendMail(...args),
  },
}));

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

  it('should send no email when a Linear issue is filed successfully', async () => {
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

    expect(mockFileAutoIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Test Alert',
      description: 'This is a test alert message',
      notionContext: { 'Context Key': 'Context Value' },
      executionRoute: 'human-triage',
    }));

    // The tracked issue is the record; no redundant email.
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('should send full detail email when Linear filing fails', async () => {
    mockFileAutoIssue.mockRejectedValueOnce(new Error('Linear API error'));

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

  it('should skip issue filing when a tracker URL is provided', async () => {
    await emailService.sendOncallAlert(
      'Test Alert',
      'Test message',
      { 'Key': 'Value' },
      'https://notion.so/existing-page'
    );

    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
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
    mockFileAutoIssue.mockRejectedValueOnce(new Error('Linear down'));

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
    mockSendMail.mockRejectedValueOnce(new Error('Resend API error: down'));
    mockFileAutoIssue.mockRejectedValueOnce(new Error('Linear error'));

    // Should not throw
    await expect(emailService.sendOncallAlert(
      'Test Alert',
      'Test message'
    )).resolves.not.toThrow();
  });
});

describe('EmailService - sendOncallEmailOnly (ENG-2743)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ONCALL_EMAIL_LIST = 'test@example.com,test2@example.com';
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    delete process.env.ONCALL_EMAIL_LIST;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('emails the oncall list and never files a tracked issue', async () => {
    const sent = await emailService.sendOncallEmailOnly('2 scheduled runs cost 2x+', 'line one\n- schedule <b>x</b> & y');
    expect(sent).toBe(true);
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.to).toEqual(['test@example.com', 'test2@example.com']);
    expect(callArgs.subject).toBe('[PROD] 2 scheduled runs cost 2x+');
    expect(callArgs.text).toContain('line one\n- schedule <b>x</b> & y');
    expect(callArgs.html).toContain('schedule &lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(callArgs.html).not.toContain('<b>x</b>');
  });

  it('sends nothing outside production', async () => {
    process.env.NODE_ENV = 'development';
    expect(await emailService.sendOncallEmailOnly('s', 'm')).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
  });

  it('returns false instead of throwing when the send fails', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('resend down'));
    await expect(emailService.sendOncallEmailOnly('s', 'm')).resolves.toBe(false);
  });
});
