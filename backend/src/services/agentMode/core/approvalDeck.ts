/**
 * Approval deck primitive (ENG-1635 / ENG-1644) — a compound, blocking
 * multi-item review Emma can front-load in one shot, occupying the SAME
 * single live human-interrupt slot AskUserQuestion already uses
 * (`session.pendingApprovalDeck`, mutually exclusive with
 * `pendingUserQuestion`/`pendingWorkPlanInput` — see chatbotService's 3-way
 * cross-slot guard).
 *
 * WHY THIS EXISTS: the Phoenix Tech incident (2026-08-26/29) showed the real
 * cost of AskUserQuestion's one-question-at-a-time design once a plan has
 * multiple independent decisions in it — a campaign build became 3 separate
 * plain-text "yes" rounds, on top of the turn-by-turn planning cards. A deck
 * lets every determinable decision (plan choices AND Meta write previews)
 * front-load into ONE slide deck the user fills and submits once. See
 * askUserQuestion.ts's own header for the sibling incident (RankAI,
 * 2026-07-19) this design inherits its core invariant from:
 *
 *   A gate keyed on a flag the MODEL controls is not a barrier. An answer is
 *   only trustworthy when attributable to an inbound USER action. `answeredBy`
 *   is `'user' | 'delegation'` ONLY, at the type level — there is no `'model'`.
 *
 * This module is PURE (no I/O), mirroring askUserQuestion.ts's split:
 * persistence lives in chatbotService (`updateSessionApprovalDeck`); the
 * digest-based at-most-once write grant lives in agentModeService, sourced
 * from this module's `findApprovalDeckAnswerForDigest` instead of the
 * retired `pendingUserQuestion`(kind=`meta_write_manifest`) lookup.
 *
 * BUILD/ANSWER LIFECYCLE (gap 2, ENG-1635/1644 plan): 'building' -> 'awaiting'
 * -> 'answered'. Emma appends items one tool call at a time while 'building';
 * nothing shows the deck to the user or accepts an answer until an explicit
 * finalize call transitions it to 'awaiting' — inferred timing (e.g. "no
 * append in N seconds") would either show an incomplete deck or never show
 * one at all, so the transition is a deliberate signal, not a guess.
 */

import { AskUserQuestionOption } from './askUserQuestion';

export type ApprovalDeckStatus = 'building' | 'awaiting' | 'answered';

/** Who supplied the answer. Deliberately excludes the model — see file header. */
export type ApprovalDeckAnsweredBy = 'user' | 'delegation';

/** The fixed verdict vocabulary for a Meta write preview item (no free-form options). */
export type WriteItemVerdict = 'approve' | 'reject';

export interface ApprovalDeckItem {
  /** Correlates this slide with its answer and, for a write item, its digest. */
  itemId: string;
  /** Consumer tag (e.g. 'meta_write', 'meta_objective') — correlation/logging
   *  only, same role as PendingUserQuestion.kind. Never relaxes the
   *  answered/human check below. */
  kind: string;
  /** The slide's question text, or the write's human-readable target summary. */
  question: string;
  /** 2-4 options, for a plain-decision item. Mutually exclusive with
   *  `metaWriteManifestDigest` — a write item's verdict vocabulary is the
   *  fixed 'approve'/'reject' below, not a free option set. */
  options?: AskUserQuestionOption[];
  /** Enables a "REJECT — <correction>" free-text answer on this item. */
  allowFreeText?: boolean;
  /** Present iff this item IS a Meta write preview — the canonical HMAC
   *  digest (computeMetaWriteManifestDigest) this exact write was previewed
   *  under. An 'approve' answer on this item is what a write's grant check
   *  (findApprovalDeckAnswerForDigest) looks for. */
  metaWriteManifestDigest?: string;
  /** Present iff this item IS a Meta write preview — the exact parameters
   *  needed to dispatch this write later, without the model ever re-calling
   *  the tool (ENG-1635/1644 Round 3 consequence #3/#1). Always present
   *  together with metaWriteManifestDigest; step-per-write dispatch reads
   *  this off each approved item to build its WorkflowStepDefinition. */
  metaWriteDispatch?: {
    entity_type: string;
    action: string;
    account_id: string;
    /** ENG-1644: the account getMetaCredentials actually resolved for this
     *  preview, frozen as a plain value — additive alongside the raw
     *  account_id above (which must stay raw for digest-matching). A durable,
     *  cross-session resume must dispatch against this frozen id rather than
     *  re-deriving one from live connected-accounts state, which can drift
     *  between preview and a delayed approval. Absent on any record created
     *  before this field existed. */
    resolvedAccountId?: string;
    campaign_id?: string;
    ad_set_id?: string;
    ad_id?: string;
    params: unknown;
  };
  /** Option-item only (Phase 2f) — when true, the card offers a "Let Emma
   *  decide" delegation button for THIS item, resolving to its recommended
   *  option. Same non-model-attributed `answeredBy: 'delegation'` invariant
   *  as AskUserQuestion's own delegation — never a model self-answer. */
  allowEmmaDecide?: boolean;
  /** Mirrors PendingUserQuestion.immutable exactly (ask_user_question/
   *  objective-gate migration). When true, headless auto-take must never
   *  resolve this item on its own regardless of autonomy level other than
   *  `fullAutonomy` — the objective-reconfirmation gate always sets this.
   *  Absent/false means auto-take may delegate to the recommended option
   *  under the existing `fullAutonomy || !immutable` rule. */
  immutable?: boolean;
}

