/**
 * Golden-set case schema (ENG-2135, ENG-2128 principle 2 and decision D2).
 *
 * A golden case is a pointer to real production data plus binary human labels:
 * `sourceRef` names the session, human-eval candidate or user; the content itself is fetched at
 * run time from the source table and is never stored in the case or in git. Cases and labels
 * live in a private store (goldenSetStore.ts), not in this repo.
 *
 * A pairwise creative case (ENG-2142) points at two human-eval candidates and carries one
 * A / B / tie label instead of the binary criteria; see `CreativePairRef`.
 *
 * Pure: no IO. The store, the seed builder, the labelling route and the validation runner all
 * validate through `parseGoldenCase` / `parseLabelUpdate`.
 */

import { createHash } from 'crypto';
import type { PairwiseChoice } from './agreement';
import type { EvalSurface } from './evalRegistry';

export const GOLDEN_CASE_SCHEMA_VERSION = 1;

/** Per-surface binary criteria. Agent: ENG-2128 surface A; the last three (ENG-2189) are
 * behaviours, where `pass` means the behaviour happened, as the shadow judge's true. Creative: the
 * ENG-421 launch-ready floor. Account: the ENG-2133 truth states — `pass` means the state applies
 * to the account. */
export const GOLDEN_CRITERIA = {
  agent: [
    'task_success',
    'tool_correctness',
    'groundedness',
    'instruction_compliance',
    'argued_with_instruction',
    'escalated_when_not_required',
    'failed_to_escalate',
  ],
  creative: ['hook', 'offer', 'proof_integrity', 'brand_fidelity', 'format_readiness', 'policy_risk', 'buyer_usefulness'],
  account_health: ['activation_incomplete', 'at_risk', 'healthy'],
} as const satisfies Record<EvalSurface, readonly string[]>;

/** The one criterion of a pairwise creative case (ENG-2142): which of two creatives is the
 * better ad, labelled A, B or tie. Never part of a single-creative case. */
export const PAIRWISE_CRITERION = 'pairwise_preference';

export type GoldenCriterion = (typeof GOLDEN_CRITERIA)[EvalSurface][number] | typeof PAIRWISE_CRITERION;

export const LABEL_VALUES = ['pass', 'fail', 'na'] as const;
export type BinaryLabel = (typeof LABEL_VALUES)[number];
export const PAIRWISE_LABEL_VALUES = ['A', 'B', 'tie'] as const satisfies readonly PairwiseChoice[];
/** Binary labels on single cases; A / B / tie on the pairwise criterion. */
export type LabelValue = BinaryLabel | PairwiseChoice;

export type GoldenSplit = 'dev' | 'test';

export type SourceRefKind = 'sessionId' | 'candidateId' | 'userId';

/** The source each surface's cases point at. */
export const SOURCE_KIND_BY_SURFACE: Record<EvalSurface, SourceRefKind> = {
  agent: 'sessionId',
  creative: 'candidateId',
  account_health: 'userId',
};

export interface SourceRef {
  kind: SourceRefKind;
  id: string;
}

/** Links an agent case to an ENG-1312 replay fixture: the user turn at `messageIndex` and the
 * assistant turns that answer it are that fixture's real content (agentModeReplayFixtureSource.ts). */
export interface ReplayLink {
  fixtureId: string;
  messageIndex: number;
}

/** Why the calibration sampler put a pair near the front of its batch (creativeCalibration.ts). */
export type PairSignal = 'disagree' | 'uncertain' | 'unscored' | 'clear';
export const PAIR_SIGNALS: readonly PairSignal[] = ['disagree', 'uncertain', 'unscored', 'clear'];

/**
 * A pairwise creative case (ENG-2142 weekly calibration). Creative A is the case's
 * `sourceRef.id`, the newer creative; B is the prior creative of the same account it is compared
 * with, as in the rubric judge's pairwise mode. Ids and stratum names only, no content.
 */
export interface CreativePairRef {
  candidateIdB: string;
  /** The calibration batch: the ISO week it was drawn in, e.g. `2026-W39`. */
  batch: string;
  /** 0-based order within the batch, and the batch's size when it was drawn. */
  position: number;
  batchSize: number;
  /** The stratum the pair was drawn from (human-eval category and placement). */
  category: string;
  placement: string;
  signal: PairSignal;
}

/** One criterion's AI-suggested label, with the reasoning the labeller reviews it against. */
export interface DraftCriterionLabel {
  label: LabelValue;
  rationale: string;
}

