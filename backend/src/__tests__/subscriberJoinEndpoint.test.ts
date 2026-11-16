/**
 * POST /api/tasks/:taskId/subscribers/join: the public sign-up form on a customer's page (ENG-2991).
 *
 * It used to write a row for any task id, with no rate limit and no confirmation, and send a welcome email from the task owner's account to
 * whatever address was typed. It is now a double opt-in: the form only asks the address to confirm, and nothing is stored until the link in
 * that email is opened (see subscriberAccess.test.ts for the confirm link).
 */
import request from 'supertest';
import express from 'express';
import taskRoutes from '../routes/tasks';

// Mock the database services
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: jest.fn(),
  },
  subscriberDb: {
    addSubscriber: jest.fn(),
    getTaskSubscriberByEmail: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
}));

// Mock email service
jest.mock('../services/emailService', () => ({
  emailService: {
    sendSubscriberWelcomeEmail: jest.fn(),
    sendSubscriberConfirmationEmail: jest.fn(),
  },
}));

// Mock resend service
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));

import { taskDb, subscriberDb } from '../services/db';
import { emailService } from '../services/emailService';
import { readConfirmToken } from '../services/subscriberTokens';
import { resetJoinConfirmationLimits, reserveJoinConfirmation } from '../services/subscriberSignup';

const sendConfirmation = emailService.sendSubscriberConfirmationEmail as jest.Mock;

