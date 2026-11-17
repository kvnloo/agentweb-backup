/**
 * ENG-3033 (ENG-2920 slice 2) — Zoma `ads_boost_ig_post` for external agents.
 *
 * Turns an existing Instagram post into an ad on the selected ad account: one campaign,
 * one ad set and one ad, every one of them created PAUSED. Nothing can spend until the user
 * activates them through call_meta_marketing_api, which is its own preview and approval.
 *
 * Guard: the shared Zoma write guard (zomaWriteGuard). The first call returns a PREVIEW of
 * everything that would be created plus a single-use preview_token; nothing is created
 * without confirm=true and that token.
 *
 * Ownership, all checked before the preview and again before any write: the Instagram
 * account must be on the ad account's instagram_accounts edge, the Page on its promote_pages
 * edge, and the media item must be one of that Instagram account's own posts.
 *
 * One path: the campaign, ad set and ad go through the same shared gate and dispatcher as
 * call_meta_marketing_api CREATE (previewToolkitMetaWrite → dispatchToolkitConfirmedMetaWrite),
 * so money normalization, the budget-anomaly check and the rate shaper stay in the path. Only
 * the creative (source_instagram_media_id) is a new Graph write; a creative cannot spend.
 */
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { getJwtSecret } from '../config/jwt';
import { evaluateMetaSpendCeiling, type MetaSpendCeilingPolicy } from '../services/agentMode/metaSpendCeiling';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { assertAdsManagementGranted, spendCeilingPolicyFromEnv } from './metaToolkitWrites';
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, isOutcomeUnknownFailure, previewFingerprint, previewResponse,
  previewTokenMatches, rememberTokenOutcome, replayTokenOutcome, type WriteVerification,
} from './zomaWriteGuard';

export const META_BOOST_TOOL_NAMES = ['ads_boost_ig_post'] as const;
export type MetaBoostToolName = (typeof META_BOOST_TOOL_NAMES)[number];

export function isMetaBoostTool(name: string): name is MetaBoostToolName {
  return (META_BOOST_TOOL_NAMES as readonly string[]).includes(name);
}

const MAX_DURATION_DAYS = 90;
const MEDIA_PAGE_SIZE = '100';
const MEDIA_MAX_PAGES = 10;

export const META_BOOST_TOOL_DEFINITIONS = [
  {
    name: 'ads_boost_ig_post',
    description:
      'Boost an existing Instagram post as an ad on this ad account. Creates one campaign, one ad set and one ad, all PAUSED: ' +
      'nothing spends until they are activated with call_meta_marketing_api, which is a separate preview and approval. ' +
      'Two calls: PREVIEW (everything that would be created) + preview_token, then confirm=true with the token. ' +
      'daily_budget is in MAJOR units of the ad account currency (e.g. 20 = $20.00). Verified by read-back.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' },
        ig_account_id: { type: 'string', pattern: '^[0-9]+$', description: 'Instagram account id from ads_get_ig_accounts.' },
        ig_media_id: { type: 'string', pattern: '^[0-9]+$', description: 'Id of one of that account\'s posts, from ads_get_ig_media.' },
        page_id: { type: 'string', pattern: '^[0-9]+$', description: 'Facebook Page id from ads_get_ad_account_pages, used as the ad identity.' },
        daily_budget: { type: 'number', exclusiveMinimum: 0, description: 'Daily budget in MAJOR units of the ad account currency.' },
        countries: { type: 'array', minItems: 1, maxItems: 25, items: { type: 'string', pattern: '^[A-Z]{2}$' }, description: 'ISO country codes to reach, e.g. ["US"].' },
        age_min: { type: 'integer', minimum: 18, maximum: 65, description: 'Default 18.' },
        age_max: { type: 'integer', minimum: 18, maximum: 65, description: 'Default 65.' },
        duration_days: { type: 'integer', minimum: 1, maximum: MAX_DURATION_DAYS, description: 'Optional. Sets the ad set end time this many days after it is created. Omit for no end date.' },
        name: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional name for the campaign, ad set and ad.' },
        confirm: { type: 'boolean', description: 'Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.' },
        preview_token: { type: 'string', description: 'The preview_token of the preview the user approved. Single use, 15 minutes; repeat the previewed arguments exactly.' },
      },
      required: ['ig_account_id', 'ig_media_id', 'page_id', 'daily_budget', 'countries'],
      additionalProperties: false,
    },
  },
];

