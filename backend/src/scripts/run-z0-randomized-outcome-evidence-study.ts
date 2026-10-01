#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  exportOutcomeExpectationToZ0Safe,
} from '../services/z0OutcomeCoverage';
import {
  exportOutcomeObservationToZ0Safe,
  type Z0OutcomeWindow,
} from '../services/z0OutcomeObservation';
import {
  exportOutcomeAssignmentToZ0Safe,
  getZ0RandomizedOutcomeEvidence,
  randomizedOutcomeEvidenceReviewReady,
} from '../services/z0OutcomeRandomizedEvidence';

const EXPERIMENT_ID = 'agentweb-live-outcome-v1';
const DECISION_TIME = '2026-09-01T12:00:00Z';
const EXECUTION_TIME = '2026-09-01T12:00:05Z';
const ASSIGNED_AT = '2026-09-01T11:59:59Z';
const OBSERVED_AT: Record<Z0OutcomeWindow, string> = {
  '1h': '2026-09-01T13:00:00Z',
  '24h': '2026-09-02T12:00:00Z',
  '7d': '2026-09-08T12:00:00Z',
};

function trace(index: number): string {
  return index.toString(16).padStart(64, '0');
}

async function main() {
  const output = process.argv[2] ?? '/tmp/z0-randomized-evidence-study.json';
  const baseUrl = process.env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501';
  const env = {
    ...process.env,
    Z0INT_AGENTWEB_OUTCOME_EXPECT: 'shadow',
    Z0INT_AGENTWEB_OUTCOME_OBSERVE: 'shadow',
    Z0INT_AGENTWEB_OUTCOME_ASSIGNMENT: 'shadow',
    Z0INT_SERVICE_URL: baseUrl,
  } as NodeJS.ProcessEnv;

  const values: Record<number, number> = {
    1: 0.20,
    2: 0.24,
    3: 0.10,
    4: 0.12,
  };

  const expectations = [];
  const observations = [];

  for (let index = 1; index <= 4; index += 1) {
    expectations.push(await exportOutcomeExpectationToZ0Safe({
      decisionTraceId: trace(index),
      decisionTime: DECISION_TIME,
      executionTime: EXECUTION_TIME,
      requiredWindows: ['1h', '24h', '7d'],
      subjectId: `raw-randomized-unit-${index}`,
      metric: {
        source: 'agentweb.analytics',
        name: 'conversion_rate',
        unit: 'ratio',
        direction: 'higher_better',
      },
    }, { env }));

    for (const window of ['1h', '24h', '7d'] as Z0OutcomeWindow[]) {
      observations.push(await exportOutcomeObservationToZ0Safe({
        decisionTraceId: trace(index),
        decisionTime: DECISION_TIME,
        executionTime: EXECUTION_TIME,
        observationTime: OBSERVED_AT[window],
        window,
        subjectId: `raw-randomized-unit-${index}`,
        metric: {
          source: 'agentweb.analytics',
          name: 'conversion_rate',
          value: values[index],
          unit: 'ratio',
          direction: 'higher_better',
        },
      }, { env }));
    }
  }

  const beforeAssignments = await getZ0RandomizedOutcomeEvidence({
    baseUrl,
    cacheTtlMs: 0,
  });

  const assignments = [];
  for (let index = 1; index <= 4; index += 1) {
    const candidate = index <= 2;
    assignments.push(await exportOutcomeAssignmentToZ0Safe({
      decisionTraceId: trace(index),
      subjectId: `raw-randomized-unit-${index}`,
      experimentId: EXPERIMENT_ID,
      pairId: `pair-${index}`,
      armId: candidate ? 'candidate' : 'reference',
      treatmentHash: candidate ? 'a'.repeat(16) : 'b'.repeat(16),
      selectionPolicy: 'production',
      assignmentMethod: 'randomized',
      assignmentProbability: 0.5,
      assignedAt: ASSIGNED_AT,
    }, { env }));
  }

  const replay = await exportOutcomeAssignmentToZ0Safe({
    decisionTraceId: trace(1),
    subjectId: 'raw-randomized-unit-1',
    experimentId: EXPERIMENT_ID,
    pairId: 'pair-1',
    armId: 'candidate',
    treatmentHash: 'a'.repeat(16),
    selectionPolicy: 'production',
    assignmentMethod: 'randomized',
    assignmentProbability: 0.5,
    assignedAt: ASSIGNED_AT,
  }, { env });

  const mutation = await exportOutcomeAssignmentToZ0Safe({
    decisionTraceId: trace(1),
    subjectId: 'raw-randomized-unit-1',
    experimentId: EXPERIMENT_ID,
    pairId: 'pair-1',
    armId: 'reference',
    treatmentHash: 'b'.repeat(16),
    selectionPolicy: 'production',
    assignmentMethod: 'randomized',
    assignmentProbability: 0.5,
    assignedAt: ASSIGNED_AT,
  }, { env });

  const afterAssignments = await getZ0RandomizedOutcomeEvidence({
    baseUrl,
    cacheTtlMs: 0,
  });
  const reviewReady = randomizedOutcomeEvidenceReviewReady(
    afterAssignments,
    EXPERIMENT_ID,
  );

  const result = {
    schema: 'z0eval.agentweb_randomized_outcome_evidence_e2e.v1',
    expectations,
    observations,
    beforeAssignments,
    assignments,
    replay,
    mutation,
    afterAssignments,
    reviewReady,
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');

  if (expectations.some(row => !row.exported || row.reason !== 'stored')) {
    throw new Error('expectation registration failed');
  }
  if (observations.some(row => !row.exported || row.reason !== 'stored')) {
    throw new Error('outcome observation registration failed');
  }

  if (beforeAssignments.coverage.promotion_gate.eligible !== true) {
    throw new Error('coverage prerequisite did not pass');
  }
  if (beforeAssignments.review_ready_any !== false) {
    throw new Error('causal review opened without assignment evidence');
  }

  if (assignments.some(row => !row.exported || row.reason !== 'stored')) {
    throw new Error('randomized assignment registration failed');
  }
  if (!replay.exported || replay.reason !== 'replayed') {
    throw new Error('assignment replay did not reconcile');
  }
  if (mutation.exported || mutation.reason !== 'http_400') {
    throw new Error('changed assignment did not conflict');
  }

  const experiment = afterAssignments.experiments[EXPERIMENT_ID];
  if (!experiment || experiment.review_ready !== true || reviewReady !== true) {
    throw new Error('human-review gate did not open');
  }
  if (
    experiment.auto_promotion_allowed !== false ||
    afterAssignments.auto_promotion_allowed !== false ||
    experiment.human_review_required !== true ||
    afterAssignments.human_review_required !== true ||
    experiment.causal_quality_proven !== false ||
    afterAssignments.causal_quality_proven !== false
  ) {
    throw new Error('randomized review barrier overclaimed promotion authority');
  }

  const oneHour =
    experiment.metric_windows['agentweb.analytics:conversion_rate']['1h'];
  if (oneHour.candidate_n !== 2 || oneHour.reference_n !== 2) {
    throw new Error('arm counts are wrong');
  }
  if (
    oneHour.candidate_mean === null ||
    oneHour.reference_mean === null ||
    oneHour.difference_in_means === null
  ) {
    throw new Error('effect summary unexpectedly incomplete');
  }
  if (Math.abs(oneHour.candidate_mean - 0.22) > 1e-12) {
    throw new Error('candidate mean mismatch');
  }
  if (Math.abs(oneHour.reference_mean - 0.11) > 1e-12) {
    throw new Error('reference mean mismatch');
  }
  if (Math.abs(oneHour.difference_in_means - 0.11) > 1e-12) {
    throw new Error('difference-in-means mismatch');
  }
  if (!oneHour.ci95 || oneHour.ci95.length !== 2) {
    throw new Error('95% interval missing');
  }

  process.stderr.write('z0 randomized outcome evidence study passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
