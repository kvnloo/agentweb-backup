import { z } from 'zod';

export function normalizeMetaCampaignIds(campaignIds: unknown, legacyCampaignId?: unknown): string[] {
  let ids: unknown[] = [];
  if (Array.isArray(campaignIds)) ids = campaignIds;
  else if (typeof campaignIds === 'string' && campaignIds.trim()) {
    const trimmed = campaignIds.trim();
    try {
      const parsed = JSON.parse(trimmed);
      ids = Array.isArray(parsed) ? parsed : [trimmed];
    } catch { ids = [trimmed]; }
  } else if (typeof legacyCampaignId === 'string' && legacyCampaignId.trim()) ids = [legacyCampaignId];
  return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
}

export function repairMetaAdsMetricsAlias(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const alias = source.campaign_ids === undefined
    ? Object.keys(source).find((key) => key.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'campaignids')
    : undefined;
  if (!alias || alias === 'campaign_ids') return input;
  const args = { ...source, campaign_ids: source[alias] };
  delete args[alias];
  return args;
}

export const getMetaAdsMetricsArgsSchema = z.preprocess(repairMetaAdsMetricsAlias,
z.record(z.unknown()).superRefine((args, context) => {
  const mismatch = (path: string, expected: string) => context.addIssue({
    code: z.ZodIssueCode.custom, path: [path], params: { contractCode: 'type_mismatch' },
    message: `Argument "${path}" has the wrong type. Expected ${expected}.`,
  });
  if (args.timeframe != null && typeof args.timeframe !== 'string') mismatch('timeframe', 'string');
  if (args.campaign_ids != null && !Array.isArray(args.campaign_ids) && typeof args.campaign_ids !== 'string')
    mismatch('campaign_ids', 'array or string');
  else if (Array.isArray(args.campaign_ids)) {
    if (!args.campaign_ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['campaign_ids'],
      message: 'Argument "campaign_ids" must contain at least 1 item(s).' });
    args.campaign_ids.forEach((id, index) => {
      if (typeof id !== 'string') mismatch(`campaign_ids[${index}]`, 'string');
    });
  }
  if (args.campaign_id != null && typeof args.campaign_id !== 'string') mismatch('campaign_id', 'string');
  if (args.account_id != null && typeof args.account_id !== 'string') mismatch('account_id', 'string');
  const hasId = (Array.isArray(args.campaign_ids) && args.campaign_ids.some((id) => typeof id === 'string' && id.trim()))
    || (typeof args.campaign_ids === 'string' && args.campaign_ids.trim())
    || (typeof args.campaign_id === 'string' && args.campaign_id.trim());
  if (!hasId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['campaign_ids'],
    message: 'Provide at least one campaign id via campaign_ids (array or string) or campaign_id. Use list_meta_ads_campaigns to find campaign IDs.' });
})).transform(({ campaign_id, ...args }) => ({ ...args,
  campaign_ids: normalizeMetaCampaignIds(args.campaign_ids, campaign_id) }));
