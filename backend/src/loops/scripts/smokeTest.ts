/**
 * Smoke test entry point for the closed-loop framework.
 *
 * Runs the full pipeline described in ACCEPTANCE_SPEC.md against scripted
 * persona data. Produces a structured JSON report of:
 *   - Which personas were replayed
 *   - Which rules fired
 *   - What fix specs were generated
 *   - What Notion tasks would be created (with full body content)
 *   - What Slack DM would be sent (with full body content)
 *
 * The Notion task + Slack DM payloads are emitted as JSON so the runner
 * (or a host wrapper) can make the real API calls. This keeps the framework
 * itself host-agnostic.
 *
 * Run with:
 *   cd backend && npx ts-node src/loops/scripts/smokeTest.ts
 * or:
 *   cd backend && npx ts-node src/loops/scripts/smokeTest.ts --personas=default
 *   cd backend && npx ts-node src/loops/scripts/smokeTest.ts --personas=completer-only
 */

import { runLoop } from '../core/orchestrator';
import type { LoopPorts, S3Port, DynamoPort, BedrockPort, SlackPort, ClockPort, LoggerPort } from '../core/ports';
import { _resetRegistryForTesting } from '../index';
import { registerAiEvalFunnel } from '../instances/ai-eval-funnel';
import { aiEvalManifest } from '../instances/ai-eval-funnel/manifest';
import {
  completerOnlyEvents,
  defaultSmokeEvents,
} from '../instances/ai-eval-funnel/personas';
import type { FixSpec } from '../core/tools/specOutputTool';
import type { LoopRunResult, NormalizedEvent } from '../core/types';