/**
 * An AI-drafted suggestion for a case's labels (ENG-2200): never the ground truth itself, never
 * written to `labels`, and never counted toward `isFullyLabelled`. A human reviews and explicitly
 * applies each suggestion (or ignores it) before saving through the normal label route. Advisory
 * only — a case with a stale or malformed draft still labels normally, so a bad draft never
 * blocks a real labeller.
 */
export interface GoldenCaseDraft {
  labels: Partial<Record<GoldenCriterion, DraftCriterionLabel>>;
  /** The model that generated this draft, e.g. `claude-opus-5-5`. */
  model: string;
  generatedAt: string;
}

export interface GoldenCase {
  caseId: string;
  surface: EvalSurface;
  /** What kind of case this is, e.g. `fp_catalogue`, `admin_override`, `creative_image`, `subscription_canceled`. */
  taskType: string;
  sourceRef: SourceRef;
  criteria: GoldenCriterion[];
  /** Criteria not yet labelled are absent. */
  labels: Partial<Record<GoldenCriterion, LabelValue>>;
  notes?: string;
  labeller?: string;
  labelledAt?: string;
  split: GoldenSplit;
  /** Revision of this case; incremented by every label save (optimistic concurrency). Untouched by a draft write. */
  version: number;
  schemaVersion: number;
  /** Where the seed builder found the case, e.g. `fp_catalogue:ENG-972`. No content. */
  seedSource: string;
  createdAt: string;
  replay?: ReplayLink;
  /** Present on pairwise creative cases only; their criteria are exactly [PAIRWISE_CRITERION]. */
  pair?: CreativePairRef;
  /** An AI-drafted suggestion for this case, pending human review. Absent until generated. */
  draft?: GoldenCaseDraft;
  /** Set when an admin took the case out of the set; absent otherwise. */
  excluded?: GoldenCaseExclusion;
}

/**
 * Why a case was taken out of the set (ENG-2608), e.g. `empty_session` for a session nobody used.
 * The row stays, so the exclusion can be undone and the seeder never adds the case again; reads
 * leave it out unless they ask for excluded cases.
 */
export interface GoldenCaseExclusion {
  reason: string;
  /** The admin who excluded it. */
  by: string;
  /** ISO time it was excluded. */
  at: string;
}

export const MAX_EXCLUSION_REASON_CHARS = 200;

/** Share of cases in the test split. 0.6 so a 50-case surface can reach the registry's
 * MIN_VALIDATION_N (30) test cases; the rest are dev cases for tuning graders. */
export const TEST_SPLIT_FRACTION = 0.6;

/** Deterministic split from the case id alone: adding cases never moves an existing case. */
export function splitForCaseId(caseId: string): GoldenSplit {
  const bucket = createHash('sha256').update(caseId).digest().readUInt32BE(0) / 2 ** 32;
  return bucket < TEST_SPLIT_FRACTION ? 'test' : 'dev';
}

/** Stable case id: one case per (surface, source). */
export function buildCaseId(surface: EvalSurface, sourceRef: SourceRef): string {
  return `${surface}#${sourceRef.kind}#${sourceRef.id}`;
}

const SURFACES = Object.keys(GOLDEN_CRITERIA) as EvalSurface[];

export function isEvalSurface(value: unknown): value is EvalSurface {
  return typeof value === 'string' && (SURFACES as string[]).includes(value);
}

export function isLabelValue(value: unknown): value is BinaryLabel {
  return typeof value === 'string' && (LABEL_VALUES as readonly string[]).includes(value);
}

export function isPairwiseLabel(value: unknown): value is PairwiseChoice {
  return typeof value === 'string' && (PAIRWISE_LABEL_VALUES as readonly string[]).includes(value);
}

export function criteriaFor(surface: EvalSurface): readonly GoldenCriterion[] {
  return GOLDEN_CRITERIA[surface];
}

