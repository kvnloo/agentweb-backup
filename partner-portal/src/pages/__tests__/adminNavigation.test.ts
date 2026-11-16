import { ADMIN_NAVIGATION_SECTIONS, ADMIN_TABS } from '../adminNavigation';

describe('admin navigation taxonomy', () => {
  it('keeps every deep-link slug exactly once (27 existing plus vendor-rates, ENG-2271, and zoma, ENG-2902)', () => {
    const expected = [
      'overview', 'announcements', 'users', 'waitlist', 'tasks', 'workflows',
      'chat-history', 'knowledge-base', 'agent-mode', 'image-models', 'default-prompts',
      'benchmarks', 'subscriptions', 'mcp-servers', 'result-endpoints', 'scoring-judges',
      'crm', 'revenue', 'funnel', 'alert-emails', 'onboarding', 'connected-accounts',
      'contractors', 'emma-mcp', 'costs', 'usage-cost', 'eval-v2', 'vendor-rates', 'zoma',
    ];
    expect(ADMIN_TABS.map(({ slug }) => slug).sort()).toEqual(expected.sort());
  });

  it('groups tabs into the seven approved sections', () => {
    expect(ADMIN_NAVIGATION_SECTIONS.map(({ label }) => label)).toEqual([
      'Overview', 'People & access', 'Product ops', 'AI configuration',
      'Revenue & billing', 'Growth & CRM', 'Ops & alerts',
    ]);
  });

  it('maps Users to the existing default tab value', () => {
    expect(ADMIN_TABS.find(({ slug }) => slug === 'users')).toMatchObject({ value: 2, label: 'Users' });
  });

  it('has unique numeric values so deep links select one panel', () => {
    const values = ADMIN_TABS.map(({ value }) => value);
    expect(new Set(values).size).toBe(29);
  });
});
