/**
 * ENG-529 — POST /api/support/report-ui-bug: the durable filing result is decoupled from
 * best-effort notification delivery.
 *
 * Production returned HTTP 500 three times on 2026-07-26 even though every attempt had already
 * filed the report: the email subject was built from the raw first 80 characters of a MULTILINE
 * description, Resend rejected it (`422 validation_error: "The \n is not allowed in the subject
 * field."`), and that `await` sat inside the route's success-critical try/catch. The generic
 * failure toast then invited retries, so one report became reporter tickets #169, #170 and #171.
 *
 * These tests cover the human-written behavioral contract on the Linear issue.
 */
import express from 'express';
import request from 'supertest';
import supportRouter from '../routes/support';
import * as reportIntake from '../utils/reportIntake';

const { __resetReportIdempotencyForTests, ReportReplayCapacityError } = reportIntake;

const FILED = {
  pageId: '169',
  trackerUrl: 'https://featurebase.example/t/169',
  userUrl: 'https://featurebase.example/t/169',
  canonicalUrl: 'https://linear.app/emmabyaw/issue/ENG-529',
  deduped: false,
  tracker: 'Featurebase' as const,
};

jest.mock('../services/intakeService', () => ({
  fileUserIssue: jest.fn(),
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getJsonArraySetting: jest.fn() },
}));
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));
jest.mock('../utils/s3Utils', () => ({
  uploadScreenshotToS3: jest.fn(),
  presignS3Url: jest.fn().mockReturnValue('https://presigned.example/shot.png'),
}));
jest.mock('../utils/errorReporter', () => ({
  reportUIError: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com', isAdmin: false };
    next();
  },
}));

const { fileUserIssue } = require('../services/intakeService');
const { resendService } = require('../services/resendService');
const { settingsService } = require('../services/settingsService');
const { userDb } = require('../services/db');
const { reportUIError } = require('../utils/errorReporter');

const MULTILINE = [
  'The Generate button does nothing.',
  '',
  'Steps to reproduce:',
  '1. Open the marketing hub',
  '2. Click Generate',
  '3. Nothing happens and the spinner stays forever',
].join('\n');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/support', supportRouter);
  return app;
}

function submit(body: Record<string, any>) {
  return request(buildApp()).post('/api/support/report-ui-bug').send(body);
}

