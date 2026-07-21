/**
 * AskUserQuestion primitive (ENG-396) — a structured, blocking option-select
 * prompt Emma can emit in chat. Modeled on Claude Code's AskUserQuestion.
 *
 * WHY THIS EXISTS (incident 2026-07-19, sessions e2fd937d… / ecae640e…):
 * RankAI Meta campaigns launched optimizing for LANDING_PAGE_VIEWS — an
 * IMMUTABLE Meta parameter (campaign objective) that no human ever chose. Emma
 * DEFAULTED it (creation idx=20), then DEFEATED its own confirmation gate by
 * re-issuing the create with `confirm:true` inside the SAME turn (idx=205), so
 * the loop's post-dispatch halt (`collectConfirmationPrompt` → break) fired only
 * AFTER the live mutation had run. Because the objective is immutable, the fix
 * was a full clone-and-kill rebuild (repair session). See
 * memory/ note + the ticket for the full trace.
 *
 * The two structural lessons this module encodes:
 *   1. A gate keyed on a flag the MODEL controls (`confirm:true`) is not a
 *      barrier. An answer is only trustworthy when it is attributable to an
 *      inbound USER action — never to a model-emitted argument. This module
 *      makes that a TYPE-LEVEL invariant: `answeredBy` is `'user' | 'delegation'`
 *      only. There is deliberately NO `'model'` — the model cannot construct a
 *      valid answer, so the run cannot self-resolve the question.
 *   2. A recommendation is the product. Exactly ONE option is flagged
 *      Recommended with a one-line why, and every option carries the concrete
 *      machine `payload` it implies so a selection DETERMINISTICALLY sets the
 *      parameter — no re-inference, no drift (the LEADS→TRAFFIC flip between
 *      idx=202 and idx=205 was re-inference drift).
 *
 * This module is PURE (no I/O). Persistence lives in chatbotService
 * (`updateSessionAskUserQuestion`); loop/tool wiring lives in agentModeService;
 * the structured answer channel lives in the /generate controller. Scope is
 * deliberately minimal (no generic requires_structured_choice framework) — the
 * first and only consumer is the Meta campaign-objective gate (ENG-400).
 */

/** One selectable option on the card. */
export interface AskUserQuestionOption {
  /** Stable id the frontend returns on selection (never re-parsed from prose). */
  id: string;
  /** Short button label, e.g. "Leads". */
  label: string;
  /** One-line consequence of picking this option. */
  consequence: string;
  /** Exactly one option in a question is recommended, with a one-line `why`. */
  recommended?: boolean;
  /** One-line justification, REQUIRED on the recommended option (the product). */
  why?: string;
  /** Concrete machine parameters this option implies. The consumer applies this
   *  verbatim so selection is deterministic (no model re-inference). */
  payload?: Record<string, unknown>;
}

export type AskUserQuestionStatus = 'awaiting' | 'answered';

/** Who supplied the answer. Deliberately excludes the model — see file header. */
export type AskUserQuestionAnsweredBy = 'user' | 'delegation';

export interface AskUserQuestionAnswer {
  /** The chosen option's id. */
  optionId: string;
  /** True when reached via "Let Emma decide" (delegation), false on direct pick. */
  delegated: boolean;
  /** 'user' = explicit human selection; 'delegation' = explicit delegation click
   *  or a policy-permitted headless auto-take of the recommendation. */
  answeredBy: AskUserQuestionAnsweredBy;
  /** For delegated answers: why the recommended option was taken (logged). */
  rationale?: string;
  /** ISO timestamp the answer landed. */
  at: string;
}

export interface PendingUserQuestion {
  /** Correlates the card, the persisted state, and the inbound selection. */
  questionId: string;
  /** The question text shown on the card. */
  question: string;
  /** 2–4 options; exactly one recommended. */
  options: AskUserQuestionOption[];
  /** Id of the single recommended option (redundant with the flag, kept in sync
   *  by construction so consumers/headless auto-take need not re-scan options). */
  recommendedOptionId: string;
  /** True when the parameter is IRREVERSIBLE (e.g. Meta campaign objective).
   *  Headless/scheduled runs must PARK such questions and never auto-take. */
  immutable: boolean;
  /** When true, the card shows a "Let Emma decide" delegation button. */
  allowEmmaDecide: boolean;
  status: AskUserQuestionStatus;
  createdAt: string;
  /** Present only once status === 'answered'. */
  answer?: AskUserQuestionAnswer;
}

