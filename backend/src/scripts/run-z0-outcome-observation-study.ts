#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  exportOutcomeObservationToZ0Safe,
  projectOutcomeObservationToZ0,
  type Z0OutcomeObservationInput,
} from '../services/z0OutcomeObservation';

async function main() {
  const output = process.argv[2] ?? '/tmp/z0-outcome-observation-study.json';

  const base: Z0OutcomeObservationInput = {
    decisionTraceId: 'a'.repeat(64),
    decisionTime: '2026-10-01T12:00:00Z',
    executionTime: '2026-10-01T12:00:05Z',
    observationTime: '2026-10-01T13:00:00Z',
    window: '1h',
    subjectId: 'raw-customer-fixture',
    metric: {
      source: 'agentweb.analytics',
      name: 'conversion_rate',
      value: 0.12,
      unit: 'ratio',
      direction: 'higher_better',
    },
  };

  const env = {
    ...process.env,
    Z0INT_AGENTWEB_OUTCOME_OBSERVE: 'shadow',
  } as NodeJS.ProcessEnv;

  const oneHour = projectOutcomeObservationToZ0(base);
  const first = await exportOutcomeObservationToZ0Safe(base, { env });
  const replay = await exportOutcomeObservationToZ0Safe(base, { env });
  const mutation = await exportOutcomeObservationToZ0Safe({
    ...base,
    observationTime: '2026-10-01T13:05:00Z',
    metric: { ...base.metric, value: 0.13 },
  }, { env });

  const dayInput: Z0OutcomeObservationInput = {
    ...base,
    window: '24h',
    observationTime: '2026-10-02T12:00:00Z',
    metric: { ...base.metric, value: 0.16 },
  };
  const weekInput: Z0OutcomeObservationInput = {
    ...base,
    window: '7d',
    observationTime: '2026-10-08T12:00:00Z',
    metric: { ...base.metric, value: 0.19 },
  };

  const day = await exportOutcomeObservationToZ0Safe(dayInput, { env });
  const week = await exportOutcomeObservationToZ0Safe(weekInput, { env });

  const result = {
    schema: 'z0eval.agentweb_outcome_observation_e2e.v1',
    projected_1h: oneHour,
    first,
    replay,
    mutation,
    day,
    week,
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');

  if (!first.exported || first.reason !== 'stored') throw new Error('1h first store failed');
  if (!replay.exported || replay.reason !== 'replayed') throw new Error('1h replay failed');
  if (mutation.exported || mutation.reason !== 'http_400') throw new Error('mutation conflict was not rejected');
  if (!day.exported || day.reason !== 'stored') throw new Error('24h store failed');
  if (!week.exported || week.reason !== 'stored') throw new Error('7d store failed');

  if (first.observation_id !== replay.observation_id) throw new Error('replay identity changed');
  if (mutation.observation_id !== first.observation_id) throw new Error('mutation did not preserve immutable slot identity');
  if (day.observation_id === first.observation_id || week.observation_id === first.observation_id) {
    throw new Error('measurement windows did not get distinct identities');
  }

  process.stderr.write('z0 outcome observation study passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
