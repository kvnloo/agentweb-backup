/**
 * ENG-2782 S1 — public Slack-start intake API, end to end through Express.
 *
 *   GET   /api/onboarding/slack-start/config
 *   POST  /api/onboarding/slack-start                  {email, website, utm, captchaToken} + Idempotency-Key
 *   GET   /api/onboarding/slack-start/:intakeId         (resume)               Authorization: Bearer <intakeToken>
 *   PATCH /api/onboarding/slack-start/:intakeId         {answers, step}
 *   POST  /api/onboarding/slack-start/:intakeId/complete
 *
 * Every external effect (user, CRM lead, brand build, Slack Connect, captcha,
 * DNS) is an injected fake; the store is the in-memory mirror of the DynamoDB
 * conditions.
 */
import express from 'express';
import request from 'supertest';
import { createSlackStartRouter } from '../../routes/slackStart';
import { createSlackStartService, type SlackStartDeps } from '../../services/slackStart/slackStartService';
import { provisionOnboardingSlackConnect } from '../../services/slackConnectService';
import { createFakeSlackStartStore, type FakeSlackStartStore } from '../helpers/fakeSlackStartStore';

const BASE = '/api/onboarding/slack-start';
const KEY = 'idem-key-0123456789abcdef';
const KEY2 = 'idem-key-ffffffffffffffff';

let store: FakeSlackStartStore;
let users: Map<string, { userId: string; email: string; patches: Record<string, unknown>[] }>;
let deps: SlackStartDeps;
let leads: Array<Record<string, any>>;
let leadUpdates: Array<{ leadId: string; customFields: Record<string, unknown> }>;
let brandBuilds: string[];
let slackCalls: Array<Record<string, unknown>>;
let ids: number;

function makeDeps(overrides: Partial<SlackStartDeps> = {}): SlackStartDeps {
  return {
    store,
    verifyCaptcha: jest.fn(async (token: unknown) => (token === 'good-captcha' ? { ok: true as const } : { ok: false as const, reason: 'rejected' as const })),
    assertPublicWebsite: jest.fn(async (url: string) => {
      if (url.includes('internal-rebind')) throw new Error('private');
    }),
    findUserByEmail: jest.fn(async (email: string) => {
      for (const u of users.values()) if (u.email === email) return { userId: u.userId };
      return null;
    }),
    createUser: jest.fn(async ({ userId, email }: { userId: string; email: string }) => {
      await new Promise((r) => setImmediate(r));
      for (const u of users.values()) if (u.email === email) return 'exists' as const;
      users.set(userId, { userId, email, patches: [] });
      return 'created' as const;
    }),
    updateUser: jest.fn(async (userId: string, patch: Record<string, unknown>) => {
      users.get(userId)!.patches.push(patch);
    }),
    writeLead: jest.fn(async (lead: Record<string, any>) => {
      leads.push(lead);
      return { leadId: lead.leadId };
    }),
    updateLeadAnswers: jest.fn(async (leadId: string, customFields: Record<string, unknown>) => {
      leadUpdates.push({ leadId, customFields });
    }),
    triggerBrandBuild: jest.fn(async (userId: string) => {
      brandBuilds.push(userId);
    }),
    provisionSlackConnect: jest.fn(async (input: Record<string, unknown>) => {
      slackCalls.push(input);
      return { status: 'disabled' as const };
    }),
    tokenSecret: 'test-token-secret',
    now: () => new Date('2026-11-05T10:00:00.000Z'),
    randomId: () => `id-${++ids}`,
    rateLimits: { ipPerHour: 10, domainPerDay: 5 },
    allowedOrigins: ['https://www.hireemma.ai'],
    captchaPublic: { provider: 'turnstile', siteKey: 'site-key' },
    ...overrides,
  };
}

function app(d: SlackStartDeps = deps) {
  const a = express();
  a.set('trust proxy', true);
  a.use(express.json());
  a.use(BASE, createSlackStartRouter(createSlackStartService(d), d));
  return a;
}

const startBody = (over: Record<string, unknown> = {}) => ({
  email: 'sam@acme.co',
  website: 'acme.co',
  utm: { source: 'linkedin', campaign: 'launch' },
  captchaToken: 'good-captcha',
  ...over,
});

const start = (a = app(), body = startBody(), key: string | null = KEY, ip = '9.9.9.9') => {
  const r = request(a).post(BASE).set('X-Forwarded-For', ip).send(body);
  return key ? r.set('Idempotency-Key', key) : r;
};

