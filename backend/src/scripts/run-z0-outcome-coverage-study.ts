#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  exportOutcomeExpectationToZ0Safe,
  getZ0OutcomeCoverage,
  outcomeDataPromotionEligible,
  type Z0OutcomeExpectationInput,
} from '../services/z0OutcomeCoverage';
import {
  exportOutcomeObservationToZ0Safe,
  type Z0OutcomeObservationInput,
  type Z0OutcomeWindow,
} from '../services/z0OutcomeObservation';

const DECISION_TIME = '2026-09-01T12:00:00Z';
const EXECUTION_TIME = '2026-09-01T12:00:05Z';
const OBSERVED_AT: Record<Z0OutcomeWindow, string> = {
  '1h': '2026-09-01T13:00:00Z',
  '24h': '2026-09-02T12:00:00Z',
  '7d': '2026-09-08T12:00:00Z',
};

function expectation(index: number): Z0OutcomeExpectationInput {
  return {
    decisionTraceId: index.toString(16).padStart(64, '0'),
    decisionTime: DECISION_TIME,
    executionTime: EXECUTION_TIME,
    requiredWindows: ['1h', '24h', '7d'],
    subjectId: `raw-customer-${index}`,
    metric: {
      source: 'agentweb.analytics',
      name: 'conversion_rate',
      unit: 'ratio',
      direction: 'higher_better',
    },
  };
}

function observation(
  index: number,
  window: Z0OutcomeWindow,
  value: number,
): Z0OutcomeObservationInput {
  return {
    decisionTraceId: index.toString(16).padStart(64, '0'),
    decisionTime: DECISION_TIME,
    executionTime: EXECUTION_TIME,
    observationTime: OBSERVED_AT[window],
    window,
    subjectId: `raw-customer-${index}`,
    metric: {
      source: 'agentweb.analytics',
      name: 'conversion_rate',
      value,
      unit: 'ratio',
      direction: 'higher_better',
    },
  };
}

async function main() {
  const output = process.argv[2] ?? '/tmp/z0-outcome-coverage-study.json';
  const baseUrl = process.env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501';
  const env = {
    ...process.env,
    Z0INT_AGENTWEB_OUTCOME_EXPECT: 'shadow',
    Z0INT_AGENTWEB_OUTCOME_OBSERVE: 'shadow',
    Z0INT_SERVICE_URL: baseUrl,
  } as NodeJS.ProcessEnv;

  const expectation1 = await exportOutcomeExpectationToZ0Safe(expectation(1), { env });
  const expectation1Replay = await exportOutcomeExpectationToZ0Safe(expectation(1), { env });
  const expectation2 = await exportOutcomeExpectationToZ0Safe(expectation(2), { env });

  const changedExpectation = await exportOutcomeExpectationToZ0Safe({
    ...expectation(1),
    requiredWindows: ['1h', '24h'],
  }, { env });

  const beforeRows: any[] = [];
  for (const window of ['1h', '24h', '7d'] as Z0OutcomeWindow[]) {
    beforeRows.push(await exportOutcomeObservationToZ0Safe(
      observation(1, window, 0.10 + beforeRows.length * 0.01),
      { env },
    ));
  }
  for (const window of ['1h', '24h'] as Z0OutcomeWindow[]) {
    beforeRows.push(await exportOutcomeObservationToZ0Safe(
      observation(2, window, 0.20 + beforeRows.length * 0.01),
      { env },
    ));
  }

  const blocked = await getZ0OutcomeCoverage({
    baseUrl,
    cacheTtlMs: 0,
  });

  const final7d = await exportOutcomeObservationToZ0Safe(
    observation(2, '7d', 0.27),
    { env },
  );

  const passed = await getZ0OutcomeCoverage({
    baseUrl,
    cacheTtlMs: 0,
  });

  const result = {
    schema: 'z0eval.agentweb_outcome_coverage_gate_e2e.v1',
    expectation1,
    expectation1Replay,
    expectation2,
    changedExpectation,
    beforeRows,
    blocked,
    final7d,
    passed,
    blockedEligible: outcomeDataPromotionEligible(blocked),
    passedEligible: outcomeDataPromotionEligible(passed),
  };

  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');

  if (!expectation1.exported || expectation1.reason !== 'stored') {
    throw new Error('first expectation did not store');
  }
  if (!expectation1Replay.exported || expectation1Replay.reason !== 'replayed') {
    throw new Error('expectation replay did not reconcile');
  }
  if (!expectation2.exported || expectation2.reason !== 'stored') {
    throw new Error('second expectation did not store');
  }
  if (changedExpectation.exported || changedExpectation.reason !== 'http_400') {
    throw new Error('changed expectation under same identity did not conflict');
  }

  if (beforeRows.some(row => row.exported !== true)) {
    throw new Error('pre-gate observation export failed');
  }
  if (blocked.promotion_gate.eligible !== false || result.blockedEligible !== false) {
    throw new Error('coverage gate opened with one missing 7d slot');
  }
  if (blocked.by_window['1h'].coverage !== 1 || blocked.by_window['24h'].coverage !== 1) {
    throw new Error('short windows should have complete join coverage');
  }
  if (blocked.by_window['7d'].coverage !== 0.5) {
    throw new Error('7d coverage should be 0.5 before final slot');
  }

  if (!final7d.exported || final7d.reason !== 'stored') {
    throw new Error('final 7d observation failed');
  }
  if (passed.promotion_gate.eligible !== true || result.passedEligible !== true) {
    throw new Error('data-quality gate did not open after all required slots matured');
  }
  if (
    passed.promotion_gate.necessary_not_sufficient !== true ||
    passed.promotion_gate.causal_quality_proven !== false
  ) {
    throw new Error('coverage gate overclaimed causal authority');
  }

  process.stderr.write('z0 outcome coverage gate study passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
