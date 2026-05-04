import request from 'supertest';
import express from 'express';
import supportRoutes from '../routes/support';
import { resendService } from '../services/resendService';
import { userDb } from '../services/db';
import { authenticateToken } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/resendService');
jest.mock('../services/db');
jest.mock('../middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/support', supportRoutes);

describe('POST /api/support/send-help-message', () => {
  const mockUser = {
    userId: 'user123',
    email: 'customer@example.com',
    displayName: 'Test Customer',
    isAdmin: false,
  };

  const mockToken = 'valid-token';

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock authenticateToken middleware
    (authenticateToken as jest.Mock).mockImplementation((req: any, res: any, next: any) => {
      req.user = mockUser;
      next();
    });

    // Mock userDb.getUserById
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

    // Mock resendService.sendEmail
    (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'email-123' });
  });

  it('should send help message successfully', async () => {
    const response = await request(app)
      .post('/api/support/send-help-message')
      .set('Authorization', `Bearer ${mockToken}`)
      .send({
        message: 'I need help with my account',
        pageUrl: 'https://app.agentweb.pro/settings',
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Help message sent successfully');

    // Verify resendService.sendEmail was called
    expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
    expect(resendService.sendEmail).toHaveBeenCalledWith({
      from: 'AgentWeb Support <hi@updates.agentweb.pro>',
      to: ['founders@agentweb.pro'],
      subject: 'Help Request from customer@example.com',
      html: expect.stringContaining('I need help with my account'),
      replyTo: 'customer@example.com',
    });

    // Verify email contains user info
    const emailCall = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.html).toContain('customer@example.com');
    expect(emailCall.html).toContain('user123');
    expect(emailCall.html).toContain('https://app.agentweb.pro/settings');
  });

  it('should send help message with delegation info', async () => {
    // Mock authenticated request with delegation
    (authenticateToken as jest.Mock).mockImplementation((req: any, res: any, next: any) => {
      req.user = mockUser;
      req.delegateInfo = {
        adminUserId: 'admin123',
        adminEmail: 'admin@agentweb.pro',
        isDelegated: true,
      };
      next();
    });

    const response = await request(app)
      .post('/api/support/send-help-message')
      .set('Authorization', `Bearer ${mockToken}`)
      .send({
        message: 'Testing delegation',
        pageUrl: 'https://app.agentweb.pro/dashboard',
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    // Verify email contains delegation warning
    const emailCall = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.html).toContain('admin@agentweb.pro');
    expect(emailCall.html).toContain('admin delegation');
    expect(emailCall.replyTo).toBe('customer@example.com'); // Reply-to should still be customer
  });

  it('should return 400 if message is missing', async () => {
    const response = await request(app)
      .post('/api/support/send-help-message')
      .set('Authorization', `Bearer ${mockToken}`)
      .send({
        pageUrl: 'https://app.agentweb.pro/settings',
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Message is required');
    expect(resendService.sendEmail).not.toHaveBeenCalled();
  });

  it('should return 404 if user not found', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(null);

    const response = await request(app)
      .post('/api/support/send-help-message')
      .set('Authorization', `Bearer ${mockToken}`)
      .send({
        message: 'Help me',
        pageUrl: 'https://app.agentweb.pro/settings',
      });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('User not found');
    expect(resendService.sendEmail).not.toHaveBeenCalled();
  });

  it('should handle email sending errors gracefully', async () => {
    (resendService.sendEmail as jest.Mock).mockRejectedValue(new Error('Email service error'));

    const response = await request(app)
      .post('/api/support/send-help-message')
      .set('Authorization', `Bearer ${mockToken}`)
      .send({
        message: 'Test message',
        pageUrl: 'https://app.agentweb.pro/settings',
      });

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Failed to send help message');
  });

  it('should work with optional pageUrl', async () => {
    const response = await request(app)
      .post('/api/support/send-help-message')
      .set('Authorization', `Bearer ${mockToken}`)
      .send({
        message: 'I need help',
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    // Verify email contains "Not provided" for pageUrl
    const emailCall = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.html).toContain('Not provided');
  });

  it('should preserve line breaks in message', async () => {
    const multilineMessage = 'Line 1\nLine 2\nLine 3';

    const response = await request(app)
      .post('/api/support/send-help-message')
      .set('Authorization', `Bearer ${mockToken}`)
      .send({
        message: multilineMessage,
        pageUrl: 'https://app.agentweb.pro/settings',
      });

    expect(response.status).toBe(200);

    // Verify email contains <br> tags
    const emailCall = (resendService.sendEmail as jest.Mock).mock.calls[0][0];
    expect(emailCall.html).toContain('Line 1<br>Line 2<br>Line 3');
  });
});
