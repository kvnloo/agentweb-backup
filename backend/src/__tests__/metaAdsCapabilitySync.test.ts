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
const mockClassifyAdsRefusalTier = jest.fn().mockResolvedValue('unknown');
jest.mock('../services/metaService', () => ({
  metaService: {
    probeAdsAccountAccess: (...args: any[]) => mockProbeAdsAccountAccess(...args),
    classifyAdsRefusalTier: (...args: any[]) => mockClassifyAdsRefusalTier(...args),
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

/**
 * updateAccountConfig's 4th arg is now either a plain object or a function of
 * the freshly-read config (Greptile P1: a CAS retry must recompute a derived
 * update from what it actually reads, not reapply a stale precomputed one).
 * Resolves either form against `freshConfig` the way the real CAS loop would.
 */
const resolveMutation = (call: any[], freshConfig: Record<string, any>) => {
  const [, , , configUpdates, options] = call;
  if (typeof configUpdates === 'function') {
    return configUpdates(freshConfig);
  }
  return { updates: configUpdates, unset: options?.unset };
};

describe('syncMetaAdsCapability (ENG-1158)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateAccountConfig.mockResolvedValue(undefined);
    mockClassifyAdsRefusalTier.mockResolvedValue('unknown');
  });

  describe('recovery — the owner re-granted the permission outside our OAuth flow', () => {
    it('retracts the revocation when the ad account actually serves a read', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = latchedAccount();
      const configSnapshot = { ...account.config };

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('recovered');
      const { updates, unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(unset).toEqual(
        expect.arrayContaining(['ads_scope_revoked_at', 'granted_scopes'])
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
      const configSnapshot = { ...account.config };

      await syncMetaAdsCapability(account, 'user1');

      const { unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(unset).toContain('granted_scopes');
      expect(account.config.granted_scopes).toBeUndefined();
    });

    it('clears the recorded tier along with the refusal it retracts', async () => {
      // A stale 'asset' tier surviving a recovery would keep pointing an owner
      // at Business Manager for a connection that is fully healthy again.
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = metaAccount({
        granted_scopes: [],
        ads_scope_revoked_at: '2026-07-31T07:00:21.688Z',
        ads_scope_tier: 'asset',
      });
      const configSnapshot = { ...account.config };

      await syncMetaAdsCapability(account, 'user1');

      const { unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(unset).toContain('ads_scope_tier');
      expect(account.config.ads_scope_tier).toBeUndefined();
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
      const configSnapshot = { ...account.config };

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('suspected');
      const { updates } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(typeof updates.ads_scope_denied_seen_at).toBe('string');
      expect(updates.granted_scopes).toBeUndefined();
      expect(updates.ads_scope_revoked_at).toBeUndefined();
      // The connection keeps working in the meantime.
      expect(getMetaAdsScopeState(account.config)).not.toBe('missing');
    });

    /**
     * Greptile P1 follow-up (2nd round): the suspicion write is not exempt
     * from the probedAt guard either. Without it, a suspicion delayed past a
     * concurrent recovery could still land afterward, sit unmarked as stale,
     * and let a later UNRELATED denial read it as "already suspected" —
     * skipping the two-strike wait and false-confirming a revocation the
     * recovery had already disproved.
     */
    it('does not record a suspicion that a newer recovery has already superseded', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = metaAccount({ granted_scopes: ['ads_read', 'pages_show_list'] });
      const configSnapshot = { ...account.config };

      const newerFreshConfig = {
        ...configSnapshot,
        ads_capability_probed_at: '3000-01-01T00:00:00.000Z',
      };

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('suspected'); // decided from the (stale) outer read
      const { updates, unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], newerFreshConfig);
      // But the actual persisted write, seeing the newer signal on its own
      // fresh read, must refuse to record the now-superseded suspicion.
      expect(updates).toEqual({});
      expect(unset).toEqual([]);
    });

    it('acts on the second consecutive denial', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = metaAccount({
        granted_scopes: ['ads_read', 'pages_show_list'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('revoked');
      expect(getMetaAdsScopeState(account.config)).toBe('missing');
    });

    it('classifies and records which grant is actually missing on confirmation', async () => {
      // Production shape: the app-level scope is still confirmed present at
      // debug_token, so the gap is on the ad account, not the OAuth connection.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockClassifyAdsRefusalTier.mockResolvedValue('asset');
      const account = metaAccount({
        granted_scopes: ['ads_read'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });
      const configSnapshot = { ...account.config };

      await syncMetaAdsCapability(account, 'user1');

      expect(mockClassifyAdsRefusalTier).toHaveBeenCalledWith('EAA-token');
      expect(account.config.ads_scope_tier).toBe('asset');
      const { updates } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(updates.ads_scope_tier).toBe('asset');
    });

    it('does not assert a tier it could not determine', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockClassifyAdsRefusalTier.mockResolvedValue('unknown');
      const account = metaAccount({
        granted_scopes: ['ads_read'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });
      const configSnapshot = { ...account.config };

      await syncMetaAdsCapability(account, 'user1');

      expect(account.config.ads_scope_tier).toBeUndefined();
      const { unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(unset).toContain('ads_scope_tier');
    });

    it('forgets the suspicion as soon as one probe succeeds', async () => {
      // Otherwise a denial today and an unrelated one next month would combine
      // into a "confirmed" outage that never actually persisted.
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = metaAccount({
        granted_scopes: ['ads_read'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });
      const configSnapshot = { ...account.config };

      await syncMetaAdsCapability(account, 'user1');

      const { unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(unset).toContain('ads_scope_denied_seen_at');
      expect(account.config.ads_scope_denied_seen_at).toBeUndefined();
    });

    it('is a no-op when the refusal is already on record and the tier is already known', async () => {
      // An account the agent path already caught is already reported as
      // degraded by every surface; there is nothing left to record.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');

      const result = await syncMetaAdsCapability(
        metaAccount({
          granted_scopes: [],
          ads_scope_revoked_at: '2026-07-31T07:00:21.688Z',
          ads_scope_tier: 'asset',
        }),
        'user1'
      );

      expect(result.outcome).toBe('unchanged');
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

    /**
     * The account production 922903076601160 was actually found in: latched
     * 'missing' since before tier classification shipped. The confirm-branch
     * above is the only place tier is ever computed, and an already-'missing'
     * account never reaches it again through the normal suspect-then-confirm
     * path while it stays denied — without this backfill, it would carry the
     * generic OAuth-tier message forever, the exact account this whole
     * feature was built for never actually benefiting from it.
     */
    it('backfills the tier for an account latched before tier classification existed', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockClassifyAdsRefusalTier.mockResolvedValue('asset');
      const account = latchedAccount(); // no ads_scope_tier — the real production shape
      const configSnapshot = { ...account.config };

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('unchanged'); // nothing user-visible changes...
      expect(mockClassifyAdsRefusalTier).toHaveBeenCalledWith('EAA-token');
      // ...but the write it would make on a real (non-mocked) CAS loop carries
      // the now-known tier. The mock here doesn't invoke the closure, so the
      // local mirror (`applied`-gated) correctly stays untouched — assert on
      // what the write itself would do, not on the local side effect.
      const { updates } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(updates.ads_scope_tier).toBe('asset');
    });

    it('rejects the backfill write when a concurrent writer already recorded a tier', async () => {
      // Greptile P1: the guard inside the write must actually gate the write,
      // not just be decorative — a fresh read that already carries a tier
      // (another process won the race) must produce a true no-op, which the
      // outer code then must not misreport as an applied backfill.
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockClassifyAdsRefusalTier.mockResolvedValue('asset');
      const account = latchedAccount();
      const concurrentlyWonConfig = { ...account.config, ads_scope_tier: 'oauth' };

      await syncMetaAdsCapability(account, 'user1');

      const { updates, unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], concurrentlyWonConfig);
      expect(updates).toEqual({});
      expect(unset).toEqual([]);
    });

    it('does not backfill when the tier cannot be determined', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockClassifyAdsRefusalTier.mockResolvedValue('unknown');

      const result = await syncMetaAdsCapability(latchedAccount(), 'user1');

      expect(result.outcome).toBe('unchanged');
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

    it('does not re-backfill an account whose tier is already recorded', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      mockClassifyAdsRefusalTier.mockResolvedValue('asset');

      await syncMetaAdsCapability(
        metaAccount({
          granted_scopes: [],
          ads_scope_revoked_at: '2026-07-31T07:00:21.688Z',
          ads_scope_tier: 'oauth',
        }),
        'user1'
      );

      expect(mockClassifyAdsRefusalTier).not.toHaveBeenCalled();
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });
  });


  describe('proactive detection — scope lost with no run to notice it', () => {
    it('records the revocation and alerts the owner', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = metaAccount({
        granted_scopes: ['ads_read', 'pages_show_list'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });
      const configSnapshot = { ...account.config };

      const result = await syncMetaAdsCapability(account, 'user1');

      expect(result.outcome).toBe('revoked');
      const [userId, platform, accountId] = mockUpdateAccountConfig.mock.calls[0];
      expect(userId).toBe('user1');
      expect(platform).toBe('meta');
      expect(accountId).toBe(AD_ACCOUNT_ID);
      const { updates } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(typeof updates.ads_scope_revoked_at).toBe('string');
      // The grant must be narrowed too, or the revocation is inert — see below.
      expect(updates.granted_scopes).toEqual(['pages_show_list']);
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
  });

  /**
   * Greptile P1 follow-up: a plain fresh-read retry only guarantees the WRITE
   * reflects current DB state, not that the DECISION being written is the
   * newer of two independently-arrived-at conclusions. Two processes can each
   * probe Meta for the same account close together — this sweep and a live
   * chat run's read failure — and reach opposite answers. Whichever write
   * loses a CAS conflict must not reapply its own now-stale decision over a
   * newer one that landed in between.
   */
  describe('a newer probe elsewhere always wins (probedAt guard)', () => {
    it('does not reverse a recovery that was probed more recently than this denial', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = metaAccount({
        granted_scopes: ['ads_read', 'pages_show_list'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });
      const configSnapshot = { ...account.config };

      // Simulate: between this call's probe and its write, a concurrent
      // recovery landed with a probe timestamp in the future relative to
      // whatever this call captures internally (any probedAt this call
      // computes falls before "the year 3000").
      const newerFreshConfig = {
        ...configSnapshot,
        granted_scopes: ['ads_read', 'pages_show_list'],
        ads_capability_probed_at: '3000-01-01T00:00:00.000Z',
      };
      delete newerFreshConfig.ads_scope_revoked_at;

      await syncMetaAdsCapability(account, 'user1');

      const { updates, unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], newerFreshConfig);
      expect(updates).toEqual({});
      expect(unset).toEqual([]);
    });

    it('does not reverse a revocation that was probed more recently than this recovery', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('accessible');
      const account = latchedAccount();
      const configSnapshot = { ...account.config };

      const newerFreshConfig = {
        ...configSnapshot,
        ads_scope_revoked_at: '2026-08-14T12:00:00.000Z',
        ads_capability_probed_at: '3000-01-01T00:00:00.000Z',
      };

      await syncMetaAdsCapability(account, 'user1');

      const { updates, unset } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], newerFreshConfig);
      expect(updates).toEqual({});
      expect(unset).toEqual([]);
    });

    it('stamps its own probe time on a write that does apply', async () => {
      mockProbeAdsAccountAccess.mockResolvedValue('denied');
      const account = metaAccount({
        granted_scopes: ['ads_read', 'pages_show_list'],
        ads_scope_denied_seen_at: '2026-08-12T07:00:00.000Z',
      });
      const configSnapshot = { ...account.config };

      await syncMetaAdsCapability(account, 'user1');

      const { updates } = resolveMutation(mockUpdateAccountConfig.mock.calls[0], configSnapshot);
      expect(typeof updates.ads_capability_probed_at).toBe('string');
    });
  });

  describe('never acts on absence of proof', () => {
    it('does nothing when Meta could not give a clear answer', async () => {
      // A Meta outage must not revoke every connection we have.
      mockProbeAdsAccountAccess.mockResolvedValue('unknown');

      const result = await syncMetaAdsCapability(metaAccount({ granted_scopes: ['ads_read'] }), 'user1');

      expect(result.outcome).toBe('undetermined');
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
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
