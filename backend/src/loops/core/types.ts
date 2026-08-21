/**
 * Closed-loop framework — type definitions for the 4 pluggable layers.
 *
 * The architecture follows Tom Blomfield's recursive AI loop and Diana Hu's
 * AI-native-company thesis: every important process in a company is a self-
 * improving closed loop composed of four orthogonal layers:
 *
 *   1. Sensor       — captures events from the world (`EventSource`)
 *   2. Policy       — evaluates events against rules, proposes mutations (`RuleSet`)
 *   3. Tools        — turns proposals into concrete mutations (`MutationTools`)
 *   4. Learning     — records outcomes, refeeds into the next cycle (`LearningStore`)
 *
 * A loop instance is a `LoopManifest` that names one implementation per layer
 * plus the parameters those implementations need. The orchestrator (in
 * orchestrator.ts) wires the layers; the orchestrator itself is loop-agnostic.
 *
 * Package boundary: this directory (`backend/src/loops/core/`) must not import
 * from anywhere else in agentweb. All external dependencies arrive through
 * the injected ports in `ports.ts`. This is what makes the package
 * open-source-ready.
 */

// ---------------------------------------------------------------------------
// Branded ID types — runtime is `string`, but TypeScript prevents accidental
// substitution of one ID type for another (e.g. passing a runId where a
// loopId is expected).
// ---------------------------------------------------------------------------

declare const loopIdBrand: unique symbol;
declare const runIdBrand: unique symbol;
declare const mutationIdBrand: unique symbol;
declare const variantIdBrand: unique symbol;
declare const subjectIdBrand: unique symbol;

export type LoopId = string & { readonly [loopIdBrand]: true };
export type RunId = string & { readonly [runIdBrand]: true };
export type MutationId = string & { readonly [mutationIdBrand]: true };
export type VariantId = string & { readonly [variantIdBrand]: true };
export type SubjectId = string & { readonly [subjectIdBrand]: true };

/** Cast a string to a branded ID. Use sparingly — prefer letting branded types
 * flow through the system. */
export const asLoopId = (s: string): LoopId => s as LoopId;
export const asRunId = (s: string): RunId => s as RunId;
export const asMutationId = (s: string): MutationId => s as MutationId;
export const asVariantId = (s: string): VariantId => s as VariantId;
export const asSubjectId = (s: string): SubjectId => s as SubjectId;

// ---------------------------------------------------------------------------
// Time + filter primitives
// ---------------------------------------------------------------------------

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** Free-form key/value dimensions attached to events. Used by the policy
 * layer to group/segment events (e.g. by variantId, by step, by ICP segment). */
export type EventDimensions = Readonly<Record<string, string | number | boolean | null>>;

// ---------------------------------------------------------------------------
// Layer 1 — Sensor
// ---------------------------------------------------------------------------

/** The shape every event passes through after normalization. Implementations
 * of `EventSource` are responsible for translating their raw storage format
 * (DynamoDB array attribute, separate events table, webhook stream, etc.)
 * into this normalized shape. */
export interface NormalizedEvent {
  /** Stable identifier for the subject the event is about. May be a userId,
   * an anonymous sessionId, or any other id that lets the loop attribute
   * downstream behavior back to the same actor. */
  subjectId: SubjectId;
  /** Event-type discriminator, e.g. `landed`, `form_submitted`, `onboarding_completed`.
   * The allowed set is defined per-loop in the manifest's `allowedEventTypes`. */
  eventType: string;
  /** When the event occurred. */
  ts: Date;
  /** Variant the subject was exposed to at the time of the event, if any.
   * Required for lift computation. */
  variantId?: VariantId;
  /** Free-form dimensions for segmentation. */
  dimensions?: EventDimensions;
}

/** Optional filter to narrow event-source reads at fetch time. Implementations
 * may push the filter down to the underlying store (e.g. as a DynamoDB
 * KeyConditionExpression) or apply it in memory. */
