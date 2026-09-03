/**
 * ENG-918 — per-account ads-threshold store: the pure half.
 *
 * Externalises detection thresholds so they can be tuned per client, carry provenance, and be
 * reverted. This is ENG-885's L4 parameter layer, so it is also where a learning loop writes a
 * fitted value — building it now means the ledger has a destination instead of needing one
 * retrofitted.
 *
 * Kept free of the DynamoDB client for the same reason `metaCapiKeyCoverage` is: the rules below
 * are the part worth unit-testing exhaustively, and they should not need AWS to run.
 * Storage lives in `adsThresholdsDb.ts`.
 *
 * ─── Why the key is the AD ACCOUNT and not the user ───────────────────────────────────────
 *
 * **One ad account can sit on several user records** — a fleet read found 21 connection rows
 * resolving to 15 distinct ad accounts, with two accounts held by three user records each. Keying
 * thresholds by `userId` would let those three records hold three different frequency ceilings
 * for the same account, with the effective one decided by whichever record happened to resolve.
 * That is silent and non-deterministic, and it is the same defect class that already produced a
 * wrong per-user counter against correct per-account alerting.
 *
 * These thresholds are evaluated against an ad account's campaigns, so the account is the grain
 * that matches the measurement. Several people editing one account's thresholds is then an
 * ordinary concurrent-write problem, which the storage layer's compare-and-swap already handles,
 * and *who* edited is preserved on each revision's `changedBy`.
 *
 * The composite `${platform}#${accountId}` mirrors `AW-AdsMetricsSnapshots`' `entityKey`
 * convention rather than inventing a second shape, and keeps a Meta account id from ever
 * colliding with a numerically identical Google customer id.
 *
 * ─── Why three sources, and why the precedence rule is load-bearing ───────────────────────
 *
 * Three different writers set values here, and they are NOT interchangeable:
 *
 *   'default'  seeded from the registry below (CS-16's operational thresholds)
 *   'user'     a person setting an explicit business rule
 *   'learned'  a learning loop writing a fitted value
 *
 * **A `learned` write must never silently overwrite a `user` one.** Someone who deliberately set
 * a frequency ceiling to 3.0 has stated an intent; a loop fitting 3.4 from last week's data has
 * produced an estimate. Letting the estimate win means the product quietly undoes a human choice
 * and shows no evidence it happened — indistinguishable from a bug, and unrecoverable once the
 * old value is gone. A `user` write may freely override a `learned` one; that direction is a
 * human correcting a machine, which is the entire point of the revert control.
 *
 * ─── Why clamp a machine but REFUSE a human ───────────────────────────────────────────────
 *
 * Out-of-range values are handled differently by source, deliberately. A `learned` value is a
 * *proposal*, so clamping it to the nearest legal value is a reasonable reading of intent. A
 * `user` value is an *assertion*, and silently storing 8 when someone typed 50 leaves them
 * believing they set 50 — the setting reads back wrong forever and nothing ever tells them.
 * A human gets a refusal they can see; a machine gets a clamp.
 *
 * ─── Why a movement cap AND absolute bounds ───────────────────────────────────────────────
 *
 * They bound different things and neither substitutes for the other. The movement cap bounds a
 * single STEP (no more than N% of the current value per cycle), which stops one noisy week from
 * relocating a threshold. Absolute `min`/`max` bound the DESTINATION — without them a capped
 * parameter still walks anywhere given enough cycles, each step individually legitimate. A
 * frequency ceiling that drifts to 12 over two months is not a tuning outcome, it is a disabled
 * check.
 *
 * ─── Why a revert starts a cooldown ───────────────────────────────────────────────────────
 *
 * A revert is the strongest negative signal available: a human looked at a fitted value and
 * rejected it. Returning the parameter straight to `default` without a cooldown lets the loop
 * refit the same value on its next tick, so the human reverts again, forever. The existing
 * `loops/` framework reaches the same conclusion from the other direction — its `LearningStore`
 * exposes `lastOutcomeForRule` specifically so the policy layer can apply a "failure-driven
 * cooldown — don't re-propose a fix whose last shipped version regressed."
 *
 * ─── Why the registry is a Map, not a plain object ────────────────────────────────────────
 *
 * `paramKey` is attacker-controlled — it arrives straight off the URL path on every route. A
 * plain object literal's bracket access (`REGISTRY[paramKey]`) falls through the PROTOTYPE CHAIN
 * for inherited property names: `REGISTRY['__proto__']` returns `Object.prototype` itself, which
 * is truthy, so `?? null` does not catch it — the lookup silently "succeeds" with an object whose
 * `min`/`max` are `undefined`, and every bounds/movement-cap comparison against `undefined` is
 * `false`, so the entire validation this module exists to provide is skipped for that key. A
 * `Map` has no such fallthrough: `.get()` only ever returns entries actually inserted via
 * `.set()`/the constructor, so `'__proto__'`, `'constructor'`, `'toString'`, etc. all correctly
 * return `undefined`. This closes the whole class rather than special-casing the two or three
 * property names someone happened to think of.
 */

