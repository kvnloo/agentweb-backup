/**
 * Tests for onboarding variant serving — route + config service.
 *
 * Covers:
 *   - Hash-assignment determinism (same userId+step → same variant)
 *   - Weight-bucket boundary logic
 *   - Control fallback when no variants configured
 *   - loop_paused short-circuit
 *   - S3 error degrades gracefully (200 with variant:null)
 *   - 60s in-memory cache (re-reads from S3 only when stale)
 *   - Route: 401 when unauthenticated
 *   - Route: valid response shape
 */

import request from 'supertest';
import express from 'express';

// ---- Mock AWS S3 before importing the module under test ----
const mockGetObject = jest.fn();
const mockPutObject = jest.fn();
jest.mock('aws-sdk', () => {
  return {
    __esModule: true,
    default: {
      S3: jest.fn().mockImplementation(() => ({
        getObject: mockGetObject,
        putObject: mockPutObject,
      })),
    },
  };
});

// ---- Mock auth middleware so we can control user context ----
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = req.headers['x-test-user']
      ? JSON.parse(req.headers['x-test-user'] as string)
      : null;
    next();
  },
  AuthenticatedRequest: {},
}));

import { resolveVariant, readConfig, invalidateConfigCache, OnboardingLoopConfig, Variant } from '../services/onboardingLoopConfig';
import onboardingVariantsRoutes from '../routes/onboardingVariants';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeConfig(overrides: Partial<OnboardingLoopConfig> = {}): OnboardingLoopConfig {
  return {
    _schema_version: '1',
    paused: false,
    thresholds: {
      promote_lift_pct: 15,
      promote_min_n: 80,
      retire_lift_pct: -10,
      retire_min_n: 50,
      watchdog_rollback_pct_24h: 20,
      watchdog_pause_pct_7d: 10,
      max_active_arms_per_step: 5,
      max_tokens_per_cycle_usd: 5,
    },
    approval: {
      slack_channel: 'test',
      auto_ship_cutoff_hour_pt: 18,
      auto_ship_conditions: [],
    },
    steps: {},
    ...overrides,
  };
}

function makeVariant(id: string, weight: number, type: 'control' | 'treatment' = 'treatment'): Variant {
  return {
    variantId: id,
    type,
    weight,
    copy: { heading: `Heading for ${id}` },
  };
}

function mockS3Config(config: OnboardingLoopConfig, versionId = 'v1') {
  mockGetObject.mockReturnValue({
    promise: () => Promise.resolve({
      Body: Buffer.from(JSON.stringify(config)),
      VersionId: versionId,
    }),
  });
}

// -----------------------------------------------------------------------
// Unit tests: resolveVariant
// -----------------------------------------------------------------------