export interface EventFilter {
  eventTypes?: readonly string[];
  subjectIds?: readonly SubjectId[];
  variantIds?: readonly VariantId[];
}

/** Layer 1. */
export interface EventSource<TEvent extends NormalizedEvent = NormalizedEvent> {
  fetchEvents(window: TimeWindow, filter?: EventFilter): Promise<TEvent[]>;
}

// ---------------------------------------------------------------------------
// Layer 2 — Policy (rule DSL)
// ---------------------------------------------------------------------------

/** A condition is an expression over an event window. Phase 1b implements the
 * evaluator (`policy/dsl.ts`); for now this captures the wire format that the
 * evaluator will parse. Strings are intentionally human-readable so manifests
 * stay declarative.
 *
 * Examples:
 *   "icp_match_count = 0 over 7d"
 *   "form_submitted / landed < 0.1"
 *   "eval_failed / eval_started > 0.2"
 */
export type Condition = string;

/** The shape of a mutation the policy layer proposes. Loops parameterize this
 * — a copy loop's `TProposal` describes copy fields; a code-change loop's
 * `TProposal` describes a file path + diff hint; an Emma-query loop's
 * `TProposal` describes the question to ask. */
export interface ProposalTemplate<TProposal> {
  /** Human-readable hypothesis the Generator will reference. */
  hypothesis: string;
  /** What kind of mutation this proposal will become — copy, image_prompt,
   * emma_query, code_change, etc. The tools layer dispatches on this. */
  kind: string;
  /** Free-form payload the tools layer consumes when applying the proposal. */
  payload: TProposal;
}

/** A rule in the funnel-cascade DSL. Rules are data, not code. Adding a rule
 * to a loop is an append to `instances/<loopId>/rules.ts` — no changes to the
 * orchestrator, DSL evaluator, or any other layer. */
export interface Rule<TProposal> {
  /** Stable identifier. Used by the smoke harness to assert specific rules
   * fired. */
  id: string;
  /** When this rule should fire. Parsed + evaluated by `policy/dsl.ts`. */
  when: Condition;
  /** What to propose when it fires. */
  then: ProposalTemplate<TProposal>;
  /** Higher priority fires first. Only the top-N (per manifest) proposals
   * actually get materialized each cycle to stay under the cost cap. */
  priority: number;
  /** Optional cooldown to avoid the same rule firing every cycle while data
   * settles. */
  cooldownDays?: number;
}

/** Materialized output of the policy layer. */
export interface MutationProposal<TProposal> {
  proposalId: MutationId;
  /** The rule that fired. */
  sourceRuleId: string;
  hypothesis: string;
  kind: string;
  payload: TProposal;
  /** Snapshot of the event-window stats that triggered the rule — used for
   * audit logging and for the Slack DM. */
  triggeringStats: EventDimensions;
}

/** Layer 2. */
export interface RuleSet<TEvent extends NormalizedEvent, TProposal> {
  evaluate(events: TEvent[], window: TimeWindow): Promise<MutationProposal<TProposal>[]>;
}

// ---------------------------------------------------------------------------
// Layer 3 — Tools
// ---------------------------------------------------------------------------

/** The concrete result of running a tool against a proposal. The shape is
 * intentionally generic — copy mutations carry new text, code mutations carry
 * a Notion task URL pointing at a cloud-dev spec, Emma-query mutations carry
 * the persisted answer. */
export interface Mutation {
  mutationId: MutationId;
  proposalId: MutationId;
  /** Mirrors `MutationProposal.kind` for fast dispatch. */
  kind: string;
  /** What the tool actually did, as a structured record. */
  artifact: Readonly<Record<string, unknown>>;
  /** Set by the tool if it failed; cleared on success. */
  error?: string;
}

/** Layer 3. */
export interface MutationTools<TProposal> {
  apply(proposal: MutationProposal<TProposal>): Promise<Mutation>;
}

