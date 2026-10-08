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
const mockGetMessages = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSessionRecord: (...a: unknown[]) => mockGetChatSessionRecord(...a),
    getMessagesFromMessagesTable: (...a: unknown[]) => mockGetMessages(...a),
  },
}));

const mockGenerateIcps = jest.fn();
const mockGenerateCompetitors = jest.fn();
jest.mock('../services/onboardingIcpService', () => ({
  extractIcpBrandContext: () => ({ companyName: 'Acme', companyUrl: 'acme.com' }),
  generateIcpsForUser: (...a: unknown[]) => mockGenerateIcps(...a),
  mapIcpResultToMarketStrategy: (p: any[]) => p.map((x) => ({ title: x.name })),
}));
jest.mock('../services/onboardingCompetitorService', () => ({
  generateCompetitorStrategyForUser: (...a: unknown[]) => mockGenerateCompetitors(...a),
  mapCompetitorResultToMarketStrategy: () => [{ name: 'Rival' }],
}));

jest.mock('../services/agentMode/brandLogo', () => ({
  ...jest.requireActual('../services/agentMode/brandLogo'),
  downloadBrandLogoToS3: jest.fn(),
}));

import { regenerateMarketStrategy, updateBrandGuidelines, updateMarketStrategy } from '../emma/impl/brandMarketStrategy';
import {
  brandBuildOwnershipCondition,
  brandBuildSessionPageIdentifier,
  BRAND_BUILD_PROMPT_SENTINEL,
  countHumanMessages,
  isClaimSuperseded,
  parseBrandBuildSessionClaim,
  shouldRefuseBrandBuildSessionWrite,
} from '../services/brandBuildSessionMarker';
import { toolResultError, ToolResultPolicyBlockedError } from '../utils/toolResultError';
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
  mockGetMessages.mockReset();
  mockGenerateIcps.mockReset();
  mockGenerateCompetitors.mockReset();
  mockGenerateIcps.mockResolvedValue([{ name: 'P' }]);
  mockGenerateCompetitors.mockResolvedValue({ per_icp: [] });
  // default history: just the build's own opening prompt (a zombie: no human has written)
  mockGetMessages.mockResolvedValue([{ role: 'user', content: `You are Emma, ${BRAND_BUILD_PROMPT_SENTINEL}. ...` }]);
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

  it('isClaimSuperseded needs both claims known and different', () => {
    expect(isClaimSuperseded(T1, T2)).toBe(true);
    expect(isClaimSuperseded(T2, T2)).toBe(false);
    expect(isClaimSuperseded(undefined, T2)).toBe(false);
    expect(isClaimSuperseded(T1, undefined)).toBe(false);
  });

  describe('shouldRefuseBrandBuildSessionWrite (decided by content, not age)', () => {
    it('refuses a superseded session nobody has talked to, however long ago it started (a slow zombie)', () => {
      expect(shouldRefuseBrandBuildSessionWrite(T1, { startedAt: T2, status: 'ready' }, 0)).toBe(true);
      expect(shouldRefuseBrandBuildSessionWrite(T1, { startedAt: T2, status: 'failed' }, 0)).toBe(true);
    });

    it('lets a superseded session a human has written in (a reopened chat) behave like ordinary chat', () => {
      expect(shouldRefuseBrandBuildSessionWrite(T1, { startedAt: T2, status: 'ready' }, 1)).toBe(false);
    });

    it('refuses any superseded session while a newer build is in flight, whoever has written in it', () => {
      expect(shouldRefuseBrandBuildSessionWrite(T1, { startedAt: T2, status: 'building' }, 5)).toBe(true);
    });

    it('does not refuse on the strength of an unreadable history alone, unless a build is in flight', () => {
      expect(shouldRefuseBrandBuildSessionWrite(T1, { startedAt: T2, status: 'ready' }, undefined)).toBe(false);
      expect(shouldRefuseBrandBuildSessionWrite(T1, { startedAt: T2, status: 'building' }, undefined)).toBe(true);
    });

    it('never refuses the current claim, an unmarked session, or an unknown current claim', () => {
      expect(shouldRefuseBrandBuildSessionWrite(T2, { startedAt: T2, status: 'building' }, 0)).toBe(false);
      expect(shouldRefuseBrandBuildSessionWrite(undefined, { startedAt: T2, status: 'building' }, 0)).toBe(false);
      expect(shouldRefuseBrandBuildSessionWrite(T1, { startedAt: undefined, status: 'building' }, 0)).toBe(false);
    });
  });

  describe('countHumanMessages', () => {
    it('ignores the build prompt, assistant/tool/system messages', () => {
      expect(countHumanMessages([
        { role: 'user', content: `You are Emma, ${BRAND_BUILD_PROMPT_SENTINEL}. Scrape...` },
        { role: 'assistant', content: 'hi' },
        { role: 'tool', content: '{}' },
        { role: 'system', content: 'x' },
      ])).toBe(0);
    });
    it('counts what a human typed', () => {
      expect(countHumanMessages([
        { role: 'user', content: `You are Emma, ${BRAND_BUILD_PROMPT_SENTINEL}.` },
        { role: 'user', content: 'change my primary color' },
      ])).toBe(1);
      expect(countHumanMessages(undefined)).toBe(0);
    });
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

  it('the refusal reaches the model as a deliberate policy block that carries the stop instruction in `error`', async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T1));

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Zombie Brand' } }, 'u1', {
      sessionId: 'sess-zombie',
    });

    // Run it through the same conversion the tool dispatcher applies. Before
    // this shape, `error` ("Superseded brand build") won over `message`, so the
    // model was never told to stop and was invited to retry with new arguments.
    const err = toolResultError(result);
    expect(err).toBeInstanceOf(ToolResultPolicyBlockedError); // not counted as a tool malfunction
    expect(err!.message).toMatch(/do not retry/i);
    expect(err!.message).toMatch(/end your turn/i);
  });

  it('looks the session up with a consistent read, so a session created moments ago is visible', async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));
    await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', { sessionId: 'sess-owner' });
    expect(mockGetChatSessionRecord).toHaveBeenCalledWith('sess-owner', true);
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

