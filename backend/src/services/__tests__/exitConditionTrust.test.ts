import {
  classifyExitConditionTrust,
  machineSusceptibleExits,
  SequenceExitCondition,
} from '../exitConditionTrust';

describe('classifyExitConditionTrust (ENG-2573)', () => {
  // Record<union, ...> fails to compile if a member is added without a row here.
  const expected: Record<SequenceExitCondition, ReturnType<typeof classifyExitConditionTrust>> = {
    replied: { trust: 'reliable', reasonCode: 'human_reply' },
    linkedin_reply: { trust: 'reliable', reasonCode: 'human_reply' },
    lifecycle_change: { trust: 'reliable', reasonCode: 'first_party_state_change' },
    unsubscribe: { trust: 'reliable', reasonCode: 'first_party_state_change' },
    opened: { trust: 'machine_susceptible', reasonCode: 'image_proxy_open' },
    clicked: { trust: 'machine_susceptible', reasonCode: 'link_scanner_click' },
  };

  it.each(Object.entries(expected))('%s', (condition, want) => {
    expect(classifyExitConditionTrust(condition as SequenceExitCondition)).toEqual(want);
  });

  it('throws on an unknown runtime value', () => {
    expect(() => classifyExitConditionTrust('bogus' as any)).toThrow();
  });
});

describe('machineSusceptibleExits', () => {
  it('lists only open/click, deduped, in configured order', () => {
    expect(
      machineSusceptibleExits({
        onEmailEngagement: ['clicked', 'replied', 'opened', 'clicked'],
        onLinkedInReply: true,
        onLifecycleChange: ['customer' as any],
        onUnsubscribe: true,
      }),
    ).toEqual([
      { condition: 'clicked', reasonCode: 'link_scanner_click' },
      { condition: 'opened', reasonCode: 'image_proxy_open' },
    ]);
  });

  it('is empty for reply-only, missing, or malformed config', () => {
    expect(machineSusceptibleExits({ onEmailEngagement: ['replied'], onUnsubscribe: true })).toEqual([]);
    expect(machineSusceptibleExits(undefined)).toEqual([]);
    expect(machineSusceptibleExits({ onEmailEngagement: 'opened' as any, onUnsubscribe: false })).toEqual([]);
    expect(machineSusceptibleExits({ onEmailEngagement: ['weird' as any], onUnsubscribe: false })).toEqual([]);
  });
});
