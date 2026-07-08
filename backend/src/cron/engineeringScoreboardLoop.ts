import { getSecret } from '../utils/secretsManager';
import { getEngineeringBugStats, type EngineeringBugStats } from '../services/linearService';
import { productionLoopPorts } from '../loops/adapters/awsAdapters';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import type { DynamoPort } from '../loops/core/ports';

const WEAVE_API_BASE = 'https://app.workweave.ai/api/v1';
const SCOREBOARD_LOOP_ID = 'engineering-scoreboard-weekly';

export type WeaveMetricName =
  | 'bug_ratio'
  | 'code_turnover'
  | 'prs'
  | 'points'
  | 'pr_cycle_time'
  | 'pr_merge_time'
  | 'ai_code_percentage'
  | 'ai_code_loc'
  | 'code_output'
  | 'code_reviews'
  | 'active_developers'
  | 'innovation_ratio';

export type ScoreboardErrorType =
  | 'config'
  | 'linear'
  | 'weave'
  | 'weave_auth'
  | 'unknown_metric'
  | 'snapshot'
  | 'slack_delivery';

export class WeaveApiError extends Error {
  constructor(
    public readonly type: Extract<ScoreboardErrorType, 'weave' | 'weave_auth' | 'unknown_metric'>,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'WeaveApiError';
  }
}

class ScoreboardRunError extends Error {
  constructor(public readonly type: ScoreboardErrorType, message: string) {
    super(message);
    this.name = 'ScoreboardRunError';
  }
}

export interface WeaveAccount {
  id: string;
  name: string;
  email?: string;
}

export interface WeaveMetricPoint {
  date: string;
  value: number;
  group?: string;
}

export interface WeaveMetricOptions {
  start: string;
  end: string;
  groupBy?: 'account';
  granularity?: 'day' | 'week';
}

export interface WeaveClientLike {
  getAccounts(): Promise<WeaveAccount[]>;
  getMetricSeries(metric: WeaveMetricName, options: WeaveMetricOptions): Promise<WeaveMetricPoint[]>;
}

export interface EngineerConfig {
  name: string;
  email: string;
  prFloor: number;
}

export interface EngineerScoreboardRow {
  name: string;
  prs: number;
  prFloor: number;
  bugRatio: number | null;
  codeTurnover: number | null;
}

export interface OrgTrend {
  bugRatioPrevious: number | null;
  bugRatioCurrent: number | null;
  prsPrevious: number | null;
  prsCurrent: number | null;
}

export interface EngineeringScoreboardSnapshot {
  snapshotDate: string;
  netOpenBugs: number;
  opened7d: number;
  closed7d: number;
  bugRatioLastWeek: number | null;
  prsLastWeek: number | null;
  createdAt: string;
}

export interface SnapshotStore {
  listRecentSnapshots(limit: number): Promise<EngineeringScoreboardSnapshot[]>;
  appendSnapshot(snapshot: EngineeringScoreboardSnapshot): Promise<void>;
}

export interface SlackDelivery {
  channel: string;
  ts?: string;
  link?: string;
}

export interface EngineeringScoreboardDeps {
  env: Record<string, string | undefined>;
  now: () => Date;
  linear: {
    getBugStats(start: string, end: string): Promise<EngineeringBugStats>;
  };
  weave: WeaveClientLike;
  snapshots: SnapshotStore;
  slack: {
    postMessage(channelOrUserId: string, markdown: string): Promise<SlackDelivery>;
  };
  logger: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
  };
}

export type EngineeringScoreboardRunResult =
  | { status: 'disabled' }
  | { status: 'ok'; slack: SlackDelivery; snapshot: EngineeringScoreboardSnapshot }
  | { status: 'failed'; error: { type: ScoreboardErrorType; message: string } };

export interface EngineeringScoreboardMessageInput {
  reportDate: string;
  bugStats: EngineeringBugStats;
  orgTrend: OrgTrend;
  engineerRows: EngineerScoreboardRow[];
  priorSnapshots: EngineeringScoreboardSnapshot[];
}

type FetchLike = typeof fetch;

