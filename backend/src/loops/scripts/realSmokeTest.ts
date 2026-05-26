/**
 * Real-data smoke test for the lander loop.
 *
 * Reads real `AI_GTM_Position_Eval` sessions from `/tmp/real-eval-sessions.json`
 * (the DynamoDB scan of AW-ChatSessions) and the corresponding messages from
 * `/tmp/real-session-messages/<sessionId>.json` (queries of AW-ChatMessages).
 *
 * For each session, derives `NormalizedEvent`s:
 *   - `eval_started` at session.createdAt
 *   - `eval_completed` if any message body contains an https://*.html URL
 *   - `eval_failed` if any message has `metadata.isErrorMessage = true`
 *   - `eval_abandoned` if neither completed nor failed and last message is
 *     more than 10 minutes after createdAt (suggests user gave up)
 *   - `low_satisfaction` if satisfactionScore.score <= 3
 *
 * Then runs `runLoop(aiEvalManifest, smokePorts)` against those events and
 * reports what rules fired against REAL data, plus drains the captureGate
 * for the proposed fixes that need cloud-dev attention.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runLoop } from '../core/orchestrator';
import type { LoopPorts, S3Port, DynamoPort, BedrockPort, SlackPort, ClockPort, LoggerPort } from '../core/ports';
import { _resetRegistryForTesting } from '../index';
import { registerAiEvalFunnel } from '../instances/ai-eval-funnel';
import { aiEvalManifest } from '../instances/ai-eval-funnel/manifest';
import type { FixSpec } from '../core/tools/specOutputTool';
import type { NormalizedEvent } from '../core/types';
import { asSubjectId } from '../core/types';

// ---------------------------------------------------------------------------
// Read raw DynamoDB items
// ---------------------------------------------------------------------------

interface DynamoItem {
  [key: string]: { S?: string; N?: string; BOOL?: boolean; M?: DynamoItem; L?: DynamoItem[] };
}

interface SessionMeta {
  sessionId: string;
  createdAt: string;
  satisfactionScore?: { score: number; reason?: string; evaluatedMessageIndex?: number };
}

interface SessionAnalysis {
  meta: SessionMeta;
  messages: number;
  hasReportUrl: boolean;
  hasErrorMessage: boolean;
  errorSamples: string[];
  lastMessageTs?: Date;
  durationMs?: number;
  abandoned: boolean;
  lowSat: boolean;
}

function readSessionMeta(): SessionMeta[] {
  const raw = JSON.parse(fs.readFileSync('/tmp/real-eval-sessions.json', 'utf8')) as {
    Items: DynamoItem[];
  };
  return raw.Items.map((s) => ({
    sessionId: s.sessionId.S!,
    createdAt: s.createdAt.S!,
    satisfactionScore: s.satisfactionScore?.M
      ? {
          score: Number(s.satisfactionScore.M.score?.N ?? '5'),
          reason: s.satisfactionScore.M.reason?.S,
          evaluatedMessageIndex: s.satisfactionScore.M.evaluatedMessageIndex?.N
            ? Number(s.satisfactionScore.M.evaluatedMessageIndex.N)
            : undefined,
        }
      : undefined,
  }));
}

function analyzeSession(meta: SessionMeta): SessionAnalysis {
  const msgsPath = path.join('/tmp/real-session-messages', `${meta.sessionId}.json`);
  if (!fs.existsSync(msgsPath)) {
    return {
      meta,
      messages: 0,
      hasReportUrl: false,
      hasErrorMessage: false,
      errorSamples: [],
      abandoned: false,
      lowSat: (meta.satisfactionScore?.score ?? 5) <= 3,
    };
  }
  const raw = JSON.parse(fs.readFileSync(msgsPath, 'utf8')) as { Items: DynamoItem[] };
  const items = raw.Items ?? [];
  let hasReportUrl = false;
  let hasErrorMessage = false;
  const errorSamples: string[] = [];
  let lastMessageTs: Date | undefined;

  for (const it of items) {
    const m = it.message?.M;
    if (!m) continue;
    const content = m.content?.S ?? '';
    if (/https:\/\/[^\s"']+\.html/.test(content)) hasReportUrl = true;
    if (m.metadata?.M?.isErrorMessage?.BOOL === true) {
      hasErrorMessage = true;
      if (errorSamples.length < 3) errorSamples.push(content.slice(0, 300));
    }
    const ts = m.timestamp?.S ?? m.metadata?.M?.timestamp?.S;
    if (ts) {
      const d = new Date(ts);
      if (!lastMessageTs || d > lastMessageTs) lastMessageTs = d;
    }
  }

  const createdAt = new Date(meta.createdAt);
  const durationMs = lastMessageTs ? lastMessageTs.getTime() - createdAt.getTime() : undefined;

  const abandoned =
    !hasReportUrl &&
    !hasErrorMessage &&
    typeof durationMs === 'number' &&
    durationMs > 10 * 60 * 1000;

  return {
    meta,
    messages: items.length,
    hasReportUrl,
    hasErrorMessage,
    errorSamples,
    lastMessageTs,
    durationMs,
    abandoned,
    lowSat: (meta.satisfactionScore?.score ?? 5) <= 3,
  };
}

// ---------------------------------------------------------------------------
// Derive NormalizedEvents from analyses
// ---------------------------------------------------------------------------

function toEvents(analyses: readonly SessionAnalysis[]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const a of analyses) {
    const sid = asSubjectId(a.meta.sessionId);
    const created = new Date(a.meta.createdAt);

    // Always fire eval_started.
    events.push({ subjectId: sid, eventType: 'eval_started', ts: created });

    if (a.hasReportUrl) {
      events.push({
        subjectId: sid,
        eventType: 'eval_completed',
        ts: a.lastMessageTs ?? created,
        dimensions: a.lowSat
          ? { lowSatReason: a.meta.satisfactionScore?.reason ?? '' }
          : undefined,
      });
    }
    if (a.hasErrorMessage) {
      events.push({
        subjectId: sid,
        eventType: 'eval_failed',
        ts: a.lastMessageTs ?? created,
        dimensions: {
          errorMessage: a.errorSamples[0] ?? 'unknown',
          allErrorSamples: a.errorSamples.join(' | '),
        },
      });
    }
    if (a.abandoned) {
      events.push({
        subjectId: sid,
        eventType: 'eval_abandoned',
        ts: a.lastMessageTs ?? created,
        dimensions: { elapsedMs: a.durationMs ?? 0 },
      });
    }
    if (a.lowSat) {
      events.push({
        subjectId: sid,
        eventType: 'complaint_received',
        ts: a.lastMessageTs ?? created,
        dimensions: {
          complaintText: a.meta.satisfactionScore?.reason ?? 'low satisfaction',
          complaintChannel: 'llm_judge',
          satisfactionScore: a.meta.satisfactionScore?.score ?? 0,
        },
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Stub ports — same as the synthetic smoke; only stderr logger
// ---------------------------------------------------------------------------

const noopS3: S3Port = {
  async getObject() {
    throw new Error('S3 not used in smoke');
  },
  async putObject() {
    return { versionId: 'smoke' };
  },
};
const noopDynamo: DynamoPort = {
  async putItem() {},
  async getItem() {
    return null;
  },
  async query() {
    return { items: [] };
  },
};
const noopBedrock: BedrockPort = {
  async invoke() {
    return { text: '[smoke-stub]', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  },
};
const noopSlack: SlackPort = {
  async postMessage() {
    return { channel: 'smoke', ts: 'smoke' };
  },
  async getReactions() {
    return [];
  },
  async getReplies() {
    return [];
  },
};
const realClock: ClockPort = { now: () => new Date() };
const consoleLogger: LoggerPort = {
  log(level, message, context) {
    if (level === 'debug' && process.env.LOOPS_DEBUG !== '1') return;
    process.stderr.write(`[${level}] ${message} ${context ? JSON.stringify(context) : ''}\n`);
  },
};
const smokePorts: LoopPorts = {
  s3: noopS3,
  dynamo: noopDynamo,
  bedrock: noopBedrock,
  slack: noopSlack,
  clock: realClock,
  logger: consoleLogger,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const metas = readSessionMeta();
  process.stderr.write(`[smoke] read ${metas.length} session metas\n`);

  const analyses = metas.map(analyzeSession);
  const events = toEvents(analyses);

  // Funnel stats over real data
  const totalSessions = analyses.length;
  const completed = analyses.filter((a) => a.hasReportUrl).length;
  const failed = analyses.filter((a) => a.hasErrorMessage).length;
  const abandoned = analyses.filter((a) => a.abandoned).length;
  const lowSat = analyses.filter((a) => a.lowSat).length;
  const noMessages = analyses.filter((a) => a.messages === 0).length;
  const durations = analyses
    .map((a) => a.durationMs)
    .filter((d): d is number => typeof d === 'number');
  const medianDuration =
    durations.length > 0
      ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]
      : 0;
  const p90Duration =
    durations.length > 0
      ? durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.9)]
      : 0;

  // Pick the most concrete failure samples for the report
  const failureSamples = analyses
    .filter((a) => a.hasErrorMessage)
    .flatMap((a) => a.errorSamples.map((s) => ({ sessionId: a.meta.sessionId, sample: s })))
    .slice(0, 5);

  // Low-sat reasons
  const lowSatSamples = analyses
    .filter((a) => a.lowSat)
    .map((a) => ({
      sessionId: a.meta.sessionId,
      score: a.meta.satisfactionScore?.score,
      reason: a.meta.satisfactionScore?.reason ?? '',
    }))
    .slice(0, 5);

  // Run the loop against real events. Override window to include all the
  // historical data we pulled (last 30 days).
  _resetRegistryForTesting();
  registerAiEvalFunnel(events);
  const now = new Date();
  const window = {
    start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    end: now,
  };
  const result = await runLoop(aiEvalManifest, smokePorts, { window });

  // Build the structured report
  const report = {
    source: 'AW-ChatSessions production scan (pageIdentifier = plan-AI_GTM_Position_Eval, last 30d)',
    funnel: {
      totalSessions,
      completedEvalCount: completed,
      failedEvalCount: failed,
      abandonedEvalCount: abandoned,
      lowSatisfactionCount: lowSat,
      zeroMessageSessionsInChatSessionsTable: noMessages, // note: messages live in AW-ChatMessages, not AW-ChatSessions
      medianSessionDurationMs: medianDuration,
      p90SessionDurationMs: p90Duration,
      completionRate: completed / totalSessions,
      failureRate: failed / totalSessions,
      abandonmentRate: abandoned / totalSessions,
    },
    failureSamples,
    lowSatSamples,
    runResult: {
      eventsScanned: result.eventsScanned,
      rulesFired: result.proposals.map((p) => ({
        ruleId: p.sourceRuleId,
        hypothesis: p.hypothesis,
        kind: p.kind,
        triggeringStats: p.triggeringStats,
      })),
      mutationCount: result.mutations.length,
    },
    fixSpecs: result.mutations
      .filter((m) => !m.error)
      .map((m) => {
        const fixSpec = (m.artifact as { fixSpec?: FixSpec }).fixSpec;
        return fixSpec ? { title: fixSpec.title, summary: fixSpec.summary, body: fixSpec } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  };

  process.stdout.write(JSON.stringify(report, null, 2));
  process.stdout.write('\n');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[realSmoke] fatal:', err);
  process.exit(2);
});
