/** Process-wide ENG-110 active-run guard (one switch cache, one instanceId per process). */
import { randomUUID } from 'crypto';
import { settingsService } from '../settingsService';
import { CHAT_SESSIONS_TABLE_NAME, dynamodb } from '../chatbotService';
import { createSessionActiveRunGuard } from './sessionActiveRunGuard';

export const sessionActiveRunGuard = createSessionActiveRunGuard({
  getSetting: (name) => settingsService.getSetting(name),
  update: (params) => dynamodb.update(params as any).promise(),
  tableName: () => CHAT_SESSIONS_TABLE_NAME,
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields),
  instanceId: randomUUID(),
  newRunId: () => randomUUID(),
});
