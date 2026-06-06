/**
 * Registers + runs the /ai-readiness lander funnel loop (framework instance).
 *
 * Policy = the LLM analyst (reasons over the funnel, names the binding
 * constraint), NOT the legacy fixed-threshold DSL. The digest always reports
 * the funnel SHAPE and never says "healthy" on silence — a daily heartbeat so
 * "no message" can't be confused with "all good".
 *
 * Layer mapping:
 *   sensor   = EventTableEventSource over Dev-AW-LoopEvents, scoped to
 *              landerPath=/ai-readiness (drops site-wide `landed`)
 *   policy   = LlmAnalystRuleSet (binding-constraint lens via flowDescription)
 *   tools    = SpecOutputTool (records the proposal spec; the DM is the value)
 *   gate     = CaptureGate (Slack DM + reactions)
 *   learning = InMemoryLearningStore
 *
 * Registration is ALWAYS performed (so /api/loop-events accepts + stores the
 * lander's events). The daily analysis run is scheduled separately in
 * server.ts and is killable via AI_READINESS_LOOP_ENABLED=false.
 */

import {
  getLoopManifest,
  getRegisteredLoopIds,
  registerGate,
  registerLearningStore,
  registerLoop,
  registerRuleSet,
  registerSensor,
  registerTools,
} from '../../index';
import { CaptureGate } from '../../core/gates/captureGate';
import { InMemoryLearningStore } from '../../core/learning/inMemoryLearningStore';
import { LlmAnalystRuleSet } from '../../core/policy/llmAnalystRuleSet';
import { EventTableEventSource } from '../../core/sensors/eventTableEventSource';
import { SpecOutputTool } from '../../core/tools/specOutputTool';
import { runLoop } from '../../core/orchestrator';
import { productionLoopPorts } from '../../adapters/awsAdapters';
import type { DynamoPort } from '../../core/ports';
import type { LoopRunResult, NormalizedEvent } from '../../core/types';
import {
  AI_READINESS_FLOW_DESCRIPTION,
  AI_READINESS_LOOP_ID,
  aiReadinessManifest,
} from './manifest';

const READINESS_SCOPE = {
  eventType: 'landed',
  dimensionKey: 'landerPath',
  dimensionValue: '/ai-readiness',
} as const;

// Held so the tick can drain the gate after the orchestrator returns.
let aiReadinessGate: CaptureGate | null = null;

/**
 * Register the loop. Idempotent. Does NOT reset the registry, so it coexists
 * with the ai-eval + onboarding loops. Must be called AFTER
 * registerAiEvalFunnelForProduction() in app.ts (that legacy function resets
 * the registry only when called on a non-empty registry).
 */
