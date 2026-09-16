/**
 * ENG-1550 — outcome ledger API, focused on the authorisation boundary.
 *
 * READ is owner-scoped (same shape as ENG-918's ads-thresholds); WRITE (record/score) is
 * admin-only, since a recommendation is the agent's own prediction, not a customer-set value —
 * see the route file's header. The pure scoring/creation rules are covered exhaustively in
 * `eng1550.outcomeLedger.test.ts`; this file only re-proves the boundary, not the logic.
 */

import request from 'supertest';
import express from 'express';
import outcomeLedgerRoutes from '../routes/outcomeLedger';
import { userDb } from '../services/db';
import * as db from '../services/outcomeLedgerDb';

jest.mock('../services/db');
jest.mock('../services/outcomeLedgerDb');

let CALLER_IS_ADMIN = false;

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'caller-1', isAdmin: CALLER_IS_ADMIN };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    if (!req.user?.isAdmin) return res.status(403).json({ message: 'Admin access required' });
    next();
  },
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockDb = db as jest.Mocked<typeof db>;

const OWNED = '1842363582956923';
const NOT_OWNED = '9999999999999999';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/outcome-ledger', outcomeLedgerRoutes);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  CALLER_IS_ADMIN = false;
  (mockUserDb.getUserById as jest.Mock).mockResolvedValue({
    userId: 'caller-1',
    connected_accounts: [
      {
        platform: 'meta',
        account_id: `act_${OWNED}`,
        config: { account_type: 'ad_account', access_token: 'tok' },
      },
    ],
  });
  (mockDb.getRecommendationsForAccount as jest.Mock).mockResolvedValue([]);
  (mockDb.getRecommendation as jest.Mock).mockResolvedValue(null);
  (mockDb.putNewRecommendation as jest.Mock).mockResolvedValue(undefined);
  (mockDb.putScoredRecommendation as jest.Mock).mockResolvedValue(undefined);
});

describe('read ownership', () => {
  it('refuses a read for an ad account the caller does not own', async () => {
    const res = await request(app()).get(`/api/outcome-ledger/meta/${NOT_OWNED}`);
    expect(res.status).toBe(403);
    expect(mockDb.getRecommendationsForAccount).not.toHaveBeenCalled();
  });

  it('allows a read for an ad account the caller owns', async () => {
    const res = await request(app()).get(`/api/outcome-ledger/meta/${OWNED}`);
    expect(res.status).toBe(200);
    expect(res.body.recommendations).toEqual([]);
  });

  it('refuses a non-meta platform', async () => {
    const res = await request(app()).get(`/api/outcome-ledger/google_ads/${OWNED}`);
    expect(res.status).toBe(400);
  });
});

describe('write authorisation', () => {
  it('refuses recording a recommendation for a non-admin caller', async () => {
    const res = await request(app())
      .post(`/api/outcome-ledger/meta/${OWNED}`)
      .send({
        hypothesis: 'test',
        predictedMetric: 'ctr',
        predictedDirection: 'increase',
        predictedMagnitudePct: 5,
        evaluationDate: '2026-01-01',
      });
    expect(res.status).toBe(403);
    expect(mockDb.putNewRecommendation).not.toHaveBeenCalled();
  });

  it('refuses scoring a recommendation for a non-admin caller', async () => {
    const res = await request(app())
      .post(`/api/outcome-ledger/meta/${OWNED}/rec_1/score`)
      .send({ adopted: true, actualValue: 5, baselineValue: 4 });
    expect(res.status).toBe(403);
    expect(mockDb.putScoredRecommendation).not.toHaveBeenCalled();
  });

  it('allows an admin caller to record a recommendation', async () => {
    CALLER_IS_ADMIN = true;
    const res = await request(app())
      .post(`/api/outcome-ledger/meta/${OWNED}`)
      .send({
        hypothesis: 'raising freq cap reduces fatigue',
        predictedMetric: 'ctr',
        predictedDirection: 'increase',
        predictedMagnitudePct: 5,
        evaluationDate: '2026-01-01',
      });
    expect(res.status).toBe(201);
    expect(mockDb.putNewRecommendation).toHaveBeenCalledTimes(1);
    expect(res.body.status).toBe('pending');
  });

  it('rejects an admin recording an empty hypothesis with 400, not 500', async () => {
    CALLER_IS_ADMIN = true;
    const res = await request(app())
      .post(`/api/outcome-ledger/meta/${OWNED}`)
      .send({
        hypothesis: '   ',
        predictedMetric: 'ctr',
        predictedDirection: 'increase',
        predictedMagnitudePct: 5,
        evaluationDate: '2026-01-01',
      });
    expect(res.status).toBe(400);
    expect(mockDb.putNewRecommendation).not.toHaveBeenCalled();
  });

  it('404s scoring a recommendation that does not exist, even for an admin', async () => {
    CALLER_IS_ADMIN = true;
    const res = await request(app())
      .post(`/api/outcome-ledger/meta/${OWNED}/does-not-exist/score`)
      .send({ adopted: true, actualValue: 5, baselineValue: 4 });
    expect(res.status).toBe(404);
  });

  it('409s scoring an already-scored recommendation', async () => {
    CALLER_IS_ADMIN = true;
    (mockDb.getRecommendation as jest.Mock).mockResolvedValue({
      accountId: OWNED,
      platform: 'meta',
      recommendationId: 'rec_1',
      hypothesis: 'h',
      predictedMetric: 'ctr',
      predictedDirection: 'increase',
      predictedMagnitudePct: 5,
      evaluationDate: '2026-01-01',
      createdAt: '2025-12-01T00:00:00.000Z',
      createdBy: 'agent',
      adopted: true,
      status: 'scored',
      scoredAt: '2026-02-01T00:00:00.000Z',
      actualDirection: 'increase',
      actualMagnitudePct: 10,
      verdict: 'correct',
      verdictReason: null,
    });
    const res = await request(app())
      .post(`/api/outcome-ledger/meta/${OWNED}/rec_1/score`)
      .send({ adopted: true, actualValue: 5, baselineValue: 4 });
    expect(res.status).toBe(409);
    expect(mockDb.putScoredRecommendation).not.toHaveBeenCalled();
  });
});

