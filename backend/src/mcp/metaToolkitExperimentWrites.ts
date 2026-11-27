/**
 * ENG-2980 (ENG-2919 slice 2) — Zoma Meta experiment writes for external agents.
 *
 *   ads_experiment_check_eligibility   READ: can these campaigns of this account run in a new study?
 *   ads_experiment_abtest_create_test  create an A/B split test          (preview → confirm)
 *   ads_experiment_abtest_update_test  update an A/B split test's details (preview → confirm)
 *   ads_experiment_lift_create_test    create a conversion lift study     (preview → confirm)
 *
 * Ownership: every campaign id must belong to the resolved ad account (read `<id>?fields=account_id`),
 * and an updated study id must be on the account's own `act_<id>/ad_studies` edge — ad studies
 * are globally addressed, so a guessed id from another account is refused. Writes use the shared
 * Zoma guard (zomaWriteGuard): the first call returns a PREVIEW with the full study spec and a
 * single-use preview_token; nothing reaches Meta without confirm=true and that token. A created
 * study never starts before the confirm: start_time must be in the future (default +24h).
 * Every write is read back from the study node and compared field by field; only CONFIRMED is success.
 */
import { getJwtSecret } from '../config/jwt';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { explainMetaError } from './metaToolkitDiagnostics';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches,
  rememberTokenOutcome, replayTokenOutcome, type WriteVerification,
} from './zomaWriteGuard';

export const META_EXPERIMENT_WRITE_TOOL_NAMES = [
  'ads_experiment_check_eligibility', 'ads_experiment_abtest_create_test',
  'ads_experiment_abtest_update_test', 'ads_experiment_lift_create_test',
] as const;
export type MetaExperimentWriteToolName = (typeof META_EXPERIMENT_WRITE_TOOL_NAMES)[number];

export function isMetaExperimentWriteTool(name: string): name is MetaExperimentWriteToolName {
  return (META_EXPERIMENT_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

export const EXPERIMENT_WRITE_KIND: Partial<Record<MetaExperimentWriteToolName, { entityType: 'AD_STUDY'; action: 'CREATE' | 'UPDATE' }>> = {
  ads_experiment_abtest_create_test: { entityType: 'AD_STUDY', action: 'CREATE' },
  ads_experiment_abtest_update_test: { entityType: 'AD_STUDY', action: 'UPDATE' },
  ads_experiment_lift_create_test: { entityType: 'AD_STUDY', action: 'CREATE' },
};

/** True for the tools that change Meta state (write scope). The eligibility check is read-only. */
export function isMetaExperimentWrite(name: string): boolean {
  return isMetaExperimentWriteTool(name) && EXPERIMENT_WRITE_KIND[name] !== undefined;
}

const STUDY_FIELDS = 'id,name,type,description,start_time,end_time,cells{id,name,treatment_percentage,campaigns}';
const DEFAULT_START_DELAY_S = 24 * 60 * 60;
const MIN_DURATION_S = 4 * 24 * 60 * 60;
const MAX_DURATION_S = 90 * 24 * 60 * 60;

const ACCOUNT_PROP = { account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' } };
const CONFIRM_PROPS = {
  confirm: { type: 'boolean', description: 'Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.' },
  preview_token: { type: 'string', description: 'The preview_token of the preview the user approved. Single use, 15 minutes; repeat the previewed arguments exactly.' },
};
const CELLS_PROP = {
  cells: {
    type: 'array', minItems: 2, maxItems: 5,
    description: 'Study cells. Each cell holds campaigns of this ad account; treatment percentages must sum to 100.',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        treatment_percentage: { type: 'integer', minimum: 1, maximum: 99 },
        campaign_ids: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[0-9]+$' } },
      },
      required: ['name', 'treatment_percentage', 'campaign_ids'],
      additionalProperties: false,
    },
  },
};
const SPEC_PROPS = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: 'string', maxLength: 1000 },
  start_time: { type: 'integer', description: 'Unix seconds; must be in the future. Default: 24 hours from now.' },
  end_time: { type: 'integer', description: 'Unix seconds; 4 to 90 days after start_time.' },
};