/** Input shape a tool/consumer passes to construct a question (pre-validation). */
export interface AskUserQuestionInput {
  questionId: string;
  question: string;
  options: AskUserQuestionOption[];
  immutable?: boolean;
  allowEmmaDecide?: boolean;
  createdAt: string;
}

export class AskUserQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskUserQuestionError';
  }
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/**
 * Validate the option set and return the single recommended option's id.
 * Throws AskUserQuestionError on any structural violation. Kept separate so the
 * tool handler can validate before persisting and the tests can assert each rule.
 */
export function resolveRecommendedOptionId(options: AskUserQuestionOption[]): string {
  if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new AskUserQuestionError(
      `AskUserQuestion requires ${MIN_OPTIONS}–${MAX_OPTIONS} options, got ${Array.isArray(options) ? options.length : 'none'}`,
    );
  }

  const ids = new Set<string>();
  for (const opt of options) {
    if (!opt || typeof opt.id !== 'string' || opt.id.trim() === '') {
      throw new AskUserQuestionError('Each option needs a non-empty id');
    }
    if (ids.has(opt.id)) {
      throw new AskUserQuestionError(`Duplicate option id: ${opt.id}`);
    }
    ids.add(opt.id);
    if (typeof opt.label !== 'string' || opt.label.trim() === '') {
      throw new AskUserQuestionError(`Option ${opt.id} needs a non-empty label`);
    }
    if (typeof opt.consequence !== 'string' || opt.consequence.trim() === '') {
      throw new AskUserQuestionError(`Option ${opt.id} needs a one-line consequence`);
    }
  }

  const recommended = options.filter((o) => o.recommended === true);
  if (recommended.length !== 1) {
    // The recommendation is the whole product — never zero, never ambiguous.
    throw new AskUserQuestionError(
      `Exactly one option must be recommended, got ${recommended.length}`,
    );
  }
  if (typeof recommended[0].why !== 'string' || recommended[0].why.trim() === '') {
    throw new AskUserQuestionError('The recommended option needs a one-line `why`');
  }
  return recommended[0].id;
}

/**
 * Construct a validated PendingUserQuestion in the `awaiting` state. This is the
 * ONLY sanctioned way to create one — it guarantees the exactly-one-recommended
 * invariant and keeps recommendedOptionId in sync with the flag.
 */
export function buildPendingUserQuestion(input: AskUserQuestionInput): PendingUserQuestion {
  if (typeof input.questionId !== 'string' || input.questionId.trim() === '') {
    throw new AskUserQuestionError('questionId is required');
  }
  if (typeof input.question !== 'string' || input.question.trim() === '') {
    throw new AskUserQuestionError('question text is required');
  }
  const recommendedOptionId = resolveRecommendedOptionId(input.options);
  return {
    questionId: input.questionId,
    question: input.question,
    options: input.options,
    recommendedOptionId,
    immutable: input.immutable === true,
    allowEmmaDecide: input.allowEmmaDecide === true,
    status: 'awaiting',
    createdAt: input.createdAt,
  };
}

/** Fields an inbound answer supplies (from the /generate structured channel). */
export interface ApplyAnswerInput {
  optionId: string;
  delegated: boolean;
  answeredBy: AskUserQuestionAnsweredBy;
  rationale?: string;
  at: string;
}

/**
 * Transition an awaiting question to answered. Enforces every invariant that
 * the incident violated:
 *   - the question must still be awaiting (no double-answer / no re-answer of a
 *     resolved gate — the idx=205 same-turn re-issue would be rejected here);
 *   - the optionId must be a real option;
 *   - answeredBy must be 'user' or 'delegation' (the type already forbids
 *     'model', but we re-check defensively against untyped call sites);
 *   - a delegated answer must resolve to the recommended option (delegation
 *     means "take Emma's recommendation", never a silent different choice).
 * Returns a NEW question object (does not mutate the input).
 */
