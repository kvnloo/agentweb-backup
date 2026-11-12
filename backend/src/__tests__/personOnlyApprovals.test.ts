import { personOnlyApprovalsIn } from '../services/personOnlyApprovals';

const deck = (items: any[]) => ({ deckId: 'd', status: 'awaiting', items, createdAt: '', finalizedAt: '' } as any);

describe('personOnlyApprovalsIn (ENG-2962)', () => {
  it('finds approvals of person-only cards only', () => {
    const d = deck([
      { itemId: 'a', kind: 'smartlead_push_approval:start:x:n' },
      { itemId: 'b', kind: 'hot_lead_call_approval:call:x:n' },
      { itemId: 'c', kind: 'crm_sequence_activation:s:t' },
      { itemId: 'e', kind: 'meta_write', metaWriteDispatch: { action: 'CREATE_PAUSED_BUNDLE' } },
      { itemId: 'f', kind: 'meta_write' },
      { itemId: 'g', kind: 'plan_choice' },
    ]);
    const answers = ['a', 'b', 'e', 'f', 'g'].map((itemId) => ({ itemId, verdict: 'approve' })).concat([{ itemId: 'c', verdict: 'activate' }]);
    expect(personOnlyApprovalsIn(d, answers).map((x) => x.action).sort()).toEqual(['crm_sequence_activation', 'hot_lead_call', 'meta_paused_bundle', 'smartlead']);
  });

  it('declines, comments, keep-draft and delegations are not approvals', () => {
    const d = deck([{ itemId: 'a', kind: 'smartlead_push_approval:start:x:n' }, { itemId: 'c', kind: 'crm_sequence_activation:s:t' }]);
    expect(personOnlyApprovalsIn(d, [{ itemId: 'a', verdict: 'decline' }, { itemId: 'c', verdict: 'keep_draft' }])).toEqual([]);
    expect(personOnlyApprovalsIn(d, [{ itemId: 'a', verdict: 'comment', freeText: 'x' }])).toEqual([]);
    expect(personOnlyApprovalsIn(d, [{ itemId: 'a', verdict: 'approve', delegated: true }])).toEqual([]);
  });

  it('tolerates missing or malformed input', () => {
    expect(personOnlyApprovalsIn(undefined, [])).toEqual([]);
    expect(personOnlyApprovalsIn(deck([{ itemId: 'a', kind: 'smartlead_push_approval:x' }]), 'nope')).toEqual([]);
  });
});
