/**
 * ENG-2990 and ENG-2991: the task subscriber routes that anyone on the internet, or any signed-in user, used to be able to abuse.
 *  - GET /:taskId/subscribers: needs a login, but handed any signed-in user every subscriber record (emails, imported fields, email history)
 *    of any task. Now the task's owner or an admin only. (Runs through the real login middleware.)
 *  - GET + POST /:taskId/subscribers/confirm: the link in the confirmation email. GET only shows a button (mail scanners open links), the
 *    POST subscribes. A link sent before the person unsubscribed no longer works.
 *  - POST /:taskId/unsubscribe and /resubscribe: the undo needs the token the unsubscribe call returned. The token goes only to the call that
 *    really flips the row (one atomic update), is tied to that opt-out and to the address exactly as stored, and so cannot be replayed.
 *  - GET /:taskId/subscribers/:email/status: public, returns only whether the address is subscribed.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import taskRoutes from '../routes/tasks';

jest.mock('../services/db', () => ({
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: {
    addSubscriber: jest.fn(),
    getTaskSubscriberByEmail: jest.fn(),
    getTaskSubscribers: jest.fn(),
    getTaskSubscriberStates: jest.fn(),
    softUnsubscribe: jest.fn(),
    refreshOptOut: jest.fn(),
    resubscribe: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/emailService', () => ({
  emailService: { sendSubscriberWelcomeEmail: jest.fn(), sendSubscriberConfirmationEmail: jest.fn() },
}));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));

import { taskDb, subscriberDb, userDb } from '../services/db';
import { emailService } from '../services/emailService';
import { signConfirmToken, signResubscribeToken, readResubscribeToken, subscriberTokenKey } from '../services/subscriberTokens';
import { clearSubscriberLookups } from '../services/subscriberLookup';

const TASK = 'task-1';
const EMAIL = 'reader@example.com';
const UNSUB_AT = '2026-02-01T00:00:00.000Z';
const NONCE = 'nonce-of-the-persons-opt-out';
const subscribed = { taskId: TASK, email: EMAIL, subscribedAt: '2026-01-01T00:00:00Z', unsubscribed: false, feedback: 'private note', customFields: { phone: '555' } };
const optedOut = { ...subscribed, unsubscribed: true, unsubscribedAt: UNSUB_AT, optOutNonce: NONCE };

let app: express.Application;
let nextClient = 1;
/** A POST from its own client address, so the per-connection limit on these routes is never what a test trips over. */
const post = (path: string) => request(app).post(path).set('X-Forwarded-For', `198.51.100.${(nextClient++ % 250) + 1}`);
/** A real login token for a user the mocked database knows (the real middleware verifies it and looks the user up). */
const login = (userId: string) => `Bearer ${jwt.sign({ userId, email: `${userId}@example.com` }, process.env.JWT_SECRET!)}`;
/** A subscriber token with any claims and any age. */
const mint = (payload: object, options: jwt.SignOptions = { expiresIn: '1h' }, key: jwt.Secret = subscriberTokenKey()) => jwt.sign(payload, key, options);

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  clearSubscriberLookups();
  app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/tasks', taskRoutes);
  (taskDb.getTaskById as jest.Mock).mockImplementation(async (id: string) => (id === TASK ? { taskId: TASK, userId: 'owner', name: 'Weekly Report' } : undefined));
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) =>
    ['owner', 'stranger', 'teammate', 'root'].includes(id) ? { userId: id, email: `${id}@example.com`, isAdmin: id === 'root' } : undefined);
  (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(undefined);
  (subscriberDb.addSubscriber as jest.Mock).mockResolvedValue({ taskId: TASK, email: EMAIL });
  (subscriberDb.getTaskSubscribers as jest.Mock).mockResolvedValue([subscribed]);
  (subscriberDb.getTaskSubscriberStates as jest.Mock).mockResolvedValue([]);
  (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue({ ...optedOut });
  (subscriberDb.refreshOptOut as jest.Mock).mockResolvedValue(true);
  (subscriberDb.resubscribe as jest.Mock).mockResolvedValue({ ...subscribed });
  (emailService.sendSubscriberWelcomeEmail as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/tasks/:taskId/subscribers (ENG-2990)', () => {
  it('needs a login', async () => {
    await request(app).get(`/api/tasks/${TASK}/subscribers`).expect(401);
    expect(subscriberDb.getTaskSubscribers).not.toHaveBeenCalled();
  });

  it('refuses a token that is not a login token', async () => {
    const forged = jwt.sign({ userId: 'owner' }, 'some-other-secret');
    await request(app).get(`/api/tasks/${TASK}/subscribers`).set('Authorization', `Bearer ${forged}`).expect(401);
    const subscriberLink = signResubscribeToken(TASK, EMAIL, NONCE);
    await request(app).get(`/api/tasks/${TASK}/subscribers`).set('Authorization', `Bearer ${subscriberLink}`).expect(401);
    expect(subscriberDb.getTaskSubscribers).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user who does not own the task, without reading the list', async () => {
    for (const who of ['stranger', 'teammate']) {
      const res = await request(app).get(`/api/tasks/${TASK}/subscribers`).set('Authorization', login(who)).expect(403);
      expect(res.body).toEqual({ message: 'Access denied' });
    }
    expect(subscriberDb.getTaskSubscribers).not.toHaveBeenCalled();
  });

  it('returns the list to the task owner and to an admin', async () => {
    const owner = await request(app).get(`/api/tasks/${TASK}/subscribers`).set('Authorization', login('owner')).expect(200);
    const admin = await request(app).get(`/api/tasks/${TASK}/subscribers`).set('Authorization', login('root')).expect(200);
    expect(owner.body).toEqual([subscribed]);
    expect(admin.body).toEqual([subscribed]);
  });

  it('answers 404 for a task that does not exist', async () => {
    await request(app).get('/api/tasks/ghost/subscribers').set('Authorization', login('owner')).expect(404);
  });
});

describe('public routes that do not repeat a database message', () => {
  it('status, task name', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockRejectedValue(new Error('Type mismatch for key email expected: S actual: M'));
    const status = await request(app).get(`/api/tasks/${TASK}/subscribers/${EMAIL}/status`).expect(500);
    expect(JSON.stringify(status.body)).not.toContain('mismatch');
    (taskDb.getTaskById as jest.Mock).mockRejectedValue(new Error('ProvisionedThroughputExceededException: table AW-Tasks'));
    const name = await request(app).get(`/api/tasks/${TASK}/name`).expect(500);
    expect(JSON.stringify(name.body)).not.toContain('AW-Tasks');
  });
});

