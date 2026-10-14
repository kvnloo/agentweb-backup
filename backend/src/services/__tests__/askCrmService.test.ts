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


describe('askCrm — ENG-2155 live lifecycle precedence', () => {
  it('lets an authorized active subscription advance stale inbox to paying', async () => {
    const result = await askCrm('show paying customers', 'u1', makeDeps([
      lead({ lifecycle: 'inbox', subscriptionState: 'active', hasUserRecord: true }),
    ]));
    expect(result.items[0].lifecycle).toBe('paying');
  });

  it('lets positive open-deal evidence advance stale inbox to in_deal', async () => {
    const result = await askCrm('which deals are closing', 'u1', makeDeps([
      lead({ lifecycle: 'inbox', openDealStages: ['Negotiation'] }),
    ]));
    expect(result.items[0].lifecycle).toBe('in_deal');
  });

  it('does not treat closed-only deal stages as authoritative evidence for a downgrade', async () => {
    const result = await askCrm('which deals are closing', 'u1', makeDeps([
      lead({ lifecycle: 'in_deal', openDealStages: ['Won'] }),
    ]));
    expect(result.items[0].lifecycle).toBe('in_deal');
  });

  it('uses stored lifecycle when no positive/terminal live signal can replace it', async () => {
    const result = await askCrm('show paying customers', 'u1', makeDeps([
      lead({ lifecycle: 'paying', openDealStages: [] }),
    ]));
    expect(result.items[0].lifecycle).toBe('paying');
  });

  // specific_contact is lifecycle-agnostic (text match only), unlike the
  // paying_customers/at_risk/deals_closing intents above, which filter the result
  // list BY the derived lifecycle — so a test whose derived outcome isn't in that
  // intent's own target set would see result.items come back empty rather than
  // actually exercising deriveScores. Querying by name keeps every case below
  // observable regardless of what lifecycle it resolves to.
  it('lets a confirmed account record advance stale inbox to signed_up', async () => {
    const result = await askCrm('is Signupcase at acme', 'u1', makeDeps([
      lead({ firstName: 'Signupcase', company: 'Acme', lifecycle: 'inbox', hasUserRecord: true }),
    ]));
    expect(result.items[0].lifecycle).toBe('signed_up');
  });

  it('lets 60+ days of inactivity advance stale paying to churned', async () => {
    const result = await askCrm('is Churncase at acme', 'u1', makeDeps([
      lead({ firstName: 'Churncase', company: 'Acme', lifecycle: 'paying', lastActivityAt: '2026-01-01T00:00:00Z' }),
    ]));
    expect(result.items[0].lifecycle).toBe('churned');
  });

  // healthScore/lastUsageAt are NOT live signals: askCrmLeadLoader.ts never merges
  // either one (healthScore is written once, historic-only, by
  // scripts/backfill-crm-scores.ts and never refreshed; lastUsageAt is never
  // persisted onto a lead row outside that same one-time script). A gate branch
  // that trusted them alone would downgrade a stored "paying" off a snapshot with
  // zero live evidence behind it — exactly what this gate exists to prevent. These
  // two guard against reintroducing that.
  it('does not let a stale stored health score alone move a stored paying customer to at_risk', async () => {
    const result = await askCrm('is Healthcase at acme', 'u1', makeDeps([
      lead({ firstName: 'Healthcase', company: 'Acme', lifecycle: 'paying', healthScore: 20 }),
    ]));
    expect(result.items[0].lifecycle).toBe('paying');
  });

  it.each(['paying', 'trialing', 'at_risk'] as const)(
    'does not let an open deal downgrade a stored %s customer to in_deal', async stored => {
      const result = await askCrm('is Dealcase at acme', 'u1', makeDeps([
        lead({ firstName: 'Dealcase', company: 'Acme', lifecycle: stored, openDealStages: ['Negotiation'] }),
      ]));
      expect(result.items[0].lifecycle).toBe(stored);
    });

  it('still lets an open deal promote a stored signed_up lead to in_deal', async () => {
    const result = await askCrm('is Promocase at acme', 'u1', makeDeps([
      lead({ firstName: 'Promocase', company: 'Acme', lifecycle: 'signed_up', hasUserRecord: true, openDealStages: ['Proposal'] }),
    ]));
    expect(result.items[0].lifecycle).toBe('in_deal');
  });

  it('still lets a live active subscription win over an open deal on a stored inbox lead', async () => {
    const result = await askCrm('is Subwins at acme', 'u1', makeDeps([
      lead({ firstName: 'Subwins', company: 'Acme', lifecycle: 'inbox', subscriptionState: 'active', openDealStages: ['Proposal'] }),
    ]));
    expect(result.items[0].lifecycle).toBe('paying');
  });

  describe('win-back: a live open deal on a churned-looking lead', () => {
    const live = { liveOpenDealStages: ['Negotiation'], openDealStages: ['Negotiation'] };
    const life = async (name: string, l: Partial<AskCrmLead>) =>
      (await askCrm(`is ${name} at acme`, 'u1', makeDeps([lead({ firstName: name, company: 'Acme', ...l })]))).items[0].lifecycle;

    it('reports in_deal for a stored churned lead', async () => {
      expect(await life('Wbstored', { lifecycle: 'churned', ...live })).toBe('in_deal');
    });
    it('reports in_deal for a stored paying lead whose subscription was canceled', async () => {
      expect(await life('Wbcancel', { lifecycle: 'paying', subscriptionState: 'canceled', ...live })).toBe('in_deal');
    });
    it('reports in_deal for a cold lead that is 60+ days idle', async () => {
      expect(await life('Wbidle', { lifecycle: 'inbox', lastActivityAt: '2026-01-01T00:00:00Z', ...live })).toBe('in_deal');
    });
    it('stays churned when the only deal evidence is stored (possibly stale), not live', async () => {
      expect(await life('Wbstale', { lifecycle: 'churned', openDealStages: ['Negotiation'] })).toBe('churned');
    });
    it('stays churned when the live deal is closed', async () => {
      expect(await life('Wbclosed', { lifecycle: 'churned', liveOpenDealStages: ['Won'] })).toBe('churned');
    });
    it('does not override a live active subscription', async () => {
      expect(await life('Wbsub', { lifecycle: 'churned', subscriptionState: 'active', hasUserRecord: true, ...live })).toBe('paying');
    });
    it('does not change a healthy stored paying lead that has an upsell deal', async () => {
      expect(await life('Wbupsell', { lifecycle: 'paying', ...live })).toBe('paying');
    });
  });

  it('keeps a live active subscriber paying despite 60+ days without a login', async () => {
    const result = await askCrm('is Annualcase at acme', 'u1', makeDeps([
      lead({ firstName: 'Annualcase', company: 'Acme', lifecycle: 'inbox', subscriptionState: 'active', hasUserRecord: true, lastActivityAt: '2026-01-01T00:00:00Z' }),
    ]));
    expect(result.items[0].lifecycle).toBe('paying');
  });

  it('keeps a live trialing subscriber trialing despite 60+ days without a login', async () => {
    const result = await askCrm('is Trialcase at acme', 'u1', makeDeps([
      lead({ firstName: 'Trialcase', company: 'Acme', lifecycle: 'inbox', subscriptionState: 'trialing', hasUserRecord: true, lastActivityAt: '2026-01-01T00:00:00Z' }),
    ]));
    expect(result.items[0].lifecycle).toBe('trialing');
  });

  it('still churns a canceled subscription', async () => {
    const result = await askCrm('is Cancelcase at acme', 'u1', makeDeps([
      lead({ firstName: 'Cancelcase', company: 'Acme', lifecycle: 'paying', subscriptionState: 'canceled', lastActivityAt: '2026-04-01T00:00:00Z' }),
    ]));
    expect(result.items[0].lifecycle).toBe('churned');
  });

  it('does not let a stale health score leak in through a different gate branch (live active sub)', async () => {
    const result = await askCrm('is Leakcase at acme', 'u1', makeDeps([
      lead({ firstName: 'Leakcase', company: 'Acme', lifecycle: 'paying', subscriptionState: 'active', healthScore: 20, lastUsageAt: '2026-03-01T00:00:00Z' }),
    ]));
    expect(result.items[0].lifecycle).toBe('paying');
  });

  it('does not let a stale stored usage timestamp alone move a stored paying customer to at_risk', async () => {
    const result = await askCrm('is Usagecase at acme', 'u1', makeDeps([
      lead({ firstName: 'Usagecase', company: 'Acme', lifecycle: 'paying', lastUsageAt: '2026-03-01T00:00:00Z' }),
    ]));
    expect(result.items[0].lifecycle).toBe('paying');
  });

  it('does not downgrade stored paying from a healthy score and recent usage alone', async () => {
    const result = await askCrm('is Healthycase at acme', 'u1', makeDeps([
      lead({ firstName: 'Healthycase', company: 'Acme', lifecycle: 'paying', healthScore: 90, lastUsageAt: '2026-04-13T00:00:00Z' }),
    ]));
    expect(result.items[0].lifecycle).toBe('paying');
  });

  it('does not let past_due downgrade a stored signed_up lead to inbox', async () => {
    const result = await askCrm('is Pastduecase at acme', 'u1', makeDeps([
      lead({ firstName: 'Pastduecase', company: 'Acme', lifecycle: 'signed_up', subscriptionState: 'past_due' }),
    ]));
    // Before the fix, subscriptionIsDefinitive treated ANY past_due as definitive,
    // so the gate trusted computeLifecycle here — which (Rule 2 only applies from
    // paying/at_risk, so past_due is a no-op, and hasUserRecord is unset) falls
    // through to the Rule 7 email-visibility floor and returns 'inbox'. That is a
    // real downgrade of a stronger stored state, the exact failure class this
    // gate exists to prevent. provesSignup can't rescue this case either —
    // its own condition requires lifecycle to already be 'unknown'/'inbox'.
    expect(result.items[0].lifecycle).toBe('signed_up');
  });

  it('does treat past_due as definitive from an already-paying stored state', async () => {
    const result = await askCrm('is Atriskcase at acme', 'u1', makeDeps([
      lead({ firstName: 'Atriskcase', company: 'Acme', lifecycle: 'paying', subscriptionState: 'past_due' }),
    ]));
    expect(result.items[0].lifecycle).toBe('at_risk');
  });
});
