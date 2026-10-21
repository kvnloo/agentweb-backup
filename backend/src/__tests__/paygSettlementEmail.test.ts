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
import { formatUsageMonth, paygOverageInvoiceCopy } from '../utils/paygSettlementCopy';

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
    expect(subject).toBe('Your pay-as-you-go invoice for September 2026');
    // The bill follows the month's highest limit, so the percentage is of that limit (rvE2E R4).
    expect(text).toContain('using 60% of the highest pay-as-you-go limit you had set that month');
    expect(text).toContain('View your invoice: https://invoice.stripe.com/i/acct/in_1');
    expect(html).toContain('href="https://invoice.stripe.com/i/acct/in_1"');
    for (const body of [subject, text, html]) expect(body).not.toMatch(DOLLARS);
  });

  it('payment failed: PAYG on hold and what to do — no amount', async () => {
    await emailService.sendPaygOveragePaymentFailedEmail({
      to: 'owner@example.com', month: '2026-09', invoiceUrl: 'https://invoice.stripe.com/i/acct/in_1',
    });
    const [, subject, text, html] = send.mock.calls[0];
    expect(subject).toBe("Action needed: your pay-as-you-go payment for September 2026 didn't go through");
    expect(text).toContain('Pay-as-you-go is on hold');
    expect(text).toContain('Update your payment method and pay the invoice to resume pay-as-you-go.');
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
    expect(send.mock.calls[0][2]).toContain('100% of the highest pay-as-you-go limit');
  });

  it('the Stripe invoice describes the month it bills', () => {
    expect(formatUsageMonth('2026-12')).toBe('December 2026');
    expect(paygOverageInvoiceCopy('2026-09')).toEqual({
      description: 'AgentWeb pay-as-you-go usage for September 2026',
      lineDescription: "AI usage beyond your plan's included usage, September 2026 (pay-as-you-go)",
    });
  });
});