describe('GET /api/tasks/:taskId/subscribers/:email/status (public)', () => {
  it('returns only the address and whether it is subscribed, never the feedback, dates or imported fields', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
    const res = await request(app).get(`/api/tasks/${TASK}/subscribers/${EMAIL}/status`).expect(200);
    expect(res.body).toEqual({ email: EMAIL, unsubscribed: false });
  });

  it('reports an unsubscribed address', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    const res = await request(app).get(`/api/tasks/${TASK}/subscribers/${EMAIL}/status`).expect(200);
    expect(res.body).toEqual({ email: EMAIL, unsubscribed: true });
  });
});

describe('POST /api/tasks/:taskId/unsubscribe (public)', () => {
  it('unsubscribes an active address in one conditional update and hands back an undo token tied to that opt-out', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
    const res = await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL, feedback: 'too many' }).expect(200);
    expect(subscriberDb.softUnsubscribe).toHaveBeenCalledWith(TASK, EMAIL, 'too many', { onlyIfActive: true });
    expect(readResubscribeToken(res.body.resubscribeToken)).toEqual({ taskId: TASK, email: EMAIL, optOutNonce: NONCE });
  });

  it('hands out NO token when the row was already opted out (the conditional update does not apply)', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue(null);
    const res = await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(200);
    expect(res.body).toEqual({ message: 'Already unsubscribed' });
    // ...and the opt-out gets a new nonce, which voids any undo token someone obtained for the earlier one
    expect(subscriberDb.refreshOptOut).toHaveBeenCalledWith(TASK, EMAIL);
  });

  it('a repeat call for an opted-out address never moves the opt-out time (it is the record, and the confirmation-link rule depends on it)', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue(null);
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(200);
    // the only write besides the refused conditional update is the nonce refresh, which takes no time argument at all
    expect((subscriberDb.refreshOptOut as jest.Mock).mock.calls[0]).toEqual([TASK, EMAIL]);
  });

  it('if the refresh finds the row put back to subscribed in between, the person who clicked Unsubscribe is unsubscribed after all (and gets the undo token)', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...optedOut });
    (subscriberDb.refreshOptOut as jest.Mock).mockResolvedValue(false);
    const res = await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(200);
    expect(subscriberDb.softUnsubscribe).toHaveBeenCalledTimes(2);
    expect(readResubscribeToken(res.body.resubscribeToken)).toMatchObject({ optOutNonce: NONCE });
  });

  it('a failed refresh is not answered "done" (the earlier undo token would stay alive): it asks to try again, and logs nothing but a code', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue(null);
    (subscriberDb.refreshOptOut as jest.Mock).mockRejectedValue(Object.assign(new Error(`table AW-Subscribers key ${EMAIL}`), { code: 'ThrottlingException' }));
    const res = await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(503);
    expect(JSON.stringify(res.body)).not.toContain('AW-Subscribers');
    const logged = (console.error as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('ThrottlingException');
    expect(logged).not.toContain(EMAIL);
  });

  it('answers 404, not "try again", when the owner removed the address between the first read and the writes', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValueOnce(subscribed).mockResolvedValue(undefined);
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue(null);
    (subscriberDb.refreshOptOut as jest.Mock).mockResolvedValue(false);
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(404);
    expect(subscriberDb.softUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps going while the row is flipped back and forth under it (up to three rounds), and then asks to try again rather than claiming it is done', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue(null);
    (subscriberDb.refreshOptOut as jest.Mock).mockResolvedValue(false);
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(503);
    expect(subscriberDb.softUnsubscribe).toHaveBeenCalledTimes(3);
    expect(subscriberDb.refreshOptOut).toHaveBeenCalledTimes(3);

    jest.clearAllMocks();
    // refused, row put back, refused again, then the flip lands: the caller gets its own token
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...optedOut });
    (subscriberDb.refreshOptOut as jest.Mock).mockResolvedValue(false);
    const res = await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(200);
    expect(readResubscribeToken(res.body.resubscribeToken)).toMatchObject({ optOutNonce: NONCE });
  });

  it('does not touch the opt-out time when the call itself flips the row', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(200);
    expect(subscriberDb.refreshOptOut).not.toHaveBeenCalled();
  });

  it('an attacker who unsubscribed an address first cannot undo the person\'s own later opt-out: the person\'s call voids the attacker\'s token', async () => {
    const attackersToken = signResubscribeToken(TASK, EMAIL, NONCE);
    // the person unsubscribes after the attacker did: the row is already opted out, so the call gives the opt-out a new nonce
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue(null);
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(200);
    expect(subscriberDb.refreshOptOut).toHaveBeenCalledTimes(1);
    // the row now carries a different nonce than the attacker's token names (and the same opt-out time as before)
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ ...optedOut, optOutNonce: 'a-new-nonce' });
    await post(`/api/tasks/${TASK}/resubscribe`).send({ email: EMAIL, token: attackersToken }).expect(403);
    expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
  });

  it('hands out NO token to a caller that lost a race: the read said "subscribed" but another request had already flipped the row', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed); // a stale read
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue(null); // the atomic update refused: it was already opted out
    const res = await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(200);
    expect(res.body.resubscribeToken).toBeUndefined();
  });

  it('answers 404 for an address that was never subscribed', async () => {
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(404);
    expect(subscriberDb.softUnsubscribe).not.toHaveBeenCalled();
  });

  it('the attack on an opted-out address fails end to end: unsubscribe again, then try to resubscribe', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    (subscriberDb.softUnsubscribe as jest.Mock).mockResolvedValue(null);
    const unsub = await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(200);
    const attempt = await post(`/api/tasks/${TASK}/resubscribe`).send({ email: EMAIL, token: unsub.body.resubscribeToken }).expect(403);
    expect(attempt.body.message).toMatch(/expired/i);
    expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
  });

  it.each([['no address', {}], ['an array', { email: [EMAIL] }], ['an object', { email: { $ne: '' } }], ['a number', { email: 5 }], ['an address over 320 characters', { email: 'a'.repeat(321) }]])(
    'answers 400 for %s, without asking the database',
    async (_name, body) => {
      await post(`/api/tasks/${TASK}/unsubscribe`).send(body).expect(400);
      expect(subscriberDb.getTaskSubscriberByEmail).not.toHaveBeenCalled();
    },
  );

  it('stores feedback only when it is text, and not more than 2000 characters of it', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL, feedback: { not: 'text' } }).expect(200);
    expect(subscriberDb.softUnsubscribe).toHaveBeenLastCalledWith(TASK, EMAIL, undefined, { onlyIfActive: true });
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL, feedback: 'x'.repeat(5000) }).expect(200);
    expect((subscriberDb.softUnsubscribe as jest.Mock).mock.calls.at(-1)![2]).toHaveLength(2000);
  });

  it('cuts a long feedback note on whole characters (an emoji is not split in half)', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
    await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL, feedback: '😀'.repeat(2500) }).expect(200);
    const stored = (subscriberDb.softUnsubscribe as jest.Mock).mock.calls.at(-1)![2] as string;
    expect(Array.from(stored)).toHaveLength(2000);
    expect(stored.length).toBe(4000);
    expect(stored).toBe('😀'.repeat(2000)); // no lone surrogate at the cut
  });

  it('does not repeat a database error message to the visitor', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
    (subscriberDb.softUnsubscribe as jest.Mock).mockRejectedValue(new Error('ProvisionedThroughputExceededException: table AW-Subscribers'));
    const res = await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL }).expect(500);
    expect(JSON.stringify(res.body)).not.toContain('AW-Subscribers');
  });
});

