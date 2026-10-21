/**
 * ENG-668 PR-2: every customer-facing sentence month-end pay-as-you-go settlement produces, in one
 * place for copy review — the two owner emails, and the description Stripe prints on the invoice.
 *
 * Percentages only, never dollars, in anything AgentWeb writes: the Stripe invoice is the one place the
 * amount appears, the same rule the PAYG settings and the 429 follow ("N% of your limit"). The invoice
 * description is the exception by nature — it sits next to the amount Stripe renders.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `2026-09` -> `September 2026`; the raw string when it is not a `YYYY-MM` month. */
export function formatUsageMonth(month: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : month;
}

/** The Stripe invoice's own description and its single line item. */
export function paygOverageInvoiceCopy(month: string): { description: string; lineDescription: string } {
  const label = formatUsageMonth(month);
  return {
    description: `AgentWeb pay-as-you-go usage for ${label}`,
    lineDescription: `AI usage beyond your plan's included usage, ${label} (pay-as-you-go)`,
  };
}

export interface PaygSettlementEmailCopy {
  subject: string;
  headline: string;
  paragraphs: string[];
  /** Link text for the Stripe-hosted invoice, when there is one. */
  invoiceLinkLabel?: string;
  /** Link text for the pay-as-you-go settings. */
  settingsLinkLabel: string;
}

/**
 * Sent once, when the month's overage invoice is created — or, when Stripe had already collected it by
 * then (`paid`: a credit balance, an instant charge, a held month's invoice paid later), in the paid
 * wording, so the owner is never told a card "will" be charged for an invoice that is settled.
 */
export function paygInvoiceCreatedEmailCopy(input: { month: string; percentOfCap: number; paid?: boolean }): PaygSettlementEmailCopy {
  const label = formatUsageMonth(input.month);
  const percent = Math.max(0, Math.min(100, Math.floor(input.percentOfCap)));
  return {
    subject: `Your pay-as-you-go invoice for ${label}`,
    headline: `Pay-as-you-go invoice for ${label}`,
    paragraphs: [
      // The bill is measured against the highest limit in force during the month (the limit is a monthly
      // total), so the percentage is of that limit — the one the amount actually follows.
      `In ${label} your team kept working past the AI usage included in your plan, using ${percent}% of the highest pay-as-you-go limit you had set that month.`,
      input.paid
        ? 'Stripe has issued an invoice for that usage, and it has already been paid. The invoice shows the amount.'
        : 'Stripe has issued an invoice for that usage and will charge the payment method on file. The invoice shows the amount.',
    ],
    invoiceLinkLabel: 'View your invoice',
    settingsLinkLabel: 'Review your pay-as-you-go settings',
  };
}

/**
 * Sent once, when the bank holds the month's overage charge for the owner to confirm (3-D Secure or a
 * mandate). Pay-as-you-go stays on; nothing is suspended unless the payment then fails.
 */
export function paygPaymentActionRequiredEmailCopy(input: { month: string }): PaygSettlementEmailCopy {
  const label = formatUsageMonth(input.month);
  return {
    subject: `Confirm your pay-as-you-go payment for ${label}`,
    headline: 'Your bank needs you to confirm a payment',
    paragraphs: [
      `Your bank asked for confirmation before charging your card for your pay-as-you-go usage in ${label}.`,
      'Open the invoice to confirm the payment. Pay-as-you-go stays on while it is pending.',
    ],
    invoiceLinkLabel: 'Confirm your payment',
    settingsLinkLabel: 'Review your pay-as-you-go settings',
  };
}

/** Sent once, when the month's overage charge fails and pay-as-you-go is put on hold. */
export function paygPaymentFailedEmailCopy(input: { month: string }): PaygSettlementEmailCopy {
  const label = formatUsageMonth(input.month);
  return {
    subject: `Action needed: your pay-as-you-go payment for ${label} didn't go through`,
    headline: 'Pay-as-you-go is on hold',
    paragraphs: [
      `We couldn't collect the payment for your pay-as-you-go usage in ${label}.`,
      "Pay-as-you-go is on hold until it's resolved: once your plan's included AI usage runs out, AI usage pauses instead of continuing.",
      'Update your payment method and pay the invoice to resume pay-as-you-go.',
    ],
    invoiceLinkLabel: 'View and pay your invoice',
    settingsLinkLabel: 'Update your payment method',
  };
}