export interface ApprovalDeckAnswer {
  itemId: string;
  /** An optionId or 'approve'/'reject' (write item), or the universal 'comment'
   *  verdict — valid on ANY item kind, doesn't execute/decide anything, requires
   *  non-empty freeText. */
  verdict: string;
  /** A correction/reason, only meaningful when the item allows it. Lands
   *  inside the REBUILT item's `params` when Emma acts on it — which is what
   *  binds free-text content into the next digest (gap 4), not this field
   *  itself. */
  freeText?: string;
  /** 'user' = explicit human submission; 'delegation' = explicit delegation
   *  choice. Never 'model' — see file header. */
  answeredBy: ApprovalDeckAnsweredBy;
  /** ISO timestamp this specific answer landed. */
  at: string;
}

/** One front-loaded question, as present_question_deck's execute() returns it
 *  (already normalized — every option carries a stable id) — the same shape
 *  used both live (building a question-deck) and stashed (a dropped one). */
export interface QuestionDeckQuestionInput {
  question: string;
  options: AskUserQuestionOption[];
  allowEmmaDecide?: boolean;
  /** Correlator preserved through a dropped/re-asked round-trip (mirrors
   *  ApprovalDeckItem.kind) — e.g. 'meta_objective' for the objective gate's
   *  deck-of-one item, so a re-ask after drop/cancel can still be identified. */
  kind?: string;
  /** Mirrors ApprovalDeckItem.immutable — preserved through the same
   *  dropped/re-asked round-trip so a re-asked immutable item is rebuilt as
   *  immutable, not silently downgraded to auto-takeable. */
  immutable?: boolean;
}

export interface PendingApprovalDeck {
  deckId: string;
  items: ApprovalDeckItem[];
  status: ApprovalDeckStatus;
  /** Present only once status === 'answered'; one entry per item, no more, no fewer. */
  answers?: ApprovalDeckAnswer[];
  createdAt: string;
  /** Present only once status has passed 'building' — the building->awaiting signal (gap 2). */
  finalizedAt?: string;
  /** ENG-1635/1644 v3 (round 6): set when a mixed turn produced BOTH a write
   *  halt and a present_question_deck halt — writes win the slot, so these
   *  questions were dropped from THIS deck rather than shown. Read (and
   *  cleared) when this write-deck is later answered OR cancelled, so the
   *  re-ask directive reaches Emma through answerAck/messageContent — never
   *  through userMessage. Only ever set on a 'meta_write' deck. */
  droppedQuestionDeckPayload?: QuestionDeckQuestionInput[];
}

export class ApprovalDeckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalDeckError';
  }
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

