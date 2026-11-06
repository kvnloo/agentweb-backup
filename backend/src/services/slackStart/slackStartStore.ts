/**
 * ENG-2782 S1 — durable storage for the public Slack-start intake.
 *
 * One table, `AW-SlackStartIntakes` (HASH `pk`, TTL `expiresAt`), three item kinds:
 *
 *   intake#<intakeId>          the intake: email, website, answers, step progress,
 *                              provisioning stamps, completion state
 *   domain#<company domain>    the dedupe lock: which intake owns this domain and the
 *                              hash of the Idempotency-Key that created it (30-day TTL)
 *   rate#<scope>#<hash>#<win>  fixed-window rate-limit counter (expires via TTL)
 *
 * Everything that must hold across backend instances is a DynamoDB condition:
 * the intake + domain lock are one TransactWrite (both attribute_not_exists), so
 * two concurrent starts for one domain can never both win; provisioning stamps
 * and the completion lease are conditional updates; rate counters are an atomic
 * ADD bounded by a condition. Nothing here lives in process memory.
 */

import AWS from 'aws-sdk';
import { TABLE_PREFIX } from '../../config/constants';
import type { AnswerField, AnswerValue } from './slackStartConfig';

export const SLACK_START_TABLE = `${TABLE_PREFIX}AW-SlackStartIntakes`;
export const SLACK_START_TTL_ATTRIBUTE = 'expiresAt';
/**
 * A domain lock lives 30 days. Long enough to dedupe a company's real signup burst;
 * short enough that one abandoned intake cannot lock a company out for good.
 * Intakes themselves carry no TTL: they are the durable record behind the user + lead.
 */
const DOMAIN_LOCK_TTL_SEC = 30 * 24 * 3600;

export const SLACK_START_TABLE_SPEC: AWS.DynamoDB.CreateTableInput = {
  TableName: SLACK_START_TABLE,
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  BillingMode: 'PAY_PER_REQUEST',
};

export type IntakeStatus = 'open' | 'completed';

export interface IntakeRecord {
  intakeId: string;
  email: string;
  domain: string;
  website: string;
  websiteHost: string;
  utm?: Record<string, string>;
  idempotencyKeyHash: string;
  userId: string;
  leadId: string;
  status: IntakeStatus;
  createdAt: string;
  updatedAt: string;
  answers: Partial<Record<AnswerField, AnswerValue>>;
  /** ISO time each step was last saved — drop-off analysis reads furthestStep + these. */
  stepSavedAt: Partial<Record<AnswerField, string>>;
  lastStep?: number;
  furthestStep?: number;
  userCreatedAt?: string;
  leadWrittenAt?: string;
  brandBuildTriggeredAt?: string;
  /** Set when the email turned out to belong to an existing account mid-provisioning. */
  accountConflictAt?: string;
  completionLeaseUntil?: string;
  completedAt?: string;
  completionAttempts?: number;
  slackConnectStatus?: string;
  slackConnectChannelId?: string;
  highBudget?: boolean;
  franciscoAlertEligibleAt?: string;
}

export interface DomainLock {
  domain: string;
  intakeId: string;
  idempotencyKeyHash: string;
  createdAt: string;
}

export interface UpdateCondition {
  /** Only apply when this attribute is absent (exactly-once stamps). */
  ifNotExists?: string;
  /** Only apply when this lease attribute is absent or earlier than `now`. */
  ifLeaseFree?: { attr: string; now: string };
}

export interface SlackStartStore {
  createIntake(intake: IntakeRecord, lock: DomainLock): Promise<{ created: true } | { created: false; lock: DomainLock | null }>;
  getIntake(intakeId: string): Promise<IntakeRecord | null>;
  getDomainLock(domain: string): Promise<DomainLock | null>;
  /** Keys may be dotted paths into maps (`answers.source`). Returns false when the condition failed. */
  updateIntake(intakeId: string, set: Record<string, unknown>, condition?: UpdateCondition): Promise<boolean>;
  /** Atomically count one hit in the current fixed window; false once `max` is reached. */
  consumeRate(scope: string, keyHash: string, max: number, windowMs: number, now: Date): Promise<boolean>;
}

type DocClient = Pick<AWS.DynamoDB.DocumentClient, 'transactWrite' | 'get' | 'update'>;