describe('the per-connection limit on the confirm page and its button', () => {
  it('allows 300 an hour from one connection (a mail gateway opens every link it scans), then answers a plain page with 429 and reads nothing more', async () => {
    const getFromOneConnection = () => request(app).get(`/api/tasks/${TASK}/subscribers/confirm`).query({ token: 'nope' }).set('X-Forwarded-For', '203.0.113.201');
    for (let i = 0; i < 300; i++) expect((await getFromOneConnection()).status).toBe(400);
    (taskDb.getTaskById as jest.Mock).mockClear();
    const limited = await getFromOneConnection();
    expect(limited.status).toBe(429);
    expect(limited.type).toBe('text/html');
    expect(limited.text).toContain('Too many requests');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(limited.headers['referrer-policy']).toBe('same-origin');
    // the button's POST shares the same counter, and nothing was read for either
    const press = await request(app).post(`/api/tasks/${TASK}/subscribers/confirm`).type('form').send({ token: 'nope' }).set('X-Forwarded-For', '203.0.113.201');
    expect(press.status).toBe(429);
    expect(taskDb.getTaskById).not.toHaveBeenCalled();
    // another connection is unaffected
    expect((await request(app).get(`/api/tasks/${TASK}/subscribers/confirm`).query({ token: 'nope' }).set('X-Forwarded-For', '203.0.113.202')).status).toBe(400);
  });
});

