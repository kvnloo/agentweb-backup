/**
 * ENG-2840 — two lanes in the shared email queue.
 *
 * Every platform email waits in ONE paced queue. One GTM report sends one email at a time, but when several senders overlap
 * (several reports at once, or later several outside agents over MCP) a password reset could wait behind all of their mail.
 * These tests pin the behaviour that prevents that: transactional mail is served first, bulk mail is bounded and never
 * starves, and a caller that says nothing behaves exactly as before.
 *
 * Every test holds one send "in flight" (the held first email) so the rest queue up, then releases it and reads the order
 * in which Resend was called. The pacing delay is set to 0 so the order is the only thing measured.
 */

export {};

const mockGetSecret = jest.fn();
const mockResendSend = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getSecret: (...args: any[]) => mockGetSecret(...args),
}));

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockResendSend },
  })),
}));

type Lane = 'transactional' | 'bulk';

const email = (subject: string, lane?: Lane | string) => ({
  from: 'sender@example.com',
  to: `${subject}@example.com`,
  subject,
  html: `<p>${subject}</p>`,
  ...(lane === undefined ? {} : { lane: lane as Lane }),
});

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('ENG-2840 — email lanes', () => {
  let order: string[];
  let release: () => void;

  async function load() {
    const mod = await import('../services/resendService');
    (mod.resendService as any).MIN_SEND_INTERVAL_MS = 0;
    (mod.resendService as any).BASE_DELAY = 1;
    return mod;
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetSecret.mockResolvedValue('test-resend-api-key');
    order = [];
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // the email called `hold` stays in flight until the test releases it; the others finish at once
    mockResendSend.mockImplementation(async (options: any) => {
      order.push(options.subject);
      if (options.subject === 'hold') await gate;
      return { data: { id: options.subject }, error: null };
    });
  });

  it('serves transactional mail before bulk mail that was queued earlier, and keeps first-in-first-out inside each lane', async () => {
    const { resendService } = await load();

    const sends = [
      resendService.sendEmail(email('hold')),
      resendService.sendEmail(email('bulk-1', 'bulk')),
      resendService.sendEmail(email('bulk-2', 'bulk')),
      resendService.sendEmail(email('txn-1')),
      resendService.sendEmail(email('txn-2', 'transactional')),
    ];
    await until(() => order.includes('hold'), 'the held send to start');
    release();
    await Promise.all(sends);

    expect(order).toEqual(['hold', 'txn-1', 'txn-2', 'bulk-1', 'bulk-2']);
  });

  it('a caller that names no lane is transactional: nothing changes for the existing callers', async () => {
    const { resendService } = await load();

    const sends = [
      resendService.sendEmail(email('hold')),
      resendService.sendEmail(email('bulk-1', 'bulk')),
      resendService.sendEmail(email('plain')), // no lane at all
    ];
    await until(() => order.includes('hold'), 'the held send to start');
    release();
    await Promise.all(sends);

    expect(order).toEqual(['hold', 'plain', 'bulk-1']);
  });

  it('a lane value that is not "bulk" is treated as transactional, never silently deprioritised', async () => {
    const { resendService } = await load();

    const sends = [
      resendService.sendEmail(email('hold')),
      resendService.sendEmail(email('bulk-1', 'bulk')),
      resendService.sendEmail(email('typo', 'urgent')),
    ];
    await until(() => order.includes('hold'), 'the held send to start');
    release();
    await Promise.all(sends);

    expect(order).toEqual(['hold', 'typo', 'bulk-1']);
  });

  describe('the bulk lane is bounded', () => {
    it('refuses at once when full: nothing is queued, nothing is sent, and the error says so', async () => {
      const { resendService, EmailQueueFullError } = await load();
      (resendService as any).BULK_QUEUE_LIMIT = 3;

      const held = resendService.sendEmail(email('hold'));
      const queued = [1, 2, 3].map((n) => resendService.sendEmail(email(`bulk-${n}`, 'bulk')));
      await until(() => order.includes('hold'), 'the held send to start');

      // rejects while the held send is STILL in flight: it did not wait for anything
      const refused = resendService.sendEmail(email('bulk-4', 'bulk'));
      await expect(refused).rejects.toBeInstanceOf(EmailQueueFullError);
      await expect(refused).rejects.toMatchObject({
        name: 'EmailQueueFullError',
        code: 'EMAIL_QUEUE_FULL',
        lane: 'bulk',
        limit: 3,
      });
      await expect(refused).rejects.toThrow(/Nothing was sent/);
      expect((resendService as any).bulkQueue).toHaveLength(3);

      release();
      await Promise.all([held, ...queued]);
      expect(order).toEqual(['hold', 'bulk-1', 'bulk-2', 'bulk-3']); // bulk-4 never reached Resend
    });

    it('the lane accepts mail again once it has drained', async () => {
      const { resendService } = await load();
      (resendService as any).BULK_QUEUE_LIMIT = 2;

      const held = resendService.sendEmail(email('hold'));
      const queued = [1, 2].map((n) => resendService.sendEmail(email(`bulk-${n}`, 'bulk')));
      await until(() => order.includes('hold'), 'the held send to start');
      await expect(resendService.sendEmail(email('bulk-3', 'bulk'))).rejects.toMatchObject({ code: 'EMAIL_QUEUE_FULL' });

      release();
      await Promise.all([held, ...queued]);
      await expect(resendService.sendEmail(email('bulk-5', 'bulk'))).resolves.toEqual({ id: 'bulk-5' });
    });

    it('a full bulk lane never refuses transactional mail', async () => {
      const { resendService } = await load();
      (resendService as any).BULK_QUEUE_LIMIT = 1;

      const held = resendService.sendEmail(email('hold'));
      const bulk = resendService.sendEmail(email('bulk-1', 'bulk'));
      await until(() => order.includes('hold'), 'the held send to start');
      await expect(resendService.sendEmail(email('bulk-2', 'bulk'))).rejects.toMatchObject({ code: 'EMAIL_QUEUE_FULL' });
      const transactional = resendService.sendEmail(email('txn-1'));

      release();
      await Promise.all([held, bulk, transactional]);
      expect(order).toEqual(['hold', 'txn-1', 'bulk-1']);
    });

    it('the bound counts bulk mail only: a backlog of transactional mail never makes bulk mail fail', async () => {
      const { resendService } = await load();
      (resendService as any).BULK_QUEUE_LIMIT = 2;

      const held = resendService.sendEmail(email('hold'));
      await until(() => order.includes('hold'), 'the held send to start');
      const backlog = [1, 2, 3].map((n) => resendService.sendEmail(email(`txn-${n}`))); // 3 waiting, more than the bulk limit
      const bulk = [1, 2].map((n) => resendService.sendEmail(email(`bulk-${n}`, 'bulk'))); // both accepted
      await expect(resendService.sendEmail(email('bulk-3', 'bulk'))).rejects.toMatchObject({ code: 'EMAIL_QUEUE_FULL' });

      release();
      await Promise.all([held, ...backlog, ...bulk]);
      expect(order).toEqual(['hold', 'txn-1', 'txn-2', 'txn-3', 'bulk-1', 'bulk-2']);
    });

    it('the limit is 100 waiting', async () => {
      const { resendService } = await load();
      expect((resendService as any).BULK_QUEUE_LIMIT).toBe(100);
    });
  });

  describe('bulk mail is never starved', () => {
    it('while bulk mail waits, every eleventh send is a bulk one, even under a steady stream of transactional mail', async () => {
      const { resendService } = await load();

      const sends = [resendService.sendEmail(email('hold'))];
      await until(() => order.includes('hold'), 'the held send to start'); // the worker is busy and both lanes are empty
      for (let n = 1; n <= 25; n++) sends.push(resendService.sendEmail(email(`t${n}`)));
      sends.push(resendService.sendEmail(email('b1', 'bulk')));
      sends.push(resendService.sendEmail(email('b2', 'bulk')));
      release();
      await Promise.all(sends);

      const t = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `t${from + i}`);
      expect(order).toEqual(['hold', ...t(1, 10), 'b1', ...t(11, 20), 'b2', ...t(21, 25)]);
    });

    it('with no transactional mail waiting, bulk mail goes straight out (the lane never idles the worker)', async () => {
      const { resendService } = await load();

      const sends = [resendService.sendEmail(email('hold')), resendService.sendEmail(email('b1', 'bulk')), resendService.sendEmail(email('b2', 'bulk'))];
      await until(() => order.includes('hold'), 'the held send to start');
      release();
      await Promise.all(sends);

      expect(order).toEqual(['hold', 'b1', 'b2']);
    });

    it('selection: a bulk email taken because no transactional mail waits starts the count again', async () => {
      const { resendService } = await load();
      const svc = resendService as any;
      const item = (id: string, lane: Lane) => ({ id, lane, params: {}, resolve: () => undefined, reject: () => undefined });

      svc.transactionalStreak = 7; // seven transactional sends were made while a bulk email waited
      svc.bulkQueue.push(item('b1', 'bulk'));
      expect(svc.takeNextQueued().id).toBe('b1'); // no transactional mail waits, so the bulk email goes
      expect(svc.transactionalStreak).toBe(0);

      for (let n = 1; n <= 12; n++) svc.sendQueue.push(item(`t${n}`, 'transactional'));
      svc.bulkQueue.push(item('b2', 'bulk'));
      const picked: string[] = [];
      for (let n = 0; n < 11; n++) picked.push(svc.takeNextQueued().id);
      expect(picked).toEqual([...Array.from({ length: 10 }, (_, i) => `t${i + 1}`), 'b2']); // a full ten, not three
    });

    it('selection: transactional sends made before any bulk mail was waiting do not let a late bulk email jump the queue', async () => {
      const { resendService } = await load();
      const svc = resendService as any;
      const item = (id: string, lane: Lane) => ({ id, lane, params: {}, resolve: () => undefined, reject: () => undefined });

      for (let n = 1; n <= 30; n++) svc.sendQueue.push(item(`t${n}`, 'transactional'));
      const picked: string[] = [];
      for (let n = 0; n < 12; n++) picked.push(svc.takeNextQueued().id); // 12 transactional sends, no bulk waiting
      expect(picked).toEqual(Array.from({ length: 12 }, (_, i) => `t${i + 1}`));
      expect(svc.transactionalStreak).toBe(0);

      svc.bulkQueue.push(item('late-bulk', 'bulk'));
      const next: string[] = [];
      for (let n = 0; n < 11; n++) next.push(svc.takeNextQueued().id);
      expect(next).toEqual([...Array.from({ length: 10 }, (_, i) => `t${i + 13}`), 'late-bulk']);
    });
  });

  describe('the pacing gap', () => {
    it('mail that arrives while the worker waits out the gap after a send goes ahead of bulk mail already waiting', async () => {
      const { resendService } = await load();
      (resendService as any).MIN_SEND_INTERVAL_MS = 80;

      const first = resendService.sendEmail(email('A'));
      const bulk = resendService.sendEmail(email('B', 'bulk'));
      await first; // A is sent; the worker now waits out the 80 ms gap before it chooses what to send next
      const late = resendService.sendEmail(email('T')); // arrives during the gap
      await Promise.all([bulk, late]);

      expect(order).toEqual(['A', 'T', 'B']);
    });
  });

  describe('failures', () => {
    it('a refused send rejects only its own caller and the worker carries on, in both lanes', async () => {
      const { resendService } = await load();
      mockResendSend.mockImplementation(async (options: any) => {
        order.push(options.subject);
        if (options.subject === 'hold') await new Promise<void>((resolve) => (release = resolve));
        if (options.subject === 'bad-bulk' || options.subject === 'bad-txn') {
          return { data: null, error: { statusCode: 422, message: 'invalid recipient' } };
        }
        return { data: { id: options.subject }, error: null };
      });

      const held = resendService.sendEmail(email('hold'));
      const badBulk = resendService.sendEmail(email('bad-bulk', 'bulk'));
      const badTxn = resendService.sendEmail(email('bad-txn'));
      const goodBulk = resendService.sendEmail(email('good-bulk', 'bulk'));
      const goodTxn = resendService.sendEmail(email('good-txn'));
      await until(() => order.includes('hold'), 'the held send to start');
      release();

      await expect(badBulk).rejects.toThrow(/invalid recipient/);
      await expect(badTxn).rejects.toThrow(/invalid recipient/);
      await expect(Promise.all([held, goodBulk, goodTxn])).resolves.toEqual([{ id: 'hold' }, { id: 'good-bulk' }, { id: 'good-txn' }]);
      expect(order).toEqual(['hold', 'bad-txn', 'good-txn', 'bad-bulk', 'good-bulk']);
    });

    it('a retryable failure on bulk mail is retried and then delivered, as before', async () => {
      const { resendService } = await load();
      mockResendSend
        .mockResolvedValueOnce({ data: null, error: { statusCode: 500, message: 'temporary resend error' } })
        .mockResolvedValueOnce({ data: { id: 'recovered' }, error: null });

      await expect(resendService.sendEmail(email('retry-me', 'bulk'))).resolves.toEqual({ id: 'recovered' });
      expect(mockResendSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('where the lane travels', () => {
    it('the lane never reaches Resend', async () => {
      const { resendService } = await load();
      release();
      await resendService.sendEmail(email('plain-bulk', 'bulk'));
      expect(mockResendSend).toHaveBeenCalledTimes(1);
      expect(mockResendSend.mock.calls[0][0]).not.toHaveProperty('lane');
      expect(mockResendSend.mock.calls[0][0]).toMatchObject({ subject: 'plain-bulk', to: ['plain-bulk@example.com'] });
    });

    it('the queue log lines name the lane, the order number and the depth of both lanes (operators read them in CloudWatch)', async () => {
      const { resendService } = await load();
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      let lines: string[] = [];
      try {
        await resendService.sendEmail(email('first-bulk', 'bulk'));
        await resendService.sendEmail(email('second-plain'));
        lines = log.mock.calls.map((call) => String(call[0]));
      } finally {
        log.mockRestore();
      }

      expect(lines).toContain('Queued Resend email #1 (lane=bulk). Queue size: 0 transactional, 1 bulk');
      expect(lines).toContain('Processing Resend queue item #1 (lane=bulk) for: first-bulk@example.com (remaining: 0)');
      expect(lines).toContain('Queued Resend email #2 (lane=transactional). Queue size: 1 transactional, 0 bulk');
      expect(lines).toContain('Processing Resend queue item #2 (lane=transactional) for: second-plain@example.com (remaining: 0)');
    });

    it('the "remaining" count in the processing line includes both lanes', async () => {
      const { resendService } = await load();
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      let lines: string[] = [];
      try {
        const held = resendService.sendEmail(email('hold'));
        const bulk = resendService.sendEmail(email('bulk-1', 'bulk'));
        const transactional = resendService.sendEmail(email('txn-1'));
        await until(() => order.includes('hold'), 'the held send to start');
        release();
        await Promise.all([held, bulk, transactional]);
        lines = log.mock.calls.map((call) => String(call[0]));
      } finally {
        log.mockRestore();
      }

      // txn-1 is sent while bulk-1 still waits: one email remains, and it is in the OTHER lane
      expect(lines).toContain('Processing Resend queue item #3 (lane=transactional) for: txn-1@example.com (remaining: 1)');
      expect(lines).toContain('Processing Resend queue item #2 (lane=bulk) for: bulk-1@example.com (remaining: 0)');
    });

    it('sendSystemEmail passes the lane through, and passes nothing when no lane is given', async () => {
      const { resendService } = await load();
      const spy = jest.spyOn(resendService, 'sendEmail').mockResolvedValue({ id: 'x' } as any);

      await resendService.sendSystemEmail({ to: 'a@example.com', subject: 's', html: '<p>h</p>', lane: 'bulk' });
      await resendService.sendSystemEmail({ to: 'a@example.com', subject: 's', html: '<p>h</p>' });

      expect(spy.mock.calls[0][0]).toMatchObject({ lane: 'bulk' });
      expect(spy.mock.calls[1][0].lane).toBeUndefined();
    });

    it('the non-production guard keeps the lane when it drops some recipients and queues the rest', async () => {
      const { resendService } = await load();
      // example.com is on the default allowlist; the other address is not, so the guard drops it and queues a copy of the send
      const held = resendService.sendEmail(email('hold'));
      const guardedBulk = resendService.sendEmail({ ...email('guarded-bulk', 'bulk'), to: ['guarded-bulk@example.com', 'someone@real-customer.com'] });
      const transactional = resendService.sendEmail(email('txn-1'));
      await until(() => order.includes('hold'), 'the held send to start');
      release();
      await Promise.all([held, guardedBulk, transactional]);

      expect(order).toEqual(['hold', 'txn-1', 'guarded-bulk']); // still bulk after the guard rebuilt the send
      const guardedCall = mockResendSend.mock.calls.find(([options]) => options.subject === 'guarded-bulk');
      expect(guardedCall![0].to).toEqual(['guarded-bulk@example.com']);
    });
  });
});
