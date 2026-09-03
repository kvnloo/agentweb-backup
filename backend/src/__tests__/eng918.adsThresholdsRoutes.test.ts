/**
 * ENG-918 — parameter API, focused on the authorisation boundary.
 *
 * These thresholds decide when a live campaign is flagged, and once ENG-87 consumes them they
 * will decide what gets alerted on. A caller who could write another tenant's parameters could
 * therefore suppress that tenant's alerting — so ownership is the property worth testing hardest,
 * ahead of the happy paths.
 *
 * The store itself is mocked: its rules are covered exhaustively in
 * `eng918.adsThresholds.test.ts`, and re-testing them through HTTP would prove the same thing
 * twice while making a failure harder to localise.
 */

import request from 'supertest';
import express from 'express';
import adsThresholdsRoutes from '../routes/adsThresholds';
import { userDb } from '../services/db';
import * as db from '../services/adsThresholdsDb';

jest.mock('../services/db');
jest.mock('../services/adsThresholdsDb');

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'caller-1' };
    next();
  },
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockDb = db as jest.Mocked<typeof db>;

const OWNED = '1842363582956923';
const NOT_OWNED = '9999999999999999';
const FREQ = 'creativeFatigue.frequencyCritical';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/ads-thresholds', adsThresholdsRoutes);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  // The caller owns exactly one Meta ad account.
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
  (mockDb.getThresholdsForAccount as jest.Mock).mockResolvedValue([]);
  (mockDb.getThreshold as jest.Mock).mockResolvedValue(null);
  (mockDb.putThreshold as jest.Mock).mockResolvedValue(undefined);
});

describe('ownership', () => {
  it('refuses a read for an ad account the caller does not own', async () => {
    const res = await request(app()).get(`/api/ads-thresholds/meta/${NOT_OWNED}`);

    expect(res.status).toBe(403);
    expect(mockDb.getThresholdsForAccount).not.toHaveBeenCalled();
  });

  it('refuses a WRITE for an ad account the caller does not own, before touching storage', async () => {
    const res = await request(app())
      .put(`/api/ads-thresholds/meta/${NOT_OWNED}/${FREQ}`)
      .send({ value: 3.0, evidence: 'attempted cross-tenant write' });

    expect(res.status).toBe(403);
    expect(mockDb.putThreshold).not.toHaveBeenCalled();
  });

  it('refuses a REVERT for an ad account the caller does not own', async () => {
    const res = await request(app()).post(
      `/api/ads-thresholds/meta/${NOT_OWNED}/${FREQ}/revert`,
    );

    expect(res.status).toBe(403);
    expect(mockDb.putThreshold).not.toHaveBeenCalled();
  });

  it('does not reveal whether an unowned account exists at all', async () => {
    // A refusal that distinguishes "not yours" from "no such account" is an existence oracle.
    const res = await request(app()).get(`/api/ads-thresholds/meta/${NOT_OWNED}`);
    expect(res.body.error).not.toContain(NOT_OWNED);
    expect(String(res.body.error)).toMatch(/not one of your connected accounts/i);
  });

  it('accepts an account the caller owns, matching past the act_ prefix', async () => {
    const res = await request(app()).get(`/api/ads-thresholds/meta/${OWNED}`);
    expect(res.status).toBe(200);
    expect(mockDb.getThresholdsForAccount).toHaveBeenCalledWith('meta', OWNED);
  });

  it('ignores a connected account that is not an ad_account', async () => {
    // A `platform: meta` row can be an Instagram Business account rather than an ad account.
    (mockUserDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'caller-1',
      connected_accounts: [
        { platform: 'meta', account_id: OWNED, config: { account_type: 'instagram', access_token: 't' } },
      ],
    });

    const res = await request(app()).get(`/api/ads-thresholds/meta/${OWNED}`);
    expect(res.status).toBe(403);
  });
});

describe('platform gating — fail closed', () => {
  it.each(['google_ads', 'linkedin_ads'])(
    'refuses %s, which has no ownership resolver wired yet',
    async platform => {
      const res = await request(app()).get(`/api/ads-thresholds/${platform}/${OWNED}`);

      expect(res.status).toBe(400);
      expect(mockDb.getThresholdsForAccount).not.toHaveBeenCalled();
    },
  );
});

