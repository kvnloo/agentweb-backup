/**
 * ENG-2496 — persistence for Zoma device-flow onboarding. The ONLY module that touches the
 * new table; the flow (zomaDeviceFlow.ts) depends on the ZomaDeviceStore interface.
 *
 * DATA-PLANE (needs Harsha approval before merge): one new single-table DynamoDB table
 *   `${prefix}AW-ZomaDeviceAuth`  PK `pk` (S), no sort key, no GSI, TTL attribute `ttl` (epoch s)
 * Item kinds:
 *   device#<sha256(device_code)>  pending device authorization (TTL = expiry)
 *   usercode#<USER_CODE>          user_code -> device lookup (TTL = expiry)
 *   token#<sha256(zoma token)>    per-user Zoma API token, hash only, no TTL, revocable
 * Raw device codes and raw tokens are never stored.
 *
 * Device items also carry `events` (append-only setup timeline, ENG-2496 tracing) and
 * `lastPollOutcome`. TTL is the logical expiry plus ZOMA_TRACE_RETENTION_MS so support can
 * still read a finished/expired setup's timeline; every read path checks `expiresAt`, never TTL.
 */
import AWS from 'aws-sdk';
import { TABLE_PREFIX } from '../config/constants';
import type { ZomaSetupEvent } from './zomaSetupLog';

export const ZOMA_DEVICE_TABLE = `${TABLE_PREFIX}AW-ZomaDeviceAuth`;

export type ZomaDeviceStatus = 'pending' | 'approved' | 'denied' | 'issued';
export type ZomaLinkStep = 'connect_meta' | 'add_payment';

export interface ZomaDeviceRecord {
  deviceId: string; // sha256(device_code)
  userCode: string; // normalized, no dash
  status: ZomaDeviceStatus;
  pkceVerifier: string; // for the server-side OAuth consent round-trip
  intervalSec: number;
  expiresAt: number; // epoch ms
  lastPollAt?: number; // epoch ms
  userId?: string;
  links?: Partial<Record<ZomaLinkStep, string>>;
  createdAt: string;
  events?: ZomaSetupEvent[];
  lastPollOutcome?: string;
}

export interface ZomaTokenRecord {
  tokenHash: string;
  tokenId: string;
  userId: string;
  deviceId: string;
  revoked: boolean;
  createdAt: string;
  revokedAt?: string;
}

export interface ZomaDeviceStore {
  /** False when the user code is already taken (caller retries with a new one). */
  createDevice(record: ZomaDeviceRecord): Promise<boolean>;
  getDevice(deviceId: string): Promise<ZomaDeviceRecord | null>;
  getDeviceIdByUserCode(userCode: string): Promise<string | null>;
  /**
   * Atomically record a poll iff the previous one was at least `intervalSec` ago. On a
   * too-fast poll the interval grows by 5s (RFC 8628 §3.5) and the new interval is returned.
   */
  claimPoll(deviceId: string, intervalSec: number, now: number): Promise<{ ok: true } | { ok: false; intervalSec: number }>;
  /** pending -> approved|denied, exactly once. */
  resolveDevice(deviceId: string, outcome: { status: 'approved'; userId: string; expiresAt: number } | { status: 'denied' }, now: number): Promise<boolean>;
  saveLink(deviceId: string, step: ZomaLinkStep, link: string): Promise<void>;
  /** approved -> issued and the token row written in one transaction; false if it lost the race. */
  issueToken(deviceId: string, token: ZomaTokenRecord): Promise<boolean>;
  getToken(tokenHash: string): Promise<ZomaTokenRecord | null>;
  /** Idempotent; true when the token exists (now revoked). */
  revokeToken(tokenHash: string, now: number): Promise<boolean>;
  /** Append to the device's setup timeline; optionally record the latest poll outcome. No-op for a missing device. */
  appendEvent(deviceId: string, event: ZomaSetupEvent, opts?: { pollOutcome?: string }): Promise<void>;
}

/** Support can read a setup's timeline for this long after it expires. */
export const ZOMA_TRACE_RETENTION_MS = 14 * 24 * 3600 * 1000;

const deviceKey = (deviceId: string) => `device#${deviceId}`;
const userCodeKey = (userCode: string) => `usercode#${userCode}`;
const tokenKey = (tokenHash: string) => `token#${tokenHash}`;
const ttlOf = (expiresAtMs: number) => Math.ceil((expiresAtMs + ZOMA_TRACE_RETENTION_MS) / 1000);

function isConditionFailure(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code === 'ConditionalCheckFailedException') return true;
  if (code === 'TransactionCanceledException') {
    return /ConditionalCheckFailed/.test(String((error as Error).message ?? ''));
  }
  return false;
}