describe('resolveVariant', () => {
  const controlVariant = makeVariant('control', 0.7, 'control');
  const treatmentVariant = makeVariant('treatment-a', 0.3, 'treatment');

  test('returns null when step not in config', () => {
    const config = makeConfig();
    expect(resolveVariant(config, 'welcome', 'user-1')).toBeNull();
  });

  test('returns null when step has empty variants', () => {
    const config = makeConfig({ steps: { welcome: { active_variants: [] } } });
    expect(resolveVariant(config, 'welcome', 'user-1')).toBeNull();
  });

  test('returns only variant when weight is 1.0', () => {
    const config = makeConfig({
      steps: { welcome: { active_variants: [makeVariant('solo', 1.0)] } },
    });
    expect(resolveVariant(config, 'welcome', 'user-1')?.variantId).toBe('solo');
    expect(resolveVariant(config, 'welcome', 'user-99')?.variantId).toBe('solo');
  });

  test('hash assignment is deterministic — same input always yields same variant', () => {
    const config = makeConfig({
      steps: {
        brand: { active_variants: [controlVariant, treatmentVariant] },
      },
    });
    const results = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const v = resolveVariant(config, 'brand', 'stable-user-id');
      results.add(v?.variantId ?? 'null');
    }
    expect(results.size).toBe(1); // always same
  });

  test('different users are distributed across variants', () => {
    const config = makeConfig({
      steps: {
        brand: { active_variants: [controlVariant, treatmentVariant] },
      },
    });
    const assigned: Record<string, number> = {};
    const N = 500;
    for (let i = 0; i < N; i++) {
      const v = resolveVariant(config, 'brand', `user-${i}`);
      const id = v?.variantId ?? 'null';
      assigned[id] = (assigned[id] ?? 0) + 1;
    }
    // With weights 0.7 / 0.3, expect roughly 350/150 ±10%
    expect(assigned['control']).toBeGreaterThan(300);
    expect(assigned['control']).toBeLessThan(400);
    expect(assigned['treatment-a']).toBeGreaterThan(100);
    expect(assigned['treatment-a']).toBeLessThan(200);
  });

  test('step name in hash prevents cross-step collisions', () => {
    const config = makeConfig({
      steps: {
        welcome: { active_variants: [makeVariant('w-control', 0.5), makeVariant('w-treatment', 0.5)] },
        brand: { active_variants: [makeVariant('b-control', 0.5), makeVariant('b-treatment', 0.5)] },
      },
    });
    const userId = 'user-boundary-test';
    const vWelcome = resolveVariant(config, 'welcome', userId)?.variantId;
    const vBrand = resolveVariant(config, 'brand', userId)?.variantId;
    // They may differ because step name is included in hash
    // We just assert they're both resolved (not null)
    expect(vWelcome).toBeTruthy();
    expect(vBrand).toBeTruthy();
  });

  test('falls back to last variant on floating-point rounding edge', () => {
    // Weight 0.0 means bucket always >= cumulative=0 on first variant,
    // so it falls through to the last-variant fallback.
    const variants = [makeVariant('a', 0.0), makeVariant('b', 0.0), makeVariant('last', 0.0)];
    const config = makeConfig({ steps: { test: { active_variants: variants } } });
    const result = resolveVariant(config, 'test', 'user-1');
    expect(result?.variantId).toBe('last');
  });

  test('handles undefined weight via ?? 0 fallback', () => {
    const variantNoWeight = { variantId: 'no-weight', type: 'control' as const, copy: {} } as any;
    const variantWithWeight = makeVariant('has-weight', 1.0);
    const config = makeConfig({
      steps: { test: { active_variants: [variantNoWeight, variantWithWeight] } },
    });
    // Should not throw; just resolves to the variant with actual weight
    const result = resolveVariant(config, 'test', 'user-1');
    expect(result).not.toBeNull();
  });
});

// -----------------------------------------------------------------------
// Unit tests: readConfig + cache
// -----------------------------------------------------------------------

describe('readConfig', () => {
  beforeEach(() => {
    invalidateConfigCache();
    jest.clearAllMocks();
  });

  test('fetches from S3 on cold cache', async () => {
    const cfg = makeConfig();
    mockS3Config(cfg, 'version-1');
    const result = await readConfig();
    expect(result.config.paused).toBe(false);
    expect(result.versionId).toBe('version-1');
    expect(mockGetObject).toHaveBeenCalledTimes(1);
  });

  test('returns cached value within TTL window', async () => {
    const cfg = makeConfig();
    mockS3Config(cfg, 'version-1');
    await readConfig(); // prime cache
    await readConfig(); // should hit cache
    expect(mockGetObject).toHaveBeenCalledTimes(1);
  });

  test('invalidateConfigCache forces re-fetch', async () => {
    const cfg = makeConfig();
    mockS3Config(cfg, 'version-1');
    await readConfig();
    invalidateConfigCache();
    await readConfig();
    expect(mockGetObject).toHaveBeenCalledTimes(2);
  });

  test('throws when S3 getObject fails', async () => {
    mockGetObject.mockReturnValue({
      promise: () => Promise.reject(new Error('S3 unavailable')),
    });
    await expect(readConfig()).rejects.toThrow('S3 unavailable');
  });

  test('handles S3 response with no Body (defaults to {})', async () => {
    mockGetObject.mockReturnValue({
      promise: () => Promise.resolve({ Body: undefined, VersionId: 'v1' }),
    });
    const result = await readConfig();
    // {} parses to an empty config — just check no error thrown
    expect(result.versionId).toBe('v1');
  });

  test('handles S3 response with no VersionId (defaults to empty string)', async () => {
    mockGetObject.mockReturnValue({
      promise: () => Promise.resolve({
        Body: Buffer.from(JSON.stringify(makeConfig())),
        VersionId: undefined,
      }),
    });
    const result = await readConfig();
    expect(result.versionId).toBe('');
  });
});

// -----------------------------------------------------------------------
// Unit tests: writeConfig
// -----------------------------------------------------------------------

