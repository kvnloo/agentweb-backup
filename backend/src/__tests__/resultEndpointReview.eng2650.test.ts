/**
 * ENG-2650: the result-endpoint review routes (/review/:sessionId and
 * /review/:sessionId/send) must only serve the configured reviewer (per-session
 * capability token) or a real admin, /send may only email this session's own
 * assets to one valid address, everything interpolated into the email is
 * escaped, and sends are rate-limited per session.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn(async () => ({ user: null })),
}));

jest.mock('../controllers/resultEndpointController', () => ({
  handleResult: jest.fn(),
  getResultEndpointConfigs: jest.fn(async () => []),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionResultEndpointMetadata: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn().mockResolvedValue({ id: 'resend-1' }) },
}));

jest.mock('../config', () => ({
  RESEND_SYSTEM_EMAIL: 'no-reply@updates.agentweb.pro',
  RESEND_SYSTEM_NAME: 'AgentWeb',
}));

import { getUserFromToken } from '../middleware/auth';
import { chatbotDb } from '../services/chatbotService';
import { resendService } from '../services/resendService';
import { reviewRouter, requireReviewAccess, REVIEW_SEND_LIMIT } from '../routes/resultEndpoints';
import {
  buildResultDeliveryEmailHtml,
  buildReviewUrl,
  isValidRecipientEmail,
  signReviewToken,
  verifyReviewToken,
} from '../services/resultEndpointReview';

const mockedGetUser = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;
const mockedDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockedSend = resendService.sendEmail as jest.Mock;

const IMAGE_URL = 'https://s3.example.com/hero.png';
const HTML_URL = 'https://s3.example.com/report.html';
const ISHARE_URL = 'https://app.example.com/ishare/sess?conversable=secret';

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    resultName: 'gtm',
    resultTitle: 'GTM Plan',
    leadEmail: 'lead@example.com',
    reviewerEmail: 'reviewer@example.com',
    outputFormat: 'html',
    args: {},
    sendHistory: [],
    ...overrides,
  };
}

function useSession(sessionId: string, meta: Record<string, unknown> = metadata()) {
  mockedDb.getChatSession.mockImplementation(async (id: string) =>
    (id === sessionId ? { sessionId, resultEndpointMetadata: meta } : null) as any);
  (mockedDb as any).getMessagesFromMessagesTable.mockResolvedValue([
    { role: 'tool', name: 'generate_image', content: JSON.stringify({ success: true, imageUrl: IMAGE_URL }) },
    { role: 'tool', name: 'create_html_file', content: JSON.stringify({ success: true, s3_url: HTML_URL }) },
  ]);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/review', reviewRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetUser.mockResolvedValue({ user: null });
  mockedDb.createOrReuseInteractiveShare.mockResolvedValue(ISHARE_URL);
  mockedDb.updateSessionResultEndpointMetadata.mockResolvedValue({} as any);
});

describe('reviewer capability token', () => {
  it('is a per-session 256-bit token that only verifies for its own session', () => {
    const token = signReviewToken('sess-a');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signReviewToken('sess-a')).toBe(token);
    expect(signReviewToken('sess-b')).not.toBe(token);
    expect(verifyReviewToken('sess-a', token)).toBe(true);
    expect(verifyReviewToken('sess-b', token)).toBe(false);
  });

  it('fails closed for missing, malformed or tampered tokens', () => {
    const token = signReviewToken('sess-a');
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    for (const bad of [undefined, null, 42, '', 'sess-a', token.slice(1), `${token}A`, tampered, `${token.slice(0, 42)}=`]) {
      expect(verifyReviewToken('sess-a', bad)).toBe(false);
    }
    expect(verifyReviewToken('', token)).toBe(false);
  });

  it('depends on the server secret', () => {
    const original = process.env.JWT_SECRET;
    const token = signReviewToken('sess-a');
    try {
      process.env.JWT_SECRET = 'a-different-secret';
      expect(verifyReviewToken('sess-a', token)).toBe(false);
    } finally {
      process.env.JWT_SECRET = original;
    }
  });

  it('travels in the review link fragment, never the query string', () => {
    const url = buildReviewUrl('https://app.agentweb.pro/', 'sess-a');
    expect(url).toBe(`https://app.agentweb.pro/review/sess-a#token=${signReviewToken('sess-a')}`);
    expect(new URL(url).search).toBe('');
  });
});

describe('every review route is gated', () => {
  it('runs requireReviewAccess first on every route of reviewRouter', () => {
    const routes = (reviewRouter as any).stack.filter((layer: any) => layer.route);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const layer of routes) {
      expect(layer.route.stack[0].handle).toBe(requireReviewAccess);
    }
  });
});

describe('GET /review/:sessionId', () => {
  it('rejects a bare session id without reading the session, minting an iShare link or returning PII', async () => {
    useSession('sess-1');
    const res = await request(buildApp()).get('/review/sess-1').expect(401);
    expect(res.body.code).toBe('review_access_denied');
    expect(res.body.leadEmail).toBeUndefined();
    expect(res.body.ishareUrl).toBeUndefined();
    expect(mockedDb.getChatSession).not.toHaveBeenCalled();
    expect(mockedDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
  });

  it("rejects another session's token", async () => {
    useSession('sess-1');
    await request(buildApp()).get('/review/sess-1').set('X-Review-Token', signReviewToken('sess-2')).expect(401);
    expect(mockedDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
  });

  it('serves the reviewer holding the link token, including lead email and iShare URL', async () => {
    useSession('sess-1');
    const res = await request(buildApp()).get('/review/sess-1').set('X-Review-Token', signReviewToken('sess-1')).expect(200);
    expect(res.body.leadEmail).toBe('lead@example.com');
    expect(res.body.ishareUrl).toBe(ISHARE_URL);
    expect(res.body.assets.map((a: any) => a.url)).toEqual([IMAGE_URL, HTML_URL]);
  });

  it('serves a real admin without a link token', async () => {
    useSession('sess-1');
    mockedGetUser.mockResolvedValue({ user: { userId: 'admin-1', email: 'admin@example.com', isAdmin: true }, decoded: {} as any });
    const res = await request(buildApp()).get('/review/sess-1').set('Authorization', 'Bearer admin-jwt').expect(200);
    expect(res.body.ishareUrl).toBe(ISHARE_URL);
  });

  it('rejects a non-admin login and a delegated session even when the target account is an admin', async () => {
    useSession('sess-1');
    mockedGetUser.mockResolvedValue({ user: { userId: 'u-1', email: 'user@example.com', isAdmin: false }, decoded: {} as any });
    await request(buildApp()).get('/review/sess-1').set('Authorization', 'Bearer user-jwt').expect(401);

    mockedGetUser.mockResolvedValue({
      user: { userId: 'target-admin', email: 'target@example.com', isAdmin: true },
      decoded: { delegateAccess: { adminUserId: 'a', adminEmail: 'a@x.com', targetUserId: 'target-admin', targetEmail: 'target@example.com' } } as any,
    });
    await request(buildApp()).get('/review/sess-1').set('Authorization', 'Bearer delegate-jwt').expect(401);
    expect(mockedDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
  });
});

describe('POST /review/:sessionId/send', () => {
  const send = (sessionId: string, body: Record<string, unknown>, token: string | null = signReviewToken(sessionId)) => {
    const req = request(buildApp()).post(`/review/${sessionId}/send`);
    if (token) req.set('X-Review-Token', token);
    return req.send(body);
  };

  it('rejects an unauthenticated send without emailing', async () => {
    useSession('send-1');
    await send('send-1', { recipientEmail: 'victim@example.com', assetUrl: IMAGE_URL }, null).expect(401);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('only sends one of the session\'s own assets', async () => {
    useSession('send-2');
    const res = await send('send-2', { recipientEmail: 'lead@example.com', assetUrl: 'https://evil.example.com/phish' }).expect(400);
    expect(res.body.error).toMatch(/not one of this result's assets/);
    await send('send-2', { recipientEmail: 'lead@example.com', assetUrl: '__inline_html__' }).expect(400);
    expect(mockedSend).not.toHaveBeenCalled();

    await send('send-2', { recipientEmail: 'lead@example.com', assetUrl: HTML_URL }).expect(200);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend.mock.calls[0][0].html).toContain(`href="${HTML_URL}"`);
  });

  it('sends the inline-html sentinel only when the session has contentHtml', async () => {
    useSession('send-3', metadata({ contentHtml: '<h1>Generated plan</h1>' }));
    await send('send-3', { recipientEmail: 'lead@example.com', assetUrl: '__inline_html__' }).expect(200);
    expect(mockedSend.mock.calls[0][0].html).toContain('<h1>Generated plan</h1>');
  });

  it('accepts exactly one valid recipient address', async () => {
    useSession('send-4');
    for (const recipientEmail of ['not-an-email', 'a@example.com,b@example.com', 'Lead <lead@example.com>', 'lead@example.com\r\nbcc:x@example.com', 'a b@example.com']) {
      await send('send-4', { recipientEmail, assetUrl: IMAGE_URL }).expect(400);
    }
    expect(mockedSend).not.toHaveBeenCalled();
    expect(isValidRecipientEmail('first.last+tag@sub.example.co')).toBe(true);
  });

  it('escapes the result title, reply-to address and custom message in the email', async () => {
    useSession('send-5', metadata({
      resultTitle: '<script>alert(1)</script>',
      reviewerEmail: 'r@example.com"><img src=x onerror=alert(2)>',
    }));
    await send('send-5', {
      recipientEmail: 'lead@example.com',
      assetUrl: IMAGE_URL,
      customMessage: 'Hi "there" <b>&</b>',
    }).expect(200);
    const html: string = mockedSend.mock.calls[0][0].html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('r@example.com&quot;&gt;&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain('Hi &quot;there&quot; &lt;b&gt;&amp;&lt;/b&gt;');
  });

  it(`rate-limits successful sends per session (${REVIEW_SEND_LIMIT} per window)`, async () => {
    useSession('send-6');
    // Rejected requests do not spend the budget.
    await send('send-6', { recipientEmail: 'bad', assetUrl: IMAGE_URL }).expect(400);
    for (let i = 0; i < REVIEW_SEND_LIMIT; i++) {
      await send('send-6', { recipientEmail: 'lead@example.com', assetUrl: IMAGE_URL }).expect(200);
    }
    const res = await send('send-6', { recipientEmail: 'lead@example.com', assetUrl: IMAGE_URL }).expect(429);
    expect(res.body.error).toMatch(/Too many emails/);
    expect(mockedSend).toHaveBeenCalledTimes(REVIEW_SEND_LIMIT);

    // Another session has its own budget.
    useSession('send-7');
    await send('send-7', { recipientEmail: 'lead@example.com', assetUrl: IMAGE_URL }).expect(200);
  });
});

describe('buildResultDeliveryEmailHtml', () => {
  it('escapes the asset URL attribute and drops non-http(s) asset URLs', () => {
    const html = buildResultDeliveryEmailHtml({
      resultLabel: 'Plan',
      replyTo: 'r@example.com',
      assetUrl: 'https://s3.example.com/image"onerror="alert(1)',
    });
    expect(html).toContain('src="https://s3.example.com/image&quot;onerror=&quot;alert(1)"');

    const js = buildResultDeliveryEmailHtml({ resultLabel: 'Plan', replyTo: 'r@example.com', assetUrl: 'javascript:alert(1)' });
    expect(js).not.toContain('javascript:');
  });
});
