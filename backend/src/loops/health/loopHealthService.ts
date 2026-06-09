/**
 * loopHealthService — the I/O wrapper around the pure `computeLoopHealth`.
 *
 * Iterates every registered loop manifest, reads its durable learning history
 * through the manifest's own learning store (so it works for any loop —
 * product funnels AND the agent-mode loop), and returns one `LoopHealth` per
 * loop. The route handler serializes the result; the operator dashboard renders
 * the six lifecycle states.
 *
 * Loop-agnostic by construction: a loop appears here the moment it registers a
 * manifest + learning store. No per-loop wiring, mirroring the attribution cron.
 */

import { getLearningStore, getRegisteredLoopManifests } from '../index';
import { computeLoopHealth, type LoopHealth } from '../core/health';
import { productionLoopPorts } from '../adapters/awsAdapters';
import type { ClockPort } from '../core/ports';

export interface LoopHealthReport {
  generatedAt: string;
  loops: LoopHealth[];
}

/**
 * Build the health report for every registered loop. A loop whose learning
 * store can't be read (misregistered impl, transient Dynamo error) is reported
 * with an `error` state rather than failing the whole report — one bad loop
 * must not blind the operator to the others.
 */
export async function getLoopHealthReport(
  clock: ClockPort = productionLoopPorts().clock,
): Promise<LoopHealthReport> {
  const now = clock.now();
  const loops: LoopHealth[] = [];

  for (const manifest of getRegisteredLoopManifests()) {
    try {
      const learning = getLearningStore(manifest.learningImpl);
      const history = await learning.queryHistory({ loopId: manifest.loopId });
      loops.push(computeLoopHealth(manifest, history, now));
    } catch (err) {
      loops.push({
        loopId: manifest.loopId,
        displayName: manifest.displayName,
        state: 'empty',
        paused: manifest.paused,
        targetMetric: manifest.targetMetric.name,
        counts: {
          total: 0,
          pendingApproval: 0,
          inFlight: 0,
          improved: 0,
          regressed: 0,
          noChange: 0,
          inconclusive: 0,
        },
        lastActivityAt: null,
        lastOutcome: null,
        error: err instanceof Error ? err.message : String(err),
      } as LoopHealth & { error: string });
    }
  }

  return { generatedAt: now.toISOString(), loops };
}