const isConditionalFailure = (err: any) => err?.code === 'ConditionalCheckFailedException';
const isTransactionConditionFailure = (err: any) =>
  err?.code === 'TransactionCanceledException' && /ConditionalCheckFailed/.test(String(err?.message ?? ''));

function stripKey<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const { pk: _pk, kind: _kind, [SLACK_START_TTL_ATTRIBUTE]: _ttl, ...rest } = item;
  return rest as T;
}

export function createDynamoSlackStartStore(client: DocClient = new AWS.DynamoDB.DocumentClient()): SlackStartStore {
  const getByPk = async <T>(pk: string): Promise<T | null> => {
    const res = await client.get({ TableName: SLACK_START_TABLE, Key: { pk }, ConsistentRead: true }).promise();
    return stripKey<T>(res.Item as Record<string, unknown> | undefined);
  };

  return {
    async createIntake(intake, lock) {
      const lockCreatedSec = Math.floor(Date.parse(lock.createdAt) / 1000);
      try {
        await client
          .transactWrite({
            TransactItems: [
              {
                Put: {
                  TableName: SLACK_START_TABLE,
                  Item: { pk: `intake#${intake.intakeId}`, kind: 'intake', ...intake },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: SLACK_START_TABLE,
                  Item: { pk: `domain#${lock.domain}`, kind: 'domain', ...lock, [SLACK_START_TTL_ATTRIBUTE]: lockCreatedSec + DOMAIN_LOCK_TTL_SEC },
                  // TTL deletion is lazy (up to ~48h), so an expired lock already counts as free.
                  ConditionExpression: 'attribute_not_exists(pk) OR #expiresAt < :nowSec',
                  ExpressionAttributeNames: { '#expiresAt': SLACK_START_TTL_ATTRIBUTE },
                  ExpressionAttributeValues: { ':nowSec': lockCreatedSec },
                },
              },
            ],
          })
          .promise();
        return { created: true };
      } catch (err) {
        if (!isTransactionConditionFailure(err)) throw err;
        return { created: false, lock: await getByPk<DomainLock>(`domain#${lock.domain}`) };
      }
    },

    getIntake(intakeId) {
      return getByPk<IntakeRecord>(`intake#${intakeId}`);
    },

    getDomainLock(domain) {
      return getByPk<DomainLock>(`domain#${domain}`);
    },

    async updateIntake(intakeId, set, condition) {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let n = 0;
      const assignments = Object.entries(set).map(([path, value], i) => {
        const placeholders = path.split('.').map((segment) => {
          const key = `#n${n++}`;
          names[key] = segment;
          return key;
        });
        values[`:v${i}`] = value;
        return `${placeholders.join('.')} = :v${i}`;
      });
      let conditionExpression = 'attribute_exists(pk)';
      if (condition?.ifNotExists) {
        names['#c0'] = condition.ifNotExists;
        conditionExpression += ' AND attribute_not_exists(#c0)';
      } else if (condition?.ifLeaseFree) {
        names['#c0'] = condition.ifLeaseFree.attr;
        values[':cnow'] = condition.ifLeaseFree.now;
        conditionExpression += ' AND (attribute_not_exists(#c0) OR #c0 < :cnow)';
      }
      try {
        await client
          .update({
            TableName: SLACK_START_TABLE,
            Key: { pk: `intake#${intakeId}` },
            UpdateExpression: `SET ${assignments.join(', ')}`,
            ConditionExpression: conditionExpression,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          })
          .promise();
        return true;
      } catch (err) {
        if (isConditionalFailure(err)) return false;
        throw err;
      }
    },

    async consumeRate(scope, keyHash, max, windowMs, now) {
      const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
      const windowEndSec = Math.floor((windowStart + windowMs) / 1000);
      try {
        await client
          .update({
            TableName: SLACK_START_TABLE,
            Key: { pk: `rate#${scope}#${keyHash}#${new Date(windowStart).toISOString()}` },
            UpdateExpression: 'ADD #count :one SET #expiresAt = if_not_exists(#expiresAt, :exp)',
            ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
            ExpressionAttributeNames: { '#count': 'count', '#expiresAt': SLACK_START_TTL_ATTRIBUTE },
            // Keep the counter one hour past its window so a clock-skewed instance still sees it.
            ExpressionAttributeValues: { ':one': 1, ':max': max, ':exp': windowEndSec + 3600 },
          })
          .promise();
        return true;
      } catch (err) {
        if (isConditionalFailure(err)) return false;
        throw err;
      }
    },
  };
}
