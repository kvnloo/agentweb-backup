import {
  askCrm,
  classifyIntent,
  AskCrmLead,
  AskCrmDeps,
} from '../askCrmService';

function lead(overrides: Partial<AskCrmLead>): AskCrmLead {
  return {
    leadId: 'l_' + (overrides.email || Math.random().toString(36).slice(2, 6)),
    listId: 'list_1',
    email: overrides.email || 'someone@example.com',
    ...overrides,
  };
}

function makeDeps(leads: AskCrmLead[]): AskCrmDeps {
  return {
    loadLeadsForUser: async () => leads,
    now: () => new Date('2026-04-14T00:00:00Z'),
  };
}

describe('classifyIntent', () => {
  it('maps "who should I reach out to today" to hot_leads', () => {
    expect(classifyIntent('Who should I reach out to today?')).toBe('hot_leads');
  });

  it('maps "which deals are close to closing" to deals_closing', () => {
    expect(classifyIntent('Which deals are close to closing?')).toBe('deals_closing');
  });

  it('maps "who are my at-risk customers" to at_risk', () => {
    expect(classifyIntent('Who are my at-risk customers?')).toBe('at_risk');
  });

  it('maps "is jane at acme paying us" to specific_contact', () => {
    expect(classifyIntent('Is jane at acme paying us?')).toBe('specific_contact');
  });

  it('maps "show me paying customers" to paying_customers', () => {
    expect(classifyIntent('Show me paying customers')).toBe('paying_customers');
  });

  it('empty question → unknown', () => {
    expect(classifyIntent('')).toBe('unknown');
    expect(classifyIntent('   ')).toBe('unknown');
  });

  it('vague question defaults to hot_leads', () => {
    expect(classifyIntent('What are my priorities')).toBe('hot_leads');
  });
});

describe('askCrm — hot_leads intent', () => {
  it('sorts by heatScore descending and caps at resultLimit', async () => {
    const leads: AskCrmLead[] = [
      lead({ email: 'a@x.com', heatScore: 90, lifecycle: 'inbox', contactStatus: 'active' }),
      lead({ email: 'b@x.com', heatScore: 20, lifecycle: 'inbox', contactStatus: 'active' }),
      lead({ email: 'c@x.com', heatScore: 50, lifecycle: 'inbox', contactStatus: 'active' }),
    ];
    const result = await askCrm('who should I reach out to today', 'u1', makeDeps(leads), {
      resultLimit: 2,
    });
    expect(result.intent).toBe('hot_leads');
    expect(result.items).toHaveLength(2);
    expect(result.items[0].heatScore).toBe(90);
    expect(result.items[1].heatScore).toBe(50);
  });

  it('excludes churned leads', async () => {
    const leads = [
      lead({ email: 'a@x.com', heatScore: 90, lifecycle: 'churned', contactStatus: 'active' }),
      lead({ email: 'b@x.com', heatScore: 20, lifecycle: 'inbox', contactStatus: 'active' }),
    ];
    const result = await askCrm('hot leads', 'u1', makeDeps(leads));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].email).toBe('b@x.com');
  });

  it('excludes do-not-contact leads', async () => {
    const leads = [
      lead({ email: 'a@x.com', heatScore: 90, lifecycle: 'inbox', contactStatus: 'do-not-contact' }),
      lead({ email: 'b@x.com', heatScore: 20, lifecycle: 'inbox', contactStatus: 'active' }),
    ];
    const result = await askCrm('hot leads', 'u1', makeDeps(leads));
    expect(result.items.map(i => i.email)).toEqual(['b@x.com']);
  });

  it('computes heat on the fly when stored score is missing', async () => {
    const leads = [
      lead({
        email: 'a@x.com',
        hasUserRecord: true,
        hasActiveSubscription: true,
        isICP: true,
        contactStatus: 'active',
        lifecycle: 'paying',
      }),
    ];
    const result = await askCrm('hot leads', 'u1', makeDeps(leads));
    expect(result.items[0].heatScore).toBeGreaterThan(0);
  });
});

