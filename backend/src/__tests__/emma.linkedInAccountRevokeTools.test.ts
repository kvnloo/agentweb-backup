// ENG-1153: inspect/revoke LinkedIn Outreach account + neutralize queued engagement actions.
const getAccountsByUserId = jest.fn();
const getAccountsWithOwnerIncludingOrgShared = jest.fn();
const deleteAccountById = jest.fn();
const getSchedulesByUserId = jest.fn();
const updateSchedule = jest.fn();
const deleteUnipile = jest.fn();
const canCallerDisconnectAccount = jest.fn();

jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserId, getAccountsWithOwnerIncludingOrgShared, deleteAccountById }));
jest.mock('../services/db', () => ({ scheduleDb: { getSchedulesByUserId, updateSchedule } }));
jest.mock('../services/linkedInOutreachService', () => ({ linkedInOutreachService: { deleteAccount: deleteUnipile } }));
jest.mock('../routes/connectedAccounts', () => ({ canCallerDisconnectAccount }));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/linkedInAccountRevokeTools';

const ctx = { userId: 'u1' };
const acct = { platform: 'unipile', account_id: 'acc1', account_name: 'Rui', config: { access_token: 'SECRET' } };
const action = (id: string, extra: any = {}) => ({
  scheduleId: id, type: 'social_engagement_action', status: 'active', nextRunTime: '2026-10-21T00:00:00Z',
  variableValues: { engagingAccountId: 'acc1', ownerAccountId: 'acc1', actionType: 'like', postId: 'p' }, ...extra,
});