function validateItemShape(item: ApprovalDeckItem, existingIds: ReadonlySet<string>): void {
  if (typeof item.itemId !== 'string' || item.itemId.trim() === '') {
    throw new ApprovalDeckError('Each deck item needs a non-empty itemId');
  }
  if (existingIds.has(item.itemId)) {
    throw new ApprovalDeckError(`Duplicate deck item id: ${item.itemId}`);
  }
  if (typeof item.kind !== 'string' || item.kind.trim() === '') {
    throw new ApprovalDeckError(`Item ${item.itemId} needs a non-empty kind`);
  }
  if (typeof item.question !== 'string' || item.question.trim() === '') {
    throw new ApprovalDeckError(`Item ${item.itemId} needs non-empty question text`);
  }

  const isWriteItem = typeof item.metaWriteManifestDigest === 'string' && item.metaWriteManifestDigest.trim() !== '';
  if (isWriteItem) {
    if (item.options !== undefined) {
      throw new ApprovalDeckError(
        `Item ${item.itemId} carries a metaWriteManifestDigest — it uses the fixed approve/reject ` +
          `verdict vocabulary and must not also declare options`,
      );
    }
    if (!item.metaWriteDispatch) {
      throw new ApprovalDeckError(
        `Item ${item.itemId} carries a metaWriteManifestDigest but no metaWriteDispatch — ` +
          `step-per-write dispatch would have nothing to execute once this item is approved`,
      );
    }
    return;
  }

  // Not a write item — must be a plain multi-option decision.
  if (!Array.isArray(item.options) || item.options.length < MIN_OPTIONS || item.options.length > MAX_OPTIONS) {
    throw new ApprovalDeckError(
      `Item ${item.itemId} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options (or a metaWriteManifestDigest), got ` +
        `${Array.isArray(item.options) ? item.options.length : 'none'}`,
    );
  }
  const ids = new Set<string>();
  for (const opt of item.options) {
    if (!opt || typeof opt.id !== 'string' || opt.id.trim() === '') {
      throw new ApprovalDeckError(`Item ${item.itemId}: each option needs a non-empty id`);
    }
    // Reserved word guard: 'comment' is the universal 3rd verdict, checked ahead
    // of write/option branching in applyDeckAnswers — an option genuinely named
    // that would be misread as the comment verdict on submission. Only 'comment'
    // collides: a write item can never carry options[] at all (checked above),
    // so 'approve'/'reject' are never compared against an option id.
    if (opt.id === 'comment') {
      throw new ApprovalDeckError(`Item ${item.itemId}: option id 'comment' is reserved for the universal comment verdict`);
    }
    if (ids.has(opt.id)) {
      throw new ApprovalDeckError(`Item ${item.itemId}: duplicate option id ${opt.id}`);
    }
    ids.add(opt.id);
    if (typeof opt.label !== 'string' || opt.label.trim() === '') {
      throw new ApprovalDeckError(`Item ${item.itemId}: option ${opt.id} needs a non-empty label`);
    }
  }

  // Same invariant askUserQuestion.ts's resolveRecommendedOptionId enforces for a
  // real PendingUserQuestion — the recommendation is the product, never zero,
  // never ambiguous. approvalDeck.ts never had this check even for its existing
  // plan_choice fixture path; present_question_deck (Phase 2) makes it reachable
  // from real model-authored input, so it can no longer go unenforced.
  const recommended = item.options.filter((o) => o.recommended === true);
  if (recommended.length !== 1) {
    throw new ApprovalDeckError(
      `Item ${item.itemId}: exactly one option must be recommended, got ${recommended.length}`,
    );
  }
}

/** Construct an empty deck in the 'building' state. Items are added one at a
 *  time via `appendApprovalDeckItem` as Emma determines them. */
export function createApprovalDeck(deckId: string, createdAt: string): PendingApprovalDeck {
  if (typeof deckId !== 'string' || deckId.trim() === '') {
    throw new ApprovalDeckError('deckId is required');
  }
  return { deckId, items: [], status: 'building', createdAt };
}

/** Append one item while the deck is still 'building'. Returns a NEW deck
 *  (does not mutate the input) — same immutable-update convention as
 *  askUserQuestion.ts's applyAnswer. */
