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

  it('fails closed when credentials resolve no account at all', async () => {
    // Nothing to scope against: the raw argument is empty and the resolver produced nothing.
    // Refusing is correct here — the alternative is an unscoped write prompt.
    credentialsSpy.mockResolvedValue({ accountId: '', accessToken: 'tok' } as never);

    const result = await build(undefined);

    expect(result.tenancyRefused).toBe(true);
  });
});