describe('the per-connection limit on the public unsubscribe and undo calls', () => {
  it('allows 300 an hour from one connection (a shared office or campus address may hold many people), then answers 429 and writes nothing more', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(undefined);
    const fromOneConnection = () => request(app).post(`/api/tasks/${TASK}/unsubscribe`).set('X-Forwarded-For', '203.0.113.200').send({ email: EMAIL });
    for (let i = 0; i < 300; i++) expect((await fromOneConnection()).status).toBe(404);
    const limited = await fromOneConnection();
    expect(limited.status).toBe(429);
    expect(limited.body.message).toMatch(/too many/i);
    // another connection is unaffected
    expect((await post(`/api/tasks/${TASK}/unsubscribe`).send({ email: EMAIL })).status).toBe(404);
  });
});

describe('POST /api/tasks/:taskId/resubscribe (public)', () => {
  const resubscribe = (body: object) => post(`/api/tasks/${TASK}/resubscribe`).send(body);

  it('undoes the unsubscribe with the token for that opt-out', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    await resubscribe({ email: EMAIL, token: signResubscribeToken(TASK, EMAIL, NONCE) }).expect(200);
    // one atomic update that applies only while the row is still opted out by exactly that opt-out
    expect(subscriberDb.resubscribe).toHaveBeenCalledWith(TASK, EMAIL, { onlyIfOptOutNonce: NONCE });
  });

  it('refuses when the person opted out again between the check and the update (the conditional update does not apply)', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    (subscriberDb.resubscribe as jest.Mock).mockResolvedValue(null);
    const res = await resubscribe({ email: EMAIL, token: signResubscribeToken(TASK, EMAIL, NONCE) }).expect(403);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('refuses the same address in another letter case: rows are case-sensitive, so the token names one row exactly', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockImplementation(async (_t: string, e: string) => (e === 'Reader@Example.com' ? { ...optedOut, email: e } : e === EMAIL ? subscribed : undefined));
    const tokenForTheActiveRow = signResubscribeToken(TASK, EMAIL, NONCE);
    await resubscribe({ email: 'Reader@Example.com', token: tokenForTheActiveRow }).expect(403);
    expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
  });

  it('refuses a replay: once the person has opted out again, the old undo token no longer matches that row', async () => {
    const oldToken = signResubscribeToken(TASK, EMAIL, NONCE);
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ ...optedOut, optOutNonce: 'nonce-of-a-newer-opt-out' });
    const res = await resubscribe({ email: EMAIL, token: oldToken }).expect(403);
    expect(res.body.message).toMatch(/expired/i);
    expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
  });

  it('refuses a token when the address has already been put back (the opt-out it undoes is over)', async () => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ ...subscribed, resubscribedAt: '2026-02-02T00:00:00Z' });
    await resubscribe({ email: EMAIL, token: signResubscribeToken(TASK, EMAIL, NONCE) }).expect(403);
    expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
  });

  it('answers 404 when the row is gone', async () => {
    await resubscribe({ email: EMAIL, token: signResubscribeToken(TASK, EMAIL, NONCE) }).expect(404);
  });

  it.each([
    ['no token', () => undefined],
    ['an empty token', () => ''],
    ['garbage', () => 'not-a-token'],
    ['a token for another address', () => signResubscribeToken(TASK, 'someone.else@example.com', NONCE)],
    ['a token for another task', () => signResubscribeToken('task-2', EMAIL, NONCE)],
    ['a confirm-subscription token', () => signConfirmToken(TASK, EMAIL)],
    ['an expired token', () => mint({ purpose: 'resubscribe', taskId: TASK, email: EMAIL, optOutNonce: NONCE }, { expiresIn: -10 })],
    ['a token signed with the login secret', () => mint({ purpose: 'resubscribe', taskId: TASK, email: EMAIL, optOutNonce: NONCE }, { expiresIn: '1h' }, process.env.JWT_SECRET!)],
    ['an unsigned token', () => jwt.sign({ purpose: 'resubscribe', taskId: TASK, email: EMAIL, optOutNonce: NONCE }, '', { algorithm: 'none' as any })],
    ['a token that names no opt-out', () => mint({ purpose: 'resubscribe', taskId: TASK, email: EMAIL })],
    ['a non-string token', () => ({ nested: 'object' }) as any],
  ])('refuses to resubscribe with %s, and changes nothing', async (_name, makeToken) => {
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(optedOut);
    const res = await resubscribe({ email: EMAIL, token: makeToken() }).expect(403);
    expect(res.body.message).toMatch(/expired/i);
    expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
  });

  it('keeps asking for the email first', async () => {
    await resubscribe({}).expect(400);
    await resubscribe({ email: [EMAIL], token: 'x' }).expect(400);
  });
});

