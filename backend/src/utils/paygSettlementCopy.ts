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

/** Sent once, when the month's overage invoice is created. */
export function paygInvoiceCreatedEmailCopy(input: { month: string; percentOfCap: number }): PaygSettlementEmailCopy {
  const label = formatUsageMonth(input.month);
  const percent = Math.max(0, Math.min(100, Math.floor(input.percentOfCap)));
  return {
    subject: `Your pay-as-you-go invoice for ${label}`,
    headline: `Pay-as-you-go invoice for ${label}`,
    paragraphs: [
      `In ${label} your team kept working past the AI usage included in your plan, using ${percent}% of the pay-as-you-go limit you set.`,
      'Stripe has issued an invoice for that usage and will charge the payment method on file. The invoice shows the amount.',
    ],
    invoiceLinkLabel: 'View your invoice',
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
