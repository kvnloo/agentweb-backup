/**
 * ENG-2364: giving a campaign a budget (CBO) without a bid strategy leaves Meta on
 * LOWEST_COST_WITH_BID_CAP, and every ad set create/copy then fails with subcode 1815857
 * ("Bid amount required"). The write (MetaService.updateCampaign) and the Toolkit preview
 * both ask this one function, so the preview shows exactly what is sent.
 *
 * The no-cap default is added only when the update sets a budget, the caller sent no
 * bid_strategy, and the campaign has neither a budget nor a bid strategy of its own — a
 * deliberate COST_CAP (or any explicit strategy) is never replaced.
 */
export const DEFAULT_CAMPAIGN_BID_STRATEGY = 'LOWEST_COST_WITHOUT_CAP';

export function campaignBidStrategyDefault(
  params: Record<string, any> | undefined,
  current: Record<string, any> | null | undefined,
): string | undefined {
  const setsBudget = params?.daily_budget !== undefined || params?.lifetime_budget !== undefined
    || params?.budget_amount !== undefined;
  if (!setsBudget || params?.bid_strategy !== undefined) return undefined;
  const hadBudget = Number(current?.daily_budget) > 0 || Number(current?.lifetime_budget) > 0;
  const hasStrategy = typeof current?.bid_strategy === 'string' && current.bid_strategy.trim() !== '';
  return hadBudget || hasStrategy ? undefined : DEFAULT_CAMPAIGN_BID_STRATEGY;
}
