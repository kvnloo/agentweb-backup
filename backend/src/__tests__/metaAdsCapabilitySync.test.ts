/**
 * ENG-1158 — reconcile recorded Meta Ads capability against Meta's own answer.
 *
 * Two gaps this closes, both found by reading the live record for account
 * 922903076601160 rather than the code:
 *
 *  - RECOVERY. `ads_scope_revoked_at` was only ever cleared by our own OAuth
 *    reconnect (which replaces the config wholesale). An owner who re-granted
 *    the Ads permission out of band — on Meta's Business Integrations page,
 *    which is a normal thing to do — stayed locked out indefinitely: the
 *    pre-flight gate refuses locally in ~100ms and nothing re-reads the grant.
 *
 *  - PROACTIVE DETECTION. Scope loss was only noticed when a run happened to
 *    attempt a Meta read. A paused schedule, or none at all, meant silence.
 *
 * Capability is settled by ATTEMPTING an ads read, never by reading scopes. Two
 * independent grants must line up — the user granting our app `ads_read`, and
 * the ad account's owner granting that user access to that ad account — and a
 * token's scopes only show the first. Verified live: production account
 * 922903076601160 reports `ads_read` granted via /me/permissions while the same
 * token is refused by the ad account itself. Reconciling on scopes would have
 * declared the reported account healthy and cleared the refusal protecting it.
 *
 * The asymmetry that governs every case below: Meta's answer is authoritative
 * only when we actually get one. Anything that is not a clear yes or a clear
 * ads-scope refusal is 'unknown', and acting on it would revoke working
 * connections during a Meta outage.
 */

const mockProbeAdsAccountAccess = jest.fn();
jest.mock('../services/metaService', () => ({
  metaService: {
    probeAdsAccountAccess: (...args: any[]) => mockProbeAdsAccountAccess(...args),
  },
}));

const mockUpdateAccountConfig = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/connectedAccountsDb', () => {
  const actual = jest.requireActual('../services/connectedAccountsDb');
  return {
    ...actual,
    updateAccountConfig: (...args: any[]) => mockUpdateAccountConfig(...args),
  };
});

const mockNotifyMetaAdsScopeLost = jest.fn().mockResolvedValue(true);
jest.mock('../services/metaAdsScopeAlertService', () => ({
  notifyMetaAdsScopeLost: (...args: any[]) => mockNotifyMetaAdsScopeLost(...args),
}));

import { syncMetaAdsCapability } from '../services/metaAdsCapabilitySync';
import { getMetaAdsScopeState } from '../utils/metaAdsScope';

const AD_ACCOUNT_ID = '922903076601160';

const metaAccount = (config: Record<string, any>) =>
  ({
    platform: 'meta',
    account_id: AD_ACCOUNT_ID,
    account_name: 'AgentWeb',
    config: {
      account_type: 'ad_account',
      ad_account_id: AD_ACCOUNT_ID,
      access_token: 'EAA-token',
      token_expires_at: Date.now() + 86_400_000,
      ...config,
    },
  }) as any;

/** The exact production state this ticket was filed about. */
const latchedAccount = () =>
  metaAccount({ granted_scopes: [], ads_scope_revoked_at: '2026-07-31T07:00:21.688Z' });

