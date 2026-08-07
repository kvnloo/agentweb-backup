/**
 * ENG-600 verification guardrail: restricts the new HubSpot/CSV-sourced
 * Custom Audience campaign-launch workflows (launchTargetedAudienceCampaign /
 * launchRetargetingCampaign) to an explicitly approved Meta ad account during
 * development, so implementation/testing never touches a live customer
 * account. Deliberately NOT wired into any shared Meta service
 * (manageMetaCustomAudiences / createMetaAdsAdSet / callMetaMarketingApi) —
 * those serve every other real-customer Emma workflow.
 *
 * Default (env var unset/empty) is fully unrestricted — this must never
 * silently constrain production once ENG-600 ships.
 */
export function assertMetaAccountAllowed(accountId: string): void {
  const raw = process.env.META_TEST_ACCOUNT_ALLOWLIST;
  if (!raw || raw.trim() === '') return;

  const allowlist = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length === 0) return;

  if (!allowlist.includes(accountId)) {
    throw new Error(
      `Meta account ${accountId} is not in the ENG-600 verification allowlist (META_TEST_ACCOUNT_ALLOWLIST). ` +
      `This guardrail restricts these two campaign-launch workflows to approved test accounts during development.`
    );
  }
}
