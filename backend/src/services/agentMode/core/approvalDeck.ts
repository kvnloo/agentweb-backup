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
}

export interface ApprovalDeckAnswer {
  itemId: string;
  /** An optionId (plain item) or 'approve'/'reject' (write item). */
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

export interface PendingApprovalDeck {
  deckId: string;
  items: ApprovalDeckItem[];
  status: ApprovalDeckStatus;
  /** Present only once status === 'answered'; one entry per item, no more, no fewer. */
  answers?: ApprovalDeckAnswer[];
  createdAt: string;
  /** Present only once status has passed 'building' — the building->awaiting signal (gap 2). */
  finalizedAt?: string;
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
    if (ids.has(opt.id)) {
      throw new ApprovalDeckError(`Item ${item.itemId}: duplicate option id ${opt.id}`);
    }
    ids.add(opt.id);
    if (typeof opt.label !== 'string' || opt.label.trim() === '') {
      throw new ApprovalDeckError(`Item ${item.itemId}: option ${opt.id} needs a non-empty label`);
    }
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
}

/**
 * Apply a full, one-shot submission of answers (one per item — no partial
 * submissions, no re-answering one item later) and transition the deck to
 * 'answered'. `answeredBy` is a single value for the whole submission,
 * mirroring resolveInboundAnswer's derivation from the request's own
 * provenance rather than any per-item client-supplied flag.
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

    const isWriteItem = typeof item.metaWriteManifestDigest === 'string' && item.metaWriteManifestDigest.trim() !== '';
    if (isWriteItem) {
      if (answer.verdict !== 'approve' && answer.verdict !== 'reject') {
        throw new ApprovalDeckError(
          `Item ${item.itemId} is a Meta write preview — verdict must be 'approve' or 'reject', got '${answer.verdict}'`,
        );
      }
    } else if (!item.options?.some((option) => option.id === answer.verdict)) {
      throw new ApprovalDeckError(`Item ${item.itemId}: '${answer.verdict}' is not one of its options`);
    }
    if (typeof answer.freeText === 'string' && answer.freeText.trim() !== '' && item.allowFreeText !== true) {
      throw new ApprovalDeckError(`Item ${item.itemId} does not allow a free-text answer`);
    }

    return {
      itemId: item.itemId,
      verdict: answer.verdict,
      ...(typeof answer.freeText === 'string' && answer.freeText.trim() !== '' ? { freeText: answer.freeText } : {}),
      answeredBy,
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