export function appendApprovalDeckItem(deck: PendingApprovalDeck, item: ApprovalDeckItem): PendingApprovalDeck {
  if (deck.status !== 'building') {
    throw new ApprovalDeckError(
      `Cannot append to deck ${deck.deckId} — status is '${deck.status}', not 'building'. ` +
        `A deck already shown to the user (or answered) is closed to new items.`,
    );
  }
  validateItemShape(item, new Set(deck.items.map((existing) => existing.itemId)));
  return { ...deck, items: [...deck.items, item] };
}

/** Transition 'building' -> 'awaiting' (gap 2's explicit completion signal).
 *  Only an 'awaiting' deck is ever shown to the user or answerable — this is
 *  what stops a later append from arriving after the user already answered,
 *  and what stops an incomplete deck from ever being shown at all. */
export function finalizeApprovalDeck(deck: PendingApprovalDeck, finalizedAt: string): PendingApprovalDeck {
  if (deck.status !== 'building') {
    throw new ApprovalDeckError(`Cannot finalize deck ${deck.deckId} — status is already '${deck.status}'`);
  }
  if (deck.items.length === 0) {
    throw new ApprovalDeckError(`Cannot finalize deck ${deck.deckId} — it has no items`);
  }
  return { ...deck, status: 'awaiting', finalizedAt };
}

/** One inbound answer as posted by the structured deck-submission channel
 *  (never derived from model tool-call arguments — see file header). */
export interface InboundDeckAnswer {
  itemId: string;
  verdict: string;
  freeText?: string;
  /** Phase 2f: true when reached via "Let Emma decide" on THIS item — the
   *  discriminated-per-item version of askUserQuestion.ts's resolveInboundAnswer
   *  delegation branch, generalized to a batch (a submission can have some
   *  items delegated and others directly answered). When true, `verdict` is
   *  IGNORED and the item's recommended option is used instead — same "a
   *  stray client-supplied verdict can never become a silent different
   *  choice" guarantee the single-question primitive already has. */
  delegated?: boolean;
}

/**
 * Apply a full, one-shot submission of answers (one per item — no partial
 * submissions, no re-answering one item later) and transition the deck to
 * 'answered'. `answeredBy` is the default for the whole submission, but a
 * per-item `delegated:true` overrides it to 'delegation' for THAT item only —
 * mirroring resolveInboundAnswer's derivation from provenance, generalized so
 * one submission can mix directly-answered and delegated items.
 */