export class GoldenCaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenCaseValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new GoldenCaseValidationError(`${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new GoldenCaseValidationError(`${field} must be a string`);
  return value;
}

/**
 * Labels for `surface`: every key a criterion of that surface, every value pass|fail|na. For a
 * pairwise case the only key is PAIRWISE_CRITERION and its value is A|B|tie.
 */
export function parseLabels(surface: EvalSurface, value: unknown, pairwise = false): Partial<Record<GoldenCriterion, LabelValue>> {
  if (!isRecord(value)) throw new GoldenCaseValidationError('labels must be an object');
  const allowed: readonly string[] = pairwise ? [PAIRWISE_CRITERION] : criteriaFor(surface);
  const out: Partial<Record<GoldenCriterion, LabelValue>> = {};
  for (const [criterion, label] of Object.entries(value)) {
    if (!allowed.includes(criterion)) {
      const kind = pairwise ? `pairwise ${surface}` : surface;
      throw new GoldenCaseValidationError(`labels.${criterion} is not a ${kind} criterion (${allowed.join(', ')})`);
    }
    if (pairwise ? !isPairwiseLabel(label) : !isLabelValue(label)) {
      throw new GoldenCaseValidationError(`labels.${criterion} must be ${pairwise ? 'A, B or tie' : 'pass, fail or na'}`);
    }
    out[criterion as GoldenCriterion] = label as LabelValue;
  }
  return out;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new GoldenCaseValidationError(`${field} must be a non-negative integer`);
  return value as number;
}

function parsePairRef(value: unknown): CreativePairRef {
  if (!isRecord(value)) throw new GoldenCaseValidationError('pair must be an object');
  const signal = value.signal;
  if (typeof signal !== 'string' || !(PAIR_SIGNALS as readonly string[]).includes(signal)) {
    throw new GoldenCaseValidationError(`pair.signal must be one of ${PAIR_SIGNALS.join(', ')}`);
  }
  return {
    candidateIdB: nonEmptyString(value.candidateIdB, 'pair.candidateIdB'),
    batch: nonEmptyString(value.batch, 'pair.batch'),
    position: nonNegativeInteger(value.position, 'pair.position'),
    batchSize: nonNegativeInteger(value.batchSize, 'pair.batchSize'),
    category: nonEmptyString(value.category, 'pair.category'),
    placement: nonEmptyString(value.placement, 'pair.placement'),
    signal: signal as PairSignal,
  };
}

/**
 * Parses a stored `draft`. Strict — every failure throws GoldenCaseValidationError naming the
 * bad field — because the one caller that must not silently swallow a bad shape is the writer
 * (generateGoldenDraftLabels.ts): a bug there should fail loudly, not save a malformed suggestion.
 */
export function parseDraft(surface: EvalSurface, criteria: readonly GoldenCriterion[], value: unknown): GoldenCaseDraft {
  if (!isRecord(value)) throw new GoldenCaseValidationError('draft must be an object');
  if (!isRecord(value.labels)) throw new GoldenCaseValidationError('draft.labels must be an object');
  const labels: Partial<Record<GoldenCriterion, DraftCriterionLabel>> = {};
  for (const [criterion, entry] of Object.entries(value.labels)) {
    if (!criteria.includes(criterion as GoldenCriterion)) {
      throw new GoldenCaseValidationError(`draft.labels.${criterion} is not one of this case's criteria (${criteria.join(', ')})`);
    }
    if (!isRecord(entry)) throw new GoldenCaseValidationError(`draft.labels.${criterion} must be an object`);
    const pairwise = criteria.length === 1 && criteria[0] === PAIRWISE_CRITERION;
    if (pairwise ? !isPairwiseLabel(entry.label) : !isLabelValue(entry.label)) {
      throw new GoldenCaseValidationError(`draft.labels.${criterion}.label must be ${pairwise ? 'A, B or tie' : 'pass, fail or na'}`);
    }
    labels[criterion as GoldenCriterion] = {
      label: entry.label as LabelValue,
      rationale: nonEmptyString(entry.rationale, `draft.labels.${criterion}.rationale`),
    };
  }
  return {
    labels,
    model: nonEmptyString(value.model, 'draft.model'),
    generatedAt: nonEmptyString(value.generatedAt, 'draft.generatedAt'),
  };
}

/**
 * Parses a stored `draft` for display, tolerant of a stale/malformed shape (e.g. a criterion
 * removed from GOLDEN_CRITERIA since the draft was written): logs and drops it rather than
 * failing the whole case, since a bad draft must never block real labelling.
 */
