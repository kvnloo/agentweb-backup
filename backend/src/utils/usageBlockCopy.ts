import { resetDateFromMonth, formatResetDateLong, resetSentence } from "./usageCycle";

/**
 * The ONE producer of "why am I blocked and when does it lift".
 *
 * ENG-1344 AC6: "MCP and portal say the same thing. The portal copy and the
 * ENG-1035 429 payload are generated from one source, so they cannot drift into
 * two different explanations of the same block."
 *
 * There is no shared package between `agentweb` and `agentweb-customer-portal`
 * and no cross-repo import, so "one source" can only mean one RUNTIME source:
 * the server composes the sentences and every client renders what it is handed.
 * The portal deliberately does NOT derive this from `month` any more — a second
 * implementation that agrees today is exactly the drift this AC names.
 *
 * The ACTION is not in here on purpose. It is the one part that legitimately
 * differs per surface: a modal has buttons and a tier-specific upgrade target,
 * an MCP 429 has neither. Copy that describes the block is shared; copy that
 * offers a control belongs to the surface that owns the control.
 */
export interface UsageBlockCopy {
  /** `YYYY-MM-DD` the included allowance returns, or null when underivable. */
  resetDate: string | null;
  headline: string;
  body: string;
  /** Null when `resetDate` is null — callers omit the line rather than guess. */
  resetSentence: string | null;
  /**
   * Flat one-line rendering, for clients that have no layout to put the pieces
   * into: the 429 `error` field, MCP refusals, log lines.
   */
  message: string;
  /**
   * ENG-668: present only when the block is pay-as-you-go's own, so a client can say why an account
   * that opted into overages is still paused. Absent = the plain included-usage block, unchanged.
   * Additive: every surface keeps `code: 'usage_paused'`.
   */
  reason?: UsageBlockReason;
  /** ENG-668: present only with `reason: 'payg_inactive'` — which PAYG prerequisite is missing. */
  paygInactiveReason?: PaygInactiveReason;
  /**
   * ENG-668: present only with `reason: 'payg_suspended'`, and only when the caller is the billing owner:
   * the Stripe-hosted page of the unpaid overage invoice. Paying it (with any card) lifts the hold.
   */
  openInvoiceUrl?: string;
}

/**
 * `payg_cap_reached`: past the pool AND the cap the customer chose. `payg_suspended`: settlement failed.
 * `payg_inactive`: PAYG is on but cannot cover this (no payment method, or the subscription is not live).
 */
export type UsageBlockReason = "payg_cap_reached" | "payg_suspended" | "payg_inactive";
export type PaygInactiveReason = "no_payment_method" | "subscription_inactive";

/** The PAYG-specific block, as the gates report it. */
export interface UsageBlockPaygInput {
  reason: UsageBlockReason;
  paygInactiveReason?: PaygInactiveReason;
  /** Only with `payg_suspended`: what put pay-as-you-go on hold, which decides what lifts it. */
  paygSuspendedReason?: PaygSuspendedReason;
  /** Only with `payg_suspended`: the caller is a pooled member, so the billing owner resolves it. */
  paygOwnerResolves?: boolean;
  openInvoiceUrl?: string;
}

/**
 * `payment_failed`: paying the open invoice lifts the hold. `payment_unconfirmed`: confirming the payment
 * on the open invoice lifts it. `dispute` / `dispute_lost`: a person lifts it.
 */
export type PaygSuspendedReason = "payment_failed" | "payment_unconfirmed" | "dispute" | "dispute_lost";

const HEADLINE = "Your monthly AI usage is paused";
const BODY = "You've used all of the AI usage included in your plan this month.";
const ACTION_TAIL = "Add usage or upgrade your plan to keep working before then.";

type PaygCopy = { headline: string; body: string; actionTail: string; undated: string };