export function applyDeckAnswers(
  deck: PendingApprovalDeck,
  inbound: InboundDeckAnswer[],
  answeredBy: ApprovalDeckAnsweredBy,
  at: string,
): PendingApprovalDeck {
  if (deck.status !== 'awaiting') {
    throw new ApprovalDeckError(`Cannot answer deck ${deck.deckId} — status is '${deck.status}', not 'awaiting'`);
  }
  if (answeredBy !== 'user' && answeredBy !== 'delegation') {
    // The model can never be the answerer — this is the core barrier (see file header).
    throw new ApprovalDeckError(`Invalid answeredBy: ${String(answeredBy)}`);
  }
  if (!Array.isArray(inbound) || inbound.length !== deck.items.length) {
    throw new ApprovalDeckError(
      `Deck ${deck.deckId} has ${deck.items.length} item(s) but the submission answered ` +
        `${Array.isArray(inbound) ? inbound.length : 0} — every item needs exactly one answer`,
    );
  }

  const seenItemIds = new Set<string>();
  const answers: ApprovalDeckAnswer[] = deck.items.map((item) => {
    const answer = inbound.find((candidate) => candidate.itemId === item.itemId);
    if (!answer) {
      throw new ApprovalDeckError(`Missing answer for deck item ${item.itemId}`);
    }
    if (seenItemIds.has(item.itemId)) {
      throw new ApprovalDeckError(`Duplicate answer for deck item ${item.itemId}`);
    }
    seenItemIds.add(item.itemId);

    const isDelegated = answer.delegated === true;
    let verdict = answer.verdict;
    if (item.metaWriteDispatch?.action === 'CREATE_PAUSED_BUNDLE' && verdict === 'approve' && (answeredBy !== 'user' || isDelegated)) {
      throw new ApprovalDeckError('A paused campaign bundle needs explicit user approval.');
    }
    if (isDelegated) {
      // Deterministic, never re-inferred: a stray client-supplied verdict on a
      // delegated answer must never become a silent different choice — same
      // guarantee askUserQuestion.ts's resolveInboundAnswer already has. Only
      // an option item can be delegated (a write item has no "recommended
      // option" concept); a write item here has no options, so the find below
      // returns undefined and this correctly rejects rather than delegating
      // to an approve/reject it never chose.
      const recommended = item.options?.find((option) => option.recommended === true);
      if (!recommended) {
        throw new ApprovalDeckError(`Item ${item.itemId}: delegation requires a recommended option, but this item has none`);
      }
      verdict = recommended.id;
    }

    if (verdict === 'comment') {
      // Universal 3rd verdict — valid on ANY item kind (write or option-based),
      // unlike reject-with-correction below which stays gated on allowFreeText.
      // A comment with nothing said is meaningless, so unlike reject, freeText
      // is required here, not merely permitted.
      if (typeof answer.freeText !== 'string' || answer.freeText.trim() === '') {
        throw new ApprovalDeckError(`Item ${item.itemId}: a 'comment' verdict requires non-empty freeText`);
      }
    } else {
      const isWriteItem = typeof item.metaWriteManifestDigest === 'string' && item.metaWriteManifestDigest.trim() !== '';
      if (isWriteItem) {
        if (verdict !== 'approve' && verdict !== 'reject') {
          throw new ApprovalDeckError(
            `Item ${item.itemId} is a Meta write preview — verdict must be 'approve', 'reject', or 'comment', got '${verdict}'`,
          );
        }
      } else if (!item.options?.some((option) => option.id === verdict)) {
        throw new ApprovalDeckError(`Item ${item.itemId}: '${verdict}' is not one of its options`);
      }
      if (typeof answer.freeText === 'string' && answer.freeText.trim() !== '' && item.allowFreeText !== true) {
        throw new ApprovalDeckError(`Item ${item.itemId} does not allow a free-text answer`);
      }
    }

    return {
      itemId: item.itemId,
      verdict,
      ...(typeof answer.freeText === 'string' && answer.freeText.trim() !== '' ? { freeText: answer.freeText } : {}),
      answeredBy: isDelegated ? 'delegation' : answeredBy,
      at,
    };
  });

  return { ...deck, status: 'answered', answers };
}

/**
 * Every write item the user approved, paired with its answer — the input to
 * step-per-write dispatch (one WorkflowStepDefinition per entry). A rejected
 * item is simply absent here; no separate "reject payload" plumbing exists.
 */
export function approvedWriteItems(
  deck: PendingApprovalDeck,
): Array<{ item: ApprovalDeckItem; answer: ApprovalDeckAnswer }> {
  if (deck.status !== 'answered' || !deck.answers) return [];
  const results: Array<{ item: ApprovalDeckItem; answer: ApprovalDeckAnswer }> = [];
  for (const item of deck.items) {
    if (!item.metaWriteManifestDigest) continue;
    const answer = deck.answers.find((candidate) => candidate.itemId === item.itemId);
    if (answer?.verdict === 'approve') results.push({ item, answer });
  }
  return results;
}

export type ApprovalDeckGrantOutcome =
  | { granted: true; item: ApprovalDeckItem; answer: ApprovalDeckAnswer }
  | { granted: false; reason: string };

/**
 * The consumer guard for a Meta write — the deck's equivalent of
 * askUserQuestion's checkQuestionGate. `callMetaMarketingApi`'s gate (ENG-1635
 * gap 5 fix) calls this with the session's FRESH pendingApprovalDeck before
 * treating a write as grantable; the caller still owns the at-most-once
 * CONSUME (chatbotService's digest-claim, same shape as today's
 * claimMetaWriteManifestGrant) — this function only answers "does an
 * answered, human-attributed deck item approve this exact digest," never
 * marks anything consumed.
 */
