import { resetDateFromMonth, formatResetDateLong } from "./usageCycle";

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
}

/** `payg_cap_reached`: past the pool AND the cap the customer chose. `payg_suspended`: settlement failed. */
export type UsageBlockReason = "payg_cap_reached" | "payg_suspended";

const HEADLINE = "Your monthly AI usage is paused";
const BODY = "You've used all of the AI usage included in your plan this month.";
const ACTION_TAIL = "Add usage or upgrade your plan to keep working before then.";

const PAYG_COPY: Record<UsageBlockReason, { headline: string; body: string; actionTail: string; undated: string }> = {
  payg_cap_reached: {
    headline: "You've reached your pay-as-you-go limit",
    body: "You've used all of the AI usage included in your plan this month and the pay-as-you-go limit you set.",
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

/**
 * Pre-ENG-1344 wording, kept verbatim as the fallback. It is vague — which is the
 * defect — but it is TRUE. A customer who plans around an invented date is worse
 * off than one who has to go looking for it.
 */
const UNDATED_MESSAGE =
  "AI usage is paused until your next reset or additional usage is added.";

export function buildUsageBlockCopy(input: {
  month?: string | null;
  reason?: UsageBlockReason | null;
}): UsageBlockCopy {
  const resetDate = resetDateFromMonth(input.month);
  const label = formatResetDateLong(resetDate);
  const resetSentence = label ? `Your included usage resets on ${label}.` : null;

  const payg = input.reason ? PAYG_COPY[input.reason] : undefined;
  if (payg) {
    return {
      resetDate,
      headline: payg.headline,
      body: payg.body,
      resetSentence,
      message: resetSentence ? `AI usage is paused. ${resetSentence} ${payg.actionTail}` : payg.undated,
      reason: input.reason!,
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
