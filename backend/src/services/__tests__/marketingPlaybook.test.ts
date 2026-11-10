import { diffPlaybooks, validatePlaybook, type CampaignPlaybook } from '../marketingPlaybook';

const snap = { entityId: 'e1', status: 'PAUSED', dailyBudget: 5000, bidAmount: 120 };
const base = (steps: CampaignPlaybook['steps'], extra: Partial<CampaignPlaybook> = {}): CampaignPlaybook => ({
  id: 'pb1',
  version: '1.0.0',
  steps,
  ...extra,
});
const codes = (pb: CampaignPlaybook) => validatePlaybook(pb).errors.map((e) => e.code);

describe('validatePlaybook (ENG-2891)', () => {
  it('accepts low-risk steps and high-risk steps with a provable rollback', () => {
    const result = validatePlaybook(
      base([
        { id: 's1', actionType: 'pause_ad', objectLevel: 'ad', owned: true },
        { id: 's2', actionType: 'scale_budget', objectLevel: 'adset', owned: true, entityId: 'e1', snapshot: snap },
        { id: 's3', actionType: 'activate_ad', objectLevel: 'ad', owned: true, entityId: 'e1', snapshot: snap },
      ]),
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects unknown action types', () => {
    expect(codes(base([{ id: 's1', actionType: 'teleport_budget', objectLevel: 'ad' }]))).toEqual([
      'unknown_action_type',
    ]);
  });

  it('rejects duplicate step ids', () => {
    expect(
      codes(
        base([
          { id: 's1', actionType: 'pause_ad', objectLevel: 'ad', owned: true },
          { id: 's1', actionType: 'pause_adset', objectLevel: 'adset', owned: true },
        ]),
      ),
    ).toEqual(['duplicate_step_id']);
  });

  it.each([
    ['scale_budget without snapshot', { id: 's1', actionType: 'scale_budget', objectLevel: 'adset', owned: true, entityId: 'e1' }],
    ['raise_bid on unowned entity', { id: 's1', actionType: 'raise_bid', objectLevel: 'ad', owned: false, entityId: 'e1', snapshot: snap }],
    ['delete_campaign (never reversible)', { id: 's1', actionType: 'delete_campaign', objectLevel: 'campaign', owned: true, entityId: 'e1', snapshot: snap }],
    ['update_targeting (never reversible)', { id: 's1', actionType: 'update_targeting', objectLevel: 'adset', owned: true, entityId: 'e1', snapshot: snap }],
  ])('rejects high-risk step without rollback: %s', (_label, step) => {
    expect(codes(base([step]))).toEqual(['missing_rollback']);
  });

  it('does not demand rollback for non-high-risk steps', () => {
    expect(codes(base([{ id: 's1', actionType: 'refresh_creative', objectLevel: 'ad' }]))).toEqual([]);
  });

  it('rejects malformed playbook, id, version, and step', () => {
    expect(codes(null as unknown as CampaignPlaybook)).toEqual(['invalid_playbook']);
    expect(codes(base([{} as never], { id: ' ', version: 'v1' }))).toEqual([
      'invalid_id',
      'invalid_version',
      'invalid_step',
    ]);
  });
});

describe('diffPlaybooks (ENG-2891)', () => {
  const a = base([
    { id: 's1', actionType: 'pause_ad', objectLevel: 'ad', owned: true },
    { id: 's2', actionType: 'lower_bid', objectLevel: 'ad' },
    { id: 's3', actionType: 'pause_adset', objectLevel: 'adset' },
  ]);

  it('returns sorted added/removed/changed step ids', () => {
    const b = base(
      [
        { id: 's4', actionType: 'pause_ad', objectLevel: 'ad' },
        { id: 's2', actionType: 'lower_bid', objectLevel: 'adset' },
        { objectLevel: 'ad', owned: true, actionType: 'pause_ad', id: 's1' },
        { id: 's0', actionType: 'pause_ad', objectLevel: 'ad' },
      ],
      { version: '1.1.0' },
    );
    expect(diffPlaybooks(a, b)).toEqual({ added: ['s0', 's4'], removed: ['s3'], changed: ['s2'] });
  });

  it('is empty for identical playbooks and deterministic across calls', () => {
    expect(diffPlaybooks(a, a)).toEqual({ added: [], removed: [], changed: [] });
    expect(diffPlaybooks(null, a)).toEqual(diffPlaybooks(null, a));
    expect(diffPlaybooks(null, a).added).toEqual(['s1', 's2', 's3']);
  });
});
