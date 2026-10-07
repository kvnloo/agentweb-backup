/**
 * ENG-2308 review follow-up: the `update_brand_guidelines` hook's
 * `building -> ready` flip must only complete the claim its Emma session was
 * started under.
 *
 * `withTimeout` does not abort the Emma session, so a brand build that timed
 * out (and was then retried, reclaiming the axis) leaves a live "zombie"
 * session. Before this fix its late `update_brand_guidelines` call saw the
 * RECLAIMING run's `building` status and flipped it to `ready` early.
 *
 * These drive the real `triggerBrandBuildForUser` with a fake Emma session
 * that calls the real `updateBrandGuidelines`, against an in-memory user
 * record whose `updateUser` enforces the DynamoDB ownership condition.
 */

const mockLogStepMetric = jest.fn();
jest.mock('../services/onboardingMetricsService', () => ({
  logStepMetric: (...a: unknown[]) => mockLogStepMetric(...a),
}));

jest.mock('../services/brandGuidelinesPopulation', () => ({
  populateEmptyBrandGuidelines: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() },
}));

jest.mock('../services/agentMode/brandLogo', () => ({
  ...jest.requireActual('../services/agentMode/brandLogo'),
  downloadBrandLogoToS3: jest.fn(),
}));

import { updateBrandGuidelines } from '../emma/impl/brandMarketStrategy';
import {
  _resetBrandBuildSessionClaimsForTests,
  triggerBrandBuildForUser,
} from '../services/onboardingBrandBuildService';
const { userDb } = require('../services/db');

const T1 = '2026-10-07T10:00:00.000Z'; // the original (zombie) run's claim
const T2 = '2026-10-07T10:06:00.000Z'; // the reclaiming run's claim

let record: Record<string, any>;

function conditionalFailure() {
  return Object.assign(new Error('The conditional request failed'), {
    code: 'ConditionalCheckFailedException',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetBrandBuildSessionClaimsForTests();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  record = {
    userId: 'u1',
    email: 'u1@example.com',
    productDomain: 'https://acme.com',
    brandBuildStatus: 'building',
    brandBuildStartedAt: T2,
    brandGuidelines: { brandData: {}, attachments: [] },
  };
  userDb.getUserById.mockImplementation(async () => ({ ...record }));
  userDb.updateUser.mockImplementation(
    async (_id: string, patch: Record<string, any>, options?: any) => {
      const owner = options?.condition?.values?.[':brandBuildOwnerStartedAt'];
      if (owner !== undefined && owner !== record.brandBuildStartedAt) {
        throw conditionalFailure();
      }
      Object.assign(record, patch);
      return { ...record };
    },
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

function runBrandBuild(expectedStartedAt: string, sessionId: string) {
  return triggerBrandBuildForUser('u1', {
    expectedStartedAt,
    createChatSession: async () => ({ sessionId }),
    // The Emma session calls the real tool, exactly as the agent loop would.
    generateSessionResponse: async () => {
      await updateBrandGuidelines(
        { brandData: { brandName: 'Acme' } },
        'u1',
        { sessionId },
      );
    },
    ensureBrandLogo: async () => ({ persisted: true, logoUrl: null, reason: 'test' }),
  });
}

describe('update_brand_guidelines ready flip is owned by its brand-build session', () => {
  it('drops a zombie session\'s ready flip when a reclaim has since started: the newer run stays `building`', async () => {
    // Record says the RECLAIMING run (T2) owns the axis; the session below was
    // started under the original claim (T1) and is finishing late.
    await runBrandBuild(T1, 'sess-zombie');

    expect(record.brandBuildStatus).toBe('building');
    expect(record.brandBuildStartedAt).toBe(T2);
    const readyMetrics = mockLogStepMetric.mock.calls.filter(
      ([row]) => (row as { status?: string }).status === 'ready',
    );
    expect(readyMetrics).toHaveLength(0);
    // The flip was attempted WITH the session's own claim as the condition.
    const flip = userDb.updateUser.mock.calls.find(
      ([, patch]: [string, Record<string, unknown>]) => patch.brandBuildStatus === 'ready',
    );
    expect(flip?.[2]?.condition?.values?.[':brandBuildOwnerStartedAt']).toBe(T1);
  });

  it('still completes the build when the session owns the current claim', async () => {
    record.brandBuildStartedAt = T1;

    await runBrandBuild(T1, 'sess-owner');

    expect(record.brandBuildStatus).toBe('ready');
    const readyMetrics = mockLogStepMetric.mock.calls.filter(
      ([row]) => (row as { status?: string }).status === 'ready',
    );
    expect(readyMetrics.length).toBeGreaterThan(0);
  });

  it('keeps the unconditional flip for a session that is not a registered brand-build session (ordinary chat)', async () => {
    record.brandBuildStartedAt = T2;

    await updateBrandGuidelines(
      { brandData: { brandName: 'Acme' } },
      'u1',
      { sessionId: 'ordinary-chat-session' },
    );

    expect(record.brandBuildStatus).toBe('ready');
    const flip = userDb.updateUser.mock.calls.find(
      ([, patch]: [string, Record<string, unknown>]) => patch.brandBuildStatus === 'ready',
    );
    expect(flip?.[2]).toBeUndefined();
  });
});
