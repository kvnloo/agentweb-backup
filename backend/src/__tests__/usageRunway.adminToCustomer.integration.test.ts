/**
 * ENG-1215 — cross-seam integration: does an admin's policy edit actually reach
 * the customer?
 *
 * Every service in this path had passing unit tests while the feature was broken
 * end to end. The alert thresholds were validated, resolved and returned
 * correctly by their own units, and the admin route saved policies correctly by
 * its own unit — but the admin save path rebuilds the stored policy from an
 * explicit field whitelist, and the two alert fields were not on it. So the
 * thresholds could not be set at all, and any policy that somehow had them lost
 * them on the next save. Nothing failed. Every unit test still passed.
 *
 * The gap is the SEAM: one side writes `subscription_types`, the other reads it.
 * These tests hold that seam real -- `settingsService` is backed by an in-memory
 * store rather than per-call mocks, so a policy written by the admin route is
 * genuinely the bytes the customer read parses back. A field dropped on write,
 * or mangled in serialization, fails here and cannot fail in a unit test.
 *
 * Deliberately NOT a browser test. The defect this exists to catch lives between
 * two HTTP handlers, and a browser adds a deployed environment and seeded usage
 * data as prerequisites without getting closer to it.
 */

// ---------------------------------------------------------------------------
// The seam under test: ONE store, written by admin, read by the customer path.
// ---------------------------------------------------------------------------
const settingsStore = new Map<string, string>();

jest.mock('../services/settingsService', () => ({
  settingsService: {
    // Readers destructure `setting.settingValue`, so the record shape matters as
    // much as the bytes. Returning a bare string here made every read fail into
    // the `catch` and silently resolve to the platform defaults -- which is the
    // same class of false-pass this suite exists to prevent.
    getSetting: jest.fn(async (key: string) => {
      const value = settingsStore.get(key);
      return value === undefined ? null : { settingKey: key, settingValue: value };
    }),
    setSetting: jest.fn(async (key: string, value: string) => {
      settingsStore.set(key, value);
    }),
  },
}));

// Acting identity is swapped per request by the tests.
let actingUser: { userId: string; isAdmin: boolean } = { userId: 'admin-1', isAdmin: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = actingUser;
    next();
  },
}));
jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Validation inputs the admin route consults. Real enough that a policy naming
// an unsupported or unpriced model is still rejected.
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn(async () => ['gemini-3.1-flash-lite', 'anthropic.claude-opus-5']),
  },
}));
jest.mock('../utils/llmPricing', () => ({
  getModelPrice: jest.fn(() => ({ inputPerMillionMicroUsd: 1, outputPerMillionMicroUsd: 1 })),
}));

// The customer's own account state. The subscription TYPE is not mocked -- it is
// read back out of the shared store above, which is the whole point.
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(async (userId: string) => ({
      userId,
      email: `${userId}@example.com`,
      subscriptionType: 'Starter',
    })),
  },
  orgDb: { getOrgById: jest.fn(async () => null), getOrgMembers: jest.fn(async () => []) },
}));

import express from 'express';
import request from 'supertest';
import adminRoutes from '../routes/admin';
import subscriptionRoutes from '../routes/subscription';

const BASE_POLICY = {
  version: 'starter-v1',
  enforcementState: 'enforce' as const,
  optimizationCostThresholdMicroUsd: 30_000_000,
  hardCostThresholdMicroUsd: 60_000_000,
  optimizedModelIds: ['gemini-3.1-flash-lite'],
  optimizedDefaultModel: 'gemini-3.1-flash-lite',
};

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use('/api/subscription', subscriptionRoutes);

const asAdmin = () => {
  actingUser = { userId: 'admin-1', isAdmin: true };
};
const asCustomer = () => {
  actingUser = { userId: 'customer-1', isAdmin: false };
};

/** Save a subscription type through the real admin handler. */
const saveType = (policy: Record<string, unknown> | undefined) => {
  asAdmin();
  return request(app)
    .post('/api/admin/subscription-types')
    .send({
      subscriptionTypes: [
        {
          name: 'Starter',
          allowedPages: ['/tasks'],
          allowedSkills: ['skill-1'],
          ...(policy ? { llmUsagePolicy: policy } : {}),
        },
      ],
    });
};

/** Read the stored policy back out of the seam, as the customer path would. */
const storedPolicy = () => {
  const raw = settingsStore.get('subscription_types');
  if (!raw) return undefined;
  return JSON.parse(raw)[0]?.llmUsagePolicy;
};