describe('an old brand-build chat reopened later (ordinary chat again)', () => {
  const OLD = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();

  it('may still update brand guidelines, unconditionally, once a human has written in it and no build is in flight', async () => {
    record.brandBuildStatus = 'ready';
    record.brandBuildStartedAt = new Date().toISOString(); // a later build finished
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(OLD));
    mockGetMessages.mockResolvedValue([
      { role: 'user', content: `You are Emma, ${BRAND_BUILD_PROMPT_SENTINEL}.` },
      { role: 'user', content: 'rename the brand to Renamed' },
    ]);

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Renamed' } }, 'u1', { sessionId: 'old-chat' });

    expect(result.success).toBe(true);
    expect(record.brandGuidelines.brandData.brandName).toBe('Renamed');
    for (const [, , options] of guidelinesWrites()) expect(options).toBeUndefined();
  });

  it('is refused while a newer build is in flight', async () => {
    record.brandBuildStatus = 'building';
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(OLD));
    mockGetMessages.mockResolvedValue([{ role: 'user', content: 'rename it' }]);

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Renamed' } }, 'u1', { sessionId: 'old-chat' });

    expect(result).toMatchObject({ success: false, superseded: true });
    expect(record.brandGuidelines).toEqual(ORIGINAL_GUIDELINES);
  });
});

