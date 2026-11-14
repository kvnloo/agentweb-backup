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

/** Failed reads carry unknown observations, never fabricated zero counts. */
export interface UnavailableLoopHealth extends Omit<LoopHealth, 'state' | 'counts' | 'lastActivityAt' | 'lastOutcome'> {
  state: 'unavailable';
  counts: null;
  lastActivityAt: null;
  lastOutcome: null;
  error: 'learning_history_unavailable';
}

export interface LoopHealthReport {
  generatedAt: string;
  loops: (LoopHealth | UnavailableLoopHealth)[];
}

/**
 * Build the health report for every registered loop. A loop whose learning
 * store can't be read (misregistered impl, transient Dynamo error) is reported
 * with an `unavailable` state rather than failing the whole report — one bad loop
 * must not blind the operator to the others.
 */
export async function getLoopHealthReport(
  clock: ClockPort = productionLoopPorts().clock,
): Promise<LoopHealthReport> {
  const now = clock.now();
  const loops: LoopHealthReport['loops'] = [];

  for (const manifest of getRegisteredLoopManifests()) {
    try {
      const learning = getLearningStore(manifest.learningImpl);
      const history = await learning.queryHistory({ loopId: manifest.loopId });
      loops.push(computeLoopHealth(manifest, history, now));
    } catch {
      loops.push({
        loopId: manifest.loopId,
        displayName: manifest.displayName,
        state: 'unavailable',
        paused: manifest.paused,
        ...(manifest.pauseReason ? { pauseReason: manifest.pauseReason } : {}),
        targetMetric: manifest.targetMetric.name,
        counts: null,
        lastActivityAt: null,
        lastOutcome: null,
        error: 'learning_history_unavailable',
      });
    }
  }

  return { generatedAt: now.toISOString(), loops };
}
