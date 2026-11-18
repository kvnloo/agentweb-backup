/**
 * ENG-3132 slice A — Zoma referral-code registry.
 *
 * ENG-2906 records a free-form `ref` label on the referred user (`signupRef`). That label proves
 * nothing about WHO referred them: anyone can type `?ref=anything`, and the same field carries
 * marketing channels (`hn`, `linkedin`). This registry is the missing half: a code only earns a
 * referrer money if it is registered here and active. Unregistered refs stay analytics-only.
 *
 * DATA-PLANE: one new table `${prefix}AW-ZomaReferralCodes`, PK `code` (S), no sort key, no GSI
 * (defined in scripts/create-tables.ts). One item per code. A referrer may own several codes.
 *
 * Dark: nothing calls this until a later slice wires accrual behind ZOMA_REFERRAL_ENABLED. The
 * store is an interface so the accrual code and its tests never need a real table.
 */
import AWS from 'aws-sdk';
import { TABLE_PREFIX } from '../config/constants';
import { REF_PATTERN, validateRef } from './journeyAttribution';
import { classifyAcquisitionSource } from './zomaChannelAttribution';

export const ZOMA_REFERRAL_CODES_TABLE = `${TABLE_PREFIX}AW-ZomaReferralCodes`;

// ---------------------------------------------------------------------------------------------
// Config (env-driven, like ZOMA_BILLING_*; nothing here reads Stripe prices)
// ---------------------------------------------------------------------------------------------

export interface ZomaReferralConfig {
  enabled: boolean;
  /** Default commission in basis points (20% = 2000). A code may override it. */
  percentBps: number;
  /** How many commissionable invoices per referred user earn commission. */
  months: number;
}

export const DEFAULT_REFERRAL_PERCENT_BPS = 2000;
export const DEFAULT_REFERRAL_MONTHS = 3;

/** Percent as a decimal string/number with at most 2 decimals, 0 < p <= 100, returned as basis points. */
export function parsePercentToBps(raw: string | number | undefined): number | undefined {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return undefined;
  const bps = Math.round(n * 100);
  return Math.abs(bps / 100 - n) < 1e-9 ? bps : undefined;
}

export function getZomaReferralConfig(env: NodeJS.ProcessEnv = process.env): ZomaReferralConfig {
  const months = Number(env.ZOMA_REFERRAL_MONTHS);
  return {
    enabled: env.ZOMA_REFERRAL_ENABLED === 'true',
    // An unparsable value falls back to the documented default; it never silently becomes 0 or 100.
    percentBps: parsePercentToBps(env.ZOMA_REFERRAL_PERCENT) ?? DEFAULT_REFERRAL_PERCENT_BPS,
    months: Number.isInteger(months) && months >= 1 && months <= 12 ? months : DEFAULT_REFERRAL_MONTHS,
  };
}

// ---------------------------------------------------------------------------------------------
// Code rules
// ---------------------------------------------------------------------------------------------

export const MIN_CODE_LENGTH = 4;

/** Words that mean something elsewhere in the `ref` namespace or the product. */
const RESERVED_CODES: ReadonlySet<string> = new Set([
  'direct', 'other', 'unknown', 'none', 'null', 'undefined', 'test', 'admin', 'agentweb', 'emma', 'zoma', 'mcp', 'api',
]);

export type CodeProblem = 'invalid' | 'too_short' | 'reserved';

/**
 * A code must be a valid `ref` (lowercase [a-z0-9_-], 1–64), at least MIN_CODE_LENGTH long, and must
 * not collide with a launch-channel alias: `classifyAcquisitionSource` would file such a signup under
 * that channel, so the referral and the channel report would disagree.
 */
export function validateReferralCode(raw: unknown): { ok: true; code: string } | { ok: false; reason: CodeProblem } {
  const code = validateRef(raw);
  if (!code) return { ok: false, reason: 'invalid' };
  if (code.length < MIN_CODE_LENGTH) return { ok: false, reason: 'too_short' };
  if (RESERVED_CODES.has(code) || classifyAcquisitionSource({ ref: code }) !== 'direct') return { ok: false, reason: 'reserved' };
  return { ok: true, code };
}

// ---------------------------------------------------------------------------------------------
// Records and store
// ---------------------------------------------------------------------------------------------

export type ZomaReferralCodeStatus = 'active' | 'revoked';

export interface ZomaReferralCode {
  code: string;
  /** Stable id of the person/partner being paid. Several codes can share one referrerId. */
  referrerId: string;
  /** Display name for the payout report. Admin-only; never sent to PostHog or logs. */
  payeeName: string;
  /** Linked AgentWeb user, when the referrer has an account. Optional: partners may not. */
  userId?: string;
  /** Per-referrer override of the default commission, in basis points. */
  percentBps?: number;
  status: ZomaReferralCodeStatus;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
}

export interface ZomaReferralStore {
  /** False when the code already exists (codes are never overwritten, even a revoked one). */
  create(record: ZomaReferralCode): Promise<boolean>;
  get(code: string): Promise<ZomaReferralCode | null>;
  /** Idempotent. False only when the code does not exist. */
  revoke(code: string, nowIso: string): Promise<boolean>;
  list(): Promise<ZomaReferralCode[]>;
}