export function applyAnswer(
  question: PendingUserQuestion,
  input: ApplyAnswerInput,
): PendingUserQuestion {
  if (question.status === 'answered') {
    throw new AskUserQuestionError('Question already answered — cannot re-answer');
  }
  if (input.answeredBy !== 'user' && input.answeredBy !== 'delegation') {
    // The model can never be the answerer — this is the core barrier.
    throw new AskUserQuestionError(`Invalid answeredBy: ${String(input.answeredBy)}`);
  }
  const option = question.options.find((o) => o.id === input.optionId);
  if (!option) {
    throw new AskUserQuestionError(`Unknown optionId: ${input.optionId}`);
  }
  if (input.delegated && input.optionId !== question.recommendedOptionId) {
    throw new AskUserQuestionError('Delegated answers must select the recommended option');
  }
  return {
    ...question,
    status: 'answered',
    answer: {
      optionId: input.optionId,
      delegated: input.delegated,
      answeredBy: input.answeredBy,
      rationale: input.rationale,
      at: input.at,
    },
  };
}

/** The raw structured selection a client posts on the /generate body. */
export interface InboundAnswerBody {
  /** When present, MUST match the pending question's id (stale-card guard). */
  questionId?: string;
  /** The picked option's id. Required for a direct pick; ignored for delegation. */
  optionId?: string;
  /** True when the user clicked "Let Emma decide" (delegation). */
  delegated?: boolean;
}

/**
 * Resolve an inbound structured selection (from the /generate answer channel)
 * against the session's pending question, returning the answered question to
 * persist. Throws AskUserQuestionError on any invalid input.
 *
 * The load-bearing property: `answeredBy` is DERIVED here from the `delegated`
 * flag — it is never read off the client body. A client therefore cannot forge
 * `'model'` (the type has no such value anyway), so the barrier that the RankAI
 * incident defeated holds: only a real inbound selection produces an answer.
 *
 * Delegation ("Let Emma decide") always resolves to the RECOMMENDED option and
 * carries its `why` as the logged rationale; a stray `optionId` on a delegated
 * body is ignored so a delegation click can never become a silent different
 * choice. A direct pick MUST name a real option.
 */
export function resolveInboundAnswer(
  pending: PendingUserQuestion | null | undefined,
  body: InboundAnswerBody,
  at: string,
): PendingUserQuestion {
  if (!pending) {
    throw new AskUserQuestionError('No pending question to answer');
  }
  if (pending.status === 'answered') {
    throw new AskUserQuestionError('Question already answered — cannot re-answer');
  }
  if (body.questionId && body.questionId !== pending.questionId) {
    throw new AskUserQuestionError(
      `Answer questionId (${body.questionId}) does not match pending question (${pending.questionId})`,
    );
  }

  const delegated = body.delegated === true;
  if (delegated) {
    const recommended = pending.options.find((o) => o.id === pending.recommendedOptionId);
    return applyAnswer(pending, {
      optionId: pending.recommendedOptionId,
      delegated: true,
      answeredBy: 'delegation',
      rationale: recommended?.why
        ? `Delegated to Emma's recommendation — ${recommended.why}`
        : "Delegated to Emma's recommendation",
      at,
    });
  }

  if (typeof body.optionId !== 'string' || body.optionId.trim() === '') {
    throw new AskUserQuestionError('A direct selection must include an optionId');
  }
  return applyAnswer(pending, {
    optionId: body.optionId,
    delegated: false,
    answeredBy: 'user',
    at,
  });
}

/**
 * Headless/scheduled policy: may a run with no live human auto-take the
 * recommended option? Only when the parameter is REVERSIBLE and the session
 * explicitly allows delegation. Immutable parameters (the ENG-396 case) must
 * ALWAYS park as pending_user_input and notify — never auto-pick. This is the
 * codified form of the repair session's manual "Never guess a pixel ID" rule.
 */
