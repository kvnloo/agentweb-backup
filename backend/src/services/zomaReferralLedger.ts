/**
 * ENG-3132 slice B2 — Zoma referral payout ledger store.
 *
 * DATA-PLANE: one new table `${prefix}AW-ZomaReferralLedger` (defined in scripts/create-tables.ts):
 * PK `referredUserId` (S), SK `entry` (S), no GSI. Append-only: rows are never updated or deleted, a
 * refund is a NEGATIVE row. Volume is tiny (at most `months` accruals per referred user), so the payout
 * report scans the table instead of paying for a GSI. NOT in ensureCriticalTables: create it before
 * enabling ZOMA_REFERRAL_ENABLED.
 *
 * Idempotency: the SK carries the Stripe invoice id, and `append` is a conditional put, so a retried or
 * duplicate webhook (`invoice.paid` and `invoice.payment_succeeded` both fire) writes nothing twice.
 */
import AWS from 'aws-sdk';
import { TABLE_PREFIX } from '../config/constants';
import { commissionCents, payoutMonth } from './zomaReferralCommission';

export const ZOMA_REFERRAL_LEDGER_TABLE = `${TABLE_PREFIX}AW-ZomaReferralLedger`;

export type LedgerKind = 'accrual' | 'reversal';

export interface ZomaLedgerEntry {
  referredUserId: string;
  /** `<invoiceId>#accrual` or `<invoiceId>#reversal#<creditNoteId>`. */
  entry: string;
  kind: LedgerKind;
  invoiceId: string;
  referrerId: string;
  code: string;
  /** UTC `YYYY-MM` of the invoice's paid time; a reversal stays in the month of the invoice it reverses. */
  payoutMonth: string;
  paidAt: string;
  baseCents: number;
  percentBps: number;
  /** Positive for an accrual, negative for a reversal. */
  commissionCents: number;
  currency: 'usd';
  createdAt: string;
  creditNoteId?: string;
}

export const accrualKey = (invoiceId: string) => `${invoiceId}#accrual`;
export const reversalKey = (invoiceId: string, creditNoteId: string) => `${invoiceId}#reversal#${creditNoteId}`;

export interface ZomaReferralLedgerStore {
  /** True when written, false when this entry already exists. Throws on any other failure. */
  append(entry: ZomaLedgerEntry): Promise<boolean>;
  listForReferredUser(referredUserId: string): Promise<ZomaLedgerEntry[]>;
  listAll(): Promise<ZomaLedgerEntry[]>;
}

interface Attribution {
  referredUserId: string;
  referrerId: string;
  code: string;
  percentBps: number;
  invoiceId: string;
  paidAt: string;
  now: Date;
}

export function buildAccrualEntry(a: Attribution & { baseCents: number }): ZomaLedgerEntry {
  return {
    referredUserId: a.referredUserId,
    entry: accrualKey(a.invoiceId),
    kind: 'accrual',
    invoiceId: a.invoiceId,
    referrerId: a.referrerId,
    code: a.code,
    payoutMonth: payoutMonth(a.paidAt),
    paidAt: a.paidAt,
    baseCents: a.baseCents,
    percentBps: a.percentBps,
    commissionCents: commissionCents(a.baseCents, a.percentBps),
    currency: 'usd',
    createdAt: a.now.toISOString(),
  };
}

/** `creditedBaseCents` is the ex-tax amount handed back (positive); the row stores it negated. */
export function buildReversalEntry(a: Attribution & { creditNoteId: string; creditedBaseCents: number }): ZomaLedgerEntry {
  return {
    referredUserId: a.referredUserId,
    entry: reversalKey(a.invoiceId, a.creditNoteId),
    kind: 'reversal',
    invoiceId: a.invoiceId,
    referrerId: a.referrerId,
    code: a.code,
    payoutMonth: payoutMonth(a.paidAt),
    paidAt: a.paidAt,
    baseCents: -a.creditedBaseCents,
    percentBps: a.percentBps,
    commissionCents: -commissionCents(a.creditedBaseCents, a.percentBps),
    currency: 'usd',
    createdAt: a.now.toISOString(),
    creditNoteId: a.creditNoteId,
  };
}

const isConditionFailure = (error: unknown) => (error as { code?: string })?.code === 'ConditionalCheckFailedException';

export class DynamoZomaReferralLedgerStore implements ZomaReferralLedgerStore {
  constructor(
    private readonly db: Pick<AWS.DynamoDB.DocumentClient, 'put' | 'query' | 'scan'> = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-2',
    }),
    private readonly table: string = ZOMA_REFERRAL_LEDGER_TABLE,
  ) {}

  async append(entry: ZomaLedgerEntry): Promise<boolean> {
    try {
      await this.db.put({ TableName: this.table, Item: entry, ConditionExpression: 'attribute_not_exists(#entry)', ExpressionAttributeNames: { '#entry': 'entry' } }).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async listForReferredUser(referredUserId: string): Promise<ZomaLedgerEntry[]> {
    const out: ZomaLedgerEntry[] = [];
    let start: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const r = await this.db.query({
        TableName: this.table,
        KeyConditionExpression: 'referredUserId = :u',
        ExpressionAttributeValues: { ':u': referredUserId },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }).promise();
      out.push(...((r.Items ?? []) as ZomaLedgerEntry[]));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async listAll(): Promise<ZomaLedgerEntry[]> {
    const out: ZomaLedgerEntry[] = [];
    let start: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const r = await this.db.scan({ TableName: this.table, ConsistentRead: true, ExclusiveStartKey: start }).promise();
      out.push(...((r.Items ?? []) as ZomaLedgerEntry[]));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }
}

let defaultStore: ZomaReferralLedgerStore | undefined;
/** Lazily built so importing this module never opens a DynamoDB client. */
export function getZomaReferralLedgerStore(): ZomaReferralLedgerStore {
  return (defaultStore ??= new DynamoZomaReferralLedgerStore());
}
