import { LearningReviewConflict } from '../services/adsScopedLearning';
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

/** Always ahead of `createdAt`, which the route mints as the real current time.
 *
 * These fixtures were a hardcoded '2026-01-01'. That is a date, so it went stale the moment the
 * wall clock passed it — and once `createRecommendation` started rejecting an evaluationDate that
 * precedes createdAt (retroactive prediction), every one of these authorisation tests began failing
 * on its fixture rather than on the behaviour it exists to check. Derive it instead, so the suite
 * cannot rot again. */
const FUTURE_EVALUATION_DATE = new Date(Date.now() + 30 * 86400000).toISOString();

/** For rows read back as ALREADY CREATED, where the point of the test is scoring.
 *
 * These must sit past the 28-day settling window or `scoreRecommendation` returns `unscoreable`,
 * and the scoring tests below — which assert only status 200 — would keep passing while silently
 * exercising the unsettled path instead of a real verdict. Creation's no-backdating rule does not
 * apply here: nothing in these tests calls `createRecommendation`. */
const SETTLED_EVALUATION_DATE = new Date(Date.now() - 120 * 86400000).toISOString();

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
        evaluationDate: FUTURE_EVALUATION_DATE,
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
        evaluationDate: FUTURE_EVALUATION_DATE,
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
        evaluationDate: FUTURE_EVALUATION_DATE,
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
      evaluationDate: SETTLED_EVALUATION_DATE,
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
    evaluationDate: SETTLED_EVALUATION_DATE,
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

jest.mock('../services/adsLearningReview', () => ({ reviewLearning: jest.fn() }));
it.each(['read', 'approve', 'revert', 'decline'])('logs a sanitized %s failure without changing the client response', async action => {
  const error = new Error('secret-token and private recommendation content');
  const audit = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    let res;
    if (action === 'read') {
      const { getScopedLearning } = await import('../services/adsLearningDb');
      (getScopedLearning as jest.Mock).mockRejectedValueOnce(error);
      res = await request(app()).get(`/api/outcome-ledger/meta/${OWNED}/learning`);
    } else if (action === 'decline') {
      mockDb.getRecommendation.mockResolvedValue({ status: 'pending', recommendationId: 'r', context: { clientUserId: 'caller-1', campaignId: 'c' } } as any);
      (attachExecutionReceipt as jest.Mock).mockRejectedValueOnce(error);
      res = await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/r/decline`);
    } else {
      const { reviewLearning } = await import('../services/adsLearningReview');
      (reviewLearning as jest.Mock).mockRejectedValueOnce(error);
      res = await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/learning/${encodeURIComponent('ads-learning#' + 'a'.repeat(64))}/${action}`);
    }
    expect(res.status).toBe(action === 'read' ? 503 : 500);
    expect(audit).toHaveBeenCalledWith('[AdsLearning] request failed', expect.objectContaining({ userId: 'caller-1', accountId: OWNED, action, error: 'Error' }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-token');
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
  } finally { audit.mockRestore(); }
});

it('bounds and sanitizes request-controlled audit identifiers and error classes', async () => {
  const { reviewLearning } = await import('../services/adsLearningReview');
  const error = new Error('private content'); error.name = 'Provider\n' + 'x'.repeat(512);
  (reviewLearning as jest.Mock).mockRejectedValueOnce(error);
  const audit = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const target = encodeURIComponent('ads-learning#' + 'a'.repeat(64));
    expect((await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/learning/${target}/approve`)).status).toBe(500);
    const fields = audit.mock.calls[0][1] as Record<string, string>;
    for (const value of Object.values(fields)) {
      expect(value.length).toBeLessThanOrEqual(128);
      expect(value).toMatch(/^[a-zA-Z0-9_.:#-]*$/);
    }
  } finally { audit.mockRestore(); }
});


it.each(['ads-learning#short', 'ads-learning#' + 'g'.repeat(64), 'ads-learning#' + 'a'.repeat(1025)])('rejects malformed learning keys before review/storage (%s)', async memoryId => {
  const { reviewLearning } = await import('../services/adsLearningReview');
  expect((await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/learning/${encodeURIComponent(memoryId)}/approve`)).status).toBe(400);
  expect(reviewLearning).not.toHaveBeenCalled();
});

it.each(['decline', 'score'])('rejects oversized UTF-8 recommendation keys before %s storage access', async action => {
  CALLER_IS_ADMIN = true;
  const target = encodeURIComponent('é'.repeat(513));
  expect((await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/${target}/${action}`)).status).toBe(400);
  expect(mockDb.getRecommendation).not.toHaveBeenCalled();
});


it.each(['approve', 'revert', 'decline'])('reports %s dependency failure as 503 without exposing details', async action => {
  const error = Object.assign(new Error('private provider response'), { code: 'ProvisionedThroughputExceededException', retryable: true });
  let path;
  if (action === 'decline') {
    mockDb.getRecommendation.mockRejectedValueOnce(error);
    path = `/api/outcome-ledger/meta/${OWNED}/r/decline`;
  } else {
    const { reviewLearning } = await import('../services/adsLearningReview');
    (reviewLearning as jest.Mock).mockRejectedValueOnce(error);
    path = `/api/outcome-ledger/meta/${OWNED}/learning/${encodeURIComponent('ads-learning#' + 'a'.repeat(64))}/${action}`;
  }
  const res = await request(app()).post(path);
  expect(res.status).toBe(503);
  expect(JSON.stringify(res.body)).not.toContain('private provider response');
});

it('keeps an explicit non-applied review as a 409 conflict', async () => {
  const { reviewLearning } = await import('../services/adsLearningReview');
  (reviewLearning as jest.Mock).mockResolvedValueOnce({ applied: false, reason: 'already_reviewed' });
  const res = await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/learning/${encodeURIComponent('ads-learning#' + 'a'.repeat(64))}/approve`);
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ applied: false, reason: 'already_reviewed' });
});


it.each([
  [new LearningReviewConflict('scope mismatch'), 409],
  [Object.assign(new Error('race'), { code: 'ConditionalCheckFailedException' }), 409],
  [Object.assign(new Error('race'), { code: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] }), 409],
  [Object.assign(new Error('outage'), { code: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }] }), 503],
  [Object.assign(new Error('malformed provider metadata'), { code: 'TransactionCanceledException', CancellationReasons: [null] }), 503],
])('classifies review failure safely (%s)', async (error, status) => {
  const { reviewLearning } = await import('../services/adsLearningReview');
  (reviewLearning as jest.Mock).mockRejectedValueOnce(error);
  const res = await request(app()).post(`/api/outcome-ledger/meta/${OWNED}/learning/${encodeURIComponent('ads-learning#' + 'a'.repeat(64))}/approve`);
  expect(res.status).toBe(status);
  expect(res.body.error).toBe('Learning review could not be applied');
});
