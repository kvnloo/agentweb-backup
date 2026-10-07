/**
 * ENG-2316 — routing rules copy a session into child session lists by segment. Contract: a rule is
 * shape-validated, needs a condition, can only target an existing, same-owner session list that has
 * no routing of its own and is not the parent (no chains, no loops), and matching is AND within a rule.
 */
import { normalizeRouting, validateRoutingTargets, matchRoutingRules, MAX_ROUTING_RULES, TrackingConfigError } from '../trackingConfig';

const rule = (over: Record<string, any> = {}): any => ({ id: 'organic', match: { trafficType: 'organic' }, childListId: 'list_child_0001', ...over });
const codeOf = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return (e as TrackingConfigError).code; } };
const codeOfAsync = async (p: Promise<unknown>): Promise<string | undefined> => { try { await p; return undefined; } catch (e) { return (e as TrackingConfigError).code; } };

describe('normalizeRouting', () => {
  it('accepts a valid rule set and returns only the known fields', () => {
    expect(normalizeRouting([rule(), rule({ id: 'ig', childListId: 'list_child_0002', match: { channel: 'instagram', trafficType: 'organic' } }), rule({ id: 'grp', childListId: 'list_child_0003', match: { channelGroup: 'AI Assistant' } })]))
      .toEqual([
        { id: 'organic', match: { trafficType: 'organic' }, childListId: 'list_child_0001' },
        { id: 'ig', match: { channel: 'instagram', trafficType: 'organic' }, childListId: 'list_child_0002' },
        { id: 'grp', match: { channelGroup: 'AI Assistant' }, childListId: 'list_child_0003' },
      ]);
  });

  it('allows at most 5 rules', () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => rule({ id: `r${i}`, childListId: `list_child_${i}0000` }));
    expect(normalizeRouting(n(MAX_ROUTING_RULES))).toHaveLength(5);
    expect(codeOf(() => normalizeRouting(n(6)))).toBe('too_many_rules');
  });

  it.each([
    ['not an array', {}, 'invalid_routing'],
    ['a rule that is not an object', ['x'], 'invalid_rule'],
    ['a rule with NO match condition (it would match every session)', [rule({ match: {} })], 'invalid_rule'],
    ['match not an object', [rule({ match: 'organic' })], 'invalid_rule'],
    ['unknown rule field', [rule({ extra: 1 })], 'invalid_rule'],
    ['unknown match field', [rule({ match: { country: 'US' } })], 'invalid_rule'],
    ['trafficType outside paid/organic', [rule({ match: { trafficType: 'direct' } })], 'invalid_rule'],
    ['channelGroup outside the taxonomy', [rule({ match: { channelGroup: 'Social' } })], 'invalid_rule'],
    ['channel that is not a channel key', [rule({ match: { channel: 'Instagram' } })], 'invalid_rule'],
    ['id that is not a slug', [rule({ id: 'Has Space' })], 'invalid_rule'],
    ['missing id', [rule({ id: undefined })], 'invalid_rule'],
    ['childListId not a list id', [rule({ childListId: '../x' })], 'invalid_rule'],
    ['childListId missing', [rule({ childListId: undefined })], 'invalid_rule'],
    ['duplicate rule ids', [rule(), rule({ childListId: 'list_child_0002' })], 'duplicate_rule_id'],
  ])('rejects %s', (_l, input, code) => {
    expect(codeOf(() => normalizeRouting(input))).toBe(code);
  });
});

describe('validateRoutingTargets', () => {
  const parent = { listId: 'list_parent_001', userId: 'u1' };
  const child = (over: Record<string, any> = {}) => ({ listId: 'list_child_0001', userId: 'u1', listType: 'session', ...over });
  const lookup = (rows: Record<string, any>) => async (id: string) => rows[id] ?? null;

  it('passes for existing same-owner session lists without routing of their own', async () => {
    await expect(validateRoutingTargets(parent, [rule()], lookup({ list_child_0001: child() }))).resolves.toBeUndefined();
  });

  it.each([
    ['the parent itself (self loop)', [rule({ childListId: 'list_parent_001' })], {}, 'routing_self'],
    ['a child that does not exist', [rule()], {}, 'routing_child_not_found'],
    ['a sales list', [rule()], { list_child_0001: child({ listType: 'sales' }) }, 'routing_child_not_session'],
    ['a list with no listType', [rule()], { list_child_0001: child({ listType: undefined }) }, 'routing_child_not_session'],
    ['another owner\'s session list (cross-owner)', [rule()], { list_child_0001: child({ userId: 'someone-else' }) }, 'routing_child_other_owner'],
    ['a child that has routing of its own (chain)', [rule()], { list_child_0001: child({ trackingConfig: { allowedOrigins: [], routing: [rule({ childListId: 'list_x_000001' })] } }) }, 'routing_chain'],
    ['the same child from two rules', [rule(), rule({ id: 'other' })], { list_child_0001: child() }, 'routing_duplicate_child'],
  ])('rejects %s', async (_l, rules, rows, code) => {
    expect(await codeOfAsync(validateRoutingTargets(parent, rules as any, lookup(rows)))).toBe(code);
  });

  it('a child whose routing is empty or malformed is not a chain', async () => {
    await expect(validateRoutingTargets(parent, [rule()], lookup({ list_child_0001: child({ trackingConfig: { allowedOrigins: [], routing: [] } }) }))).resolves.toBeUndefined();
    await expect(validateRoutingTargets(parent, [rule()], lookup({ list_child_0001: child({ trackingConfig: { routing: 'x' } }) }))).resolves.toBeUndefined();
  });
});

describe('matchRoutingRules', () => {
  const c = (over: Record<string, any> = {}) => ({ trafficType: 'organic' as const, channelGroup: 'Organic Social' as const, channelKey: 'instagram', ...over });
  const R = [
    { id: 'a', match: { trafficType: 'organic' }, childListId: 'CHILD_ORGANIC' },
    { id: 'b', match: { trafficType: 'organic', channel: 'instagram' }, childListId: 'CHILD_IG' },
    { id: 'c', match: { channelGroup: 'Paid' }, childListId: 'CHILD_PAID' },
    { id: 'd', match: { trafficType: 'organic', channelGroup: 'Organic Social', channel: 'tiktok' }, childListId: 'CHILD_TT' },
  ];

  it('every field in a rule must match; independent rules can all match', () => {
    expect(matchRoutingRules(R, c())).toEqual(['CHILD_ORGANIC', 'CHILD_IG']);
    expect(matchRoutingRules(R, c({ channelKey: 'tiktok' }))).toEqual(['CHILD_ORGANIC', 'CHILD_TT']);
    expect(matchRoutingRules(R, c({ trafficType: 'paid', channelGroup: 'Paid' }))).toEqual(['CHILD_PAID']);
    expect(matchRoutingRules(R, c({ channelKey: 'direct', channelGroup: 'Direct' }))).toEqual(['CHILD_ORGANIC']);
  });

  it('returns each child once even if two rules name it', () => {
    expect(matchRoutingRules([R[0], { ...R[0], id: 'z' }], c())).toEqual(['CHILD_ORGANIC']);
  });

  it('a stored rule with no condition or a malformed shape matches NOTHING (never everything)', () => {
    expect(matchRoutingRules([{ id: 'x', match: {}, childListId: 'CH' }], c())).toEqual([]);
    expect(matchRoutingRules([null, 'x', { match: null, childListId: 'CH' }, { match: { trafficType: 'organic' } }], c())).toEqual([]);
    expect(matchRoutingRules(undefined, c())).toEqual([]);
    expect(matchRoutingRules('nope', c())).toEqual([]);
  });
});
