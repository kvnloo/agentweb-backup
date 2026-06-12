/**
 * Wires the /ai-eval-funnel loop into the LOOP_REGISTRY — both flavors:
 *
 *  - `registerAiEvalFunnel` — in-memory wiring for the smoke runners.
 *  - `registerAiEvalFunnelForProduction` + `runAiEvalLoopOnce` — the daily
 *    production cron wiring (previously in cron.ts), built on the shared
 *    instance runner like the other loop instances: real DynamoPort + real
 *    SlackPort + NotionDigestTool + CaptureGate + DynamoLearningStore.
 *    After each runLoop() the runner drains CaptureGate's collected mutations
 *    and posts a single Slack DM digest.
 *
 * Idempotent registration: safe to call at process startup multiple times
 * (e.g. across cluster instance hot-reloads). The cron itself is scheduled
 * once by server.ts; multiple instances of the backend would each run their
 * own copy → mitigated by the fireLoopEventOnce idempotency on the
 * event-write side and by the orchestrator's cap on proposals per cycle.
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
import {
  postLoopDigest,
  type LoopDigestTemplate,
  type SlackPosterLike,
} from '../../core/digest/loopDigest';
import { createInstanceRunner } from '../../core/instanceRunner';
import { DynamoLearningStore } from '../../core/learning/dynamoLearningStore';
import { InMemoryLearningStore } from '../../core/learning/inMemoryLearningStore';
import { CooldownRuleSet } from '../../core/policy/cooldownRuleSet';
import { DslRuleSet } from '../../core/policy/dslRuleSet';
import { LlmAnalystRuleSet } from '../../core/policy/llmAnalystRuleSet';
import { EventTableEventSource } from '../../core/sensors/eventTableEventSource';
import { InMemoryEventSource } from '../../core/sensors/inMemoryEventSource';
import { SpecOutputTool } from '../../core/tools/specOutputTool';
import { productionLoopPorts } from '../../adapters/awsAdapters';
import type { LoopRunResult, Mutation, NormalizedEvent, RuleSet } from '../../core/types';
import { asLoopId } from '../../core/types';
import { AI_EVAL_LOOP_ID, aiEvalManifest } from './manifest';
import { NotionDigestTool } from './notionDigestTool';
import type { RcaEnrichment } from './rcaEnricher';
import type { AiEvalProposalPayload } from './rules';
import { aiEvalRules } from './rules';

// ---------------------------------------------------------------------------
// In-memory wiring — used by the smoke runners (scripts/smokeTest.ts etc.).
// ---------------------------------------------------------------------------

interface AiEvalRegistry {
  sensor: InMemoryEventSource;
  ruleSet: DslRuleSet<AiEvalProposalPayload>;
  tools: SpecOutputTool<AiEvalProposalPayload>;
  gate: CaptureGate;
  learning: InMemoryLearningStore;
}

let registered: AiEvalRegistry | null = null;

export function registerAiEvalFunnel(events: readonly NormalizedEvent[] = []): AiEvalRegistry {
  if (registered) {
    return registered;
  }

  const sensor = new InMemoryEventSource(events);
  const ruleSet = new DslRuleSet<AiEvalProposalPayload>(AI_EVAL_LOOP_ID, aiEvalRules);
  const tools = new SpecOutputTool<AiEvalProposalPayload>(AI_EVAL_LOOP_ID);
  const gate = new CaptureGate();
  const learning = new InMemoryLearningStore();

  registerSensor('aiEvalSensor', sensor);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRuleSet('aiEvalRules', ruleSet as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTools('aiEvalSpecTool', tools as any);
  registerGate('aiEvalCaptureGate', gate);
  registerLearningStore('aiEvalLearning', learning);
  registerLoop(aiEvalManifest);

  registered = { sensor, ruleSet, tools, gate, learning };
  return registered;
}

// ---------------------------------------------------------------------------
// Production wiring — registered at app boot, run daily by server.ts.
// ---------------------------------------------------------------------------

const runner = createInstanceRunner({
  loopId: AI_EVAL_LOOP_ID,
  ports: productionLoopPorts,
  implNames: {
    sensor: 'aiEvalSensor:prod',
    ruleSet: 'aiEvalRules:prod',
    tools: 'aiEvalSpecTool:prod',
    gate: 'aiEvalCaptureGate:prod',
    learning: 'aiEvalLearning:prod',
  },
  // Already-registered only counts if it's the PRODUCTION wiring — the
  // in-memory smoke wiring above registers the same loopId and must be
  // replaced, not kept.
  isAlreadyRegistered: () => {
    if (!(getRegisteredLoopIds() as readonly string[]).includes(AI_EVAL_LOOP_ID)) return false;
    return getLoopManifest(asLoopId(AI_EVAL_LOOP_ID)).sensorImpl === 'aiEvalSensor:prod';
  },
  // The cron relies on app-boot registration (app.ts), exactly like before.
  registerOnRun: false,
  buildLayers: (ports) => {
    // Scope the loop to the /ai-eval funnel itself: keep only `landed` events on
    // /ai-eval, dropping site-wide landings (blog, home, etc.) whose visitors have
    // other intents and are not failed funnel entries. The loop measures
    // /ai-eval -> /ai-eval, not all-traffic -> /ai-eval.
    const sensor = new EventTableEventSource(ports.dynamo, AI_EVAL_LOOP_ID, {
      scope: { eventType: 'landed', dimensionKey: 'landerPath', dimensionValue: '/ai-eval' },
    });
    // Policy layer. Default = the DSL threshold rules. Set AI_EVAL_LLM_ANALYST=true
    // to swap in the LLM analyst, which reasons over the telemetry instead of
    // firing fixed thresholds (catches what no rule predicted, and works at low
    // volume). Gated so merging is inert until the flag is flipped in prod after a
    // verification pass. The flowDescription is what gives the analyst its lens —
    // note the landerPath caveat so it doesn't false-alarm on site-wide `landed`.
    const learning = new DynamoLearningStore(ports.dynamo);
    const baseRuleSet = (
      process.env.AI_EVAL_LLM_ANALYST === 'true'
        ? new LlmAnalystRuleSet(AI_EVAL_LOOP_ID, ports.bedrock, {
            model: aiEvalManifest.generator.model,
            targetMetricName: aiEvalManifest.targetMetric.name,
            maxProposals: 3,
            chapterDimension: 'landerPath',
            flowDescription:
              'The /ai-eval landing page funnel. A visitor LANDS, fills a form with their ' +
              'website URL + email (form_submitted), the backend runs an AI marketing eval ' +
              '(eval_started -> eval_completed), shows a report (report_viewed), and prompts ' +
              'signup (signup_clicked -> signed_up). IMPORTANT: the `landed` event fires on ' +
              'EVERY marketing page (see the landerPath dimension), NOT just /ai-eval — only ' +
              'landerPath=/ai-eval are real funnel entries, so do not treat total landed as the ' +
              'funnel denominator. `eval_started` is the server-confirmed capture signal; ' +
              '`form_submitted` is a client event that under-fires. Goal: more eval completers ' +
              'become signups.',
          })
        : new DslRuleSet(AI_EVAL_LOOP_ID, aiEvalRules)
    ) as RuleSet<NormalizedEvent, unknown>;
    return {
      sensor,
      ruleSet: new CooldownRuleSet(baseRuleSet, learning, AI_EVAL_LOOP_ID),
      tools: new NotionDigestTool(),
      gate: new CaptureGate(),
      learning,
    };
  },
  manifest: () => ({
    ...aiEvalManifest,
    sensorImpl: 'aiEvalSensor:prod',
    rulesetImpl: 'aiEvalRules:prod',
    toolsImpl: 'aiEvalSpecTool:prod',
    gateImpl: 'aiEvalCaptureGate:prod',
    learningImpl: 'aiEvalLearning:prod',
  }),
  onRunComplete: async ({ result, drained, ports, manifest }) => {
    // Drain the gate's captured mutations and post a single digest Slack DM.
    if (drained === null) return;
    if (drained.length > 0 || result.eventsScanned > 0) {
      await postDailyDigest(result, drained, ports.slack, manifest.approval.slackUserId);
    }
  },
});

export function registerAiEvalFunnelForProduction(): void {
  runner.register();
}

export async function runAiEvalLoopOnce(): Promise<LoopRunResult> {
  // Never null: registerOnRun is false, so runOnce never short-circuits.
  return (await runner.runOnce()) as LoopRunResult;
}

/** TExtra = the mutations drained from the gate this tick. */
const aiEvalDigestTemplate: LoopDigestTemplate<readonly Mutation[]> = {
  logTag: '[ai-eval-funnel cron]',
  missingUserWarning: 'no approval.slackUserId configured — skipping daily DM',
  header: (date) => `*🌅 AI Eval Funnel — daily run ${date}*`,
  counts: (result, mutations) =>
    `Events scanned: ${result.eventsScanned}  |  Rules fired: ${result.proposals.length}  |  Mutations: ${mutations.length}`,
  emptyBody: () => [
    `_No events in the last ${24 * 7}h window. Either traffic is dry or telemetry isn't reaching the table yet._`,
  ],
  quietBody: () => [`_No rules fired — funnel is healthy._`],
  findingsBody: (result, mutations) => {
    const lines = [`*Proposed fixes*`];
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      const p = result.proposals[i];
      const artifact = m.artifact as {
        notionUrl?: string;
        title?: string;
        rcaEnrichment?: RcaEnrichment;
      };
      const ruleId = p?.sourceRuleId ?? 'unknown';
      const titleLine = artifact.notionUrl
        ? `${i + 1}. <${artifact.notionUrl}|${artifact.title ?? ruleId}>`
        : `${i + 1}. ${artifact.title ?? ruleId}`;
      lines.push(titleLine);
      lines.push(`   Rule: \`${ruleId}\`  |  Kind: \`${p?.kind ?? 'n/a'}\``);
      // RCA top-fix line: one indented bullet under each rule. Acceptance #3.
      const rca = artifact.rcaEnrichment;
      if (rca?.error) {
        lines.push(`   ⚠️ RCA unavailable`);
      } else if (rca && rca.rankedFixes.length > 0) {
        lines.push(`   ↳ Top fix: ${truncateForSlack(rca.rankedFixes[0].title, 80)}`);
      }
      if (m.error) lines.push(`   ⚠️ ${m.error}`);
    }
    return lines;
  },
  footerExtra: [`Reply in thread to skip a specific item (e.g. "skip 2").`],
};

async function postDailyDigest(
  result: LoopRunResult,
  mutations: readonly Mutation[],
  slack: SlackPosterLike,
  slackUserId: string | undefined,
): Promise<void> {
  await postLoopDigest(result, slack, slackUserId, aiEvalDigestTemplate, mutations);
}

/** Truncate the top-fix title for the Slack DM. Adds an ellipsis when cut. */
function truncateForSlack(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Test helper. */
export function _resetCronModuleForTesting(): void {
  runner.resetForTesting();
}

/** Test seam — calls the internal digest builder so unit tests can assert on
 * the DM format without mocking the AWS adapter stack. */
export const _postDailyDigestForTesting = postDailyDigest;

// Export internal so tests can assert on it without exposing it broadly.
export const _internal = {
  get aiEvalGate() {
    return runner.gate;
  },
  get aiEvalLearning() {
    return runner.layers?.learning ?? null;
  },
};