export const META_EXPERIMENT_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'ads_experiment_check_eligibility',
    description: 'Read-only. Check whether campaigns of the selected Meta ad account can run in a new A/B test or lift study; returns eligible plus reasons.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, campaign_ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', pattern: '^[0-9]+$' } } },
      required: ['campaign_ids'], additionalProperties: false,
    },
  },
  {
    name: 'ads_experiment_abtest_create_test',
    description: 'Create an A/B split test across campaigns of this ad account. Two calls: PREVIEW (full study spec) + preview_token, then confirm=true with the token. The test starts no earlier than start_time. Verified by read-back.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...SPEC_PROPS, ...CELLS_PROP, ...CONFIRM_PROPS }, required: ['name', 'end_time', 'cells'], additionalProperties: false },
  },
  {
    name: 'ads_experiment_abtest_update_test',
    description: 'Update the name, description, start or end time of an A/B split test on this ad account. Two calls: PREVIEW + preview_token, then confirm=true with the token. Verified by read-back.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, study_id: { type: 'string', pattern: '^[0-9]+$' }, ...SPEC_PROPS, ...CONFIRM_PROPS },
      required: ['study_id'], additionalProperties: false,
    },
  },
  {
    name: 'ads_experiment_lift_create_test',
    description: 'Create a conversion lift study across campaigns of this ad account (test vs. holdout cells). Two calls: PREVIEW (full study spec) + preview_token, then confirm=true with the token. Verified by read-back.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...SPEC_PROPS, ...CELLS_PROP, ...CONFIRM_PROPS }, required: ['name', 'end_time', 'cells'], additionalProperties: false },
  },
];

export interface MetaExperimentWriteDeps {
  /** Account-bound Graph call; the service enforces the path allowlist and strips the token from errors. */
  graph: (userId: string, accountId: string, method: 'GET' | 'POST', path: string, params: Record<string, string>) => Promise<any>;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
  tokenOutcomes: Map<string, { exp: number; outcome: any }>;
}

const defaultDeps: MetaExperimentWriteDeps = {
  graph: async (userId, accountId, method, path, params) =>
    (await import('../services/agentModeService')).agentModeService.toolkitMetaExperimentGraph(userId, accountId, method, path, params),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
  tokenOutcomes: new Map(),
};

const metaMessage = (error: any) => String(error?.metaError?.message || error?.message || 'Meta request failed');
const list = (res: any): any[] => (Array.isArray(res?.data) ? res.data : []);
const numericId = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);

function assertOnlyKeys(args: any, allowed: string[]) {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !allowed.includes(k));
  if (extra.length) throw new MetaToolkitRefusal(`Not allowed: ${extra.join(', ')}. Allowed: ${allowed.join(', ')}.`);
}

/** A Graph failure explained through the ENG-2921 error explainer, never with credentials. */
function graphRefusal(error: any, doing: string): MetaToolkitRefusal {
  const meta = error?.metaError;
  let hint = '';
  try {
    if (meta?.code !== undefined) {
      const explained: any = explainMetaError({ code: String(meta.code), ...(typeof meta.message === 'string' ? { message: meta.message } : {}) });
      if (explained?.known && typeof explained.action === 'string') hint = ` ${explained.action}`;
    }
  } catch { /* explainer is advisory */ }
  return new MetaToolkitRefusal(`Could not ${doing}: ${metaMessage(error)}.${hint} Nothing was changed.`);
}

interface CellSpec { name: string; treatment_percentage: number; campaign_ids: string[] }

function parseCells(raw: unknown): CellSpec[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 5) throw new MetaToolkitRefusal('cells must be 2 to 5 cells.');
  const seen = new Set<string>();
  const cells = raw.map((c: any, i) => {
    if (!c || typeof c !== 'object') throw new MetaToolkitRefusal(`cells[${i}] must be an object.`);
    assertOnlyKeys(c, ['name', 'treatment_percentage', 'campaign_ids']);
    if (typeof c.name !== 'string' || !c.name.trim()) throw new MetaToolkitRefusal(`cells[${i}].name is required.`);
    if (!Number.isInteger(c.treatment_percentage) || c.treatment_percentage < 1 || c.treatment_percentage > 99) {
      throw new MetaToolkitRefusal(`cells[${i}].treatment_percentage must be an integer from 1 to 99.`);
    }
    if (!Array.isArray(c.campaign_ids) || c.campaign_ids.length === 0 || !c.campaign_ids.every(numericId)) {
      throw new MetaToolkitRefusal(`cells[${i}].campaign_ids must be numeric Meta campaign ids.`);
    }
    for (const id of c.campaign_ids) {
      if (seen.has(id)) throw new MetaToolkitRefusal(`Campaign ${id} is in more than one cell.`);
      seen.add(id);
    }
    return { name: c.name.trim(), treatment_percentage: c.treatment_percentage, campaign_ids: [...c.campaign_ids] };
  });
  if (cells.reduce((s, c) => s + c.treatment_percentage, 0) !== 100) throw new MetaToolkitRefusal('Cell treatment_percentage values must sum to 100.');
  return cells;
}