describe('askCrm — at_risk intent', () => {
  it('returns only at_risk leads, sorted by healthScore ascending', async () => {
    const leads = [
      lead({ email: 'a@x.com', lifecycle: 'paying', healthScore: 80 }),
      lead({ email: 'b@x.com', lifecycle: 'at_risk', healthScore: 30 }),
      lead({ email: 'c@x.com', lifecycle: 'at_risk', healthScore: 10 }),
    ];
    const result = await askCrm('who is at risk', 'u1', makeDeps(leads));
    expect(result.intent).toBe('at_risk');
    expect(result.items.map(i => i.email)).toEqual(['c@x.com', 'b@x.com']);
  });
});

describe('askCrm — deals_closing intent', () => {
  it('returns in_deal leads sorted by deal value descending', async () => {
    const leads = [
      lead({ email: 'a@x.com', lifecycle: 'in_deal', dealValue: 1000 }),
      lead({ email: 'b@x.com', lifecycle: 'in_deal', dealValue: 5000 }),
      lead({ email: 'c@x.com', lifecycle: 'inbox', dealValue: 9999 }),
    ];
    const result = await askCrm('which deals are closing', 'u1', makeDeps(leads));
    expect(result.intent).toBe('deals_closing');
    expect(result.items.map(i => i.email)).toEqual(['b@x.com', 'a@x.com']);
  });
});

describe('askCrm — paying_customers intent', () => {
  it('returns paying + trialing lifecycles', async () => {
    const leads = [
      lead({ email: 'a@x.com', lifecycle: 'paying' }),
      lead({ email: 'b@x.com', lifecycle: 'trialing' }),
      lead({ email: 'c@x.com', lifecycle: 'inbox' }),
      lead({ email: 'd@x.com', lifecycle: 'churned' }),
    ];
    const result = await askCrm('show paying customers', 'u1', makeDeps(leads));
    expect(result.intent).toBe('paying_customers');
    expect(result.items.map(i => i.email).sort()).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('askCrm — specific_contact intent', () => {
  it('filters by name/email/company tokens in the question', async () => {
    const leads = [
      lead({ email: 'jane@acme.com', firstName: 'Jane', company: 'Acme Co' }),
      lead({ email: 'bob@other.com', firstName: 'Bob', company: 'Other' }),
    ];
    const result = await askCrm('is Jane at acme paying us', 'u1', makeDeps(leads));
    expect(result.intent).toBe('specific_contact');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].email).toBe('jane@acme.com');
  });

  it('empty result set yields a descriptive summary', async () => {
    const leads = [lead({ email: 'bob@other.com', firstName: 'Bob' })];
    const result = await askCrm('does Jane at acme pay us', 'u1', makeDeps(leads));
    expect(result.items).toHaveLength(0);
    expect(result.summary.toLowerCase()).toContain('no contacts matched');
  });
});

describe('askCrm — citationUrl', () => {
  it('builds per-lead deep link', async () => {
    const leads = [lead({ email: 'a@x.com', leadId: 'LEAD_1', listId: 'LIST_1', lifecycle: 'inbox', contactStatus: 'active' })];
    const result = await askCrm('hot leads', 'u1', makeDeps(leads));
    expect(result.items[0].citationUrl).toBe('/crm/lists/LIST_1/leads/LEAD_1');
  });

  it('URL-encodes special characters in ids', async () => {
    const leads = [lead({ email: 'a@x.com', leadId: 'lead/1', listId: 'list 1', lifecycle: 'inbox', contactStatus: 'active' })];
    const result = await askCrm('hot leads', 'u1', makeDeps(leads));
    expect(result.items[0].citationUrl).toBe('/crm/lists/list%201/leads/lead%2F1');
  });
});

describe('askCrm — totalConsidered', () => {
  it('reports the pre-filter count', async () => {
    const leads = Array.from({ length: 7 }).map((_, i) =>
      lead({ email: `u${i}@x.com`, heatScore: i, lifecycle: 'inbox', contactStatus: 'active' })
    );
    const result = await askCrm('hot leads', 'u1', makeDeps(leads));
    expect(result.totalConsidered).toBe(7);
  });
});

describe('askCrm — respects load limit', () => {
  it('passes the loadLimit through to the fetcher', async () => {
    const loadLeadsForUser = jest.fn(async () => []);
    await askCrm('hot leads', 'u1', { loadLeadsForUser }, { loadLimit: 42 });
    expect(loadLeadsForUser).toHaveBeenCalledWith('u1', { limit: 42 });
  });
});
