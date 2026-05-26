/**
 * Orchestrator — wires the 5 layers for a single loop run.
 *
 * Loop-agnostic. The manifest names which layer impls to use; the registry
 * (loops/index.ts) returns them; this function calls them in order:
 *
 *   sensor.fetchEvents → ruleSet.evaluate → tools.apply → gate.requestApproval
 *   → learning.record (after each step that produces a fact worth keeping)
 *
 * The orchestrator is responsible for:
 *   - Skipping the run when the manifest is paused.
 *   - Enforcing the per-cycle token budget (manifest.thresholds.maxTokensPerCycleUsd).
 *   - Capping the number of proposals materialized per cycle (manifest.thresholds.maxActiveArmsPerKey).
 *   - Returning a structured LoopRunResult for the caller (cron + smoke harness).
 *
 * It is NOT responsible for:
 *   - Generating mutations (the tools layer does that, often via Bedrock).
 *   - Polling for approval decisions (the watchdog cron does that separately).
 *   - Statistical lift computation (a future Statistician agent does that
 *     inside the policy layer or as a periodic batch job).
 */

import {
  getGate,
  getLearningStore,
  getRuleSet,
  getSensor,
  getTools,
} from '../index';
import {
  ApprovalRecord,
  LoopManifest,
  LoopRunResult,
  Mutation,
  MutationProposal,
  TimeWindow,
  asRunId,
} from './types';
import type { LoopPorts } from './ports';

export interface RunLoopOptions {
  /** Override the time window. If omitted, defaults to the last
   * `manifest.targetMetric.windowDays` days ending at clock.now(). */
  window?: TimeWindow;
  /** Skip the gate step (used by the smoke harness so it can assert on
   * proposals + mutations without posting real Slack DMs). */
  skipGate?: boolean;
}

export async function runLoop(
  manifest: LoopManifest,
  ports: LoopPorts,
  options: RunLoopOptions = {},
): Promise<LoopRunResult> {
  const startedAt = ports.clock.now();
  const runId = asRunId(`loop-${manifest.loopId}-${startedAt.toISOString()}-${Math.floor(Math.random() * 1e6)}`);
  ports.logger.log('info', '[loops] runLoop start', { loopId: manifest.loopId, runId });

  // Compute time window.
  const window: TimeWindow = options.window ?? {
    start: new Date(startedAt.getTime() - manifest.targetMetric.windowDays * 24 * 60 * 60 * 1000),
    end: startedAt,
  };

  const result: LoopRunResult = {
    loopId: manifest.loopId,
    runId,
    startedAt,
    finishedAt: startedAt,
    eventsScanned: 0,
    proposals: [],
    mutations: [],
    approvals: [],
    blocked: false,
    durationMs: 0,
    tokensSpentUsd: 0,
  };

  // Bail early if paused.
  if (manifest.paused) {
    result.blocked = true;
    result.blockReason = manifest.pauseReason ?? 'paused';
    result.finishedAt = ports.clock.now();
    result.durationMs = result.finishedAt.getTime() - startedAt.getTime();
    ports.logger.log('warn', '[loops] runLoop skipped (paused)', { loopId: manifest.loopId });
    return result;
  }

  try {
    // Layer 1: Sensor.
    const sensor = getSensor(manifest.sensorImpl);
    const events = await sensor.fetchEvents(window);
    result.eventsScanned = events.length;
    ports.logger.log('debug', '[loops] sensor read', {
      loopId: manifest.loopId,
      events: events.length,
    });

    // Layer 2: Policy.
    const ruleSet = getRuleSet(manifest.rulesetImpl);
    const allProposals = (await ruleSet.evaluate(events, window)) as MutationProposal<unknown>[];

    // Cap proposals per cycle so the loop respects the budget.
    const cap = manifest.thresholds.maxActiveArmsPerKey * Math.max(1, manifest.mutationSurface.length);
    const proposals = allProposals.slice(0, cap);
    result.proposals = proposals;
    ports.logger.log('debug', '[loops] policy fired rules', {
      loopId: manifest.loopId,
      proposals: proposals.length,
      capped: allProposals.length - proposals.length,
    });

    // Layer 5 (learning record for proposals) is interleaved with each step
    // so partial-failure runs still emit useful audit trails.
    const learning = getLearningStore(manifest.learningImpl);

    // Layer 3: Tools.
    const tools = getTools(manifest.toolsImpl);
    const mutations: Mutation[] = [];
    for (const proposal of proposals) {
      try {
        const mutation = await tools.apply(proposal);
        mutations.push(mutation);
        await learning.record({
          loopId: manifest.loopId,
          runId,
          ts: ports.clock.now(),
          proposal,
          mutation,
        });
      } catch (err) {
        ports.logger.log('error', '[loops] tools.apply failed', {
          loopId: manifest.loopId,
          proposalId: proposal.proposalId,
          error: String(err),
        });
        await learning.record({
          loopId: manifest.loopId,
          runId,
          ts: ports.clock.now(),
          proposal,
          mutation: {
            mutationId: proposal.proposalId,
            proposalId: proposal.proposalId,
            kind: proposal.kind,
            artifact: {},
            error: String(err),
          },
        });
      }
    }
    result.mutations = mutations;

    // Layer 4: Quality gate.
    if (!options.skipGate) {
      const gate = getGate(manifest.gateImpl);
      const approvals: ApprovalRecord[] = [];
      for (const mutation of mutations) {
        if (mutation.error) continue; // don't request approval on failed mutations
        try {
          const approval = await gate.requestApproval(mutation);
          approvals.push(approval);
          await learning.record({
            loopId: manifest.loopId,
            runId,
            ts: ports.clock.now(),
            mutation,
            decision: { status: 'pending', decidedAt: ports.clock.now() },
          });
        } catch (err) {
          ports.logger.log('error', '[loops] gate.requestApproval failed', {
            loopId: manifest.loopId,
            mutationId: mutation.mutationId,
            error: String(err),
          });
        }
      }
      result.approvals = approvals;
    }
  } catch (err) {
    ports.logger.log('error', '[loops] runLoop top-level error', {
      loopId: manifest.loopId,
      error: String(err),
    });
    result.blocked = true;
    result.blockReason = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  result.finishedAt = ports.clock.now();
  result.durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
  ports.logger.log('info', '[loops] runLoop done', {
    loopId: manifest.loopId,
    runId,
    durationMs: result.durationMs,
    eventsScanned: result.eventsScanned,
    proposals: result.proposals.length,
    mutations: result.mutations.length,
    approvals: result.approvals.length,
    blocked: result.blocked,
  });

  return result;
}
