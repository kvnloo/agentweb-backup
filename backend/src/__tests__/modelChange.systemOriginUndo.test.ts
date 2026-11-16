/**
 * ENG-669: a confirmed model switch on a schedule whose pin came from an admin-authored template records the switch as
 * the owner's choice (llmModelSource 'user'); undoing it must put back BOTH the template model and its 'system' origin
 * (the audit row carries modelSourceBefore), or the restored pin would be checked as the owner's from then on.
 * An ordinary owner pin is untouched by any of this (no origin written, none restored).
 */
jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateSchedule: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));
jest.mock('../services/llmUsagePolicyResolverService', () => ({ getEffectiveLlmUsagePolicy: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { getSupportedModels: jest.fn() } }));
jest.mock('../services/llmModelChangeAuditDb', () => ({
  recordModelChange: jest.fn(),
  listModelChanges: jest.fn(),
  markModelChangeUndone: jest.fn(),
  buildChangeSortKey: (a: string, b: string) => `${a}#${b}`,
}));
jest.mock('../services/llmUsageTelemetry', () => ({
  recordUsageTelemetry: jest.fn(),
  USAGE_TELEMETRY_EVENTS: { changeApplied: 'a', changeUndone: 'u' },
}));
jest.mock('../services/agentMode/modelAccessInstance', () => ({
  modelAccess: { assertModelAllowed: jest.fn().mockResolvedValue(undefined) },
  systemModelCheck: jest.fn(() => async () => false),
}));

import { applyModelChange, undoModelChange } from '../services/llmModelChangeService';
import { scheduleDb } from '../services/db';
import { getEffectiveLlmUsagePolicy } from '../services/llmUsagePolicyResolverService';
import { agentModeService } from '../services/agentModeService';
import { listModelChanges, markModelChangeUndone, recordModelChange } from '../services/llmModelChangeAuditDb';

const TEMPLATE_MODEL = 'anthropic.claude-opus-5';
const SWITCH_TO = 'anthropic.claude-sonnet-5';

/** An in-memory schedule row that honours the patch + removals updateSchedule is given. */
function seedSchedule(initial: Record<string, unknown>) {
  let row: Record<string, unknown> = { ...initial };
  (scheduleDb.getScheduleById as jest.Mock).mockImplementation(async () => ({ ...row }));
  (scheduleDb.updateSchedule as jest.Mock).mockImplementation(
    async (_id: string, patch: Record<string, unknown>, _expect: unknown, _x: unknown, removes?: string[]) => {
      row = { ...row, ...patch };
      for (const key of removes ?? []) delete row[key];
    },
  );
  return () => row;
}

beforeEach(() => {
  jest.clearAllMocks();
  (getEffectiveLlmUsagePolicy as jest.Mock).mockResolvedValue({
    billingUserId: 'u1', policy: { optimizedModelIds: [SWITCH_TO], hardCostThresholdMicroUsd: 1 },
  });
  (agentModeService.getSupportedModels as jest.Mock).mockResolvedValue([TEMPLATE_MODEL, SWITCH_TO]);
  let audit: any;
  (recordModelChange as jest.Mock).mockImplementation(async (record: any) => { audit = record; return `${record.changedAt}#${record.changeId}`; });
  (listModelChanges as jest.Mock).mockImplementation(async () => [audit]);
  (markModelChangeUndone as jest.Mock).mockResolvedValue(true);
});

it("undo restores an admin-template pin together with its 'system' origin", async () => {
  const row = seedSchedule({ scheduleId: 'sc', userId: 'u1', scheduleName: 'n', llmModel: TEMPLATE_MODEL, llmModelSource: 'system' });
  const applied = await applyModelChange('u1', { scope: 'schedule', scopeId: 'sc', toModel: SWITCH_TO });
  expect(row()).toMatchObject({ llmModel: SWITCH_TO, llmModelSource: 'user' });
  expect(recordModelChange).toHaveBeenCalledWith(expect.objectContaining({ modelBefore: TEMPLATE_MODEL, modelSourceBefore: 'system' }));

  await undoModelChange('u1', applied.changeId as string);
  expect(row()).toMatchObject({ llmModel: TEMPLATE_MODEL, llmModelSource: 'system' });
});

it('an ordinary owner pin: no origin is written by the switch, recorded, or restored', async () => {
  const row = seedSchedule({ scheduleId: 'sc', userId: 'u1', scheduleName: 'n', llmModel: TEMPLATE_MODEL });
  const applied = await applyModelChange('u1', { scope: 'schedule', scopeId: 'sc', toModel: SWITCH_TO });
  expect(row()).not.toHaveProperty('llmModelSource');
  expect((recordModelChange as jest.Mock).mock.calls[0][0]).not.toHaveProperty('modelSourceBefore');
  await undoModelChange('u1', applied.changeId as string);
  expect(row()).toEqual({ scheduleId: 'sc', userId: 'u1', scheduleName: 'n', llmModel: TEMPLATE_MODEL });
});

it("apply-time rollback (the audit write fails) restores the admin-template pin WITH its 'system' origin", async () => {
  const row = seedSchedule({ scheduleId: 'sc', userId: 'u1', scheduleName: 'n', llmModel: TEMPLATE_MODEL, llmModelSource: 'system' });
  (recordModelChange as jest.Mock).mockRejectedValueOnce(new Error('audit table down'));
  await expect(applyModelChange('u1', { scope: 'schedule', scopeId: 'sc', toModel: SWITCH_TO })).rejects.toThrow('audit table down');
  expect(row()).toMatchObject({ llmModel: TEMPLATE_MODEL, llmModelSource: 'system' });
});
