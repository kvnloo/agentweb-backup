import { planPlaybookConsolidation, type ConsolidationPlaybook } from '../marketingPlaybookConsolidation';

const step = (id: string, actionType = 'pause_ad') => ({ id, actionType, objectLevel: 'ad', owned: true });
const pb = (id: string, version: string, steps = [step('s1')], extra: Partial<ConsolidationPlaybook> = {}): ConsolidationPlaybook => ({
  id,
  version,
  steps,
  ...extra,
});

describe('planPlaybookConsolidation (ENG-2971)', () => {
  it('returns an empty plan for empty input', () => {
    expect(planPlaybookConsolidation([])).toEqual({ entries: [], merges: [] });
  });

  it('keeps the highest semver and archives superseded versions', () => {
    const plan = planPlaybookConsolidation([pb('a', '1.2.0'), pb('a', '1.10.0'), pb('a', '1.9.3')]);
    expect(plan.entries).toEqual([
      { id: 'a', version: '1.10.0', action: 'keep' },
      { id: 'a', version: '1.9.3', action: 'archive', reason: 'superseded_by:1.10.0' },
      { id: 'a', version: '1.2.0', action: 'archive', reason: 'superseded_by:1.10.0' },
    ]);
  });

  it('never keeps an invalid playbook and reports validator codes', () => {
    const plan = planPlaybookConsolidation([pb('a', '2.0.0', [step('s1', 'teleport_budget')]), pb('a', '1.0.0')]);
    expect(plan.entries).toEqual([
      { id: 'a', version: '2.0.0', action: 'invalid', codes: ['unknown_action_type'] },
      { id: 'a', version: '1.0.0', action: 'keep' },
    ]);
  });

  it('proposes a merge of identical-step playbooks with the smallest id canonical', () => {
    const plan = planPlaybookConsolidation([pb('c', '1.0.0'), pb('b', '1.0.0'), pb('d', '1.0.0', [step('s2')])]);
    expect(plan.merges).toEqual([{ canonicalId: 'b', duplicateIds: ['c'] }]);
  });

  it('refuses to merge across orgs', () => {
    const plan = planPlaybookConsolidation([pb('b', '1.0.0', undefined, { orgId: 'o1' }), pb('c', '1.0.0', undefined, { orgId: 'o2' })]);
    expect(plan.merges).toEqual([]);
    const same = planPlaybookConsolidation([pb('b', '1.0.0', undefined, { orgId: 'o1' }), pb('c', '1.0.0', undefined, { orgId: 'o1' })]);
    expect(same.merges).toEqual([{ canonicalId: 'b', duplicateIds: ['c'], orgId: 'o1' }]);
  });

  it('archives expired playbooks and sends stale ones to review', () => {
    const plan = planPlaybookConsolidation([pb('x', '1.0.0'), pb('y', '1.0.0', [step('s9')])], {
      x: { decision: 'expire' },
      y: { decision: 'stale' },
    });
    expect(plan.entries).toEqual([
      { id: 'x', version: '1.0.0', action: 'archive', reason: 'expired' },
      { id: 'y', version: '1.0.0', action: 'review', reason: 'stale' },
    ]);
    expect(plan.merges).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const items = [pb('a', '1.0.0'), pb('b', '1.0.0'), pb('a', '2.0.0'), pb('c', '1.0.0', [step('z')])];
    expect(planPlaybookConsolidation([...items].reverse())).toEqual(planPlaybookConsolidation(items));
  });
});