function parseDraftOrDrop(surface: EvalSurface, criteria: readonly GoldenCriterion[], caseId: string, value: unknown): GoldenCaseDraft | undefined {
  if (value === undefined) return undefined;
  try {
    return parseDraft(surface, criteria, value);
  } catch (error) {
    console.warn(`[goldenSet] dropping invalid draft on case ${caseId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Validates a stored or seeded case. Throws GoldenCaseValidationError naming the first bad field. */
export function parseGoldenCase(value: unknown): GoldenCase {
  if (!isRecord(value)) throw new GoldenCaseValidationError('case must be an object');
  const caseId = nonEmptyString(value.caseId, 'caseId');
  if (!isEvalSurface(value.surface)) throw new GoldenCaseValidationError(`surface must be one of ${SURFACES.join(', ')}`);
  const surface = value.surface;
  const taskType = nonEmptyString(value.taskType, 'taskType');

  if (!isRecord(value.sourceRef)) throw new GoldenCaseValidationError('sourceRef must be an object');
  const kind = value.sourceRef.kind;
  if (kind !== SOURCE_KIND_BY_SURFACE[surface]) {
    throw new GoldenCaseValidationError(`sourceRef.kind must be ${SOURCE_KIND_BY_SURFACE[surface]} for ${surface}`);
  }
  const sourceRef: SourceRef = { kind: SOURCE_KIND_BY_SURFACE[surface], id: nonEmptyString(value.sourceRef.id, 'sourceRef.id') };

  let pair: CreativePairRef | undefined;
  if (value.pair !== undefined) {
    if (surface !== 'creative') throw new GoldenCaseValidationError('pair is only valid on creative cases');
    pair = parsePairRef(value.pair);
    if (pair.candidateIdB === sourceRef.id) throw new GoldenCaseValidationError('pair.candidateIdB must differ from sourceRef.id');
  }

  const allowed: readonly string[] = pair ? [PAIRWISE_CRITERION] : criteriaFor(surface);
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    throw new GoldenCaseValidationError('criteria must be a non-empty array');
  }
  for (const c of value.criteria) {
    if (typeof c !== 'string' || !allowed.includes(c)) {
      throw new GoldenCaseValidationError(`criteria contains ${String(c)}, not a ${pair ? 'pairwise ' : ''}${surface} criterion`);
    }
  }
  const criteria = value.criteria as GoldenCriterion[];
  const labels = parseLabels(surface, value.labels ?? {}, pair !== undefined);
  for (const c of Object.keys(labels)) {
    if (!(criteria as string[]).includes(c)) throw new GoldenCaseValidationError(`labels.${c} is not in this case's criteria`);
  }

  if (value.split !== 'dev' && value.split !== 'test') throw new GoldenCaseValidationError('split must be dev or test');
  if (!Number.isInteger(value.version) || (value.version as number) < 0) {
    throw new GoldenCaseValidationError('version must be a non-negative integer');
  }
  if (!Number.isInteger(value.schemaVersion)) throw new GoldenCaseValidationError('schemaVersion must be an integer');

  let replay: ReplayLink | undefined;
  if (value.replay !== undefined) {
    if (surface !== 'agent' || !isRecord(value.replay)) throw new GoldenCaseValidationError('replay is only valid on agent cases');
    const messageIndex = value.replay.messageIndex;
    if (!Number.isInteger(messageIndex) || (messageIndex as number) < 0) {
      throw new GoldenCaseValidationError('replay.messageIndex must be a non-negative integer');
    }
    replay = { fixtureId: nonEmptyString(value.replay.fixtureId, 'replay.fixtureId'), messageIndex: messageIndex as number };
  }

  let excluded: GoldenCaseExclusion | undefined;
  if (value.excluded !== undefined) {
    if (!isRecord(value.excluded)) throw new GoldenCaseValidationError('excluded must be an object');
    excluded = {
      reason: nonEmptyString(value.excluded.reason, 'excluded.reason'),
      by: nonEmptyString(value.excluded.by, 'excluded.by'),
      at: nonEmptyString(value.excluded.at, 'excluded.at'),
    };
  }

  const notes = optionalString(value.notes, 'notes');
  const labeller = optionalString(value.labeller, 'labeller');
  const labelledAt = optionalString(value.labelledAt, 'labelledAt');
  const draft = parseDraftOrDrop(surface, criteria, caseId, value.draft);
  return {
    caseId,
    surface,
    taskType,
    sourceRef,
    criteria,
    labels,
    ...(notes !== undefined ? { notes } : {}),
    ...(labeller !== undefined ? { labeller } : {}),
    ...(labelledAt !== undefined ? { labelledAt } : {}),
    split: value.split,
    version: value.version as number,
    schemaVersion: value.schemaVersion as number,
    seedSource: nonEmptyString(value.seedSource, 'seedSource'),
    createdAt: nonEmptyString(value.createdAt, 'createdAt'),
    ...(replay ? { replay } : {}),
    ...(pair ? { pair } : {}),
    ...(draft ? { draft } : {}),
    ...(excluded ? { excluded } : {}),
  };
}

/** The reason in an exclusion request body: a non-empty string of at most MAX_EXCLUSION_REASON_CHARS. */
export function parseExclusionReason(body: unknown): string {
  const reason = isRecord(body) && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw new GoldenCaseValidationError('reason must be a non-empty string');
  if (reason.length > MAX_EXCLUSION_REASON_CHARS) throw new GoldenCaseValidationError(`reason must be at most ${MAX_EXCLUSION_REASON_CHARS} characters`);
  return reason;
}

export const MAX_NOTE_CHARS = 2000;

/**
 * A label an AI wrote, with the owner's permission, starts its note with this (ENG-2135, 2026-10-14). The store
 * records the saving admin as the labeller, so the note is the only marker. Agreement measured on such a label is
 * not human agreement, so validation and the creative calibration report leave these cases out unless asked.
 */
export const AI_LABEL_NOTE_PREFIX = '[AI-LABEL]';

export function isAiLabelled(c: Pick<GoldenCase, 'notes'>): boolean {
  return typeof c.notes === 'string' && c.notes.startsWith(AI_LABEL_NOTE_PREFIX);
}

export interface LabelUpdate {
  labels: Partial<Record<GoldenCriterion, LabelValue>>;
  notes?: string;
  /** The case version the labeller saw; the save is rejected if the case changed since. */
  expectedVersion: number;
}

/** Validates a label save request body against the case's surface (and kind, for a pairwise case). */
export function parseLabelUpdate(surface: EvalSurface, body: unknown, pairwise = false): LabelUpdate {
  if (!isRecord(body)) throw new GoldenCaseValidationError('body must be an object');
  const labels = parseLabels(surface, body.labels, pairwise);
  const notes = optionalString(body.notes, 'notes');
  if (notes !== undefined && notes.length > MAX_NOTE_CHARS) {
    throw new GoldenCaseValidationError(`notes must be at most ${MAX_NOTE_CHARS} characters`);
  }
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
    throw new GoldenCaseValidationError('expectedVersion must be a non-negative integer');
  }
  return { labels, ...(notes !== undefined ? { notes } : {}), expectedVersion: body.expectedVersion as number };
}

