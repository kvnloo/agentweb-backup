interface MetaCampaignResolver {
  getAdCampaignIdForAccount(accessToken: string, accountId: string, adId: string): Promise<string | undefined>;
  getAdSetCampaignIdForAccount(accessToken: string, accountId: string, adSetId: string): Promise<string | undefined>;
}

/**
 * Resolve the parent campaign an AD or AD_SET activation needs for the tracking gate.
 * The read is scoped to the selected ad account, so a node owned by another account
 * resolves to nothing. Any failure leaves the campaign unset and the gate blocks.
 */
export async function resolveMetaActivationCampaignId(input: {
  entityType: string;
  campaignId?: string;
  adId?: string;
  adSetId?: string;
  accessToken: string;
  accountId: string;
  resolver: MetaCampaignResolver;
}): Promise<string | undefined> {
  if (input.campaignId) return input.campaignId;
  try {
    if (input.entityType === 'AD' && input.adId) {
      return await input.resolver.getAdCampaignIdForAccount(input.accessToken, input.accountId, input.adId);
    }
    if (input.entityType === 'AD_SET' && input.adSetId) {
      return await input.resolver.getAdSetCampaignIdForAccount(input.accessToken, input.accountId, input.adSetId);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
