/**
 * Daily cron for the ai-eval-funnel closed loop.
 *
 * Composes the production wiring: real DynamoPort + real SlackPort +
 * NotionDigestTool + CaptureGate + DynamoLearningStore + the manifest.
 * After each runLoop() returns, drains CaptureGate's collected mutations
 * and posts a single Slack DM summarizing the run + the Notion task URLs
 * that were created.
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
  registerOrReplaceGate,
  registerOrReplaceLearningStore,
  registerOrReplaceLoop,
  registerOrReplaceRuleSet,
  registerOrReplaceSensor,
  registerOrReplaceTools,
} from '../../index';
import { aiEvalManifest, AI_EVAL_LOOP_ID } from './manifest';
import { aiEvalRules } from './rules';
import { CaptureGate } from '../../core/gates/captureGate';
import { DynamoLearningStore } from '../../core/learning/dynamoLearningStore';
import { CooldownRuleSet } from '../../core/policy/cooldownRuleSet';
import { DslRuleSet } from '../../core/policy/dslRuleSet';
import { LlmAnalystRuleSet } from '../../core/policy/llmAnalystRuleSet';
import { EventTableEventSource } from '../../core/sensors/eventTableEventSource';
import { runLoop } from '../../core/orchestrator';
import { productionLoopPorts } from '../../adapters/awsAdapters';
import { NotionDigestTool } from './notionDigestTool';
import type { LoopRunResult, Mutation, NormalizedEvent, RuleSet } from '../../core/types';
import type { RcaEnrichment } from './rcaEnricher';

// Hold module-level refs so the cron can drain the gate after orchestrator returns.
let aiEvalGate: CaptureGate | null = null;
let aiEvalLearning: DynamoLearningStore | null = null;

export function registerAiEvalFunnelForProduction(): void {
  const ports = productionLoopPorts();
  const registered = getRegisteredLoopIds() as readonly string[];

  // Idempotent: skip if already registered for production.
  if (registered.includes(AI_EVAL_LOOP_ID)) {
    const existing = getLoopManifest(AI_EVAL_LOOP_ID);
    if (existing.sensorImpl === 'aiEvalSensor:prod') return;
  }

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
  const ruleSet = new CooldownRuleSet(baseRuleSet, learning, AI_EVAL_LOOP_ID);
  const tools = new NotionDigestTool();
  const gate = new CaptureGate();

  registerOrReplaceSensor('aiEvalSensor:prod', sensor);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOrReplaceRuleSet('aiEvalRules:prod', ruleSet as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOrReplaceTools('aiEvalSpecTool:prod', tools as any);
  registerOrReplaceGate('aiEvalCaptureGate:prod', gate);
  registerOrReplaceLearningStore('aiEvalLearning:prod', learning);

  registerOrReplaceLoop({
    ...aiEvalManifest,
    sensorImpl: 'aiEvalSensor:prod',
    rulesetImpl: 'aiEvalRules:prod',
    toolsImpl: 'aiEvalSpecTool:prod',
    gateImpl: 'aiEvalCaptureGate:prod',
    learningImpl: 'aiEvalLearning:prod',
  });

  aiEvalGate = gate;
  aiEvalLearning = learning;
}

export async function runAiEvalLoopOnce(): Promise<LoopRunResult> {
  const ports = productionLoopPorts();
  const manifest = getLoopManifest(AI_EVAL_LOOP_ID);
  const result = await runLoop(manifest, ports);

  // Drain the gate's captured mutations and post a single digest Slack DM.
  if (aiEvalGate) {
    const captured = aiEvalGate.drain();
    if (captured.length > 0 || result.eventsScanned > 0) {
      await postDailyDigest(result, captured, ports.slack, manifest.approval.slackUserId);
    }
  }

  return result;
}

/** Minimal slice of SlackPort that postDailyDigest actually uses. Exposed
 * widened in the test seam so unit tests can pass a stub with only the methods
 * we call. */
type SlackPosterLike = {
  postMessage: (channelOrUserId: string, markdown: string) => Promise<unknown>;
};

async function postDailyDigest(
  result: LoopRunResult,
  mutations: readonly Mutation[],
  slack: SlackPosterLike,
  slackUserId: string | undefined,
): Promise<void> {
  if (!slackUserId) {
    console.warn('[ai-eval-funnel cron] no approval.slackUserId configured — skipping daily DM');
    return;
  }

  const lines: string[] = [];
  lines.push(`*🌅 AI Eval Funnel — daily run ${new Date().toISOString().slice(0, 10)}*`);
  lines.push(`Run ID: \`${result.runId}\``);
  lines.push(
    `Events scanned: ${result.eventsScanned}  |  Rules fired: ${result.proposals.length}  |  Mutations: ${mutations.length}`,
  );
  lines.push('');

  if (result.eventsScanned === 0) {
    lines.push(`_No events in the last ${24 * 7}h window. Either traffic is dry or telemetry isn't reaching the table yet._`);
  } else if (result.proposals.length === 0) {
    lines.push(`_No rules fired — funnel is healthy._`);
  } else {
    lines.push(`*Proposed fixes*`);
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
  }

  lines.push('');
  lines.push(`React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop`);
  lines.push(`Reply in thread to skip a specific item (e.g. "skip 2").`);

  try {
    await slack.postMessage(slackUserId, lines.join('\n'));
  } catch (err) {
    console.error('[ai-eval-funnel cron] Slack DM post failed:', err);
  }
}

/** Truncate the top-fix title for the Slack DM. Adds an ellipsis when cut. */
function truncateForSlack(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Test helper. */
export function _resetCronModuleForTesting(): void {
  aiEvalGate = null;
  aiEvalLearning = null;
}

/** Test seam — calls the internal digest builder so unit tests can assert on
 * the DM format without mocking the AWS adapter stack. */
export const _postDailyDigestForTesting = postDailyDigest;

// Export internal so tests can assert on it without exposing it broadly.
export const _internal = {
  get aiEvalGate() {
    return aiEvalGate;
  },
  get aiEvalLearning() {
    return aiEvalLearning;
  },
};
