import { findOrphanedOrgJoinRequests } from '../services/orphanedOrgJoinRequestService';

const org = (orgId: string, pendingDomainJoinRequests?: any[]) => ({
  orgId,
  name: orgId,
  ownerUserId: 'owner',
  createdAt: '',
  updatedAt: '',
  pendingDomainJoinRequests,
});

describe('findOrphanedOrgJoinRequests', () => {
  it('returns zero counts and audits an empty scan', async () => {
    const audit = jest.fn();
    await expect(findOrphanedOrgJoinRequests({ listOrganizations: async () => [], findUser: jest.fn(), audit }))
      .resolves.toEqual({ organizationsScanned: 0, pendingRequestsScanned: 0, missingUserReferences: [], truncated: false });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'inspect_orphaned_org_join_requests' }));
  });

  it('returns only bounded orgId/userId references for missing users', async () => {
    const findUser = jest.fn(async (userId: string) => userId === 'present' ? {} : null);
    const audit = jest.fn();
    const result = await findOrphanedOrgJoinRequests({
      listOrganizations: async () => [org('org-1', [
        { userId: 'present', email: 'hidden@example.com', requestToken: 'secret' },
        { userId: 'missing', email: 'hidden@example.com', requestToken: 'secret' },
        { email: 'malformed' },
      ])], findUser, audit,
    });
    expect(result).toEqual({ organizationsScanned: 1, pendingRequestsScanned: 2, missingUserReferences: [{ orgId: 'org-1', userId: 'missing' }], truncated: false });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('propagates adapter failures without auditing a false success', async () => {
    const audit = jest.fn();
    await expect(findOrphanedOrgJoinRequests({ listOrganizations: async () => { throw new Error('read failed'); }, findUser: jest.fn(), audit }))
      .rejects.toThrow('read failed');
    expect(audit).not.toHaveBeenCalled();
  });

  it('marks the result truncated only when a reference exceeds the cap', async () => {
    const audit = jest.fn();
    const exactlyAtCap = Array.from({ length: 100 }, (_, index) => org(`org-${index}`, [{ userId: `missing-${index}` }]));
    await expect(findOrphanedOrgJoinRequests({
      listOrganizations: async () => exactlyAtCap,
      findUser: async () => null,
      audit,
    })).resolves.toMatchObject({ missingUserReferences: expect.arrayContaining([{ orgId: 'org-99', userId: 'missing-99' }]), truncated: false });

    await expect(findOrphanedOrgJoinRequests({
      listOrganizations: async () => [...exactlyAtCap, org('org-100', [{ userId: 'missing-100' }])],
      findUser: async () => null,
      audit,
    })).resolves.toMatchObject({ truncated: true });
  });
});