export type ThresholdSource = 'default' | 'user' | 'learned';

/** Platforms the store is keyed by. Meta is the only live consumer; the key carries the
 *  dimension now so Google/LinkedIn need no migration — the same reason `AW-AdsMetricsSnapshots`
 *  is platform-general while its only adapter is Meta's. */
export type AdsPlatform = 'meta' | 'google_ads' | 'linkedin_ads';

/**
 * How long a reverted parameter refuses `learned` writes.
 *
 * 30 days rather than a few: these thresholds are fitted from campaign data whose own settling
 * window is 28 days, so a shorter cooldown would let the loop re-propose from substantially the
 * same observations that produced the value a human just rejected.
 */
export const LEARNED_COOLDOWN_DAYS = 30;

/**
 * Round to a fixed precision after clamping.
 *
 * Clamping is float64 arithmetic and can leave binary-fraction dust — `2.8 - Math.abs(2.8)*0.2`
 * is `2.2399999999999998`, not `2.24`. Left unrounded, a UI that displays the rounded figure and
 * a human who later types that exact figure back in produces a value that is NOT `=== ` the
 * stored one, so a write that changed nothing meaningful gets recorded as a new audit revision —
 * noise in the exact trail this feature exists to keep trustworthy.
 */
const CLAMP_PRECISION = 6;
function roundClamped(value: number): number {
  return Number(value.toFixed(CLAMP_PRECISION));
}

export interface ThresholdRevision {
  value: number;
  /** null on the seeding revision, where there is no prior value. */
  previousValue: number | null;
  source: ThresholdSource;
  /** Free text: why this value. Required — a value with no stated reason cannot be reviewed. */
  evidence: string;
  /** Observations behind a `learned` value. null for `user`/`default`, which are not fitted. */
  sampleSize: number | null;
  changedAt: string;
  /** userId, or a loop/service identifier for machine writes. */
  changedBy: string;
}

export interface AdsThreshold {
  /** The ad account these thresholds govern. See the header for why this is not a userId. */
  accountId: string;
  platform: AdsPlatform;
  paramKey: string;
  currentValue: number;
  source: ThresholdSource;
  updatedAt: string;
  /** ISO timestamp until which `learned` writes are refused. Set by a revert. */
  learnedCooldownUntil?: string | null;
  /** Newest first, capped at REVISION_HISTORY_LIMIT. */
  revisions: ThresholdRevision[];
}

export interface ThresholdDefinition {
  key: string;
  defaultValue: number;
  /** Absolute floor/ceiling. Bounds the destination, not the step — see the header. */
  min: number;
  max: number;
  /** Largest single-cycle change, as a fraction of the current value. */
  maxMovePctPerCycle: number;
  /** A `learned` write with fewer observations than this is refused. */
  minSampleSize: number;
  unit: 'percent' | 'ratio' | 'count' | 'days' | 'currency';
  description: string;
}

/**
 * How many revisions to retain per parameter.
 *
 * Bounded deliberately, matching `promptRevisions`' existing precedent on scheduled chats: an
 * unbounded audit list grows without limit inside a single item and eventually collides with
 * DynamoDB's 400KB item ceiling — at which point the WRITE fails, so an audit trail nobody
 * trimmed would end up blocking the very change it exists to record.
 *
 * ⚠ Because history is capped, a revert's cooldown is stored as its own field rather than
 * derived by scanning `revisions` — a revert can age out of the list while its cooldown is
 * still in force.
 */