// ENG-668: customers see this feature as "Extra usage", never "pay-as-you-go" (matching the portal's
// `paygCopy.ts`; ENG-2571 already uses "Pay as you go" for something else). Sentence case: "Extra usage"
// starts a sentence, "extra usage" mid-sentence.
const PAYG_CAP_REACHED_COPY: PaygCopy = {
  headline: "You've reached your extra usage limit",
  body: "You've used all of the AI usage included in your plan this month and your extra usage limit.",
  actionTail: "Raise your extra usage limit or upgrade your plan to keep working before then.",
  undated: "AI usage is paused: you've reached your extra usage limit. Raise the limit or upgrade your plan to keep working.",
};

/**
 * ENG-668 PR-2: a hold says what actually lifts it. A payment-failure hold lifts when the open invoice is
 * paid (with any card, on its hosted page — updating the card alone does not pay it); an unconfirmed
 * payment lifts when the owner confirms it on that invoice; a dispute hold (open or lost) is lifted by a
 * person, so the owner is asked to contact us. With no reason recorded, the same. A pooled member cannot
 * do any of that: they are told the organization owner can resolve it.
 */
const PAYG_SUSPENDED_CAUSE: Record<PaygSuspendedReason | "unknown", { cause: string; ownerAction: string; ownerUndatedAction: string }> = {
  payment_failed: {
    cause: "because a recent payment didn't go through",
    ownerAction: "Pay the open invoice to resume extra usage.",
    ownerUndatedAction: "Pay the open invoice to resume it.",
  },
  payment_unconfirmed: {
    cause: "because a recent payment is still waiting to be confirmed",
    ownerAction: "Open the invoice to confirm the payment and resume extra usage.",
    ownerUndatedAction: "Open the invoice to confirm the payment and resume it.",
  },
  dispute: {
    cause: "while a recent payment is under review with your bank",
    ownerAction: "Please contact us to resume extra usage.",
    ownerUndatedAction: "Please contact us to resume it.",
  },
  dispute_lost: {
    cause: "following a dispute about a recent payment",
    ownerAction: "Please contact us to resume extra usage.",
    ownerUndatedAction: "Please contact us to resume it.",
  },
  unknown: {
    cause: "because of a problem with a recent payment",
    ownerAction: "Please contact us to resume extra usage.",
    ownerUndatedAction: "Please contact us to resume it.",
  },
};
const PAYG_OWNER_RESOLVES = "Your organization owner can resolve this.";

function paygSuspendedCopy(block: UsageBlockPaygInput): PaygCopy {
  const why = block.paygSuspendedReason;
  const copy = PAYG_SUSPENDED_CAUSE[why && why in PAYG_SUSPENDED_CAUSE ? why : "unknown"];
  const actionTail = block.paygOwnerResolves ? PAYG_OWNER_RESOLVES : copy.ownerAction;
  return {
    headline: "Extra usage is on hold",
    body: `You've used all of the AI usage included in your plan this month, and extra usage is on hold ${copy.cause}.`,
    actionTail,
    undated: `AI usage is paused: extra usage is on hold ${copy.cause}. ${block.paygOwnerResolves ? PAYG_OWNER_RESOLVES : copy.ownerUndatedAction}`,
  };
}

const PAYG_INACTIVE_COPY: Record<PaygInactiveReason, PaygCopy> = {
  no_payment_method: {
    headline: "Extra usage needs a payment method",
    body: "You've used all of the AI usage included in your plan this month. Extra usage is on, but there is no payment method on file to cover more.",
    actionTail: "Add a payment method to keep working with extra usage.",
    undated: "AI usage is paused: extra usage is on, but there is no payment method on file. Add one to keep working.",
  },
  subscription_inactive: {
    headline: "Extra usage needs an active subscription",
    body: "You've used all of the AI usage included in your plan this month. Extra usage is on, but it only covers more usage while your subscription is active.",
    actionTail: "Reactivate your subscription to keep working with extra usage.",
    undated: "AI usage is paused: extra usage only covers more usage while your subscription is active. Reactivate it to keep working.",
  },
};

/**
 * The action sentence for a PAYG block (raise the limit, update or add a payment method, reactivate),
 * or null when the block is not PAYG's own. For surfaces that phrase their own text around the shared
 * headline and body — the scheduled-chat email — so their call to action cannot drift from the 429's.
 */
