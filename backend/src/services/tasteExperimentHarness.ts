import { createHash } from 'crypto';
import {
  TASTE_SURFACES,
  type TasteApplicationReceipt,
  type TasteSurface,
} from './tasteProfileService';

export const TASTE_EXPERIMENT_SCHEMA = 'taste.experiment.v1';
export const TASTE_EXPERIMENT_RECEIPT_SCHEMA = 'taste.experiment-receipt.v1';
export const TASTE_PAIRWISE_SCHEMA = 'taste.pairwise.v1';

export const TASTE_EXPERIMENT_ARMS = [
  'brand_only',
  'brand_taste',
  'brand_performance',
  'brand_taste_performance',
] as const;

export type TasteExperimentArm = typeof TASTE_EXPERIMENT_ARMS[number];

export type TasteExperimentCase = {
  caseId: string;
  surface: TasteSurface;
  prompt: string;
  evaluationNotes: string[];
};

export const TASTE_EXPERIMENT_SUITE_V1: readonly TasteExperimentCase[] = [
  {
    caseId: 'landing-pricing-hero-v1',
    surface: 'landing_page',
    prompt: 'Create a pricing-page hero and first fold for a B2B security product. Preserve the supplied offer and CTA exactly.',
    evaluationNotes: ['hierarchy', 'brand fit', 'clarity', 'accessibility'],
  },
  {
    caseId: 'image-product-launch-v1',
    surface: 'image',
    prompt: 'Create a square product-launch image for an analytics dashboard. Preserve the supplied headline exactly.',
    evaluationNotes: ['composition', 'brand fit', 'legibility', 'anti-slop'],
  },
  {
    caseId: 'social-launch-v1',
    surface: 'social',
    prompt: 'Draft a concise launch post from the supplied product facts without inventing claims or metrics.',
    evaluationNotes: ['voice', 'specificity', 'brand fit', 'factuality'],
  },
  {
    caseId: 'research-executive-brief-v1',
    surface: 'research',
    prompt: 'Turn the supplied research findings into an executive brief without adding unsupported facts.',
    evaluationNotes: ['structure', 'clarity', 'brand fit', 'factuality'],
  },
] as const;

export type TasteExperimentReceipt = {
  schema: typeof TASTE_EXPERIMENT_RECEIPT_SCHEMA;
  experimentId: string;
  caseId: string;
  surface: TasteSurface;
  arm: TasteExperimentArm;
  brandRevision: string;
  tasteReceipt?: TasteApplicationReceipt;
  performanceEvidenceRevision?: string;
  createdAt: string;
};

export type TasteExperimentCandidate = {
  candidateId: string;
  artifactId: string;
  artifactUrl?: string;
  receipt: TasteExperimentReceipt;
};

export type TasteMeasuredPerformance = {
  kind: 'measured';
  metric: string;
  value: number;
  unit?: string;
  evidenceRevision: string;
  source: string;
  windowStart: string;
  windowEnd: string;
};

export type TasteHumanRubric = {
  briefCompliance: number;
  brandCompliance: number;
  accessibilityPolicy: number;
  tasteAlignment: number;
};

export type TasteExperimentEvaluation = {
  candidateId: string;
  rubric: TasteHumanRubric;
  objectivePerformance?: TasteMeasuredPerformance;
};

export type TasteBlindCandidate = {
  presentationId: 'A' | 'B';
  /**
   * Supply an opaque/staged URL when possible. Raw artifact IDs stay only in
   * the hidden mapping so they cannot encode the experiment arm for reviewers.
   */
  artifactUrl?: string;
};

export type TasteBlindPairwisePacket = {
  schema: typeof TASTE_PAIRWISE_SCHEMA;
  pairId: string;
  experimentId: string;
  caseId: string;
  surface: TasteSurface;
  candidates: [TasteBlindCandidate, TasteBlindCandidate];
};

export type TasteBlindPairwiseMapping = {
  pairId: string;
  A: TasteExperimentCandidate;
  B: TasteExperimentCandidate;
};

export type TasteBlindPairwiseBundle = {
  packet: TasteBlindPairwisePacket;
  mapping: TasteBlindPairwiseMapping;
};

export type TastePairwiseSelection = 'A' | 'B' | 'tie';

export type TastePairwiseObservation = {
  pairId: string;
  experimentId: string;
  caseId: string;
  surface: TasteSurface;
  tasteOutcome: 'win' | 'loss' | 'tie';
  performanceContext: 'without_performance' | 'with_performance';
};

export type TasteObservedEffect =
  | 'observed_help'
  | 'observed_hurt'
  | 'observed_neutral'
  | 'insufficient';

export type TasteExperimentSummary = {
  schema: typeof TASTE_EXPERIMENT_SCHEMA;
  comparisons: number;
  wins: number;
  losses: number;
  ties: number;
  effect: TasteObservedEffect;
  note: string;
};

function cleanString(value: unknown, field: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const clean = value.trim();
  if (clean.length > max) throw new Error(`${field} must be ${max} characters or less`);
  return clean;
}