export const REVISION_HISTORY_LIMIT = 20;

/**
 * Maximum length of a free-text `evidence` string.
 *
 * `revisions` is capped by COUNT (`REVISION_HISTORY_LIMIT`), not by byte size, so an
 * unbounded evidence string can still push a single item past DynamoDB's 400KB ceiling — at
 * which point the write fails with a generic error rather than a clear "your input is too long."
 * 2000 characters is generous for a justification and cheap to enforce at the boundary instead.
 */
export const MAX_EVIDENCE_LENGTH = 2000;

/**
 * The registry, and the single source of truth for defaults.
 *
 * Values seed CS-16's operational thresholds, decided 2026-07-27 and reaffirmed 2026-08-16
 * ("Approved as drafted") with the explicit note that **"threshold tuning is operational
 * configuration and does not require a new founder taste gate"** — so these are starting values,
 * not policy, and nobody needs to stop on them.
 *
 * ⚠ These are the CREATIVE-FATIGUE / campaign-health thresholds, which today live as prose in a
 * published production skill prompt. They are deliberately NOT §F/§G's detection constants
 * (`OPTIMISATION_ABSENCE_DAYS`, `EVENT_MIX_ABSENCE_DAYS`, …): those were calibrated by replaying
 * a real outage and are platform-mechanics, not per-client business judgement. Do not fold them
 * in here without a separate decision.
 *
 * A plain array of entries feeds a `Map` rather than an object literal — see the header for why
 * a `Map` is load-bearing here, not a style preference.
 */
const THRESHOLD_DEFINITIONS: readonly ThresholdDefinition[] = [
  {
    key: 'creativeFatigue.ctrDropCriticalPct',
    defaultValue: 20,
    min: 5,
    max: 60,
    maxMovePctPerCycle: 0.25,
    minSampleSize: 30,
    unit: 'percent',
    description: 'CTR decline vs baseline that contributes to a critical fatigue verdict.',
  },
  {
    key: 'creativeFatigue.frequencyCritical',
    defaultValue: 3.5,
    min: 1.5,
    max: 8,
    maxMovePctPerCycle: 0.2,
    minSampleSize: 30,
    unit: 'ratio',
    description: 'Impressions-per-person ceiling above which an ad set reads as saturated.',
  },
  {
    key: 'creativeFatigue.cpmRiseCriticalPct',
    defaultValue: 15,
    min: 5,
    max: 50,
    maxMovePctPerCycle: 0.25,
    minSampleSize: 30,
    unit: 'percent',
    description: 'CPM increase vs baseline that contributes to a critical fatigue verdict.',
  },
  {
    key: 'campaignHealth.cplDriftCriticalPct',
    defaultValue: 40,
    min: 10,
    max: 100,
    maxMovePctPerCycle: 0.25,
    minSampleSize: 30,
    unit: 'percent',
    description: 'Cost-per-lead drift vs trailing baseline that escalates to critical.',
  },
  {
    key: 'campaignHealth.pacingMissCriticalPct',
    defaultValue: 35,
    min: 10,
    max: 100,
    maxMovePctPerCycle: 0.25,
    minSampleSize: 30,
    unit: 'percent',
    description: 'Budget pacing miss that escalates to critical.',
  },
  {
    key: 'campaignHealth.pacingWatchPct',
    defaultValue: 20,
    min: 5,
    max: 60,
    maxMovePctPerCycle: 0.25,
    minSampleSize: 30,
    unit: 'percent',
    description: 'Budget pacing deviation that raises a watch (not critical) signal.',
  },
];

export const THRESHOLD_REGISTRY: ReadonlyMap<string, ThresholdDefinition> = new Map(
  THRESHOLD_DEFINITIONS.map(def => [def.key, def]),
);

export function getThresholdDefinition(paramKey: string): ThresholdDefinition | null {
  return THRESHOLD_REGISTRY.get(paramKey) ?? null;
}

