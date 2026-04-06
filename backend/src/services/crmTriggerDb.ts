import { v4 as uuidv4 } from 'uuid';
import { dynamodb } from '../config/aws';
import { CRMTrigger, CRMTriggerLog } from '../types/crmTriggers';
import { TABLE_PREFIX } from '../config/constants';
import { crmDb } from './db';

const LOGS_TABLE = `${TABLE_PREFIX}AW-CRMTriggerLogs`;

const TTL_90_DAYS_SECONDS = 90 * 24 * 60 * 60;

const MAX_TRIGGERS = 20;

const generateTriggerId = () => `trig_${uuidv4()}`;
const generateLogId = () => `tlog_${uuidv4()}`;

export const crmTriggerDb = {
  // ── Trigger CRUD (embedded in list record) ──────────────────────────────

  async getTriggersByListId(listId: string): Promise<CRMTrigger[]> {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return [];
    return Array.isArray(list.triggers) ? list.triggers : [];
  },

  async getTriggerById(triggerId: string, listId: string): Promise<CRMTrigger | null> {
    const triggers = await this.getTriggersByListId(listId);
    return triggers.find((t) => t.triggerId === triggerId) ?? null;
  },

  async createTrigger(
    trigger: Omit<CRMTrigger, 'triggerId' | 'createdAt' | 'updatedAt'>
  ): Promise<CRMTrigger> {
    const triggers = await this.getTriggersByListId(trigger.listId);
    if (triggers.length >= MAX_TRIGGERS) {
      throw new Error(`Maximum of ${MAX_TRIGGERS} triggers per list`);
    }

    const now = new Date().toISOString();
    const newTrigger: CRMTrigger = {
      ...trigger,
      triggerId: generateTriggerId(),
      createdAt: now,
      updatedAt: now,
    };

    await crmDb.updateLeadList(trigger.listId, {
      triggers: [...triggers, newTrigger],
    });

    return newTrigger;
  },

  async updateTrigger(
    triggerId: string,
    listId: string,
    updates: Partial<Omit<CRMTrigger, 'triggerId' | 'createdAt'>>
  ): Promise<CRMTrigger> {
    const triggers = await this.getTriggersByListId(listId);
    const idx = triggers.findIndex((t) => t.triggerId === triggerId);
    if (idx === -1) throw new Error('Trigger not found');

    const updated: CRMTrigger = {
      ...triggers[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    triggers[idx] = updated;

    await crmDb.updateLeadList(listId, { triggers });
    return updated;
  },

  async deleteTrigger(triggerId: string, listId: string): Promise<void> {
    const triggers = await this.getTriggersByListId(listId);
    const filtered = triggers.filter((t) => t.triggerId !== triggerId);
    if (filtered.length === triggers.length) throw new Error('Trigger not found');

    await crmDb.updateLeadList(listId, { triggers: filtered });
  },

  // ── Trigger Logs (separate AW-CRMTriggerLogs table, unchanged) ──────────

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
