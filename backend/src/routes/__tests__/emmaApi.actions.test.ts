/**
 * Tests for GET /api/emma/actions (G5 — autonomous action log).
 * Verifies the route filters AW-ContactEvents by source='emma_session',
 * returns rows in newest-first order, flags every row as non-revertible
 * in v1, and guards against cross-tenant leakage.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  }),
}));

const mockScan = jest.fn();
jest.mock('../../config/aws', () => ({
  dynamodb: {
    scan: (...args: any[]) => ({ promise: () => mockScan(...args) }),
  },
}));

import emmaApiRouter from '../emmaApi';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/emma', emmaApiRouter);
  return app;
}

describe('GET /api/emma/actions', () => {
  beforeEach(() => {
    mockScan.mockReset();
  });

  it('returns emma_session events newest-first with revert disabled', async () => {
    mockScan.mockResolvedValueOnce({
      Items: [
        {
          eventId: 'evt_1',
          eventTimestamp: '2026-04-10T12:00:00.000Z',
          eventType: 'engagement.emma_session',
          contactId: 'alice@example.com',
          source: 'emma_session',
          sourceRecordId: 'src-1',
          payload: { note: 'assigned lead' },
        },
        {
          eventId: 'evt_2',
          eventTimestamp: '2026-04-12T12:00:00.000Z',
          eventType: 'deal.created',
          contactId: 'bob@example.com',
          dealId: 'deal-9',
          source: 'emma_session',
          sourceRecordId: 'src-2',
          payload: {},
        },
      ],
    });

    const res = await request(makeApp()).get('/api/emma/actions?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    // newest first — evt_2 (Apr 12) before evt_1 (Apr 10)
    expect(res.body.actions[0].eventId).toBe('evt_2');
    expect(res.body.actions[1].eventId).toBe('evt_1');
    // v1: every row must be non-revertible with a reason
    for (const a of res.body.actions) {
      expect(a.revertible).toBe(false);
      expect(typeof a.revertDisabledReason).toBe('string');
    }
    // dealId surfaced so the UI can deep-link
    expect(res.body.actions[0].dealId).toBe('deal-9');
    expect(res.body.actions[1].dealId).toBeNull();
  });

  it('passes source=emma_session and the caller userId into the scan filter', async () => {
    mockScan.mockResolvedValueOnce({ Items: [] });
    await request(makeApp()).get('/api/emma/actions');
    expect(mockScan).toHaveBeenCalledTimes(1);
    const params = mockScan.mock.calls[0][0];
    expect(params.FilterExpression).toContain('#src = :src');
    expect(params.ExpressionAttributeValues[':src']).toBe('emma_session');
    // tenant-scoping guard
    expect(params.ExpressionAttributeValues[':uid']).toBe('user-123');
    expect(params.FilterExpression).toContain('tenantId');
  });

  it('caps limit at 200 even when a larger value is requested', async () => {
    mockScan.mockResolvedValueOnce({ Items: [] });
    await request(makeApp()).get('/api/emma/actions?limit=9999');
    const params = mockScan.mock.calls[0][0];
    // request limit is capped at 200; scan Limit is 4x the cap for overscan
    expect(params.Limit).toBeLessThanOrEqual(200 * 4);
  });

  it('returns 500 on dynamo failure', async () => {
    mockScan.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).get('/api/emma/actions');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});
