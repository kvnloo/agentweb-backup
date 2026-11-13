import { dynamodb } from '../../config/aws';
import { tableName } from '../../config/constants';
import { errorCode, isConditionalFailure } from './setupWrites';

/**
 * Atomic counters and expiring claims for the hot-lead call abuse limits. Every method is ONE conditional
 * write, so concurrent callers can never both win the last slot. Correctness never depends on DynamoDB's
 * (eventual) TTL reaper: keys are bucketed per window for counters, and claims are tested against their own
 * expiry; the reaper only deletes what is already dead.
 */
export interface LimitStore {
  /** Adds one to the counter at `key` unless it already holds `cap`. False = at the cap, nothing written. */
  incrementBelow(key: string, cap: number, expiresAtS: number): Promise<boolean>;
  /** The counter at `key` (0 when absent). A consistent read; used for customer notices only, never to decide a limit. */
  read(key: string): Promise<number>;
  /** Gives a slot back (never below zero). Best-effort: a failure only burns the slot, which errs safe. */
  decrement(key: string): Promise<void>;
  /** Claims `key` for `token` unless a claim that has not yet expired exists (live while nowS < expiresAtS). */
  claim(key: string, token: string, expiresAtS: number, nowS: number): Promise<boolean>;
  /** The token of the live claim on `key` (not yet expired at nowS), or null. A consistent read. */
  holder(key: string, nowS: number): Promise<string | null>;
  /** Drops the claim, only if `token` still owns it (an expired claim may have been re-taken by someone else). */
  release(key: string, token: string): Promise<void>;
}

// An existing table with a native `ttl` attribute. Its only scan is the eval credential-cleanup inventory
// (evaluationStore prepareCredentialCleanup), which filters on agentUserId, so `hlc#` rows are read by that scan
// but never matched or touched. Not a new table or index: new key prefixes only (hlc#phone#, hlc#cool#, hlc#cap#h#,
// hlc#cap#d#, hlc#cap#m#, hlc#cap#g# (platform-wide), hlc#notify# (incl. g80/g100), hlc#dnc#, and the inbound hlc#cap#ih#, hlc#cap#id#, hlc#in#p#, hlc#in#c#).
const LIMITS_TABLE = tableName('AW-MCPSessions');
const PK = 'sessionId';

class DynamoLimitStore implements LimitStore {
  async incrementBelow(key: string, cap: number, expiresAtS: number): Promise<boolean> {
    if (!(cap >= 1)) return false; // a zero, negative or NaN cap admits nothing (the condition would admit a first call)
    try {
      await dynamodb.update({
        TableName: LIMITS_TABLE,
        Key: { [PK]: key },
        UpdateExpression: 'SET calls = if_not_exists(calls, :zero) + :one, #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(calls) OR calls < :cap',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':cap': cap, ':ttl': expiresAtS },
      }).promise();
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  async read(key: string): Promise<number> {
    const { Item } = await dynamodb.get({ TableName: LIMITS_TABLE, Key: { [PK]: key }, ConsistentRead: true }).promise();
    return Item && typeof Item.calls === 'number' ? Item.calls : 0;
  }

  async decrement(key: string): Promise<void> {
    try {
      await dynamodb.update({
        TableName: LIMITS_TABLE,
        Key: { [PK]: key },
        UpdateExpression: 'SET calls = calls - :one',
        ConditionExpression: 'calls > :zero',
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      }).promise();
    } catch (err) {
      if (!isConditionalFailure(err)) console.warn('[hotLeadCall] could not give a call slot back', errorCode(err) ?? 'error');
    }
  }

  async claim(key: string, token: string, expiresAtS: number, nowS: number): Promise<boolean> {
    try {
      await dynamodb.put({
        TableName: LIMITS_TABLE,
        Item: { [PK]: key, token, ttl: expiresAtS },
        // An expired claim the reaper has not removed yet counts as absent.
        ConditionExpression: 'attribute_not_exists(#pk) OR #ttl <= :now',
        ExpressionAttributeNames: { '#pk': PK, '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':now': nowS },
      }).promise();
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  async holder(key: string, nowS: number): Promise<string | null> {
    const { Item } = await dynamodb.get({ TableName: LIMITS_TABLE, Key: { [PK]: key }, ConsistentRead: true }).promise();
    return Item && typeof Item.token === 'string' && Number(Item.ttl) > nowS ? Item.token : null;
  }

  async release(key: string, token: string): Promise<void> {
    try {
      await dynamodb.delete({
        TableName: LIMITS_TABLE,
        Key: { [PK]: key },
        ConditionExpression: '#token = :token',
        ExpressionAttributeNames: { '#token': 'token' },
        ExpressionAttributeValues: { ':token': token },
      }).promise();
    } catch (err) {
      if (!isConditionalFailure(err)) console.warn('[hotLeadCall] could not release a call claim', errorCode(err) ?? 'error');
    }
  }
}

let store: LimitStore | null = null;
export function getLimitStore(): LimitStore {
  if (!store) store = new DynamoLimitStore();
  return store;
}

/** Test-only: inject a fake, or pass null to restore the DynamoDB-backed store. */
export function setLimitStoreForTests(replacement: LimitStore | null): void {
  store = replacement;
}