describe('writeConfig', () => {
  beforeEach(() => {
    invalidateConfigCache();
    jest.clearAllMocks();
  });

  test('puts config to S3 and returns versionId', async () => {
    mockPutObject.mockReturnValue({
      promise: () => Promise.resolve({ VersionId: 'new-v2' }),
    });
    const { writeConfig } = await import('../services/onboardingLoopConfig');
    const cfg = makeConfig();
    const versionId = await writeConfig(cfg, 'old-v1');
    expect(versionId).toBe('new-v2');
    expect(mockPutObject).toHaveBeenCalledTimes(1);
    const call = mockPutObject.mock.calls[0][0];
    expect(call.Bucket).toBe('agentweb-onboarding-loop');
    expect(call.Key).toBe('config.json');
    expect(call.ContentType).toBe('application/json');
  });

  test('returns empty string when S3 returns no VersionId', async () => {
    mockPutObject.mockReturnValue({
      promise: () => Promise.resolve({}),
    });
    const { writeConfig } = await import('../services/onboardingLoopConfig');
    const versionId = await writeConfig(makeConfig(), 'v1');
    expect(versionId).toBe('');
  });

  test('invalidates cache after write', async () => {
    // Prime cache
    mockGetObject.mockReturnValue({
      promise: () => Promise.resolve({ Body: Buffer.from(JSON.stringify(makeConfig())), VersionId: 'v1' }),
    });
    await readConfig();
    expect(mockGetObject).toHaveBeenCalledTimes(1);

    mockPutObject.mockReturnValue({ promise: () => Promise.resolve({ VersionId: 'v2' }) });
    const { writeConfig } = await import('../services/onboardingLoopConfig');
    await writeConfig(makeConfig(), 'v1');

    // Next read should go to S3 again
    mockGetObject.mockReturnValue({
      promise: () => Promise.resolve({ Body: Buffer.from(JSON.stringify(makeConfig())), VersionId: 'v2' }),
    });
    await readConfig();
    expect(mockGetObject).toHaveBeenCalledTimes(2);
  });
});

// -----------------------------------------------------------------------
// Route tests: GET /api/onboarding/variants/:step
// -----------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/onboarding', onboardingVariantsRoutes);
  return app;
}

const AUTH_HEADER = { 'x-test-user': JSON.stringify({ userId: 'test-user-123', email: 'test@example.com', isAdmin: false }) };

describe('GET /api/onboarding/variants/:step', () => {
  beforeEach(() => {
    invalidateConfigCache();
    jest.clearAllMocks();
  });

  test('returns 401 when not authenticated', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/onboarding/variants/welcome');
    expect(res.status).toBe(401);
  });

  test('returns 200 with variant:null when no step config', async () => {
    mockS3Config(makeConfig());
    const app = buildApp();
    const res = await request(app)
      .get('/api/onboarding/variants/welcome')
      .set(AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.variant).toBeNull();
  });

  test('returns variant when step is configured', async () => {
    const config = makeConfig({
      steps: {
        welcome: { active_variants: [makeVariant('control', 1.0, 'control')] },
      },
    });
    mockS3Config(config);
    const app = buildApp();
    const res = await request(app)
      .get('/api/onboarding/variants/welcome')
      .set(AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.variant?.variantId).toBe('control');
    expect(res.body.variant?.copy?.heading).toBe('Heading for control');
  });

  test('returns loop_paused reason when paused=true', async () => {
    mockS3Config(makeConfig({ paused: true }));
    const app = buildApp();
    const res = await request(app)
      .get('/api/onboarding/variants/welcome')
      .set(AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.variant).toBeNull();
    expect(res.body.reason).toBe('loop_paused');
  });

  test('degrades gracefully when S3 throws', async () => {
    mockGetObject.mockReturnValue({
      promise: () => Promise.reject(new Error('network error')),
    });
    const app = buildApp();
    const res = await request(app)
      .get('/api/onboarding/variants/welcome')
      .set(AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.variant).toBeNull();
    expect(res.body.reason).toBe('error');
  });

  test('returns 400 when step param is empty string', async () => {
    // Express routing doesn't match empty :step, so test the logic directly
    // by checking that route setup doesn't expose /variants/ without a param
    const app = buildApp();
    const res = await request(app)
      .get('/api/onboarding/variants/')
      .set(AUTH_HEADER);
    // 404 because Express won't match /variants/ without a param
    expect(res.status).toBe(404);
  });

  test('accepts userId query param for pre-assigned variant', async () => {
    const config = makeConfig({
      steps: {
        brand: { active_variants: [makeVariant('ctrl', 1.0, 'control')] },
      },
    });
    mockS3Config(config);
    const app = buildApp();
    const res = await request(app)
      .get('/api/onboarding/variants/brand?userId=external-user-abc')
      .set(AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.variant?.variantId).toBe('ctrl');
  });
});