export function paygBlockActionSentence(block: UsageBlockPaygInput | null | undefined): string | null {
  return paygCopyFor(block)?.actionTail ?? null;
}

function paygCopyFor(block: UsageBlockPaygInput | null | undefined): PaygCopy | undefined {
  if (!block) return undefined;
  if (block.reason === "payg_inactive") {
    return block.paygInactiveReason ? PAYG_INACTIVE_COPY[block.paygInactiveReason] : undefined;
  }
  if (block.reason === "payg_suspended") return paygSuspendedCopy(block);
  return block.reason === "payg_cap_reached" ? PAYG_CAP_REACHED_COPY : undefined;
}

/**
 * Pre-ENG-1344 wording, kept verbatim as the fallback. It is vague — which is the
 * defect — but it is TRUE. A customer who plans around an invented date is worse
 * off than one who has to go looking for it.
 */
const UNDATED_MESSAGE =
  "AI usage is paused until your next reset or additional usage is added.";

export function buildUsageBlockCopy(input: {
  month?: string | null;
  /** ENG-668: the PAYG-specific block reason, when there is one. Absent = the plain copy, unchanged. */
  paygBlock?: UsageBlockPaygInput | null;
}): UsageBlockCopy {
  const resetDate = resetDateFromMonth(input.month);
  const label = formatResetDateLong(resetDate);
  const resetSentence = label ? `Your included usage resets on ${label}.` : null;

  const payg = paygCopyFor(input.paygBlock);
  if (payg && input.paygBlock) {
    return {
      resetDate,
      headline: payg.headline,
      body: payg.body,
      resetSentence,
      message: resetSentence ? `AI usage is paused. ${resetSentence} ${payg.actionTail}` : payg.undated,
      reason: input.paygBlock.reason,
      ...(input.paygBlock.reason === "payg_inactive"
        ? { paygInactiveReason: input.paygBlock.paygInactiveReason }
        : {}),
      ...(input.paygBlock.reason === "payg_suspended" && input.paygBlock.openInvoiceUrl
        ? { openInvoiceUrl: input.paygBlock.openInvoiceUrl }
        : {}),
    };
  }

  return {
    resetDate,
    headline: HEADLINE,
    body: BODY,
    resetSentence,
    message: resetSentence
      ? `AI usage is paused. ${resetSentence} ${ACTION_TAIL}`
      : UNDATED_MESSAGE,
  };
}

/**
 * The run-result text a scheduled chat records when the usage gate refuses it (agentModeController
 * `runScheduledChat`). Unlike the shared copy above it ends with an action, because the run result is
 * the only place the schedule owner reads it.
 *
 * ENG-1344: both branches used to end at the word "reset" with no date. The reset sentence is appended
 * rather than interpolated so the percentage branch keeps its own leading clause, and so a month we
 * cannot parse drops the sentence instead of rendering "resets on null".
 *
 * ENG-668: a pay-as-you-go account is past its plan pool by design, so the plan percentage is not the
 * limit that stopped it (and can read far above 100%). For a PAYG block, say which PAYG limit did, in
 * the 429's own words, and print no percentage.
 */
export function buildScheduledChatBlockMessage(input: {
  usageMode?: string | null;
  limitPercent: number;
  month?: string | null;
  paygBlock?: UsageBlockPaygInput | null;
}): string {
  if (input.paygBlock) {
    const copy = buildUsageBlockCopy({ month: input.month, paygBlock: input.paygBlock });
    if (copy.reason) return `Scheduled chat cannot run: ${copy.headline}. ${copy.message}`;
  }
  return [
    input.usageMode === "paused"
      ? "Scheduled chat cannot run: AI usage is paused."
      : `Scheduled chat cannot run: you've reached your monthly usage limit (${input.limitPercent}% used).`,
    resetSentence(input.month),
    "Add usage or upgrade your plan to keep working before then.",
  ]
    .filter(Boolean)
    .join(" ");
}
