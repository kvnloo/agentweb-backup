/**
 * ENG-2145 (decision D4): prompt / model / skill changes made in the database emit a report-only
 * "needs eval" marker, so DB-side edits are not invisible to the eval gate.
 */
import {
  EVAL_GATE_LOOP_ID,
  EVT_EVAL_NEEDED,
  SKILL_FIELD_REMOVED,
  buildEvalNeededItem,
  changedEvalSkillFields,
  classifySettingChange,
  listEvalChangeMarkers,
  recordSettingChange,
  recordSkillChange,
  shortHash,
} from '../loops/eval/evalChangeMarkers';
import type { DynamoAttributeMap } from '../loops/core/ports';

const AT = new Date('2026-09-26T08:00:00.000Z');

describe('classifySettingChange', () => {
  it('marks prompt, model, judge, work-plan, skill and tool settings', () => {
    expect(classifySettingChange('agent_mode_system_prompt')).toBe('prompt');
    expect(classifySettingChange('agent_mode_default_model')).toBe('model');
    expect(classifySettingChange('agent_mode_video_generation_default_model')).toBe('model');
    expect(classifySettingChange('default-scoring-prompt')).toBe('judge');
    expect(classifySettingChange('scoring-judges')).toBe('judge');
    expect(classifySettingChange('agent-mode-predefined-workplans')).toBe('workplan');
    expect(classifySettingChange('public_allowed_skills')).toBe('skill');
    expect(classifySettingChange('foundation_tools')).toBe('tools');
  });

  it('ignores settings that cannot move agent quality', () => {
    for (const name of ['oncall_emails', 'subscription_types', 'usernote_abc', 'slack_admin_channel', 'agent_mode_welcome_message', 'constructor', 'toString']) {
      expect(classifySettingChange(name)).toBeNull();
    }
  });
});

describe('changedEvalSkillFields', () => {
  // SKILL_FIELD_REMOVED must itself be a defined, non-empty value — the whole point is to be
  // distinguishable from "no change", including under Jest's toEqual (which treats an
  // undefined-valued key as equal to an absent one, so a sentinel that's accidentally undefined
  // would make these assertions pass vacuously whether or not removals are actually detected).
  it('is a real, defined value', () => {
    expect(SKILL_FIELD_REMOVED).toBeDefined();
    expect(typeof SKILL_FIELD_REMOVED).toBe('string');
    expect(SKILL_FIELD_REMOVED.length).toBeGreaterThan(0);
  });

  it('flags a field cleared back to unset as a removal, not "no change" (ENG-2195 CodeRabbit)', () => {
    const before = { systemPrompt: 'old prompt', llmModel: 'gemini-3.5-flash', toolNames: ['a'], isPublished: true, maxIterations: 5 };
    // A replacement write that omits systemPrompt and llmModel genuinely clears them.
    const after = { toolNames: ['a'], isPublished: true, maxIterations: 5 };
    const changed = changedEvalSkillFields(before, after);
    expect(Object.keys(changed).sort()).toEqual(['llmModel', 'systemPrompt']);
    expect(changed.systemPrompt).toBe(SKILL_FIELD_REMOVED);
    expect(changed.llmModel).toBe(SKILL_FIELD_REMOVED);
  });

  it('does not flag a field absent in both before and after as removed', () => {
    expect(changedEvalSkillFields({ toolNames: ['a'] }, { toolNames: ['a'] })).toEqual({});
    expect(changedEvalSkillFields({ name: 'x' }, { name: 'y' })).toEqual({});
    // No prior row at all (before undefined): a field set for the first time is a real change,
    // not a "removal" of something that never existed.
    expect(changedEvalSkillFields(undefined, { toolNames: ['a'] })).toEqual({ toolNames: ['a'] });
  });

  it('still detects an ordinary value change alongside a removal', () => {
    const before = { systemPrompt: 'old', llmModel: 'model-a' };
    const after = { llmModel: 'model-b' };
    const changed = changedEvalSkillFields(before, after);
    expect(Object.keys(changed).sort()).toEqual(['llmModel', 'systemPrompt']);
    expect(changed.systemPrompt).toBe(SKILL_FIELD_REMOVED);
    expect(changed.llmModel).toBe('model-b');
  });
});

