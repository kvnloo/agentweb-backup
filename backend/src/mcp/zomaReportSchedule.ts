/**
 * ENG-3155 — measurement-report schedules: auto-enrolled when Zoma ships a campaign, then run by an
 * hourly job that emails the hosted zoma_measurement_report.
 *
 * DATA-PLANE: one new table `${prefix}AW-ZomaReportSchedules` (scripts/create-tables.ts), PK `userId`
 * (S) + SK `adAccountId` (S), no GSI. One item per user + Meta ad account. Not in ensureCriticalTables:
 * create it deliberately before turning ZOMA_MEASUREMENT_REPORTS_ENABLED on.
 *
 * Lifecycle:
 *   ship (a confirmed write that sets a campaign ACTIVE) -> enroll: first report 7 days after launch,
 *   then every `cadence`. Enrolling again while active changes nothing (conditional write).
 *   A due schedule whose account had no spend in the last 14 days goes `dormant` (no email); the next
 *   ship resumes it. A user's own pause/stop is never undone by a ship; zoma_report_schedule resumes it.
 *
 * Exactly once per slot: the runner claims a slot by advancing `nextReportAt` with a conditional update
 * on its current value BEFORE sending, so concurrent or repeated passes can never send it twice. A failed
 * send is not retried for that slot (a missed report is cheaper than a duplicate). Opt-out: a signed link
 * (same scheme as the weekly email, its own context) stops every schedule of the user.
 *
 * Industry (for the report's vs. industry CPA line): optional `industry` + `industrySource` ('user' via
 * SET_INDUSTRY, or 'classified' once at enrollment from the ads' destination with the ENG-3156 classifier)
 * + `industryClassifiedAt`. Classification is best-effort and runs after the ship response; a failure stores
 * nothing. A stored industry (user-set or classified) is never overwritten by classification.
 */
import AWS from 'aws-sdk';
import { TABLE_PREFIX } from '../config/constants';
import { getJwtSecret } from '../config/jwt';
import { getBackendUrl } from './oauth/authChallenge';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { measurementReportsEnabled, type MeasurementReport } from './zomaMeasurementReport';
import { isReportRecipient, signUnsubscribeToken, unsubscribeHeaders } from './zomaWeeklyReport';
import { BENCHMARK_INDUSTRIES, type BenchmarkIndustry, isBenchmarkIndustry } from './zomaIndustryBenchmarks';
import type { ZomaUserRecord } from '../services/zomaScoreboard';

export const ZOMA_REPORT_SCHEDULES_TABLE = `${TABLE_PREFIX}AW-ZomaReportSchedules`;
export const ZOMA_REPORT_SCHEDULE_TOOL = 'zoma_report_schedule';
export const isZomaReportScheduleTool = (name: string) => name === ZOMA_REPORT_SCHEDULE_TOOL;
export const MEASUREMENT_UNSUBSCRIBE_CONTEXT = 'zoma-measurement-report-unsubscribe';

const DAY_MS = 24 * 60 * 60 * 1000;
export const FIRST_REPORT_DELAY_DAYS = 7;
export const DORMANT_AFTER_DAYS = 14;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_PER_PASS = 200;

export const REPORT_CADENCES = { weekly: 7, biweekly: 14, monthly: 30 } as const;
export type ReportCadence = keyof typeof REPORT_CADENCES;
/** active: will send. paused/stopped: the user's choice. dormant: no spend for 14+ days, resumed by the next ship. */
export type ReportScheduleStatus = 'active' | 'paused' | 'stopped' | 'dormant';

export interface ZomaReportSchedule {
  userId: string;
  adAccountId: string;
  status: ReportScheduleStatus;
  cadence: ReportCadence;
  /** ISO time the next report is due. */
  nextReportAt: string;
  launchedAt: string;
  createdAt: string;
  updatedAt: string;
  lastSentAt?: string;
  /** The last slot (its due time) claimed by a runner. */
  lastClaimedSlot?: string;
  /** The user's industry for the vs. industry line (ENG-3156 enum). */
  industry?: BenchmarkIndustry;
  industrySource?: IndustrySource;
  /** When the classifier set `industry` (only when industrySource is 'classified'). */
  industryClassifiedAt?: string;
}
export type IndustrySource = 'user' | 'classified';

