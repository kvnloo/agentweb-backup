/**
 * ENG-2308 review follow-up: `update_brand_guidelines` calls made from a
 * brand-build Emma session may only act for the claim that session belongs to.
 *
 * `withTimeout` does not abort a brand build's Emma session, so a build that
 * timed out and was retried leaves a live "zombie" session. Before this fix its
 * late call overwrote the RECLAIMING run's brand guidelines and flipped its
 * status to `ready`.
 *
 * A brand-build session names its claim in its `pageIdentifier`
 * (`brand-build|claim:<brandBuildStartedAt>`). The hook compares that to the
 * build's CURRENT `brandBuildStartedAt`. Sessions with no marker (ordinary chat,
 * REST saves) are not brand-build sessions and keep the original behavior.
 * (An earlier attempt kept the link in an in-process map and then in a
 * createdAt age rule; the first never worked across the forked agent worker and
 * the second wrongly blocked ordinary sessions.)
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

const mockGetChatSessionRecord = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSessionRecord: (...a: unknown[]) => mockGetChatSessionRecord(...a) },
}));

jest.mock('../services/agentMode/brandLogo', () => ({
  ...jest.requireActual('../services/agentMode/brandLogo'),
  downloadBrandLogoToS3: jest.fn(),
}));

import { updateBrandGuidelines } from '../emma/impl/brandMarketStrategy';
import {
  brandBuildOwnershipCondition,
  brandBuildSessionPageIdentifier,
  isBrandBuildSessionSuperseded,
  parseBrandBuildSessionClaim,
} from '../services/brandBuildSessionMarker';
const { userDb } = require('../services/db');

const T1 = '2026-10-07T10:00:00.000Z'; // original (zombie) run's claim
const T2 = '2026-10-07T10:06:00.000Z'; // reclaiming run's claim (the current one)

let record: Record<string, any>;

function conditionalFailure() {
  return Object.assign(new Error('The conditional request failed'), {
    code: 'ConditionalCheckFailedException',
  });
}

const brandBuildSession = (claim: string) => ({
  sessionId: 's',
  pageIdentifier: brandBuildSessionPageIdentifier(claim),
});

function readyFlips() {
  return userDb.updateUser.mock.calls.filter(
    ([, patch]: [string, Record<string, unknown>]) => patch.brandBuildStatus === 'ready',
  );
}

function guidelinesWrites() {
  return userDb.updateUser.mock.calls.filter(
    ([, patch]: [string, Record<string, unknown>]) => 'brandGuidelines' in patch,
  );
}

function readyMetrics() {
  return mockLogStepMetric.mock.calls.filter(
    ([row]) => (row as { status?: string }).status === 'ready',
  );
}

const ORIGINAL_GUIDELINES = { brandData: { brandName: 'Newer Run Brand' }, attachments: [] };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  record = {
    userId: 'u1',
    email: 'u1@example.com',
    brandBuildStatus: 'building',
    brandBuildStartedAt: T2,
    brandGuidelines: JSON.parse(JSON.stringify(ORIGINAL_GUIDELINES)),
  };
  mockGetChatSessionRecord.mockReset();
  userDb.getUserById.mockImplementation(async () => JSON.parse(JSON.stringify(record)));
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

describe('brand-build session marker', () => {
  it('round-trips a claim through the pageIdentifier', () => {
    expect(parseBrandBuildSessionClaim(brandBuildSessionPageIdentifier(T1))).toBe(T1);
  });

  it('does not treat any other pageIdentifier as a brand-build session', () => {
    for (const other of ['agent-mode', 'crm-email-draft', 'slack-thread', 'Daily post|scheduleId:abc-123', '', undefined, null]) {
      expect(parseBrandBuildSessionClaim(other as any)).toBeUndefined();
    }
  });

  it('does not collide with the identifier shapes other code parses', () => {
    const id = brandBuildSessionPageIdentifier(T1);
    expect(id.toLowerCase()).not.toContain('slack'); // agentModeService treats 'slack' ids specially
    expect(/\|scheduleId:([a-f0-9-]+)\s*$/.test(id)).toBe(false); // extractScheduleId
  });

  it('only calls a session superseded when both claims are known and differ', () => {
    expect(isBrandBuildSessionSuperseded(T1, T2)).toBe(true);
    expect(isBrandBuildSessionSuperseded(T2, T2)).toBe(false);
    expect(isBrandBuildSessionSuperseded(undefined, T2)).toBe(false); // not a brand-build session
    expect(isBrandBuildSessionSuperseded(T1, undefined)).toBe(false); // cannot prove it
  });
});

describe('update_brand_guidelines from a brand-build session', () => {
  it('a superseded session writes NOTHING: no guidelines overwrite, no status flip, no metric, and is told to stop', async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T1));

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Zombie Brand' } }, 'u1', {
      sessionId: 'sess-zombie',
    });

    expect(result).toMatchObject({ success: false, superseded: true });
    expect(result.message).toMatch(/do not retry/i);
    // The gap the review found: the newer run's guidelines must survive intact.
    expect(userDb.updateUser).not.toHaveBeenCalled();
    expect(record.brandGuidelines).toEqual(ORIGINAL_GUIDELINES);
    expect(record.brandBuildStatus).toBe('building');
    expect(readyMetrics()).toHaveLength(0);
  });

  it("the owning session writes its guidelines and flips ready, both conditioned on its claim", async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', {
      sessionId: 'sess-owner',
    });

    expect(result.success).toBe(true);
    expect(record.brandBuildStatus).toBe('ready');
    expect(record.brandGuidelines.brandData.brandName).toBe('Acme');
    expect(readyMetrics().length).toBeGreaterThan(0);
    for (const [, , options] of [...guidelinesWrites(), ...readyFlips()]) {
      expect(options.condition).toEqual(brandBuildOwnershipCondition(T2));
    }
    expect(guidelinesWrites().length).toBeGreaterThan(0);
    expect(readyFlips()).toHaveLength(1);
  });

  it('a reclaim landing AFTER the ownership check is caught atomically: the guidelines write is rejected, nothing is overwritten', async () => {
    mockGetChatSessionRecord.mockImplementation(async () => {
      // The reclaim happens while the hook is looking the session up.
      record.brandBuildStartedAt = '2026-10-07T10:09:00.000Z';
      return brandBuildSession(T2);
    });
    // user was read before the lookup, so the hook still believes T2 is current.

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Zombie Brand' } }, 'u1', {
      sessionId: 'sess-owner',
    });

    expect(result).toMatchObject({ success: false, superseded: true });
    expect(record.brandGuidelines).toEqual(ORIGINAL_GUIDELINES);
    expect(record.brandBuildStatus).toBe('building');
    expect(readyMetrics()).toHaveLength(0);
  });

  it('a reclaim landing between the guidelines write and the ready flip drops only the flip', async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));
    const realImpl = userDb.updateUser.getMockImplementation();
    userDb.updateUser.mockImplementation(async (id: string, patch: any, options?: any) => {
      const out = await realImpl(id, patch, options);
      if ('brandGuidelines' in patch) record.brandBuildStartedAt = '2026-10-07T10:09:00.000Z';
      return out;
    });

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', {
      sessionId: 'sess-owner',
    });

    expect(result.success).toBe(true);
    expect(record.brandBuildStatus).toBe('building');
    expect(readyMetrics()).toHaveLength(0);
  });
});

describe('update_brand_guidelines from sessions that are NOT brand-build sessions keeps the original behavior', () => {
  it('an ordinary chat session, even one that predates the build, still completes it mid-build (no ownership condition)', async () => {
    mockGetChatSessionRecord.mockResolvedValue({
      sessionId: 'ordinary',
      pageIdentifier: 'agent-mode',
      createdAt: '2026-10-07T09:00:00.000Z', // long before the T2 claim
    });

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', {
      sessionId: 'ordinary',
    });

    expect(result.success).toBe(true);
    expect(record.brandBuildStatus).toBe('ready');
    for (const [, , options] of [...guidelinesWrites(), ...readyFlips()]) {
      expect(options).toBeUndefined();
    }
  });

  it('a call with no session id (REST / direct service calls) is unconditional and does no session lookup', async () => {
    const result = await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1');

    expect(result.success).toBe(true);
    expect(record.brandBuildStatus).toBe('ready');
    expect(mockGetChatSessionRecord).not.toHaveBeenCalled();
  });

  it('a failed session lookup is treated as an ordinary session instead of failing the update', async () => {
    mockGetChatSessionRecord.mockRejectedValue(new Error('dynamo hiccup'));

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', {
      sessionId: 'sess-x',
    });

    expect(result.success).toBe(true);
    expect(record.brandBuildStatus).toBe('ready');
  });

  it('skips the session lookup entirely for a user who has never had a brand build', async () => {
    delete record.brandBuildStartedAt;
    delete record.brandBuildStatus;

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', {
      sessionId: 'sess-y',
    });

    expect(result.success).toBe(true);
    expect(mockGetChatSessionRecord).not.toHaveBeenCalled();
  });
});
