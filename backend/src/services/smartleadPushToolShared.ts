/**
 * Argument checks and result shapes shared by every tool that drives a Smartlead push: Emma's own tools (emma/smartleadPushTools.ts) and
 * the MCP tools for outside agents (mcp/server/smartleadTools.ts). One copy, so both validate the same way and neither ever hands the
 * signed preview token to a model.
 */
export const BAD_ARGS = 'Invalid Smartlead push arguments';

export function onlyKeys(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error(BAD_ARGS);
  // Models often send null for omitted optionals; treat null as "not provided".
  const entries = Object.entries(args).filter(([, v]) => v !== null);
  if (entries.some(([k]) => !allowed.includes(k))) throw new Error(BAD_ARGS);
  return Object.fromEntries(entries);
}


export const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
export const RUN_ID = /^[A-Za-z0-9]{10,40}$/;

export function idArg(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${what} is required`);
  return value;
}

export function campaignArg(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error('campaignId must be a positive whole number (from list_smartlead_campaigns)');
  return n;
}

export function runIdArg(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID.test(value)) throw new Error('runId is required (from get_smartlead_push_status)');
  return value;
}

/** The service's refusals carry a status and a message written for the user: surface them as the tool's error. */
export function unwrap<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (result.ok) return result as Extract<T, { ok: true }>;
  const fail = result as unknown as { message?: string; code?: string };
  throw new Error(fail.message || fail.code || 'The Smartlead push request failed');
}

export interface PushArgs {
  listId: string;
  campaignId: number;
  accountId?: string;
  includeUnverified: boolean;
  mapping: Record<string, string>;
  acknowledgedTags: string[];
  cohort?: number;
}

export const PUSH_KEYS = ['listId', 'campaignId', 'accountId', 'includeUnverified', 'mapping', 'acknowledgedTags', 'cohort', 'confirm'] as const;

export function pushArgs(args: unknown): PushArgs {
  const a = onlyKeys(args, PUSH_KEYS);
  const mappingRaw = a.mapping ?? {};
  if (typeof mappingRaw !== 'object' || Array.isArray(mappingRaw) || Object.keys(mappingRaw).length > 50) throw new Error(BAD_ARGS);
  const mapping: Record<string, string> = {};
  for (const [tag, path] of Object.entries(mappingRaw as Record<string, unknown>)) {
    if (typeof path !== 'string' || !tag || tag.length > 100 || !path || path.length > 100) throw new Error(BAD_ARGS);
    mapping[tag] = path;
  }
  const tagsRaw = a.acknowledgedTags ?? [];
  if (!Array.isArray(tagsRaw) || tagsRaw.length > 50 || tagsRaw.some(t => typeof t !== 'string' || !t || t.length > 100)) throw new Error(BAD_ARGS);
  if (a.includeUnverified !== undefined && typeof a.includeUnverified !== 'boolean') throw new Error(BAD_ARGS);
  if (a.cohort !== undefined && (typeof a.cohort !== 'number' || !Number.isSafeInteger(a.cohort) || a.cohort < 1)) throw new Error('cohort must be a positive whole number');
  return {
    listId: idArg(a.listId, 'listId'),
    campaignId: campaignArg(a.campaignId),
    ...(a.accountId !== undefined ? { accountId: idArg(a.accountId, 'accountId') } : {}),
    includeUnverified: a.includeUnverified === true,
    mapping,
    acknowledgedTags: tagsRaw as string[],
    ...(a.cohort !== undefined ? { cohort: a.cohort as number } : {}),
  };
}

export const pushBody = (p: PushArgs) => ({
  listId: p.listId,
  campaignId: p.campaignId,
  ...(p.accountId ? { accountId: p.accountId } : {}),
  includeUnverified: p.includeUnverified,
  mapping: p.mapping,
  acknowledgedTags: p.acknowledgedTags,
  ...(p.cohort !== undefined ? { cohort: p.cohort } : {}),
});

/** What the model is told about a preview: numbers and findings, never the signed token. */
export function previewSummary(p: any) {
  return {
    campaign: p.campaign,
    smartleadAccount: p.connection,
    emailStepsInCampaignSequence: p.sequence.stepCount,
    list: p.list,
    cohort: p.cohort,
    blocks: p.preflight.blocks,
    warnings: p.preflight.warnings,
    fieldsToDecide: p.preflight.tagsToMap,
    campaignAlreadySending: p.requiresActiveConfirmation === true,
    sendingWithNoUnsubscribeLink: p.requiresUnsubscribeAcknowledgement === true,
    canStart: p.canStart === true,
  };
}

/** Smartlead updates its counters on its own schedule, so a recent send or push may not show yet. */
export const STATS_LAG_NOTE = "Smartlead's counts can lag a few minutes behind a recent push or send.";

/** A campaign's numbers as the tools report them: Smartlead's counts (no opens or clicks) and the lag note. */
export function campaignStatsSummary(stats: {
  campaignId: number; name: string; status: string; leadsInCampaign?: number;
  contactsEmailed: number; emailsSent: number; replies: number; bounces: number; unsubscribes: number;
}) {
  return {
    campaign: { id: stats.campaignId, name: stats.name, status: stats.status },
    stats: {
      ...(stats.leadsInCampaign !== undefined ? { leadsInCampaign: stats.leadsInCampaign } : {}),
      contactsEmailed: stats.contactsEmailed,
      emailsSent: stats.emailsSent,
      replies: stats.replies,
      bounces: stats.bounces,
      unsubscribes: stats.unsubscribes,
    },
    note: STATS_LAG_NOTE,
  };
}
