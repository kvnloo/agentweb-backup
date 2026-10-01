/**
 * ENG-2195: skillService itself records the "needs eval" marker, so every caller is covered — the
 * admin routes, Emma's create/update tools, agentModeService, the user skill routes and the
 * scripts/patch-* and rewrite-* scripts all write through it. The marker names only the
 * eval-relevant fields the write changed (the row it replaced comes back through ALL_OLD), and is
 * never written when the skill write fails.
 */

const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockGet = jest.fn();
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: mockPut,
      delete: mockDelete,
      get: mockGet,
      createSet: (values: string[]) => ({ values }),
    })),
  },
}));

import { skillService, type Skill } from '../services/skillService';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';

type PutParams = { TableName: string; Item: Record<string, unknown> };

const resolved = (value: unknown) => ({ promise: jest.fn().mockResolvedValue(value) });
const rejected = () => ({ promise: jest.fn().mockRejectedValue(new Error('ConditionalCheckFailedException')) });

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The `dimensions` of every eval_needed marker written to Dev-AW-LoopEvents so far. */
function markers(): Record<string, unknown>[] {
  return mockPut.mock.calls
    .map(([params]) => params as PutParams)
    .filter((p) => p.TableName === LOOP_EVENTS_TABLE && p.Item.eventType === 'eval_needed')
    .map((p) => p.Item.dimensions as Record<string, unknown>);
}

const stored = (overrides: Partial<Skill> = {}): Skill => ({
  skillId: 's1',
  name: 'Weekly digest',
  description: 'd',
  toolNames: ['a', 'b'],
  systemPrompt: 'old prompt',
  isPublished: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockPut.mockReturnValue(resolved({}));
  mockDelete.mockReturnValue(resolved({}));
});

describe('skillService records eval_needed markers for every caller', () => {
  it('marks a create', async () => {
    const skill = await skillService.createSkill('n', 'd', ['a'], 'prompt', false);
    await flush();
    expect(markers()).toEqual([
      expect.objectContaining({ changeKind: 'skill', target: skill.skillId, action: 'create', via: 'skillService', fields: 'systemPrompt,toolNames,isPublished' }),
    ]);
  });

  it('marks an update with only the eval-relevant fields that changed', async () => {
    mockPut.mockReturnValueOnce(resolved({ Attributes: { ...stored(), toolNames: { values: ['b', 'a'] } } }));
    await skillService.updateSkill(stored({ systemPrompt: 'new prompt', name: 'Renamed' }));
    await flush();
    expect(markers()).toEqual([expect.objectContaining({ target: 's1', action: 'update', fields: 'systemPrompt' })]);
  });

  it('does not mark an update that leaves prompt, tools, model and publish state alone', async () => {
    mockPut.mockReturnValueOnce(resolved({ Attributes: stored() }));
    await skillService.updateSkill(stored({ name: 'Renamed', description: 'new copy' }));
    await flush();
    expect(markers()).toEqual([]);
  });

  it('marks an update that clears an eval-relevant field back to unset (ENG-2195 CodeRabbit)', async () => {
    // The stored row has a systemPrompt; the write replaces it with a skill object that never
    // sets the key at all — the same shape a caller genuinely clearing the field would produce,
    // and skillService.putSkill's full-item put drops the attribute exactly like an explicit clear.
    mockPut.mockReturnValueOnce(resolved({ Attributes: stored() }));
    const withoutPrompt: Skill = { ...stored({ name: 'Renamed' }) };
    delete withoutPrompt.systemPrompt;
    await skillService.updateSkill(withoutPrompt);
    await flush();
    expect(markers()).toEqual([expect.objectContaining({ target: 's1', action: 'update', fields: 'systemPrompt' })]);
    // Nothing was written for the field, so nothing to hash as its content.
    expect(markers()[0]).not.toHaveProperty('value');
    expect(markers()[0]).not.toHaveProperty('valueSha');
  });

  it('marks an approve, which makes the skill public', async () => {
    mockGet.mockReturnValueOnce(resolved({ Item: stored({ visibility: 'pending_review', isPublished: false }) }));
    mockPut.mockReturnValueOnce(resolved({ Attributes: stored({ visibility: 'pending_review', isPublished: false }) }));
    await skillService.approveSkill('s1');
    await flush();
    expect(markers()).toEqual([expect.objectContaining({ target: 's1', action: 'approve' })]);
  });

  it('marks a sync', async () => {
    mockGet.mockReturnValueOnce(resolved({ Item: stored({ systemPrompt: 'dev prompt' }) }));
    mockPut.mockReturnValueOnce(resolved({ Attributes: stored() }));
    await skillService.syncSkill('s1', 'dev-to-prod');
    await flush();
    expect(markers()).toEqual([expect.objectContaining({ target: 's1', action: 'sync', fields: 'systemPrompt' })]);
  });

  it('marks the delete of a skill that existed, and not of one that did not', async () => {
    mockDelete.mockReturnValueOnce(resolved({ Attributes: stored() }));
    await skillService.deleteSkill('s1');
    mockDelete.mockReturnValueOnce(resolved({}));
    await skillService.deleteSkill('missing');
    await flush();
    expect(markers()).toEqual([expect.objectContaining({ target: 's1', action: 'delete' })]);
  });

  it('marks nothing when the skill write fails', async () => {
    mockPut.mockReturnValueOnce(rejected());
    await expect(skillService.updateSkill(stored({ systemPrompt: 'new prompt' }))).rejects.toThrow('ConditionalCheckFailedException');
    mockPut.mockReturnValueOnce(rejected());
    await expect(skillService.createSkill('n', 'd', ['a'], 'prompt')).rejects.toThrow();
    await flush();
    expect(markers()).toEqual([]);
  });
});
