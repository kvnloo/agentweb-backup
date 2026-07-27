/**
 * ENG-442 — pure send-safety gate + targeting/step builders for the CRM
 * sequence agent tools.
 *
 * The gate is the hard safety requirement: a drip sequence must never be able
 * to start sending to real leads from an unattended (scheduled/automated) run.
 */

import {
  ATTENDED_SESSION_TYPES,
  buildSequenceTargeting,
  describeSequenceTarget,
  evaluateSequenceSendApproval,
  normalizeSequenceSteps,
  resolveSequenceRunMode,
  SequenceInputError,
  summarizeSequence,
} from '../services/crmSequenceApproval';

describe('resolveSequenceRunMode', () => {
  const neverCalled = jest.fn(async () => {
    throw new Error('loadSessionType should not have been called');
  });

  it('treats an explicit unattended flag as unattended', async () => {
    await expect(
      resolveSequenceRunMode({ sessionId: 'sess-1', unattended: true }, neverCalled),
    ).resolves.toBe('unattended');
  });

  it('fails closed to unattended when there is no session at all', async () => {
    await expect(resolveSequenceRunMode(undefined, neverCalled)).resolves.toBe('unattended');
    await expect(resolveSequenceRunMode({}, neverCalled)).resolves.toBe('unattended');
  });

  it('classifies a scheduled Emma session as unattended', async () => {
    const load = jest.fn(async () => 'scheduled');
    await expect(resolveSequenceRunMode({ sessionId: 'sess-1' }, load)).resolves.toBe('unattended');
    expect(load).toHaveBeenCalledWith('sess-1');
  });

  it('fails closed when the session cannot be resolved (unknown / external transport id)', async () => {
    await expect(
      resolveSequenceRunMode({ sessionId: 'mcp-transport-id' }, async () => undefined),
    ).resolves.toBe('unattended');
    await expect(
      resolveSequenceRunMode({ sessionId: 'sess-1' }, async () => null),
    ).resolves.toBe('unattended');
  });

  it('fails closed when the session lookup throws', async () => {
    await expect(
      resolveSequenceRunMode({ sessionId: 'sess-1' }, async () => {
        throw new Error('dynamo down');
      }),
    ).resolves.toBe('unattended');
  });

  it('fails closed on any session type not on the attended allowlist', async () => {
    for (const sessionType of ['emma-email', 'meeting-intake', 'report_generation', 'result-endpoint']) {
      await expect(
        resolveSequenceRunMode({ sessionId: 'sess-1' }, async () => sessionType),
      ).resolves.toBe('unattended');
    }
  });

  it('classifies a human-attended chat session as interactive', async () => {
    for (const sessionType of ATTENDED_SESSION_TYPES) {
      await expect(
        resolveSequenceRunMode({ sessionId: 'sess-1' }, async () => sessionType),
      ).resolves.toBe('interactive');
    }
  });
});

describe('evaluateSequenceSendApproval', () => {
  it('blocks an unattended run even when the caller passes confirm=true', () => {
    const decision = evaluateSequenceSendApproval({ runMode: 'unattended', confirmed: true });
    expect(decision.approved).toBe(false);
    expect(decision).toMatchObject({ reason: 'unattended_run' });
  });

  it('blocks an unattended run with confirm omitted', () => {
    expect(evaluateSequenceSendApproval({ runMode: 'unattended', confirmed: false })).toMatchObject({
      approved: false,
      reason: 'unattended_run',
    });
  });

  it('requires explicit confirmation in an interactive run', () => {
    expect(evaluateSequenceSendApproval({ runMode: 'interactive', confirmed: false })).toMatchObject({
      approved: false,
      reason: 'confirmation_required',
    });
  });

  it('approves an interactive run that carries explicit human confirmation', () => {
    expect(evaluateSequenceSendApproval({ runMode: 'interactive', confirmed: true })).toEqual({
      approved: true,
    });
  });
});

