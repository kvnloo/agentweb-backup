/**
 * ENG-2145: AW-Settings writes (settingsService) record a "needs eval" marker after the write
 * succeeds, and never when it fails. Report-only: the write's own result is unchanged. Skill writes
 * are marked inside skillService (ENG-2195, skillService.evalMarkers.test.ts), not by the routes.
 */
import type { Request, Response } from 'express';

const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockGet = jest.fn();
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({ put: mockPut, delete: mockDelete, get: mockGet })) },
}));
jest.mock('../loops/eval/evalChangeMarkers', () => ({
  recordSettingChange: jest.fn().mockResolvedValue(true),
  recordSkillChange: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/skillService', () => ({
  skillService: { createSkill: jest.fn(), getSkill: jest.fn(), updateSkill: jest.fn(), deleteSkill: jest.fn(), syncSkill: jest.fn() },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/subscriptionService', () => ({
  findTiersAllowingSkill: jest.fn().mockResolvedValue({ reachable: true }),
}));

import { recordSettingChange, recordSkillChange } from '../loops/eval/evalChangeMarkers';
import { settingsService } from '../services/settingsService';
import { skillService } from '../services/skillService';
import { createSkill, deleteSkill, updateSkill } from '../controllers/skillController';

const ok = () => ({ promise: jest.fn().mockResolvedValue({}) });
const fail = () => ({ promise: jest.fn().mockRejectedValue(new Error('ConditionalCheckFailed')) });

function res(): Response {
  const r: Partial<Response> = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('settingsService marks eval-relevant writes', () => {
  it('records a set after the row is written', async () => {
    mockPut.mockReturnValue(ok());
    await settingsService.setSetting('agent_mode_system_prompt', 'new prompt', 'desc', 'admin@example.com');
    expect(recordSettingChange).toHaveBeenCalledWith('agent_mode_system_prompt', 'set', 'new prompt');
  });

  it('records a delete after the row is deleted', async () => {
    mockDelete.mockReturnValue(ok());
    await settingsService.deleteSetting('default-scoring-model');
    expect(recordSettingChange).toHaveBeenCalledWith('default-scoring-model', 'delete', undefined);
  });

  it('records nothing when the write fails', async () => {
    mockPut.mockReturnValue(fail());
    await expect(settingsService.setSetting('agent_mode_system_prompt', 'x')).rejects.toThrow('ConditionalCheckFailed');
    expect(recordSettingChange).not.toHaveBeenCalled();
  });
});

describe('settingsService marks conditional writes and plan syncs only after they succeed', () => {
  it('records a compare-and-swap set and delete', async () => {
    mockPut.mockReturnValue(ok());
    mockDelete.mockReturnValue(ok());
    await settingsService.setSettingIfValueMatches('agent_mode_default_model', 'model-b', 'model-a');
    await settingsService.deleteSettingIfValueMatches('agent_mode_system_prompt', 'old');
    expect(recordSettingChange).toHaveBeenCalledWith('agent_mode_default_model', 'set', 'model-b');
    expect(recordSettingChange).toHaveBeenCalledWith('agent_mode_system_prompt', 'delete', undefined);
  });

  it('records nothing when the condition fails', async () => {
    mockPut.mockReturnValue(fail());
    mockDelete.mockReturnValue(fail());
    await expect(settingsService.setSettingIfValueMatches('agent_mode_default_model', 'b', 'a')).rejects.toThrow();
    await expect(settingsService.deleteSettingIfValueMatches('agent_mode_system_prompt', 'old')).rejects.toThrow();
    expect(recordSettingChange).not.toHaveBeenCalled();
  });

  it('records a synced work plan after it is written, and nothing when the write fails', async () => {
    const plan = { id: 'p1', title: 'Plan' };
    mockGet
      .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: { settingValue: JSON.stringify([plan]) } }) })
      .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });
    mockPut.mockReturnValue(ok());
    await settingsService.syncPlan('p1', 'dev-to-prod');
    expect(recordSettingChange).toHaveBeenCalledWith('agent-mode-predefined-workplans', 'sync', JSON.stringify([plan]));

    jest.mocked(recordSettingChange).mockClear();
    mockGet
      .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: { settingValue: JSON.stringify([plan]) } }) })
      .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });
    mockPut.mockReturnValue(fail());
    await expect(settingsService.syncPlan('p1', 'dev-to-prod')).rejects.toThrow();
    expect(recordSettingChange).not.toHaveBeenCalled();
  });
});

describe('admin skill routes leave marker recording to skillService (ENG-2195)', () => {
  // skillService is mocked here, so any marker seen would be a second, controller-level one.
  it('records nothing itself on create, update or delete', async () => {
    const stored = { skillId: 's1', name: 'n', description: 'd', toolNames: [], isPublished: true, createdAt: '', updatedAt: '' };
    jest.mocked(skillService.createSkill).mockResolvedValue(stored);
    jest.mocked(skillService.getSkill).mockResolvedValue(stored);
    jest.mocked(skillService.updateSkill).mockResolvedValue('2026-09-26T00:00:00.000Z');
    jest.mocked(skillService.deleteSkill).mockResolvedValue(undefined);
    await createSkill({ body: { name: 'n', description: 'd', systemPrompt: 'p', isPublished: true } } as unknown as Request, res());
    await updateSkill({ params: { skillId: 's1' }, body: { systemPrompt: 'new', toolNames: ['a'] } } as unknown as Request, res());
    await deleteSkill({ params: { skillId: 's1' } } as unknown as Request, res());
    expect(skillService.updateSkill).toHaveBeenCalled();
    expect(recordSkillChange).not.toHaveBeenCalled();
  });
});
