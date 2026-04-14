/**
 * Tests for lifecycleService (C3 — CRM Unification v1).
 * Covers every transition in the priority-ordered rule set + the applyAndUpdate
 * side-effect contract (no-op when unchanged, event + persist when changed).
 */

import { computeLifecycle, applyAndUpdate, LifecycleSignals } from '../lifecycleService';

const FIXED_NOW = new Date('2026-04-14T12:00:00.000Z');
const daysAgo = (d: number) =>
  new Date(FIXED_NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

describe('computeLifecycle — rule priority', () => {
  it('1. canceled subscription → churned', () => {
    expect(
      computeLifecycle({ subscriptionState: 'canceled', email: 'a@acme.com' }, FIXED_NOW)
    ).toBe('churned');
  });

  it('1. inactivity >60d → churned regardless of other signals', () => {
    expect(
      computeLifecycle(
        {
          subscriptionState: 'active',
          lastActivityAt: daysAgo(70),
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('churned');
  });

  it('2. past_due while currently paying → at_risk', () => {
    expect(
      computeLifecycle(
        { subscriptionState: 'past_due', currentLifecycle: 'paying', email: 'a@acme.com' },
        FIXED_NOW
      )
    ).toBe('at_risk');
  });

  it('2. healthScore<40 while currently paying → at_risk', () => {
    expect(
      computeLifecycle(
        {
          subscriptionState: 'active',
          currentLifecycle: 'paying',
          healthScore: 30,
          lastActivityAt: daysAgo(1),
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('at_risk');
  });

  it('2. no usage >30d while currently paying → at_risk', () => {
    expect(
      computeLifecycle(
        {
          subscriptionState: 'active',
          currentLifecycle: 'paying',
          lastUsageAt: daysAgo(45),
          lastActivityAt: daysAgo(45),
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('at_risk');
  });

  it('2. at_risk rules do NOT fire when currentLifecycle is not paying/at_risk', () => {
    // past_due on a non-paying contact shouldn't promote them to at_risk — falls through
    // to the later rules. With hasUserRecord=true we should land on signed_up.
    expect(
      computeLifecycle(
        {
          subscriptionState: 'past_due',
          currentLifecycle: 'signed_up',
          hasUserRecord: true,
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('signed_up');
  });

  it('2. at_risk can self-sustain (at_risk stays at_risk while past_due)', () => {
    expect(
      computeLifecycle(
        {
          subscriptionState: 'past_due',
          currentLifecycle: 'at_risk',
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('at_risk');
  });

  it('3. active subscription → paying', () => {
    expect(
      computeLifecycle(
        {
          subscriptionState: 'active',
          lastActivityAt: daysAgo(1),
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('paying');
  });

  it('4. trialing subscription → trialing', () => {
    expect(
      computeLifecycle(
        {
          subscriptionState: 'trialing',
          lastActivityAt: daysAgo(1),
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('trialing');
  });

  it('5. open Deal (not Won/Lost) → in_deal', () => {
    expect(
      computeLifecycle(
        {
          openDealStages: ['Proposal'],
          hasUserRecord: true,
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('in_deal');
  });

  it('5. closed deals (Won/Lost only) do NOT count as in_deal', () => {
    expect(
      computeLifecycle(
        {
          openDealStages: ['Won', 'Lost'],
          hasUserRecord: true,
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('signed_up');
  });

  it('6. AW-Users record, no deal, no sub → signed_up', () => {
    expect(
      computeLifecycle({ hasUserRecord: true, email: 'a@acme.com' }, FIXED_NOW)
    ).toBe('signed_up');
  });

  it('7. email only, no signup, no sub, no deal → inbox', () => {
    expect(computeLifecycle({ email: 'a@acme.com' }, FIXED_NOW)).toBe('inbox');
  });

  it('8. domain only, no email → unknown', () => {
    expect(computeLifecycle({ domain: 'acme.com' }, FIXED_NOW)).toBe('unknown');
  });

  it('8. nothing at all → unknown', () => {
    expect(computeLifecycle({}, FIXED_NOW)).toBe('unknown');
  });
});

describe('computeLifecycle — edge cases', () => {
  it('treats whitespace-only email as no email', () => {
    expect(computeLifecycle({ email: '   ' }, FIXED_NOW)).toBe('unknown');
  });

  it('ignores malformed timestamps (no crash, no false churn)', () => {
    expect(
      computeLifecycle(
        {
          subscriptionState: 'active',
          lastActivityAt: 'not-a-date',
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('paying');
  });

  it('does not flip active→churned for a recent active subscription', () => {
    expect(
      computeLifecycle(
        {
          subscriptionState: 'active',
          lastActivityAt: daysAgo(5),
          email: 'a@acme.com',
        },
        FIXED_NOW
      )
    ).toBe('paying');
  });
});

describe('applyAndUpdate', () => {
  function buildDeps(overrides: Partial<LifecycleSignals>) {
    const loadSignals = jest.fn().mockResolvedValue(overrides);
    const persistLifecycle = jest.fn().mockResolvedValue(undefined);
    const logTransitionEvent = jest.fn().mockResolvedValue(undefined);
    return { loadSignals, persistLifecycle, logTransitionEvent };
  }

  it('persists + logs when the lifecycle changes', async () => {
    const deps = buildDeps({
      currentLifecycle: 'inbox',
      hasUserRecord: true,
      email: 'a@acme.com',
    });

    const result = await applyAndUpdate('a@acme.com', deps, FIXED_NOW);

    expect(result.changed).toBe(true);
    expect(result.previous).toBe('inbox');
    expect(result.current).toBe('signed_up');
    expect(deps.persistLifecycle).toHaveBeenCalledWith('a@acme.com', 'signed_up');
    expect(deps.logTransitionEvent).toHaveBeenCalledWith('a@acme.com', 'inbox', 'signed_up');
  });

  it('is a no-op when the lifecycle is unchanged', async () => {
    const deps = buildDeps({
      currentLifecycle: 'signed_up',
      hasUserRecord: true,
      email: 'a@acme.com',
    });

    const result = await applyAndUpdate('a@acme.com', deps, FIXED_NOW);

    expect(result.changed).toBe(false);
    expect(result.previous).toBe('signed_up');
    expect(result.current).toBe('signed_up');
    expect(deps.persistLifecycle).not.toHaveBeenCalled();
    expect(deps.logTransitionEvent).not.toHaveBeenCalled();
  });

  it('reports previous=null on first-time computation', async () => {
    const deps = buildDeps({ email: 'a@acme.com' });
    const result = await applyAndUpdate('a@acme.com', deps, FIXED_NOW);

    expect(result.previous).toBeNull();
    expect(result.current).toBe('inbox');
    expect(result.changed).toBe(true);
  });
});