// ---------------------------------------------------------------------------
// Historical decision metadata
// ---------------------------------------------------------------------------

export type DecisionStatus = 'approved' | 'denied' | 'held' | 'pending' | 'auto_shipped';

export interface Decision {
  status: DecisionStatus;
  decidedAt: Date;
  decidedBy?: string;
  reason?: string;
}

// Layer 4 — Learning store
// ---------------------------------------------------------------------------

/** Verdict from the attribution job (layer 4): did the shipped mutation move
 * the loop's target metric over the settle window? This is what makes the loop
 * *self-improving* rather than only self-proposing. */
export type OutcomeVerdict = 'improved' | 'no_change' | 'regressed' | 'inconclusive';

/** A single appended entry in the learning store. Captures the full
 * provenance of a mutation: what triggered it, what was proposed, what shipped,
 * and (when outcome data is available later) whether it moved the metric. */
export interface LearningEvent {
  loopId: LoopId;
  runId: RunId;
  ts: Date;
  proposal?: MutationProposal<unknown>;
  mutation?: Mutation;
  decision?: Decision;
  /** Atomic run-level Slack decision claim. One record resolves every listed
   * proposal together, avoiding partial multi-proposal terminal state. */
  decisionClaim?: 'approved' | 'denied';
  decisionProposalIds?: readonly string[];
  /** Resolved ship-time T — when the mutation actually went live (decision
   * resolved to approved/auto_shipped). Drives outcome attribution. */
  shippedAt?: Date | null;
  /** Target-metric ratio over the window BEFORE the ship: [T - windowDays, T]. */
  metricBefore?: number | null;
  /** Target-metric ratio over the window AFTER the ship: [T, T + windowDays]. */
  metricAfter?: number | null;
  /** (metricAfter - metricBefore) / metricBefore * 100. Filled by attribution. */
  observedLiftPct?: number | null;
  /** Denominator events in the after-window — the sample backing the verdict. */
  sampleN?: number | null;
  /** Attribution verdict. Null until the settle window elapses + attribution
   * runs. A non-null verdict marks this record as an attributed outcome. */
  verdict?: OutcomeVerdict | null;
}

/** Filter for retrieving history. */
export interface HistoryFilter {
  loopId: LoopId;
  window?: TimeWindow;
  ruleIds?: readonly string[];
  status?: readonly DecisionStatus[];
}

export interface LearningRecord extends LearningEvent {
  /** Storage-assigned ordering token. */
  sortKey: string;
}

/** Layer 4. */
export interface LearningStore {
  record(event: LearningEvent): Promise<void>;
  /** Atomically append a deterministic decision record once. Returns false
   * when another process already claimed the same decision key. */
  recordDecisionIfAbsent(event: LearningEvent, decisionKey: string): Promise<boolean>;
  queryHistory(filter: HistoryFilter): Promise<LearningRecord[]>;
  /** Most recent record carrying a non-null `verdict` for the given rule, or
   * null. Lets the policy layer apply a failure-driven cooldown — don't
   * re-propose a fix whose last shipped version regressed or didn't move the
   * metric. This read-back is what closes the loop. */
  lastOutcomeForRule(loopId: LoopId, ruleId: string): Promise<LearningRecord | null>;
}

// ---------------------------------------------------------------------------
// Manifest — names one implementation per layer for a given loop instance
// ---------------------------------------------------------------------------

/** Legacy-named Slack digest parameters. Execution/review authority is
 * determined by Linear routing and the executor pipeline, not this config. */
export interface ApprovalConfig {
  slackUserId?: string;
  slackChannel?: string;
  dmTitleTemplate: string;
  autoShipCutoffHourPT?: number;
  autoShipConditions?: readonly string[];
}