async function started(a = app()) {
  const res = await start(a);
  expect(res.status).toBe(202);
  return { a, intakeId: res.body.intakeId as string, token: res.body.intakeToken as string };
}

const ALL_ANSWERS = { source: 'linkedin', role: 'founder', sector: ['saas'], tools: ['meta_ads', 'hubspot'], adSpend: '5k_20k' };

beforeEach(() => {
  store = createFakeSlackStartStore();
  users = new Map();
  leads = [];
  leadUpdates = [];
  brandBuilds = [];
  slackCalls = [];
  ids = 0;
  deps = makeDeps();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('GET /config', () => {
  it('returns the full wizard copy, options and the public captcha site key', async () => {
    const res = await request(app()).get(`${BASE}/config`);
    expect(res.status).toBe(200);
    expect(res.body.steps.map((s: any) => s.id)).toEqual(['start', 'source', 'role', 'sector', 'tools', 'adSpend']);
    expect(res.body.captcha).toEqual({ provider: 'turnstile', siteKey: 'site-key' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret/i);
  });
});

describe('CORS allowlist', () => {
  it('allows a listed origin without credentials and advertises the intake headers', async () => {
    const res = await request(app())
      .options(BASE)
      .set('Origin', 'https://www.hireemma.ai')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://www.hireemma.ai');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/);
    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/);
    expect(res.headers.vary).toMatch(/Origin/);
  });

  it('gives an unlisted origin no CORS grant', async () => {
    const res = await request(app()).options(BASE).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('POST / — start', () => {
  it('creates the intake, a user, and a CRM lead, and starts the brand build before any later answer', async () => {
    const res = await start();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ intakeId: expect.any(String), intakeToken: expect.any(String), status: 'open' });
    expect(res.body.intakeToken.length).toBeGreaterThanOrEqual(43);

    const intake = store.intakes.get(res.body.intakeId)!;
    expect(intake).toMatchObject({
      email: 'sam@acme.co',
      domain: 'acme.co',
      website: 'https://acme.co',
      utm: { source: 'linkedin', campaign: 'launch' },
      status: 'open',
      userCreatedAt: expect.any(String),
      leadWrittenAt: expect.any(String),
      brandBuildTriggeredAt: expect.any(String),
    });
    expect(intake.idempotencyKeyHash).not.toContain(KEY);

    expect(users.size).toBe(1);
    const user = users.get(intake.userId)!;
    expect(user.email).toBe('sam@acme.co');
    expect(user.patches[0]).toMatchObject({ companyUrl: 'https://acme.co', signupSource: 'slack_start', slackStartIntakeId: res.body.intakeId });

    expect(leads).toEqual([
      expect.objectContaining({ email: 'sam@acme.co', website: 'https://acme.co', domain: 'acme.co', intakeId: res.body.intakeId, utm: { source: 'linkedin', campaign: 'launch' } }),
    ]);
    expect(brandBuilds).toEqual([intake.userId]);
    expect(deps.verifyCaptcha).toHaveBeenCalledWith('good-captcha', '9.9.9.9');
  });

  it.each([
    [{ email: 'not-an-email' }, 'invalid_email'],
    [{ email: 'sam@gmail.com' }, 'personal_email'],
    [{ website: 'http://169.254.169.254' }, 'invalid_website'],
    [{ website: 'internal-rebind.acme.co' }, 'invalid_website'],
    [{ utm: 'nope' }, 'invalid_utm'],
  ])('rejects %p with 400 %s and creates nothing', async (over, code) => {
    const res = await start(app(), startBody(over));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(users.size).toBe(0);
    expect(store.intakes.size).toBe(0);
  });

  it('requires an Idempotency-Key so retries can be recognised', async () => {
    const res = await start(app(), startBody(), null);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('idempotency_key_required');
  });

  it('rejects a failed captcha with 403 and an unconfigured one with 503', async () => {
    const bad = await start(app(), startBody({ captchaToken: 'forged' }));
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('captcha_failed');

    const d = makeDeps({ verifyCaptcha: jest.fn(async () => ({ ok: false as const, reason: 'unconfigured' as const })) });
    const closed = await start(app(d));
    expect(closed.status).toBe(503);
    expect(closed.body.code).toBe('captcha_unavailable');
    expect(store.intakes.size).toBe(0);
  });

  it('rate limits starts per IP', async () => {
    const a = app(makeDeps({ rateLimits: { ipPerHour: 2, domainPerDay: 50 } }));
    expect((await start(a, startBody({ email: 'a@one.co', website: 'one.co' }), 'key-aaaaaaaaaaaaaaaa')).status).toBe(202);
    expect((await start(a, startBody({ email: 'a@two.co', website: 'two.co' }), 'key-bbbbbbbbbbbbbbbb')).status).toBe(202);
    const third = await start(a, startBody({ email: 'a@three.co', website: 'three.co' }), 'key-cccccccccccccccc');
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('rate_limited');
    const otherIp = await start(a, startBody({ email: 'a@three.co', website: 'three.co' }), 'key-cccccccccccccccc', '8.8.8.8');
    expect(otherIp.status).toBe(202);
  });

  it('rate limits starts per company domain across IPs', async () => {
    const a = app(makeDeps({ rateLimits: { ipPerHour: 50, domainPerDay: 1 } }));
    expect((await start(a)).status).toBe(202);
    const res = await start(a, startBody({ email: 'kim@acme.co' }), KEY2, '7.7.7.7');
    expect(res.status).toBe(429);
  });

  it('dedupes by company domain without leaking the existing intake capability', async () => {
    const a = app();
    const first = await start(a);
    const second = await start(a, startBody({ email: 'kim@acme.co', website: 'https://www.acme.co' }), KEY2, '7.7.7.7');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ code: 'domain_in_progress', message: expect.any(String) });
    expect(JSON.stringify(second.body)).not.toContain(first.body.intakeId);
    expect(JSON.stringify(second.body)).not.toContain(first.body.intakeToken);
    expect(users.size).toBe(1);
    expect(brandBuilds).toHaveLength(1);
  });

  it('replays the original response for a retry with the same Idempotency-Key without re-spending the captcha', async () => {
    const a = app();
    const first = await start(a);
    const retry = await start(a, startBody({ captchaToken: 'already-spent' }));
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual(first.body);
    expect(deps.verifyCaptcha).toHaveBeenCalledTimes(1);
    expect(users.size).toBe(1);
    expect(leads).toHaveLength(1);
    expect(brandBuilds).toHaveLength(1);
  });

  it('a replay must match the original email exactly — the key alone is not enough', async () => {
    const a = app();
    await start(a);
    const res = await start(a, startBody({ email: 'kim@acme.co' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('domain_in_progress');
  });

  it('resolves concurrent duplicate submissions to one intake and one user', async () => {
    const a = app();
    const [r1, r2] = await Promise.all([start(a), start(a)]);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    expect(r1.body.intakeId).toBe(r2.body.intakeId);
    expect(store.intakes.size).toBe(1);
    expect(users.size).toBe(1);
    expect(brandBuilds).toHaveLength(1);
  });

  it('never claims an existing account: same email → 409 account_exists and nothing is created', async () => {
    users.set('existing-user', { userId: 'existing-user', email: 'sam@acme.co', patches: [] });
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'account_exists', message: expect.any(String) });
    expect(store.intakes.size).toBe(0);
    expect(leads).toHaveLength(0);
    expect(brandBuilds).toHaveLength(0);
    expect(users.get('existing-user')!.patches).toHaveLength(0);
  });

  it('keeps the visitor moving when the CRM write fails, and records the failure on the intake', async () => {
    const d = makeDeps({ writeLead: jest.fn(async () => { throw new Error('crm down'); }) });
    const res = await start(app(d));
    expect(res.status).toBe(202);
    const intake = store.intakes.get(res.body.intakeId)!;
    expect(intake.leadWrittenAt).toBeUndefined();
    expect((intake as any).leadWriteError).toMatch(/crm down/);
    expect(brandBuilds).toHaveLength(1);
  });

  it('reports a retryable 503 when the account write fails, and the same-key retry finishes provisioning', async () => {
    let fail = true;
    const base = makeDeps();
    const d = makeDeps({
      createUser: jest.fn(async (input: any) => {
        if (fail) throw new Error('dynamo blip');
        return base.createUser(input);
      }),
    });
    const a = app(d);
    const first = await start(a);
    expect(first.status).toBe(503);
    expect(first.body.code).toBe('provisioning_failed');
    expect(brandBuilds).toHaveLength(0);
    fail = false;
    const retry = await start(a, startBody({ captchaToken: 'already-spent' }));
    expect(retry.status).toBe(202);
    expect(users.size).toBe(1);
    expect(brandBuilds).toHaveLength(1);
  });

  it('fails closed (503) when no token secret is configured', async () => {
    const res = await start(app(makeDeps({ tokenSecret: undefined })));
    expect(res.status).toBe(503);
    expect(store.intakes.size).toBe(0);
  });
});

describe('intake capability', () => {
  it.each([
    ['no token', undefined],
    ['wrong token', 'Bearer not-the-token'],
  ])('answers 404 with %s, identical to an unknown intake', async (_label, auth) => {
    const { a, intakeId } = await started();
    const r = request(a).patch(`${BASE}/${intakeId}`).send({ answers: { source: 'linkedin' }, step: 2 });
    const res = await (auth ? r.set('Authorization', auth) : r);
    expect(res.status).toBe(404);
    const unknown = await request(a).patch(`${BASE}/does-not-exist`).set('Authorization', 'Bearer x').send({ answers: { source: 'linkedin' } });
    expect(unknown.status).toBe(404);
    expect(res.body).toEqual(unknown.body);
  });

  it('a token for one intake does not open another', async () => {
    const a = app();
    const one = await start(a);
    const two = await start(a, startBody({ email: 'lee@beta.co', website: 'beta.co' }), KEY2);
    const res = await request(a).get(`${BASE}/${two.body.intakeId}`).set('Authorization', `Bearer ${one.body.intakeToken}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /:intakeId — answers', () => {
  it('persists an answer on the intake, the user and the CRM lead, with step progress', async () => {
    const { a, intakeId, token } = await started();
    const res = await request(a).patch(`${BASE}/${intakeId}`).set('Authorization', `Bearer ${token}`).send({ answers: { source: 'referral' }, step: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intakeId, answers: { source: 'referral' }, furthestStep: 2 });

    const intake = store.intakes.get(intakeId)!;
    expect(intake.answers).toEqual({ source: 'referral' });
    expect(intake.stepSavedAt.source).toBe('2026-11-05T10:00:00.000Z');
    expect(intake.lastStep).toBe(2);
    expect(users.get(intake.userId)!.patches.at(-1)).toEqual({ onboardingDiscoverySource: 'referral' });
    expect(leadUpdates.at(-1)).toEqual({ leadId: intake.leadId, customFields: { slackStartSource: 'referral' } });
  });

  it('is idempotent per step and keeps furthest progress when the visitor goes back', async () => {
    const { a, intakeId, token } = await started();
    const patch = (body: object) => request(a).patch(`${BASE}/${intakeId}`).set('Authorization', `Bearer ${token}`).send(body);
    await patch({ answers: { source: 'linkedin' }, step: 2 });
    await patch({ answers: { role: 'founder' }, step: 3 });
    const again = await patch({ answers: { source: 'linkedin' }, step: 2 });
    expect(again.status).toBe(200);
    const intake = store.intakes.get(intakeId)!;
    expect(intake.answers).toEqual({ source: 'linkedin', role: 'founder' });
    expect(intake.lastStep).toBe(2);
    expect(intake.furthestStep).toBe(3);
  });

  it.each([
    [{ answers: { source: 'myspace' } }, 'invalid_answer'],
    [{ answers: { sector: 'saas' } }, 'invalid_answer'],
    [{ answers: { tools: [] } }, 'invalid_answer'],
    [{ answers: { favouriteColour: 'blue' } }, 'invalid_answer'],
    [{ answers: {} }, 'invalid_answer'],
    [{ answers: { source: 'linkedin' }, step: 9 }, 'invalid_step'],
  ])('rejects %p', async (body, code) => {
    const { a, intakeId, token } = await started();
    const res = await request(a).patch(`${BASE}/${intakeId}`).set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(store.intakes.get(intakeId)!.answers).toEqual({});
  });

  it('GET /:intakeId returns saved answers so the widget can resume after a reload', async () => {
    const { a, intakeId, token } = await started();
    await request(a).patch(`${BASE}/${intakeId}`).set('Authorization', `Bearer ${token}`).send({ answers: { sector: ['saas', 'agency'] }, step: 4 });
    const res = await request(a).get(`${BASE}/${intakeId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ intakeId, status: 'open', answers: { sector: ['saas', 'agency'] }, furthestStep: 4, email: 'sam@acme.co', website: 'https://acme.co' });
  });
});

describe('POST /:intakeId/complete', () => {
  async function answered() {
    const s = await started();
    await request(s.a).patch(`${BASE}/${s.intakeId}`).set('Authorization', `Bearer ${s.token}`).send({ answers: ALL_ANSWERS, step: 6 });
    return s;
  }
  const complete = (a: express.Express, intakeId: string, token: string) =>
    request(a).post(`${BASE}/${intakeId}/complete`).set('Authorization', `Bearer ${token}`).send({});

  it('refuses to complete until every answer is saved', async () => {
    const { a, intakeId, token } = await started();
    const res = await complete(a, intakeId, token);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'missing_answers', missing: ['source', 'role', 'sector', 'tools', 'adSpend'] });
    expect(slackCalls).toHaveLength(0);
  });

  it('with the flag off, calls Slack Connect provisioning, stays inert and reports an honest pending state', async () => {
    const { a, intakeId, token } = await answered();
    const res = await complete(a, intakeId, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ intakeId, status: 'pending', slackConnectStatus: 'disabled' });
    const intake = store.intakes.get(intakeId)!;
    expect(slackCalls).toEqual([{ userId: intake.userId, companyEmail: 'sam@acme.co' }]);
    expect(intake).toMatchObject({ status: 'completed', completedAt: expect.any(String), slackConnectStatus: 'disabled', highBudget: true, franciscoAlertEligibleAt: expect.any(String) });
    expect(users.get(intake.userId)!.patches.at(-1)).toMatchObject({ slackStartCompletedAt: expect.any(String), slackStartHighBudget: true });
  });

  it('does not mark sub-$5k budgets for the Francisco alert', async () => {
    const { a, intakeId, token } = await started();
    await request(a).patch(`${BASE}/${intakeId}`).set('Authorization', `Bearer ${token}`).send({ answers: { ...ALL_ANSWERS, adSpend: '1k_5k' }, step: 6 });
    await complete(a, intakeId, token);
    const intake = store.intakes.get(intakeId)!;
    expect(intake.highBudget).toBe(false);
    expect(intake.franciscoAlertEligibleAt).toBeUndefined();
  });

  it('uses the real provisionOnboardingSlackConnect and it stays disabled while SLACK_CONNECT_ENABLED is unset', async () => {
    delete process.env.SLACK_CONNECT_ENABLED;
    const persisted: Array<Record<string, unknown>> = [];
    const client = { conversations: { create: jest.fn(), invite: jest.fn(), inviteShared: jest.fn() }, chat: { postMessage: jest.fn() } };
    deps = makeDeps({
      provisionSlackConnect: (input) => provisionOnboardingSlackConnect(input, { client: client as any, persist: async (_u, p) => { persisted.push(p); } }),
    });
    const { a, intakeId, token } = await answered();
    const res = await complete(a, intakeId, token);
    expect(res.body.slackConnectStatus).toBe('disabled');
    expect(client.conversations.create).not.toHaveBeenCalled();
    expect(client.conversations.inviteShared).not.toHaveBeenCalled();
    expect(persisted).toEqual([expect.objectContaining({ slackConnectStatus: 'disabled' })]);
  });

  it('retries provisioning on a later call (e.g. once the flag is on) and stops calling once a channel exists', async () => {
    const results = [{ status: 'disabled' as const }, { status: 'created' as const, channelId: 'C123' }];
    deps = makeDeps({ provisionSlackConnect: jest.fn(async (input: any) => { slackCalls.push(input); return results.shift()!; }) });
    const { a, intakeId, token } = await answered();
    expect((await complete(a, intakeId, token)).body.status).toBe('pending');
    const second = await complete(a, intakeId, token);
    expect(second.body).toEqual({ intakeId, status: 'invited', slackConnectStatus: 'created' });
    const third = await complete(a, intakeId, token);
    expect(third.body).toEqual(second.body);
    expect(slackCalls).toHaveLength(2);
    expect(store.intakes.get(intakeId)!.slackConnectChannelId).toBe('C123');
  });

  it('runs provisioning once for concurrent duplicate completes', async () => {
    deps = makeDeps({
      provisionSlackConnect: jest.fn(async (input: any) => {
        slackCalls.push(input);
        await new Promise((r) => setTimeout(r, 20));
        return { status: 'created' as const, channelId: 'C1' };
      }),
    });
    const { a, intakeId, token } = await answered();
    const [r1, r2] = await Promise.all([complete(a, intakeId, token), complete(a, intakeId, token)]);
    expect(slackCalls).toHaveLength(1);
    expect([r1.status, r2.status].sort()).toEqual([200, 202]);
    const loser = r1.status === 202 ? r1 : r2;
    expect(loser.body).toEqual({ intakeId, status: 'processing' });
  });

  it('reports provisioning failure as pending (never as invited)', async () => {
    deps = makeDeps({ provisionSlackConnect: jest.fn(async () => ({ status: 'failed' as const, reason: 'inviteShared failed' })) });
    const { a, intakeId, token } = await answered();
    const res = await complete(a, intakeId, token);
    expect(res.body).toEqual({ intakeId, status: 'pending', slackConnectStatus: 'failed' });
  });
});