/** A new, unlabelled case for the seed builder. */
export function newGoldenCase(input: {
  surface: EvalSurface;
  taskType: string;
  sourceId: string;
  seedSource: string;
  now: Date;
  replay?: ReplayLink;
}): GoldenCase {
  const sourceRef: SourceRef = { kind: SOURCE_KIND_BY_SURFACE[input.surface], id: input.sourceId };
  const caseId = buildCaseId(input.surface, sourceRef);
  return {
    caseId,
    surface: input.surface,
    taskType: input.taskType,
    sourceRef,
    criteria: [...criteriaFor(input.surface)],
    labels: {},
    split: splitForCaseId(caseId),
    version: 0,
    schemaVersion: GOLDEN_CASE_SCHEMA_VERSION,
    seedSource: input.seedSource,
    createdAt: input.now.toISOString(),
    ...(input.replay ? { replay: input.replay } : {}),
  };
}

/** Stable id of a pairwise case: one case per ordered (A, B) pair, whichever week drew it. */
export function buildPairCaseId(candidateIdA: string, candidateIdB: string): string {
  return `creative#candidatePair#${candidateIdA}#${candidateIdB}`;
}

/** A new, unlabelled pairwise creative case (ENG-2142). */
export function newCreativePairCase(input: {
  candidateIdA: string;
  pair: CreativePairRef;
  now: Date;
}): GoldenCase {
  const caseId = buildPairCaseId(input.candidateIdA, input.pair.candidateIdB);
  return {
    caseId,
    surface: 'creative',
    taskType: 'creative_pairwise',
    sourceRef: { kind: SOURCE_KIND_BY_SURFACE.creative, id: input.candidateIdA },
    criteria: [PAIRWISE_CRITERION],
    labels: {},
    split: splitForCaseId(caseId),
    version: 0,
    schemaVersion: GOLDEN_CASE_SCHEMA_VERSION,
    seedSource: `weekly_calibration:${input.pair.batch}`,
    createdAt: input.now.toISOString(),
    pair: input.pair,
  };
}

/** True once every criterion of the case carries a label. */
export function isFullyLabelled(c: GoldenCase): boolean {
  return c.criteria.every((criterion) => c.labels[criterion] !== undefined);
}