/** Thresholds drive Reaper/Promoter logic. */
export interface LoopThresholds {
  promoteLiftPct: number;
  promoteMinNPerArm: number;
  retireLiftPct: number;
  retireMinNPerArm: number;
  watchdogRollbackPct24h: number;
  watchdogPausePct7d: number;
  maxActiveArmsPerKey: number;
  maxTokensPerCycleUsd: number;
}

/** Generator + Critic LLM parameters. */
export interface GeneratorConfig {
  candidatesPerCycle: number;
  model: string;
  systemPrompt: string;
}

export interface CriticConfig {
  model: string;
  rubric: readonly string[];
  minScore: number;
}

/** The manifest is everything the orchestrator needs to run a loop end-to-end.
 * Each `*Impl` field is a key into a registry of named implementations that
 * the consumer registers in `loops/index.ts`. */
export interface LoopManifest<TEvent extends NormalizedEvent = NormalizedEvent, TProposal = unknown> {
  loopId: LoopId;
  displayName: string;
  /** Set to true to halt all loop activity without removing the manifest. */
  paused: boolean;
  pauseReason?: string;

  /** North-star metric this loop optimizes. Surfaced in Slack DMs. */
  targetMetric: {
    name: string;
    numeratorEvent: string;
    denominatorEvent: string;
    windowDays: number;
  };

  /** Event types this loop accepts. Used by the events ingestion route to
   * reject unknown event types early. */
  allowedEventTypes: readonly string[];

  /** Mutation surface — which keys this loop is allowed to write variants for.
   * Anything outside this list is a business-rules violation. */
  mutationSurface: readonly { key: string; kind: string }[];

  /** Implementation choices — keys into the LOOP_REGISTRY's named impl map. */
  sensorImpl: string;
  rulesetImpl: string;
  toolsImpl: string;
  learningImpl: string;

  /** Per-loop parameters. */
  thresholds: LoopThresholds;
  generator: GeneratorConfig;
  critic: CriticConfig;
  approval: ApprovalConfig;

  /** Free-form business rules the policy DSL evaluates alongside the main
   * rule list. Examples: keyword blacklists, account exclusion lists,
   * weekend freeze, deploy windows. Phase 1b will codify the schema; for
   * now these are inert metadata. */
  businessRules: readonly Readonly<Record<string, unknown>>[];

  /** Free-form parameter bag for the chosen impls — they cast and validate. */
  implParams?: Readonly<Record<string, unknown>>;

  // Type-only fields that propagate the event + proposal shapes to consumers
  // without leaking into the runtime payload. `_phantom` is never read.
  readonly _phantom?: {
    event: TEvent;
    proposal: TProposal;
  };
}

// ---------------------------------------------------------------------------
// Loop run result — what the orchestrator returns for a single tick
// ---------------------------------------------------------------------------

export interface LoopRunResult {
  loopId: LoopId;
  runId: RunId;
  startedAt: Date;
  finishedAt: Date;
  /** What the sensor returned this tick. */
  eventsScanned: number;
  /** Proposals the policy layer produced. */
  proposals: readonly MutationProposal<unknown>[];
  /**
   * How many proposals the per-cycle cap dropped (ENG-820). Surfaced so a digest
   * can say "showing 8 of N" instead of rendering a truncated slice that reads
   * as the complete set — every digest said "Failing tools: 8" and none of them
   * mentioned that 8 was a ceiling.
   */
  proposalsTruncated?: number;
  /** Mutations the tools layer materialized. May be fewer than proposals if
   * business rules filtered some out. */
  mutations: readonly Mutation[];
  /** Set to true if anything was blocked by paused state, budget cap, or a
   * watchdog warning. Slack DM should surface why. */
  blocked: boolean;
  blockReason?: string;
  /** Wall-clock duration of this tick. */
  durationMs: number;
  /** Total Bedrock spend for this tick, summed across the Generator + Critic
   * + any vision calls. Compared against `maxTokensPerCycleUsd`. */
  tokensSpentUsd: number;
}