describe('PUT', () => {
  it('cannot be told to write as `learned` — source is not read from the body', async () => {
    // The precedence rule is only worth anything if a client cannot self-declare the privileged
    // source. Passing both source and a large sampleSize should change nothing.
    const res = await request(app())
      .put(`/api/ads-thresholds/meta/${OWNED}/${FREQ}`)
      .send({ value: 3.0, evidence: 'x', source: 'learned', sampleSize: 100000 });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('user');
    const written = (mockDb.putThreshold as jest.Mock).mock.calls[0][0];
    expect(written.source).toBe('user');
    expect(written.revisions[0].sampleSize).toBeNull();
  });

  it('still REFUSES an out-of-bounds value when the body claims source: learned', async () => {
    // Pins the source passed to the EVALUATION, not just the one written. If the body could
    // reach the evaluator, this request would take the machine path — silently clamped to the
    // ceiling and stored — instead of the 400 a human gets. The stored record would still read
    // `source: 'user'`, so asserting only on what was written cannot catch it.
    const res = await request(app())
      .put(`/api/ads-thresholds/meta/${OWNED}/${FREQ}`)
      .send({ value: 50, evidence: 'x', source: 'learned', sampleSize: 100000 });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('out_of_bounds');
    expect(mockDb.putThreshold).not.toHaveBeenCalled();
  });

  it('requires evidence, so a stored value always has a reviewable reason', async () => {
    const res = await request(app())
      .put(`/api/ads-thresholds/meta/${OWNED}/${FREQ}`)
      .send({ value: 3.0 });

    expect(res.status).toBe(400);
    expect(mockDb.putThreshold).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric value', async () => {
    const res = await request(app())
      .put(`/api/ads-thresholds/meta/${OWNED}/${FREQ}`)
      .send({ value: '3.0', evidence: 'x' });

    expect(res.status).toBe(400);
    expect(mockDb.putThreshold).not.toHaveBeenCalled();
  });

  it('surfaces an out-of-bounds refusal as 400 rather than silently storing a clamped value', async () => {
    const res = await request(app())
      .put(`/api/ads-thresholds/meta/${OWNED}/${FREQ}`)
      .send({ value: 50, evidence: 'too high' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('out_of_bounds');
    expect(mockDb.putThreshold).not.toHaveBeenCalled();
  });

  it('passes the prior updatedAt as the compare-and-swap baseline', async () => {
    (mockDb.getThreshold as jest.Mock).mockResolvedValue({
      accountId: OWNED,
      platform: 'meta',
      paramKey: FREQ,
      currentValue: 3.5,
      defaultValue: 3.5,
      source: 'default',
      updatedAt: '2026-09-01T00:00:00.000Z',
      learnedCooldownUntil: null,
      revisions: [],
    });

    await request(app())
      .put(`/api/ads-thresholds/meta/${OWNED}/${FREQ}`)
      .send({ value: 3.0, evidence: 'tightened' });

    expect(mockDb.putThreshold).toHaveBeenCalledWith(
      expect.anything(),
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('reports a lost compare-and-swap race as 409, not as a server error', async () => {
    (mockDb.putThreshold as jest.Mock).mockRejectedValue(
      new db.ThresholdConflictError('modified by another writer'),
    );

    const res = await request(app())
      .put(`/api/ads-thresholds/meta/${OWNED}/${FREQ}`)
      .send({ value: 3.0, evidence: 'tightened' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('concurrent_modification');
  });
});

describe('revert', () => {
  it('is a no-op success when the parameter was never written', async () => {
    const res = await request(app()).post(
      `/api/ads-thresholds/meta/${OWNED}/${FREQ}/revert`,
    );

    expect(res.status).toBe(200);
    expect(res.body.reverted).toBe(false);
    expect(mockDb.putThreshold).not.toHaveBeenCalled();
  });

  it('restores the default and returns the cooldown when a value was set', async () => {
    (mockDb.getThreshold as jest.Mock).mockResolvedValue({
      accountId: OWNED,
      platform: 'meta',
      paramKey: FREQ,
      currentValue: 3.0,
      defaultValue: 3.5,
      source: 'user',
      updatedAt: '2026-09-01T00:00:00.000Z',
      learnedCooldownUntil: null,
      revisions: [],
    });

    const res = await request(app()).post(
      `/api/ads-thresholds/meta/${OWNED}/${FREQ}/revert`,
    );

    expect(res.status).toBe(200);
    expect(res.body.reverted).toBe(true);
    expect(res.body.value).toBe(3.5);
    expect(res.body.source).toBe('default');
    expect(res.body.learnedCooldownUntil).toBeTruthy();
  });

  it('404s an unknown parameter rather than writing one', async () => {
    const res = await request(app()).post(
      `/api/ads-thresholds/meta/${OWNED}/nope.notAThing/revert`,
    );

    expect(res.status).toBe(404);
    expect(mockDb.putThreshold).not.toHaveBeenCalled();
  });
});

describe('resolved read', () => {
  it('returns the full registry with defaults for an account that has set nothing', async () => {
    const res = await request(app()).get(`/api/ads-thresholds/meta/${OWNED}`);

    expect(res.status).toBe(200);
    expect(res.body.parameters.length).toBeGreaterThan(0);
    expect(res.body.parameters.every((p: any) => p.source === 'default')).toBe(true);
    // Bounds travel with each parameter so a UI need not carry its own copy.
    expect(res.body.parameters[0]).toHaveProperty('min');
    expect(res.body.parameters[0]).toHaveProperty('max');
  });
});
