/**
 * ENG-3132 slice C — payout roll-up for the admin report. Pure functions over ledger rows.
 *
 * Rows are grouped by their own `payoutMonth`: an accrual sits in the month its invoice was paid, a reversal
 * or void in the month the credit note was issued or voided. So a clawback after a payout shows as a negative
 * in the open month instead of rewriting a closed one.
 */
import type { ZomaLedgerEntry } from './zomaReferralLedger';

export interface PayoutRow {
  referrerId: string;
  code: string;
  accruedCents: number;
  /** Positive number: commission taken back by credit notes. */
  reversedCents: number;
  /** Positive number: commission given back by voided credit notes. */
  voidedCents: number;
  /** accrued - reversed + voided; negative when refunds in the month exceed what accrued in it. */
  netCents: number;
  /** Distinct invoices accrued in the month. */
  invoiceCount: number;
}

export const isPayoutMonth = (month: unknown): month is string => typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

export function summarizePayouts(entries: readonly ZomaLedgerEntry[], month: string): PayoutRow[] {
  const groups = new Map<string, PayoutRow & { invoices: Set<string> }>();
  for (const e of entries) {
    if (e.payoutMonth !== month) continue;
    const key = `${e.referrerId}\u0000${e.code}`;
    const row = groups.get(key) ?? { referrerId: e.referrerId, code: e.code, accruedCents: 0, reversedCents: 0, voidedCents: 0, netCents: 0, invoiceCount: 0, invoices: new Set<string>() };
    if (e.kind === 'accrual') {
      row.accruedCents += e.commissionCents;
      row.invoices.add(e.invoiceId);
    } else if (e.entry.includes('#void#')) {
      row.voidedCents += e.commissionCents;
    } else {
      row.reversedCents -= e.commissionCents;
    }
    groups.set(key, row);
  }
  return [...groups.values()]
    .map(({ invoices, ...row }) => ({ ...row, invoiceCount: invoices.size, netCents: row.accruedCents - row.reversedCents + row.voidedCents }))
    .sort((a, b) => a.referrerId.localeCompare(b.referrerId) || a.code.localeCompare(b.code));
}

/** A text cell that a spreadsheet will not run as a formula, quoted when it holds a delimiter. */
export function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function payoutsCsv(month: string, rows: readonly PayoutRow[], payeeByCode: ReadonlyMap<string, string>): string {
  const header = 'month,referrer_id,code,payee_name,accrued_cents,reversed_cents,voided_cents,net_cents,invoices';
  const lines = rows.map((r) =>
    [csvText(month), csvText(r.referrerId), csvText(r.code), csvText(payeeByCode.get(r.code) ?? ''), r.accruedCents, r.reversedCents, r.voidedCents, r.netCents, r.invoiceCount].join(','),
  );
  return `${[header, ...lines].join('\n')}\n`;
}