export class WeaveClient implements WeaveClientLike {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = WEAVE_API_BASE,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async getAccounts(): Promise<WeaveAccount[]> {
    const data = await this.getJson('/accounts');
    const rows: Array<Record<string, unknown>> = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [];
    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id ?? row.account_id ?? row.accountId ?? ''),
      name: String(row.name ?? row.display_name ?? row.email ?? ''),
      email: row.email ? String(row.email) : undefined,
    })).filter((account) => account.id && account.name);
  }

  async getMetricSeries(metric: WeaveMetricName, options: WeaveMetricOptions): Promise<WeaveMetricPoint[]> {
    const params = new URLSearchParams({
      metric,
      start: options.start,
      end: options.end,
    });
    if (options.groupBy) params.set('group_by', options.groupBy);
    if (options.granularity) params.set('granularity', options.granularity);

    const data = await this.getJson(`/metrics?${params.toString()}`);
    const rows: Array<Record<string, unknown>> = Array.isArray(data) ? data : Array.isArray(data?.metrics) ? data.metrics : [];
    return rows.map((row: Record<string, unknown>) => ({
      date: String(row.date ?? ''),
      group: optionalString(row.group ?? row.account ?? row.account_id ?? row.accountId),
      value: Number(row[metric]),
    })).filter((point) => point.date && Number.isFinite(point.value));
  }

  private async getJson(path: string): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { 'X-API-Key': this.apiKey },
    });
    const body = await response.text();
    const parsed = parseJson(body);
    if (!response.ok) {
      const message = extractApiMessage(parsed) ?? body ?? `Weave API ${response.status}`;
      if (/unknown metric type/i.test(message)) {
        throw new WeaveApiError('unknown_metric', message, response.status);
      }
      if (response.status === 401 || response.status === 403) {
        throw new WeaveApiError('weave_auth', message, response.status);
      }
      throw new WeaveApiError('weave', message, response.status);
    }
    return parsed;
  }
}

export async function runEngineeringScoreboardLoopOnce(
  deps?: EngineeringScoreboardDeps,
): Promise<EngineeringScoreboardRunResult> {
  deps = deps ?? await createProductionEngineeringScoreboardDeps();
  if (deps.env.ENGINEERING_SCOREBOARD_LOOP_ENABLED !== 'true') {
    deps.logger.info('[engineering-scoreboard] disabled');
    return { status: 'disabled' };
  }

  try {
    const engineers = parseEngineerConfig(deps.env.ENGINEERING_SCOREBOARD_ENGINEERS);
    const recipient = deps.env.ENGINEERING_SCOREBOARD_SLACK_USER_ID || deps.env.LOOP_APPROVAL_SLACK_USER_ID;
    if (!recipient) throw new ScoreboardRunError('config', 'ENGINEERING_SCOREBOARD_SLACK_USER_ID is required');

    const now = deps.now();
    const end = ymd(now);
    const start = ymd(addDays(now, -7));
    const previousStart = ymd(addDays(now, -14));

    const bugStats = await deps.linear.getBugStats(start, end).catch((err: unknown) => {
      throw new ScoreboardRunError('linear', errorMessage(err));
    });

    const priorSnapshots = await deps.snapshots.listRecentSnapshots(8).catch((err: unknown) => {
      throw new ScoreboardRunError('snapshot', errorMessage(err));
    });

    const { orgTrend, engineerRows } = await fetchWeaveScoreboard(deps.weave, engineers, {
      start,
      end,
      previousStart,
    }).catch((err: unknown) => {
      if (err instanceof WeaveApiError) throw new ScoreboardRunError(err.type, err.message);
      throw new ScoreboardRunError('weave', errorMessage(err));
    });

    const message = buildEngineeringScoreboardMessage({
      reportDate: end,
      bugStats,
      orgTrend,
      engineerRows,
      priorSnapshots,
    });

    const slack = await deps.slack.postMessage(recipient, message).catch((err: unknown) => {
      throw new ScoreboardRunError('slack_delivery', errorMessage(err));
    });
    if (!slack.ts && !slack.link) {
      throw new ScoreboardRunError('slack_delivery', 'Slack post did not return a message ts or link');
    }

    const snapshot: EngineeringScoreboardSnapshot = {
      snapshotDate: end,
      netOpenBugs: bugStats.netOpenBugs,
      opened7d: bugStats.opened7d,
      closed7d: bugStats.closed7d,
      bugRatioLastWeek: orgTrend.bugRatioCurrent,
      prsLastWeek: orgTrend.prsCurrent,
      createdAt: now.toISOString(),
    };
    await deps.snapshots.appendSnapshot(snapshot).catch((err: unknown) => {
      throw new ScoreboardRunError('snapshot', errorMessage(err));
    });

    deps.logger.info('[engineering-scoreboard] posted', { channel: slack.channel, ts: slack.ts, link: slack.link });
    return { status: 'ok', slack, snapshot };
  } catch (err) {
    const type = err instanceof ScoreboardRunError ? err.type : 'config';
    const message = errorMessage(err);
    deps.logger.error('[engineering-scoreboard] failed', { type, message });
    return { status: 'failed', error: { type, message } };
  }
}

