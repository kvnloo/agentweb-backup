/**
 * Which bid targets / CPC ceilings each standard Google Ads bidding strategy can store.
 * Pure (no I/O): shared by googleAdsService and the Zoma Google toolkit, which refuses an
 * unaddressable target before its preview instead of after the user approved it.
 */
/**
 * Which bid targets each strategy can actually carry, and where Google stores them.
 *
 * `target` is bidding_strategy_target, `ceiling` is cpc_bid_ceiling_micros. A `false` here
 * does not mean "we chose not to support it" — it means the field does not exist on that
 * strategy at campaign level, so sending it writes nothing.
 *
 * cpc_bid_ceiling_micros is documented as "mutable for portfolio bidding strategies only",
 * which is why it is false on every STANDARD strategy that is not TARGET_IMPRESSION_SHARE
 * (where it is required) or TARGET_SPEND (where it is the strategy's only knob). We
 * deliberately do NOT start writing it onto TargetCpa/TargetRoas to "support" it: that is a
 * new, spend-affecting write we cannot validate against the live API from here, and the
 * caller is better served by a loud rejection than by a bid cap that may be ignored.
 */
export const BID_TARGET_SUPPORT: Record<string, { target: boolean; ceiling: boolean; targetMeans: string }> = {
  MAXIMIZE_CONVERSIONS:      { target: true,  ceiling: false, targetMeans: 'a target CPA' },
  MAXIMIZE_CONVERSION_VALUE: { target: true,  ceiling: false, targetMeans: 'a target ROAS' },
  TARGET_CPA:                { target: true,  ceiling: false, targetMeans: 'a target CPA' },
  TARGET_ROAS:               { target: true,  ceiling: false, targetMeans: 'a target ROAS' },
  TARGET_IMPRESSION_SHARE:   { target: true,  ceiling: true,  targetMeans: 'an impression share fraction' },
  TARGET_SPEND:              { target: false, ceiling: true,  targetMeans: '' },
  MANUAL_CPC:                { target: false, ceiling: false, targetMeans: '' },
};

/**
 * Refuse any bid target the selected strategy cannot store, BEFORE anything is sent.
 *
 * Google keeps a bid target as a leaf of the bidding strategy (target_cpa.target_cpa_micros
 * and friends), so a target is only reachable through the strategy branch that owns it.
 * Every combination this rejects used to be accepted, dropped on the floor, and reported as
 * `success: true` — the caller was told the campaign was updated while the number they sent
 * was never written, leaving smart bidding optimising to the OLD target with real money.
 *
 * Three distinct shapes of that bug, all confirmed against the mutate payload:
 *   - no strategy at all: the target had no branch to live in;
 *   - a strategy that has no such field (MANUAL_CPC + target, TARGET_SPEND + target,
 *     MAXIMIZE_* + ceiling);
 *   - a portfolio resource name, where the campaign only carries a REFERENCE and every
 *     target belongs to the shared strategy object instead.
 */
export function assertBidTargetIsAddressable(params: {
  biddingStrategy?: string;
  biddingStrategyResourceName?: string;
  biddingStrategyTarget?: number;
  cpcBidCeilingMicros?: number;
}): void {
  const sentTarget = params.biddingStrategyTarget !== undefined;
  const sentCeiling = params.cpcBidCeilingMicros !== undefined;
  if (!sentTarget && !sentCeiling) return;

  const supplied = [
    sentTarget ? 'bidding_strategy_target' : '',
    sentCeiling ? 'cpc_bid_ceiling_micros' : '',
  ].filter(Boolean).join(' / ');

  if (!params.biddingStrategy && !params.biddingStrategyResourceName) {
    throw new Error(
      `${supplied} cannot be applied on their own: Google stores a bid target as a leaf of the bidding strategy, so the strategy has to be named to know which field to write. Re-send with bidding_strategy set to the campaign's current strategy (read it with call_google_ads_reporting_api: SELECT campaign.bidding_strategy_type FROM campaign). Nothing was sent to Google Ads.`,
    );
  }

  // A portfolio/shared strategy is attached to the campaign by REFERENCE. The campaign row
  // has nowhere to put a target, so one supplied here would be silently discarded — it has
  // to be written on the shared strategy object itself, where it applies to every campaign
  // using it.
  if (params.biddingStrategyResourceName) {
    throw new Error(
      `${supplied} cannot be set on a campaign that uses the portfolio bidding strategy ${params.biddingStrategyResourceName}: the campaign only holds a reference to it, and the target lives on the shared strategy, where it applies to every campaign using that strategy. Update the bidding strategy itself instead. Nothing was sent to Google Ads.`,
    );
  }

  const support = BID_TARGET_SUPPORT[params.biddingStrategy as string];
  // An unknown strategy is rejected further down with the list of supported values; let
  // that error win rather than shadowing it with a less specific one.
  if (!support) return;

  if (sentTarget && !support.target) {
    throw new Error(
      `bidding_strategy_target is not a field of ${params.biddingStrategy}: that strategy has no bid target to set${params.biddingStrategy === 'MANUAL_CPC' ? ' (bids are per ad group / keyword with MANUAL_CPC)' : ''}. Drop bidding_strategy_target, or choose a strategy that takes one (${Object.entries(BID_TARGET_SUPPORT).filter(([, v]) => v.target).map(([k]) => k).join(', ')}). Nothing was sent to Google Ads.`,
    );
  }

  if (sentCeiling && !support.ceiling) {
    throw new Error(
      `cpc_bid_ceiling_micros is not a campaign-level field of ${params.biddingStrategy}: Google makes the ceiling on this strategy mutable only through a PORTFOLIO bidding strategy, so a ceiling sent here is not stored and the campaign keeps bidding uncapped. Either move the campaign onto a portfolio strategy that carries the ceiling, or drop cpc_bid_ceiling_micros${support.target ? ` and control cost with bidding_strategy_target (${support.targetMeans})` : ''}. Nothing was sent to Google Ads.`,
    );
  }
}