const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();
export const firstReportAt = (launchedAtIso: string) => addDays(launchedAtIso, FIRST_REPORT_DELAY_DAYS);

/** Next slot after `dueIso`, always in the future of `nowMs` (a long outage does not queue a backlog). */
export function nextSlot(dueIso: string, cadence: ReportCadence, nowMs: number): string {
  let t = Date.parse(dueIso) + REPORT_CADENCES[cadence] * DAY_MS;
  while (t <= nowMs) t += REPORT_CADENCES[cadence] * DAY_MS;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export type EnrollOutcome = 'created' | 'resumed' | 'already_active' | 'kept_user_choice';

export interface ZomaReportScheduleStore {
  get(userId: string, adAccountId: string): Promise<ZomaReportSchedule | null>;
  listForUser(userId: string): Promise<ZomaReportSchedule[]>;
  /** Active schedules due at or before `nowIso`. */
  listDue(nowIso: string): Promise<ZomaReportSchedule[]>;
  /** Conditional create: false when a row already exists. */
  create(record: ZomaReportSchedule): Promise<boolean>;
  /** Conditional: dormant -> active with a new first report. False when it is not dormant. */
  resumeDormant(userId: string, adAccountId: string, launchedAtIso: string, nextReportAt: string, nowIso: string): Promise<boolean>;
  /** Exactly-once slot claim: advances nextReportAt only if it still equals `dueIso` and the row is active. */
  claimSlot(userId: string, adAccountId: string, dueIso: string, nextIso: string, nowIso: string): Promise<boolean>;
  /** Conditional on the row existing. */
  update(userId: string, adAccountId: string, patch: Partial<Pick<ZomaReportSchedule, 'status' | 'cadence' | 'nextReportAt' | 'lastSentAt'>>, nowIso: string): Promise<boolean>;
  /**
   * Conditional on the row existing; with `onlyIfUnset`, also on no industry being stored yet (the classifier
   * never overwrites a user-set or earlier industry). False when a condition fails.
   */
  setIndustry(
    userId: string,
    adAccountId: string,
    value: { industry: BenchmarkIndustry; industrySource: IndustrySource; industryClassifiedAt?: string },
    nowIso: string,
    opts?: { onlyIfUnset?: boolean },
  ): Promise<boolean>;
}

const isConditionFailure = (error: unknown) => (error as { code?: string })?.code === 'ConditionalCheckFailedException';

export class DynamoZomaReportScheduleStore implements ZomaReportScheduleStore {
  constructor(
    private readonly db: Pick<AWS.DynamoDB.DocumentClient, 'put' | 'get' | 'update' | 'query' | 'scan'> = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-2',
    }),
    private readonly table: string = ZOMA_REPORT_SCHEDULES_TABLE,
  ) {}

  async get(userId: string, adAccountId: string) {
    const r = await this.db.get({ TableName: this.table, Key: { userId, adAccountId }, ConsistentRead: true }).promise();
    return (r.Item as ZomaReportSchedule | undefined) ?? null;
  }

  async listForUser(userId: string) {
    const r = await this.db.query({
      TableName: this.table, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': userId }, ConsistentRead: true,
    }).promise();
    return (r.Items as ZomaReportSchedule[] | undefined) ?? [];
  }

  async listDue(nowIso: string) {
    const out: ZomaReportSchedule[] = [];
    let start: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const r = await this.db.scan({
        TableName: this.table,
        FilterExpression: '#status = :active AND nextReportAt <= :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':now': nowIso },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }).promise();
      out.push(...((r.Items as ZomaReportSchedule[] | undefined) ?? []));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async create(record: ZomaReportSchedule) {
    try {
      await this.db.put({ TableName: this.table, Item: record, ConditionExpression: 'attribute_not_exists(userId)' }).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async resumeDormant(userId: string, adAccountId: string, launchedAtIso: string, nextReportAt: string, nowIso: string) {
    return this.conditional({
      TableName: this.table,
      Key: { userId, adAccountId },
      UpdateExpression: 'SET #status = :active, launchedAt = :l, nextReportAt = :n, updatedAt = :now',
      ConditionExpression: '#status = :dormant',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':dormant': 'dormant', ':l': launchedAtIso, ':n': nextReportAt, ':now': nowIso },
    });
  }

  async claimSlot(userId: string, adAccountId: string, dueIso: string, nextIso: string, nowIso: string) {
    return this.conditional({
      TableName: this.table,
      Key: { userId, adAccountId },
      UpdateExpression: 'SET nextReportAt = :next, lastClaimedSlot = :due, updatedAt = :now',
      ConditionExpression: '#status = :active AND nextReportAt = :due',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':due': dueIso, ':next': nextIso, ':now': nowIso },
    });
  }

  async update(userId: string, adAccountId: string, patch: Partial<Pick<ZomaReportSchedule, 'status' | 'cadence' | 'nextReportAt' | 'lastSentAt'>>, nowIso: string) {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ':now': nowIso };
    const sets = entries.map(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      return `#f${i} = :v${i}`;
    });
    return this.conditional({
      TableName: this.table,
      Key: { userId, adAccountId },
      UpdateExpression: `SET ${[...sets, 'updatedAt = :now'].join(', ')}`,
      ConditionExpression: 'attribute_exists(userId)',
      ...(entries.length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
    });
  }

  async setIndustry(
    userId: string,
    adAccountId: string,
    value: { industry: BenchmarkIndustry; industrySource: IndustrySource; industryClassifiedAt?: string },
    nowIso: string,
    opts: { onlyIfUnset?: boolean } = {},
  ) {
    const classifiedAt = value.industryClassifiedAt !== undefined;
    return this.conditional({
      TableName: this.table,
      Key: { userId, adAccountId },
      UpdateExpression: `SET industry = :i, industrySource = :s, ${classifiedAt ? 'industryClassifiedAt = :c, ' : ''}updatedAt = :now`,
      ConditionExpression: opts.onlyIfUnset ? 'attribute_exists(userId) AND attribute_not_exists(industry)' : 'attribute_exists(userId)',
      ExpressionAttributeValues: { ':i': value.industry, ':s': value.industrySource, ':now': nowIso, ...(classifiedAt ? { ':c': value.industryClassifiedAt } : {}) },
    });
  }

  private async conditional(params: AWS.DynamoDB.DocumentClient.UpdateItemInput): Promise<boolean> {
    try {
      await this.db.update(params).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }
}

let defaultStore: ZomaReportScheduleStore | undefined;
/** Lazily built so importing this module never opens a DynamoDB client. */
export function getZomaReportScheduleStore(): ZomaReportScheduleStore {
  return (defaultStore ??= new DynamoZomaReportScheduleStore());
}

// ---------------------------------------------------------------------------------------------
// Enrollment (called by the gateway after a confirmed launch)
// ---------------------------------------------------------------------------------------------

/** What the ship response tells the agent. */
export interface ScheduleNotice {
  status: ReportScheduleStatus;
  cadence: ReportCadence;
  next_report_at: string;
  enrollment: EnrollOutcome;
  how_to_change: string;
  /** The stored industry at enrollment time; null while unknown (a classification may still be running). */
  industry?: BenchmarkIndustry | null;
  industry_source?: IndustrySource | null;
  how_to_set_industry?: string;
}

const HOW_TO_CHANGE = 'Change the cadence (weekly, biweekly, monthly), pause, resume or stop it with zoma_report_schedule.';
/** How the agent sets or corrects the industry the report compares CPA against. */
export const HOW_TO_SET_INDUSTRY = 'Set or correct the industry with zoma_report_schedule (action SET_INDUSTRY, industry).';

/** Classifies an ad account's industry (ENG-3156 classifier); null when it cannot. May throw. */
export type ClassifyIndustry = (userId: string, adAccountId: string) => Promise<BenchmarkIndustry | null>;

export async function enrollReportSchedule(
  userId: string,
  adAccountId: string,
  opts: {
    store?: ZomaReportScheduleStore;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    /** When given and no industry is stored, classify once after enrollment (never awaited by the ship). */
    classifyIndustry?: ClassifyIndustry;
    /** Receives the background classification; default: let it run (errors are already caught). */
    background?: (work: Promise<void>) => void;
  } = {},
): Promise<ScheduleNotice | null> {
  if (!measurementReportsEnabled(opts.env)) return null;
  const store = opts.store ?? getZomaReportScheduleStore();
  const now = opts.now ?? Date.now;
  const nowIso = new Date(now()).toISOString();
  const first = firstReportAt(nowIso);
  const notice = (s: Pick<ZomaReportSchedule, 'status' | 'cadence' | 'nextReportAt'>, enrollment: EnrollOutcome, existing?: ZomaReportSchedule | null): ScheduleNotice => {
    const industry = existing?.industry && isBenchmarkIndustry(existing.industry) ? existing.industry : null;
    if (!industry && opts.classifyIndustry) {
      const work = classifyAndStoreIndustry(userId, adAccountId, opts.classifyIndustry, store, now);
      (opts.background ?? ((w) => void w))(work);
    }
    return {
      status: s.status, cadence: s.cadence, next_report_at: s.nextReportAt, enrollment, how_to_change: HOW_TO_CHANGE,
      industry, industry_source: industry ? existing?.industrySource ?? null : null, how_to_set_industry: HOW_TO_SET_INDUSTRY,
    };
  };

  const record: ZomaReportSchedule = {
    userId, adAccountId, status: 'active', cadence: 'weekly', nextReportAt: first, launchedAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
  };
  if (await store.create(record)) return notice(record, 'created', record);
  if (await store.resumeDormant(userId, adAccountId, nowIso, first, nowIso)) {
    const existing = await store.get(userId, adAccountId);
    return notice({ status: 'active', cadence: existing?.cadence ?? 'weekly', nextReportAt: first }, 'resumed', existing);
  }
  const existing = await store.get(userId, adAccountId);
  if (!existing) return null;
  return notice(existing, existing.status === 'active' ? 'already_active' : 'kept_user_choice', existing);
}

/**
 * One best-effort classification. Stores the industry only when one was found AND none is stored yet
 * (conditional write, so a user's SET_INDUSTRY that lands meanwhile wins). Never throws.
 */
export async function classifyAndStoreIndustry(
  userId: string,
  adAccountId: string,
  classify: ClassifyIndustry,
  store: ZomaReportScheduleStore = getZomaReportScheduleStore(),
  now: () => number = Date.now,
): Promise<void> {
  try {
    const industry = await classify(userId, adAccountId);
    if (!industry || !isBenchmarkIndustry(industry)) return;
    const nowIso = new Date(now()).toISOString();
    await store.setIndustry(userId, adAccountId, { industry, industrySource: 'classified', industryClassifiedAt: nowIso }, nowIso, { onlyIfUnset: true });
  } catch (error) {
    console.warn('[zoma-measurement-report] industry classification failed; nothing stored:', error instanceof Error ? error.message : error);
  }
}

/** Production classifier: the ENG-3156 ad-destination classifier on the account's usable Meta connection. */
export const defaultClassifyIndustry: ClassifyIndustry = async (userId, adAccountId) => {
  const { classifyFromAdDestinations } = await import('./zomaIndustryBenchmark');
  return (await classifyFromAdDestinations(await usableMetaAccount(userId, adAccountId), adAccountId, userId)).industry;
};

/** The stored, still-valid industry for an ad account, or null (also on any read failure). */
export async function storedIndustry(userId: string, adAccountId: string, store: ZomaReportScheduleStore = getZomaReportScheduleStore()): Promise<BenchmarkIndustry | null> {
  try {
    const s = await store.get(userId, adAccountId);
    return s?.industry && isBenchmarkIndustry(s.industry) ? s.industry : null;
  } catch (error) {
    console.warn('[zoma-measurement-report] stored industry not read:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** One sentence for the ship response. */
export function scheduleNoticeText(n: ScheduleNotice): string {
  const when = n.next_report_at.slice(0, 10);
  if (n.enrollment === 'kept_user_choice') {
    return `The measurement report for this ad account is ${n.status} by the user's choice, so no report was scheduled. ${HOW_TO_CHANGE}`;
  }
  const verb = n.enrollment === 'created' ? 'A measurement report schedule was set up' : n.enrollment === 'resumed' ? 'The measurement report schedule was resumed' : 'The measurement report schedule is already on';
  const industry = n.industry
    ? ` It compares CPA with the ${n.industry} industry benchmark (${n.industry_source === 'user' ? 'set by the user' : "classified from the ads' destination"}); if that is wrong, ask the user. ${HOW_TO_SET_INDUSTRY}`
    : ` The user's industry is not known yet, so the report's industry benchmark line may read N/A (Zoma tries to classify it from the ads' destination). Ask the user for it. ${HOW_TO_SET_INDUSTRY}`;
  return `${verb}: Zoma emails the user a full report (campaign metrics, CRM leads, breakdowns) ${n.cadence}, first on ${when} (about a week after launch, once delivery has settled). ${HOW_TO_CHANGE}${industry}`;
}

// ---------------------------------------------------------------------------------------------
// The zoma_report_schedule tool
// ---------------------------------------------------------------------------------------------

const SCHEDULE_ACTIONS = ['GET', 'UPDATE', 'PAUSE', 'RESUME', 'STOP', 'SET_INDUSTRY'] as const;
export const isReportScheduleWrite = (args: any) => String(args?.action ?? 'GET').toUpperCase() !== 'GET';

export const ZOMA_REPORT_SCHEDULE_DEFINITION = {
  name: ZOMA_REPORT_SCHEDULE_TOOL,
  description:
    'The proactive measurement-report email Zoma sets up when a campaign goes live. GET shows each ad account\'s schedule (cadence, next report, status). ' +
    'UPDATE sets cadence (weekly, biweekly, monthly). PAUSE and STOP turn it off (STOP also covers future launches until RESUME); RESUME turns it back on. ' +
    'SET_INDUSTRY sets the user\'s industry, which the report compares CPA against (otherwise it is classified from the ads\' destination, or the line is N/A). ' +
    'Without account_id, a change applies to every schedule the user has. Changes only Zoma\'s own email, never the ads.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...SCHEDULE_ACTIONS], description: 'Default GET.' },
      cadence: { type: 'string', enum: Object.keys(REPORT_CADENCES), description: 'UPDATE only.' },
      industry: { type: 'string', enum: [...BENCHMARK_INDUSTRIES], description: 'SET_INDUSTRY only. The user\'s industry.' },
      account_id: { type: 'string', description: 'Meta ad account id; omit to act on all of the user\'s schedules.' },
    },
    additionalProperties: false,
  },
};

const describe = (s: ZomaReportSchedule) => ({
  account_id: s.adAccountId, status: s.status, cadence: s.cadence,
  ...(s.status === 'active' ? { next_report_at: s.nextReportAt } : {}),
  ...(s.lastSentAt ? { last_sent_at: s.lastSentAt } : {}),
  industry: s.industry ?? null,
  ...(s.industry ? { industry_source: s.industrySource ?? null } : {}),
});

export async function runZomaReportScheduleTool(
  userId: string,
  args: any,
  opts: { store?: ZomaReportScheduleStore; now?: () => number; env?: NodeJS.ProcessEnv } = {},
) {
  if (!measurementReportsEnabled(opts.env)) throw new MetaToolkitRefusal('Measurement report schedules are not available yet.');
  const store = opts.store ?? getZomaReportScheduleStore();
  const nowMs = (opts.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const action = String(args?.action ?? 'GET').toUpperCase();
  if (!(SCHEDULE_ACTIONS as readonly string[]).includes(action)) throw new MetaToolkitRefusal(`action must be one of: ${SCHEDULE_ACTIONS.join(', ')}.`);
  const accountId = args?.account_id === undefined ? undefined : String(args.account_id).replace(/^act_/, '');
  const all = await store.listForUser(userId);
  const targets = accountId ? all.filter((s) => s.adAccountId === accountId) : all;
  if (accountId && !targets.length) throw new MetaToolkitRefusal(`No measurement report schedule exists for ad account ${accountId}. One is set up when a campaign goes live through Zoma.`);
  if (action === 'GET') {
    return {
      schedules: targets.map(describe),
      summary: targets.length
        ? targets.map((s) => `act_${s.adAccountId}: ${s.status}, ${s.cadence}${s.status === 'active' ? `, next report ${s.nextReportAt.slice(0, 10)}` : ''}, industry ${s.industry ?? `unknown (${HOW_TO_SET_INDUSTRY})`}`).join('\n')
        : 'No measurement report schedule yet. One is set up automatically when a campaign goes live through Zoma.',
    };
  }
  if (!targets.length) throw new MetaToolkitRefusal('No measurement report schedule exists yet. One is set up when a campaign goes live through Zoma.');
  if (action === 'SET_INDUSTRY') {
    const industry = args?.industry;
    if (!isBenchmarkIndustry(industry)) throw new MetaToolkitRefusal(`industry must be one of: ${BENCHMARK_INDUSTRIES.join(', ')}.`);
    const updated: ZomaReportSchedule[] = [];
    for (const s of targets) {
      if (await store.setIndustry(s.userId, s.adAccountId, { industry, industrySource: 'user' }, nowIso)) updated.push({ ...s, industry, industrySource: 'user' });
    }
    return {
      action,
      schedules: updated.map(describe),
      summary: `Industry set to ${industry} for ${updated.length} ad account${updated.length === 1 ? '' : 's'}; the next measurement report compares CPA with that industry's benchmark.`,
    };
  }
  let patchFor: (s: ZomaReportSchedule) => Partial<ZomaReportSchedule>;
  if (action === 'UPDATE') {
    const cadence = String(args?.cadence ?? '');
    if (!(cadence in REPORT_CADENCES)) throw new MetaToolkitRefusal(`cadence must be one of: ${Object.keys(REPORT_CADENCES).join(', ')}.`);
    // The pending slot keeps its date unless the new cadence brings the next report sooner.
    patchFor = (s) => {
      const sooner = new Date(nowMs + REPORT_CADENCES[cadence as ReportCadence] * DAY_MS).toISOString();
      return { cadence: cadence as ReportCadence, ...(s.status === 'active' && sooner < s.nextReportAt ? { nextReportAt: sooner } : {}) };
    };
  } else if (action === 'PAUSE') patchFor = () => ({ status: 'paused' });
  else if (action === 'STOP') patchFor = () => ({ status: 'stopped' });
  else patchFor = (s) => ({ status: 'active', ...(Date.parse(s.nextReportAt) <= nowMs || s.status !== 'active' ? { nextReportAt: new Date(nowMs + REPORT_CADENCES[s.cadence] * DAY_MS).toISOString() } : {}) });
  const updated: ZomaReportSchedule[] = [];
  for (const s of targets) {
    const patch = patchFor(s);
    if (await store.update(s.userId, s.adAccountId, patch, nowIso)) updated.push({ ...s, ...patch });
  }
  return {
    action,
    schedules: updated.map(describe),
    summary: `${action === 'UPDATE' ? 'Cadence updated' : action === 'PAUSE' ? 'Paused' : action === 'STOP' ? 'Stopped' : 'Resumed'} for ${updated.length} ad account${updated.length === 1 ? '' : 's'}.`,
  };
}

// ---------------------------------------------------------------------------------------------
// The runner (all I/O injectable)
// ---------------------------------------------------------------------------------------------

export interface MeasurementRunnerDeps {
  enabled: () => boolean;
  maxPerPass: () => number;
  store: () => ZomaReportScheduleStore;
  /** Fresh user read right before the send; undefined when the account cannot be resolved. */
  getUser: (userId: string) => Promise<(Pick<ZomaUserRecord, 'email' | 'isAdmin' | 'zomaAdsExperience'> & { userId: string }) | undefined>;
  /** Account spend over the last `days` complete days; throws when the account cannot be read. */
  recentSpend: (userId: string, adAccountId: string, days: number) => Promise<number>;
  /** `industry` is the schedule's stored industry, when there is one. */
  buildReport: (userId: string, adAccountId: string, industry?: BenchmarkIndustry) => Promise<MeasurementReport>;
  sendEmail: (to: string, subject: string, text: string, html: string, headers?: Record<string, string>) => Promise<'sent' | 'suppressed' | 'failed' | void>;
  backendUrl: () => string;
  secret: () => string;
  now: () => number;
}

export interface MeasurementRunResult {
  due: number;
  sent: number;
  failed: number;
  dormant: number;
}

export function measurementUnsubscribeUrl(userId: string, deps: Pick<MeasurementRunnerDeps, 'backendUrl' | 'secret'>): string {
  return `${deps.backendUrl().replace(/\/+$/, '')}/api/zoma/measurement-report/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(userId, deps.secret(), MEASUREMENT_UNSUBSCRIBE_CONTEXT))}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function measurementReportEmail(report: MeasurementReport, unsubscribeUrl: string): { subject: string; text: string; html: string } {
  const subject = `Your Zoma measurement report (${report.date_range.since} to ${report.date_range.until})`;
  const link = report.report_url ?? '';
  const lines = [
    report.summary,
    '',
    `Full report: ${link}`,
    '',
    'Change how often this comes, or stop it, by asking your agent to use zoma_report_schedule.',
    `Stop these measurement report emails: ${unsubscribeUrl}`,
  ];
  const html = [
    `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#202124">`,
    `<h2 style="margin:0 0 6px">Your Zoma measurement report</h2>`,
    ...report.summary.split('\n').map((l) => `<p style="margin:6px 0">${escapeHtml(l)}</p>`),
    `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the full report</a></p>`,
    `<p style="color:#5f6368;font-size:13px">Change how often this comes, or stop it, by asking your agent to use zoma_report_schedule.</p>`,
    `<p style="color:#80868b;font-size:12px"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#80868b">Stop these measurement report emails</a></p>`,
    `</div>`,
  ].join('');
  return { subject, text: lines.join('\n'), html };
}

export async function runZomaMeasurementReports(deps: MeasurementRunnerDeps = defaultMeasurementRunnerDeps): Promise<MeasurementRunResult> {
  const result: MeasurementRunResult = { due: 0, sent: 0, failed: 0, dormant: 0 };
  if (!deps.enabled()) return result;
  const store = deps.store();
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const due = (await store.listDue(nowIso)).sort((a, b) => (a.nextReportAt < b.nextReportAt ? -1 : 1));
  result.due = due.length;
  let claimed = 0;
  let failedInARow = 0;
  for (const s of due) {
    if (claimed >= deps.maxPerPass()) {
      console.warn(`[zoma-measurement-report] cap of ${deps.maxPerPass()} reached; the rest wait for the next pass`);
      break;
    }
    try {
      if (s.userId.startsWith('deleted_')) continue;
      const user = await deps.getUser(s.userId);
      if (!user || !isReportRecipient(user)) continue;
      // No spend for 14+ days: go dormant without emailing; the next ship resumes it.
      if ((await deps.recentSpend(s.userId, s.adAccountId, DORMANT_AFTER_DAYS)) <= 0) {
        if (await store.update(s.userId, s.adAccountId, { status: 'dormant' }, nowIso)) result.dormant += 1;
        continue;
      }
      // Build (and host) everything BEFORE the claim: a failure here must not burn the slot.
      const report = await deps.buildReport(s.userId, s.adAccountId, s.industry && isBenchmarkIndustry(s.industry) ? s.industry : undefined);
      const unsubscribeUrl = measurementUnsubscribeUrl(s.userId, deps);
      const email = measurementReportEmail(report, unsubscribeUrl);
      // Claim BEFORE sending: a concurrent or repeated pass loses the conditional write and sends nothing.
      if (!(await store.claimSlot(s.userId, s.adAccountId, s.nextReportAt, nextSlot(s.nextReportAt, s.cadence, nowMs), nowIso))) continue;
      claimed += 1;
      const outcome = await deps.sendEmail(user.email!, email.subject, email.text, email.html, unsubscribeHeaders(unsubscribeUrl));
      if (outcome === 'failed') {
        result.failed += 1;
        failedInARow += 1;
        console.error(`[zoma-measurement-report] not delivered for ${s.userId}/${s.adAccountId} (slot ${s.nextReportAt}); not retried for this slot`);
        if (failedInARow >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[zoma-measurement-report] ${failedInARow} sends in a row failed: stopping this pass`);
          break;
        }
        continue;
      }
      failedInARow = 0;
      if (outcome === 'sent') result.sent += 1;
      await store.update(s.userId, s.adAccountId, { lastSentAt: nowIso }, nowIso).catch((e) => console.error('[zoma-measurement-report] lastSentAt not recorded:', e instanceof Error ? e.message : e));
    } catch (error) {
      console.error(`[zoma-measurement-report] failed for ${s.userId}/${s.adAccountId}:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}

/** Stop every schedule of the user (the signed unsubscribe link). False when the user has none. */
export async function stopAllReportSchedules(userId: string, store: ZomaReportScheduleStore = getZomaReportScheduleStore(), now: () => number = Date.now): Promise<boolean> {
  const all = await store.listForUser(userId);
  const nowIso = new Date(now()).toISOString();
  for (const s of all) await store.update(userId, s.adAccountId, { status: 'stopped' }, nowIso);
  return all.length > 0;
}

/** For the weekly email: users with an active measurement schedule get that report instead (no double email). */
export async function hasActiveReportSchedule(userId: string, store: ZomaReportScheduleStore = getZomaReportScheduleStore(), env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!measurementReportsEnabled(env)) return false;
  return (await store.listForUser(userId)).some((s) => s.status === 'active');
}

// ---------------------------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------------------------

async function usableMetaAccount(userId: string, adAccountId: string) {
  const [{ getAccountsByUserIdIncludingOrgShared }, { META_PROVIDER }] = await Promise.all([import('../services/connectedAccountsDb'), import('./zomaProviders')]);
  const now = Date.now();
  const account = (await getAccountsByUserIdIncludingOrgShared(userId)).find(
    (a) => META_PROVIDER.isAdAccount(a) && META_PROVIDER.isUsable(a, now) && META_PROVIDER.accountIds(a).includes(adAccountId),
  );
  if (!account) throw new Error('no usable Meta connection for this ad account');
  return account;
}

export const defaultMeasurementRunnerDeps: MeasurementRunnerDeps = {
  enabled: () => measurementReportsEnabled(),
  maxPerPass: () => {
    const n = Number(process.env.ZOMA_MEASUREMENT_REPORTS_MAX_PER_PASS);
    return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_MAX_PER_PASS;
  },
  store: getZomaReportScheduleStore,
  async getUser(userId) {
    const { userDb } = await import('../services/db');
    const user = await userDb.getUserByIdConsistent(userId);
    return user?.email ? { userId, email: user.email, isAdmin: user.isAdmin, zomaAdsExperience: (user as any).zomaAdsExperience } : undefined;
  },
  async recentSpend(userId, adAccountId, days) {
    const { runZomaAdsReport } = await import('./zomaAdsReport');
    const account = await usableMetaAccount(userId, adAccountId);
    const until = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - DAY_MS;
    const since = until - (days - 1) * DAY_MS;
    const r = await runZomaAdsReport(account, adAccountId, { level: 'account', since: new Date(since).toISOString().slice(0, 10), until: new Date(until).toISOString().slice(0, 10) });
    return r.totals.spend;
  },
  async buildReport(userId, adAccountId, industry) {
    const { runZomaMeasurementReport } = await import('./zomaMeasurementReport');
    return runZomaMeasurementReport(userId, await usableMetaAccount(userId, adAccountId), adAccountId, { date_preset: 'last_30d', ...(industry ? { industry } : {}) });
  },
  async sendEmail(to, subject, text, html, headers) {
    const { emailService } = await import('../services/emailService');
    return emailService.sendEmail(to, subject, text, html, undefined, headers);
  },
  backendUrl: getBackendUrl,
  secret: () => getJwtSecret(),
  now: () => Date.now(),
};