/**
 * Partition key: `${platform}#${accountId}`.
 *
 * Mirrors `AW-AdsMetricsSnapshots`' `entityKey` rather than inventing a second convention, and
 * keeps a Meta ad-account id from colliding with a numerically identical Google customer id.
 */
export function buildThresholdEntityKey(
  platform: AdsPlatform,
  accountId: string,
): string {
  return `${platform}#${accountId}`;
}

/**
 * Split an entity key back into its parts.
 *
 * Splits on the FIRST separator only. Platform names never contain `#`, whereas an account
 * identifier is externally supplied and could; `split('#')[1]` would silently truncate such an
 * id and address a different account than the one stored.
 */
export function parseThresholdEntityKey(
  entityKey: string,
): { platform: AdsPlatform; accountId: string } | null {
  const idx = entityKey.indexOf('#');
  if (idx <= 0 || idx === entityKey.length - 1) return null;
  return {
    platform: entityKey.slice(0, idx) as AdsPlatform,
    accountId: entityKey.slice(idx + 1),
  };
}

export type ThresholdWriteRefusal =
  | 'unknown_parameter'
  | 'invalid_source'
  | 'learned_would_override_user'
  | 'insufficient_sample'
  | 'not_finite'
  | 'out_of_bounds'
  | 'revert_cooldown'
  | 'no_change';

export type ThresholdWriteVerdict =
  | {
      allowed: true;
      /** The value that will actually be stored — may differ from the request if clamped. */
      value: number;
      requestedValue: number;
      clampedBy: 'movementCap' | 'bounds' | null;
    }
  | { allowed: false; reason: ThresholdWriteRefusal; detail: string };

/**
 * Decide whether a proposed write is allowed, and what value it would actually store.
 *
 * Pure and side-effect free so the caller can preview a change — the "human-reviewable diff"
 * L4's governance requires — without committing it.
 *
 * `existing` is null when the parameter has never been written for this account, in which case
 * the comparison baseline is the registry default.
 */