describe('Subscriber Join Endpoint', () => {
  let app: express.Application;
  let nextIp = 1;
  /** Each test gets its own client address, so the per-address limit is only hit on purpose. */
  const newIp = () => `203.0.113.${nextIp++}`;

  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    process.env.BACKEND_URL = 'https://api.example.test';
  });

  beforeEach(() => {
    app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/tasks', taskRoutes);
    jest.clearAllMocks();
    resetJoinConfirmationLimits();
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 'test-task-123', userId: 'user-123', name: 'Test Task' });
    (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue(undefined);
    sendConfirmation.mockResolvedValue(true);
  });

  describe('POST /api/tasks/:taskId/subscribers/join', () => {
    const taskId = 'test-task-123';
    const join = (email: unknown, ip = newIp(), origin = 'https://example.com') =>
      request(app).post(`/api/tasks/${taskId}/subscribers/join`).set('X-Forwarded-For', ip).set('Origin', origin).send(email === undefined ? {} : { email });

    it('asks the address to confirm and stores nothing yet', async () => {
      const email = 'confirm-me@example.com';
      const response = await join(email).expect(202);

      expect(response.body).toEqual({ message: 'Check your email to confirm your subscription.' });
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
      expect(emailService.sendSubscriberWelcomeEmail).not.toHaveBeenCalled();
      expect(sendConfirmation).toHaveBeenCalledTimes(1);
      const [to, task, confirmUrl] = sendConfirmation.mock.calls[0];
      expect(to).toBe(email);
      expect(task).toBe(taskId);
      expect(confirmUrl).toMatch(/^https:\/\/api\.example\.test\/api\/tasks\/test-task-123\/subscribers\/confirm\?token=/);
      // the link carries a signed claim for exactly this task and address
      const token = decodeURIComponent(confirmUrl.split('token=')[1]);
      const claim = readConfirmToken(token);
      expect(claim).toEqual({ taskId, email, issuedAtMs: expect.any(Number) });
      expect(Math.abs(Date.now() - claim!.issuedAtMs)).toBeLessThan(10_000);
    });

    it('should return 400 if email is missing', async () => {
      const response = await join(undefined).expect(400);

      expect(response.body.message).toBe('Email is required');
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it('should return 400 if email format is invalid', async () => {
      const response = await join('invalid-email').expect(400);

      expect(response.body.message).toBe('Invalid email format');
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it.each([
      ['a display name around an address', 'Evil<victim@example.com>'],
      ['a comma list', 'a@example.com,b@example.com'],
      ['a number', 42],
      ['an array', ['victim@example.com']],
      ['an object', { toString: 'x' }],
      ['an address over 254 characters', `${'a'.repeat(250)}@example.com`],
    ])('rejects %s with 400 and sends nothing', async (_name, email) => {
      const response = await join(email).expect(400);
      expect(response.body.message).toBe('Invalid email format');
      expect(taskDb.getTaskById).not.toHaveBeenCalled();
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it('turns away a 90 KB address quickly (the old pattern needed seconds for it, and far longer for the 50 MB the server accepts)', async () => {
      const started = Date.now();
      await join('a@' + '.'.repeat(90_000) + ' ').expect(400);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('returns 404 for a task that does not exist, and sends nothing', async () => {
      (taskDb.getTaskById as jest.Mock).mockResolvedValue(undefined);

      const response = await join('nobody@example.com').expect(404);

      expect(response.body.message).toBe('Task not found');
      expect(sendConfirmation).not.toHaveBeenCalled();
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
    });

    it('answers an address that is already subscribed exactly like a new one, and sends nothing (no way to probe who subscribes)', async () => {
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ email: 'already@example.com', unsubscribed: false });

      const response = await join('already@example.com').expect(202);

      expect(response.body).toEqual({ message: 'Check your email to confirm your subscription.' });
      expect(sendConfirmation).not.toHaveBeenCalled();
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
    });

    it('asks an address that opted out earlier to confirm again, and still does not subscribe it', async () => {
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockResolvedValue({ email: 'back@example.com', unsubscribed: true });

      await join('back@example.com').expect(202);

      expect(sendConfirmation).toHaveBeenCalledTimes(1);
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
    });

    it('sends one confirmation per task and address per 30 minutes, with the same answer every time', async () => {
      const email = 'cooldown@example.com';
      const first = await join(email).expect(202);
      const second = await join(email).expect(202);

      expect(second.body).toEqual(first.body);
      expect(sendConfirmation).toHaveBeenCalledTimes(1);
    });

    it('counts plus-addresses of one mailbox as one address, for one task and across tasks', async () => {
      await join('victim@example.com').expect(202);
      await join('victim+2@example.com').expect(202);
      await join('Victim+3@Example.com').expect(202);
      expect(sendConfirmation).toHaveBeenCalledTimes(1);

      // another task, same mailbox: allowed until the mailbox has had 5 in an hour
      const otherTask = (n: number) => request(app).post(`/api/tasks/other-task-${n}/subscribers/join`).set('X-Forwarded-For', newIp()).send({ email: `victim+t${n}@example.com` });
      for (let n = 1; n <= 4; n++) await otherTask(n).expect(202);
      expect(sendConfirmation).toHaveBeenCalledTimes(5);
      await otherTask(5).expect(202);
      expect(sendConfirmation).toHaveBeenCalledTimes(5); // the sixth for this mailbox is silently not sent
    });

    it('says so (429) when the whole form is getting more sign-ups than it will send mail for, instead of silently sending nothing', async () => {
      for (let i = 0; i < 300; i++) reserveJoinConfirmation(taskId, `earlier${i}@example.com`, 'user-123'); // the form's hourly allowance is used up
      const response = await join('late@example.com').expect(429);
      expect(response.body.message).toMatch(/try again/i);
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it('answers a limit on the address itself exactly like a normal sign-up, so the form cannot be used to probe', async () => {
      reserveJoinConfirmation(taskId, 'target@example.com', 'user-123'); // a confirmation to this address went out a moment ago
      const response = await join('target@example.com').expect(202);
      expect(response.body).toEqual({ message: 'Check your email to confirm your subscription.' });
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it('gives the person their slot back when the confirmation email could not be sent, so they can try again at once', async () => {
      sendConfirmation.mockResolvedValueOnce(false);
      await join('retry@example.com').expect(202);
      await new Promise((resolve) => setImmediate(resolve));
      await join('retry@example.com').expect(202);
      expect(sendConfirmation).toHaveBeenCalledTimes(2);
    });

    it('finds an existing row stored in lower case when the address is typed in mixed case', async () => {
      (subscriberDb.getTaskSubscriberByEmail as jest.Mock).mockImplementation(async (_t: string, e: string) =>
        e === 'jane@example.com' ? { email: e, unsubscribed: false } : undefined);
      await join('Jane@Example.com').expect(202);
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it('treats the same address in a different case as the same address', async () => {
      await join('Mixed.Case@Example.com').expect(202);
      await join('mixed.case@example.com').expect(202);

      expect(sendConfirmation).toHaveBeenCalledTimes(1);
    });

    it('should allow requests from any origin (CORS)', async () => {
      const response = await join('cors@example.com', newIp(), 'https://any-external-site.com').expect(202);

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('still answers 202 when the confirmation email fails to send', async () => {
      sendConfirmation.mockRejectedValue(new Error('Email send failed'));

      await join('flaky@example.com').expect(202);
    });

    it('limits one connection to 10 sign-up attempts an hour', async () => {
      const ip = newIp();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await join(`bulk${i}@example.com`, ip)).status);
      }

      expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      expect(sendConfirmation).toHaveBeenCalledTimes(10);
    });
  });
});
