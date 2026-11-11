import { getEngineeringBugStats, type EngineeringBugStats } from '../services/linearService';
import { productionLoopPorts } from '../loops/adapters/awsAdapters';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import type { DynamoPort } from '../loops/core/ports';

const SCOREBOARD_LOOP_ID = 'engineering-scoreboard-weekly';

export type ScoreboardErrorType =
  | 'config'
  | 'linear'
  | 'snapshot'
  | 'slack_delivery';

class ScoreboardRunError extends Error {
  constructor(public readonly type: ScoreboardErrorType, message: string) {
    super(message);
    this.name = 'ScoreboardRunError';
  }
}

export interface EngineeringScoreboardSnapshot {
  snapshotDate: string;
  netOpenBugs: number;
  opened7d: number;
  closed7d: number;
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
  priorSnapshots: EngineeringScoreboardSnapshot[];
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
    const recipient = deps.env.ENGINEERING_SCOREBOARD_SLACK_USER_ID || deps.env.LOOP_APPROVAL_SLACK_USER_ID;
    if (!recipient) throw new ScoreboardRunError('config', 'ENGINEERING_SCOREBOARD_SLACK_USER_ID is required');

    const now = deps.now();
    const end = ymd(now);
    const start = ymd(addDays(now, -7));

    const bugStats = await deps.linear.getBugStats(start, end).catch((err: unknown) => {
      throw new ScoreboardRunError('linear', errorMessage(err));
    });

    const priorSnapshots = await deps.snapshots.listRecentSnapshots(8).catch((err: unknown) => {
      throw new ScoreboardRunError('snapshot', errorMessage(err));
    });

    const message = buildEngineeringScoreboardMessage({
      reportDate: end,
      bugStats,
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
  const verdict = (bugDelta ?? 0) < 0 ? 'WARN' : 'OK';
  return [
    `*Engineering Scoreboard - ${input.reportDate}*`,
    `TL;DR: ${verdict} bugs ${trendPhrase(bugDelta)}`,
    '',
    `Bugs: ${input.bugStats.netOpenBugs} open bugs (+${input.bugStats.opened7d}/-${input.bugStats.closed7d} last 7d). Trend: ${trendPhrase(bugDelta)}.`,
    '',
    '_Read-only: Linear was not modified._',
  ].join('\n');
}

async function createProductionEngineeringScoreboardDeps(): Promise<EngineeringScoreboardDeps> {
  const ports = productionLoopPorts();
  return {
    env: process.env,
    now: () => new Date(),
    linear: { getBugStats: getEngineeringBugStats },
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

export class DynamoScoreboardSnapshotStore implements SnapshotStore {
  constructor(private readonly dynamo: DynamoPort) {}

  async listRecentSnapshots(limit: number): Promise<EngineeringScoreboardSnapshot[]> {
    const result = await this.dynamo.query({
      tableName: LOOP_EVENTS_TABLE,
      keyConditionExpression: 'loopId = :loopId',
      expressionAttributeValues: { ':loopId': SCOREBOARD_LOOP_ID },
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
    createdAt: item.createdAt,
  };
}

function burnDownDelta(netOpenBugs: number, priorSnapshots: EngineeringScoreboardSnapshot[]): number | null {
  const previous = [...priorSnapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!previous) return null;
  return previous.netOpenBugs - netOpenBugs;
}

function trendPhrase(delta: number | null): string {
  if (delta === null) return 'no prior snapshot';
  if (delta > 0) return `burning down by ${delta}`;
  if (delta < 0) return `rising by ${Math.abs(delta)}`;
  return 'flat';
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
