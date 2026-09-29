/**
 * Online eval sampler: creative and account-health snapshots (ENG-2196, ENG-2128 slice 6).
 *
 * The daily sampler (cron/evalV2SamplerCron.ts) grades agent sessions. This file adds the other two
 * ENG-2128 surfaces, computed from grader output that is already stored — nothing is re-graded
 * and no model is called:
 *  - creative: the ENG-2139 deterministic gates and the ENG-2140 rubric judge, both stored on
 *    AW-HumanEvalQueue candidates (`creativeGates`, `creativeRubric`). Gate pass rate, which checks
 *    fail, and the distribution of rubric criteria passed (0-7).
 *  - account health: the ENG-2143 classifier's current state per paying account, stored in
 *    AW-AccountCapabilityRequirements (capability `account_health_signal`). State distribution and
 *    flip rate.
 *
 * Pure: rows in, snapshot out. The cron does the (bounded) reads and the writes. Every metric
 * carries its registry `mayGate`, which is false for all of them today, so none may alert or gate.
 */

import type { DynamoAttributeMap } from '../core/ports';
import type { CreativeGateResult } from '../../services/creativeGates';
import type { CreativeRubricResult } from '../../services/creativeRubricJudge';
import type { AccountHealthState } from '../../services/accountHealthClassifier';
import { wilsonInterval, type Interval } from './agreement';
import { mayGate } from './evalRegistry';
import { EVAL_V2_DAILY_LOOP_ID, EVAL_V2_WINDOWS, shiftDate, type EvalV2WindowLabel } from './evalV2Sampler';

export const EVT_EVAL_V2_CREATIVE_SNAPSHOT = 'eval_v2_creative_snapshot';
export const EVT_EVAL_V2_ACCOUNT_HEALTH_SNAPSHOT = 'eval_v2_account_health_snapshot';

export const CREATIVE_GATES_GRADER = 'creative-deterministic-gates';
export const CREATIVE_RUBRIC_GRADER = 'creative-rubric-judge';
export const ACCOUNT_HEALTH_GRADER = 'account-health-classifier';
/** ENG-421's floor has 7 criteria (creativeRubricJudgePrompt.ts RUBRIC_CRITERIA). */
export const RUBRIC_CRITERIA_COUNT = 7;

export type EvalV2Surface = 'creative' | 'account_health';

/**
 * `ok`: every row was read. `truncated`: the bounded read stopped before the end, so nothing is
 * reported (a partial rate is a wrong rate). `unavailable`: the read failed.
 */
export type SurfaceReadStatus = 'ok' | 'truncated' | 'unavailable';

interface SurfaceSnapshotBase {
  date: string;
  windowLabel: EvalV2WindowLabel;
  windowStartDate: string;
  windowEndDate: string;
  status: SurfaceReadStatus;
  statusReason?: string;
  computedAt: string;
}

export interface RateWithCI {
  n: number;
  passes: number;
  rate: number | null;
  ci: Interval | null;
}

export interface CreativeSnapshot extends SurfaceSnapshotBase {
  surface: 'creative';
  /** Candidates created in the window that carry a gate or rubric result. */
  creatives: number;
  gates: RateWithCI & {
    graderId: string;
    versions: string[];
    /** Creatives in which each check failed. */
    failedChecks: Record<string, number>;
    mayGate: boolean;
  };
  rubric: {
    graderId: string;
    versions: string[];
    judged: number;
    errors: number;
    skipped: number;
    /** Index k: judged creatives that passed exactly k of the 7 criteria. */
    passedCountDistribution: number[];
    /** All 7 criteria passed (ENG-421 launch-ready floor), over judged creatives. */
    floorMet: RateWithCI;
    mayGate: boolean;
  };
}

export interface AccountHealthSnapshot extends SurfaceSnapshotBase {
  surface: 'account_health';
  graderId: string;
  /** Accounts with a stored classifier state. */
  accounts: number;
  byState: Record<AccountHealthState | 'other', number>;
  /**
   * Accounts that entered their current state inside the window after an earlier classification
   * (row version > 1 and stateSince in the window), over all classified accounts.
   */
  flips: RateWithCI;
  mayGate: boolean;
}

export type SurfaceSnapshot = CreativeSnapshot | AccountHealthSnapshot;

function rate(passes: number, n: number): RateWithCI {
  return { n, passes, rate: n > 0 ? passes / n : null, ci: n > 0 ? wilsonInterval(passes, n) : null };
}

function windowOf(date: string, windowLabel: EvalV2WindowLabel): { windowStartDate: string; windowEndDate: string } {
  return { windowStartDate: shiftDate(date, 1 - EVAL_V2_WINDOWS[windowLabel]), windowEndDate: date };
}

const inWindow = (iso: unknown, w: { windowStartDate: string; windowEndDate: string }): boolean => {
  if (typeof iso !== 'string' || iso.length < 10) return false;
  const day = iso.slice(0, 10);
  return day >= w.windowStartDate && day <= w.windowEndDate;
};

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export interface SurfaceSnapshotOptions {
  date: string;
  windowLabel: EvalV2WindowLabel;
  now: Date;
  status?: SurfaceReadStatus;
  statusReason?: string;
  gate?: (graderId: string) => boolean;
}

