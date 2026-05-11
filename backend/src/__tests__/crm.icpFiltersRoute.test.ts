// Tests for GET /api/crm/icp/filters.
//
// Returns LLM-extracted LinkedIn search filter VARIANTS (1-3) for one of
// the user's ICP personas. WITHOUT triggering a search or import. The
// frontend uses this to pre-fill the Find Leads modal — when the LLM
// returns multiple variants, the modal renders a chip picker so the user
// chooses an angle before clicking Find & Import.
//
// The route caches the LLM result on user.icpResult[i].extractedFilters
// keyed by a hash of the persona content. Subsequent reads for the same
// persona content skip the LLM.

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(),
  getTemplates: jest.fn(),
  getTemplate: jest.fn(),
  updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  publishTemplate: jest.fn(),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    createLeadList: jest.fn(),
    getLeadListById: jest.fn(),
    updateLeadList: jest.fn(),
    deleteLeadList: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadsByICPFlag: jest.fn(),
    getLeadsByEngagedFlag: jest.fn(),
    getLeadsByStatus: jest.fn(),
    createLead: jest.fn(),
    getLeadById: jest.fn(),
    getLeadByEmail: jest.fn(),
    updateLead: jest.fn(),
    deleteLead: jest.fn(),
    batchCreateLeads: jest.fn(),
    getLeadEngagements: jest.fn(),
    addLeadEngagement: jest.fn(),
    updateLeadEngagement: jest.fn(),
    deleteLeadEngagement: jest.fn(),
    getLeadEngagementCount: jest.fn(),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
  dealDb: {},
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomain: jest.fn(),
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    searchWeb: jest.fn(),
    importLeadsFromSearch: jest.fn(),
  },
}));

jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn(), LLMService: jest.fn() }));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { handleLeadEvent: jest.fn() },
}));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', email: 'u1@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

// Mock the LLM extractor's network-doing function but keep the real
// personaCacheKey / cache version so the route's cache logic operates
// against realistic hashes.
jest.mock('../services/icpFilterLlmExtractor', () => {
  const actual = jest.requireActual('../services/icpFilterLlmExtractor');
  return {
    ...actual,
    extractIcpFiltersWithLlm: jest.fn(),
  };
});

import { userDb } from '../services/db';
import router from '../routes/crm';
import {
  extractIcpFiltersWithLlm,
  personaCacheKey,
  ICP_FILTER_CACHE_VERSION,
} from '../services/icpFilterLlmExtractor';

const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method],
  );
  if (!layer?.route) return null;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

const persona = (over: any = {}) => ({
  name: 'Mid-market RevOps Leaders',
  pain: 'data hand-offs',
  desire: 'pipeline visibility',
  objection: 'switching cost',
  meta_targeting_brief:
    'RevOps managers at SaaS companies in North America who use Salesforce.',
  ...over,
});

const llmVariants = () => [
  { label: 'Broad', title: 'RevOps Leaders', industry: 'SaaS' },
  {
    label: 'North America focus',
    title: 'RevOps Leaders',
    industry: 'SaaS',
    location: 'North America',
  },
];