describe('buildSequenceTargeting', () => {
  it('defaults to manual enrollment when no target is given', () => {
    expect(buildSequenceTargeting(undefined)).toEqual({
      enrollmentTrigger: { type: 'manual' },
    });
  });

  it('maps a lead list to a list_membership trigger', () => {
    expect(buildSequenceTargeting({ lead_list_id: 'list-1' })).toEqual({
      enrollmentTrigger: { type: 'list_membership', listId: 'list-1' },
    });
  });

  it('maps a bare lifecycle to a lifecycle_change trigger', () => {
    expect(buildSequenceTargeting({ lifecycle: 'trialing' })).toEqual({
      enrollmentTrigger: { type: 'lifecycle_change', lifecycleStage: 'trialing' },
    });
  });

  it('maps lifecycle alongside a list to an enrollment condition', () => {
    expect(buildSequenceTargeting({ lead_list_id: 'list-1', lifecycle: 'paying' })).toEqual({
      enrollmentTrigger: { type: 'list_membership', listId: 'list-1' },
      enrollmentCondition: { field: 'lifecycle', operator: 'eq', value: 'paying' },
    });
  });

  it('maps min_heat_score to a gte heatScore condition', () => {
    expect(buildSequenceTargeting({ lead_list_id: 'list-1', min_heat_score: 60 })).toEqual({
      enrollmentTrigger: { type: 'list_membership', listId: 'list-1' },
      enrollmentCondition: { field: 'heatScore', operator: 'gte', value: 60 },
    });
  });

  it('rejects an unknown lifecycle value instead of silently dropping it', () => {
    expect(() => buildSequenceTargeting({ lifecycle: 'super_hot' })).toThrow(SequenceInputError);
  });

  it('rejects an out-of-range or non-numeric heat score', () => {
    expect(() => buildSequenceTargeting({ min_heat_score: -1 })).toThrow(SequenceInputError);
    expect(() => buildSequenceTargeting({ min_heat_score: 101 })).toThrow(SequenceInputError);
    expect(() => buildSequenceTargeting({ min_heat_score: 'hot' as any })).toThrow(SequenceInputError);
  });

  it('fails loudly when lifecycle and heat both need the single condition slot', () => {
    expect(() =>
      buildSequenceTargeting({ lead_list_id: 'list-1', lifecycle: 'trialing', min_heat_score: 50 }),
    ).toThrow(SequenceInputError);
  });

  it('uses both slots when lifecycle drives the trigger and heat drives the condition', () => {
    expect(buildSequenceTargeting({ lifecycle: 'trialing', min_heat_score: 50 })).toEqual({
      enrollmentTrigger: { type: 'lifecycle_change', lifecycleStage: 'trialing' },
      enrollmentCondition: { field: 'heatScore', operator: 'gte', value: 50 },
    });
  });
});

describe('normalizeSequenceSteps', () => {
  it('requires at least one step', () => {
    expect(() => normalizeSequenceSteps(undefined)).toThrow(SequenceInputError);
    expect(() => normalizeSequenceSteps([])).toThrow(SequenceInputError);
  });

  it('requires subject and body on every step', () => {
    expect(() => normalizeSequenceSteps([{ subject: 'Hi' } as any])).toThrow(SequenceInputError);
    expect(() => normalizeSequenceSteps([{ body_html: '<p>Hi</p>' } as any])).toThrow(SequenceInputError);
  });

  it('rejects a negative or non-integer cadence', () => {
    expect(() =>
      normalizeSequenceSteps([{ subject: 'a', body_html: 'b', delay_days: -1 }]),
    ).toThrow(SequenceInputError);
    expect(() =>
      normalizeSequenceSteps([{ subject: 'a', body_html: 'b', delay_days: 1.5 }]),
    ).toThrow(SequenceInputError);
  });

  it('normalizes a multi-step email sequence with cadence and default names', () => {
    expect(
      normalizeSequenceSteps([
        { subject: 'Welcome', body_html: '<p>Hello</p>' },
        { name: 'Nudge', subject: 'Still there?', body_html: '<p>Ping</p>', delay_days: 4 },
      ]),
    ).toEqual([
      { stepNumber: 1, name: 'Step 1', delayDays: 0, channel: 'email', subject: 'Welcome', bodyHtml: '<p>Hello</p>' },
      { stepNumber: 2, name: 'Nudge', delayDays: 4, channel: 'email', subject: 'Still there?', bodyHtml: '<p>Ping</p>' },
    ]);
  });

  it('defaults the first step to immediate and later steps to a 3-day gap', () => {
    const steps = normalizeSequenceSteps([
      { subject: 'a', body_html: 'a' },
      { subject: 'b', body_html: 'b' },
    ]);
    expect(steps.map((s) => s.delayDays)).toEqual([0, 3]);
  });
});

describe('summarizeSequence / describeSequenceTarget', () => {
  const sequence = {
    sequenceId: 'seq-1',
    name: 'Trial nurture',
    status: 'paused',
    campaignType: 'nurture',
    enrollmentTrigger: { type: 'list_membership', listId: 'list-1' },
    enrollmentCondition: { field: 'heatScore', operator: 'gte', value: 60 },
    autoEnrollListIds: ['list-1'],
    steps: [{ stepId: 's1' }, { stepId: 's2' }, { stepId: 's3' }],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  };

  it('reports name, status, target segment and step count', () => {
    const summary = summarizeSequence(sequence);
    expect(summary).toMatchObject({
      sequence_id: 'seq-1',
      name: 'Trial nurture',
      status: 'paused',
      step_count: 3,
      is_sending: false,
    });
    expect(summary.target).toContain('list-1');
    expect(summary.target).toContain('heatScore');
  });

  it('marks an active sequence as sending', () => {
    expect(summarizeSequence({ ...sequence, status: 'active' }).is_sending).toBe(true);
  });

  it('describes a manual-enrollment sequence without inventing a segment', () => {
    expect(
      describeSequenceTarget({ enrollmentTrigger: { type: 'manual' }, steps: [] }),
    ).toBe('manual enrollment only');
  });

  it('tolerates a sequence with no steps array', () => {
    expect(summarizeSequence({ sequenceId: 'seq-2', name: 'x', status: 'draft' }).step_count).toBe(0);
  });
});
