/**
 * metaListScope — how a Meta list result describes its own scope and completeness.
 *
 * Extracted rather than added inline to `agentModeService.ts`, per that file's path instruction
 * (it is mid-restructure and the project's complexity policy is subtraction-biased). These are
 * pure string/shape helpers with no I/O, so they are directly testable without mocking the Meta
 * SDK, credentials, or the database.
 *
 * Why any of this exists: `Found 25 ad(s)` — a bare count with no scope and no bound — is the
 * sentence that told an Every.io customer an ad they were protecting did not exist (ENG-1584).
 * It read as "these are all the ads" when it meant "these are the first 25 in the account". Every
 * helper here exists to make that sentence unsayable.
 */

/** Which node a list read was scoped to. Empty means account-wide. */
export interface MetaListScope {
  campaignId?: string;
  adSetId?: string;
}

/** Human phrase for the scope actually applied, for use inside a result message. */
export function describeScope(scope: MetaListScope | undefined, opts: { campaignScopable: boolean }): string {
  if (scope?.adSetId) return ` in ad set ${scope.adSetId}`;
  if (opts.campaignScopable && scope?.campaignId) return ` in campaign ${scope.campaignId}`;
  return ' in this ad account';
}

/**
 * The message the model reads.
 *
 * A truncated list states its incompleteness in PROSE, not only in a boolean field, because a
 * field is easy to skip and the failure mode being prevented is a confident "it does not exist".
 */
/**
 * What a truncated list must warn the reader not to conclude — "an ad"/"a creative" for the
 * two edges this originally shipped for, widened for ENG-1625's follow-up (campaigns, ad
 * sets, custom audiences, pixels) rather than falling back to a generic, less pointed phrase.
 */
function absentNounFor(noun: string): string {
  if (noun.startsWith('ad creative')) return 'a creative';
  if (noun.startsWith('ad set')) return 'an ad set';
  if (noun.startsWith('campaign')) return 'a campaign';
  if (noun.startsWith('custom audience')) return 'a custom audience';
  if (noun.startsWith('pixel')) return 'a pixel';
  return 'an ad';
}

export function buildListMessage(args: {
  noun: string;
  totalCount: number;
  scope?: MetaListScope;
  truncated?: boolean;
  campaignScopable: boolean;
}): string {
  const where = describeScope(args.scope, { campaignScopable: args.campaignScopable });
  if (args.truncated) {
    return (
      `Found ${args.totalCount} ${args.noun}${where}, but THIS LIST IS INCOMPLETE — Meta had more ` +
      `results and the read stopped at its bound. Do NOT conclude ${absentNounFor(args.noun)} ` +
      `is absent from this list. Narrow the request with campaign_id or ad_set_id and ask again.`
    );
  }
  return `Found ${args.totalCount} ${args.noun}${where} (complete list).`;
}

/**
 * Note appended when a scope was requested that this edge cannot honour.
 *
 * Meta exposes no campaign→adcreatives edge, so `AD_CREATIVE LIST` genuinely cannot apply
 * `campaign_id`. Returning an account-wide list labelled "(complete list)" while quietly
 * discarding the requested scope would be the same silent-scope-drop defect in a new place, so
 * the limitation is named instead.
 */
export function describeIgnoredCampaignScope(campaignId: string): string {
  return (
    ` ⚠ campaign_id "${campaignId}" was NOT applied — Meta exposes no campaign-scoped adcreatives ` +
    `edge, so this list is not limited to that campaign. Do NOT treat it as evidence about that ` +
    `campaign; use AD LIST with campaign_id instead, which returns each ad's creative inline.`
  );
}

/**
 * Assemble a list response with completeness metadata AHEAD of the payload.
 *
 * ⚠ Field order is load-bearing. A Meta ad list carries `object_story_spec` per ad, so it
 * routinely exceeds the S3 offload threshold, after which the model is handed a SEALED
 * fixed-length PREFIX of this JSON. Anything serialized after a large payload array is simply not
 * there — so the truncation warning would vanish on exactly the lists that need it most.
 *
 * Building the object here, in one place, is what stops a future `{...result, extraField}` from
 * quietly appending a field behind that cut.
 */
export function buildListResult(args: {
  payloadKey: 'ads' | 'creatives' | 'campaigns' | 'adSets' | 'audiences' | 'pixels';
  payload: any[];
  message: string;
  truncated?: boolean;
  scope?: MetaListScope;
  scopeIgnored?: Record<string, string>;
}): Record<string, any> {
  return {
    success: true,
    message: args.message,
    complete: !args.truncated,
    hasMore: !!args.truncated,
    totalCount: args.payload.length,
    scope: args.scope ?? {},
    ...(args.scopeIgnored ? { scopeIgnored: args.scopeIgnored } : {}),
    [args.payloadKey]: args.payload,
  };
}