export function evaluateThresholdWrite(args: {
  paramKey: string;
  requestedValue: number;
  source: ThresholdSource;
  sampleSize?: number | null;
  existing: AdsThreshold | null;
  /** Defaults to now. Injected so cooldown behaviour is testable without faking the clock. */
  at?: Date;
}): ThresholdWriteVerdict {
  const definition = getThresholdDefinition(args.paramKey);
  if (!definition) {
    return {
      allowed: false,
      reason: 'unknown_parameter',
      detail: `'${args.paramKey}' is not in THRESHOLD_REGISTRY`,
    };
  }

  // 'default' is a STATE a parameter can be in (nothing was ever set, or it was reverted), never
  // a WRITE a live actor proposes — only 'user' and 'learned' represent an actor asserting a
  // value. The out-of-bounds check a few lines down branches on `args.source !== 'learned'` to
  // decide refuse-vs-clamp; without this guard a 'default'-sourced call (permitted by the type,
  // never issued by any current caller) would fall through that branch as if it were a human
  // write, refusing rather than clamping, for a source that should never reach here at all.
  if (args.source === 'default') {
    return {
      allowed: false,
      reason: 'invalid_source',
      detail: "'default' describes an unset or reverted parameter's state, not a write source",
    };
  }

  // Guard before any arithmetic: NaN silently defeats every comparison below — a NaN clamp
  // returns NaN, and `NaN !== current` is true, so it would read as a legitimate change and be
  // stored.
  if (!Number.isFinite(args.requestedValue)) {
    return {
      allowed: false,
      reason: 'not_finite',
      detail: `requested value ${String(args.requestedValue)} is not a finite number`,
    };
  }

  const currentValue = args.existing ? args.existing.currentValue : definition.defaultValue;
  const currentSource: ThresholdSource = args.existing ? args.existing.source : 'default';

  // The precedence rule. See the header for why this direction and not the other.
  if (args.source === 'learned' && currentSource === 'user') {
    return {
      allowed: false,
      reason: 'learned_would_override_user',
      detail:
        'a human-set value is in place; a learned value may not replace it. Surface the ' +
        'proposal for review instead of writing it.',
    };
  }

  if (args.source === 'learned') {
    const cooldownUntil = args.existing?.learnedCooldownUntil;
    if (cooldownUntil) {
      const now = args.at ?? new Date();
      const until = Date.parse(cooldownUntil);
      // An unparseable stamp fails CLOSED — refusing a fit is recoverable, silently resuming
      // machine writes against a value a human rejected is not.
      if (!Number.isFinite(until) || now.getTime() < until) {
        return {
          allowed: false,
          reason: 'revert_cooldown',
          detail: `learned writes are paused until ${cooldownUntil} following a revert`,
        };
      }
    }

    // `?? 0` alone is not enough: it only replaces null/undefined, and `NaN ?? 0` is still
    // `NaN` — every comparison against NaN is false, so a NaN sample size would sail straight
    // past `n < definition.minSampleSize` below. Number.isFinite rejects NaN too.
    const n = Number.isFinite(args.sampleSize) ? (args.sampleSize as number) : 0;
    if (n < definition.minSampleSize) {
      return {
        allowed: false,
        reason: 'insufficient_sample',
        detail: `sample size ${n} is below the ${definition.minSampleSize} required for '${args.paramKey}'`,
      };
    }
  }

  // Out of range: refuse a human, clamp a machine. See the header.
  if (args.requestedValue < definition.min || args.requestedValue > definition.max) {
    if (args.source !== 'learned') {
      return {
        allowed: false,
        reason: 'out_of_bounds',
        detail: `${args.requestedValue} is outside the permitted ${definition.min}–${definition.max} for '${args.paramKey}'`,
      };
    }
  }

  // Movement cap applies only to machine writes. A human setting a value deliberately is not
  // making the mistake the cap exists to prevent — and a cap that silently rewrites what
  // somebody typed into a settings field is a bug, not a guardrail.
  let value = args.requestedValue;
  let clampedBy: 'movementCap' | 'bounds' | null = null;

  if (args.source === 'learned') {
    const maxDelta = Math.abs(currentValue) * definition.maxMovePctPerCycle;
    const delta = value - currentValue;
    if (Math.abs(delta) > maxDelta) {
      value = currentValue + Math.sign(delta) * maxDelta;
      clampedBy = 'movementCap';
    }

    const bounded = Math.min(definition.max, Math.max(definition.min, value));
    if (bounded !== value) {
      value = bounded;
      clampedBy = 'bounds';
    }

    if (clampedBy) value = roundClamped(value);
  }

  if (value === currentValue) {
    return {
      allowed: false,
      reason: 'no_change',
      detail: `value already ${currentValue} after clamping; nothing to write`,
    };
  }

  return { allowed: true, value, requestedValue: args.requestedValue, clampedBy };
}

/**
 * Build the parameter record a write should store.
 *
 * Returns the whole item rather than a patch: `revisions` has to be trimmed against its own
 * previous contents, so a caller assembling this by hand would have to re-implement the cap and
 * would eventually get it wrong in one of the call sites.
 */
export function applyThresholdWrite(args: {
  accountId: string;
  platform: AdsPlatform;
  paramKey: string;
  value: number;
  source: ThresholdSource;
  evidence: string;
  sampleSize?: number | null;
  changedBy: string;
  changedAt: string;
  existing: AdsThreshold | null;
}): AdsThreshold {
  const previousValue = args.existing ? args.existing.currentValue : null;

  const revision: ThresholdRevision = {
    value: args.value,
    previousValue,
    source: args.source,
    evidence: args.evidence,
    sampleSize: args.source === 'learned' ? args.sampleSize ?? null : null,
    changedAt: args.changedAt,
    changedBy: args.changedBy,
  };

  return {
    accountId: args.accountId,
    platform: args.platform,
    paramKey: args.paramKey,
    currentValue: args.value,
    source: args.source,
    updatedAt: args.changedAt,
    // Any successful write clears the cooldown, and it is deliberately NOT conditional on source.
    // A human write supersedes whatever the revert was protecting. A `learned` write can only
    // reach this function once `evaluateThresholdWrite` has already let it past the cooldown —
    // i.e. once the stamp is spent — so preserving it would keep a dead field on the item
    // forever while changing no behaviour. Enforcement lives at evaluation time; this function
    // records the outcome.
    learnedCooldownUntil: null,
    revisions: [revision, ...(args.existing?.revisions ?? [])].slice(0, REVISION_HISTORY_LIMIT),
  };
}

