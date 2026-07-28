/**
 * Tests for marketingActionContract (ENG-445).
 *
 * Each behavioral assertion from the HUMAN-APPROVED contract on ENG-445 maps
 * to named tests below (see the `A<n>` prefixes in describe blocks):
 *   A1  selector returns 0–3 actions, never more than three
 *   A2  same inputs → same IDs and order (including under input permutation)
 *   A3  ranking considers business impact, campaign priority, urgency,
 *       confidence, and ease of execution
 *   A4  a low-priority campaign cannot displace a higher-priority action
 *       unless the low-priority action is explicitly critical
 *   A5  duplicate recommendations for the same underlying action/scope are
 *       represented once
 *   A6  every selected action serializes with one stable ID plus the full
 *       named field set
 *   A7  status supports proposed/approved/dismissed/completed without
 *       changing the action ID
 *   A8  empty/healthy input returns an empty list (no placeholders)
 *   A9  no network, live account, or external service required (hermetic)
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  MAX_MARKETING_ACTIONS,
  MarketingAction,
  MarketingActionCandidate,
  MarketingActionContractError,
  MarketingActionPriorityInputs,
  MarketingActionStatus,
  marketingActionId,
  parseMarketingActions,
  selectTopMarketingActions,
  serializeMarketingActions,
  transitionMarketingActionStatus,
} from '../marketingActionContract';

/** All-medium priority inputs — the neutral baseline for fixtures. */
const neutralPriority = (): MarketingActionPriorityInputs => ({
  businessImpact: 'medium',
  campaignPriority: 'medium',
  urgency: 'medium',
  confidence: 'medium',
  easeOfExecution: 'medium',
});

let fixtureCounter = 0;

/** Build a structurally valid candidate; override any field per test. */
const candidate = (
  overrides: Partial<MarketingActionCandidate> = {}
): MarketingActionCandidate => {
  fixtureCounter += 1;
  return {
    actionType: `pause_ad_${fixtureCounter}`,
    recommendation: `Pause underperforming ad ${fixtureCounter}`,
    scopeId: `campaign-${fixtureCounter}`,
    evidence: [`CTR fell below 0.5% over 7 days (fixture ${fixtureCounter})`],
    expectedImpact: 'Save ~$40/day in wasted spend',
    sourceKind: 'report',
    sourceId: `report-${fixtureCounter}`,
    priority: neutralPriority(),
    ctaType: 'review',
    deepLink: '/paid-social',
    ...overrides,
  };
};

beforeEach(() => {
  fixtureCounter = 0;
});

describe('A1 + A8 — selector returns 0–3 actions, empty input returns empty list', () => {
  it('returns an empty list for empty input (no placeholder recommendations)', () => {
    expect(selectTopMarketingActions([])).toEqual([]);
  });

  it('returns exactly one action for a single candidate', () => {
    const result = selectTopMarketingActions([candidate()]);
    expect(result).toHaveLength(1);
  });

  it('returns two actions for two candidates', () => {
    const result = selectTopMarketingActions([candidate(), candidate()]);
    expect(result).toHaveLength(2);
  });

  it('caps at three actions when given more than three candidates', () => {
    const many = [candidate(), candidate(), candidate(), candidate(), candidate(), candidate()];
    const result = selectTopMarketingActions(many);
    expect(result).toHaveLength(MAX_MARKETING_ACTIONS);
    expect(result).toHaveLength(3);
  });

  it('never invents actions: every selected ID derives from an input candidate', () => {
    const inputs = [candidate(), candidate()];
    const inputIds = new Set(
      inputs.map((c) => marketingActionId(c.actionType, c.scopeId))
    );
    for (const action of selectTopMarketingActions(inputs)) {
      expect(inputIds.has(action.id)).toBe(true);
    }
  });
});

