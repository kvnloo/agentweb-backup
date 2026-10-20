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
}

const HEADLINE = "Your monthly AI usage is paused";
const BODY = "You've used all of the AI usage included in your plan this month.";
const ACTION_TAIL = "Add usage or upgrade your plan to keep working before then.";

type PaygCopy = { headline: string; body: string; actionTail: string; undated: string };

const PAYG_COPY: Record<"payg_cap_reached" | "payg_suspended", PaygCopy> = {
  payg_cap_reached: {
    headline: "You've reached your pay-as-you-go limit",
    body: "You've used all of the AI usage included in your plan this month and your pay-as-you-go limit.",
    actionTail: "Raise your pay-as-you-go limit or upgrade your plan to keep working before then.",
    undated: "AI usage is paused: you've reached your pay-as-you-go limit. Raise the limit or upgrade your plan to keep working.",
  },
  payg_suspended: {
    headline: "Pay-as-you-go is on hold",
    body: "You've used all of the AI usage included in your plan this month, and pay-as-you-go is on hold because of a problem with a recent payment.",
    actionTail: "Update your payment method to resume pay-as-you-go.",
    undated: "AI usage is paused: pay-as-you-go is on hold because of a payment problem. Update your payment method to resume it.",
  },
};

const PAYG_INACTIVE_COPY: Record<PaygInactiveReason, PaygCopy> = {
  no_payment_method: {
    headline: "Pay-as-you-go needs a payment method",
    body: "You've used all of the AI usage included in your plan this month. Pay-as-you-go is on, but there is no payment method on file to cover more.",
    actionTail: "Add a payment method to keep working with pay-as-you-go.",
    undated: "AI usage is paused: pay-as-you-go is on, but there is no payment method on file. Add one to keep working.",
  },
  subscription_inactive: {
    headline: "Pay-as-you-go needs an active subscription",
    body: "You've used all of the AI usage included in your plan this month. Pay-as-you-go is on, but it only covers more usage while your subscription is active.",
    actionTail: "Reactivate your subscription to keep working with pay-as-you-go.",
    undated: "AI usage is paused: pay-as-you-go only covers more usage while your subscription is active. Reactivate it to keep working.",
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
  return PAYG_COPY[block.reason];
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