describe('syncMetaAdsCapability (ENG-1158)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateAccountConfig.mockResolvedValue(undefined);
    mockNotifyMetaAdsScopeLost.mockResolvedValue(true);
  });

  describe('recovery — the owner re-granted the permission outside our OAuth flow', () => {
    it('retracts the revocation when the ad account actually serves a read', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = latchedAccount();

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('recovered');
      const [, , , updates, options] = mockUpdateAccountConfig.mock.calls[0];
      expect(options.unset).toEqual(
        expect.arrayContaining(['ads_scope_revoked_at', 'ads_scope_alerted_at'])
      );
      // Nothing is asserted about the grant itself: we proved the read works,
      // not what the user granted. Writing an ads scope here would fabricate
      // provenance for a field that means "what Meta told us".
      expect(updates.granted_scopes).toBeUndefined();
    });

    it('probes the ad account, not the token scopes', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');

      await syncMetaAdsCapability(latchedAccount(), 'user1');

      expect(mockProbeAdsAccountAccess).toHaveBeenCalledWith('EAA-token', AD_ACCOUNT_ID);
    });

    it('leaves the account genuinely usable again, not merely re-labelled', async () => {
      // The end state is what matters: the pre-flight gate must stop refusing.
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = latchedAccount();

      await syncMetaAdsCapability(account, 'user1');

      expect(getMetaAdsScopeState(account.config)).not.toBe('missing');
    });

    /**
     * The realistic post-revocation shape, and the one the fixtures missed. A
     * revocation NARROWS granted_scopes rather than emptying it, so a recovered
     * account is left holding e.g. ['pages_show_list'] — and getMetaAdsScopeState
     * reads a non-empty grant with no ads scope as a proven 'missing', its final
     * fallthrough. Clearing only the markers therefore leaves the gate refusing
     * and the row disconnected: recovery that does not recover.
     */
    it('recovers an account whose grant was narrowed by an earlier revocation', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = metaAccount({
        granted_scopes: ['pages_show_list', 'pages_read_engagement', 'public_profile'],
        ads_scope_revoked_at: '2026-07-31T07:00:21.688Z',
        ads_scope_alerted_at: '2026-08-13T07:00:00.000Z',
      });

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('recovered');
      expect(getMetaAdsScopeState(account.config)).not.toBe('missing');
    });

    it('drops the narrowed grant rather than leaving a value we derived', async () => {
      // What remains is our own subtraction, not anything Meta reported, so it
      // cannot be trusted as a grant record. Absent reads as 'unknown', which is
      // the honest answer: we proved the read works, not what was granted.
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = metaAccount({
        granted_scopes: ['pages_show_list'],
        ads_scope_revoked_at: '2026-07-31T07:00:21.688Z',
      });

      await syncMetaAdsCapability(account, 'user1');

      const [, , , , options] = mockUpdateAccountConfig.mock.calls[0];
      expect(options.unset).toContain('granted_scopes');
      expect(account.config.granted_scopes).toBeUndefined();
    });

    it('reports a cleared suspicion as unchanged, not as a recovery', async () => {
      // Nothing user-visible was ever wrong, so counting it as a recovery would
      // make a transient blip read in monitoring as a customer outage resolved.
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = metaAccount({
        granted_scopes: ['ads_read'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('unchanged');
      expect(account.config.ads_scope_denied_seen_at).toBeUndefined();
    });

    it('does not write when a capable account is already recorded as capable', async () => {
      // The overwhelmingly common case every 12 hours. It must be a no-op.
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');

      const result = await syncMetaAdsCapability(metaAccount({ granted_scopes: ['ads_read'] }), 'user1');

      expect(result.outcome).toBe('unchanged');
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
      expect(mockNotifyMetaAdsScopeLost).not.toHaveBeenCalled();
    });
  });

  /**
   * A single denied probe is weak evidence. Meta returns the ads refusal for
   * transient reasons too — Business Manager permission changes take time to
   * propagate — and acting on one observation means stripping a working
   * customer's grant and emailing them about an outage that already ended.
   *
   * Two consecutive denials, a sweep apart, is strong evidence. The cost of
   * waiting is 12 more hours on a problem that had already run for 13 days
   * unnoticed; the cost of being wrong is a broken connection and a false alarm.
   */
  describe('a first denial is suspected, not acted on', () => {
    it('records the suspicion without stripping the grant or alerting', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = metaAccount({ granted_scopes: ['ads_read', 'pages_show_list'] });

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('suspected');
      expect(mockNotifyMetaAdsScopeLost).not.toHaveBeenCalled();
      const [, , , updates] = mockUpdateAccountConfig.mock.calls[0];
      expect(typeof updates.ads_scope_denied_seen_at).toBe('string');
      expect(updates.granted_scopes).toBeUndefined();
      expect(updates.ads_scope_revoked_at).toBeUndefined();
      // The connection keeps working in the meantime.
      expect(getMetaAdsScopeState(account.config)).not.toBe('missing');
    });

    it('acts on the second consecutive denial', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = metaAccount({
        granted_scopes: ['ads_read', 'pages_show_list'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('revoked');
      expect(mockNotifyMetaAdsScopeLost).toHaveBeenCalledTimes(1);
      expect(getMetaAdsScopeState(account.config)).toBe('missing');
    });

    it('forgets the suspicion as soon as one probe succeeds', async () => {
      // Otherwise a denial today and an unrelated one next month would combine
      // into a "confirmed" outage that never actually persisted.
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = metaAccount({
        granted_scopes: ['ads_read'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });

      await syncMetaAdsCapability(account, 'user1');

      const [, , , , options] = mockUpdateAccountConfig.mock.calls[0];
      expect(options.unset).toContain('ads_scope_denied_seen_at');
      expect(account.config.ads_scope_denied_seen_at).toBeUndefined();
    });

    it('acts immediately when the refusal is already on record', async () => {
      // An account the agent path already caught does not need re-confirming.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');

      const result = await syncMetaAdsCapability(latchedAccount(), 'user1');

      expect(result.outcome).toBe('revoked');
      expect(mockNotifyMetaAdsScopeLost).toHaveBeenCalledTimes(1);
    });
  });

  describe('alert budget', () => {
    it('still records the revocation when the alert budget is spent', async () => {
      // Protection must not depend on there being room to send mail.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = latchedAccount();

      const result = await syncMetaAdsCapability(account, 'user1', { allowAlert: false });

      expect(result.outcome).toBe('revoked');
      expect(result.alerted).toBe(false);
      expect(mockNotifyMetaAdsScopeLost).not.toHaveBeenCalled();
      expect(getMetaAdsScopeState(account.config)).toBe('missing');
      expect(account.config.ads_scope_alerted_at).toBeUndefined();
    });

    it('leaves the notice unrecorded so a later sweep can still send it', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = latchedAccount();

      await syncMetaAdsCapability(account, 'user1', { allowAlert: false });

      expect(account.config.ads_scope_alerted_at).toBeUndefined();
    });

    it('reports that it alerted when the budget allows', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');

      const result = await syncMetaAdsCapability(latchedAccount(), 'user1', { allowAlert: true });

      expect(result.alerted).toBe(true);
    });
  });

  describe('proactive detection — scope lost with no run to notice it', () => {
    it('records the revocation and alerts the owner', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');

      const result = await syncMetaAdsCapability(
        metaAccount({
          granted_scopes: ['ads_read', 'pages_show_list'],
          ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
        }),
        'user1'
      );

      expect(result.outcome).toBe('revoked');
      const [userId, platform, accountId, updates] = mockUpdateAccountConfig.mock.calls[0];
      expect(userId).toBe('user1');
      expect(platform).toBe('meta');
      expect(accountId).toBe(AD_ACCOUNT_ID);
      expect(typeof updates.ads_scope_revoked_at).toBe('string');
      // The grant must be narrowed too, or the revocation is inert — see below.
      expect(updates.granted_scopes).toEqual(['pages_show_list']);
      expect(mockNotifyMetaAdsScopeLost).toHaveBeenCalledWith(
        expect.objectContaining({ ownerUserId: 'user1', accountId: AD_ACCOUNT_ID })
      );
    });

    /**
     * Caught by running the reconciler against a real denied account: the marker
     * was written and getMetaAdsScopeState still returned 'granted', because an
     * affirmative ads scope in `granted_scopes` outranks `ads_scope_revoked_at`.
     * The revocation was recorded and changed nothing — the gate kept letting
     * reads through and Settings kept saying "Active".
     */
    it('makes the revocation actually take effect, not merely record it', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = metaAccount({
        granted_scopes: ['ads_read', 'pages_show_list'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });

      await syncMetaAdsCapability(account, 'user1');

      expect(getMetaAdsScopeState(account.config)).toBe('missing');
    });

    it('alerts the owner of an account latched before any alert existed', async () => {
      // Already revoked, never told. The sweep is the only thing that reaches
      // this owner if their schedule is paused.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');

      const result = await syncMetaAdsCapability(latchedAccount(), 'user1');

      expect(result.outcome).toBe('revoked');
      expect(mockNotifyMetaAdsScopeLost).toHaveBeenCalledTimes(1);
    });

    it('does not alert twice for the same outage', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');

      const result = await syncMetaAdsCapability(
        metaAccount({
          granted_scopes: [],
          ads_scope_revoked_at: '2026-07-31T07:00:21.688Z',
          ads_scope_alerted_at: '2026-08-13T07:00:00.000Z',
        }),
        'user1'
      );

      expect(result.outcome).toBe('unchanged');
      expect(mockNotifyMetaAdsScopeLost).not.toHaveBeenCalled();
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

    /**
     * The marker is claimed before sending so a mail failure cannot become a
     * twice-daily loop. But keeping it when nothing was delivered would record
     * the owner as told when they never were, and every later run trusts it —
     * so the claim only stands if the notice actually went out (Greptile P1).
     */
    it('records no notice when nothing was delivered, so a later run retries', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockNotifyMetaAdsScopeLost.mockResolvedValue(false);
      const account = latchedAccount();

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.alerted).toBe(false);
      expect(account.config.ads_scope_alerted_at).toBeUndefined();
      // No write ever carries the marker — there is nothing to retract, so no
      // second failure can leave a permanent false acknowledgement.
      for (const call of mockUpdateAccountConfig.mock.calls) {
        expect(call[3]?.ads_scope_alerted_at).toBeUndefined();
      }
      // The revocation itself stands — protection is not undone by a mail failure.
      expect(getMetaAdsScopeState(account.config)).toBe('missing');
    });

    it('never records the notice in the same write as the revocation', async () => {
      // The revocation must land whatever happens to the mail; coupling them is
      // what created the acknowledge-then-retract problem.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockNotifyMetaAdsScopeLost.mockResolvedValue(true);

      await syncMetaAdsCapability(latchedAccount(), 'user1');

      const revocationWrite = mockUpdateAccountConfig.mock.calls[0][3];
      expect(typeof revocationWrite.ads_scope_revoked_at).toBe('string');
      expect(revocationWrite.ads_scope_alerted_at).toBeUndefined();
    });

    it('still reports success when the notice went out but could not be recorded', async () => {
      // Bounded repetition (a later sweep tells them again) beats silence.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockNotifyMetaAdsScopeLost.mockResolvedValue(true);
      mockUpdateAccountConfig
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('dynamo unavailable'));

      const result = await syncMetaAdsCapability(latchedAccount(), 'user1');

      expect(result.outcome).toBe('revoked');
      expect(result.alerted).toBe(true);
    });

    it('keeps the notice when it was delivered', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockNotifyMetaAdsScopeLost.mockResolvedValue(true);
      const account = latchedAccount();

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.alerted).toBe(true);
      expect(typeof account.config.ads_scope_alerted_at).toBe('string');
    });

    it('does not email when the notice could not be recorded', async () => {
      // Without a durable marker nothing stops the next sweep emailing again —
      // and this one runs every 12 hours, forever.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockUpdateAccountConfig.mockRejectedValue(new Error('DynamoDB unavailable'));

      const result = await syncMetaAdsCapability(latchedAccount(), 'user1');

      expect(result.outcome).toBe('error');
      expect(mockNotifyMetaAdsScopeLost).not.toHaveBeenCalled();
    });
  });

  describe('never acts on absence of proof', () => {
    it('does nothing when Meta could not give a clear answer', async () => {
      // A Meta outage must not revoke every connection we have.
      mockProbeAdsAccountAccess.mockResolvedValue('unknown');

      const result = await syncMetaAdsCapability(metaAccount({ granted_scopes: ['ads_read'] }), 'user1');

      expect(result.outcome).toBe('undetermined');
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
      expect(mockNotifyMetaAdsScopeLost).not.toHaveBeenCalled();
    });

    it('does not clear a revocation when access cannot be determined', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('unknown');
      const account = latchedAccount();

      await syncMetaAdsCapability(account, 'user1');

      expect(getMetaAdsScopeState(account.config)).toBe('missing');
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

    it('never throws when Meta itself throws', async () => {
      mockProbeAdsAccountAccess.mockRejectedValue(new Error('ECONNRESET'));

      const result = await syncMetaAdsCapability(latchedAccount(), 'user1');

      expect(result.outcome).toBe('error');
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

    it('skips accounts that are not Meta ad accounts', async () => {
      const page = metaAccount({ account_type: 'page', granted_scopes: [] });

      const result = await syncMetaAdsCapability(page, 'user1');

      expect(result.outcome).toBe('skipped');
      expect(mockProbeAdsAccountAccess).not.toHaveBeenCalled();
    });

    it('skips an account with no access token to ask with', async () => {
      const tokenless = metaAccount({ granted_scopes: [] });
      delete tokenless.config.access_token;

      const result = await syncMetaAdsCapability(tokenless, 'user1');

      expect(result.outcome).toBe('skipped');
      expect(mockProbeAdsAccountAccess).not.toHaveBeenCalled();
    });
  });
});