describe('a SLOW zombie (the turn cap does not apply to the brand build, so age proves nothing)', () => {
  it('is refused even though its claim is hours old and the newer build already finished', async () => {
    const HOURS_AGO = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    record.brandBuildStatus = 'ready'; // the newer run finished
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(HOURS_AGO));
    // history is only the build prompt: nobody ever talked to this session

    const result = await updateBrandGuidelines({ brandData: { brandName: 'Zombie Brand' } }, 'u1', { sessionId: 'slow' });

    expect(result).toMatchObject({ success: false, superseded: true });
    expect(userDb.updateUser).not.toHaveBeenCalled();
    expect(record.brandGuidelines).toEqual(ORIGINAL_GUIDELINES);
  });

  it('is also refused when the newer run FAILED', async () => {
    record.brandBuildStatus = 'failed';
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(new Date(Date.now() - 5 * 3600 * 1000).toISOString()));
    const result = await updateMarketStrategy({ businessOverview: 'Zombie' }, 'u1', { sessionId: 'slow' });
    expect(result).toMatchObject({ success: false, superseded: true });
  });

  it('does not read the history at all for the current claim or an unmarked session', async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));
    await updateBrandGuidelines({ brandData: { brandName: 'A' } }, 'u1', { sessionId: 'cur' });
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'x', pageIdentifier: 'agent-mode' });
    await updateBrandGuidelines({ brandData: { brandName: 'B' } }, 'u1', { sessionId: 'plain' });
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  it('falls back to the in-flight rule when the history cannot be read', async () => {
    mockGetMessages.mockRejectedValue(new Error('dynamo hiccup'));
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T1));
    record.brandBuildStatus = 'ready';
    expect((await updateBrandGuidelines({ brandData: { brandName: 'X' } }, 'u1', { sessionId: 's' })).success).toBe(true);
    record.brandBuildStatus = 'building';
    expect(await updateBrandGuidelines({ brandData: { brandName: 'X' } }, 'u1', { sessionId: 's' })).toMatchObject({ superseded: true });
  });
});

describe('refreshMarketStrategy and regenerate_market_strategy carry the session through', () => {
  const NEWER = { businessOverview: 'Newer', competitors: [{ name: 'Keep' }], icp: [{ title: 'Keep' }] };

  it('regenerate_market_strategy from a superseded session writes nothing and leaves the newer strategy intact', async () => {
    record.marketStrategy = JSON.parse(JSON.stringify(NEWER));
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T1));

    const result = await regenerateMarketStrategy('u1', {}, { sessionId: 'z' });

    expect(result).toMatchObject({ success: false, superseded: true });
    expect(record.marketStrategy).toEqual(NEWER);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('the owning session regenerates, and the strategy write is conditioned on its claim', async () => {
    record.marketStrategy = JSON.parse(JSON.stringify(NEWER));
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));

    const result = await regenerateMarketStrategy('u1', {}, { sessionId: 'o' });

    expect(result.success).toBe(true);
    const write = userDb.updateUser.mock.calls.find(([, p]: any) => 'marketStrategy' in p);
    expect(write[2].condition).toEqual(brandBuildOwnershipCondition(T2));
  });

  it('a reclaim landing DURING the (slow) regeneration rejects the write: the newer run keeps its strategy', async () => {
    record.marketStrategy = JSON.parse(JSON.stringify(NEWER));
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));
    mockGenerateIcps.mockImplementation(async () => {
      record.brandBuildStartedAt = '2026-10-07T10:09:00.000Z'; // reclaim lands mid-regeneration
      return [{ name: 'P' }];
    });

    const result = await regenerateMarketStrategy('u1', {}, { sessionId: 'o' });

    expect(result).toMatchObject({ success: false, superseded: true });
    expect(record.marketStrategy).toEqual(NEWER);
  });

  it('update_brand_guidelines with refreshMarketStrategy:true hands the session to the regeneration', async () => {
    record.marketStrategy = JSON.parse(JSON.stringify(NEWER));
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));
    // the reclaim lands while the strategy is being regenerated, after the guidelines write passed
    mockGenerateIcps.mockImplementation(async () => {
      record.brandBuildStartedAt = '2026-10-07T10:09:00.000Z';
      return [{ name: 'P' }];
    });

    await updateBrandGuidelines({ brandData: { brandName: 'Acme' }, refreshMarketStrategy: true }, 'u1', { sessionId: 'o' });

    expect(record.marketStrategy).toEqual(NEWER);
  });
});