export class DynamoZomaDeviceStore implements ZomaDeviceStore {
  constructor(
    private readonly db: AWS.DynamoDB.DocumentClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-2',
    }),
    private readonly table: string = ZOMA_DEVICE_TABLE,
  ) {}

  async createDevice(record: ZomaDeviceRecord): Promise<boolean> {
    const ttl = ttlOf(record.expiresAt);
    try {
      await this.db.transactWrite({
        TransactItems: [
          { Put: { TableName: this.table, Item: { pk: userCodeKey(record.userCode), deviceId: record.deviceId, ttl }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Put: { TableName: this.table, Item: { pk: deviceKey(record.deviceId), ...record, ttl }, ConditionExpression: 'attribute_not_exists(pk)' } },
        ],
      }).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async getDevice(deviceId: string): Promise<ZomaDeviceRecord | null> {
    const r = await this.db.get({ TableName: this.table, Key: { pk: deviceKey(deviceId) }, ConsistentRead: true }).promise();
    if (!r.Item) return null;
    const { pk: _pk, ttl: _ttl, ...rest } = r.Item;
    return rest as ZomaDeviceRecord;
  }

  async getDeviceIdByUserCode(userCode: string): Promise<string | null> {
    const r = await this.db.get({ TableName: this.table, Key: { pk: userCodeKey(userCode) }, ConsistentRead: true }).promise();
    return typeof r.Item?.deviceId === 'string' ? r.Item.deviceId : null;
  }

  async claimPoll(deviceId: string, intervalSec: number, now: number) {
    try {
      await this.db.update({
        TableName: this.table,
        Key: { pk: deviceKey(deviceId) },
        UpdateExpression: 'SET lastPollAt = :now',
        ConditionExpression: 'attribute_exists(pk) AND intervalSec = :iv AND (attribute_not_exists(lastPollAt) OR lastPollAt <= :threshold)',
        ExpressionAttributeValues: { ':now': now, ':iv': intervalSec, ':threshold': now - intervalSec * 1000 },
      }).promise();
      return { ok: true as const };
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const r = await this.db.update({
        TableName: this.table,
        Key: { pk: deviceKey(deviceId) },
        UpdateExpression: 'SET lastPollAt = :now ADD intervalSec :five',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':now': now, ':five': 5 },
        ReturnValues: 'UPDATED_NEW',
      }).promise();
      return { ok: false as const, intervalSec: Number(r.Attributes?.intervalSec ?? intervalSec + 5) };
    }
  }

  async resolveDevice(deviceId: string, outcome: { status: 'approved'; userId: string; expiresAt: number } | { status: 'denied' }, now: number) {
    const values: Record<string, unknown> = { ':pending': 'pending', ':status': outcome.status, ':now': now };
    let update = 'SET #status = :status';
    if (outcome.status === 'approved') {
      update += ', userId = :userId, expiresAt = :exp, #ttl = :ttl';
      Object.assign(values, { ':userId': outcome.userId, ':exp': outcome.expiresAt, ':ttl': ttlOf(outcome.expiresAt) });
    }
    try {
      await this.db.update({
        TableName: this.table,
        Key: { pk: deviceKey(deviceId) },
        UpdateExpression: update,
        ConditionExpression: '#status = :pending AND expiresAt > :now',
        ExpressionAttributeNames: { '#status': 'status', ...(outcome.status === 'approved' ? { '#ttl': 'ttl' } : {}) },
        ExpressionAttributeValues: values,
      }).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async saveLink(deviceId: string, step: ZomaLinkStep, link: string) {
    const r = await this.db.get({ TableName: this.table, Key: { pk: deviceKey(deviceId) }, ConsistentRead: true }).promise();
    if (!r.Item) return;
    await this.db.update({
      TableName: this.table,
      Key: { pk: deviceKey(deviceId) },
      UpdateExpression: 'SET links = :links',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':links': { ...(r.Item.links ?? {}), [step]: link } },
    }).promise();
  }

  async issueToken(deviceId: string, token: ZomaTokenRecord) {
    try {
      await this.db.transactWrite({
        TransactItems: [
          {
            Update: {
              TableName: this.table,
              Key: { pk: deviceKey(deviceId) },
              UpdateExpression: 'SET #status = :issued',
              ConditionExpression: '#status = :approved AND userId = :userId',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':issued': 'issued', ':approved': 'approved', ':userId': token.userId },
            },
          },
          { Put: { TableName: this.table, Item: { pk: tokenKey(token.tokenHash), ...token }, ConditionExpression: 'attribute_not_exists(pk)' } },
        ],
      }).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async getToken(tokenHash: string): Promise<ZomaTokenRecord | null> {
    const r = await this.db.get({ TableName: this.table, Key: { pk: tokenKey(tokenHash) }, ConsistentRead: true }).promise();
    if (!r.Item) return null;
    const { pk: _pk, ...rest } = r.Item;
    return rest as ZomaTokenRecord;
  }

  async appendEvent(deviceId: string, event: ZomaSetupEvent, opts: { pollOutcome?: string } = {}) {
    try {
      await this.db.update({
        TableName: this.table,
        Key: { pk: deviceKey(deviceId) },
        UpdateExpression: `SET events = list_append(if_not_exists(events, :empty), :ev)${opts.pollOutcome ? ', lastPollOutcome = :poll' : ''}`,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':empty': [], ':ev': [event], ...(opts.pollOutcome ? { ':poll': opts.pollOutcome } : {}) },
      }).promise();
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  /** Support tooling only (scripts/zoma-setup-trace.ts): full scan of device items. Small table. */
  async scanDevices(): Promise<ZomaDeviceRecord[]> {
    const out: ZomaDeviceRecord[] = [];
    let ExclusiveStartKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const r = await this.db.scan({
        TableName: this.table,
        FilterExpression: 'begins_with(pk, :device)',
        ExpressionAttributeValues: { ':device': 'device#' },
        ExclusiveStartKey,
      }).promise();
      for (const item of r.Items ?? []) {
        const { pk: _pk, ttl: _ttl, ...rest } = item;
        out.push(rest as ZomaDeviceRecord);
      }
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async revokeToken(tokenHash: string, now: number) {
    try {
      await this.db.update({
        TableName: this.table,
        Key: { pk: tokenKey(tokenHash) },
        UpdateExpression: 'SET revoked = :t, revokedAt = if_not_exists(revokedAt, :at)',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':t': true, ':at': new Date(now).toISOString() },
      }).promise();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }
}