export function buildEngineeringScoreboardMessage(input: EngineeringScoreboardMessageInput): string {
  const bugDelta = burnDownDelta(input.bugStats.netOpenBugs, input.priorSnapshots);
  const verdict = verdictFor(input, bugDelta);
  const lines = [
    `*Engineering Scoreboard - ${input.reportDate}*`,
    `TL;DR: ${verdict} bugs ${trendPhrase(bugDelta)} | bug_ratio ${formatMetric(input.orgTrend.bugRatioCurrent)} | prs ${formatMetric(input.orgTrend.prsCurrent)}`,
    '',
    `Bugs: ${input.bugStats.netOpenBugs} open bugs (+${input.bugStats.opened7d}/-${input.bugStats.closed7d} last 7d). Trend: ${trendPhrase(bugDelta)}.`,
    `Weave: bug_ratio ${formatMetric(input.orgTrend.bugRatioCurrent)} (${deltaPhrase(input.orgTrend.bugRatioCurrent, input.orgTrend.bugRatioPrevious, true)}) | prs ${formatMetric(input.orgTrend.prsCurrent)} (${deltaPhrase(input.orgTrend.prsCurrent, input.orgTrend.prsPrevious, false)}).`,
    '',
    'Engineer | PRs | floor | bug_ratio | code_turnover',
    '--- | ---: | ---: | ---: | ---:',
  ];

  if (input.engineerRows.length === 0) {
    lines.push('_No configured engineers matched Weave accounts._');
  } else {
    for (const row of input.engineerRows) {
      lines.push(
        `${row.name} | ${row.prs} | ${row.prFloor} | ${formatMetric(row.bugRatio)} | ${formatMetric(row.codeTurnover)}`,
      );
    }
  }

  lines.push('');
  lines.push('_Read-only: Linear was not modified. Weave REST metrics only; unsupported MCP-only metrics are omitted._');
  return lines.join('\n');
}

async function fetchWeaveScoreboard(
  weave: WeaveClientLike,
  engineers: EngineerConfig[],
  window: { previousStart: string; start: string; end: string },
): Promise<{ orgTrend: OrgTrend; engineerRows: EngineerScoreboardRow[] }> {
  const [accounts, orgBugRatio, orgPrs, accountBugRatio, accountPrs, accountTurnover] = await Promise.all([
    weave.getAccounts(),
    weave.getMetricSeries('bug_ratio', { start: window.previousStart, end: window.end, granularity: 'week' }),
    weave.getMetricSeries('prs', { start: window.previousStart, end: window.end, granularity: 'week' }),
    weave.getMetricSeries('bug_ratio', { start: window.start, end: window.end, groupBy: 'account', granularity: 'week' }),
    weave.getMetricSeries('prs', { start: window.start, end: window.end, groupBy: 'account', granularity: 'week' }),
    weave.getMetricSeries('code_turnover', { start: window.start, end: window.end, groupBy: 'account', granularity: 'week' }),
  ]);

  const orgTrend: OrgTrend = {
    bugRatioPrevious: valueAt(orgBugRatio.filter((p) => !p.group), 0),
    bugRatioCurrent: latestValue(orgBugRatio.filter((p) => !p.group)),
    prsPrevious: valueAt(orgPrs.filter((p) => !p.group), 0),
    prsCurrent: latestValue(orgPrs.filter((p) => !p.group)),
  };

  const engineerRows = engineers.map((engineer) => {
    const account = findAccount(accounts, engineer);
    const groupKeys = account ? [account.id, account.email, account.name].filter((x): x is string => Boolean(x)) : [];
    return {
      name: engineer.name,
      prs: Math.round(latestForAnyGroup(accountPrs, groupKeys) ?? 0),
      prFloor: engineer.prFloor,
      bugRatio: latestForAnyGroup(accountBugRatio, groupKeys) ?? orgTrend.bugRatioCurrent,
      codeTurnover: latestForAnyGroup(accountTurnover, groupKeys),
    };
  });

  return { orgTrend, engineerRows };
}