beforeEach(() => {
  settingsStore.clear();
  asAdmin();
});

describe('ENG-1215 — admin policy edit reaches the customer (alert thresholds)', () => {
  it('a threshold an admin sets survives the write and is readable back', async () => {
    // The exact defect: this round trip silently lost both fields.
    await saveType({ ...BASE_POLICY, alertUsagePercentThreshold: 75, alertOnForecastShortfall: false })
      .expect(200);

    expect(storedPolicy()).toMatchObject({
      alertUsagePercentThreshold: 75,
      alertOnForecastShortfall: false,
    });
  });

  it('a second save does not silently drop a threshold set by the first', async () => {
    // The more damaging half of the bug. Setting the field was impossible, but
    // had it been set, ANY later edit -- even one that never touched alerting --
    // would have quietly reverted the tier to the platform default.
    await saveType({ ...BASE_POLICY, alertUsagePercentThreshold: 60 }).expect(200);
    expect(storedPolicy()).toMatchObject({ alertUsagePercentThreshold: 60 });

    // Re-save carrying the value the admin UI would have loaded back.
    await saveType({
      ...BASE_POLICY,
      enforcementState: 'observe',
      alertUsagePercentThreshold: 60,
    }).expect(200);

    expect(storedPolicy()).toMatchObject({
      enforcementState: 'observe',
      alertUsagePercentThreshold: 60,
    });
  });

  it('leaves the fields absent when unset, so the platform default stays movable', async () => {
    await saveType(BASE_POLICY).expect(200);

    const policy = storedPolicy();
    expect(policy).not.toHaveProperty('alertUsagePercentThreshold');
    expect(policy).not.toHaveProperty('alertOnForecastShortfall');
  });

  it('rejects an out-of-range threshold rather than storing one that never fires', async () => {
    await saveType({ ...BASE_POLICY, alertUsagePercentThreshold: 100 }).expect(400);
    expect(settingsStore.get('subscription_types')).toBeUndefined();
  });

  it('rejects a non-boolean forecast flag rather than coercing it to false', async () => {
    // Coercion here would silently DISABLE forecast alerts for the tier, which
    // is the opposite of what an admin fumbling the value intended.
    await saveType({ ...BASE_POLICY, alertOnForecastShortfall: 'yes' as unknown as boolean })
      .expect(400);
    expect(settingsStore.get('subscription_types')).toBeUndefined();
  });

  it('still rejects a policy naming a model the platform cannot serve', async () => {
    // Guard against these tests passing by making validation inert.
    await saveType({
      ...BASE_POLICY,
      optimizedModelIds: ['not-a-real-model'],
      optimizedDefaultModel: 'not-a-real-model',
    }).expect(400);
  });
});

describe('ENG-1215 — the customer read reflects the admin-configured threshold', () => {
  it('serves the admin-set threshold rather than the compiled-in default', async () => {
    await saveType({ ...BASE_POLICY, alertUsagePercentThreshold: 75 }).expect(200);

    asCustomer();
    const res = await request(app).get('/api/subscription/usage').expect(200);

    // The portal reads this to decide when to warn. If it reported 90 while the
    // tier said 75, the admin setting would exist only on paper -- which is the
    // shape of the original defect, one seam further along.
    expect(res.body.alertThresholds).toMatchObject({ usagePercent: 75 });
  });

  it('falls back to the platform default when the tier configures nothing', async () => {
    await saveType(BASE_POLICY).expect(200);

    asCustomer();
    const res = await request(app).get('/api/subscription/usage').expect(200);

    expect(res.body.alertThresholds).toMatchObject({
      usagePercent: 90,
      onForecastShortfall: true,
    });
  });

  it('carries a disabled forecast alert through to the customer', async () => {
    await saveType({ ...BASE_POLICY, alertOnForecastShortfall: false }).expect(200);

    asCustomer();
    const res = await request(app).get('/api/subscription/usage').expect(200);

    expect(res.body.alertThresholds).toMatchObject({ onForecastShortfall: false });
  });

  it('always reports thresholds, even for a tier with no usage policy at all', async () => {
    // The portal treats a missing `alertThresholds` as licence to substitute its
    // own constant, so the field must never be absent.
    await saveType(undefined).expect(200);

    asCustomer();
    const res = await request(app).get('/api/subscription/usage').expect(200);

    expect(res.body.alertThresholds).toBeDefined();
    expect(typeof res.body.alertThresholds.usagePercent).toBe('number');
  });
});
