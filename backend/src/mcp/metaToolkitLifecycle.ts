/**
 * ENG-2922 — guarded ARCHIVE / DELETE / COPY of Meta campaigns, ad sets and ads for
 * external Zoma agents. Same preview → confirm flow as metaToolkitWrites.ts (shared guard,
 * zomaWriteGuard.ts): a call without confirm returns a PREVIEW and a single-use
 * preview_token bound to the user, the exact arguments and the Meta state the preview
 * showed (status, last-24h spend); confirm=true + that token applies it once, then reads
 * it back. Only CONFIRMED is success.
 *
 *   ARCHIVE  status → ARCHIVED (stops delivery; Meta keeps the object and its history).
 *   DELETE   irreversible. Meta keeps the history but the object can never run again.
 *   COPY     Meta /copies with status_option=PAUSED (deep_copy for CAMPAIGN / AD_SET);
 *            the copy is read back and must be PAUSED.
 *
 * Spend guard: ARCHIVE and DELETE are refused when the entity spent in the last 24 hours
 * (or its spend cannot be read) unless confirm_recent_spend=true — a live entity should
 * be paused first, or the user must explicitly accept stopping it mid-delivery.
 *
 * Same write gate as every external write: payment method + usable Meta connection + a
 * GRANTED ads_management scope. Every node is read through the selected ad account
 * (ownership); a COPY destination must be in the same account.
 */
import { getJwtSecret } from '../config/jwt';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import type { LifecycleEntity, MetaCopyOptions, MetaGraphContext, MetaNodeState } from '../services/agentMode/metaToolkitLifecycleGraph';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { assertAdsManagementGranted } from './metaToolkitWrites';
import { LIFECYCLE_WRITE_ACTIONS } from './metaToolkitWriteSurface';
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import {
  consumePreviewToken, previewFingerprint, previewResponse, previewTokenMatches, type WriteVerification,
} from './zomaWriteGuard';

type LifecycleAction = (typeof LIFECYCLE_WRITE_ACTIONS)[number];

export interface MetaToolkitLifecycleDeps {
  assertReady: (userId: string) => Promise<void>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  /** Ownership-scoped read; null = missing or not in this ad account. */
  readNode: (userId: string, accountId: string, entity: LifecycleEntity, id: string) => Promise<MetaNodeState | null>;
  /** Spend over at least the last 24 hours, major units of the account currency. */
  recentSpend: (userId: string, accountId: string, entity: LifecycleEntity, id: string) => Promise<number>;
  archive: (userId: string, accountId: string, entity: LifecycleEntity, id: string) => Promise<void>;
  remove: (userId: string, accountId: string, entity: LifecycleEntity, id: string) => Promise<void>;
  copy: (userId: string, accountId: string, entity: LifecycleEntity, id: string, opts: MetaCopyOptions) => Promise<{ copiedId?: string; childIds: string[] }>;
  secret: () => string;
  now: () => number;
  consumedTokens: Map<string, number>;
}

// Loaded lazily: the agentMode monolith and Meta SDK are not imported unless a write runs.
const graph = async () => import('../services/agentMode/metaToolkitLifecycleGraph');
async function graphContext(userId: string, accountId: string): Promise<MetaGraphContext> {
  const { agentModeService } = await import('../services/agentModeService');
  const axios = (await import('axios')).default;
  const { attachMetaToolkitBackoff } = await import('../utils/metaToolkitBackoff');
  // Bounded: a stalled Graph call must not hold the request open (a hung COPY retried after a
  // client timeout could create a second copy).
  return { http: attachMetaToolkitBackoff(axios.create({ timeout: 30_000 })), ...(await agentModeService.getToolkitMetaGraphCredentials(userId, accountId)) };
}
async function metaWriter(userId: string, accountId: string) {
  const { metaService } = await import('../services/metaService');
  const ctx = await graphContext(userId, accountId);
  return { metaService, ctx };
}

const defaultDeps: MetaToolkitLifecycleDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId),
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  readNode: async (userId, accountId, _entity, id) => (await graph()).readOwnedMetaNode(await graphContext(userId, accountId), id),
  recentSpend: async (userId, accountId, _entity, id) => (await graph()).readMetaRecentSpend(await graphContext(userId, accountId), id, Date.now()),
  // metaService's writers re-verify ownership inside the write itself (ENG-1724).
  archive: async (userId, accountId, entity, id) => {
    const { metaService: m, ctx } = await metaWriter(userId, accountId);
    const p = { status: 'ARCHIVED' };
    if (entity === 'CAMPAIGN') await m.updateCampaign(ctx.accessToken, id, p, ctx.accountId);
    else if (entity === 'AD_SET') await m.updateAdSet(ctx.accessToken, id, p, ctx.accountId);
    else await m.updateAd(ctx.accessToken, id, p, ctx.accountId);
  },
  remove: async (userId, accountId, entity, id) => {
    const { metaService: m, ctx } = await metaWriter(userId, accountId);
    if (entity === 'CAMPAIGN') await m.deleteCampaign(ctx.accessToken, id, ctx.accountId);
    else if (entity === 'AD_SET') await m.deleteAdSet(ctx.accessToken, id, ctx.accountId);
    else await m.deleteAd(ctx.accessToken, id, ctx.accountId);
  },
  copy: async (userId, accountId, entity, id, opts) => (await graph()).copyMetaNode(await graphContext(userId, accountId), entity, id, opts),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: new Map(),
};

const ID_FIELD: Record<LifecycleEntity, string> = { CAMPAIGN: 'campaign_id', AD_SET: 'ad_set_id', AD: 'ad_id' };
const COPY_PARAMS: Record<LifecycleEntity, string[]> = {
  CAMPAIGN: ['deep_copy', 'status_option'],
  AD_SET: ['deep_copy', 'campaign_id', 'status_option'],
  AD: ['adset_id', 'status_option'],
};
const TARGET_STATUS: Record<'ARCHIVE' | 'DELETE', string> = { ARCHIVE: 'ARCHIVED', DELETE: 'DELETED' };

function describe(entity: string, node: MetaNodeState): string {
  return `${entity} ${node.name ? `"${node.name}" ` : ''}(id ${node.id}, status ${node.status ?? 'unknown'}${node.effective_status ? `, effective ${node.effective_status}` : ''})`;
}

/** Shape checks that need no I/O. Returns the target id and the COPY options. */
function validateShape(entity: LifecycleEntity, action: LifecycleAction, args: any): { id: string; opts: MetaCopyOptions } {
  if (args.client_id !== undefined) throw new MetaToolkitRefusal('client_id is not available to external Meta Toolkit callers.');
  const id = args[ID_FIELD[entity]];
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new MetaToolkitRefusal(`${entity} ${action} requires ${ID_FIELD[entity]}.`);
  const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? { ...args.params } : {};
  // An AD_SET is identified by ad_set_id, so a top-level campaign_id on an AD_SET COPY can only
  // mean the destination campaign. It used to be dropped silently, copying the ad set back into
  // its own campaign instead of the one the user named.
  if (action === 'COPY' && entity === 'AD_SET' && params.campaign_id === undefined && args.campaign_id !== undefined) {
    params.campaign_id = typeof args.campaign_id === 'number' ? String(args.campaign_id) : args.campaign_id;
  }
  const keys = Object.keys(params).filter((k) => params[k] !== undefined);
  const allowed = action === 'COPY' ? COPY_PARAMS[entity] : [];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw new MetaToolkitRefusal(`${entity} ${action} via the Meta Toolkit accepts ${allowed.length ? `only params: ${allowed.join(', ')}` : 'no params'}. Not allowed: ${extra.join(', ')}.`);
  }
  if (params.status_option !== undefined && params.status_option !== 'PAUSED') {
    throw new MetaToolkitRefusal('Copies are always created PAUSED. Activate the copy afterwards with UPDATE status=ACTIVE and its own preview and approval.');
  }
  if (params.deep_copy !== undefined && typeof params.deep_copy !== 'boolean') throw new MetaToolkitRefusal('params.deep_copy must be true or false.');
  for (const k of ['campaign_id', 'adset_id']) {
    if (params[k] !== undefined && !(typeof params[k] === 'string' && /^\d+$/.test(params[k]))) throw new MetaToolkitRefusal(`params.${k} must be a numeric id.`);
  }
  return { id, opts: { deep_copy: params.deep_copy, campaign_id: params.campaign_id, adset_id: params.adset_id } };
}

/**
 * Execute (or preview) one ARCHIVE / DELETE / COPY. `args.account_id` must already be the
 * resolved, ownership-checked ad account (the gateway does that before calling here).
 */