function isExperimentArm(value: unknown): value is TasteExperimentArm {
  return typeof value === 'string' && (TASTE_EXPERIMENT_ARMS as readonly string[]).includes(value);
}

function armUsesTaste(arm: TasteExperimentArm): boolean {
  return arm === 'brand_taste' || arm === 'brand_taste_performance';
}

function armUsesPerformance(arm: TasteExperimentArm): boolean {
  return arm === 'brand_performance' || arm === 'brand_taste_performance';
}

function stableId(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 20);
}

function assertTasteReceipt(receipt: TasteApplicationReceipt, surface: TasteSurface): void {
  if (
    !receipt ||
    receipt.schema !== 'taste.application-receipt.v1' ||
    receipt.applicationSchema !== 'taste.application.v1'
  ) {
    throw new Error('Taste arm requires a valid Taste application receipt');
  }
  if (receipt.surface !== surface) {
    throw new Error('Taste receipt surface must match the experiment surface');
  }
  if (!receipt.active || receipt.intensity === 'off') {
    throw new Error('Taste arm requires an active Taste application');
  }
}

export function createTasteExperimentReceipt(input: {
  experimentId: unknown;
  caseId: unknown;
  surface: TasteSurface;
  arm: unknown;
  brandRevision: unknown;
  tasteReceipt?: TasteApplicationReceipt;
  performanceEvidenceRevision?: unknown;
  createdAt?: string;
}): TasteExperimentReceipt {
  const experimentId = cleanString(input.experimentId, 'experimentId', 100);
  const caseId = cleanString(input.caseId, 'caseId', 100);
  const brandRevision = cleanString(input.brandRevision, 'brandRevision', 200);
  if (!(TASTE_SURFACES as readonly string[]).includes(input.surface)) {
    throw new Error('unsupported Taste experiment surface');
  }
  if (!isExperimentArm(input.arm)) throw new Error('unsupported Taste experiment arm');
  const arm = input.arm;
  const usesTaste = armUsesTaste(arm);
  const usesPerformance = armUsesPerformance(arm);

  if (usesTaste) {
    if (!input.tasteReceipt) throw new Error('Taste arm requires tasteReceipt');
    assertTasteReceipt(input.tasteReceipt, input.surface);
  } else if (input.tasteReceipt) {
    throw new Error('Non-Taste arm must not include tasteReceipt');
  }

  const performanceEvidenceRevision = input.performanceEvidenceRevision === undefined
    ? undefined
    : cleanString(input.performanceEvidenceRevision, 'performanceEvidenceRevision', 200);
  if (usesPerformance && !performanceEvidenceRevision) {
    throw new Error('Performance arm requires performanceEvidenceRevision');
  }
  if (!usesPerformance && performanceEvidenceRevision) {
    throw new Error('Non-performance arm must not include performance evidence');
  }

  return {
    schema: TASTE_EXPERIMENT_RECEIPT_SCHEMA,
    experimentId,
    caseId,
    surface: input.surface,
    arm,
    brandRevision,
    ...(input.tasteReceipt ? { tasteReceipt: JSON.parse(JSON.stringify(input.tasteReceipt)) } : {}),
    ...(performanceEvidenceRevision ? { performanceEvidenceRevision } : {}),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function createMeasuredPerformance(input: {
  metric: unknown;
  value: unknown;
  unit?: unknown;
  evidenceRevision: unknown;
  source: unknown;
  windowStart: unknown;
  windowEnd: unknown;
}): TasteMeasuredPerformance {
  const metric = cleanString(input.metric, 'metric', 100);
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    throw new Error('measured performance value must be a finite number');
  }
  const evidenceRevision = cleanString(input.evidenceRevision, 'evidenceRevision', 200);
  const source = cleanString(input.source, 'source', 200);
  const windowStart = cleanString(input.windowStart, 'windowStart', 100);
  const windowEnd = cleanString(input.windowEnd, 'windowEnd', 100);
  if (!Number.isFinite(Date.parse(windowStart)) || !Number.isFinite(Date.parse(windowEnd))) {
    throw new Error('measured performance window must use valid timestamps');
  }
  if (Date.parse(windowEnd) < Date.parse(windowStart)) {
    throw new Error('measured performance windowEnd must not precede windowStart');
  }
  const unit = input.unit === undefined ? undefined : cleanString(input.unit, 'unit', 40);

  return {
    kind: 'measured',
    metric,
    value: input.value,
    ...(unit ? { unit } : {}),
    evidenceRevision,
    source,
    windowStart,
    windowEnd,
  };
}

export function createTasteExperimentEvaluation(input: {
  candidateId: unknown;
  rubric: TasteHumanRubric;
  objectivePerformance?: TasteMeasuredPerformance;
}): TasteExperimentEvaluation {
  const candidateId = cleanString(input.candidateId, 'candidateId', 100);
  const rubricEntries = Object.entries(input.rubric || {}) as Array<[keyof TasteHumanRubric, unknown]>;
  const expected: Array<keyof TasteHumanRubric> = [
    'briefCompliance',
    'brandCompliance',
    'accessibilityPolicy',
    'tasteAlignment',
  ];
  if (rubricEntries.length !== expected.length) throw new Error('human rubric must contain exactly four dimensions');
  for (const key of expected) {
    const value = input.rubric?.[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`${key} must be an integer from 1 to 5`);
    }
  }
  if (input.objectivePerformance && input.objectivePerformance.kind !== 'measured') {
    throw new Error('objective performance must be measured evidence');
  }
  const objectivePerformance = input.objectivePerformance
    ? createMeasuredPerformance(input.objectivePerformance)
    : undefined;
  return {
    candidateId,
    rubric: { ...input.rubric },
    ...(objectivePerformance ? { objectivePerformance } : {}),
  };
}

