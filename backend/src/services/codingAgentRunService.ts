import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import type { AcceptanceVerificationResult } from './codingAgentAcceptance';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const RUNS_TABLE = `${TABLE_PREFIX}AW-CodingAgentRuns`;

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
  httpOptions: { timeout: 10_000, connectTimeout: 3_000 },
});

export type CodingAgentRunState =
  | 'queued'
  | 'authorizing'
  | 'editing'
  | 'deploying'
  | 'verifying'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'timed_out'
  | 'cancelled'
  | 'rolled_back';

export interface CodingAgentRecoveryState {
  attempted?: boolean;
  status?: 'not_needed' | 'pending' | 'succeeded' | 'failed';
  reason?: string;
  baseCommitSha?: string;
  latestCommitSha?: string;
  message?: string;
}

export interface CodingAgentRun {
  runId: string;
  sessionId: string;
  pageId: string;
  userId: string;
  branch?: string;
  baseCommitSha?: string;
  latestCommitSha?: string;
  previewUrl?: string;
  state: CodingAgentRunState;
  failureReason?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  verification?: AcceptanceVerificationResult;
  recovery?: CodingAgentRecoveryState;
  transitions: Array<{ state: CodingAgentRunState; at: string; reason?: string }>;
}

export const TERMINAL_CODING_AGENT_STATES = new Set<CodingAgentRunState>([
  'passed',
  'failed',
  'blocked',
  'timed_out',
  'cancelled',
  'rolled_back',
]);

const memoryRuns = new Map<string, CodingAgentRun>();

function persistenceEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' || process.env.CODING_AGENT_RUNS_DYNAMO_TEST === 'true';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

async function bestEffortPersist(run: CodingAgentRun): Promise<void> {
  if (!persistenceEnabled()) return;
  try {
    await dynamodb.put({ TableName: RUNS_TABLE, Item: run }).promise();
  } catch (error: any) {
    console.warn('[CODING_AGENT_RUN] Persistence skipped:', error?.message || error);
  }
}

export function isTerminalCodingAgentState(state: CodingAgentRunState | undefined): boolean {
  return !!state && TERMINAL_CODING_AGENT_STATES.has(state);
}

export async function createCodingAgentRun(input: {
  sessionId: string;
  pageId: string;
  userId: string;
  branch?: string;
}): Promise<CodingAgentRun> {
  const now = new Date().toISOString();
  const run: CodingAgentRun = {
    runId: uuidv4(),
    sessionId: input.sessionId,
    pageId: input.pageId,
    userId: input.userId,
    branch: input.branch,
    state: 'queued',
    startedAt: now,
    updatedAt: now,
    transitions: [{ state: 'queued', at: now }],
    recovery: { status: 'not_needed' },
  };
  memoryRuns.set(run.runId, run);
  await bestEffortPersist(run);
  return clone(run);
}

export async function getCodingAgentRun(runId: string): Promise<CodingAgentRun | undefined> {
  const run = memoryRuns.get(runId);
  return run ? clone(run) : undefined;
}

export async function updateCodingAgentRun(
  runId: string,
  patch: Partial<Omit<CodingAgentRun, 'runId' | 'startedAt' | 'transitions'>> & {
    state?: CodingAgentRunState;
    transitionReason?: string;
  }
): Promise<CodingAgentRun | undefined> {
  const current = memoryRuns.get(runId);
  if (!current) return undefined;
  if (isTerminalCodingAgentState(current.state) && patch.state && patch.state !== current.state) {
    return clone(current);
  }

  const now = new Date().toISOString();
  const next: CodingAgentRun = {
    ...current,
    ...patch,
    updatedAt: now,
    transitions:
      patch.state && patch.state !== current.state
        ? [...current.transitions, { state: patch.state, at: now, reason: patch.transitionReason }]
        : current.transitions,
  };
  delete (next as any).transitionReason;
  if (patch.state && isTerminalCodingAgentState(patch.state)) {
    next.endedAt = next.endedAt || now;
  }

  memoryRuns.set(runId, next);
  await bestEffortPersist(next);
  return clone(next);
}

export function _resetCodingAgentRunsForTest(): void {
  memoryRuns.clear();
}
