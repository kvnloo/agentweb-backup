import { v4 as uuidv4 } from 'uuid';
import { dynamodb } from '../config/aws';
import { CRMTrigger, CRMTriggerLog } from '../types/crmTriggers';
import { TABLE_PREFIX } from '../config/constants';

const TRIGGERS_TABLE = `${TABLE_PREFIX}AW-CRMTriggers`;
const LOGS_TABLE = `${TABLE_PREFIX}AW-CRMTriggerLogs`;

const TTL_90_DAYS_SECONDS = 90 * 24 * 60 * 60;

const generateTriggerId = () => `trig_${uuidv4()}`;
const generateLogId = () => `tlog_${uuidv4()}`;

export const crmTriggerDb = {
  async createTrigger(
    trigger: Omit<CRMTrigger, 'triggerId' | 'createdAt' | 'updatedAt'>
  ): Promise<CRMTrigger> {
    const now = new Date().toISOString();
    const item: CRMTrigger = {
      ...trigger,
      triggerId: generateTriggerId(),
      createdAt: now,
      updatedAt: now,
    };

    await dynamodb
      .put({ TableName: TRIGGERS_TABLE, Item: item })
      .promise();

    return item;
  },

  async getTriggersByListId(listId: string): Promise<CRMTrigger[]> {
    const result = await dynamodb
      .query({
        TableName: TRIGGERS_TABLE,
        IndexName: 'listId-index',
        KeyConditionExpression: 'listId = :listId',
        ExpressionAttributeValues: { ':listId': listId },
      })
      .promise();

    return (result.Items || []) as CRMTrigger[];
  },

  async getTriggerById(triggerId: string): Promise<CRMTrigger | null> {
    const result = await dynamodb
      .get({ TableName: TRIGGERS_TABLE, Key: { triggerId } })
      .promise();

    return (result.Item as CRMTrigger) || null;
  },

  async updateTrigger(
    triggerId: string,
    updates: Partial<Omit<CRMTrigger, 'triggerId' | 'createdAt'>>
  ): Promise<CRMTrigger> {
    const now = new Date().toISOString();
    const fields = { ...updates, updatedAt: now };

    const setExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    Object.entries(fields).forEach(([key, value]) => {
      const attrName = `#${key}`;
      const attrValue = `:${key}`;
      setExpressions.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = value;
    });

    const result = await dynamodb
      .update({
        TableName: TRIGGERS_TABLE,
        Key: { triggerId },
        UpdateExpression: `SET ${setExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
      .promise();

    return result.Attributes as CRMTrigger;
  },

  async deleteTrigger(triggerId: string): Promise<void> {
    await dynamodb
      .delete({ TableName: TRIGGERS_TABLE, Key: { triggerId } })
      .promise();
  },

  async writeTriggerLog(
    log: Omit<CRMTriggerLog, 'logId'>
  ): Promise<CRMTriggerLog> {
    const ttl = Math.floor(Date.now() / 1000) + TTL_90_DAYS_SECONDS;
    const item: CRMTriggerLog = {
      ...log,
      logId: generateLogId(),
      ttl,
    };

    await dynamodb
      .put({ TableName: LOGS_TABLE, Item: item })
      .promise();

    return item;
  },

  async getLogsByListId(
    listId: string,
    limit = 50
  ): Promise<CRMTriggerLog[]> {
    const result = await dynamodb
      .query({
        TableName: LOGS_TABLE,
        IndexName: 'listId-createdAt-index',
        KeyConditionExpression: 'listId = :listId',
        ExpressionAttributeValues: { ':listId': listId },
        ScanIndexForward: false,
        Limit: limit,
      })
      .promise();

    return (result.Items || []) as CRMTriggerLog[];
  },

  async getLogsByTriggerId(
    triggerId: string,
    limit = 50
  ): Promise<CRMTriggerLog[]> {
    const result = await dynamodb
      .query({
        TableName: LOGS_TABLE,
        IndexName: 'triggerId-index',
        KeyConditionExpression: 'triggerId = :triggerId',
        ExpressionAttributeValues: { ':triggerId': triggerId },
        ScanIndexForward: false,
        Limit: limit,
      })
      .promise();

    return (result.Items || []) as CRMTriggerLog[];
  },
};