describe('score input validation', () => {
  const PENDING = {
    accountId: OWNED,
    platform: 'meta',
    recommendationId: 'rec_1',
    hypothesis: 'h',
    predictedMetric: 'ctr',
    predictedDirection: 'increase',
    predictedMagnitudePct: 5,
    evaluationDate: '2026-01-01',
    createdAt: '2025-12-01T00:00:00.000Z',
    createdBy: 'agent',
    adopted: null,
    status: 'pending',
    scoredAt: null,
    actualDirection: null,
    actualMagnitudePct: null,
    verdict: null,
    verdictReason: null,
  };

  beforeEach(() => {
    CALLER_IS_ADMIN = true;
    (mockDb.getRecommendation as jest.Mock).mockResolvedValue(PENDING);
  });

  // NaN/Infinity are not representable in JSON (both serialize to `null`), so an HTTP caller can
  // never actually produce a non-finite `typeof 'number'` value here — that guard belongs to, and
  // is tested against, `scoreRecommendation` itself (`eng1550.outcomeLedger.test.ts`), which is
  // reachable by any future non-HTTP caller too.

  it('accepts a well-formed score', async () => {
    const res = await request(app())
      .post(`/api/outcome-ledger/meta/${OWNED}/rec_1/score`)
      .send({ adopted: true, actualValue: 5, baselineValue: 4 });
    expect(res.status).toBe(200);
    expect(mockDb.putScoredRecommendation).toHaveBeenCalledTimes(1);
  });

  it('returns 409, not 500, when the DB layer loses a concurrent double-score race', async () => {
    // Simulates two requests racing past the route's own pending-status pre-check: the DB layer's
    // condition expression is what actually catches this, and its rejection must produce the same
    // status code as the pre-check path above, not a generic server error.
    (mockDb.putScoredRecommendation as jest.Mock).mockRejectedValue(
      new Error(`outcomeLedgerDb: recommendation 'rec_1' is not pending (already scored, or does not exist)`),
    );
    const res = await request(app())
      .post(`/api/outcome-ledger/meta/${OWNED}/rec_1/score`)
      .send({ adopted: true, actualValue: 5, baselineValue: 4 });
    expect(res.status).toBe(409);
  });
});

describe('ENG-502 captured client scope', () => {
  it('filters another client even when both clients own the same platform account', async () => {
    (mockDb.getRecommendationsForAccount as jest.Mock).mockResolvedValue([
      { recommendationId: 'mine', context: { clientUserId: 'caller-1' } },
      { recommendationId: 'theirs', context: { clientUserId: 'other-client' } },
      { recommendationId: 'legacy' },
    ]);
    const res = await request(app()).get(`/api/outcome-ledger/meta/${OWNED}`);
    expect(res.status).toBe(200);
    expect(res.body.recommendations.map((r: any) => r.recommendationId)).toEqual(['mine']);
  });
  it('refuses an unsupported manual score for a shadow proposal even by an admin', async () => {
    CALLER_IS_ADMIN = true;
    (mockDb.getRecommendation as jest.Mock).mockResolvedValue({ status: 'pending', context: { mode: 'shadow' } });
    const res = await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/rec_1/score`)
      .send({ adopted: true, actualValue: 5, baselineValue: 4 });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('attributed_evaluation_required');
    expect(mockDb.putScoredRecommendation).not.toHaveBeenCalled();
  });
});

it.each([undefined, 'other-client', 'caller-1'])('hides ambiguous legacy ownership even with creator %s', async createdBy => {
  (mockDb.getRecommendationsForAccount as jest.Mock).mockResolvedValue([{ recommendationId: 'legacy', createdBy }]);
  const res = await request(app()).get(`/api/outcome-ledger/meta/${OWNED}`);
  expect(res.status).toBe(200);
  expect(res.body.recommendations).toEqual([]);
});

jest.mock('../services/adsLearningDb', () => ({ getScopedLearning: jest.fn().mockResolvedValue([]), attachExecutionReceipt: jest.fn().mockResolvedValue(undefined) }));
import { attachExecutionReceipt } from '../services/adsLearningDb';
it('records explicit owner rejection as non-adoption, never as a performance failure', async () => {
  mockDb.getRecommendation.mockResolvedValue({ status: 'pending', recommendationId: 'r', context: { clientUserId: 'caller-1', campaignId: 'c' } } as any);
  const res = await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/r/decline`);
  expect(res.status).toBe(200);
  expect(attachExecutionReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ adopted: false, status: 'declined', clientUserId: 'caller-1' }), 1500);
});
it('does not allow shared-account peers to decline another client recommendation', async () => {
  mockDb.getRecommendation.mockResolvedValue({ status: 'pending', context: { clientUserId: 'other' } } as any);
  expect((await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/r/decline`)).status).toBe(404);
  expect(attachExecutionReceipt).not.toHaveBeenCalled();
});

it('rejects repeated campaign query values instead of silently dropping scope', async () => {
  expect((await request(app()).get(`/api/outcome-ledger/meta/${OWNED}/learning?campaignId=a&campaignId=b`)).status).toBe(400);
});
