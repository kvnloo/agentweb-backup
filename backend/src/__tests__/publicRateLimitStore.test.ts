/**
 * ENG-2946: PublicRateLimitStore port (in-memory impl) + injection into the
 * lead-magnet router.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../services/db', () => ({
  taskDb: { createTaskExecution: jest.fn().mockResolvedValue({}), getTaskExecutionById: jest.fn() },
}));
jest.mock('../services/waitlistDb', () => ({
  waitlistDb: { add: jest.fn().mockResolvedValue({}) },
}));

import {
  InMemoryPublicRateLimitStore,
  emailRateLimitKey,
  ipRateLimitKey,
} from '../services/publicRateLimitStore';
import { createLeadMagnetRouter, globalExecutionTimestamps } from '../routes/leadMagnet';

const DAY = 24 * 60 * 60 * 1000;

describe('InMemoryPublicRateLimitStore', () => {
  it('enforces the cap atomically via consume', async () => {
    const store = new InMemoryPublicRateLimitStore();
    expect(await store.consume('k', 2, DAY)).toEqual({ allowed: true, count: 1 });
    expect(await store.consume('k', 2, DAY)).toEqual({ allowed: true, count: 2 });
    expect(await store.consume('k', 2, DAY)).toEqual({ allowed: false, count: 2 });
  });

  it('expires events after the window', async () => {
    let now = 1_000_000;
    const store = new InMemoryPublicRateLimitStore(() => now);
    await store.consume('k', 1, DAY);
    expect((await store.check('k', 1, DAY)).allowed).toBe(false);
    now += DAY - 1;
    expect((await store.check('k', 1, DAY)).allowed).toBe(false);
    now += 1;
    expect((await store.check('k', 1, DAY)).allowed).toBe(true);
    store.prune(DAY);
    expect(store.keys()).toEqual([]);
  });

  it('keeps keys independent', async () => {
    const store = new InMemoryPublicRateLimitStore();
    await store.consume('a', 1, DAY);
    expect((await store.consume('b', 1, DAY)).allowed).toBe(true);
    expect((await store.consume('a', 1, DAY)).allowed).toBe(false);
  });

  it('check does not mutate; record always counts', async () => {
    const store = new InMemoryPublicRateLimitStore();
    await store.check('k', 1, DAY);
    expect((await store.check('k', 1, DAY)).count).toBe(0);
    await store.record('k', DAY);
    await store.record('k', DAY);
    expect((await store.check('k', 5, DAY)).count).toBe(2);
  });

  it('email keys are hashed, case-insensitive, and contain no raw email', () => {
    const key = emailRateLimitKey('Alice.Smith@Example.com');
    expect(key).toBe(emailRateLimitKey('alice.smith@example.com'));
    expect(key).toMatch(/^email:[0-9a-f]{64}$/);
    expect(key.toLowerCase()).not.toContain('alice');
    expect(key.toLowerCase()).not.toContain('example');
    expect(ipRateLimitKey('1.2.3.4')).toBe('ip:1.2.3.4');
  });
});

describe('lead-magnet router with injected store', () => {
  beforeEach(() => {
    globalExecutionTimestamps.length = 0;
    delete process.env.LEAD_MAGNET_EXECUTE_DISABLED;
    delete process.env.LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY;
  });

  const appWith = (store: InMemoryPublicRateLimitStore) => {
    const app = express();
    app.use(express.json());
    app.use('/api/lead-magnet', createLeadMagnetRouter({ rateLimitStore: store }));
    return app;
  };

  it('two router instances sharing one store share counts (cross-instance model)', async () => {
    const store = new InMemoryPublicRateLimitStore();
    const a = appWith(store);
    const b = appWith(store);
    const body = { email: 'shared@example.com', taskInput: 'hi' };
    expect((await request(a).post('/api/lead-magnet/execute').send(body)).status).toBe(200);
    const second = await request(b).post('/api/lead-magnet/execute').send(body);
    expect(second.status).toBe(429);
    expect(second.body.message).toBe('Rate limit exceeded. You can run one free task per day.');
    expect(store.keys().some((k) => k.includes('shared@example.com'))).toBe(false);
  });

  it('separate stores do not share counts', async () => {
    const body = { email: 'sep@example.com', taskInput: 'hi' };
    expect((await request(appWith(new InMemoryPublicRateLimitStore())).post('/api/lead-magnet/execute').send(body)).status).toBe(200);
    expect((await request(appWith(new InMemoryPublicRateLimitStore())).post('/api/lead-magnet/execute').send(body)).status).toBe(200);
  });
});