describe('org members (brand data lives on the org record, which has no claim to condition on)', () => {
  const org = { orgId: 'org1', ownerUserId: 'u1', brandGuidelines: { brandData: { brandName: 'Org Brand' }, attachments: [] } };

  beforeEach(() => {
    record.orgId = 'org1';
    record.orgRole = 'owner';
    const { orgDb } = require('../services/db');
    orgDb.getOrgById.mockResolvedValue(org);
    orgDb.updateOrg.mockReset();
    orgDb.updateOrg.mockResolvedValue({});
    userDb.getUserByEmailConsistent = jest.fn(async () => JSON.parse(JSON.stringify(record)));
  });

  it('a superseded session is refused before any org write', async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T1));
    const result = await updateBrandGuidelines({ brandData: { brandName: 'Zombie' } }, 'u1', { sessionId: 'z' });
    expect(result).toMatchObject({ success: false, superseded: true });
    expect(require('../services/db').orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('a reclaim landing after the check but before the org write is caught by the consistent re-read', async () => {
    mockGetChatSessionRecord.mockImplementation(async () => {
      // reclaim lands while the hook is still working, after it read the user
      record.brandBuildStartedAt = '2026-10-07T10:09:00.000Z';
      return brandBuildSession(T2);
    });
    const result = await updateBrandGuidelines({ brandData: { brandName: 'Zombie' } }, 'u1', { sessionId: 'z' });
    expect(result).toMatchObject({ success: false, superseded: true });
    expect(require('../services/db').orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('update_market_strategy for an org member re-reads the claim before the org write', async () => {
    mockGetChatSessionRecord.mockImplementation(async () => {
      record.brandBuildStartedAt = '2026-10-07T10:09:00.000Z';
      return brandBuildSession(T2);
    });
    const result = await updateMarketStrategy({ businessOverview: 'Zombie' }, 'u1', { sessionId: 'z' });
    expect(result).toMatchObject({ success: false, superseded: true });
    expect(require('../services/db').orgDb.updateOrg).not.toHaveBeenCalled();
  });

  it('the owning session still writes the org brand', async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));
    const result = await updateBrandGuidelines({ brandData: { brandName: 'Acme' } }, 'u1', { sessionId: 'o' });
    expect(result.success).toBe(true);
    expect(require('../services/db').orgDb.updateOrg).toHaveBeenCalled();
  });
});

describe('update_market_strategy gets the same guard', () => {
  const strategy = { businessOverview: 'Zombie overview' };

  it('a superseded brand-build session cannot overwrite the market strategy', async () => {
    record.marketStrategy = { businessOverview: 'Newer run overview', competitors: [], icp: [] };
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T1));

    const result = await updateMarketStrategy(strategy, 'u1', { sessionId: 'z' });

    expect(result).toMatchObject({ success: false, superseded: true });
    expect(record.marketStrategy.businessOverview).toBe('Newer run overview');
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('a reclaim landing after the check rejects the conditioned write', async () => {
    record.marketStrategy = { businessOverview: 'Newer run overview', competitors: [], icp: [] };
    mockGetChatSessionRecord.mockImplementation(async () => {
      record.brandBuildStartedAt = '2026-10-07T10:09:00.000Z';
      return brandBuildSession(T2);
    });

    const result = await updateMarketStrategy(strategy, 'u1', { sessionId: 'z' });

    expect(result).toMatchObject({ success: false, superseded: true });
    expect(record.marketStrategy.businessOverview).toBe('Newer run overview');
  });

  it('the owning session writes, conditioned on its claim', async () => {
    mockGetChatSessionRecord.mockResolvedValue(brandBuildSession(T2));
    const result = await updateMarketStrategy(strategy, 'u1', { sessionId: 'o' });
    expect(result.success).toBe(true);
    expect(userDb.updateUser.mock.calls[0][2].condition).toEqual(brandBuildOwnershipCondition(T2));
  });

  it('ordinary sessions and callers with no session id are unchanged', async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'x', pageIdentifier: 'agent-mode' });
    expect((await updateMarketStrategy(strategy, 'u1', { sessionId: 'x' })).success).toBe(true);
    expect((await updateMarketStrategy(strategy, 'u1')).success).toBe(true);
    for (const [, , options] of userDb.updateUser.mock.calls) expect(options).toBeUndefined();
  });
});
