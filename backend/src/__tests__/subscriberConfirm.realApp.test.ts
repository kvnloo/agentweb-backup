/**
 * ENG-2991, a bug found in review that no route-level test could see: the confirm page's button is a plain HTML form POST, and the API sets
 * `Referrer-Policy: no-referrer` on every response. Under that policy a browser labels a form POST `Origin: null` (even to the same site),
 * and the app-wide CORS check rejects that with 403 Forbidden, so the Confirm button would never have worked. Route tests that mount the
 * router alone have no global headers and no CORS, so they passed. This boots the REAL app.
 *
 * The browser rule (Fetch standard, "append a request Origin header"): for a non-GET request that is not a CORS request, when the referrer
 * policy is `no-referrer` the Origin header is `null`; otherwise it is the page's own origin.
 */
jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  EC2: jest.fn(() => ({})),
  SSM: jest.fn(() => ({})),
  IAM: jest.fn(() => ({})),
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn().mockReturnThis(),
      put: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      get: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      scan: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
  },
  S3: jest.fn(() => ({
    getObject: jest.fn().mockReturnThis(),
    putObject: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  SES: jest.fn(() => ({})),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), getAllUsers: jest.fn() },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getTaskSubscriberByEmail: jest.fn(), addSubscriber: jest.fn(), getTaskSubscriberStates: jest.fn(), resubscribe: jest.fn() },
}));
jest.mock('../services/emailService', () => ({
  emailService: { sendSubscriberWelcomeEmail: jest.fn().mockResolvedValue(undefined), sendSubscriberConfirmationEmail: jest.fn().mockResolvedValue(true) },
}));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import request from 'supertest';
import app from '../app';
import { taskDb, subscriberDb } from '../services/db';
import { emailService } from '../services/emailService';
import { signConfirmToken } from '../services/subscriberTokens';
import { clearSubscriberLookups } from '../services/subscriberLookup';

const TASK = 'task-1';
const EMAIL = 'reader@example.com';
const PAGE_ORIGIN = 'https://api.agentweb.pro'; // where the confirm page is served from in production
const confirmPath = `/api/tasks/${TASK}/subscribers/confirm`;

/** What a browser puts in the Origin header of a form POST made from a page that came with this Referrer-Policy. */
const originBrowserSends = (referrerPolicy: string | undefined) => (referrerPolicy === 'no-referrer' ? 'null' : PAGE_ORIGIN);

beforeEach(() => {
  jest.clearAllMocks();
  clearSubscriberLookups();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: TASK, userId: 'owner', name: 'Weekly Report' });
  (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(undefined);
  (subscriberDb.getTaskSubscriberStates as jest.Mock).mockResolvedValue([]);
  (subscriberDb.addSubscriber as jest.Mock).mockResolvedValue({ taskId: TASK, email: EMAIL });
});
afterEach(() => jest.restoreAllMocks());

describe('the confirmation page in the real app (global headers and CORS included)', () => {
  const link = () => `${confirmPath}?token=${encodeURIComponent(signConfirmToken(TASK, EMAIL))}`;

  it('does not come with the API-wide no-referrer policy, and locks the page down to a same-site form', async () => {
    const res = await request(app).get(link()).expect(200);
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("form-action 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY'); // the global header still applies
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`<form method="post" action="${confirmPath}"`); // same site, so no cross-site post
  });

  it('subscribes when the Confirm button is pressed: the form POST carries the Origin a browser sends for this page', async () => {
    const page = await request(app).get(link()).expect(200);
    const token = signConfirmToken(TASK, EMAIL);

    const press = await request(app)
      .post(confirmPath)
      .set('Origin', originBrowserSends(page.headers['referrer-policy'] as string))
      .type('form')
      .send({ token });

    expect(press.status).toBe(200);
    expect(press.text).toContain('subscribed');
    expect(subscriberDb.addSubscriber).toHaveBeenCalledWith(TASK, EMAIL);
    expect(emailService.sendSubscriberWelcomeEmail).toHaveBeenCalledWith(EMAIL, TASK);
  });

  it('a form POST labelled Origin: null (what no-referrer would produce) is refused by the app-wide CORS check, which is why the page must not use that policy', async () => {
    const press = await request(app).post(confirmPath).set('Origin', 'null').type('form').send({ token: signConfirmToken(TASK, EMAIL) });
    expect(press.status).toBe(403);
    expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
  });

  it('the expired-link and the no-longer-valid pages are served with the same headers', async () => {
    const expired = await request(app).get(`${confirmPath}?token=nope`).expect(400);
    expect(expired.headers['referrer-policy']).toBe('same-origin');
    expect(expired.headers['content-security-policy']).toContain("form-action 'self'");
  });
});