export function findApprovalDeckAnswerForDigest(
  deck: PendingApprovalDeck | null | undefined,
  digest: string,
): ApprovalDeckGrantOutcome {
  if (!deck || deck.status !== 'answered' || !deck.answers) {
    return { granted: false, reason: 'No answered approval deck in this session.' };
  }
  const item = deck.items.find((candidate) => candidate.metaWriteManifestDigest === digest);
  if (!item) {
    return { granted: false, reason: 'This exact write was not previewed in any deck item.' };
  }
  const answer = deck.answers.find((candidate) => candidate.itemId === item.itemId);
  if (!answer || answer.verdict !== 'approve') {
    return { granted: false, reason: 'This write item was not approved.' };
  }
  if (answer.answeredBy !== 'user' && answer.answeredBy !== 'delegation') {
    // Defensive re-check — the type already forbids 'model', mirrors checkQuestionGate.
    return { granted: false, reason: 'The approval was not attributable to a human selection.' };
  }
  return { granted: true, item, answer };
}

/**
 * ENG-1748: name WHICH fields drifted when a Meta write's digest has no grant
 * but the same target (entity/action/account/ids) WAS approved in the answered
 * deck with different params. Purely explanatory — the grant decision stays
 * findApprovalDeckAnswerForDigest's digest match; this never grants anything.
 * Returns the sorted top-level param keys whose values differ (gate-only flags
 * `confirm`/`tracking_override_token` ignored), or null when there is no
 * approved same-target item to compare against or nothing differs.
 */
export function describeMetaWriteParamDrift(
  deck: PendingApprovalDeck | null | undefined,
  call: {
    entity_type: string;
    action: string;
    account_id?: string;
    campaign_id?: string;
    ad_set_id?: string;
    ad_id?: string;
    params: unknown;
  },
): string[] | null {
  if (!deck || deck.status !== 'answered' || !deck.answers) return null;
  const same = (a: unknown, b: unknown) => (a ?? undefined) === (b ?? undefined);
  const approvedItems = deck.items.filter((item) => {
    const d = item.metaWriteDispatch;
    if (!d) return false;
    const answer = deck.answers!.find((candidate) => candidate.itemId === item.itemId);
    if (!answer || answer.verdict !== 'approve') return false;
    return d.entity_type === call.entity_type && d.action === call.action &&
      same(d.account_id, call.account_id) && same(d.campaign_id, call.campaign_id) &&
      same(d.ad_set_id, call.ad_set_id) && same(d.ad_id, call.ad_id);
  });
  if (!approvedItems.length) return null;
  const ignored = new Set(['confirm', 'tracking_override_token']);
  const asRecord = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const after = asRecord(call.params);
  const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as any)[k]]))
      : val) ?? 'undefined';
  // Compare against EVERY approved same-target item: if any matches on all
  // compared params there is no drift to report; otherwise report the item
  // with the fewest differing fields (closest approved version).
  let best: string[] | null = null;
  for (const item of approvedItems) {
    const before = asRecord(item.metaWriteDispatch!.params);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => !ignored.has(key) && stable(before[key]) !== stable(after[key]))
      .sort();
    if (!changed.length) return null;
    if (!best || changed.length < best.length) best = changed;
  }
  return best;
}

/** ENG-1748: user-facing drift sentence appended to a halted Meta write summary. */
export function formatMetaWriteParamDriftMessage(drifted: string[]): string {
  return ` CHANGED SINCE APPROVAL: ${drifted.join(', ')} differ from the version you approved, ` +
    `so that approval does not cover this write and nothing was sent to Meta.`;
}

/** The shape of a persisted chat message this module cares about — deliberately
 *  minimal so this stays a pure function of already-fetched data (the file
 *  header's "no I/O" rule); the caller (e.g. resolveCampaignObjectiveGate)
 *  owns fetching the real message list via chatbotDb. */
export interface ApprovalDeckHistoryMessage {
  metadata?: {
    pendingApprovalDeckId?: string;
    approvalDeckItems?: ApprovalDeckItem[];
    approvalDeckAnswer?: { deckId: string; answers: ApprovalDeckAnswer[] };
  } | null;
}

export type ApprovalDeckHistoryOutcome =
  | { found: true; item: ApprovalDeckItem; answer: ApprovalDeckAnswer }
  | { found: false };

