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

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getJsonArraySetting: jest.fn().mockResolvedValue(['founders@agentweb.pro'])
  }
}));

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue({ pageId: 'page-abc', notionUrl: 'https://notion.so/pageabc' })
}));

jest.mock('../utils/s3Utils', () => ({
  uploadScreenshotToS3: jest.fn().mockResolvedValue({
    url: 'https://agentweb-user-files.s3.amazonaws.com/users/user-123/files/1/tok/screenshot.jpg',
    attachment: {
      url: 'https://agentweb-user-files.s3.amazonaws.com/users/user-123/files/1/tok/screenshot.jpg',
      filename: 'screenshot.jpg',
      size: 1234,
      mimetype: 'image/jpeg',
      uploadedAt: '2026-06-10T00:00:00.000Z'
    }
  }),
  presignS3Url: jest.fn().mockReturnValue('https://agentweb-user-files.s3.amazonaws.com/presigned')
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com', isAdmin: false };
    next();
  }
}));

const { resendService } = require('../services/resendService');
const { createOncallItem } = require('../services/notionService');
const { uploadScreenshotToS3 } = require('../utils/s3Utils');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/support', supportRouter);
  return app;
}

describe('POST /api/support/report-ui-bug', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL tests — invalid inputs / boundary conditions
  it('returns 400 when description is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ pageUrl: 'https://app.agentweb.pro/tasks' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/description is required/i);
    expect(createOncallItem).not.toHaveBeenCalled();
  });

  it('returns 400 when description is an empty/whitespace string', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ description: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/description is required/i);
  });

  it('does not expose internal server errors to caller when email sending fails', async () => {
    resendService.sendEmail.mockRejectedValueOnce(new Error('SMTP connection failed'));
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ description: 'The button overlaps the header' });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Failed to submit report');
  });

  // SUCCESS tests — happy path
  it('uploads screenshot, creates a tracked item, emails the team, and returns the issue id', async () => {
    const app = buildApp();
    const dataUrl = 'data:image/jpeg;base64,QUJD';
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({
        description: 'The save button is cut off on the settings page',
        pageUrl: 'https://app.agentweb.pro/settings',
        screenshot: dataUrl
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.issueId).toBe('AGW-page-abc');

    // Screenshot uploaded for the reporting user
    expect(uploadScreenshotToS3).toHaveBeenCalledWith(dataUrl, 'user-123');

    // Tracked item created on the sprint board with the right tags + context
    expect(createOncallItem).toHaveBeenCalledTimes(1);
    const itemArg = createOncallItem.mock.calls[0][0];
    expect(itemArg.additionalTags).toEqual(expect.arrayContaining(['Customer Reported', 'Bug']));
    expect(itemArg.title).toMatch(/^UI Bug:/);
    expect(itemArg.description).toContain('The save button is cut off');
    expect(itemArg.context['Page URL']).toBe('https://app.agentweb.pro/settings');
    expect(itemArg.context['Screenshot']).toContain('s3.amazonaws.com');

    // Team notified, reply-to the customer
    expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
    const emailCall = resendService.sendEmail.mock.calls[0][0];
    expect(emailCall.to).toEqual(['founders@agentweb.pro']);
    expect(emailCall.subject).toContain('UI Bug');
    expect(emailCall.replyTo).toBe('user@example.com');
    expect(emailCall.html).toContain('The save button is cut off');
  });

  it('succeeds without a screenshot (does not attempt upload)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ description: 'Something looks broken', pageUrl: 'https://app.agentweb.pro/tasks' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(uploadScreenshotToS3).not.toHaveBeenCalled();
    expect(createOncallItem).toHaveBeenCalledTimes(1);
    const itemArg = createOncallItem.mock.calls[0][0];
    expect(itemArg.context['Screenshot']).toBe('Not provided');
  });

  it('still reports the bug if screenshot upload fails (degrades gracefully)', async () => {
    uploadScreenshotToS3.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({
        description: 'Layout glitch',
        pageUrl: 'https://app.agentweb.pro/tasks',
        screenshot: 'data:image/jpeg;base64,QUJD'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(createOncallItem).toHaveBeenCalledTimes(1);
    const itemArg = createOncallItem.mock.calls[0][0];
    expect(itemArg.context['Screenshot']).toBe('Upload failed');
  });

  // Report types — bugs, feature requests, improvements, general feedback
  it('defaults to a bug report (tag "Bug", "UI Bug" title) when reportType is omitted', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ description: 'The layout is broken' });

    expect(res.status).toBe(200);
    const itemArg = createOncallItem.mock.calls[0][0];
    expect(itemArg.additionalTags).toEqual(expect.arrayContaining(['Customer Reported', 'Bug']));
    expect(itemArg.title).toMatch(/^UI Bug:/);
    expect(resendService.sendEmail.mock.calls[0][0].subject).toContain('[Bug]');
  });

  it('falls back to a bug report when reportType is unrecognized', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ description: 'Weird thing', reportType: 'not-a-real-type' });

    expect(res.status).toBe(200);
    const itemArg = createOncallItem.mock.calls[0][0];
    expect(itemArg.additionalTags).toEqual(expect.arrayContaining(['Customer Reported', 'Bug']));
  });

  it('tags and labels a feature request', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ description: 'Please add dark mode', reportType: 'feature_request' });

    expect(res.status).toBe(200);
    const itemArg = createOncallItem.mock.calls[0][0];
    expect(itemArg.additionalTags).toEqual(expect.arrayContaining(['Customer Reported', 'Feature Request']));
    expect(itemArg.title).toMatch(/^Feature Request:/);
    const emailCall = resendService.sendEmail.mock.calls[0][0];
    expect(emailCall.subject).toContain('[Feature Request]');
    expect(emailCall.html).toContain('Feature Request');
  });

  it('tags and labels an improvement suggestion', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ description: 'Make the dashboard faster', reportType: 'improvement' });

    expect(res.status).toBe(200);
    const itemArg = createOncallItem.mock.calls[0][0];
    expect(itemArg.additionalTags).toEqual(expect.arrayContaining(['Customer Reported', 'Improvement']));
    expect(itemArg.title).toMatch(/^Improvement:/);
    expect(resendService.sendEmail.mock.calls[0][0].subject).toContain('[Improvement]');
  });

  it('tags and labels general feedback', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/support/report-ui-bug')
      .send({ description: 'Love the product!', reportType: 'feedback' });

    expect(res.status).toBe(200);
    const itemArg = createOncallItem.mock.calls[0][0];
    expect(itemArg.additionalTags).toEqual(expect.arrayContaining(['Customer Reported', 'Feedback']));
    expect(itemArg.title).toMatch(/^Feedback:/);
    expect(resendService.sendEmail.mock.calls[0][0].subject).toContain('[Feedback]');
  });
});
