/**
 * ENG-668 PR-2 — the owner emails settlement sends say a percentage of the cap, never an amount.
 *
 * The Stripe invoice the email links to is the one place the dollar figure appears, the same
 * percentages-only rule the PAYG settings and the 429 follow. The copy lives in
 * utils/paygSettlementCopy.ts; these render it through emailService and read what would be sent.
 */
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/db', () => ({ userDb: {}, scheduleDb: {} }));

import { emailService } from '../services/emailService';
import {
  formatUsageMonth,
  paygInvoiceCreatedEmailCopy,
  paygOverageInvoiceCopy,
  paygPaymentActionRequiredEmailCopy,
  paygPaymentFailedEmailCopy,
  paygPaymentUnconfirmedEmailCopy,
} from '../utils/paygSettlementCopy';
import { buildScheduledChatBlockMessage, buildUsageBlockCopy, type UsageBlockPaygInput } from '../utils/usageBlockCopy';

const DOLLARS = /\$\s?\d|\bUSD\b|\d+\.\d{2}\b/;

describe('ENG-668 settlement emails', () => {
  let send: jest.SpyInstance;
  beforeEach(() => {
    send = jest.spyOn(emailService, 'sendEmail').mockResolvedValue('sent');
  });
  afterEach(() => send.mockRestore());

  it('invoice created: the month, the percent of the cap and the Stripe invoice link — no amount', async () => {
    await emailService.sendPaygOverageInvoiceEmail({
      to: 'owner@example.com', month: '2026-09', percentOfCap: 60, invoiceUrl: 'https://invoice.stripe.com/i/acct/in_1',
    });
    const [to, subject, text, html] = send.mock.calls[0];
    expect(to).toBe('owner@example.com');
    expect(subject).toBe('Your extra usage invoice for September 2026');
    // The bill follows the month's highest limit, so the percentage is of that limit (rvE2E R4).
    expect(text).toContain('using 60% of the highest extra usage limit you had set that month');
    // Stripe sends its own receipt for the charge; the heads-up lives only in the "will charge" wording.
    expect(text).toContain('Stripe will also email you a receipt for the payment.');
    expect(text).toContain('View your invoice: https://invoice.stripe.com/i/acct/in_1');
    expect(html).toContain('href="https://invoice.stripe.com/i/acct/in_1"');
    for (const body of [subject, text, html]) expect(body).not.toMatch(DOLLARS);
  });

  it('the receipt heads-up is only in the "will charge" wording, not the paid, failed or action-required emails', () => {
    const RECEIPT = 'Stripe will also email you a receipt';
    const joined = (c: { paragraphs: string[] }) => c.paragraphs.join(' ');
    expect(joined(paygInvoiceCreatedEmailCopy({ month: '2026-09', percentOfCap: 40 }))).toContain(RECEIPT);
    for (const c of [
      paygInvoiceCreatedEmailCopy({ month: '2026-09', percentOfCap: 40, paid: true }),
      paygPaymentActionRequiredEmailCopy({ month: '2026-09' }),
      paygPaymentFailedEmailCopy({ month: '2026-09' }),
      paygPaymentUnconfirmedEmailCopy({ month: '2026-09' }),
    ]) expect(joined(c)).not.toContain(RECEIPT);
  });

  it('payment failed: PAYG on hold and what to do — no amount', async () => {
    await emailService.sendPaygOveragePaymentFailedEmail({
      to: 'owner@example.com', month: '2026-09', invoiceUrl: 'https://invoice.stripe.com/i/acct/in_1',
    });
    const [, subject, text, html] = send.mock.calls[0];
    expect(subject).toBe("Action needed: your extra usage payment for September 2026 didn't go through");
    expect(text).toContain('Extra usage is on hold');
    expect(text).toContain('Update your payment method and pay the invoice to resume extra usage.');
    for (const body of [subject, text, html]) expect(body).not.toMatch(DOLLARS);
  });

  it('a link that is not https is left out rather than rendered', async () => {
    await emailService.sendPaygOverageInvoiceEmail({
      to: 'owner@example.com', month: '2026-09', percentOfCap: 100, invoiceUrl: 'javascript:alert(1)',
    });
    const [, , text, html] = send.mock.calls[0];
    expect(text).not.toContain('javascript:');
    expect(html).not.toContain('javascript:');
  });

  it('the percentage is a whole number within 0-100', async () => {
    await emailService.sendPaygOverageInvoiceEmail({ to: 'o@example.com', month: '2026-09', percentOfCap: 133.7 });
    expect(send.mock.calls[0][2]).toContain('100% of the highest extra usage limit');
  });

  it('the Stripe invoice describes the month it bills', () => {
    expect(formatUsageMonth('2026-12')).toBe('December 2026');
    expect(paygOverageInvoiceCopy('2026-09')).toEqual({
      description: 'AgentWeb extra usage for September 2026',
      lineDescription: "Extra usage beyond your plan's included AI usage, September 2026",
    });
  });
});

/**
 * ENG-668 copy: customers see this feature as "Extra usage", never "pay-as-you-go" or "PAYG" (the
 * portal's `paygCopy.ts`; ENG-2571 already shows "Pay as you go" for a different thing). Every
 * customer-facing sentence the backend produces for it is checked here, so a new one cannot bring the
 * internal name back.
 */
describe('ENG-668 customer copy never says pay-as-you-go', () => {
  const INTERNAL_NAME = /pay[- ]?as[- ]?you[- ]?go|payg/i;
  const blocks: UsageBlockPaygInput[] = [
    { reason: 'payg_cap_reached' },
    ...(['payment_failed', 'payment_unconfirmed', 'dispute', 'dispute_lost', undefined] as const).flatMap((paygSuspendedReason) => [
      { reason: 'payg_suspended' as const, paygSuspendedReason },
      { reason: 'payg_suspended' as const, paygSuspendedReason, paygOwnerResolves: true },
    ]),
    { reason: 'payg_inactive', paygInactiveReason: 'no_payment_method' },
    { reason: 'payg_inactive', paygInactiveReason: 'subscription_inactive' },
  ];

  it('emails and the Stripe invoice text', () => {
    const emails = [
      paygInvoiceCreatedEmailCopy({ month: '2026-09', percentOfCap: 40 }),
      paygInvoiceCreatedEmailCopy({ month: '2026-09', percentOfCap: 40, paid: true }),
      paygPaymentActionRequiredEmailCopy({ month: '2026-09' }),
      paygPaymentFailedEmailCopy({ month: '2026-09' }),
      paygPaymentUnconfirmedEmailCopy({ month: '2026-09' }),
    ];
    for (const copy of emails) {
      const all = [copy.subject, copy.headline, ...copy.paragraphs, copy.invoiceLinkLabel ?? '', copy.settingsLinkLabel].join(' | ');
      expect(all).not.toMatch(INTERNAL_NAME);
      expect(all).toMatch(/extra usage/i);
    }
    const invoice = paygOverageInvoiceCopy('2026-09');
    expect(`${invoice.description} | ${invoice.lineDescription}`).not.toMatch(INTERNAL_NAME);
  });

  it.each(blocks)('usage-block and scheduled-chat copy (%p)', (paygBlock) => {
    for (const month of ['2026-10', null]) {
      const copy = buildUsageBlockCopy({ month, paygBlock });
      expect([copy.headline, copy.body, copy.message].join(' | ')).not.toMatch(INTERNAL_NAME);
      expect(copy.headline).toMatch(/extra usage/i);
      expect(buildScheduledChatBlockMessage({ usageMode: 'paused', limitPercent: 180, month, paygBlock })).not.toMatch(INTERNAL_NAME);
    }
  });
});