/**
 * ENG-1635/1644 (ask_user_question retirement) — the deck primitive's sibling
 * to askUserQuestion.ts's `findQuestionByKind`, for a producer (e.g. the Meta
 * objective gate) that needs to find an already-answered item by its `kind`
 * correlator across THIS session's history. Decks have no archive
 * table/field (file header) — history only exists as message-metadata pairs
 * (the halt message carries `approvalDeckItems` + `pendingApprovalDeckId`,
 * the reply message carries `approvalDeckAnswer`), the exact same
 * self-contained pairing the frontend already reconstructs historical cards
 * from. Pure: the caller fetches `messages` and passes them in. Returns the
 * FIRST match scanning oldest-to-newest — callers are expected to pass a
 * `kind` specific enough (e.g. a composite `meta_objective:<correlator>`,
 * mirroring findQuestionByKind's own exact-match contract) that only one
 * real match should ever exist.
 */
export function findAnsweredDeckItemByKind(
  messages: ApprovalDeckHistoryMessage[],
  kind: string,
): ApprovalDeckHistoryOutcome {
  for (const message of messages) {
    const items = message.metadata?.approvalDeckItems;
    const deckId = message.metadata?.pendingApprovalDeckId;
    if (!Array.isArray(items) || !deckId) continue;
    const item = items.find((candidate) => candidate.kind === kind);
    if (!item) continue;
    const reply = messages.find((candidate) => candidate.metadata?.approvalDeckAnswer?.deckId === deckId);
    const answer = reply?.metadata?.approvalDeckAnswer?.answers.find((candidate) => candidate.itemId === item.itemId);
    // Same defensive human-attribution re-check checkQuestionGate/
    // findApprovalDeckAnswerForDigest already do — the type forbids 'model'
    // already, this just never trusts a malformed/legacy record blindly.
    if (answer && (answer.answeredBy === 'user' || answer.answeredBy === 'delegation')) {
      return { found: true, item, answer };
    }
  }
  return { found: false };
}

/**
 * Rebuilds a fully 'answered' PendingApprovalDeck for `deckId` purely from
 * message history — for the ONE case where a deck's own session field no
 * longer holds it: resuming a workflow run whose steps were built from a
 * deck that a LATER deck has since overwritten in `session.pendingApprovalDeck`
 * (see agentModeService.ts's stuck-run resume, ENG-1635/1644). Same
 * halt-message/reply-message pairing as findAnsweredDeckItemByKind, just
 * returning the whole deck instead of one item. Returns null if no such
 * answered deck is found in this history (the caller has no fallback at that
 * point — it means the deck genuinely isn't reconstructable, not that it's
 * safe to skip).
 */
export function reconstructApprovalDeckFromHistory(
  messages: ApprovalDeckHistoryMessage[],
  deckId: string,
): PendingApprovalDeck | null {
  const halt = messages.find((message) => message.metadata?.pendingApprovalDeckId === deckId);
  const items = halt?.metadata?.approvalDeckItems;
  if (!Array.isArray(items) || items.length === 0) return null;
  const reply = messages.find((message) => message.metadata?.approvalDeckAnswer?.deckId === deckId);
  const answers = reply?.metadata?.approvalDeckAnswer?.answers;
  if (!Array.isArray(answers) || answers.length !== items.length) return null;
  return { deckId, items, status: 'answered', answers, createdAt: new Date(0).toISOString() };
}

/**
 * Render the deck as a plain-text prompt — the accessible/non-card mirror,
 * same role as askUserQuestion's renderQuestionPrompt. Carries no instruction
 * on how to answer; only an inbound structured submission can resolve a deck.
 */
export function renderApprovalDeckPrompt(deck: PendingApprovalDeck): string {
  const lines = deck.items.map((item, i) => {
    const isWriteItem = Boolean(item.metaWriteManifestDigest);
    const verdictHint = isWriteItem
      ? '(approve / reject)'
      : `(${(item.options ?? []).map((o) => o.label).join(' / ')})`;
    return `${i + 1}. ${item.question} ${verdictHint}`;
  });
  return `Review the following ${deck.items.length} item(s) and submit your answers for all of them at once:\n\n${lines.join('\n')}`;
}
