/**
 * Generic attribution cron for every registered loop.
 *
 * A loop is not self-learning until shipped mutations are measured after their
 * settle window and the result is written back into Layer 5. This runner is
 * deliberately loop-agnostic: any product surface that registers a manifest,
 * sensor, and durable learning store gets the same attribution pass.
 */

import {
  getLearningStore,
  getRegisteredLoopManifests,
  getSensor,
} from '../index';
import { productionLoopPorts } from '../adapters/awsAdapters';
import { runAttribution, type AttributionSummary } from '../core/learning/attribution';
import type { LoopId } from '../core/types';
import type { LoopPorts } from '../core/ports';

export interface LoopAttributionResult {
  loopId: LoopId;
  skipped: boolean;
  reason?: string;
  summary?: AttributionSummary;
  error?: string;
}

export interface LoopAttributionRunResult {
  startedAt: Date;
  finishedAt: Date;
  loops: LoopAttributionResult[];
}

export async function runLoopAttributionOnce(
  ports: LoopPorts = productionLoopPorts(),
): Promise<LoopAttributionRunResult> {
  const startedAt = ports.clock.now();
  const results: LoopAttributionResult[] = [];

  for (const manifest of getRegisteredLoopManifests()) {
    if (manifest.paused) {
      results.push({
        loopId: manifest.loopId,
        skipped: true,
        reason: manifest.pauseReason ?? 'paused',
      });
      continue;
    }

    try {
      const sensor = getSensor(manifest.sensorImpl);
      const learning = getLearningStore(manifest.learningImpl);
      const summary = await runAttribution({
        manifest,
        sensor,
        learning,
        clock: ports.clock,
        logger: ports.logger,
        slack: ports.slack,
        slackChannelOrUserId: manifest.approval.slackChannel ?? manifest.approval.slackUserId,
      });
      results.push({ loopId: manifest.loopId, skipped: false, summary });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ports.logger.log('error', '[loops] attribution failed', {
        loopId: manifest.loopId,
        error,
      });
      results.push({ loopId: manifest.loopId, skipped: false, error });
    }
  }

  const finishedAt = ports.clock.now();
  ports.logger.log('info', '[loops] attribution run done', {
    loops: results.length,
    attributed: results.reduce((sum, r) => sum + (r.summary?.attributed ?? 0), 0),
    errors: results.filter((r) => r.error).length,
  });

  return { startedAt, finishedAt, loops: results };
}