async function createProductionEngineeringScoreboardDeps(): Promise<EngineeringScoreboardDeps> {
  const ports = productionLoopPorts();
  const apiKey = await getWeaveApiKey(process.env);
  return {
    env: process.env,
    now: () => new Date(),
    linear: { getBugStats: getEngineeringBugStats },
    weave: new WeaveClient(apiKey),
    snapshots: new DynamoScoreboardSnapshotStore(ports.dynamo),
    slack: {
      postMessage: (channelOrUserId, markdown) => ports.slack.postMessage(channelOrUserId, markdown),
    },
    logger: {
      info: (message, context) => ports.logger.log('info', message, context),
      warn: (message, context) => ports.logger.log('warn', message, context),
      error: (message, context) => ports.logger.log('error', message, context),
    },
  };
}

class DynamoScoreboardSnapshotStore implements SnapshotStore {
  constructor(private readonly dynamo: DynamoPort) {}

  async listRecentSnapshots(limit: number): Promise<EngineeringScoreboardSnapshot[]> {
    const result = await this.dynamo.query({
      tableName: LOOP_EVENTS_TABLE,
      keyConditionExpression: 'loopId = :loopId',
      expressionAttributeValues: { ':loopId': SCOREBOARD_LOOP_ID },
      limit,
    });
    return result.items
      .map((item) => snapshotFromItem(item))
      .filter((snapshot): snapshot is EngineeringScoreboardSnapshot => Boolean(snapshot?.createdAt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async appendSnapshot(snapshot: EngineeringScoreboardSnapshot): Promise<void> {
    await this.dynamo.putItem(LOOP_EVENTS_TABLE, {
      loopId: SCOREBOARD_LOOP_ID,
      tsSession: snapshot.createdAt,
      eventType: 'scoreboard_snapshot',
      subjectId: 'engineering',
      ts: snapshot.createdAt,
      snapshotDate: snapshot.snapshotDate,
      netOpenBugs: snapshot.netOpenBugs,
      opened7d: snapshot.opened7d,
      closed7d: snapshot.closed7d,
      bugRatioLastWeek: snapshot.bugRatioLastWeek,
      prsLastWeek: snapshot.prsLastWeek,
      createdAt: snapshot.createdAt,
    });
  }
}

function snapshotFromItem(item: Record<string, unknown>): EngineeringScoreboardSnapshot | null {
  if (typeof item.createdAt !== 'string' || typeof item.snapshotDate !== 'string') return null;
  return {
    snapshotDate: item.snapshotDate,
    netOpenBugs: Number(item.netOpenBugs ?? 0),
    opened7d: Number(item.opened7d ?? 0),
    closed7d: Number(item.closed7d ?? 0),
    bugRatioLastWeek: nullableNumber(item.bugRatioLastWeek),
    prsLastWeek: nullableNumber(item.prsLastWeek),
    createdAt: item.createdAt,
  };
}

async function getWeaveApiKey(env: Record<string, string | undefined>): Promise<string> {
  if (env.WEAVE_API_KEY?.trim()) return env.WEAVE_API_KEY.trim();
  const secretName = env.WEAVE_SECRET_NAME || (env.NODE_ENV === 'production' ? 'prod/AgentWeb/Weave' : 'prod/AgentWeb/Weave');
  const secret = await getSecret(secretName);
  const parsed = parseJson(secret);
  const key = typeof parsed === 'object' && parsed !== null
    ? String(parsed.WEAVE_API_KEY ?? parsed.apiKey ?? parsed.api_key ?? '')
    : secret;
  if (!key.trim()) throw new ScoreboardRunError('config', `Weave API key missing in ${secretName}`);
  return key.trim();
}

function parseEngineerConfig(raw: string | undefined): EngineerConfig[] {
  if (!raw?.trim()) {
    throw new ScoreboardRunError('config', 'ENGINEERING_SCOREBOARD_ENGINEERS is required');
  }
  const text = raw.trim();
  const parsed = parseJson(text);
  if (Array.isArray(parsed)) {
    const engineers = parsed.map((row) => ({
      name: String(row.name ?? row.email ?? '').trim(),
      email: String(row.email ?? '').trim().toLowerCase(),
      prFloor: Number(row.prFloor ?? row.pr_floor ?? 0),
    })).filter((row) => row.name && row.email);
    if (engineers.length > 0) return engineers;
  }

  const engineers = text.split(',').map((entry) => {
    const [namePart, emailPart, floorPart] = entry.split('|').map((part) => part.trim());
    const email = (emailPart || namePart).toLowerCase();
    return {
      name: namePart || email,
      email,
      prFloor: Number(floorPart ?? 0),
    };
  }).filter((row) => row.email);
  if (engineers.length === 0) {
    throw new ScoreboardRunError('config', 'ENGINEERING_SCOREBOARD_ENGINEERS did not contain any engineers');
  }
  return engineers;
}

function findAccount(accounts: WeaveAccount[], engineer: EngineerConfig): WeaveAccount | null {
  const email = engineer.email.toLowerCase();
  const name = engineer.name.toLowerCase();
  return accounts.find((account) => account.email?.toLowerCase() === email)
    ?? accounts.find((account) => account.name.toLowerCase() === name)
    ?? null;
}

function latestForAnyGroup(points: WeaveMetricPoint[], groups: string[]): number | null {
  const normalized = new Set(groups.map((g) => g.toLowerCase()));
  return latestValue(points.filter((point) => point.group && normalized.has(point.group.toLowerCase())));
}

function latestValue(points: WeaveMetricPoint[]): number | null {
  if (points.length === 0) return null;
  return [...points].sort((a, b) => a.date.localeCompare(b.date))[points.length - 1].value;
}

function valueAt(points: WeaveMetricPoint[], index: number): number | null {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return sorted[index]?.value ?? null;
}

function burnDownDelta(netOpenBugs: number, priorSnapshots: EngineeringScoreboardSnapshot[]): number | null {
  const previous = [...priorSnapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!previous) return null;
  return previous.netOpenBugs - netOpenBugs;
}

function verdictFor(input: EngineeringScoreboardMessageInput, bugDelta: number | null): 'OK' | 'WARN' | 'HOLD' {
  if (input.orgTrend.bugRatioPrevious !== null && input.orgTrend.bugRatioCurrent !== null) {
    if (input.orgTrend.bugRatioCurrent > input.orgTrend.bugRatioPrevious && (bugDelta ?? 0) < 0) return 'HOLD';
  }
  if (input.engineerRows.some((row) => row.prs < row.prFloor)) return 'WARN';
  if ((bugDelta ?? 0) < 0) return 'WARN';
  return 'OK';
}

function trendPhrase(delta: number | null): string {
  if (delta === null) return 'no prior snapshot';
  if (delta > 0) return `burning down by ${delta}`;
  if (delta < 0) return `rising by ${Math.abs(delta)}`;
  return 'flat';
}

function deltaPhrase(current: number | null, previous: number | null, lowerIsBetter: boolean): string {
  if (current === null || previous === null) return 'no prior Weave point';
  const delta = current - previous;
  if (delta === 0) return 'flat';
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return `${improved ? 'better' : 'worse'} ${formatMetric(Math.abs(delta))}`;
}

function formatMetric(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  return s ? s : undefined;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractApiMessage(parsed: any): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.error === 'string') return parsed.error;
  if (typeof parsed.message === 'string') return parsed.message;
  if (Array.isArray(parsed.errors) && parsed.errors[0]?.message) return String(parsed.errors[0].message);
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
