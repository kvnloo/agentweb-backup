/**
 * ENG-2308 review follow-up: the `update_brand_guidelines` hook's
 * `building -> ready` flip must only complete the claim its Emma session
 * belongs to.
 *
 * `withTimeout` does not abort the Emma session, so a brand build that timed
 * out (and was then retried, reclaiming the axis) leaves a live "zombie"
 * session. Before this fix its late `update_brand_guidelines` call saw the
 * RECLAIMING run's `building` status and flipped it to `ready` early.
 *
 * The agent loop runs in a forked worker process, so ownership cannot live in
 * an in-process map (a first attempt did, and a live run showed the worker
 * never saw it). It is derived from the session's own `createdAt` instead: a
 * brand build creates its session after it claims the axis.
 *
 * These drive the real `updateBrandGuidelines` hook against an in-memory user
 * record whose `updateUser` enforces the DynamoDB ownership condition.
 */

const mockLogStepMetric = jest.fn();
jest.mock('../services/onboardingMetricsService', () => ({
  logStepMetric: (...a: unknown[]) => mockLogStepMetric(...a),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() },
}));

const mockGetChatSession = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: (...a: unknown[]) => mockGetChatSession(...a) },
}));

jest.mock('../services/agentMode/brandLogo', () => ({
  ...jest.requireActual('../services/agentMode/brandLogo'),
  downloadBrandLogoToS3: jest.fn(),
}));

import { updateBrandGuidelines } from '../emma/impl/brandMarketStrategy';
import {
  BRAND_BUILD_SESSION_SKEW_TOLERANCE_MS,
  sessionMayCompleteBrandBuild,
} from '../services/onboardingBrandBuildService';
const { userDb } = require('../services/db');

const T1 = '2026-10-07T10:00:00.000Z'; // original (zombie) run's claim
const T1_SESSION = '2026-10-07T10:00:01.000Z'; // its Emma session, created just after
const T2 = '2026-10-07T10:06:00.000Z'; // reclaiming run's claim
const T2_SESSION = '2026-10-07T10:06:01.000Z'; // the reclaiming run's own session

let record: Record<string, any>;

function conditionalFailure() {
  return Object.assign(new Error('The conditional request failed'), {
    code: 'ConditionalCheckFailedException',
  });
}

function readyFlips() {
  return userDb.updateUser.mock.calls.filter(
    ([, patch]: [string, Record<string, unknown>]) => patch.brandBuildStatus === 'ready',
  );
}

function readyMetrics() {
  return mockLogStepMetric.mock.calls.filter(
    ([row]) => (row as { status?: string }).status === 'ready',
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  record = {
    userId: 'u1',
    email: 'u1@example.com',
    brandBuildStatus: 'building',
    brandBuildStartedAt: T2,
    brandGuidelines: { brandData: {}, attachments: [] },
  };
  mockGetChatSession.mockReset();
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

describe('sessionMayCompleteBrandBuild', () => {
  it('allows a session created after the claim', () => {
    expect(sessionMayCompleteBrandBuild(T2_SESSION, T2)).toBe(true);
  });

  it('rejects a session created before the claim, well outside the skew tolerance', () => {
    expect(sessionMayCompleteBrandBuild(T1_SESSION, T2)).toBe(false);
  });

  it('absorbs small cross-instance clock skew', () => {
    const skewed = new Date(Date.parse(T2) - BRAND_BUILD_SESSION_SKEW_TOLERANCE_MS + 1).toISOString();
    expect(sessionMayCompleteBrandBuild(skewed, T2)).toBe(true);
    const tooOld = new Date(Date.parse(T2) - BRAND_BUILD_SESSION_SKEW_TOLERANCE_MS - 1).toISOString();
    expect(sessionMayCompleteBrandBuild(tooOld, T2)).toBe(false);
  });

  it('allows (keeps old behavior) when it cannot prove the session predates the claim', () => {
    expect(sessionMayCompleteBrandBuild(undefined, T2)).toBe(true);
    expect(sessionMayCompleteBrandBuild('not-a-date', T2)).toBe(true);
    expect(sessionMayCompleteBrandBuild(T1_SESSION, undefined)).toBe(true);
  });
});

describe('update_brand_guidelines ready flip is owned by its brand-build session', () => {
  it("drops a zombie session's ready flip when a reclaim has since started: the newer run stays `building`", async () => {
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-zombie', createdAt: T1_SESSION });

    await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', {
      sessionId: 'sess-zombie',
    });

    expect(record.brandBuildStatus).toBe('building');
    expect(record.brandBuildStartedAt).toBe(T2);
    expect(readyFlips()).toHaveLength(0);
    expect(readyMetrics()).toHaveLength(0);
  });

  it('still completes the build when the session belongs to the current claim', async () => {
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-owner', createdAt: T2_SESSION });

    await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', {
      sessionId: 'sess-owner',
    });

    expect(record.brandBuildStatus).toBe('ready');
    expect(readyMetrics().length).toBeGreaterThan(0);
    // The flip is conditioned on the claim the ownership check was judged against.
    expect(readyFlips()[0][2].condition.values[':brandBuildOwnerStartedAt']).toBe(T2);
  });

  it('drops the flip atomically when a reclaim lands between the ownership check and the write', async () => {
    mockGetChatSession.mockImplementation(async () => {
      // The reclaim happens while the hook is looking the session up.
      record.brandBuildStartedAt = '2026-10-07T10:09:00.000Z';
      return { sessionId: 'sess-owner', createdAt: T2_SESSION };
    });

    await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', {
      sessionId: 'sess-owner',
    });

    expect(record.brandBuildStatus).toBe('building');
    expect(readyMetrics()).toHaveLength(0);
  });

  it('keeps the unconditional flip for a call with no session id (REST / direct service calls)', async () => {
    await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1');

    expect(record.brandBuildStatus).toBe('ready');
    expect(mockGetChatSession).not.toHaveBeenCalled();
    expect(readyFlips()[0][2]).toBeUndefined();
  });
});
