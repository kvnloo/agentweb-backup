/**
 * Golden-set case schema (ENG-2135, ENG-2128 principle 2 and decision D2).
 *
 * A golden case is a pointer to real production data plus binary human labels:
 * `sourceRef` names the session, human-eval candidate or user; the content itself is fetched at
 * run time from the source table and is never stored in the case or in git. Cases and labels
 * live in a private store (goldenSetStore.ts), not in this repo.
 *
 * Pure: no IO. The store, the seed builder, the labelling route and the validation runner all
 * validate through `parseGoldenCase` / `parseLabelUpdate`.
 */

import { createHash } from 'crypto';
import type { EvalSurface } from './evalRegistry';

export const GOLDEN_CASE_SCHEMA_VERSION = 1;

/** Per-surface binary criteria. Agent: ENG-2128 surface A. Creative: the ENG-421 launch-ready
 * floor. Account: the ENG-2133 truth states — `pass` means the state applies to the account. */
export const GOLDEN_CRITERIA = {
  agent: ['task_success', 'tool_correctness', 'groundedness', 'instruction_compliance'],
  creative: ['hook', 'offer', 'proof_integrity', 'brand_fidelity', 'format_readiness', 'policy_risk', 'buyer_usefulness'],
  account_health: ['activation_incomplete', 'at_risk', 'healthy'],
} as const satisfies Record<EvalSurface, readonly string[]>;

export type GoldenCriterion = (typeof GOLDEN_CRITERIA)[EvalSurface][number];

export const LABEL_VALUES = ['pass', 'fail', 'na'] as const;
export type LabelValue = (typeof LABEL_VALUES)[number];

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
  /** Revision of this case; incremented by every label save (optimistic concurrency). */
  version: number;
  schemaVersion: number;
  /** Where the seed builder found the case, e.g. `fp_catalogue:ENG-972`. No content. */
  seedSource: string;
  createdAt: string;
  replay?: ReplayLink;
}

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

export function isLabelValue(value: unknown): value is LabelValue {
  return typeof value === 'string' && (LABEL_VALUES as readonly string[]).includes(value);
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

/** Labels for `surface`: every key a criterion of that surface, every value pass|fail|na. */
export function parseLabels(surface: EvalSurface, value: unknown): Partial<Record<GoldenCriterion, LabelValue>> {
  if (!isRecord(value)) throw new GoldenCaseValidationError('labels must be an object');
  const allowed = criteriaFor(surface) as readonly string[];
  const out: Partial<Record<GoldenCriterion, LabelValue>> = {};
  for (const [criterion, label] of Object.entries(value)) {
    if (!allowed.includes(criterion)) {
      throw new GoldenCaseValidationError(`labels.${criterion} is not a ${surface} criterion (${allowed.join(', ')})`);
    }
    if (!isLabelValue(label)) throw new GoldenCaseValidationError(`labels.${criterion} must be pass, fail or na`);
    out[criterion as GoldenCriterion] = label;
  }
  return out;
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

  const allowed = criteriaFor(surface) as readonly string[];
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    throw new GoldenCaseValidationError('criteria must be a non-empty array');
  }
  for (const c of value.criteria) {
    if (typeof c !== 'string' || !allowed.includes(c)) {
      throw new GoldenCaseValidationError(`criteria contains ${String(c)}, not a ${surface} criterion`);
    }
  }
  const criteria = value.criteria as GoldenCriterion[];
  const labels = parseLabels(surface, value.labels ?? {});
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

  const notes = optionalString(value.notes, 'notes');
  const labeller = optionalString(value.labeller, 'labeller');
  const labelledAt = optionalString(value.labelledAt, 'labelledAt');
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
  };
}

export const MAX_NOTE_CHARS = 2000;

export interface LabelUpdate {
  labels: Partial<Record<GoldenCriterion, LabelValue>>;
  notes?: string;
  /** The case version the labeller saw; the save is rejected if the case changed since. */
  expectedVersion: number;
}

/** Validates a label save request body against the case's surface. */
export function parseLabelUpdate(surface: EvalSurface, body: unknown): LabelUpdate {
  if (!isRecord(body)) throw new GoldenCaseValidationError('body must be an object');
  const labels = parseLabels(surface, body.labels);
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

/** True once every criterion of the case carries a label. */
export function isFullyLabelled(c: GoldenCase): boolean {
  return c.criteria.every((criterion) => c.labels[criterion] !== undefined);
}