describe('ENG-1153 LinkedIn revoke tools', () => {
  let connected: any[];
  let shared: any[];
  beforeEach(() => {
    jest.clearAllMocks();
    connected = [acct, { platform: 'gmail', account_id: 'g', config: {} }];
    getAccountsByUserId.mockImplementation(async () => connected);
    shared = [];
    getAccountsWithOwnerIncludingOrgShared.mockImplementation(async () => [...connected.map((a) => ({ ...a, userId: 'u1' })), ...shared]);
    deleteAccountById.mockImplementation(async () => { connected = connected.filter((a) => a.account_id !== 'acc1'); });
    let schedules = [action('s1'), action('s2'), action('other', { variableValues: { engagingAccountId: 'acc2', ownerAccountId: 'acc2' } }), { scheduleId: 'chat', type: 'chat', status: 'active' }];
    getSchedulesByUserId.mockImplementation(async () => schedules);
    updateSchedule.mockImplementation(async (id: string, u: any) => { schedules = schedules.map((s) => (s.scheduleId === id ? { ...s, ...u } : s)); });
    canCallerDisconnectAccount.mockResolvedValue({ allowed: true });
  });

  it('inspect lists accounts without tokens and queued actions for the selected account', async () => {
    const r = await emmaToolRegistry.execute('inspect_linkedin_account', { account_id: 'acc1' }, ctx);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(r.accounts).toEqual([expect.objectContaining({ accountId: 'acc1', name: 'Rui' })]);
    expect(r.queuedActions.map((a: any) => a.scheduleId)).toEqual(['s1', 's2']);
  });

  it('revoke requires explicit confirmation and does nothing without it', async () => {
    const r = await emmaToolRegistry.execute('revoke_linkedin_account', { account_id: 'acc1' }, ctx);
    expect(r.revoked).toBe(false);
    expect(deleteUnipile).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  it('revoke pauses queued actions, revokes at provider, removes account, reports final state', async () => {
    const r = await emmaToolRegistry.execute('revoke_linkedin_account', { account_id: 'acc1', confirm: true }, ctx);
    expect(updateSchedule.mock.calls.map((c) => c[0])).toEqual(['s1', 's2']);
    expect(updateSchedule).toHaveBeenCalledWith('s1', { status: 'paused' });
    expect(deleteUnipile).toHaveBeenCalledWith('acc1');
    expect(r).toEqual(expect.objectContaining({ revoked: true, providerRevoked: true, cancelledActions: ['s1', 's2'], notCancelled: [] }));
  });

  it('reports actions that could not be cancelled and provider failure', async () => {
    updateSchedule.mockImplementationOnce(async () => { throw new Error('ddb down'); });
    deleteUnipile.mockRejectedValueOnce(new Error('unipile 500'));
    const r = await emmaToolRegistry.execute('revoke_linkedin_account', { account_id: 'acc1', confirm: true }, ctx);
    expect(r.notCancelled).toEqual([{ scheduleId: 's1', error: 'ddb down' }]);
    expect(r.providerRevoked).toBe(false);
    expect(r.providerError).toBe('unipile 500');
    expect(r.revoked).toBe(false);
    expect(deleteAccountById).not.toHaveBeenCalled();
    expect(r.removedFromAgentWeb).toBe(false);
  });

  it('reports local cleanup failure after provider revocation and preserves final state', async () => {
    deleteAccountById.mockRejectedValueOnce(new Error('local cleanup failed'));
    const audit = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const r = await emmaToolRegistry.execute('revoke_linkedin_account', { account_id: 'acc1', confirm: true }, ctx);
      expect(r).toEqual(expect.objectContaining({
        revoked: false, providerRevoked: true, removedFromAgentWeb: false,
        localError: 'local cleanup failed', cancelledActions: ['s1', 's2'], notCancelled: [],
      }));
      expect(audit).toHaveBeenCalledWith(expect.stringContaining('[Audit][ENG-1153]'));
    } finally {
      audit.mockRestore();
    }
  });

  it('cannot touch an account not connected to the caller (cross-tenant)', async () => {
    const r = await emmaToolRegistry.execute('revoke_linkedin_account', { account_id: 'acc-other-tenant', confirm: true }, ctx);
    expect(r.revoked).toBe(false);
    expect(deleteUnipile).not.toHaveBeenCalled();
    expect(deleteAccountById).not.toHaveBeenCalled();
    const i = await emmaToolRegistry.execute('inspect_linkedin_account', { account_id: 'acc-other-tenant' }, ctx);
    expect(i.queuedActions).toBeUndefined();
  });

  it('honours the org-shared owner guard', async () => {
    canCallerDisconnectAccount.mockResolvedValueOnce({ allowed: false, error: 'Only the org owner' });
    const r = await emmaToolRegistry.execute('revoke_linkedin_account', { account_id: 'acc1', confirm: true }, ctx);
    expect(r).toEqual({ revoked: false, error: 'Only the org owner' });
    expect(deleteUnipile).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  describe('ENG-3108 org-shared accounts in inspect', () => {
    const mate = { platform: 'unipile', account_id: 'mate1', account_name: 'Teammate', sharedWithOrg: true, connected_at: '2026-11-01T00:00:00Z', userId: 'u2', config: { access_token: 'MATESECRET' } };
    const ownEntry = { accountId: 'acc1', name: 'Rui', sharedWithOrg: false, connectedAt: undefined };

    it('with no shared account the result is the same as before', async () => {
      expect(await emmaToolRegistry.execute('inspect_linkedin_account', {}, ctx)).toEqual({ accounts: [ownEntry] });
    });

    it('lists a teammate-shared account marked as shared and not revocable, own entry unmarked', async () => {
      shared = [mate, { ...mate, platform: 'gmail', account_id: 'mateg' }];
      const r = await emmaToolRegistry.execute('inspect_linkedin_account', {}, ctx);
      expect(r).toEqual({
        accounts: [
          ownEntry,
          { accountId: 'mate1', name: 'Teammate', sharedWithOrg: true, connectedAt: '2026-11-01T00:00:00Z', sharedByTeammate: true, revocableByCaller: false },
        ],
      });
      expect(JSON.stringify(r)).not.toContain('SECRET');
    });

    it('asking for a shared account by id returns its entry, no error, and does not read its queued actions', async () => {
      shared = [mate];
      const r = await emmaToolRegistry.execute('inspect_linkedin_account', { account_id: 'mate1' }, ctx);
      expect(r.error).toBeUndefined();
      expect(r.accountId).toBe('mate1');
      expect(r.account).toEqual(expect.objectContaining({ accountId: 'mate1', sharedByTeammate: true, revocableByCaller: false }));
      expect(r.queuedActions).toBeUndefined();
      expect(getSchedulesByUserId).not.toHaveBeenCalled();
    });

    it('an id the caller cannot reach keeps the existing not-connected text', async () => {
      shared = [mate];
      const r = await emmaToolRegistry.execute('inspect_linkedin_account', { account_id: 'nope' }, ctx);
      expect(r.error).toBe('No LinkedIn Outreach account nope is connected to this user.');
      expect(r.account).toBeUndefined();
    });

    it('revoke of a teammate-shared account is still refused and touches nothing', async () => {
      shared = [mate];
      const r = await emmaToolRegistry.execute('revoke_linkedin_account', { account_id: 'mate1', confirm: true }, ctx);
      expect(r).toEqual({ revoked: false, error: 'No LinkedIn Outreach account mate1 is connected to this user.' });
      expect(deleteUnipile).not.toHaveBeenCalled();
      expect(deleteAccountById).not.toHaveBeenCalled();
      expect(updateSchedule).not.toHaveBeenCalled();
      expect(canCallerDisconnectAccount).not.toHaveBeenCalled();
    });
  });
});