export async function executeMetaToolkitLifecycle(userId: string, rawArgs: any, deps: MetaToolkitLifecycleDeps = defaultDeps) {
  const { confirm, preview_token: previewToken, confirm_recent_spend: confirmRecentSpend, ...args } = rawArgs ?? {};
  const entity = String(args.entity_type) as LifecycleEntity;
  const action = String(args.action) as LifecycleAction;
  const accountId = String(args.account_id ?? '');
  const { id, opts } = validateShape(entity, action, args);
  if (confirmRecentSpend !== undefined && typeof confirmRecentSpend !== 'boolean') throw new MetaToolkitRefusal('confirm_recent_spend must be true or false.');

  try {
    await deps.assertReady(userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }
  assertAdsManagementGranted(await deps.listAccounts(userId), accountId);

  const node = await deps.readNode(userId, accountId, entity, id);
  if (!node) throw new MetaToolkitRefusal(`${entity} ${id} was not found in ad account ${accountId}. Nothing was changed.`);

  if (action !== 'COPY' && node.status === TARGET_STATUS[action]) {
    return { status: 'NO_CHANGE', success: true, message: `${describe(entity, node)} is already ${node.status}. Nothing was changed.` };
  }
  if (node.status === 'DELETED') throw new MetaToolkitRefusal(`${describe(entity, node)} is deleted and cannot be ${action === 'COPY' ? 'copied' : 'archived'}.`);

  let destination: MetaNodeState | null = null;
  if (action === 'COPY' && (opts.campaign_id || opts.adset_id)) {
    const destEntity: LifecycleEntity = opts.campaign_id ? 'CAMPAIGN' : 'AD_SET';
    destination = await deps.readNode(userId, accountId, destEntity, (opts.campaign_id || opts.adset_id)!);
    if (!destination) throw new MetaToolkitRefusal(`The copy destination ${destEntity} ${opts.campaign_id || opts.adset_id} was not found in ad account ${accountId}. Nothing was changed.`);
  }

  // Spend guard (ARCHIVE / DELETE only). Unknown spend is treated like recent spend.
  let spend: number | null = null;
  if (action !== 'COPY') {
    spend = await deps.recentSpend(userId, accountId, entity, id).catch(() => null);
    if (confirmRecentSpend !== true && (spend === null || spend > 0)) {
      throw new MetaToolkitRefusal(
        spend === null
          ? `Zoma could not read the last 24 hours of spend for ${describe(entity, node)}, so it will not ${action.toLowerCase()} it. Pause it first, or repeat with confirm_recent_spend=true only if the user explicitly accepts stopping it without that check.`
          : `${describe(entity, node)} spent ${spend.toFixed(2)} (account currency) in the last 24 hours. Pause it first, or repeat with confirm_recent_spend=true only if the user explicitly accepts stopping it while it is spending.`,
      );
    }
  }

  const fingerprint = previewFingerprint({
    userId, entity, action, accountId, id, opts,
    // Bind the configured status and the spend CATEGORY, not the amount or effective_status:
    // both move on a live entity between preview and approval, which would turn every
    // confirm_recent_spend confirmation into PREVIEW_MISMATCH. 0 → spending still invalidates.
    node: { status: node.status ?? null },
    destination: destination?.id ?? null,
    spend: spend === null ? 'unknown' : spend > 0 ? 'spent' : 'none',
    confirmRecentSpend: confirmRecentSpend === true,
  });
  const now = deps.now();
  const secret = deps.secret();
  const spendLine = spend === null ? '' : `Spend in the last 24 hours: ${spend.toFixed(2)} (account currency).`;
  const previewText = [
    'PREVIEW — nothing has changed yet.',
    action === 'ARCHIVE' ? `Archive ${describe(entity, node)}. Delivery stops; Meta keeps it and its history (it can no longer be edited, only viewed).` : '',
    action === 'DELETE' ? `DELETE ${describe(entity, node)}. This cannot be undone: it stops delivery and can never run again. Archive instead if the user may want it back.` : '',
    action === 'COPY'
      ? `Copy ${describe(entity, node)}${destination ? ` into ${opts.campaign_id ? 'campaign' : 'ad set'} ${destination.name ? `"${destination.name}" ` : ''}(id ${destination.id})` : ''}${opts.deep_copy ? ', including its ad sets and ads' : ''}.`
      : '',
    spendLine,
    spend !== null && spend > 0 ? 'The user accepted stopping it while it is spending (confirm_recent_spend).' : '',
    spend === null && action !== 'COPY' ? 'Recent spend could not be checked; the user accepted proceeding without that check (confirm_recent_spend).' : '',
    action === 'COPY' ? 'Status: PAUSED — the copy is created paused; going live is a separate preview and approval.' : '',
  ].filter(Boolean).join('\n');
  const freshPreview = () => previewResponse({ secret, userId, now, fingerprint, preview: previewText });

  if (confirm !== true) return freshPreview();

  if (!previewTokenMatches(previewToken, secret, userId, fingerprint, now)) {
    return {
      ...freshPreview(),
      status: 'PREVIEW_MISMATCH',
      note: 'The confirmation did not match a current preview (missing, expired, or the arguments or Meta state changed). Nothing was sent. Show this new preview and get approval again.',
    };
  }
  if (!consumePreviewToken(deps.consumedTokens, previewToken, now)) {
    throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview for another change.');
  }

  // A thrown write may still have applied (timeout, network), so the read-back decides.
  let applyError: string | undefined;
  let metaAnswered = false;
  let copied: { copiedId?: string; childIds: string[] } = { childIds: [] };
  try {
    if (action === 'ARCHIVE') await deps.archive(userId, accountId, entity, id);
    else if (action === 'DELETE') await deps.remove(userId, accountId, entity, id);
    else copied = await deps.copy(userId, accountId, entity, id, opts);
  } catch (error) {
    applyError = error instanceof Error ? error.message : String(error);
    metaAnswered = !!(error as any)?.response;
  }

  const readId = action === 'COPY' ? copied.copiedId : id;
  let readBack: MetaNodeState | null = null;
  let readFailed = !readId;
  if (readId) {
    try {
      readBack = await deps.readNode(userId, accountId, entity, readId);
    } catch {
      readFailed = true;
    }
  }
  // Meta answered with an error and the read-back shows nothing changed: a definite failure.
  const unchanged = action === 'COPY' ? !readId && metaAnswered : !!readBack && readBack.status === node.status;
  if (applyError && unchanged) {
    return { status: 'FAILED', success: false, message: `Meta refused the ${action}: ${applyError}. Nothing was changed.` };
  }
  // An unreadable node proves a DELETE only when the delete itself succeeded; after an error
  // (e.g. the token lost access) "not readable" is not evidence of deletion.
  const verification = action === 'DELETE' && applyError && !readBack ? 'UNCONFIRMED' : verifyLifecycle(action, readBack, readFailed);
  const base = {
    success: verification === 'CONFIRMED',
    verification,
    id: readId ?? null,
    ...(action === 'COPY' ? { source_id: id, child_ids: copied.childIds } : {}),
    status: readBack?.status ?? (action === 'DELETE' && verification === 'CONFIRMED' ? 'DELETED' : null),
    effective_status: readBack?.effective_status ?? null,
    ...(applyError ? { meta_message: applyError } : {}),
  };
  if (verification === 'CONFIRMED') {
    const done = action === 'COPY' ? `copied to ${readId} (PAUSED${copied.childIds.length ? `, ${copied.childIds.length} child objects` : ''})` : `${TARGET_STATUS[action].toLowerCase()}`;
    return { ...base, message: `${action} ${entity} confirmed by read-back: ${entity} ${id} ${done}.` };
  }
  if (verification === 'MISMATCH') {
    return { ...base, message: `Meta accepted the ${action}, but the read-back does not match what was approved (status ${readBack?.status ?? 'unknown'}). Review ${entity} ${readId} before doing anything else.` };
  }
  return {
    ...base,
    message: `UNCONFIRMED: the ${action} of ${entity} ${id}${applyError ? ` returned an error (${applyError})` : ' was sent'}, but the read-back could not confirm it. Do not report this as done and do not retry blindly — check the ${entity} first.`,
  };
}

function verifyLifecycle(action: LifecycleAction, readBack: MetaNodeState | null, readFailed: boolean): WriteVerification {
  if (readFailed) return 'UNCONFIRMED';
  // A deleted node may stop being readable at all; that is the delete taking effect.
  if (action === 'DELETE') return !readBack || readBack.status === 'DELETED' ? 'CONFIRMED' : 'MISMATCH';
  if (!readBack) return 'UNCONFIRMED';
  const expected = action === 'ARCHIVE' ? 'ARCHIVED' : 'PAUSED';
  return readBack.status === expected ? 'CONFIRMED' : 'MISMATCH';
}
