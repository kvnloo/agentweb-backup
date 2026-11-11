import axios from 'axios';
import { MetaToolkitRefusal } from './metaToolkitErrors';

/**
 * ENG-2919 slice 1: read-only Meta experiment (ad study) tools. A/B tests and conversion
 * lift studies are both `ad_study` nodes; creates/updates (delivery-changing) are a later
 * slice behind preview+confirm.
 */
export const EXPERIMENT_FIELDS = {
  list: 'id,name,type,start_time,end_time,created_time,updated_time',
  detail: 'id,name,type,description,start_time,end_time,created_time,updated_time,cells{id,name,treatment_percentage,adsets,campaigns},objectives{id,name,type,is_primary}',
};

const names = ['ads_experiment_list_tests', 'ads_experiment_abtest_get_test', 'ads_experiment_lift_get_test'] as const;
const STUDY_TYPE: Record<string, string> = { ads_experiment_abtest_get_test: 'SPLIT_TEST', ads_experiment_lift_get_test: 'LIFT' };

export function isExperimentRead(name: string): boolean { return (names as readonly string[]).includes(name); }

export const EXPERIMENT_READ_DEFINITIONS = names.map((name) => ({
  name,
  description: ({
    ads_experiment_list_tests: 'List experiments (A/B split tests and conversion lift studies) on the selected Meta ad account. Read-only; returns one page and paging cursors.',
    ads_experiment_abtest_get_test: 'Read an A/B split test on the selected Meta ad account, including its cells and objectives. Read-only.',
    ads_experiment_lift_get_test: 'Read a conversion lift study on the selected Meta ad account, including its cells and objectives. Read-only.',
  })[name],
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'Connected Meta ad account; optional when exactly one is connected.' },
      ...(name === 'ads_experiment_list_tests'
        ? { limit: { type: 'integer', minimum: 1, maximum: 100 }, after: { type: 'string' } }
        : { study_id: { type: 'string', pattern: '^[0-9]+$' } }),
    },
    ...(name === 'ads_experiment_list_tests' ? {} : { required: ['study_id'] }),
    additionalProperties: false,
  },
}));

/** Uses server-resolved, account-bound credentials; never caller supplied. */
export async function executeExperimentRead(
  name: string, args: any, credentials: { accountId: string; accessToken: string },
  graph: Pick<typeof axios, 'get'> = axios,
) {
  const def = EXPERIMENT_READ_DEFINITIONS.find((d) => d.name === name);
  if (!def) throw new MetaToolkitRefusal('Unknown experiment read tool.');
  args = Object.fromEntries(Object.entries(args ?? {}).filter(([k, v]) => !(k !== 'study_id' && typeof v === 'string' && v.trim() === '')));
  for (const key of Object.keys(args)) {
    if (!(key in def.inputSchema.properties)) throw new MetaToolkitRefusal(`Unsupported experiment argument: ${key}`);
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new MetaToolkitRefusal('limit must be an integer from 1 to 100.');
  if (args.after !== undefined && typeof args.after !== 'string') throw new MetaToolkitRefusal('after must be a string.');
  const base = `https://graph.facebook.com/${process.env.META_API_VERSION || 'v25.0'}`;
  const account = `act_${credentials.accountId.replace(/^act_/, '')}`;
  const get = async (path: string, params: Record<string, unknown> = {}) => (await graph.get(`${base}/${path}`, { params: { ...params, access_token: credentials.accessToken }, timeout: 15_000 })).data;

  if (name === 'ads_experiment_list_tests') {
    return get(`${account}/ad_studies`, { fields: EXPERIMENT_FIELDS.list, limit: args.limit ?? 100, ...(args.after !== undefined ? { after: args.after } : {}) });
  }
  if (typeof args.study_id !== 'string' || !/^\d+$/.test(args.study_id)) throw new MetaToolkitRefusal('study_id must be a numeric string.');
  // Ad studies are globally addressed: prove membership in the selected account before reading.
  let after: string | undefined;
  const seen = new Set<string>();
  for (let pages = 0; ; pages += 1) {
    if (pages >= 50) throw new MetaToolkitRefusal('That experiment is not in the selected ad account.');
    const owned = await get(`${account}/ad_studies`, { fields: 'id', limit: 100, ...(after ? { after } : {}) });
    if (owned?.data?.some((s: any) => String(s.id) === args.study_id)) break;
    const next = owned?.paging?.next ? owned?.paging?.cursors?.after : undefined;
    if (typeof next !== 'string' || !next || seen.has(next)) throw new MetaToolkitRefusal('That experiment is not in the selected ad account.');
    seen.add(next); after = next;
  }
  const study = await get(args.study_id, { fields: EXPERIMENT_FIELDS.detail });
  const expected = STUDY_TYPE[name];
  if (study?.type && String(study.type).toUpperCase() !== expected) {
    throw new MetaToolkitRefusal(`That experiment is type ${study.type}, not ${expected}; use the matching get tool.`);
  }
  return study;
}