describe('POST /api/support/report-ui-bug — filing vs notification (ENG-529)', () => {
  // Every case here is a full supertest round trip; jest's 5s default is tight against a cold
  // ts-jest transform on a loaded CI worker (observed once locally). Explicit, not flaky-tolerant.
  jest.setTimeout(20_000);

  beforeEach(() => {
    jest.clearAllMocks();
    __resetReportIdempotencyForTests();
    fileUserIssue.mockResolvedValue(FILED);
    resendService.sendEmail.mockResolvedValue(undefined);
    settingsService.getJsonArraySetting.mockResolvedValue(['founders@agentweb.pro']);
    userDb.getUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'user@example.com',
      displayName: 'Test User',
    });
  });

  // AC1 — a multiline report of any type succeeds and returns the tracked item + link.
  it.each([
    ['bug', 'UI Bug'],
    ['feature_request', 'Feature Request'],
    ['improvement', 'Improvement'],
    ['feedback', 'Feedback'],
  ])('AC1: accepts a multiline %s description and returns the tracked item + link', async (reportType, prefix) => {
    const res = await submit({ description: MULTILINE, reportType, pageUrl: 'https://app.agentweb.pro/hub' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.issueId).toBe('AGW-169');
    expect(res.body.trackingUrl).toBe(FILED.userUrl);
    expect(fileUserIssue).toHaveBeenCalledTimes(1);
    // The shared title is normalized ONCE — no raw newline reaches the tracked item either.
    const filedTitle = fileUserIssue.mock.calls[0][0].title as string;
    expect(filedTitle.startsWith(`${prefix}: `)).toBe(true);
    expect(filedTitle).not.toMatch(/[\r\n]/);
    // The reporter's own words keep their line breaks in the issue body.
    expect(fileUserIssue.mock.calls[0][0].description).toContain('\n');
  });

  // AC2 — the outbound notification subject is valid single-line text derived from the report.
  it('AC2: builds a single-line notification subject from a multiline description', async () => {
    await submit({ description: MULTILINE, reportType: 'bug' });

    expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
    const subject = resendService.sendEmail.mock.calls[0][0].subject as string;
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain('[Bug]');
    expect(subject).toContain('The Generate button does nothing. Steps to reproduce:');
    expect(subject).toContain('reported by user@example.com');
  });

  it('AC2: strips control characters that would make the subject invalid', async () => {
    await submit({ description: 'Broken\u000bafter\u2028save', reportType: 'bug' });

    const subject = resendService.sendEmail.mock.calls[0][0].subject as string;
    expect(subject).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
    expect(subject).toContain('Broken after save');
  });

  // AC3 — filing succeeded, notification failed: still success, failure recorded for operators.
  it('AC3: reports filing success when the notification email fails, and records the failure', async () => {
    resendService.sendEmail.mockRejectedValueOnce(
      new Error('Resend 422 validation_error: The \n is not allowed in the subject field.'),
    );

    const res = await submit({ description: MULTILINE, reportType: 'bug' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.issueId).toBe('AGW-169');
    expect(res.body.trackingUrl).toBe(FILED.userUrl);

    expect(reportUIError).toHaveBeenCalledTimes(1);
    const reported = reportUIError.mock.calls[0][0];
    expect(reported.operation).toBe('support:report-ui-bug:notification');
    expect(reported.errorMessage).toContain('not allowed in the subject field');
    expect(reported.userId).toBe('user-123');
    expect(reported.context['Issue ID']).toBe('AGW-169');
    expect(reported.context['Tracker URL']).toBe(FILED.trackerUrl);
  });

  it('AC3: a notification failure never rolls back or re-runs the filing', async () => {
    resendService.sendEmail.mockRejectedValueOnce(new Error('Resend down'));

    await submit({ description: MULTILINE, reportType: 'bug' });

    expect(fileUserIssue).toHaveBeenCalledTimes(1);
  });

  // AC4 — filing itself failed: report failure, never claim the report is tracked.
  it('AC4: returns failure and claims nothing tracked when filing fails', async () => {
    fileUserIssue.mockRejectedValueOnce(new Error('Linear create failed'));

    const res = await submit({ description: MULTILINE, reportType: 'bug' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBeUndefined();
    expect(res.body.issueId).toBeUndefined();
    expect(res.body.trackingUrl).toBeUndefined();
    expect(res.body.message).toBe('Failed to submit report');
    // Nothing was announced as tracked to the team either.
    expect(resendService.sendEmail).not.toHaveBeenCalled();
  });

  it('AC4: a failed filing is retryable — the retry really files', async () => {
    fileUserIssue.mockRejectedValueOnce(new Error('Linear create failed'));

    const failed = await submit({ description: MULTILINE, reportType: 'bug' });
    const retry = await submit({ description: MULTILINE, reportType: 'bug' });

    expect(failed.status).toBe(500);
    expect(retry.status).toBe(200);
    expect(retry.body.issueId).toBe('AGW-169');
    expect(fileUserIssue).toHaveBeenCalledTimes(2);
  });

  it('returns an explicit retryable 503 when bounded replay admission times out', async () => {
    const guard = jest
      .spyOn(reportIntake, 'fileReportOnce')
      .mockRejectedValueOnce(new ReportReplayCapacityError());
    try {
      const res = await submit({ description: MULTILINE, reportType: 'bug' });

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.message).toBe('Report intake is busy; please retry shortly');
      expect(fileUserIssue).not.toHaveBeenCalled();
    } finally {
      guard.mockRestore();
    }
  });

  // AC5 — retrying an ambiguous/timed-out request must not duplicate the reporter ticket.
  it('AC5: a sequential retry of the same report replays the first filing', async () => {
    const first = await submit({ description: MULTILINE, reportType: 'bug', pageUrl: '/hub' });
    const second = await submit({ description: MULTILINE, reportType: 'bug', pageUrl: '/hub' });
    const third = await submit({ description: MULTILINE, reportType: 'bug', pageUrl: '/hub' });

    expect(fileUserIssue).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
    // …and the product team is notified once, not once per retry.
    expect(resendService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('AC5: concurrent duplicate submissions collapse onto a single filing', async () => {
    let resolveFiling: (v: any) => void = () => {};
    fileUserIssue.mockImplementationOnce(() => new Promise((resolve) => { resolveFiling = resolve; }));

    // `.then` is what dispatches a supertest request — both are genuinely in flight before the
    // filing is allowed to resolve.
    const a = submit({ description: MULTILINE, reportType: 'bug' }).then((r) => r);
    const b = submit({ description: MULTILINE, reportType: 'bug' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    resolveFiling(FILED);

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resB.body).toEqual(resA.body);
    expect(fileUserIssue).toHaveBeenCalledTimes(1);
  });

  it('AC5: a genuinely different report from the same user still files separately', async () => {
    await submit({ description: MULTILINE, reportType: 'bug' });
    await submit({ description: 'A completely different problem', reportType: 'bug' });

    expect(fileUserIssue).toHaveBeenCalledTimes(2);
  });

  it('AC5: the same wording from a different report type still files separately', async () => {
    await submit({ description: MULTILINE, reportType: 'bug' });
    await submit({ description: MULTILINE, reportType: 'feature_request' });

    expect(fileUserIssue).toHaveBeenCalledTimes(2);
  });
});
