import * as v0Service from '../services/v0Service';
import { resolveSiteForCaller } from '../services/v0Service';

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockGetOrgMembers = jest.fn();
const mockCanEditItem = jest.fn();

jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: {
    getOrgById: (...a: any[]) => mockGetOrgById(...a),
    getOrgMembers: (...a: any[]) => mockGetOrgMembers(...a),
  },
}));
jest.mock('../services/orgShareService', () => ({
  canEditItem: (...a: any[]) => mockCanEditItem(...a),
}));

// We spy on the exported findUserSiteRecord so the internal call in
// resolveSiteForCaller picks up the mock (CommonJS module — spyOn works).
let findSiteSpy: jest.SpyInstance;

describe('resolveSiteForCaller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findSiteSpy = jest.spyOn(v0Service, 'findUserSiteRecord');
  });

  afterEach(() => {
    findSiteSpy.mockRestore();
  });

  it("returns the caller's own site when present", async () => {
    findSiteSpy.mockResolvedValueOnce({ id: 'p1', userId: 'u1' });
    const result = await resolveSiteForCaller('u1');
    expect(result).toEqual({ id: 'p1', userId: 'u1' });
    expect(findSiteSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when caller has no site and no org', async () => {
    findSiteSpy.mockResolvedValueOnce(null);
    mockGetUserById.mockResolvedValueOnce({ userId: 'u1', orgId: undefined });
    const result = await resolveSiteForCaller('u1');
    expect(result).toBeNull();
  });

  it("returns org-member's site when caller has org-edit access", async () => {
    findSiteSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p2', userId: 'u2' });
    mockGetUserById.mockResolvedValueOnce({ userId: 'u1', orgId: 'org1', orgRole: 'member' });
    mockGetOrgMembers.mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }]);
    mockGetOrgById.mockResolvedValueOnce({ orgId: 'org1' });
    mockCanEditItem.mockReturnValueOnce(true);
    const result = await resolveSiteForCaller('u1');
    expect(result).toEqual({ id: 'p2', userId: 'u2' });
  });

  it('returns null when org members exist but canEditItem denies', async () => {
    findSiteSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p2', userId: 'u2' });
    mockGetUserById.mockResolvedValueOnce({ userId: 'u1', orgId: 'org1', orgRole: 'member' });
    mockGetOrgMembers.mockResolvedValueOnce([{ userId: 'u2' }]);
    mockGetOrgById.mockResolvedValueOnce({ orgId: 'org1' });
    mockCanEditItem.mockReturnValueOnce(false);
    const result = await resolveSiteForCaller('u1');
    expect(result).toBeNull();
  });

  it('skips members without a site and returns the next eligible', async () => {
    findSiteSpy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p3', userId: 'u3' });
    mockGetUserById.mockResolvedValueOnce({ userId: 'u1', orgId: 'org1', orgRole: 'member' });
    mockGetOrgMembers.mockResolvedValueOnce([{ userId: 'u2' }, { userId: 'u3' }]);
    mockGetOrgById.mockResolvedValueOnce({ orgId: 'org1' });
    mockCanEditItem.mockReturnValueOnce(true);
    const result = await resolveSiteForCaller('u1');
    expect(result).toEqual({ id: 'p3', userId: 'u3' });
  });
});
