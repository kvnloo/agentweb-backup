/**
 * ENG-2937: get_leads_needing_followup failed 100% because lists rarely carry
 * linkedInAccountId. It must fall back to the caller's own connected account.
 */
const getLeadListById = jest.fn();
const canOrgMemberAccessList = jest.fn();
const getLeadsByListId = jest.fn();
const getUserById = jest.fn();
const resolveUserOwnedAccountId = jest.fn();
const getAllConnectionsByAccount = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: { getLeadListById, canOrgMemberAccessList, getLeadsByListId },
  userDb: { getUserById },
}));
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { resolveUserOwnedAccountId },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomain: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/unipileConnectionsDb', () => ({
  getAllConnectionsByAccount,
  normalizeLinkedInUrl: (u: string) => String(u || '').trim().toLowerCase(),
}));

import { getLeadsNeedingFollowup } from '../emma/impl/leads';

describe('ENG-2937 getLeadsNeedingFollowup account resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    canOrgMemberAccessList.mockResolvedValue(true);
    getUserById.mockResolvedValue({ emailDomain: 'acme.com' });
    getAllConnectionsByAccount.mockResolvedValue([]);
    getLeadsByListId.mockResolvedValue({ leads: [], lastEvaluatedKey: undefined });
  });

  it('falls back to the user-owned LinkedIn account when the list has none', async () => {
    getLeadListById.mockResolvedValue({ id: 'L1', userId: 'u1' });
    resolveUserOwnedAccountId.mockResolvedValue('acct-user');

    const result = await getLeadsNeedingFollowup('L1', 'u1');

    expect(resolveUserOwnedAccountId).toHaveBeenCalledWith('u1');
    expect(getAllConnectionsByAccount).toHaveBeenCalledWith('acct-user');
    expect(result.success).not.toBe(false);
  });

  it('prefers the list-assigned account over the fallback', async () => {
    getLeadListById.mockResolvedValue({ id: 'L1', userId: 'u1', linkedInAccountId: 'acct-list' });

    await getLeadsNeedingFollowup('L1', 'u1');

    expect(resolveUserOwnedAccountId).not.toHaveBeenCalled();
    expect(getAllConnectionsByAccount).toHaveBeenCalledWith('acct-list');
  });

  it('returns an actionable structured error when no account is connected', async () => {
    getLeadListById.mockResolvedValue({ id: 'L1', userId: 'u1' });
    resolveUserOwnedAccountId.mockResolvedValue(null);

    const result = await getLeadsNeedingFollowup('L1', 'u1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connect LinkedIn/);
    expect(getAllConnectionsByAccount).not.toHaveBeenCalled();
  });
});