/**
 * Build the record for a revert-to-default.
 *
 * Modelled as a write rather than a deletion, because deleting the item would take the revision
 * history with it — and "why is this back at 20?" is exactly the question the history exists to
 * answer.
 *
 * ⚠ The restored value always comes from the REGISTRY. `AdsThreshold` does not carry its own
 * `defaultValue` — it did originally, and reverting through THAT stored copy was the exact bug
 * this function exists to avoid: a parameter written long ago carries whatever the default was
 * back then, so a stale stored copy would "revert" to a number that is no longer anybody's
 * policy. Rather than leave a field around that every consumer had to remember not to trust, the
 * field itself is gone — the registry is the only place a default is allowed to be read from.
 *
 * The reverted state is `source: 'default'` so the parameter is managed again rather than frozen
 * — paired with a cooldown so the loop cannot immediately refit the value just rejected.
 *
 * ⚠ Throws rather than silently disarming the cooldown on a bad `changedAt`. The sibling read
 * path (`evaluateThresholdWrite`'s cooldown check) fails CLOSED on an unparseable timestamp — a
 * corrupt stamp is treated as "still in cooldown," never as "no cooldown." Silently writing
 * `learnedCooldownUntil: null` here would do the opposite: the one caller that failed to pass a
 * valid clock reading would be the one revert that gets NO protection at all. Loud failure here
 * is safe because every current caller (the HTTP route) always passes `new Date().toISOString()`.
 */
export function buildThresholdRevert(args: {
  existing: AdsThreshold;
  changedBy: string;
  changedAt: string;
  evidence?: string;
  cooldownDays?: number;
}): AdsThreshold {
  const definition = getThresholdDefinition(args.existing.paramKey);
  if (!definition) {
    throw new Error(`buildThresholdRevert: '${args.existing.paramKey}' is not in THRESHOLD_REGISTRY`);
  }

  const changedAtMs = Date.parse(args.changedAt);
  if (!Number.isFinite(changedAtMs)) {
    throw new Error(`buildThresholdRevert: changedAt '${args.changedAt}' is not a parseable timestamp`);
  }
  const days = args.cooldownDays ?? LEARNED_COOLDOWN_DAYS;
  const cooldownUntil = new Date(changedAtMs + days * 24 * 60 * 60 * 1000).toISOString();

  const evidence = args.evidence ?? 'Reverted to default';
  if (evidence.length > MAX_EVIDENCE_LENGTH) {
    throw new Error(`buildThresholdRevert: evidence exceeds ${MAX_EVIDENCE_LENGTH} characters`);
  }

  const revision: ThresholdRevision = {
    value: definition.defaultValue,
    previousValue: args.existing.currentValue,
    source: 'default',
    evidence,
    sampleSize: null,
    changedAt: args.changedAt,
    changedBy: args.changedBy,
  };

  return {
    ...args.existing,
    currentValue: definition.defaultValue,
    source: 'default',
    updatedAt: args.changedAt,
    learnedCooldownUntil: cooldownUntil,
    revisions: [revision, ...args.existing.revisions].slice(0, REVISION_HISTORY_LIMIT),
  };
}

/**
 * Resolve every parameter for an account, filling unset ones from the registry.
 *
 * Returns the full registry rather than only what is stored: a consumer asking for a threshold
 * must always get a usable number, and forcing each caller to remember its own fallback is how
 * two call sites end up disagreeing about what the default is.
 */
export function resolveThresholds(
  stored: readonly AdsThreshold[],
): Record<string, { value: number; source: ThresholdSource }> {
  const byKey = new Map(stored.map(p => [p.paramKey, p]));
  const resolved: Record<string, { value: number; source: ThresholdSource }> = {};

  for (const definition of THRESHOLD_REGISTRY.values()) {
    const hit = byKey.get(definition.key);
    resolved[definition.key] = hit
      ? { value: hit.currentValue, source: hit.source }
      : { value: definition.defaultValue, source: 'default' };
  }

  return resolved;
}