describe('the confirmation link (public)', () => {
  const confirmUrl = `/api/tasks/${TASK}/subscribers/confirm`;
  const good = () => signConfirmToken(TASK, EMAIL);
  const getPage = (token?: string, taskId = TASK) =>
    request(app).get(`/api/tasks/${taskId}/subscribers/confirm`).query(token === undefined ? {} : { token });
  const confirm = (token?: string, taskId = TASK) =>
    request(app).post(`/api/tasks/${taskId}/subscribers/confirm`).type('form').send(token === undefined ? {} : { token });

  describe('GET (what a mail scanner or a link preview does)', () => {
    it('only shows a confirm button, and changes nothing', async () => {
      const res = await getPage(good()).expect(200);
      expect(res.type).toBe('text/html');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex');
      expect(res.text).toContain('Confirm your subscription');
      expect(res.text).toContain('Weekly Report');
      expect(res.text).toContain(`<form method="post" action="${confirmUrl}"`);
      expect(res.text).toContain('name="token"');
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
      expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
      expect(emailService.sendSubscriberWelcomeEmail).not.toHaveBeenCalled();
    });

    it('does not change anything for a HEAD request either', async () => {
      await request(app).head(`${confirmUrl}?token=${encodeURIComponent(good())}`).expect(200);
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
    });

    it('shows the expired-link page for a bad link', async () => {
      const res = await getPage('nope').expect(400);
      expect(res.text).toContain('expired');
      expect(res.text).not.toContain('<form');
    });
  });

  describe('POST (the button)', () => {
    it('subscribes the address and sends the welcome email', async () => {
      const res = await confirm(good()).expect(200);
      expect(res.type).toBe('text/html');
      expect(res.text).toContain('You&#39;re subscribed'); // the page escapes the apostrophe
      expect(res.text).toContain('Weekly Report');
      expect(subscriberDb.addSubscriber).toHaveBeenCalledWith(TASK, EMAIL);
      expect(emailService.sendSubscriberWelcomeEmail).toHaveBeenCalledWith(EMAIL, TASK);
    });

    it('pressing it twice does not subscribe or email twice', async () => {
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(subscribed);
      await confirm(good()).expect(200);
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
      expect(emailService.sendSubscriberWelcomeEmail).not.toHaveBeenCalled();
    });

    it('treats a race with another confirmation as success without a second welcome email', async () => {
      (subscriberDb.addSubscriber as jest.Mock).mockRejectedValue(new Error(`Email ${EMAIL} is already in the subscriber list for this task`));
      await confirm(good()).expect(200);
      expect(emailService.sendSubscriberWelcomeEmail).not.toHaveBeenCalled();
    });

    // the stored row is Reader@Example.com; the link carries reader@example.com
    const storedSpelling = (row: object) => {
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockImplementation(async (_t: string, e: string) => (e === 'Reader@Example.com' ? { ...subscribed, email: e, ...row } : undefined));
      (subscriberDb.getTaskSubscriberStates as jest.Mock).mockResolvedValue([{ email: 'Reader@Example.com', unsubscribed: false }]);
    };

    it('finds an address stored in another letter case and does not add it a second time (no duplicate emails to one person)', async () => {
      storedSpelling({});
      await confirm(good()).expect(200);
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
      expect(emailService.sendSubscriberWelcomeEmail).not.toHaveBeenCalled();
    });

    it('turns an opted-out address back on, under its stored spelling, when the person asked again after opting out', async () => {
      storedSpelling({ unsubscribed: true, unsubscribedAt: new Date(Date.now() - 60_000).toISOString() });
      await confirm(good()).expect(200);
      expect(subscriberDb.resubscribe).toHaveBeenCalledWith(TASK, 'Reader@Example.com', { onlyIfUnsubscribedAt: expect.any(String) });
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
      expect(emailService.sendSubscriberWelcomeEmail).toHaveBeenCalledWith('Reader@Example.com', TASK);
    });

    it('decides from a fresh read of the matching row, not from the cached address list', async () => {
      // the cached list still says "subscribed" but the row was opted out a minute ago and the link is older than that
      (subscriberDb.getTaskSubscriberStates as jest.Mock).mockResolvedValue([{ email: 'Reader@Example.com', unsubscribed: false }]);
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockImplementation(async (_t: string, e: string) =>
        e === 'Reader@Example.com' ? { ...optedOut, email: e, unsubscribedAt: new Date(Date.now() - 60_000).toISOString() } : undefined);
      const sentLongAgo = mint({ purpose: 'confirm-subscribe', taskId: TASK, email: EMAIL, iat: Math.floor(Date.now() / 1000) - 3600 }, { expiresIn: '48h' });
      await confirm(sentLongAgo).expect(400);
      expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
    });

    it('reads the address list once for a burst of simultaneous confirmations of one new address (it cannot be used to make the server re-read a large list)', async () => {
      // like the real table: the first insert wins, the others are told the address is already there, and later reads find the row
      let added = false;
      (subscriberDb.addSubscriber as jest.Mock).mockImplementation(async () => {
        if (added) throw new Error(`Email ${EMAIL} is already in the subscriber list for this task`);
        added = true;
        return { taskId: TASK, email: EMAIL };
      });
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockImplementation(async () => (added ? subscribed : undefined));
      const answers = await Promise.all(Array.from({ length: 12 }, () => confirm(good())));
      expect(answers.every((r) => r.status === 200)).toBe(true);
      expect((subscriberDb.getTaskSubscriberStates as jest.Mock).mock.calls.length).toBeLessThanOrEqual(2);
      expect((subscriberDb.getTaskSubscriberStates as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(emailService.sendSubscriberWelcomeEmail).toHaveBeenCalledTimes(1);
    });

    it('a new subscriber is on the next caller\'s list straight away (the cached list is dropped after a change)', async () => {
      await confirm(good()).expect(200); // adds the address, so the cached list is forgotten
      await confirm(signConfirmToken(TASK, 'another@example.com')).expect(200);
      expect(subscriberDb.getTaskSubscriberStates).toHaveBeenCalledTimes(2);
    });

    it('turns an opted-out address back on when the link was sent after the opt-out', async () => {
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ ...optedOut, unsubscribedAt: new Date(Date.now() - 60_000).toISOString() });
      await confirm(good()).expect(200);
      // one atomic update that applies only while the row is still opted out at the very time that was just checked
      const optedOutRow = await (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mock.results[0].value;
      expect(subscriberDb.resubscribe).toHaveBeenCalledWith(TASK, EMAIL, { onlyIfUnsubscribedAt: optedOutRow.unsubscribedAt });
      expect(emailService.sendSubscriberWelcomeEmail).toHaveBeenCalledTimes(1);
    });

    it('does not turn mail back on when the person opted out again between the check and the write (the conditional update is refused)', async () => {
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ ...optedOut, unsubscribedAt: new Date(Date.now() - 60_000).toISOString() });
      (subscriberDb.resubscribe as jest.Mock).mockResolvedValue(null);
      const res = await confirm(good()).expect(400);
      expect(res.text).toContain('no longer valid');
      expect(emailService.sendSubscriberWelcomeEmail).not.toHaveBeenCalled();
    });

    it('does NOT turn mail back on from a link that was sent before the person unsubscribed (a forwarded email or a rescan)', async () => {
      const sentLongAgo = mint({ purpose: 'confirm-subscribe', taskId: TASK, email: EMAIL, iat: Math.floor(Date.now() / 1000) - 3600 }, { expiresIn: '48h' });
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ ...optedOut, unsubscribedAt: new Date(Date.now() - 60_000).toISOString() });
      const res = await confirm(sentLongAgo).expect(400);
      expect(res.text).toContain('no longer valid');
      expect(res.text).toContain('sign-up form');
      expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
      expect(emailService.sendSubscriberWelcomeEmail).not.toHaveBeenCalled();
    });

    it('refuses when an opted-out row has no usable opt-out time (safe default)', async () => {
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ ...subscribed, unsubscribed: true });
      await confirm(good()).expect(400);
      expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
    });

    it.each([
      ['no token', () => undefined],
      ['garbage', () => 'nope'],
      ['an expired token', () => mint({ purpose: 'confirm-subscribe', taskId: TASK, email: EMAIL }, { expiresIn: -10 })],
      ['a resubscribe token', () => signResubscribeToken(TASK, EMAIL, NONCE)],
      ['a token for another task', () => signConfirmToken('task-2', EMAIL)],
      ['a token signed with the login secret', () => mint({ purpose: 'confirm-subscribe', taskId: TASK, email: EMAIL }, { expiresIn: '1h' }, process.env.JWT_SECRET!)],
    ])('shows an expired-link page for %s, and subscribes nobody', async (_name, makeToken) => {
      const res = await confirm(makeToken()).expect(400);
      expect(res.type).toBe('text/html');
      expect(res.text).toContain('expired');
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
      expect(subscriberDb.resubscribe).not.toHaveBeenCalled();
      expect(emailService.sendSubscriberWelcomeEmail).not.toHaveBeenCalled();
    });

    it('does not accept a link for a task that was deleted since', async () => {
      await confirm(signConfirmToken('gone', EMAIL), 'gone').expect(400);
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
    });

    it('escapes the task name on the page', async () => {
      (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: TASK, userId: 'owner', name: '<script>alert(1)</script>' });
      const res = await confirm(good()).expect(200);
      expect(res.text).not.toContain('<script>alert(1)</script>');
      expect(res.text).toContain('&lt;script&gt;');
    });

    it('shows a retry page if saving fails, without the database message', async () => {
      (subscriberDb.addSubscriber as jest.Mock).mockRejectedValue(new Error('dynamo down'));
      const res = await confirm(good()).expect(500);
      expect(res.type).toBe('text/html');
      expect(res.text).not.toContain('dynamo');
    });
  });
});

describe('subscriber tokens and login tokens cannot be mixed up', () => {
  it('a subscriber token does not verify as a login token', () => {
    expect(() => jwt.verify(signResubscribeToken(TASK, EMAIL, NONCE), process.env.JWT_SECRET!)).toThrow();
    expect(() => jwt.verify(signConfirmToken(TASK, EMAIL), process.env.JWT_SECRET!)).toThrow();
  });
});