export interface MetaBoostDeps {
  assertReady: (userId: string) => Promise<void>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  /** Read-only Graph GET of an allow-listed Pages / Instagram path with the account's own token. */
  readGraph: (userId: string, accountId: string, path: string, params: Record<string, string>) => Promise<any>;
  previewMoney: (userId: string, accountId: string, params: any) => Promise<{ params: any; currency?: string; confirmation: string }>;
  /** Shared-gate preview (AgentModeService.previewToolkitMetaWrite); never dispatches. */
  preview: (
    userId: string, entity: any, action: string, accountId: string,
    campaignId?: string, adSetId?: string, adId?: string, params?: any,
  ) => Promise<any>;
  dispatch: (userId: string, dispatch: any) => Promise<{ result: any; createdId?: string }>;
  /** Creates the ad creative that points at the Instagram post. A creative cannot spend. */
  createCreative: (userId: string, accountId: string, spec: { name: string; page_id: string; ig_account_id: string; ig_media_id: string }) => Promise<{ id?: string }>;
  readBack: (userId: string, accountId: string, entity: string, id: string) => Promise<Record<string, any> | null>;
  spendCeilingPolicy: () => MetaSpendCeilingPolicy | null;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
  tokenOutcomes: Map<string, { exp: number; outcome: any }>;
}

// agentModeService is loaded lazily: it is the monolith and the toolkit's tests must not import it.
const ams = async () => (await import('../services/agentModeService')).agentModeService;

const defaultDeps: MetaBoostDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId),
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  readGraph: async (userId, accountId, path, params) => (await ams()).readToolkitMetaPagesGraph(userId, accountId, path, params),
  previewMoney: async (userId, accountId, params) => (await ams()).previewMetaMoneyParams(userId, accountId, params),
  preview: async (...a) => (await ams()).previewToolkitMetaWrite(...a),
  dispatch: async (userId, d) => (await ams()).dispatchToolkitConfirmedMetaWrite(userId, d),
  createCreative: async (userId, accountId, spec) => (await ams()).toolkitMetaBoostCreative(userId, accountId, spec),
  readBack: async (userId, accountId, entity, id) => (await ams()).readBackMetaWriteTarget(userId, accountId, entity, id),
  spendCeilingPolicy: () => spendCeilingPolicyFromEnv(),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
  tokenOutcomes: new Map(),
};

const ALLOWED_ARGS = ['account_id', 'ig_account_id', 'ig_media_id', 'page_id', 'daily_budget', 'countries', 'age_min', 'age_max', 'duration_days', 'name'];
const numericId = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const rows = (res: any): any[] => (Array.isArray(res?.data) ? res.data : []);
const errorText = (e: any) => String(e?.metaError?.message || e?.error || e?.message || 'Meta request failed');

interface BoostSpec {
  ig_account_id: string; ig_media_id: string; page_id: string;
  daily_budget: number; countries: string[]; age_min: number; age_max: number;
  duration_days?: number; name: string;
}

function parseArgs(args: any): BoostSpec {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !ALLOWED_ARGS.includes(k));
  if (extra.length) throw new MetaToolkitRefusal(`Not allowed: ${extra.join(', ')}. Allowed: ${ALLOWED_ARGS.join(', ')}. A boost is always created PAUSED.`);
  for (const k of ['ig_account_id', 'ig_media_id', 'page_id'] as const) {
    if (!numericId(args[k])) throw new MetaToolkitRefusal(`${k} must be a numeric id string.`);
  }
  if (typeof args.daily_budget !== 'number' || !Number.isFinite(args.daily_budget) || args.daily_budget <= 0) {
    throw new MetaToolkitRefusal('daily_budget must be a positive number in major units of the ad account currency.');
  }
  const countries = args.countries;
  if (!Array.isArray(countries) || countries.length < 1 || countries.length > 25 || countries.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))) {
    throw new MetaToolkitRefusal('countries must be 1 to 25 ISO country codes, e.g. ["US"].');
  }
  const ageMin = args.age_min ?? 18;
  const ageMax = args.age_max ?? 65;
  if (![ageMin, ageMax].every((n) => Number.isInteger(n) && n >= 18 && n <= 65) || ageMin > ageMax) {
    throw new MetaToolkitRefusal('age_min and age_max must be integers from 18 to 65, with age_min <= age_max.');
  }
  if (args.duration_days !== undefined && (!Number.isInteger(args.duration_days) || args.duration_days < 1 || args.duration_days > MAX_DURATION_DAYS)) {
    throw new MetaToolkitRefusal(`duration_days must be an integer from 1 to ${MAX_DURATION_DAYS}.`);
  }
  if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200)) {
    throw new MetaToolkitRefusal('name must be 1-200 characters.');
  }
  return {
    ig_account_id: args.ig_account_id, ig_media_id: args.ig_media_id, page_id: args.page_id,
    daily_budget: args.daily_budget, countries: [...new Set(countries as string[])].sort(), age_min: ageMin, age_max: ageMax,
    duration_days: args.duration_days, name: args.name?.trim() || `Boost Instagram post ${args.ig_media_id}`,
  };
}