function parseWindow(args: any, nowS: number, required: boolean): { start_time?: number; end_time?: number } {
  const out: { start_time?: number; end_time?: number } = {};
  for (const k of ['start_time', 'end_time'] as const) {
    if (args[k] === undefined) continue;
    if (!Number.isInteger(args[k])) throw new MetaToolkitRefusal(`${k} must be Unix seconds.`);
    out[k] = args[k];
  }
  if (required) {
    out.start_time ??= nowS + DEFAULT_START_DELAY_S;
    if (out.end_time === undefined) throw new MetaToolkitRefusal('end_time is required.');
  }
  if (out.start_time !== undefined && out.start_time <= nowS) {
    throw new MetaToolkitRefusal('start_time must be in the future, so the study cannot start before it is confirmed.');
  }
  if (out.start_time !== undefined && out.end_time !== undefined) {
    const d = out.end_time - out.start_time;
    if (d < MIN_DURATION_S || d > MAX_DURATION_S) throw new MetaToolkitRefusal('A study must run 4 to 90 days (end_time - start_time).');
  }
  return out;
}

const iso = (s: number | undefined) => (s === undefined ? 'unchanged' : new Date(s * 1000).toISOString());

/** Run one ENG-2980 tool. `accountId` is the resolved, ownership-checked ad account. */
export async function runMetaExperimentWriteTool(
  name: MetaExperimentWriteToolName, userId: string, accountId: string, rawArgs: any, deps: MetaExperimentWriteDeps = defaultDeps,
) {
  const { confirm, preview_token: previewToken, ...args } = rawArgs ?? {};
  const account = `act_${String(accountId).replace(/^act_/, '')}`;
  const accountNum = account.slice(4);
  const get = async (path: string, params: Record<string, string>) => {
    try {
      return await deps.graph(userId, accountId, 'GET', path, params);
    } catch (error: any) {
      throw graphRefusal(error, 'read from Meta');
    }
  };

  /** Each campaign must be on this ad account; returns its effective status for eligibility. */
  const campaignsOf = async (ids: string[]) => {
    const out = new Map<string, any>();
    for (const id of ids) {
      const c = await get(id, { fields: 'id,name,account_id,effective_status,objective' });
      if (String(c?.account_id ?? '').replace(/^act_/, '') !== accountNum) {
        throw new MetaToolkitRefusal(`Campaign ${id} is not in the selected ad account. Nothing was changed.`);
      }
      out.set(id, c);
    }
    return out;
  };
  /** Campaigns already in a running or scheduled study on this account. */
  const campaignsInStudies = async () => {
    const nowS = Math.floor(deps.now() / 1000);
    const busy = new Map<string, string>();
    const studies = await get(`${account}/ad_studies`, { fields: 'id,end_time,cells{campaigns}', limit: '100' });
    for (const s of list(studies)) {
      const end = Date.parse(String(s?.end_time ?? '')) / 1000;
      if (Number.isFinite(end) && end <= nowS) continue;
      for (const cell of list(s?.cells)) for (const camp of list(cell?.campaigns)) busy.set(String(camp?.id ?? camp), String(s.id));
    }
    return busy;
  };
  const ownedStudy = async (studyId: string) => {
    let after: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 50; page += 1) {
      const owned = await get(`${account}/ad_studies`, { fields: 'id', limit: '100', ...(after ? { after } : {}) });
      if (list(owned).some((s: any) => String(s?.id) === studyId)) return;
      const next = owned?.paging?.next ? owned?.paging?.cursors?.after : undefined;
      if (typeof next !== 'string' || !next || seen.has(next)) break;
      seen.add(next); after = next;
    }
    throw new MetaToolkitRefusal(`Study ${studyId} is not in the selected ad account. Nothing was changed.`);
  };

  if (name === 'ads_experiment_check_eligibility') {
    assertOnlyKeys(args, ['account_id', 'campaign_ids']);
    const ids = args.campaign_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every(numericId)) {
      throw new MetaToolkitRefusal('campaign_ids must be 1 to 50 numeric Meta campaign ids.');
    }
    const campaigns = await campaignsOf(ids);
    const busy = await campaignsInStudies();
    const results = ids.map((id: string) => {
      const reasons: string[] = [];
      const status = String(campaigns.get(id)?.effective_status ?? '');
      if (['DELETED', 'ARCHIVED'].includes(status)) reasons.push(`Campaign is ${status.toLowerCase()}.`);
      if (busy.has(id)) reasons.push(`Campaign is already in study ${busy.get(id)}.`);
      return { campaign_id: id, name: campaigns.get(id)?.name ?? null, effective_status: status || null, eligible: reasons.length === 0, reasons };
    });
    const reasons = results.flatMap((r: any) => r.reasons.map((m: string) => `${r.campaign_id}: ${m}`));
    if (ids.length < 2) reasons.push('A split test or lift study needs campaigns for at least 2 cells.');
    return { account_id: accountId, eligible: reasons.length === 0, reasons, campaigns: results };
  }

  const nowMs = deps.now();
  const nowS = Math.floor(nowMs / 1000);
  const creating = name !== 'ads_experiment_abtest_update_test';
  const type = name === 'ads_experiment_lift_create_test' ? 'LIFT' : 'SPLIT_TEST';
  let studyId: string | undefined;
  let spec: Record<string, any>;
  let before: any = null;

  if (creating) {
    assertOnlyKeys(args, ['account_id', 'name', 'description', 'start_time', 'end_time', 'cells']);
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200) throw new MetaToolkitRefusal('name is required (1-200 characters).');
    if (args.description !== undefined && (typeof args.description !== 'string' || args.description.length > 1000)) throw new MetaToolkitRefusal('description must be a string up to 1000 characters.');
    const cells = parseCells(args.cells);
    const window = parseWindow(args, nowS, true);
    await campaignsOf(cells.flatMap((c) => c.campaign_ids));
    const busy = await campaignsInStudies();
    const clash = cells.flatMap((c) => c.campaign_ids).filter((id) => busy.has(id));
    if (clash.length) throw new MetaToolkitRefusal(`Campaigns already in a study: ${clash.join(', ')}. Nothing was changed.`);
    spec = { type, name: args.name.trim(), description: args.description, ...window, cells };
  } else {
    assertOnlyKeys(args, ['account_id', 'study_id', 'name', 'description', 'start_time', 'end_time']);
    if (!numericId(args.study_id)) throw new MetaToolkitRefusal('study_id must be a numeric string.');
    studyId = args.study_id as string;
    await ownedStudy(studyId);
    before = await get(studyId, { fields: STUDY_FIELDS });
    if (before?.type && String(before.type).toUpperCase() !== 'SPLIT_TEST') {
      throw new MetaToolkitRefusal(`Study ${studyId} is type ${before.type}, not SPLIT_TEST. Nothing was changed.`);
    }
    if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200)) throw new MetaToolkitRefusal('name must be 1-200 characters.');
    if (args.description !== undefined && (typeof args.description !== 'string' || args.description.length > 1000)) throw new MetaToolkitRefusal('description must be a string up to 1000 characters.');
    const window = parseWindow(args, nowS, false);
    if (window.start_time === undefined && window.end_time !== undefined) {
      const start = Date.parse(String(before?.start_time ?? '')) / 1000;
      if (Number.isFinite(start)) {
        const d = window.end_time - start;
        if (d < MIN_DURATION_S || d > MAX_DURATION_S) throw new MetaToolkitRefusal('A study must run 4 to 90 days (end_time - start_time).');
      }
    }
    spec = { name: args.name?.trim(), description: args.description, ...window };
    if (Object.values(spec).every((v) => v === undefined)) throw new MetaToolkitRefusal('Nothing to update: give name, description, start_time or end_time.');
  }

  const fingerprint = previewFingerprint({ userId, tool: name, accountId, studyId, spec, before: before ? { name: before.name, description: before.description, start_time: before.start_time, end_time: before.end_time } : null });
  const secret = deps.secret();
  const previewText = [
    'PREVIEW — nothing has changed yet.',
    creating ? `Create ${type === 'LIFT' ? 'conversion lift study' : 'A/B split test'} "${spec.name}" on ad account ${accountNum}.` : `Update A/B split test ${studyId} ("${before?.name ?? ''}").`,
    ...(spec.name !== undefined && !creating ? [`Name: "${before?.name ?? ''}" -> "${spec.name}"`] : []),
    ...(spec.description !== undefined ? [`Description: ${spec.description}`] : []),
    `Start: ${iso(spec.start_time)}${creating ? ' (the study cannot start before this)' : ''}`,
    `End: ${iso(spec.end_time)}`,
    ...(creating ? (spec.cells as CellSpec[]).map((c) => `Cell "${c.name}": ${c.treatment_percentage}% — campaigns ${c.campaign_ids.join(', ')}`) : []),
  ].join('\n');
  const freshPreview = () => ({ ...previewResponse({ secret, userId, now: nowMs, fingerprint, preview: previewText }), study_spec: spec });

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

  const what = creating ? `${type === 'LIFT' ? 'lift study' : 'A/B test'} create` : 'A/B test update';
  const outcome = await (async () => {
    const params: Record<string, string> = {};
    for (const k of ['type', 'name', 'description', 'start_time', 'end_time'] as const) if (spec[k] !== undefined) params[k] = String(spec[k]);
    if (creating) {
      params.cells = JSON.stringify((spec.cells as CellSpec[]).map((c) => ({ name: c.name, treatment_percentage: c.treatment_percentage, campaigns: c.campaign_ids })));
    }
    let id = studyId;
    try {
      const res = await deps.graph(userId, accountId, 'POST', creating ? `${account}/ad_studies` : (studyId as string), params);
      if (creating) id = res?.id ? String(res.id) : undefined;
    } catch (error: any) {
      const unknown = error?.outcomeUnknown === true || (error?.outcomeUnknown === undefined && !error?.metaError);
      return unknown
        ? { success: false, verification: 'UNCONFIRMED' as WriteVerification, id: studyId ?? null, message: `UNCONFIRMED: the ${what} failed without a definite answer from Meta (${metaMessage(error)}). Check ads_experiment_list_tests before retrying.` }
        : { status: 'FAILED', success: false, id: studyId ?? null, message: graphRefusal(error, `apply the ${what}`).message.replace(' Nothing was changed.', ' Meta refused it; nothing was changed.') };
    }
    if (!id) return { success: false, verification: 'UNCONFIRMED' as WriteVerification, id: null, message: `UNCONFIRMED: Meta accepted the ${what} but returned no study id. Check ads_experiment_list_tests before retrying.` };
    let verification: WriteVerification;
    const mismatches: string[] = [];
    try {
      const after = await deps.graph(userId, accountId, 'GET', id, { fields: STUDY_FIELDS });
      if (spec.name !== undefined && after?.name !== spec.name) mismatches.push('name');
      if (spec.description !== undefined && (after?.description ?? '') !== spec.description) mismatches.push('description');
      for (const k of ['start_time', 'end_time'] as const) {
        if (spec[k] !== undefined && Math.floor(Date.parse(String(after?.[k] ?? '')) / 1000) !== spec[k]) mismatches.push(k);
      }
      if (creating) {
        if (String(after?.type ?? '').toUpperCase() !== type) mismatches.push('type');
        const got = list(after?.cells).map((c: any) => `${c?.name}:${c?.treatment_percentage}`).sort().join('|');
        const want = (spec.cells as CellSpec[]).map((c) => `${c.name}:${c.treatment_percentage}`).sort().join('|');
        if (got !== want) mismatches.push('cells');
      }
      verification = mismatches.length ? 'MISMATCH' : 'CONFIRMED';
    } catch {
      verification = 'UNCONFIRMED';
    }
    return {
      success: verification === 'CONFIRMED', verification, id,
      message: verification === 'CONFIRMED'
        ? `${what} confirmed by read-back.`
        : verification === 'MISMATCH'
          ? `Meta accepted the ${what}, but the read-back differs in: ${mismatches.join(', ')}. Check study ${id} before doing anything else.`
          : `UNCONFIRMED: Meta accepted the ${what}, but the read-back failed. Do not report this as done; check study ${id} first.`,
    };
  })();
  return rememberTokenOutcome(deps.tokenOutcomes, previewToken, outcome);
}