describe('A2 — deterministic: same inputs → same IDs and order', () => {
  it('returns identical IDs and order across repeated calls', () => {
    const inputs = [candidate(), candidate(), candidate(), candidate()];
    const first = selectTopMarketingActions(inputs).map((a) => a.id);
    const second = selectTopMarketingActions(inputs).map((a) => a.id);
    expect(second).toEqual(first);
  });

  it('is invariant under input permutation', () => {
    const a = candidate();
    const b = candidate();
    const c = candidate();
    const d = candidate();
    const forward = selectTopMarketingActions([a, b, c, d]).map((x) => x.id);
    const reversed = selectTopMarketingActions([d, c, b, a]).map((x) => x.id);
    const shuffled = selectTopMarketingActions([c, a, d, b]).map((x) => x.id);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('breaks exact priority ties deterministically (lexicographic ID order)', () => {
    // Four candidates with IDENTICAL priority inputs — only identity differs.
    const inputs = [candidate(), candidate(), candidate(), candidate()];
    const ids = inputs
      .map((c) => marketingActionId(c.actionType, c.scopeId))
      .sort()
      .slice(0, 3);
    const selected = selectTopMarketingActions(inputs).map((a) => a.id);
    expect(selected).toEqual(ids);
  });
});

describe('A3 — ranking considers all five priority factors', () => {
  const rankPair = (
    winner: MarketingActionCandidate,
    loser: MarketingActionCandidate
  ): string[] =>
    selectTopMarketingActions([loser, winner]).map((a) => a.id);

  it('higher business impact outranks lower (all else equal)', () => {
    const winner = candidate({
      priority: { ...neutralPriority(), businessImpact: 'high' },
    });
    const loser = candidate({
      priority: { ...neutralPriority(), businessImpact: 'low' },
    });
    expect(rankPair(winner, loser)[0]).toBe(
      marketingActionId(winner.actionType, winner.scopeId)
    );
  });

  it('higher campaign priority outranks lower (all else equal)', () => {
    const winner = candidate({
      priority: { ...neutralPriority(), campaignPriority: 'high' },
    });
    const loser = candidate({
      priority: { ...neutralPriority(), campaignPriority: 'low' },
    });
    expect(rankPair(winner, loser)[0]).toBe(
      marketingActionId(winner.actionType, winner.scopeId)
    );
  });

  it('higher urgency outranks lower (all else equal)', () => {
    const winner = candidate({ priority: { ...neutralPriority(), urgency: 'high' } });
    const loser = candidate({ priority: { ...neutralPriority(), urgency: 'low' } });
    expect(rankPair(winner, loser)[0]).toBe(
      marketingActionId(winner.actionType, winner.scopeId)
    );
  });

  it('higher confidence outranks lower (all else equal)', () => {
    const winner = candidate({ priority: { ...neutralPriority(), confidence: 'high' } });
    const loser = candidate({ priority: { ...neutralPriority(), confidence: 'low' } });
    expect(rankPair(winner, loser)[0]).toBe(
      marketingActionId(winner.actionType, winner.scopeId)
    );
  });

  it('higher ease of execution outranks lower (all else equal)', () => {
    const winner = candidate({
      priority: { ...neutralPriority(), easeOfExecution: 'high' },
    });
    const loser = candidate({
      priority: { ...neutralPriority(), easeOfExecution: 'low' },
    });
    expect(rankPair(winner, loser)[0]).toBe(
      marketingActionId(winner.actionType, winner.scopeId)
    );
  });
});

describe('A4 — campaign-priority dominance and the explicit critical override', () => {
  it('a low-priority campaign action cannot displace a higher-priority action, even with maxed other factors', () => {
    const lowCampaignMaxedElse = candidate({
      priority: {
        businessImpact: 'high',
        campaignPriority: 'low',
        urgency: 'high',
        confidence: 'high',
        easeOfExecution: 'high',
      },
    });
    const highCampaignWeakElse = candidate({
      priority: {
        businessImpact: 'low',
        campaignPriority: 'high',
        urgency: 'low',
        confidence: 'low',
        easeOfExecution: 'low',
      },
    });
    const [first, second] = selectTopMarketingActions([
      lowCampaignMaxedElse,
      highCampaignWeakElse,
    ]);
    expect(first.id).toBe(
      marketingActionId(highCampaignWeakElse.actionType, highCampaignWeakElse.scopeId)
    );
    expect(second.id).toBe(
      marketingActionId(lowCampaignMaxedElse.actionType, lowCampaignMaxedElse.scopeId)
    );
  });

  it('low-priority suppression: with three higher-priority actions available, the low-priority action is not selected', () => {
    const high1 = candidate({ priority: { ...neutralPriority(), campaignPriority: 'high' } });
    const high2 = candidate({ priority: { ...neutralPriority(), campaignPriority: 'high' } });
    const med = candidate({ priority: neutralPriority() });
    const low = candidate({ priority: { ...neutralPriority(), campaignPriority: 'low' } });
    const selected = selectTopMarketingActions([low, high1, med, high2]);
    expect(selected).toHaveLength(3);
    const lowId = marketingActionId(low.actionType, low.scopeId);
    expect(selected.map((a) => a.id)).not.toContain(lowId);
  });

  it('critical override: an explicitly critical low-priority-campaign action DOES displace non-critical higher-priority actions', () => {
    const criticalLow = candidate({
      priority: { ...neutralPriority(), campaignPriority: 'low', critical: true },
    });
    const high1 = candidate({ priority: { ...neutralPriority(), campaignPriority: 'high' } });
    const high2 = candidate({ priority: { ...neutralPriority(), campaignPriority: 'high' } });
    const high3 = candidate({ priority: { ...neutralPriority(), campaignPriority: 'high' } });
    const selected = selectTopMarketingActions([high1, high2, high3, criticalLow]);
    expect(selected).toHaveLength(3);
    expect(selected[0].id).toBe(
      marketingActionId(criticalLow.actionType, criticalLow.scopeId)
    );
  });
});

describe('A5 — duplicate recommendations collapse to one representation', () => {
  it('two candidates for the same action/scope produce one selected action', () => {
    const original = candidate({ actionType: 'pause_ad', scopeId: 'campaign-123' });
    const duplicate = candidate({
      actionType: 'pause_ad',
      scopeId: 'campaign-123',
      recommendation: 'Same underlying action, differently worded',
      sourceId: 'report-duplicate',
    });
    const selected = selectTopMarketingActions([original, duplicate]);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(marketingActionId('pause_ad', 'campaign-123'));
  });

  it('identity is normalized: case and surrounding whitespace do not create distinct actions', () => {
    const a = candidate({ actionType: 'Pause_Ad', scopeId: ' Campaign-123 ' });
    const b = candidate({ actionType: 'pause_ad', scopeId: 'campaign-123' });
    const selected = selectTopMarketingActions([a, b]);
    expect(selected).toHaveLength(1);
  });

  it('duplicate collapse keeps the stronger-ranked variant deterministically', () => {
    const weak = candidate({
      actionType: 'scale_budget',
      scopeId: 'campaign-9',
      priority: { ...neutralPriority(), businessImpact: 'low' },
    });
    const strong = candidate({
      actionType: 'scale_budget',
      scopeId: 'campaign-9',
      recommendation: 'Scale budget 2x on the winning ad set',
      priority: { ...neutralPriority(), businessImpact: 'high' },
    });
    const forward = selectTopMarketingActions([weak, strong]);
    const backward = selectTopMarketingActions([strong, weak]);
    expect(forward).toHaveLength(1);
    expect(forward[0].recommendation).toBe('Scale budget 2x on the winning ad set');
    expect(backward).toEqual(forward);
  });
});

describe('A6 — serialization: stable ID plus the full named field set', () => {
  it('every selected action carries the complete contract field set', () => {
    const [action] = selectTopMarketingActions([
      candidate({
        actionType: 'rotate_creative',
        scopeId: 'campaign-42',
        sourceKind: 'run',
        sourceId: 'run-77',
        ctaType: 'approve',
        deepLink: '/meta-campaigns',
      }),
    ]);
    expect(action.id).toBe(marketingActionId('rotate_creative', 'campaign-42'));
    expect(action.actionType).toBe('rotate_creative'); // action verb/type
    expect(typeof action.recommendation).toBe('string'); // concise recommendation
    expect(action.scopeId).toBe('campaign-42'); // scope/campaign identifier
    expect(Array.isArray(action.evidence)).toBe(true); // evidence
    expect(typeof action.expectedImpact).toBe('string'); // expected impact
    expect(action.priority.confidence).toBeDefined(); // confidence
    expect(action.sourceKind).toBe('run'); // source kind
    expect(action.sourceId).toBe('run-77'); // source report/run ID
    expect(action.priority).toEqual(expect.objectContaining({
      businessImpact: expect.any(String),
      campaignPriority: expect.any(String),
      urgency: expect.any(String),
      confidence: expect.any(String),
      easeOfExecution: expect.any(String),
    })); // priority inputs
    expect(action.status).toBe('proposed'); // status
    expect(action.ctaType).toBe('approve'); // CTA type
    expect(action.deepLink).toBe('/meta-campaigns'); // deep-link target
  });

  it('serialization round-trip preserves stable IDs, order, status, and all fields', () => {
    const selected = selectTopMarketingActions([candidate(), candidate(), candidate()]);
    const withStatuses: MarketingAction[] = [
      transitionMarketingActionStatus(selected[0], 'approved'),
      transitionMarketingActionStatus(selected[1], 'dismissed'),
      selected[2],
    ];
    const roundTripped = parseMarketingActions(serializeMarketingActions(withStatuses));
    expect(roundTripped).toEqual(withStatuses);
    expect(roundTripped.map((a) => a.id)).toEqual(withStatuses.map((a) => a.id));
    expect(roundTripped.map((a) => a.status)).toEqual(['approved', 'dismissed', 'proposed']);
  });

  it('parse rejects malformed JSON loudly', () => {
    expect(() => parseMarketingActions('not json {')).toThrow(MarketingActionContractError);
  });

  it('parse rejects a non-array payload loudly', () => {
    expect(() => parseMarketingActions('{"id":"x"}')).toThrow(MarketingActionContractError);
  });

  it('parse rejects an action with an invalid status loudly', () => {
    const [action] = selectTopMarketingActions([candidate()]);
    const tampered = serializeMarketingActions([action]).replace(
      '"proposed"',
      '"bogus_status"'
    );
    expect(() => parseMarketingActions(tampered)).toThrow(MarketingActionContractError);
  });

  it('parse rejects a transported ID that does not match canonical action identity', () => {
    // A foreign-but-plausible ID must not masquerade as this action's identity:
    // assertion 6 requires ONE STABLE id per (actionType, scopeId), so parse
    // re-derives and rejects any drifted/transplanted id.
    const [action] = selectTopMarketingActions([
      candidate({ actionType: 'pause_ad', scopeId: 'campaign-real' }),
    ]);
    const tampered = JSON.parse(serializeMarketingActions([action]));
    tampered[0].id = marketingActionId('scale_budget', 'campaign-other');
    expect(() => parseMarketingActions(JSON.stringify(tampered))).toThrow(
      MarketingActionContractError
    );
    try {
      parseMarketingActions(JSON.stringify(tampered));
      throw new Error('expected parse to throw');
    } catch (err) {
      expect((err as Error).message).toContain('id');
      expect((err as Error).message).toContain('canonical');
    }
  });

  it('parse rejects an ID whose identity fields were renamed after serialization', () => {
    // Renaming actionType/scopeId in transit without re-deriving the id is the
    // same masquerade in the other direction — also rejected.
    const [action] = selectTopMarketingActions([
      candidate({ actionType: 'pause_ad', scopeId: 'campaign-real' }),
    ]);
    const tampered = JSON.parse(serializeMarketingActions([action]));
    tampered[0].actionType = 'launch_campaign';
    expect(() => parseMarketingActions(JSON.stringify(tampered))).toThrow(
      MarketingActionContractError
    );
  });

  it('parse rejects an action missing its stable ID loudly', () => {
    const [action] = selectTopMarketingActions([candidate()]);
    const stripped = JSON.parse(serializeMarketingActions([action]));
    delete stripped[0].id;
    expect(() => parseMarketingActions(JSON.stringify(stripped))).toThrow(
      MarketingActionContractError
    );
  });
});

describe('A7 — status transitions never change the action ID', () => {
  it('supports proposed → approved → dismissed → completed with a constant ID', () => {
    const [action] = selectTopMarketingActions([candidate()]);
    const originalId = action.id;
    const statuses: MarketingActionStatus[] = ['approved', 'dismissed', 'completed'];
    let current: MarketingAction = action;
    expect(current.status).toBe('proposed');
    for (const status of statuses) {
      current = transitionMarketingActionStatus(current, status);
      expect(current.status).toBe(status);
      expect(current.id).toBe(originalId);
    }
  });

  it('transition is pure: the input action is not mutated', () => {
    const [action] = selectTopMarketingActions([candidate()]);
    transitionMarketingActionStatus(action, 'completed');
    expect(action.status).toBe('proposed');
  });

  it('rejects an unknown status loudly', () => {
    const [action] = selectTopMarketingActions([candidate()]);
    expect(() =>
      transitionMarketingActionStatus(action, 'archived' as MarketingActionStatus)
    ).toThrow(MarketingActionContractError);
  });
});

describe('A9 — hermetic: the contract module needs no network or external service', () => {
  it('module source imports no network, AWS, or external-service clients', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'marketingActionContract.ts'),
      'utf8'
    );
    for (const forbidden of [
      'axios',
      'node-fetch',
      "from 'http'",
      "from 'https'",
      'aws-sdk',
      '@aws-sdk',
      'dynamodb',
      'fetch(',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('validation — structurally invalid candidates fail loudly, never silently', () => {
  it.each([
    ['actionType', { actionType: '   ' }],
    ['recommendation', { recommendation: '' }],
    ['scopeId', { scopeId: '' }],
    ['sourceId', { sourceId: '  ' }],
    ['deepLink', { deepLink: '' }],
    ['expectedImpact', { expectedImpact: '' }],
  ])(
    'rejects a candidate with a blank %s, naming the field and index',
    (field, override) => {
      const bad = candidate(override as Partial<MarketingActionCandidate>);
      expect(() => selectTopMarketingActions([candidate(), bad])).toThrow(
        MarketingActionContractError
      );
      try {
        selectTopMarketingActions([candidate(), bad]);
        throw new Error('expected selector to throw');
      } catch (err) {
        expect((err as Error).message).toContain(field);
        expect((err as Error).message).toContain('index 1');
      }
    }
  );

  it('rejects an invalid priority tier loudly', () => {
    const bad = candidate();
    (bad.priority as unknown as Record<string, unknown>).urgency = 'extreme';
    expect(() => selectTopMarketingActions([bad])).toThrow(MarketingActionContractError);
  });

  it('rejects an invalid ctaType loudly', () => {
    const bad = candidate({ ctaType: 'dance' as MarketingActionCandidate['ctaType'] });
    expect(() => selectTopMarketingActions([bad])).toThrow(MarketingActionContractError);
  });

  it('rejects an invalid sourceKind loudly', () => {
    const bad = candidate({
      sourceKind: 'vibes' as MarketingActionCandidate['sourceKind'],
    });
    expect(() => selectTopMarketingActions([bad])).toThrow(MarketingActionContractError);
  });

  it('rejects a non-array evidence field loudly', () => {
    const bad = candidate();
    (bad as unknown as Record<string, unknown>).evidence = 'a string, not an array';
    expect(() => selectTopMarketingActions([bad])).toThrow(MarketingActionContractError);
  });
});

describe('validation — malformed containers and priority objects fail loudly', () => {
  it('rejects a non-array candidates argument loudly', () => {
    expect(() =>
      selectTopMarketingActions('nope' as unknown as MarketingActionCandidate[])
    ).toThrow(MarketingActionContractError);
  });

  it('rejects a null candidate entry loudly', () => {
    expect(() =>
      selectTopMarketingActions([null as unknown as MarketingActionCandidate])
    ).toThrow(MarketingActionContractError);
  });

  it('rejects a candidate whose priority is not an object', () => {
    const bad = candidate();
    (bad as unknown as Record<string, unknown>).priority = null;
    expect(() => selectTopMarketingActions([bad])).toThrow(MarketingActionContractError);
  });

  it('rejects a non-boolean priority.critical loudly', () => {
    const bad = candidate();
    (bad.priority as unknown as Record<string, unknown>).critical = 'yes';
    expect(() => selectTopMarketingActions([bad])).toThrow(MarketingActionContractError);
  });
});

describe('determinism — same-identity variants with tied ranks resolve by content', () => {
  it('same id, identical priorities, different wording: winner is order-independent', () => {
    const variantA = candidate({
      actionType: 'pause_ad',
      scopeId: 'campaign-tie',
      recommendation: 'AAA wording',
    });
    const variantB = candidate({
      actionType: 'pause_ad',
      scopeId: 'campaign-tie',
      recommendation: 'ZZZ wording',
    });
    const forward = selectTopMarketingActions([variantA, variantB]);
    const backward = selectTopMarketingActions([variantB, variantA]);
    expect(forward).toHaveLength(1);
    expect(backward).toEqual(forward);
  });

  it('two exactly identical candidates collapse to one action', () => {
    const c = candidate({ actionType: 'pause_ad', scopeId: 'campaign-clone' });
    const selected = selectTopMarketingActions([c, { ...c }]);
    expect(selected).toHaveLength(1);
  });
});

describe('marketingActionId — stable identity derivation', () => {
  it('is deterministic for the same normalized inputs', () => {
    expect(marketingActionId('pause_ad', 'campaign-1')).toBe(
      marketingActionId('pause_ad', 'campaign-1')
    );
    expect(marketingActionId(' Pause_Ad ', 'CAMPAIGN-1')).toBe(
      marketingActionId('pause_ad', 'campaign-1')
    );
  });

  it('differs across distinct actions or scopes', () => {
    expect(marketingActionId('pause_ad', 'campaign-1')).not.toBe(
      marketingActionId('pause_ad', 'campaign-2')
    );
    expect(marketingActionId('pause_ad', 'campaign-1')).not.toBe(
      marketingActionId('scale_budget', 'campaign-1')
    );
  });
});