describe('GET /api/crm/icp/filters', () => {
  let mockReq: any;
  let mockRes: any;
  const handler = findHandler(router, '/icp/filters', 'get');

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = { params: {}, query: {}, body: {}, user: { userId: 'u1' } };
    mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', icpResult: [persona()] });
    (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);
    (extractIcpFiltersWithLlm as jest.Mock).mockResolvedValue(llmVariants());
  });

  it('route handler is registered', () => {
    expect(handler).not.toBeNull();
  });

  // Validation — unchanged from the regex-extractor era.
  it('400 when icpIndex query param is missing', async () => {
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('400 when icpIndex is negative', async () => {
    mockReq.query = { icpIndex: '-1' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('400 when icpIndex is not a number', async () => {
    mockReq.query = { icpIndex: 'first' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('404 when user has no icpResult personas', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', icpResult: [] });
    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('404 when user has no icpResult field at all', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1' });
    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('404 when icpIndex is out of range', async () => {
    mockReq.query = { icpIndex: '5' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  // ──────────────────────────────────────────────────────────────────────
  // LLM + cache behaviour.
  // ──────────────────────────────────────────────────────────────────────

  it('cache miss: calls the LLM extractor and persists the variants on user.icpResult', async () => {
    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(extractIcpFiltersWithLlm).toHaveBeenCalledTimes(1);
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    const [userId, patch] = (userDb.updateUser as jest.Mock).mock.calls[0];
    expect(userId).toBe('u1');
    expect(Array.isArray(patch.icpResult)).toBe(true);
    const cached = patch.icpResult[0].extractedFilters;
    expect(cached.cacheVersion).toBe(ICP_FILTER_CACHE_VERSION);
    expect(cached.cacheKey).toBe(personaCacheKey(persona()));
    expect(cached.variants).toEqual(llmVariants());
  });

  it('cache miss: returns 200 with variants array and cached=false', async () => {
    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    const body = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(body.persona).toEqual({ name: 'Mid-market RevOps Leaders', index: 0 });
    expect(body.variants).toEqual(llmVariants());
    expect(body.cached).toBe(false);
  });

  it('cache hit: matching cacheKey + cacheVersion skips the LLM and returns cached variants', async () => {
    const cachedVariants = [{ label: 'Cached', title: 'CachedTitle' }];
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'u1',
      icpResult: [
        {
          ...persona(),
          extractedFilters: {
            cacheKey: personaCacheKey(persona()),
            cacheVersion: ICP_FILTER_CACHE_VERSION,
            variants: cachedVariants,
            generatedAt: '2026-05-11T00:00:00.000Z',
          },
        },
      ],
    });

    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(extractIcpFiltersWithLlm).not.toHaveBeenCalled();
    expect(userDb.updateUser).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(200);
    const body = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(body.variants).toEqual(cachedVariants);
    expect(body.cached).toBe(true);
  });

  it('cache miss: persona text changed (different hash) ⇒ LLM is re-called', async () => {
    const stale = persona();
    const current = persona({ name: 'NEW NAME' });
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'u1',
      icpResult: [
        {
          ...current,
          extractedFilters: {
            cacheKey: personaCacheKey(stale), // hash of the OLD persona text
            cacheVersion: ICP_FILTER_CACHE_VERSION,
            variants: [{ label: 'Stale', title: 'Stale' }],
            generatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    });

    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(extractIcpFiltersWithLlm).toHaveBeenCalledTimes(1);
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    const body = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(body.cached).toBe(false);
  });

  it('cache miss: cacheVersion mismatch ⇒ LLM is re-called', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'u1',
      icpResult: [
        {
          ...persona(),
          extractedFilters: {
            cacheKey: personaCacheKey(persona()),
            cacheVersion: ICP_FILTER_CACHE_VERSION + 1, // future version → still invalidates
            variants: [{ label: 'Future', title: 'Future' }],
            generatedAt: '2026-05-11T00:00:00.000Z',
          },
        },
      ],
    });

    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(extractIcpFiltersWithLlm).toHaveBeenCalledTimes(1);
  });

  it('LLM failure ⇒ 503 with a user-facing message; nothing persisted', async () => {
    (extractIcpFiltersWithLlm as jest.Mock).mockRejectedValueOnce(
      new Error('Bedrock throttled'),
    );
    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(503);
    const body = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(body.message).toMatch(/extract.*filter/i);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  // Regression guard: the cache write must not clobber concurrent edits
  // made to OTHER personas during the ~3s LLM window. The route reads at
  // T0, calls the LLM, then must re-read user state before persisting so
  // that whatever was written in between (e.g., GTM page regenerating
  // personas) survives.
  it('cache write merges onto the FRESH icpResult, not the stale snapshot from before the LLM call', async () => {
    const staleP0 = persona({ name: 'Stale Name 0' }); // what we read at T0
    const freshP0 = persona({ name: 'Stale Name 0' }); // same content, still indexed at 0
    const freshP1NewlyAdded = persona({ name: 'Freshly Added By Concurrent Write' });

    // getUserById is called twice by the route (initial read + post-LLM
    // re-read). Return the stale snapshot first, then a snapshot showing
    // a concurrent change (a new persona appeared at index 1).
    (userDb.getUserById as jest.Mock)
      .mockResolvedValueOnce({ userId: 'u1', icpResult: [staleP0] })
      .mockResolvedValueOnce({ userId: 'u1', icpResult: [freshP0, freshP1NewlyAdded] });

    (extractIcpFiltersWithLlm as jest.Mock).mockResolvedValue(llmVariants());

    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    const [, patch] = (userDb.updateUser as jest.Mock).mock.calls[0];

    // Must preserve the freshly-added persona at index 1.
    expect(patch.icpResult).toHaveLength(2);
    expect(patch.icpResult[1].name).toBe('Freshly Added By Concurrent Write');

    // Index 0 must carry the new extractedFilters cache.
    expect(patch.icpResult[0].extractedFilters?.variants).toEqual(llmVariants());
    expect(patch.icpResult[0].extractedFilters?.cacheKey).toBe(personaCacheKey(staleP0));
  });

  // Edge case: if the persona at icpIndex no longer exists in the fresh
  // read (deleted concurrently), skip the cache write entirely. We still
  // return the LLM result to the caller — they asked for it, they get
  // it — but we don't pollute the user record with a cache for a now-
  // missing persona.
  it('skips the cache write when the persona is gone in the fresh read', async () => {
    (userDb.getUserById as jest.Mock)
      .mockResolvedValueOnce({ userId: 'u1', icpResult: [persona()] })
      .mockResolvedValueOnce({ userId: 'u1', icpResult: [] }); // deleted concurrently
    (extractIcpFiltersWithLlm as jest.Mock).mockResolvedValue(llmVariants());

    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(userDb.updateUser).not.toHaveBeenCalled();
    const body = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(body.variants).toEqual(llmVariants());
  });

  // Edge case: if the persona at icpIndex was *edited* (content changed)
  // between the initial read and the post-LLM re-read, the LLM result we
  // just produced is already stale. Skip the write — next click will
  // regenerate against the now-current content.
  it('skips the cache write when the persona content changed during the LLM call', async () => {
    (userDb.getUserById as jest.Mock)
      .mockResolvedValueOnce({ userId: 'u1', icpResult: [persona()] })
      .mockResolvedValueOnce({
        userId: 'u1',
        icpResult: [persona({ name: 'EDITED MID FLIGHT' })],
      });
    (extractIcpFiltersWithLlm as jest.Mock).mockResolvedValue(llmVariants());

    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('still does NOT trigger search or import (regression guard)', async () => {
    const { agentModeService } = require('../services/agentModeService');
    mockReq.query = { icpIndex: '0' };
    await handler!(mockReq, mockRes);
    expect(agentModeService.importLeadsFromSearch).not.toHaveBeenCalled();
  });
});