// ---------------------------------------------------------------------------
// Stub ports — none of these matter for the in-memory smoke path. The
// framework is wired so that real port impls drop in cleanly later.
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
  async putItem() {
    /* noop */
  },
  async getItem() {
    return null;
  },
  async query() {
    return { items: [] };
  },
};
const noopBedrock: BedrockPort = {
  async invoke(call) {
    return {
      text: `[smoke-stub] would invoke ${call.model} with system="${call.systemPrompt.slice(0, 60)}…"`,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  },
};
const noopSlack: SlackPort = {
  async postMessage(_c, _m) {
    return { channel: 'smoke', ts: 'smoke' };
  },
};
const realClock: ClockPort = { now: () => new Date() };
const consoleLogger: LoggerPort = {
  log(level, message, context) {
    if (level === 'debug' && process.env.LOOPS_DEBUG !== '1') return;
    // Write to stderr so the smoke script's JSON output on stdout stays clean.
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
// Persona-marking summary — answers the spec's "where does the marking show up"
// ---------------------------------------------------------------------------

interface PersonaSummary {
  kind: 'bounced_early' | 'completed' | 'friction_signal';
  count: number;
  representative: { subjectId: string; lastStage: string; frictionType?: string };
}

function summarizePersonas(events: readonly NormalizedEvent[]): PersonaSummary[] {
  const bySubject = new Map<string, NormalizedEvent[]>();
  for (const e of events) {
    const arr = bySubject.get(e.subjectId) ?? [];
    arr.push(e);
    bySubject.set(e.subjectId, arr);
  }

  let bouncedEarly = 0;
  let completed = 0;
  const friction: { subjectId: string; lastStage: string; frictionType: string }[] = [];
  let firstBouncer: string | undefined;
  let firstCompleter: string | undefined;
  let firstBouncerLast: string | undefined;
  let firstCompleterLast: string | undefined;

  for (const [subjectId, subjectEvents] of bySubject) {
    const types = subjectEvents.map((e) => e.eventType);
    const last = types[types.length - 1];

    if (types.includes('eval_failed')) {
      friction.push({ subjectId, lastStage: last, frictionType: 'eval_failed' });
    } else if (types.includes('eval_abandoned')) {
      friction.push({ subjectId, lastStage: last, frictionType: 'eval_timeout' });
    } else if (types.includes('complaint_received')) {
      friction.push({ subjectId, lastStage: last, frictionType: 'complaint' });
    } else if (types.includes('signed_up')) {
      completed++;
      if (!firstCompleter) {
        firstCompleter = subjectId;
        firstCompleterLast = last;
      }
    } else if (types.length === 1 && types[0] === 'landed') {
      bouncedEarly++;
      if (!firstBouncer) {
        firstBouncer = subjectId;
        firstBouncerLast = last;
      }
    } else {
      // Mid-funnel — treat as bounced for now (lands before signup).
      bouncedEarly++;
    }
  }

  const out: PersonaSummary[] = [];
  if (bouncedEarly > 0) {
    out.push({
      kind: 'bounced_early',
      count: bouncedEarly,
      representative: { subjectId: firstBouncer ?? 'n/a', lastStage: firstBouncerLast ?? 'landed' },
    });
  }
  if (completed > 0) {
    out.push({
      kind: 'completed',
      count: completed,
      representative: { subjectId: firstCompleter ?? 'n/a', lastStage: firstCompleterLast ?? 'signed_up' },
    });
  }
  if (friction.length > 0) {
    out.push({
      kind: 'friction_signal',
      count: friction.length,
      representative: { ...friction[0] },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build the Notion task + Slack DM payloads from the orchestrator's output
// ---------------------------------------------------------------------------

interface NotionTaskPayload {
  title: string;
  body: string;
  cloudDevTags: readonly string[];
}

interface SlackDmPayload {
  channel: string;
  markdown: string;
}

function buildNotionTasks(result: LoopRunResult): NotionTaskPayload[] {
  return result.mutations
    .filter((m) => !m.error)
    .map((m) => {
      const fixSpec = (m.artifact as { fixSpec?: FixSpec }).fixSpec;
      if (!fixSpec) {
        return {
          title: `fix(unknown): ${m.mutationId}`,
          body: 'No fixSpec in mutation artifact.',
          cloudDevTags: ['cloud-dev'],
        };
      }
      const body = [
        `## Summary`,
        fixSpec.summary,
        ``,
        `## Triggering data`,
        '```json',
        JSON.stringify(fixSpec.triggeringData, null, 2),
        '```',
        ``,
        `## Proposed change`,
        '```json',
        JSON.stringify(fixSpec.proposedChange, null, 2),
        '```',
        ``,
        `## Review context`,
        '```',
        fixSpec.reviewContext,
        '```',
        ``,
        `## Acceptance criteria`,
        `1. The fix preserves existing behavior on all other landing-page surfaces.`,
        `2. Behavioral assertions: the lander loop's smoke test continues to pass after this fix.`,
        `3. Human reviewer (Harsha) approves the proposed change via the linked Slack DM.`,
      ].join('\n');
      return { title: fixSpec.title, body, cloudDevTags: fixSpec.cloudDevTags };
    });
}

function buildSlackDm(
  result: LoopRunResult,
  notionTasks: readonly NotionTaskPayload[],
  personaSummary: readonly PersonaSummary[],
  slackUserId: string,
): SlackDmPayload {
  const lines: string[] = [];
  lines.push(`*🌅 AI Eval Funnel — smoke test report*`);
  lines.push(`Run ID: \`${result.runId}\``);
  lines.push(`Events scanned: ${result.eventsScanned}  |  Rules fired: ${result.proposals.length}  |  Mutations: ${result.mutations.length}`);
  lines.push('');
  lines.push(`*Personas processed*`);
  for (const p of personaSummary) {
    lines.push(`• \`${p.kind}\` × ${p.count} — example: ${p.representative.subjectId} (last stage: ${p.representative.lastStage}${p.representative.frictionType ? `, friction: ${p.representative.frictionType}` : ''})`);
  }
  lines.push('');
  if (result.proposals.length === 0) {
    lines.push(`_No rules fired this tick — funnel is healthy. (Completer-only smoke run.)_`);
  } else {
    lines.push(`*Proposed fixes* (cloud-dev tasks queued)`);
    for (let i = 0; i < notionTasks.length; i++) {
      const t = notionTasks[i];
      const p = result.proposals[i];
      lines.push(`${i + 1}. *${t.title}*`);
      lines.push(`   Rule: \`${p?.sourceRuleId ?? 'n/a'}\`  |  Kind: \`${p?.kind ?? 'n/a'}\``);
      lines.push(`   ${p?.hypothesis ?? ''}`);
    }
  }
  lines.push('');
  lines.push(`React: ✅ ship all  |  ❌ skip all  |  🛑 pause loop`);
  lines.push(`Reply in thread to skip a specific item (e.g. "skip 2"). No response by 6pm PT auto-ships per autoShipConditions.`);

  return {
    channel: slackUserId,
    markdown: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SmokeReport {
  loopId: string;
  scenarioName: string;
  acceptanceSpec: {
    personasProcessed: PersonaSummary[];
    rulesFired: readonly { ruleId: string; hypothesis: string; kind: string }[];
    notionTasksToCreate: NotionTaskPayload[];
    slackDmToSend: SlackDmPayload;
  };
  runResult: {
    loopId: string;
    runId: string;
    eventsScanned: number;
    proposalCount: number;
    mutationCount: number;
    blocked: boolean;
    blockReason?: string;
    durationMs: number;
  };
  passed: boolean;
  failureReasons: string[];
}

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--personas='));
  const scenarioName = arg ? arg.split('=')[1] : 'default';

  const events =
    scenarioName === 'completer-only'
      ? completerOnlyEvents()
      : defaultSmokeEvents();

  _resetRegistryForTesting();
  registerAiEvalFunnel(events);

  const result = await runLoop(aiEvalManifest, smokePorts);
  const personaSummary = summarizePersonas(events);
  const notionTasks = buildNotionTasks(result);
  const slackDm = buildSlackDm(
    result,
    notionTasks,
    personaSummary,
    aiEvalManifest.approval.slackUserId ?? 'U08TM4QFQ1L',
  );

  // Acceptance assertions
  const failures: string[] = [];

  if (scenarioName === 'default') {
    const bouncedEarlyCount = personaSummary.find((p) => p.kind === 'bounced_early')?.count ?? 0;
    const completedCount = personaSummary.find((p) => p.kind === 'completed')?.count ?? 0;
    const frictionCount = personaSummary.find((p) => p.kind === 'friction_signal')?.count ?? 0;
    if (bouncedEarlyCount < 1) {
      failures.push('Expected ≥1 early-dipper persona in default smoke; found 0.');
    }
    if (completedCount < 1) {
      failures.push('Expected ≥1 completer persona; found 0.');
    }
    if (frictionCount < 1) {
      failures.push('Expected ≥1 friction_signal persona (eval_failed/timeout/complaint); found 0.');
    }
    if (result.proposals.length === 0) {
      failures.push('Expected ≥1 rule fired in default smoke; none fired.');
    }
    if (notionTasks.length === 0) {
      failures.push('Expected ≥1 Notion task to be created; none built.');
    }
    // Friction-class coverage: each of the three friction subtypes should
    // produce a rule firing.
    const firedIds = new Set(result.proposals.map((p) => p.sourceRuleId));
    if (!firedIds.has('eval-failing')) {
      failures.push("Expected 'eval-failing' rule to fire from failure persona events; did not.");
    }
    if (!firedIds.has('wait-too-long')) {
      failures.push("Expected 'wait-too-long' rule to fire from timeout persona events; did not.");
    }
    if (!firedIds.has('complaint-received')) {
      failures.push("Expected 'complaint-received' rule to fire from complaint persona events; did not.");
    }
  } else if (scenarioName === 'completer-only') {
    if (result.proposals.length !== 0) {
      failures.push(
        `Expected 0 rules fired in completer-only smoke; ${result.proposals.length} fired ` +
          `(${result.proposals.map((p) => p.sourceRuleId).join(', ')}).`,
      );
    }
  }

  const report: SmokeReport = {
    loopId: aiEvalManifest.loopId,
    scenarioName,
    acceptanceSpec: {
      personasProcessed: personaSummary,
      rulesFired: result.proposals.map((p) => ({
        ruleId: p.sourceRuleId,
        hypothesis: p.hypothesis,
        kind: p.kind,
      })),
      notionTasksToCreate: notionTasks,
      slackDmToSend: slackDm,
    },
    runResult: {
      loopId: result.loopId,
      runId: result.runId,
      eventsScanned: result.eventsScanned,
      proposalCount: result.proposals.length,
      mutationCount: result.mutations.length,
      blocked: result.blocked,
      blockReason: result.blockReason,
      durationMs: result.durationMs,
    },
    passed: failures.length === 0,
    failureReasons: failures,
  };

  process.stdout.write(JSON.stringify(report, null, 2));
  process.stdout.write('\n');
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smokeTest] fatal:', err);
  process.exit(2);
});