const isConditionFailure = (error: unknown) => (error as { code?: string })?.code === 'ConditionalCheckFailedException';

export class DynamoZomaReferralStore implements ZomaReferralStore {
  constructor(
    private readonly db: Pick<AWS.DynamoDB.DocumentClient, 'put' | 'get' | 'update' | 'scan'> = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-2',
    }),
    private readonly table: string = ZOMA_REFERRAL_CODES_TABLE,
  ) {}

  async create(record: ZomaReferralCode): Promise<boolean> {
    try {
      await this.db.put({ TableName: this.table, Item: record, ConditionExpression: 'attribute_not_exists(code)' }).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async get(code: string): Promise<ZomaReferralCode | null> {
    const r = await this.db.get({ TableName: this.table, Key: { code }, ConsistentRead: true }).promise();
    return (r.Item as ZomaReferralCode | undefined) ?? null;
  }

  async revoke(code: string, nowIso: string): Promise<boolean> {
    try {
      await this.db.update({
        TableName: this.table,
        Key: { code },
        // if_not_exists keeps the ORIGINAL revocation time on a repeat call.
        UpdateExpression: 'SET #status = :revoked, revokedAt = if_not_exists(revokedAt, :now)',
        ConditionExpression: 'attribute_exists(code)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': 'revoked', ':now': nowIso },
      }).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async list(): Promise<ZomaReferralCode[]> {
    const out: ZomaReferralCode[] = [];
    let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const page = await this.db.scan({ TableName: this.table, ConsistentRead: true, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }).promise();
      out.push(...((page.Items ?? []) as ZomaReferralCode[]));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return out.sort((a, b) => a.code.localeCompare(b.code));
  }
}

let defaultStore: ZomaReferralStore | undefined;
/** Lazily built so importing this module never opens a DynamoDB client. */
export function getZomaReferralStore(): ZomaReferralStore {
  return (defaultStore ??= new DynamoZomaReferralStore());
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export interface CreateReferralCodeInput {
  code: unknown;
  referrerId: unknown;
  payeeName: unknown;
  createdBy: string;
  userId?: string;
  percentBps?: number;
}

export type CreateReferralCodeResult =
  | { status: 'created'; record: ZomaReferralCode }
  | { status: 'exists' }
  | { status: 'invalid'; field: 'code' | 'referrerId' | 'payeeName' | 'percentBps'; reason: string };

export async function createReferralCode(
  input: CreateReferralCodeInput,
  store: ZomaReferralStore = getZomaReferralStore(),
  now: () => Date = () => new Date(),
): Promise<CreateReferralCodeResult> {
  const code = validateReferralCode(input.code);
  if (!code.ok) return { status: 'invalid', field: 'code', reason: code.reason };
  const referrerId = typeof input.referrerId === 'string' && REF_PATTERN.test(input.referrerId) ? input.referrerId : undefined;
  if (!referrerId) return { status: 'invalid', field: 'referrerId', reason: 'invalid' };
  const payeeName = typeof input.payeeName === 'string' ? input.payeeName.trim() : '';
  if (!payeeName || payeeName.length > 120) return { status: 'invalid', field: 'payeeName', reason: 'invalid' };
  if (input.percentBps !== undefined && !(Number.isInteger(input.percentBps) && input.percentBps >= 1 && input.percentBps <= 10000)) {
    return { status: 'invalid', field: 'percentBps', reason: 'invalid' };
  }
  const record: ZomaReferralCode = {
    code: code.code,
    referrerId,
    payeeName,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.percentBps !== undefined ? { percentBps: input.percentBps } : {}),
    status: 'active',
    createdAt: now().toISOString(),
    createdBy: input.createdBy,
  };
  return (await store.create(record)) ? { status: 'created', record } : { status: 'exists' };
}

export const revokeReferralCode = (code: string, store: ZomaReferralStore = getZomaReferralStore(), now: () => Date = () => new Date()) =>
  store.revoke(code, now().toISOString());

export type ResolvedReferrer =
  | { kind: 'none' }
  | { kind: 'revoked'; record: ZomaReferralCode }
  | { kind: 'active'; record: ZomaReferralCode };

/**
 * Turn a `signupRef` into a referrer. Only a registered ACTIVE code earns commission. A malformed or
 * unregistered ref is `none` (it is just a channel label); a revoked one is reported separately so
 * the accrual slice can log it. Throws when the store is unreachable: the caller must not mistake an
 * outage for "not a referral" and drop a commission (the reconcile job exists for retries).
 */
export async function resolveReferrer(ref: unknown, store: ZomaReferralStore = getZomaReferralStore()): Promise<ResolvedReferrer> {
  const code = validateRef(ref);
  if (!code) return { kind: 'none' };
  const record = await store.get(code);
  if (!record) return { kind: 'none' };
  return { kind: record.status === 'active' ? 'active' : 'revoked', record };
}

/** The code's own percent when set, else the configured default. */
export const effectivePercentBps = (record: Pick<ZomaReferralCode, 'percentBps'>, cfg: Pick<ZomaReferralConfig, 'percentBps'>) =>
  record.percentBps ?? cfg.percentBps;
