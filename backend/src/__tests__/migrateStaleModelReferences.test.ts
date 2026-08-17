const mockScan = jest.fn();
const mockUpdate = jest.fn();
const mockPut = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      scan: (...a: any[]) => ({ promise: () => mockScan(...a) }),
      update: (...a: any[]) => ({ promise: () => mockUpdate(...a) }),
      put: (...a: any[]) => ({ promise: () => mockPut(...a) }),
    })),
  },
}));

const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: (...a: any[]) => mockGetSetting(...a),
    setSetting: (...a: any[]) => mockSetSetting(...a),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn(async () => [
      'openrouter/x-ai/grok-4.6',
      'openrouter/qwen/qwen3.8-max',
      'openrouter/moonshotai/kimi-k2.7-code',
      'gemini-3.5-flash',
    ]),
    normalizeModelId: jest.fn((id: string) => (id === 'legacy-alias-id' ? 'gemini-3.5-flash' : id)),
  },
}));

import { DynamoDB } from 'aws-sdk';
import {
  planModelMigration,
  collectCandidates,
  SAME_FAMILY_MODEL_REPLACEMENTS,
} from '../scripts/migrateStaleModelReferences';

describe('planModelMigration (pure, ENG-9)', () => {
  const validModelIds = new Set(['openrouter/x-ai/grok-4.6', 'gemini-3.5-flash']);
  const normalizeModelId = (id: string) => (id === 'legacy-alias-id' ? 'gemini-3.5-flash' : id);

  it('treats undefined/empty as ok (nothing to migrate)', () => {
    expect(planModelMigration(undefined, validModelIds, normalizeModelId)).toEqual({ action: 'ok' });
    expect(planModelMigration('   ', validModelIds, normalizeModelId)).toEqual({ action: 'ok' });
  });

  it('treats a currently-valid model id as ok', () => {
    expect(planModelMigration('openrouter/x-ai/grok-4.6', validModelIds, normalizeModelId)).toEqual({ action: 'ok' });
  });

  it('treats a legacy alias that normalizes to a valid model as ok (not stale)', () => {
    // Regression guard: without normalizeModelId, this would false-positive as stale.
    expect(planModelMigration('legacy-alias-id', validModelIds, normalizeModelId)).toEqual({ action: 'ok' });
  });

  it('proposes the same-family replacement for a stale model with a known mapping', () => {
    expect(planModelMigration('openrouter/x-ai/grok-4.3', validModelIds, normalizeModelId)).toEqual({
      action: 'migrate',
      newModel: 'openrouter/x-ai/grok-4.6',
    });
  });

  it('orphans a stale model with no same-family replacement (Llama — no current-gen entrant)', () => {
    expect(planModelMigration('openrouter/meta-llama/llama-4-maverick', validModelIds, normalizeModelId)).toEqual({
      action: 'orphan',
    });
  });

  it('SAME_FAMILY_MODEL_REPLACEMENTS covers exactly the four mapped ENG-9 drops, no Llama entries', () => {
    expect(SAME_FAMILY_MODEL_REPLACEMENTS).toEqual({
      'openrouter/x-ai/grok-4.3': 'openrouter/x-ai/grok-4.6',
      'openrouter/mistralai/mistral-large-2512': 'openrouter/mistralai/mistral-small-2603',
      'openrouter/moonshotai/kimi-k2.6': 'openrouter/moonshotai/kimi-k2.7-code',
      'openrouter/qwen/qwen3.7-flash': 'openrouter/qwen/qwen3.8-max',
    });
  });
});