export function registerAiReadinessFunnel(): void {
  if ((getRegisteredLoopIds() as readonly string[]).includes(AI_READINESS_LOOP_ID)) return;

  const ports = productionLoopPorts();

  const sensor = new EventTableEventSource(ports.dynamo, AI_READINESS_LOOP_ID, {
    scope: { ...READINESS_SCOPE },
  });
  const ruleSet = new LlmAnalystRuleSet(AI_READINESS_LOOP_ID, ports.bedrock, {
    model: aiReadinessManifest.generator.model,
    targetMetricName: aiReadinessManifest.targetMetric.name,
    flowDescription: AI_READINESS_FLOW_DESCRIPTION,
    maxProposals: 3,
    chapterDimension: 'landerPath',
  });
  const tools = new SpecOutputTool(AI_READINESS_LOOP_ID);
  const gate = new CaptureGate();
  const learning = new InMemoryLearningStore();

  registerSensor('aiReadinessSensor', sensor);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRuleSet('aiReadinessAnalyst', ruleSet as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTools('aiReadinessSpecTool', tools as any);
  registerGate('aiReadinessGate', gate);
  registerLearningStore('aiReadinessLearning', learning);
  registerLoop(aiReadinessManifest);

  aiReadinessGate = gate;
}

/**
 * Run one tick: register, run the orchestrator over the 7d window, drain the
 * gate, and DM Harsha the analyst's findings + the funnel shape. Always posts
 * a digest (heartbeat). Never throws — errors are logged.
 */
export async function runAiReadinessLoopOnce(): Promise<LoopRunResult> {
  registerAiReadinessFunnel();

  const ports = productionLoopPorts();
  const manifest = getLoopManifest(AI_READINESS_LOOP_ID);
  const result = await runLoop(manifest, ports);

  if (aiReadinessGate) aiReadinessGate.drain();

  const shape = await summarizeFunnel(ports.dynamo).catch(() => null);
  await postDigest(result, shape, ports.slack, manifest.approval.slackUserId);

  return result;
}

interface FunnelShape {
  landed: number;
  quiz_started: number;
  form_submitted: number;
  book_clicked: number;
  signup_clicked: number;
}

/** Tally the 7d funnel shape directly from the event table (scoped to
 * /ai-readiness) so the digest always shows where people drop, not just a
 * total. */
async function summarizeFunnel(dynamo: DynamoPort): Promise<FunnelShape> {
  const source = new EventTableEventSource(dynamo, AI_READINESS_LOOP_ID, { scope: { ...READINESS_SCOPE } });
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const events: NormalizedEvent[] = await source.fetchEvents({ start, end });
  const shape: FunnelShape = {
    landed: 0,
    quiz_started: 0,
    form_submitted: 0,
    book_clicked: 0,
    signup_clicked: 0,
  };
  for (const e of events) {
    if (e.eventType in shape) shape[e.eventType as keyof FunnelShape]++;
  }
  return shape;
}

function shapeLine(s: FunnelShape): string {
  return (
    `*Funnel (7d):* landed \`${s.landed}\` → quiz \`${s.quiz_started}\` → ` +
    `*captured \`${s.form_submitted}\`* → book \`${s.book_clicked}\` / signup \`${s.signup_clicked}\``
  );
}

/** When the analyst surfaces no page-level fix, say what the constraint IS —
 * never "healthy". At low capture volume that constraint is awareness. */
function constraintLine(s: FunnelShape): string {
  if (s.form_submitted < 10) {
    return (
      `_Binding constraint: top-of-funnel volume._ Only \`${s.form_submitted}\` captures in 7d — ` +
      `too few to optimize on-page. The lever is traffic: route homepage/blog visitors into this ` +
      `lander and add external volume. On-page copy is the wrong altitude until volume is real.`
    );
  }
  return `_No disproportionate leak this window. Watch the shape above; the next push is whichever stage is thinnest._`;
}

/** Build the digest DM lines. Pure (no I/O) so it can be unit-tested across
 * the three branches: empty window, no-finding (constraint), and findings.
 * Never emits "healthy". */
export function buildDigestLines(result: LoopRunResult, shape: FunnelShape | null): string[] {
  const lines: string[] = [];
  lines.push(`*🧭 AI Readiness Funnel — daily run ${new Date().toISOString().slice(0, 10)}*`);
  lines.push(`Run ID: \`${result.runId}\``);
  lines.push(`Events scanned: ${result.eventsScanned}  |  Findings: ${result.proposals.length}`);
  if (shape) lines.push(shapeLine(shape));
  lines.push('');

  if (result.eventsScanned === 0) {
    lines.push(`_No events in the 7d window — the lander isn't getting traffic, or telemetry just turned on. Not "healthy", just empty._`);
  } else if (result.proposals.length === 0) {
    lines.push(shape ? constraintLine(shape) : `_No page-level fix surfaced — check the binding constraint manually._`);
  } else {
    lines.push(`*What I found*`);
    for (let i = 0; i < result.proposals.length; i++) {
      const p = result.proposals[i];
      const directive = (p.payload as { directive?: string } | undefined)?.directive ?? '';
      lines.push(`${i + 1}. ${p.hypothesis}`);
      lines.push(`   Kind: \`${p.kind}\`${directive ? `  |  Fix: ${directive}` : ''}`);
    }
  }
  lines.push('');
  lines.push(`React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop`);
  return lines;
}

async function postDigest(
  result: LoopRunResult,
  shape: FunnelShape | null,
  slack: { postMessage: (channelOrUserId: string, markdown: string) => Promise<unknown> },
  slackUserId: string | undefined,
): Promise<void> {
  if (!slackUserId) {
    console.warn('[ai-readiness-funnel] no approval.slackUserId — skipping DM');
    return;
  }
  try {
    await slack.postMessage(slackUserId, buildDigestLines(result, shape).join('\n'));
  } catch (err) {
    console.error('[ai-readiness-funnel] Slack DM post failed:', err);
  }
}

/** Test seam. */
export const _internal = { get aiReadinessGate() { return aiReadinessGate; } };
export const _testing = { summarizeFunnel, buildDigestLines };
