import {
  ALWAYS_GATED_KINDS,
  CampaignChange,
  StandingAuthorization,
  classifyCampaignChange,
} from '../campaignChangeRiskPolicy';

const base: CampaignChange = {
  orgId: 'org-a',
  provider: 'meta',
  objectId: 'adset-1',
  kind: 'bid_adjustment',
  field: 'bid_amount',
  value: { amount: 120, currency: 'USD' },
  reversible: true,
};

const auth = (over: Partial<StandingAuthorization> = {}): StandingAuthorization => ({
  orgId: 'org-a',
  approvedEntries: [
    { provider: 'meta', objectId: 'adset-1', field: 'bid_amount', value: { currency: 'USD', amount: 120 } },
  ],
  ...over,
});

describe('classifyCampaignChange (ENG-3196)', () => {
  it('AC2: executes an exact, reversible, non-gated manifest match (key order irrelevant)', () => {
    expect(classifyCampaignChange(base, auth()).decision).toBe('execute');
  });

  it('AC2: stages when the value differs from the manifest', () => {
    const r = classifyCampaignChange({ ...base, value: { amount: 121, currency: 'USD' } }, auth());
    expect(r.decision).toBe('stage_for_approval');
  });

  it('AC2: stages when the object id or field differs', () => {
    expect(classifyCampaignChange({ ...base, objectId: 'adset-2' }, auth()).decision).toBe('stage_for_approval');
    expect(classifyCampaignChange({ ...base, field: 'bid_cap' }, auth()).decision).toBe('stage_for_approval');
  });

  it('AC2: stages irreversible changes even with an exact match', () => {
    expect(classifyCampaignChange({ ...base, reversible: false }, auth()).decision).toBe('stage_for_approval');
  });

  it.each([...ALWAYS_GATED_KINDS])('AC1: %s never executes, even with exact manifest match', (kind) => {
    const change = { ...base, kind };
    const r = classifyCampaignChange(change, auth());
    expect(r.decision).toBe('stage_for_approval');
    expect(r.risk).toBe('high');
  });

  it.each([...ALWAYS_GATED_KINDS])('AC1: %s is rejected with no standing authorization', (kind) => {
    expect(classifyCampaignChange({ ...base, kind }, null).decision).toBe('reject');
  });

  it('AC1: covers every gated class named in the parent', () => {
    for (const k of ['budget_increase', 'conversion_definition', 'targeting', 'activation', 'delete', 'archive', 'account_wide']) {
      expect(ALWAYS_GATED_KINDS.has(k)).toBe(true);
    }
  });

  it('AC3: unknown kinds fail closed, even when authorized', () => {
    const r = classifyCampaignChange({ ...base, kind: 'set_pixel' }, auth());
    expect(r).toEqual(expect.objectContaining({ decision: 'reject', risk: 'forbidden' }));
    expect(classifyCampaignChange({ ...base, kind: 'toString' }, auth()).decision).toBe('reject');
  });

  it('AC4: an authorization for org A never authorizes org B', () => {
    const r = classifyCampaignChange({ ...base, orgId: 'org-b' }, auth());
    expect(r.decision).toBe('reject');
    expect(classifyCampaignChange({ ...base, orgId: '' }, auth({ orgId: '' })).decision).toBe('reject');
  });

  it('AC4: deterministic for identical input', () => {
    const a = classifyCampaignChange(base, auth());
    const b = classifyCampaignChange({ ...base }, auth());
    expect(a).toEqual(b);
  });
});