describe('recording markers', () => {
  it('writes one eval_needed row to the eval-gate loop with a value hash, never the prompt text', async () => {
    const write = jest.fn<Promise<void>, [DynamoAttributeMap]>().mockResolvedValue(undefined);
    const prompt = 'You are Emma. Secret sauce prompt text.';
    await expect(recordSettingChange('agent_mode_system_prompt', 'set', prompt, { write, now: () => AT, env: {} })).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0];
    expect(item).toMatchObject({
      loopId: EVAL_GATE_LOOP_ID,
      eventType: EVT_EVAL_NEEDED,
      subjectId: 'setting:agent_mode_system_prompt',
      dimensions: { changeKind: 'setting', target: 'agent_mode_system_prompt', category: 'prompt', action: 'set', valueSha: shortHash(prompt), gateMode: 'report_only' },
    });
    expect(JSON.stringify(item)).not.toContain('Secret sauce');
  });

  it('gives every marker its own sort key under the time prefix, so same-millisecond writes never overwrite each other', () => {
    const marker = { changeKind: 'setting' as const, target: 'agent_mode_default_model', category: 'model' as const, action: 'set' as const, via: 'settingsService' };
    const first = buildEvalNeededItem(marker, AT);
    const second = buildEvalNeededItem(marker, AT);
    const prefix = `${AT.toISOString()}#setting:agent_mode_default_model#${EVT_EVAL_NEEDED}#`;
    expect(String(first.tsSession).startsWith(prefix)).toBe(true);
    expect(String(second.tsSession).startsWith(prefix)).toBe(true);
    expect(first.tsSession).not.toBe(second.tsSession);
  });

  it('writes nothing for an irrelevant setting or when EVAL_CHANGE_MARKERS_ENABLED=false', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    await expect(recordSettingChange('oncall_emails', 'set', '[]', { write, env: {} })).resolves.toBe(false);
    await expect(recordSettingChange('agent_mode_default_model', 'set', 'x', { write, env: { EVAL_CHANGE_MARKERS_ENABLED: 'false' } })).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('never throws when the telemetry write fails', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const write = jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    await expect(recordSettingChange('default-scoring-model', 'delete', undefined, { write, env: {} })).resolves.toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('marks a skill write only when it touches a prompt, tool, model or publish field', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    await expect(recordSkillChange('skill-1', 'update', { name: 'Renamed' }, { write, env: {} })).resolves.toBe(false);
    await expect(recordSkillChange('skill-1', 'update', { systemPrompt: 'new', toolNames: ['a'] }, { write, env: {}, now: () => AT })).resolves.toBe(true);
    await expect(recordSkillChange('skill-1', 'delete', {}, { write, env: {} })).resolves.toBe(true);
    expect(write.mock.calls[0][0]).toMatchObject({ subjectId: 'skill:skill-1', dimensions: { category: 'skill', action: 'update', fields: 'systemPrompt,toolNames', valueSha: shortHash('new') } });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('marks an update whose only eval-relevant change is a removal, without hashing the sentinel as prompt content (ENG-2195 CodeRabbit)', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    await expect(recordSkillChange('skill-1', 'update', { systemPrompt: SKILL_FIELD_REMOVED }, { write, env: {}, now: () => AT })).resolves.toBe(true);
    const item = write.mock.calls[0][0];
    expect(item).toMatchObject({ dimensions: { action: 'update', fields: 'systemPrompt' } });
    expect(item.dimensions).not.toHaveProperty('value');
    expect(item.dimensions).not.toHaveProperty('valueSha');
  });

  it('lists markers since a time, oldest first, across pages', async () => {
    const item = (target: string) => buildEvalNeededItem({ changeKind: 'setting', target, category: 'model', action: 'set', via: 'settingsService' }, AT);
    const query = jest.fn()
      .mockResolvedValueOnce({ Items: [item('a'), { eventType: 'other' }], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [item('b')] });
    const rows = await listEvalChangeMarkers(query, '2026-09-25T00:00:00.000Z');
    expect(rows.map((r) => r.subjectId)).toEqual(['setting:a', 'setting:b']);
    expect(query.mock.calls[0][0]).toMatchObject({ KeyConditionExpression: 'loopId = :l AND tsSession >= :since', ExpressionAttributeValues: { ':l': 'eval-gate', ':since': '2026-09-25T00:00:00.000Z' } });
    expect(query.mock.calls[1][0].ExclusiveStartKey).toEqual({ k: 1 });
  });
});
