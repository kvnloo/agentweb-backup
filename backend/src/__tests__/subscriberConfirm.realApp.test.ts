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

  it('the button works whatever Origin the browser sends, because the signed link (not a cookie) is the credential: the page\'s own origin, "null", or a deployment that is not on the allowed list', async () => {
    for (const origin of [PAGE_ORIGIN, 'null', 'https://backend.some-other-deployment.example']) {
      (subscriberDb.addSubscriber as jest.Mock).mockClear();
      const press = await request(app).post(confirmPath).set('Origin', origin).type('form').send({ token: signConfirmToken(TASK, EMAIL) });
      expect({ origin, status: press.status }).toEqual({ origin, status: 200 });
      expect(subscriberDb.addSubscriber).toHaveBeenCalledWith(TASK, EMAIL);
    }
  });

  it('the global cross-origin check still refuses other state-changing calls from the origin "null"', async () => {
    // the exception is only the confirm path: the sibling public routes and everything else keep the app-wide rule
    const res = await request(app).post(`/api/tasks/${TASK}/unsubscribe`).set('Origin', 'null').send({ email: EMAIL });
    expect(res.status).toBe(403);
  });

  it('the expired-link and the no-longer-valid pages are served with the same headers', async () => {
    const expired = await request(app).get(`${confirmPath}?token=nope`).expect(400);
    expect(expired.headers['referrer-policy']).toBe('same-origin');
    expect(expired.headers['content-security-policy']).toContain("form-action 'self'");
  });

  it('the public subscriber calls are parsed with a small limit before any limiter runs: a large body is refused, not buffered, whatever the letter case or trailing slash of the path', async () => {
    const paths: Array<[string, number]> = [
      [`/api/tasks/${TASK}/subscribers/join`, 20_000],
      [`/api/tasks/${TASK}/subscribers/confirm`, 20_000],
      [`/api/tasks/${TASK}/resubscribe`, 20_000],
      [`/api/tasks/${TASK}/unsubscribe`, 40_000],
      // the routers match any letter case and a trailing slash, so the limit must too
      [`/api/tasks/${TASK}/unsubscribe/`, 40_000],
      [`/api/tasks/${TASK}/Unsubscribe`, 40_000],
      [`/API/Tasks/${TASK}/unsubscribe/`, 40_000],
      [`/api/tasks/${TASK}/subscribers/join/`, 20_000],
      [`/api/tasks/${TASK}/Subscribers/JOIN`, 20_000],
      [`/api/tasks/${TASK}/subscribers/confirm/`, 20_000],
      [`/api/tasks/${TASK}/RESUBSCRIBE/`, 20_000],
      // a doubled slash after the mount path is routed to the same handler by Express
      [`/api/tasks//${TASK}/unsubscribe`, 40_000],
      [`/api/tasks//${TASK}/subscribers/join`, 20_000],
      [`/api/tasks//${TASK}/subscribers/confirm`, 20_000],
      [`/api/tasks//${TASK}/resubscribe`, 20_000],
    ];
    for (const [path, size] of paths) {
      const big = 'x'.repeat(size);
      const asJson = await request(app).post(path).send({ email: EMAIL, token: big });
      expect({ path, status: asJson.status }).toEqual({ path, status: 413 });
      const asForm = await request(app).post(path).type('form').send({ email: EMAIL, token: big });
      expect({ path, status: asForm.status }).toEqual({ path, status: 413 });
    }
    expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
  });

  it('the confirm button also works at the doubled-slash and trailing-slash spellings of its path (the origin exception matches them too)', async () => {
    for (const path of [`/api/tasks//${TASK}/subscribers/confirm`, `${confirmPath}/`, `/api/tasks/${TASK}/Subscribers/CONFIRM`]) {
      (subscriberDb.addSubscriber as jest.Mock).mockClear();
      const press = await request(app).post(path).set('Origin', 'https://backend.some-other-deployment.example').type('form').send({ token: signConfirmToken(TASK, EMAIL) });
      expect({ path, status: press.status }).toEqual({ path, status: 200 });
      expect(subscriberDb.addSubscriber).toHaveBeenCalledWith(TASK, EMAIL);
    }
  });

  it('an unsubscribe with a long feedback note (more than 8 kb, less than 32 kb) still reaches the route, which cuts it to 2000 characters', async () => {
    const res = await request(app).post(`/api/tasks/${TASK}/unsubscribe`).set('X-Forwarded-For', '203.0.113.90').send({ email: EMAIL, feedback: 'é'.repeat(10_000) });
    expect(res.status).toBe(404); // reached the route: no such subscriber
  });

  it.each([
    ['too many form fields in a small body', () => request(app).post(`/api/tasks/${TASK}/unsubscribe`).type('form').send('a=1' + '&a=1'.repeat(1200))],
    ['a body that claims to be gzip and is not', () => request(app).post(`/api/tasks/${TASK}/unsubscribe`).set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send('this is not gzip')],
    ['an unsupported character set', () => request(app).post(`/api/tasks/${TASK}/unsubscribe`).set('Content-Type', 'application/json; charset=x-nope').send('{"email":"a@b.co"}')],
  ])('answers %s as the caller\'s mistake (a 4xx JSON answer), and does not report a server error', async (_what, make) => {
    const reported = jest.spyOn(console, 'error');
    const res = await make();
    expect([400, 413, 415]).toContain(res.status);
    expect(res.status).not.toBe(500);
    expect(reported.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('Unhandled route error');
  });

  it('a body that is not valid JSON gets a plain 400, and is not reported as a server error', async () => {
    const res = await request(app).post(`/api/tasks/${TASK}/unsubscribe`).set('Content-Type', 'application/json').send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Invalid request' });
  });

  it('ordinary requests to the same routes are untouched by the small limit', async () => {
    const join = await request(app).post(`/api/tasks/${TASK}/subscribers/join`).set('X-Forwarded-For', '203.0.113.77').send({ email: EMAIL });
    expect(join.status).toBe(202);
    const unsub = await request(app).post(`/api/tasks/${TASK}/unsubscribe`).set('X-Forwarded-For', '203.0.113.78').send({ email: EMAIL, feedback: 'x'.repeat(2000) });
    expect(unsub.status).toBe(404); // reached the route: no such subscriber
  });
});