/** AW-HumanEvalQueue candidates (createdAt, creativeGates, creativeRubric) → the creative snapshot. */
export function aggregateCreative(items: readonly Record<string, unknown>[], opts: SurfaceSnapshotOptions): CreativeSnapshot {
  const gate = opts.gate ?? mayGate;
  const w = windowOf(opts.date, opts.windowLabel);
  const status = opts.status ?? 'ok';
  const rows = status === 'ok' ? items.filter((i) => inWindow(i.createdAt, w) && (obj(i.creativeGates) || obj(i.creativeRubric))) : [];

  let gateN = 0;
  let gatePasses = 0;
  const gateVersions = new Set<string>();
  const failedChecks: Record<string, number> = {};
  let judged = 0;
  let errors = 0;
  let skipped = 0;
  let floorMet = 0;
  const distribution = new Array<number>(RUBRIC_CRITERIA_COUNT + 1).fill(0);
  const rubricVersions = new Set<string>();

  for (const row of rows) {
    const gates = obj(row.creativeGates) as Partial<CreativeGateResult> | undefined;
    if (gates && typeof gates.passed === 'boolean') {
      gateN++;
      if (gates.passed) gatePasses++;
      if (typeof gates.version === 'string') gateVersions.add(gates.version);
      for (const check of Array.isArray(gates.checks) ? gates.checks : []) {
        if (check && check.status === 'fail' && typeof check.id === 'string') failedChecks[check.id] = (failedChecks[check.id] ?? 0) + 1;
      }
    }
    const rubric = obj(row.creativeRubric) as Partial<CreativeRubricResult> | undefined;
    if (!rubric) continue;
    if (typeof rubric.version === 'string') rubricVersions.add(rubric.version);
    if (rubric.status === 'error') errors++;
    else if (rubric.status === 'skipped') skipped++;
    else if (rubric.status === 'ok' && 'passedCount' in rubric && typeof rubric.passedCount === 'number') {
      judged++;
      distribution[Math.max(0, Math.min(RUBRIC_CRITERIA_COUNT, Math.round(rubric.passedCount)))]++;
      if ('passed' in rubric && rubric.passed === true) floorMet++;
    }
  }

  return {
    surface: 'creative',
    date: opts.date,
    windowLabel: opts.windowLabel,
    ...w,
    status,
    ...(opts.statusReason ? { statusReason: opts.statusReason } : {}),
    creatives: rows.length,
    gates: { graderId: CREATIVE_GATES_GRADER, versions: [...gateVersions].sort(), ...rate(gatePasses, gateN), failedChecks, mayGate: gate(CREATIVE_GATES_GRADER) },
    rubric: {
      graderId: CREATIVE_RUBRIC_GRADER,
      versions: [...rubricVersions].sort(),
      judged,
      errors,
      skipped,
      passedCountDistribution: distribution,
      floorMet: rate(floorMet, judged),
      mayGate: gate(CREATIVE_RUBRIC_GRADER),
    },
    computedAt: opts.now.toISOString(),
  };
}

const ACCOUNT_STATES: readonly AccountHealthState[] = ['activation_incomplete', 'at_risk', 'healthy', 'insufficient_evidence'];

/** AW-AccountCapabilityRequirements `account_health_signal` rows (state, stateSince, version) → the account-health snapshot. */
export function aggregateAccountHealth(rows: readonly Record<string, unknown>[], opts: SurfaceSnapshotOptions): AccountHealthSnapshot {
  const gate = opts.gate ?? mayGate;
  const w = windowOf(opts.date, opts.windowLabel);
  const status = opts.status ?? 'ok';
  const accounts = status === 'ok' ? rows.filter((r) => typeof r.state === 'string') : [];
  const byState = Object.fromEntries([...ACCOUNT_STATES, 'other'].map((s) => [s, 0])) as AccountHealthSnapshot['byState'];
  let flips = 0;
  for (const row of accounts) {
    const state = ACCOUNT_STATES.includes(row.state as AccountHealthState) ? (row.state as AccountHealthState) : 'other';
    byState[state]++;
    if (typeof row.version === 'number' && row.version > 1 && inWindow(row.stateSince, w)) flips++;
  }
  return {
    surface: 'account_health',
    date: opts.date,
    windowLabel: opts.windowLabel,
    ...w,
    status,
    ...(opts.statusReason ? { statusReason: opts.statusReason } : {}),
    graderId: ACCOUNT_HEALTH_GRADER,
    accounts: accounts.length,
    byState,
    flips: rate(flips, accounts.length),
    mayGate: gate(ACCOUNT_HEALTH_GRADER),
    computedAt: opts.now.toISOString(),
  };
}

const EVENT_OF: Record<EvalV2Surface, string> = {
  creative: EVT_EVAL_V2_CREATIVE_SNAPSHOT,
  account_health: EVT_EVAL_V2_ACCOUNT_HEALTH_SNAPSHOT,
};

/** `<date>#<window>#<surface>`: beside the agent snapshot's `<date>#<window>`, never colliding with it. */
export function surfaceSnapshotSortKey(date: string, windowLabel: EvalV2WindowLabel, surface: EvalV2Surface): string {
  return `${date}#${windowLabel}#${surface}`;
}

export function buildSurfaceSnapshotItem(snap: SurfaceSnapshot): DynamoAttributeMap {
  return {
    loopId: EVAL_V2_DAILY_LOOP_ID,
    tsSession: surfaceSnapshotSortKey(snap.date, snap.windowLabel, snap.surface),
    eventType: EVENT_OF[snap.surface],
    subjectId: snap.date,
    ts: snap.computedAt,
    date: snap.date,
    windowLabel: snap.windowLabel,
    snapshot: snap as unknown as DynamoAttributeMap,
  };
}

export function parseSurfaceSnapshotItem(item: Record<string, unknown>): SurfaceSnapshot | null {
  if (item.eventType !== EVT_EVAL_V2_CREATIVE_SNAPSHOT && item.eventType !== EVT_EVAL_V2_ACCOUNT_HEALTH_SNAPSHOT) return null;
  const snap = obj(item.snapshot);
  return snap && (snap.surface === 'creative' || snap.surface === 'account_health') ? (snap as unknown as SurfaceSnapshot) : null;
}
