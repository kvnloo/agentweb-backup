/**
 * The write-confirmation gate must scope against the account the write will ACTUALLY use.
 *
 * `getMetaCredentials(userId, undefined)` resolves the user's single connected ad account and
 * returns both `accountId` and `accessToken`. `buildMetaWriteConfirmation` destructured only the
 * token and then handed the RAW `account_id` argument to the ownership resolvers. When the
 * caller omitted it — the common single-account case, and `POST /emma/meta-ads/marketing-api`
 * validates nothing — every resolver compared against `undefined`, `assertOwnedByAccount`
 * correctly failed closed, and the gate refused the user's OWN campaign as a cross-tenant
 * violation. The prompt rendered "in ad account undefined", and the only remedy it offered
 * ("select that account") was one the model was never told it needed.
 *
 * The guard was right. It was being handed the wrong account.
 */

import { agentModeService } from '../services/agentModeService';
import { metaService, META_ACCOUNT_SCOPE_REFUSAL_MARKER } from '../services/metaService';

const USER = 'user-1';
const RESOLVED_ACCOUNT = '922903076601160';
const OTHER_TENANT = '111111111111111';

describe('buildMetaWriteConfirmation scopes to the resolved ad account', () => {
  let credentialsSpy: jest.SpyInstance;
  let getCampaignSpy: jest.SpyInstance;

  const build = (accountId: any) =>
    (agentModeService as any).buildMetaWriteConfirmation(
      USER, 'CAMPAIGN', 'UPDATE', accountId, 'camp_1', undefined, undefined, { status: 'PAUSED' },
    );

  beforeEach(() => {
    credentialsSpy = jest
      .spyOn(agentModeService as any, 'getMetaCredentials')
      .mockResolvedValue({ accountId: RESOLVED_ACCOUNT, accessToken: 'tok' } as never);

    // getCampaign is MOCKED to reproduce assertOwnedByAccount's contract (refuse unless the
    // supplied account matches the owner) — the real guard is exercised by
    // metaService.singleNodeScope.test.ts. What this suite pins is which ACCOUNT the gate hands
    // it, which is the thing that was wrong.
    getCampaignSpy = jest
      .spyOn(metaService, 'getCampaign')
      .mockImplementation(async (adAccountId: string, _token: string, campaignId: string) => {
        const norm = (id: unknown) => String(id ?? '').replace(/^act_/, '').trim();
        if (norm(adAccountId) !== RESOLVED_ACCOUNT) {
          throw new Error(
            `The requested campaign ${META_ACCOUNT_SCOPE_REFUSAL_MARKER}. `
            + 'If it belongs to a different ad account, select that account and try again.',
          );
        }
        return { id: campaignId, name: 'Summer Sale' } as never;
      });
  });

  afterEach(() => {
    credentialsSpy.mockRestore();
    getCampaignSpy.mockRestore();
  });

  it.each([
    ['omitted', undefined],
    ['empty', ''],
  ])('does NOT refuse the user\'s own campaign when account_id is %s', async (_label, accountId) => {
    const result = await build(accountId);

    expect(result.tenancyRefused).toBe(false);
    // Resolved id, not the raw argument — the prompt used to read "in ad account undefined".
    expect(result.summary).toContain(`ad account ${RESOLVED_ACCOUNT}`);
    expect(result.summary).not.toContain('undefined');
    // The name resolved, so the prompt names the campaign instead of degrading to a bare id.
    expect(result.summary).toContain('"Summer Sale"');
    expect(result.target.account_id).toBe(RESOLVED_ACCOUNT);
    expect(getCampaignSpy).toHaveBeenCalledWith(RESOLVED_ACCOUNT, 'tok', 'camp_1');
  });

  it('still passes the selected account through, so a DIFFERENT account is still refused', async () => {
    // The whole risk of the fix is over-correcting into "always trust the resolved account".
    // Here the caller explicitly selects another account, so the refusal must still fire.
    credentialsSpy.mockResolvedValue({ accountId: OTHER_TENANT, accessToken: 'tok' } as never);

    const result = await build(OTHER_TENANT);

    expect(result.tenancyRefused).toBe(true);
    // A refusal must not leak the node's real owner into the prompt.
    expect(result.summary).not.toContain(RESOLVED_ACCOUNT);
  });

  it('normalises an explicitly supplied act_-prefixed account to the resolved id', async () => {
    /*
     * `getMetaCredentials` validates the requested account and hands back the cleaned id, so an
     * explicit `act_<n>` now reaches the guard and the prompt as `<n>`. A deliberate, visible
     * consequence of scoping to the resolved account rather than the raw argument: ownership
     * comparison normalises the prefix away regardless, and the prompt reads consistently
     * whether the caller passed the account or left it to be resolved.
     */
    const result = await build(`act_${RESOLVED_ACCOUNT}`);

    expect(result.tenancyRefused).toBe(false);
    expect(getCampaignSpy).toHaveBeenCalledWith(RESOLVED_ACCOUNT, 'tok', 'camp_1');
    expect(result.summary).toContain(`ad account ${RESOLVED_ACCOUNT}`);
  });

  /*
   * The refusal the CALLER emits must name the same account the guard used.
   *
   * `buildMetaWriteConfirmation` was fixed to scope against the resolved account, but the
   * tenancy-refusal message beside it still interpolated the raw `account_id` argument — so a
   * correct, fail-closed block explained itself as "not available in the selected ad account
   * (undefined)". The block was right; its explanation named an account that does not exist.
   */
  it('the caller-side tenancy refusal names the resolved account, never "undefined"', async () => {
    // The campaign genuinely belongs elsewhere, so the refusal is correct — this pins the TEXT.
    getCampaignSpy.mockRejectedValue(
      new Error(
        `The requested campaign ${META_ACCOUNT_SCOPE_REFUSAL_MARKER}. `
        + 'If it belongs to a different ad account, select that account and try again.',
      ) as never,
    );

    const result: any = await agentModeService.callMetaMarketingApi(
      USER, 'CAMPAIGN', 'UPDATE', undefined as any, 'camp_1', undefined, undefined, { status: 'PAUSED' },
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('account_scope');
    expect(result.message).toContain(`ad account (${RESOLVED_ACCOUNT})`);
    expect(result.message).not.toContain('undefined');
    expect(result.error).not.toContain('undefined');
    // Still no oracle: the refusal must not disclose the account that DOES own the campaign.
    expect(result.message).not.toContain(OTHER_TENANT);
  });

  /*
   * The same fail-closed guarantee for AD and AD_SET, not just CAMPAIGN.
   *
   * This suite pinned it only for CAMPAIGN — the one entity that happened to be safe, because
   * `getCampaign` takes the account id positionally. `getAdSet`/`getAd` take it optionally, where
   * `undefined` means "opt out of the ownership check", so an unresolved account skipped the
   * guard for them and rendered another tenant's ad NAME into the prompt the user approves.
   * A test that asserts an invariant for the only entity that already held it is the shape that
   * let this through.
   */
  it.each([
    ['AD', 'ad_9', undefined, undefined, 'ad_9'],
    ['AD_SET', undefined, 'set_9', 'set_9', undefined],
  ])('fails closed for %s when credentials resolve no account', async (entity, _a, _b, adSetId, adId) => {
    credentialsSpy.mockResolvedValue({ accountId: '', accessToken: 'tok' } as never);
    const refuse = jest.fn().mockRejectedValue(
      new Error(`The requested node ${META_ACCOUNT_SCOPE_REFUSAL_MARKER}. Retry.`) as never,
    );
    const adSetSpy = jest.spyOn(metaService, 'getAdSet').mockImplementation(refuse as never);
    const adSpy = jest.spyOn(metaService, 'getAd').mockImplementation(refuse as never);
    try {
      const result = await (agentModeService as any).buildMetaWriteConfirmation(
        USER, entity, 'UPDATE', undefined, undefined, adSetId, adId, { status: 'PAUSED' },
      );
      // The guard must have been CONSULTED with a defined account id — `undefined` is the value
      // that silently disables it.
      const call = (entity === 'AD' ? adSpy : adSetSpy).mock.calls[0] as any[];
      expect(call[2]).toBeDefined();
      expect(result.tenancyRefused).toBe(true);
    } finally {
      adSetSpy.mockRestore();
      adSpy.mockRestore();
    }
  });

  it('fails closed when credentials resolve no account at all', async () => {
    // Nothing to scope against: the raw argument is empty and the resolver produced nothing.
    // Refusing is correct here — the alternative is an unscoped write prompt.
    credentialsSpy.mockResolvedValue({ accountId: '', accessToken: 'tok' } as never);

    const result = await build(undefined);

    expect(result.tenancyRefused).toBe(true);
  });

  /*
   * ENG-842 / CodeRabbit P1: the confirmation prompt must show the exact dayparting
   * schedule the write will apply, not just that "something" changed. Before this,
   * `adset_schedule`/`pacing_type` were silently omitted from the change-key allowlist,
   * so a user could approve an AD_SET UPDATE without ever seeing the delivery hours or
   * pacing mode being set — the same class of "approved without seeing it" gap the
   * ENG-941 tracking-override warning was added to close.
   */
  it('surfaces adset_schedule and pacing_type in the confirmation summary and target.changes', async () => {
    getCampaignSpy.mockRestore();
    const adSetSpy = jest.spyOn(metaService, 'getAdSet').mockResolvedValue({
      id: 'set_1',
      name: 'Evening Push',
      campaign_id: 'camp_1',
    } as never);
    const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({
      id: 'camp_1',
      name: 'Summer Sale',
    } as never);
    const schedule = [{ days: [1, 2, 3, 4, 5], start_minute: 540, end_minute: 1020 }];

    try {
      const result: any = await (agentModeService as any).buildMetaWriteConfirmation(
        USER, 'AD_SET', 'UPDATE', RESOLVED_ACCOUNT, undefined, 'set_1', undefined,
        { adset_schedule: schedule, pacing_type: ['day_parting'] },
      );

      expect(result.summary).toContain('adset_schedule');
      expect(result.summary).toContain('pacing_type');
      expect(result.target.changes.adset_schedule).toEqual(schedule);
      expect(result.target.changes.pacing_type).toEqual(['day_parting']);
    } finally {
      adSetSpy.mockRestore();
      campaignSpy.mockRestore();
    }
  });

  /*
   * ENG-1853 follow-up (found live: a real reviewer looking at the actual deployed page
   * asked "is $60 to $110 a lot or a little?" for a card that only said "Changes:
   * daily_budget."). getCampaign/getAdSet already fetch the CURRENT daily_budget/status
   * as part of the full entity — it was being fetched and thrown away, read only for
   * .name. This pins that the confirmation text now shows the actual before/after values,
   * not just which keys are changing.
   */
  describe('Changes: line shows what will actually be submitted (same units as the writers)', () => {
    // ENG-2277: every agent money input is MAJOR units of the ad account currency; Meta reports the
    // current value in MINOR units as a numeric string. Both sides are rendered with the writers'
    // own normalizeMetaMoney so a $30 -> $3,100 slip is visible on the card.
    let currencySpy: jest.SpyInstance;
    beforeEach(() => {
      currencySpy = jest.spyOn(metaService, 'getAdAccountCurrency').mockResolvedValue('USD' as never);
    });
    afterEach(() => {
      currencySpy.mockRestore();
    });

    const build = (entity: string, action: string, ids: [string | undefined, string | undefined, string | undefined], params: any) =>
      (agentModeService as any).buildMetaWriteConfirmation(USER, entity, action, RESOLVED_ACCOUNT, ids[0], ids[1], ids[2], params);

    it('shows a campaign budget as before (minor units) and after (major units converted), side by side', async () => {
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({
        id: 'camp_1', name: 'Summer Sale', daily_budget: '3000',
      } as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { daily_budget: 31 });
        expect(result.summary).toContain('daily_budget: 3000 (= $30.00) → 3100 (= $31.00)');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('makes a 100x slip visible: 3100 submitted as major units is $3,100.00', async () => {
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({
        id: 'camp_1', name: 'Summer Sale', daily_budget: '3000',
      } as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { daily_budget: 3100 });
        expect(result.summary).toContain('daily_budget: 3000 (= $30.00) → 310000 (= $3,100.00)');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('shows an AD_SET budget in the same units (major in, minor out)', async () => {
      getCampaignSpy.mockRestore();
      const adSetSpy = jest.spyOn(metaService, 'getAdSet').mockResolvedValue({
        id: 'set_1', name: 'Evening Push', campaign_id: 'camp_1', daily_budget: '6000',
      } as never);
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({ id: 'camp_1', name: 'Summer Sale' } as never);
      try {
        const result: any = await build('AD_SET', 'UPDATE', [undefined, 'set_1', undefined], { daily_budget: 75 });
        expect(result.summary).toContain('daily_budget: 6000 (= $60.00) → 7500 (= $75.00)');
      } finally {
        adSetSpy.mockRestore();
        campaignSpy.mockRestore();
      }
    });

    it('compares a campaign budget_amount against the campaign daily_budget', async () => {
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({
        id: 'camp_1', name: 'Summer Sale', daily_budget: '3000',
      } as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { budget_amount: 45 });
        expect(result.summary).toContain('budget_amount: 3000 (= $30.00) → 4500 (= $45.00)');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('uses the account currency\'s own minor-unit scale (zero-decimal JPY)', async () => {
      currencySpy.mockResolvedValue('JPY' as never);
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({
        id: 'camp_1', name: 'Summer Sale', daily_budget: '3000',
      } as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { daily_budget: 3500 });
        expect(result.summary).toContain('daily_budget: 3000 (= ¥3,000.00) → 3500 (= ¥3,500.00)');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('shows a CREATE budget with its converted amount and flags the raw value when the currency cannot be read', async () => {
      currencySpy.mockRejectedValue(new Error('graph down') as never);
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({ id: 'camp_1', name: 'Summer Sale' } as never);
      try {
        const result: any = await build('AD_SET', 'CREATE', ['camp_1', undefined, undefined], { name: 'New Set', daily_budget: 50 });
        expect(result.summary).toContain('daily_budget → 50 (major units, currency unverified)');
        expect(result.summary).not.toContain('$');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('does not quietly accept a string PROPOSAL the writers would reject (only Meta\'s own read-back is coerced)', async () => {
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({
        id: 'camp_1', name: 'Summer Sale', daily_budget: '3000',
      } as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { daily_budget: '31' });
        expect(result.summary).toContain('daily_budget: 3000 (= $30.00) → 31 (major units, currency unverified)');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('shows a status change before/after without money-formatting a non-budget field', async () => {
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({
        id: 'camp_1', name: 'Summer Sale', status: 'ACTIVE',
      } as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { status: 'PAUSED' });
        expect(result.summary).toContain('status: ACTIVE → PAUSED');
        expect(currencySpy).not.toHaveBeenCalled();
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('falls back to "key → value" (no "undefined →") when the current value could not be read', async () => {
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue(undefined as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { daily_budget: 110 });
        expect(result.summary).toContain('daily_budget → 11000 (= $110.00)');
        expect(result.summary).not.toContain('undefined');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('does not repeat the name as a "change" on CREATE', async () => {
      getCampaignSpy.mockRestore();
      const result: any = await build('CAMPAIGN', 'CREATE', [undefined, undefined, undefined], { name: 'Fall Sale', objective: 'OUTCOME_LEADS' });
      expect(result.summary).not.toContain('name →');
      expect(result.summary).not.toContain('Changes:');
    });

    it('renders object-valued changes as JSON, never "[object Object]"', async () => {
      getCampaignSpy.mockRestore();
      const adSetSpy = jest.spyOn(metaService, 'getAdSet').mockResolvedValue({ id: 'set_1', name: 'Evening Push', campaign_id: 'camp_1' } as never);
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({ id: 'camp_1', name: 'Summer Sale' } as never);
      try {
        const result: any = await build('AD_SET', 'UPDATE', [undefined, 'set_1', undefined], {
          adset_schedule: [{ days: [1], start_minute: 540, end_minute: 1020 }],
        });
        expect(result.summary).not.toContain('[object Object]');
        expect(result.summary).toContain('"start_minute":540');
      } finally {
        adSetSpy.mockRestore();
        campaignSpy.mockRestore();
      }
    });

    it('lists every field the write will send (targeting, start_time, bid_strategy), not just a fixed allowlist', async () => {
      getCampaignSpy.mockRestore();
      const adSetSpy = jest.spyOn(metaService, 'getAdSet').mockResolvedValue({ id: 'set_1', name: 'Evening Push', campaign_id: 'camp_1' } as never);
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({ id: 'camp_1', name: 'Summer Sale' } as never);
      try {
        const result: any = await build('AD_SET', 'UPDATE', [undefined, 'set_1', undefined], {
          targeting: { geo_locations: { countries: ['US'] } },
          start_time: '2026-11-01T00:00:00+0000',
          bid_strategy: 'COST_CAP',
          override_tracking_check: true,
          budget_confirmation_token: 'secret-token',
        });
        expect(result.summary).toContain('targeting → {"geo_locations":{"countries":["US"]}}');
        expect(result.summary).toContain('start_time → 2026-11-01T00:00:00+0000');
        expect(result.summary).toContain('bid_strategy → COST_CAP');
        expect(result.summary).not.toContain('secret-token');
        expect(result.target.changes.targeting).toEqual({ geo_locations: { countries: ['US'] } });
      } finally {
        adSetSpy.mockRestore();
        campaignSpy.mockRestore();
      }
    });

    it('warns loudly when the account currency could not be verified', async () => {
      currencySpy.mockRejectedValue(new Error('graph down') as never);
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({ id: 'camp_1', name: 'Summer Sale', daily_budget: '3000' } as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { daily_budget: 31 });
        expect(result.summary).toContain('WARNING: the ad account currency could not be verified');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('does not warn when the currency was read', async () => {
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({ id: 'camp_1', name: 'Summer Sale', daily_budget: '3000' } as never);
      try {
        const result: any = await build('CAMPAIGN', 'UPDATE', ['camp_1', undefined, undefined], { daily_budget: 31 });
        expect(result.summary).not.toContain('WARNING');
      } finally {
        campaignSpy.mockRestore();
      }
    });

    it('shows a rename on UPDATE (name: before → after)', async () => {
      getCampaignSpy.mockRestore();
      const campaignSpy = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({
        id: 'camp_1', name: 'Summer Sale',
      } as never);
      try {
        const result: any = await (agentModeService as any).buildMetaWriteConfirmation(
          USER, 'CAMPAIGN', 'UPDATE', RESOLVED_ACCOUNT, 'camp_1', undefined, undefined,
          { name: 'Fall Sale' },
        );
        expect(result.summary).toContain('name: Summer Sale → Fall Sale');
      } finally {
        campaignSpy.mockRestore();
      }
    });
  });
});