describe('collectCandidates — dry-run scan across every blast-radius location (ENG-9)', () => {
  let doc: DynamoDB.DocumentClient;
  const validModelIds = new Set([
    'openrouter/x-ai/grok-4.6',
    'openrouter/qwen/qwen3.8-max',
    'openrouter/moonshotai/kimi-k2.7-code',
    'gemini-3.5-flash',
  ]);
  const normalizeModelId = (id: string) => id;

  beforeEach(() => {
    jest.clearAllMocks();
    doc = new DynamoDB.DocumentClient();
  });

  it('flags a stale+mappable model and a stale Llama orphan from a scanned table, and skips a valid one', async () => {
    // AW-TaskSchedules scan
    mockScan.mockResolvedValueOnce({
      Items: [
        { scheduleId: 's-1', llmModel: 'openrouter/x-ai/grok-4.3', llmBackupModel: 'gemini-3.5-flash' },
        { scheduleId: 's-2', llmModel: 'openrouter/meta-llama/llama-4-maverick' },
        { scheduleId: 's-3', llmModel: 'openrouter/x-ai/grok-4.6' }, // currently valid — not a candidate
      ],
    });
    // Remaining 3 scanned tables + JSON-blob settings: empty/none
    mockScan.mockResolvedValue({ Items: [] });
    mockGetSetting.mockResolvedValue(null);

    const candidates = await collectCandidates(doc, '', validModelIds, normalizeModelId);

    const scheduleCandidates = candidates.filter((c) => c.table === 'AW-TaskSchedules');
    expect(scheduleCandidates).toHaveLength(2);
    expect(scheduleCandidates).toContainEqual(
      expect.objectContaining({ recordId: 's-1', field: 'llmModel', oldModel: 'openrouter/x-ai/grok-4.3', plan: { action: 'migrate', newModel: 'openrouter/x-ai/grok-4.6' } })
    );
    expect(scheduleCandidates).toContainEqual(
      expect.objectContaining({ recordId: 's-2', field: 'llmModel', oldModel: 'openrouter/meta-llama/llama-4-maverick', plan: { action: 'orphan' } })
    );
    expect(candidates.find((c) => c.recordId === 's-3')).toBeUndefined();
    expect(candidates.find((c) => c.recordId === 's-1' && c.field === 'llmBackupModel')).toBeUndefined();
  });

  it('never treats llmBackupSource as a model-id field', async () => {
    mockScan.mockResolvedValueOnce({
      Items: [{ scheduleId: 's-4', llmModel: 'gemini-3.5-flash', llmBackupSource: 'system' }],
    });
    mockScan.mockResolvedValue({ Items: [] });
    mockGetSetting.mockResolvedValue(null);

    const candidates = await collectCandidates(doc, '', validModelIds, normalizeModelId);
    expect(candidates.find((c) => c.field === 'llmBackupSource')).toBeUndefined();
  });

  it('flags a stale direct AW-Settings model row', async () => {
    mockScan.mockResolvedValue({ Items: [] });
    mockGetSetting.mockImplementation(async (settingName: string) => {
      if (settingName === 'agent_mode_dedup_judge_model') {
        return { settingName, settingValue: 'openrouter/qwen/qwen3.7-flash' };
      }
      return null;
    });

    const candidates = await collectCandidates(doc, '', validModelIds, normalizeModelId);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        table: 'AW-Settings',
        recordId: 'agent_mode_dedup_judge_model',
        field: 'settingValue',
        oldModel: 'openrouter/qwen/qwen3.7-flash',
        plan: { action: 'migrate', newModel: 'openrouter/qwen/qwen3.8-max' },
      })
    );
  });

  it('does NOT check agent_mode_image_api_default_model / agent_mode_video_api_default_model against llmModels', async () => {
    // These validate against a SEPARATE IMAGE_API_MODELS/VIDEO_API_MODELS list —
    // asserting no candidate is emitted for them proves the script never queries
    // (or misjudges) those two settings against the llmModels registry.
    mockScan.mockResolvedValue({ Items: [] });
    mockGetSetting.mockResolvedValue(null);

    await collectCandidates(doc, '', validModelIds, normalizeModelId);
    const queriedNames = mockGetSetting.mock.calls.map((c) => c[0]);
    expect(queriedNames).not.toContain('agent_mode_image_api_default_model');
    expect(queriedNames).not.toContain('agent_mode_video_api_default_model');
  });

  it('flags a stale judge inside the scoring-judges JSON blob', async () => {
    mockScan.mockResolvedValue({ Items: [] });
    mockGetSetting.mockImplementation(async (settingName: string) => {
      if (settingName === 'scoring-judges') {
        return {
          settingName,
          settingValue: JSON.stringify([
            { id: 'judge-1', llmModel: 'openrouter/moonshotai/kimi-k2.6' },
            { id: 'judge-2', llmModel: 'gemini-3.5-flash' },
          ]),
        };
      }
      return null;
    });

    const candidates = await collectCandidates(doc, '', validModelIds, normalizeModelId);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        table: 'AW-Settings[scoring-judges]',
        recordId: 'judge-1',
        field: 'llmModel',
        oldModel: 'openrouter/moonshotai/kimi-k2.6',
        plan: { action: 'migrate', newModel: 'openrouter/moonshotai/kimi-k2.7-code' },
      })
    );
    expect(candidates.find((c) => c.recordId === 'judge-2')).toBeUndefined();
  });

  it('flags a stale defaultModel inside the agent-mode-predefined-workplans JSON blob', async () => {
    mockScan.mockResolvedValue({ Items: [] });
    mockGetSetting.mockImplementation(async (settingName: string) => {
      if (settingName === 'agent-mode-predefined-workplans') {
        return {
          settingName,
          settingValue: JSON.stringify([{ id: 'plan-1', defaultModel: 'openrouter/mistralai/mistral-large-2512' }]),
        };
      }
      return null;
    });

    const candidates = await collectCandidates(doc, '', validModelIds, normalizeModelId);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        table: 'AW-Settings[agent-mode-predefined-workplans]',
        recordId: 'plan-1',
        field: 'defaultModel',
        oldModel: 'openrouter/mistralai/mistral-large-2512',
        plan: { action: 'migrate', newModel: 'openrouter/mistralai/mistral-small-2603' },
      })
    );
  });

  it('never calls any write method — dry-run collection is provably read-only', async () => {
    mockScan.mockResolvedValueOnce({
      Items: [{ scheduleId: 's-1', llmModel: 'openrouter/x-ai/grok-4.3' }],
    });
    mockScan.mockResolvedValue({ Items: [] });
    mockGetSetting.mockImplementation(async (settingName: string) => {
      if (settingName === 'scoring-judges') {
        return { settingName, settingValue: JSON.stringify([{ id: 'j-1', llmModel: 'openrouter/x-ai/grok-4.3' }]) };
      }
      return null;
    });

    await collectCandidates(doc, '', validModelIds, normalizeModelId);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('reports ~0 candidates against an all-clean snapshot (matches the real production dry-run)', async () => {
    mockScan.mockResolvedValue({ Items: [] });
    mockGetSetting.mockResolvedValue(null);

    const candidates = await collectCandidates(doc, '', validModelIds, normalizeModelId);
    expect(candidates).toHaveLength(0);
  });
});
