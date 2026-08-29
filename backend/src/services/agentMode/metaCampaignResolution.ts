interface MetaCampaignResolver {
  getAdCampaignIdForAccount(accessToken: string, accountId: string, adId: string): Promise<string | undefined>;
}

/** Resolve the parent campaign needed by an AD activation, preserving fail-closed fallback. */
export async function resolveMetaActivationCampaignId(input: {
  entityType: string;
  campaignId?: string;
  adId?: string;
  accessToken: string;
  accountId: string;
  resolver: MetaCampaignResolver;
}): Promise<string | undefined> {
  if (input.campaignId || input.entityType !== 'AD' || !input.adId) return input.campaignId;
  try {
    return await input.resolver.getAdCampaignIdForAccount(input.accessToken, input.accountId, input.adId);
  } catch {
    return undefined;
  }
}