/** Run ads_boost_ig_post. `accountId` is the resolved, ownership-checked ad account. */
export async function runMetaBoostTool(
  name: MetaBoostToolName, userId: string, accountId: string, rawArgs: any, deps: MetaBoostDeps = defaultDeps,
) {
  const { confirm, preview_token: previewToken, ...args } = rawArgs ?? {};
  const spec = parseArgs(args);
  const account = `act_${String(accountId).replace(/^act_/, '')}`;

  try {
    await deps.assertReady(userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }
  const read = async (path: string, params: Record<string, string>) => {
    try {
      return await deps.readGraph(userId, accountId, path, params);
    } catch (error: any) {
      throw new MetaToolkitRefusal(`Could not read from Meta: ${errorText(error)}. Nothing was changed.`);
    }
  };

  // Ownership. Instagram and Page ids address nodes globally, so each is proven against the
  // selected ad account before anything is previewed or written.
  const igAccounts = await read(`${account}/instagram_accounts`, { fields: 'id,username', limit: '100' });
  const ig = rows(igAccounts).find((a: any) => String(a?.id) === spec.ig_account_id);
  if (!ig) throw new MetaToolkitRefusal(`Instagram account ${spec.ig_account_id} is not available to this ad account. Nothing was changed.`);
  const pages = await read(`${account}/promote_pages`, { fields: 'id,name', limit: '100' });
  const page = rows(pages).find((p: any) => String(p?.id) === spec.page_id);
  if (!page) throw new MetaToolkitRefusal(`Page ${spec.page_id} is not one this ad account can promote. Nothing was changed.`);
  let media: any;
  let after: string | undefined;
  for (let i = 0; i < MEDIA_MAX_PAGES && !media; i += 1) {
    const res = await read(`${spec.ig_account_id}/media`, { fields: 'id,caption,media_type,permalink', limit: MEDIA_PAGE_SIZE, ...(after ? { after } : {}) });
    media = rows(res).find((m: any) => String(m?.id) === spec.ig_media_id);
    const next = res?.paging?.next ? res?.paging?.cursors?.after : undefined;
    if (typeof next !== 'string' || !next || next === after) break;
    after = next;
  }
  if (!media) {
    throw new MetaToolkitRefusal(`Post ${spec.ig_media_id} was not found among the recent posts of Instagram account ${spec.ig_account_id}. Nothing was changed.`);
  }

  // Report ownership failures before reconnect guidance, but never prepare a write
  // without a recorded ads_management grant.
  assertAdsManagementGranted(await deps.listAccounts(userId), accountId);

  // Money: echoed in the account currency and converted by the same normalizer the writers use.
  let money: { params: any; confirmation: string };
  try {
    money = await deps.previewMoney(userId, accountId, { daily_budget: spec.daily_budget });
  } catch (error) {
    throw new MetaToolkitRefusal(error instanceof Error ? error.message : 'The budget could not be normalized; nothing was sent.');
  }
  const verdict = evaluateMetaSpendCeiling(deps.spendCeilingPolicy(), { field: 'daily_budget', proposed: money.params.daily_budget });
  if (!verdict.allowed) throw new MetaToolkitRefusal(`${verdict.message} Nothing was changed.`);

  const campaignParams = { name: spec.name, objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED', special_ad_categories: [] as string[] };
  const adSetParams = (endTime?: string) => ({
    name: spec.name, status: 'PAUSED', daily_budget: spec.daily_budget,
    billing_event: 'IMPRESSIONS', optimization_goal: 'POST_ENGAGEMENT', destination_type: 'ON_POST',
    targeting: { geo_locations: { countries: spec.countries }, age_min: spec.age_min, age_max: spec.age_max },
    ...(endTime ? { end_time: endTime } : {}),
  });

  /** One CREATE through the shared gate. Returns the dispatch object or a refusal reason. */
  const prepare = async (entity: string, params: any, campaignId?: string, adSetId?: string) => {
    const p = await deps.preview(userId, entity, 'CREATE', accountId, campaignId, adSetId, undefined, params);
    if (!p?.awaitingUserConfirmation || !p.metaWriteDispatch) return { error: String(p?.error || p?.message || 'The change could not be prepared.') };
    return { dispatch: p.metaWriteDispatch };
  };

  // The campaign is run through the shared gate now, so a refusal surfaces at preview.
  const campaignGate = await prepare('CAMPAIGN', campaignParams);
  if (!campaignGate.dispatch) throw new MetaToolkitRefusal(`Not prepared, nothing was sent to Meta: ${campaignGate.error}`);

  const fingerprint = previewFingerprint({
    userId, tool: name, accountId, spec, money: money.confirmation,
    media: { id: String(media.id), permalink: media.permalink ?? null },
  });
  const nowMs = deps.now();
  const secret = deps.secret();
  const previewText = [
    'PREVIEW — nothing has changed yet.',
    `Boost Instagram post ${spec.ig_media_id} of @${ig.username ?? spec.ig_account_id}${media.permalink ? ` (${media.permalink})` : ''} on ad account ${account.slice(4)}.`,
    `Creates 1 campaign (objective OUTCOME_ENGAGEMENT), 1 ad set and 1 ad named "${spec.name}", shown as Page "${page.name ?? spec.page_id}".`,
    `Daily budget${money.confirmation || `: ${spec.daily_budget}`}`,
    `Audience: ${spec.countries.join(', ')}, ages ${spec.age_min}-${spec.age_max}.`,
    spec.duration_days ? `End: ${spec.duration_days} day(s) after the ad set is created.` : 'End: no end date.',
    'Status: PAUSED — the campaign, ad set and ad are all created paused. Nothing spends until they are activated, which is a separate preview and approval.',
  ].join('\n');
  const freshPreview = () => ({ ...previewResponse({ secret, userId, now: nowMs, fingerprint, preview: previewText }), boost_spec: spec });

  if (confirm !== true) return freshPreview();
  if (!previewTokenMatches(previewToken, secret, userId, fingerprint, nowMs)) {
    return {
      ...freshPreview(),
      status: 'PREVIEW_MISMATCH',
      note: 'The confirmation did not match a current preview (missing, expired, or the arguments or Meta state changed). Nothing was sent. Show this new preview and get approval again.',
    };
  }
  if (!(await consumeToken(deps.consumedTokens, previewToken, nowMs))) {
    const replay = replayTokenOutcome(deps.tokenOutcomes, previewToken, nowMs);
    if (replay) return replay;
    throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview for another change.');
  }

  const outcome = await (async () => {
    const created: { campaign_id?: string; ad_set_id?: string; creative_id?: string; ad_id?: string } = {};
    const leftovers = () => {
      const parts = [created.campaign_id && `campaign ${created.campaign_id}`, created.ad_set_id && `ad set ${created.ad_set_id}`, created.creative_id && `creative ${created.creative_id}`].filter(Boolean);
      return parts.length
        ? ` Already created and left PAUSED (nothing is spending): ${parts.join(', ')}. Archive campaign ${created.campaign_id} with call_meta_marketing_api to clean up.`
        : ' Nothing was created.';
    };
    /** A step that stopped the boost. Unknown outcomes and partial boosts are never reported as done. */
    const stopped = (what: string, reason: string, unknown: boolean) => {
      if (unknown) {
        return {
          success: false, verification: 'UNCONFIRMED' as WriteVerification, id: created.campaign_id ?? null, created,
          message: `UNCONFIRMED: the ${what} request failed without a definite answer from Meta (${reason}), so it may or may not exist. Do not retry blindly; check the ad account first.${leftovers()}`,
        };
      }
      if (!created.campaign_id) return { status: 'FAILED', success: false, id: null, created, message: `The ${what} was refused (${reason}).${leftovers()}` };
      return {
        status: 'PARTIAL', success: false, verification: 'UNCONFIRMED' as WriteVerification, id: created.campaign_id, created,
        message: `The boost is incomplete: the ${what} was refused (${reason}).${leftovers()}`,
      };
    };
    /** Dispatch one prepared CREATE. Returns the new id, or the outcome that ends the boost. */
    const create = async (what: string, dispatch: any): Promise<{ id: string } | { stop: any }> => {
      let dispatched: { result: any; createdId?: string | null };
      try {
        dispatched = await deps.dispatch(userId, dispatch);
      } catch (error: any) {
        return { stop: stopped(what, errorText(error), true) };
      }
      const { result, createdId } = dispatched;
      if (isOutcomeUnknownFailure(result)) return { stop: stopped(what, errorText(result), true) };
      if (!result?.success || result?.blocked || result?.throttled || result?.awaitingUserConfirmation) return { stop: stopped(what, errorText(result), false) };
      if (!createdId) return { stop: stopped(what, 'Meta returned no id', true) };
      return { id: String(createdId) };
    };

    const campaign = await create('campaign', campaignGate.dispatch);
    if ('stop' in campaign) return campaign.stop;
    created.campaign_id = campaign.id;

    const endTime = spec.duration_days ? new Date(nowMs + spec.duration_days * 86_400_000).toISOString() : undefined;
    const adSetGate = await prepare('AD_SET', adSetParams(endTime), created.campaign_id).catch((e: any) => ({ error: errorText(e), dispatch: undefined }));
    if (!adSetGate.dispatch) return stopped('ad set', adSetGate.error ?? 'not prepared', false);
    const adSet = await create('ad set', adSetGate.dispatch);
    if ('stop' in adSet) return adSet.stop;
    created.ad_set_id = adSet.id;

    try {
      const creative = await deps.createCreative(userId, accountId, { name: spec.name, page_id: spec.page_id, ig_account_id: spec.ig_account_id, ig_media_id: spec.ig_media_id });
      if (!creative?.id) return stopped('creative', 'Meta returned no id', true);
      created.creative_id = String(creative.id);
    } catch (error: any) {
      return stopped('creative', errorText(error), error?.outcomeUnknown === true || (error?.outcomeUnknown === undefined && !error?.metaError));
    }

    const adGate = await prepare('AD', { name: spec.name, status: 'PAUSED', creative_id: created.creative_id }, created.campaign_id, created.ad_set_id)
      .catch((e: any) => ({ error: errorText(e), dispatch: undefined }));
    if (!adGate.dispatch) return stopped('ad', adGate.error ?? 'not prepared', false);
    const ad = await create('ad', adGate.dispatch);
    if ('stop' in ad) return ad.stop;
    created.ad_id = ad.id;

    // Read-back: all three must exist and be PAUSED, and the ad set must carry the previewed budget.
    let verification: WriteVerification;
    const mismatches: string[] = [];
    try {
      const [c, s, a] = await Promise.all([
        deps.readBack(userId, accountId, 'CAMPAIGN', created.campaign_id),
        deps.readBack(userId, accountId, 'AD_SET', created.ad_set_id),
        deps.readBack(userId, accountId, 'AD', created.ad_id),
      ]);
      if (!c || !s || !a) throw new Error('read-back returned nothing');
      if (c.status !== 'PAUSED') mismatches.push(`campaign status ${c.status}`);
      if (s.status !== 'PAUSED') mismatches.push(`ad set status ${s.status}`);
      if (a.status !== 'PAUSED') mismatches.push(`ad status ${a.status}`);
      if (Number(s.daily_budget) !== Number(money.params.daily_budget)) mismatches.push('ad set daily_budget');
      if (s.campaign_id !== undefined && String(s.campaign_id) !== created.campaign_id) mismatches.push('ad set campaign');
      verification = mismatches.length ? 'MISMATCH' : 'CONFIRMED';
    } catch {
      verification = 'UNCONFIRMED';
    }
    return {
      success: verification === 'CONFIRMED', verification, id: created.ad_id, created,
      message: verification === 'CONFIRMED'
        ? `Boost created and confirmed by read-back: campaign ${created.campaign_id}, ad set ${created.ad_set_id}, ad ${created.ad_id}, all PAUSED. Nothing is spending. To go live, activate them with call_meta_marketing_api UPDATE status=ACTIVE (its own preview and approval).`
        : verification === 'MISMATCH'
          ? `Meta accepted the boost, but the read-back differs in: ${mismatches.join(', ')}. Check campaign ${created.campaign_id} before doing anything else; pause it if anything is not PAUSED.`
          : `UNCONFIRMED: Meta accepted the boost, but the read-back failed. Do not report this as done; check campaign ${created.campaign_id} first.`,
    };
  })();
  return rememberTokenOutcome(deps.tokenOutcomes, previewToken, outcome);
}
