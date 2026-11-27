/**
 * CAMPAIGN CREATE accepts the campaign's fields nested as `params.campaign` as well as at the top
 * level of params.
 *
 * The tool schema advertises `params.campaign` / `params.ad_set` / `params.ads` (they describe
 * Emma's CREATE_PAUSED_BUNDLE), so an agent reading it — Zoma's especially, which never sees the
 * bundle action — sent `{ campaign: { name, objective, ... } }` to CAMPAIGN CREATE and got
 * "Campaign CREATE requires name" while the name was right there. Pure; no I/O.
 */
const isPlainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export type NestedCampaignCreateResult = { params: any; error?: undefined } | { params?: undefined; error: string };

/**
 * Lift `params.campaign` into params. Refuses (never guesses) when the same field is given both
 * nested and at the top level with different values, or when an ad set / ads ride along — this
 * action creates one campaign; `oneStepHint` says how the caller's surface creates the rest.
 */
export function flattenNestedCampaignCreate(params: any, oneStepHint: string): NestedCampaignCreateResult {
  if (!isPlainObject(params) || params.campaign === undefined) return { params };
  if (!isPlainObject(params.campaign)) return { error: 'params.campaign must be an object of campaign fields (name, objective, ...).' };
  const { campaign, ...rest } = params;
  const children = ['ad_set', 'ads', 'requested_ad_count'].filter((k) => rest[k] !== undefined);
  if (children.length) {
    return {
      error:
        `CAMPAIGN CREATE creates the campaign only; it does not accept ${children.map((k) => `params.${k}`).join(', ')}. ${oneStepHint}`,
    };
  }
  const conflicts = Object.keys(campaign).filter(
    (k) => campaign[k] !== undefined && rest[k] !== undefined && JSON.stringify(rest[k]) !== JSON.stringify(campaign[k]),
  );
  if (conflicts.length) {
    return { error: `CAMPAIGN CREATE got different values for ${conflicts.join(', ')} in params and in params.campaign. Send each field once.` };
  }
  return { params: { ...rest, ...campaign } };
}