function matchedTastePair(
  a: TasteExperimentCandidate,
  b: TasteExperimentCandidate
): boolean {
  const ar = a.receipt;
  const br = b.receipt;
  if (
    ar.experimentId !== br.experimentId ||
    ar.caseId !== br.caseId ||
    ar.surface !== br.surface ||
    ar.brandRevision !== br.brandRevision
  ) {
    return false;
  }
  const arms = new Set<TasteExperimentArm>([ar.arm, br.arm]);
  const noPerf = arms.has('brand_only') && arms.has('brand_taste') && arms.size === 2;
  const withPerf =
    arms.has('brand_performance') &&
    arms.has('brand_taste_performance') &&
    arms.size === 2;
  if (!noPerf && !withPerf) return false;
  if (withPerf && ar.performanceEvidenceRevision !== br.performanceEvidenceRevision) return false;
  return true;
}

export function buildBlindTastePairwise(
  first: TasteExperimentCandidate,
  second: TasteExperimentCandidate
): TasteBlindPairwiseBundle {
  if (!matchedTastePair(first, second)) {
    throw new Error('pairwise Taste eval requires matched candidates differing only by Taste');
  }
  const pairId = `taste-pair:${stableId([
    first.receipt.experimentId,
    first.receipt.caseId,
    ...[first.candidateId, second.candidateId].sort(),
  ])}`;

  // Stable pseudorandom presentation prevents caller argument order from becoming
  // evaluator-visible arm order while keeping reruns reproducible.
  const orderKey = stableId([pairId, first.candidateId, second.candidateId]);
  const ordered = parseInt(orderKey.slice(0, 2), 16) % 2 === 0
    ? [first, second]
    : [second, first];

  const A = ordered[0];
  const B = ordered[1];
  return {
    packet: {
      schema: TASTE_PAIRWISE_SCHEMA,
      pairId,
      experimentId: first.receipt.experimentId,
      caseId: first.receipt.caseId,
      surface: first.receipt.surface,
      candidates: [
        {
          presentationId: 'A',
          ...(A.artifactUrl ? { artifactUrl: A.artifactUrl } : {}),
        },
        {
          presentationId: 'B',
          ...(B.artifactUrl ? { artifactUrl: B.artifactUrl } : {}),
        },
      ],
    },
    mapping: { pairId, A, B },
  };
}

export function scoreBlindTastePairwise(
  bundle: TasteBlindPairwiseBundle,
  selection: TastePairwiseSelection
): TastePairwiseObservation {
  const { A, B } = bundle.mapping;
  const aTaste = armUsesTaste(A.receipt.arm);
  const bTaste = armUsesTaste(B.receipt.arm);
  if (aTaste === bTaste) {
    throw new Error('pairwise mapping must contain exactly one Taste arm');
  }

  let tasteOutcome: TastePairwiseObservation['tasteOutcome'] = 'tie';
  if (selection !== 'tie') {
    const selectedTaste = selection === 'A' ? aTaste : bTaste;
    tasteOutcome = selectedTaste ? 'win' : 'loss';
  }

  return {
    pairId: bundle.packet.pairId,
    experimentId: bundle.packet.experimentId,
    caseId: bundle.packet.caseId,
    surface: bundle.packet.surface,
    tasteOutcome,
    performanceContext: armUsesPerformance(A.receipt.arm)
      ? 'with_performance'
      : 'without_performance',
  };
}

export function summarizeTastePairwise(
  observations: TastePairwiseObservation[],
  minComparisons = 3
): TasteExperimentSummary {
  const comparisons = observations.length;
  const wins = observations.filter((item) => item.tasteOutcome === 'win').length;
  const losses = observations.filter((item) => item.tasteOutcome === 'loss').length;
  const ties = observations.filter((item) => item.tasteOutcome === 'tie').length;

  let effect: TasteObservedEffect = 'insufficient';
  if (comparisons >= minComparisons) {
    if (wins > losses) effect = 'observed_help';
    else if (losses > wins) effect = 'observed_hurt';
    else effect = 'observed_neutral';
  }

  return {
    schema: TASTE_EXPERIMENT_SCHEMA,
    comparisons,
    wins,
    losses,
    ties,
    effect,
    note: effect === 'insufficient'
      ? `Need at least ${minComparisons} blinded comparisons before describing an observed direction.`
      : 'Observed direction only; no statistical-significance or causal claim is implied.',
  };
}

export const _tasteExperimentInternalsForTests = {
  armUsesTaste,
  armUsesPerformance,
  matchedTastePair,
  stableId,
};