export function canAutoTakeInHeadless(
  question: PendingUserQuestion,
  sessionAllowsDelegation: boolean,
): boolean {
  return !question.immutable && question.allowEmmaDecide && sessionAllowsDelegation;
}

/**
 * Resolve the answer's concrete machine payload for the consumer to apply
 * verbatim (deterministic — no model re-inference). Returns undefined if the
 * question is unanswered or the selected option carried no payload.
 */
export function selectedPayload(question: PendingUserQuestion): Record<string, unknown> | undefined {
  if (question.status !== 'answered' || !question.answer) return undefined;
  return question.options.find((o) => o.id === question.answer!.optionId)?.payload;
}

/**
 * Render the question + options as a plain-text prompt. This is the fallback
 * shown/fed when the structured card can't render (and the string the loop's
 * confirmation-halt surfaces). The structured `options` on the tool result
 * drive the interactive card; this text is the accessible mirror. Deliberately
 * carries NO instruction on how to answer — the model must not be able to
 * self-resolve; only an inbound user selection does.
 */
export function renderQuestionPrompt(question: PendingUserQuestion): string {
  const lines = question.options.map((o, i) => {
    const base = `${i + 1}. ${o.label} — ${o.consequence}`;
    return o.recommended ? `${base}\n   ⭐ Recommended: ${o.why}` : base;
  });
  const footer = question.allowEmmaDecide
    ? '\n\nPick an option above, or choose "Let Emma decide" to go with the recommendation.'
    : '\n\nPick an option above to continue.';
  return `${question.question}\n\n${lines.join('\n')}${footer}`;
}

export type QuestionGateOutcome =
  | { allowed: true; answer: AskUserQuestionAnswer; payload?: Record<string, unknown> }
  | { allowed: false; reason: string };

/**
 * The consumer guard — the load-bearing half of Option A. A write to an
 * IMMUTABLE parameter (e.g. the Meta campaign objective, ENG-400) calls this
 * with the session's FRESH pendingUserQuestion before it executes. It ALLOWS
 * only when a matching question has been answered by a HUMAN.
 *
 * This is the seam where the RankAI incident's same-turn `[ask, create]` bundle
 * dies: a question emitted in the same turn can only ever be `'awaiting'` (only
 * an inbound user message in a LATER run flips it to `'answered'`), so a
 * bundled create is blocked; a create with no prior ask is blocked (no pending);
 * and an answer the model somehow forged is blocked (answeredBy must be
 * user/delegation). The consumer must re-read the session from the DB (tool
 * handlers already do — see getChatSession usage) so it never reads a stale
 * in-memory blank.
 *
 * SCOPING (avoids the over-blocking / angry-users failure mode): this is only
 * ever CALLED by writes to immutable parameters. Reversible Meta ops (pause,
 * budget edit) never call it and are never gated. The guard itself is
 * parameter-agnostic; the consumer decides when it applies.
 *
 * @param pending    session.pendingUserQuestion, read fresh from the DB
 * @param questionId when provided, the pending question must match this id
 *                   (correlation); omit to accept any answered question
 */
export function checkQuestionGate(
  pending: PendingUserQuestion | null | undefined,
  questionId?: string,
): QuestionGateOutcome {
  if (!pending) {
    return { allowed: false, reason: 'No question has been asked yet — the choice must be made first.' };
  }
  if (questionId && pending.questionId !== questionId) {
    return {
      allowed: false,
      reason: `The pending question (${pending.questionId}) does not match the expected question (${questionId}).`,
    };
  }
  if (pending.status !== 'answered' || !pending.answer) {
    return { allowed: false, reason: 'The question is still awaiting a selection.' };
  }
  if (pending.answer.answeredBy !== 'user' && pending.answer.answeredBy !== 'delegation') {
    return { allowed: false, reason: 'The answer was not attributable to a human selection.' };
  }
  return { allowed: true, answer: pending.answer, payload: selectedPayload(pending) };
}
