import { describeMetaWriteParamDrift } from '../services/agentMode/core/approvalDeck';

const dispatch = {
  entity_type: 'AD_SET', action: 'update', account_id: 'act_1', ad_set_id: 'as_1',
  params: { daily_budget: 5000, status: 'ACTIVE', targeting: { geo: ['US'], age_min: 25 } },
};
const deck = (verdict: string): any => ({
  deckId: 'd1', status: 'answered',
  items: [{ itemId: 'i1', kind: 'meta_write', question: 'q', metaWriteManifestDigest: 'dg', metaWriteDispatch: dispatch }],
  answers: [{ itemId: 'i1', verdict, answeredBy: 'user' }],
});

describe('describeMetaWriteParamDrift (ENG-1748)', () => {
  it('names exactly the fields that drifted from the approved preview', () => {
    expect(describeMetaWriteParamDrift(deck('approve'), {
      ...dispatch, params: { daily_budget: 50000, status: 'ACTIVE', targeting: { age_min: 25, geo: ['US', 'CA'] }, confirm: true },
    })).toEqual(['daily_budget', 'targeting']);
  });

  it('returns null for an unchanged replay (key order and gate flags ignored)', () => {
    expect(describeMetaWriteParamDrift(deck('approve'), {
      ...dispatch, params: { targeting: { age_min: 25, geo: ['US'] }, status: 'ACTIVE', daily_budget: 5000, confirm: true },
    })).toBeNull();
  });

  it('never compares against a rejected item or a different target', () => {
    expect(describeMetaWriteParamDrift(deck('reject'), { ...dispatch, params: { daily_budget: 1 } })).toBeNull();
    expect(describeMetaWriteParamDrift(deck('approve'), { ...dispatch, ad_set_id: 'as_2', params: { daily_budget: 1 } })).toBeNull();
  });

  it('returns null when the deck is not answered', () => {
    expect(describeMetaWriteParamDrift({ ...deck('approve'), status: 'awaiting' }, { ...dispatch, params: {} })).toBeNull();
    expect(describeMetaWriteParamDrift(undefined, { ...dispatch, params: {} })).toBeNull();
  });
});
