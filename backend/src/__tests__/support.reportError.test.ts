import express from 'express';
import request from 'supertest';
import supportRouter from '../routes/support';

// Mock dependencies
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue({
      userId: 'user-123',
      email: 'user@example.com',
      displayName: 'Test User'
    })
  }
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com', isAdmin: false };
    next();
  }
}));

const { resendService } = require('../services/resendService');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/support', supportRouter);
  return app;
}

describe('POST /api/support/report-error', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL tests — invalid inputs / boundary conditions
  it('returns 400 when errorMessage is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-error')
      .send({ sessionId: 'session-123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/error message is required/i);
  });

  it('returns 400 when errorMessage is an empty string', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-error')
      .send({ errorMessage: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/error message is required/i);
  });

  it('does not expose internal server errors to caller when email sending fails', async () => {
    resendService.sendEmail.mockRejectedValueOnce(new Error('SMTP connection failed'));
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-error')
      .send({ errorMessage: 'Some API error' });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Failed to send error report');
  });

  // SUCCESS test — happy path
  it('sends email and returns 200 with valid error report data', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-error')
      .send({
        errorMessage: 'Rate limit exceeded',
        errorCode: 'RATE_LIMIT',
        sessionId: 'session-abc',
        pageUrl: 'https://app.agentweb.pro/agent-mode/session-abc',
        additionalDetails: 'Happened after clicking send'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
    const emailCall = resendService.sendEmail.mock.calls[0][0];
    expect(emailCall.to).toEqual(['ruiw@agentweb.pro']);
    expect(emailCall.subject).toContain('Error Report');
    expect(emailCall.html).toContain('Rate limit exceeded');
    expect(emailCall.html).toContain('RATE_LIMIT');
    expect(emailCall.html).toContain('session-abc');
  });

  it('succeeds with only the required errorMessage field', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-error')
      .send({ errorMessage: 'Something went wrong' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
  });
});
