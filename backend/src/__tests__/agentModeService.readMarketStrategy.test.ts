import { AgentModeService } from '../services/agentModeService';

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
    updateOrg: jest.fn(),
  },
}));

const userDb = require('../services/db').userDb;
const orgDb = require('../services/db').orgDb;

// A tool result over this many characters is offloaded to S3 and only its first
// 20,000 chars stay in the model's context (TOOL_RESPONSE_S3_THRESHOLD /
// S3_IN_MEMORY_CAP in agentMode/core/toolDispatch). A read_market_strategy page
// that exceeds it pushes its own competitor list out of context.
const IN_CONTEXT_CAP = 20000;

// Real competitor descriptions on the reporting account run 57–2,107 chars
// (mean 1,106). The fixtures use realistic sizes on purpose: with toy 60-char
// descriptions a character budget is never exercised and the paging tests below
// would pass against an implementation that pages badly.
const DESC_CHARS = 1000;

const makeCompetitors = (n: number, prefix = 'Comp', descChars = DESC_CHARS) =>
  Array.from({ length: n }, (_, i) => ({
    name: `${prefix}${i + 1}`,
    description: `Description for ${prefix}${i + 1}. `.padEnd(descChars, 'x'),
  }));

const marketStrategyWith = (competitors: any[], icpChars = 200) => ({
  businessOverview: 'We do X',
  competitors,
  icp: [{
    title: 'ICP1',
    description: 'd'.padEnd(icpChars, 'd'),
    valueProposition: 'v',
    buyerPersonas: ['p'],
  }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
});

const asUser = (marketStrategy: any) => ({ userId: 'u1', email: 'u@x.com', marketStrategy });

// ENG-945: read_market_strategy used to silently slice the competitor list to
// the first 40 entries. Callers (Emma / scheduled agents) read that truncated
// list back after a write, saw fewer competitors than they had just written,
// and concluded the write had silently dropped records — when in fact the
// records were stored and only hidden by the read.
describe('AgentModeService.readMarketStrategy competitor visibility (ENG-945)', () => {
  let svc: AgentModeService;
  beforeEach(() => {
    svc = new AgentModeService();
    jest.clearAllMocks();
  });

  it('never hides stored competitors: every name beyond the detail window is still listed', async () => {
    const competitors = makeCompetitors(49);
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(competitors)));

    const res = await svc.readMarketStrategy('u1');

    expect(res.success).toBe(true);
    for (const c of competitors) {
      expect(res.formattedContent).toContain(c.name);
    }
  });

  it('reports the true stored competitor count, not the number rendered in full', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1');

    expect(res.totalCompetitors).toBe(49);
    expect(res.competitorsWithFullDetail).toBeLessThan(49);
    expect(res.formattedContent).toContain('49 total');
  });

  it('states explicitly that the name-only entries exist so they are not re-added or reported missing', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1');

    expect(res.formattedContent).toMatch(/name only/i);
    expect(res.formattedContent).toMatch(/do not treat them as missing/i);
  });

  it('does not mutate the stored market strategy while rendering', async () => {
    const strategy = marketStrategyWith(makeCompetitors(49));
    userDb.getUserById.mockResolvedValue(asUser(strategy));

    await svc.readMarketStrategy('u1');

    expect(strategy.competitors).toHaveLength(49);
  });

  it('reads the org strategy for org members and still exposes every competitor', async () => {
    const orgCompetitors = makeCompetitors(46, 'OrgComp');
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', orgId: 'o1' });
    orgDb.getOrgById.mockResolvedValue({ orgId: 'o1', marketStrategy: marketStrategyWith(orgCompetitors) });

    const res = await svc.readMarketStrategy('u1');

    expect(res.totalCompetitors).toBe(46);
    expect(res.formattedContent).toContain('OrgComp46');
  });

  // Happy path: nothing changes for the common (small) case.
  it('renders every competitor with its description and no truncation notice when the whole list fits', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(5))));

    const res = await svc.readMarketStrategy('u1');

    expect(res.totalCompetitors).toBe(5);
    expect(res.competitorsWithFullDetail).toBe(5);
    expect(res.nextCompetitorOffset).toBeNull();
    expect(res.formattedContent).toContain('Description for Comp5');
    expect(res.formattedContent).not.toMatch(/name only/i);
  });

  it('a competitor added past the detail window is visible on the next read (write/read round-trip)', async () => {
    const existing = makeCompetitors(45);
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(existing)));
    userDb.updateUser.mockResolvedValue({});

    const write = await svc.updateMarketStrategy({ competitors: [{ name: 'Tenasol', description: 'NEW ENTRY' }] }, 'u1');
    expect(write.success).toBe(true);
    expect(write.addedEntries).toContain('Competitor: Tenasol');

    const written = userDb.updateUser.mock.calls[0][1].marketStrategy;
    userDb.getUserById.mockResolvedValue(asUser(written));

    const res = await svc.readMarketStrategy('u1');
    expect(res.totalCompetitors).toBe(46);
    expect(res.formattedContent).toContain('Tenasol');
  });
});

// ENG-945 follow-up: name-only is bounded, not lossy — but a caller that needs
// the description of an entry past the detail window must be able to get it,
// and each page must actually fit the context window it is sized for.
describe('AgentModeService.readMarketStrategy competitorOffset paging (ENG-945)', () => {
  let svc: AgentModeService;
  beforeEach(() => {
    svc = new AgentModeService();
    jest.clearAllMocks();
  });

  it('keeps a page inside the in-context window even with a large ICP section', async () => {
    // 8,000-char ICP matches the reporting account, whose ICP section alone was
    // 8,044 chars — the overhead that made a 40-entry page overflow.
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49), 8000)));

    const res = await svc.readMarketStrategy('u1');

    expect(res.formattedContent.length).toBeLessThan(IN_CONTEXT_CAP);
  });

  it('every page stays inside the in-context window while paging the whole list', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null && pages < 50) {
      const res: any = await svc.readMarketStrategy('u1', { competitorOffset: offset });
      expect(res.formattedContent.length).toBeLessThan(IN_CONTEXT_CAP);
      expect(res.competitorsWithFullDetail).toBeGreaterThan(0);
      offset = res.nextCompetitorOffset;
      pages++;
    }
    expect(offset).toBeNull();
    expect(pages).toBeGreaterThan(1);
  });

  it('following nextCompetitorOffset yields every competitor description exactly once', async () => {
    const competitors = makeCompetitors(49);
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(competitors)));

    const seen = new Set<string>();
    let offset: number | null = 0;
    while (offset !== null) {
      const res: any = await svc.readMarketStrategy('u1', { competitorOffset: offset });
      for (const c of competitors) {
        // A full-detail line carries the description; a name-only line does not.
        if (res.formattedContent.includes(`<strong>${c.name}:</strong>`)) seen.add(c.name);
      }
      offset = res.nextCompetitorOffset;
    }

    expect(seen.size).toBe(49);
  });

  it('returns full descriptions for the tail when the window is moved past the first page', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1', { competitorOffset: 40 });

    expect(res.competitorDetailOffset).toBe(40);
    expect(res.competitorsWithFullDetail).toBeGreaterThan(0);
    // The page starts exactly where it was asked to and runs as far as the
    // character budget allows — every entry in it carries its description.
    const last = res.competitorDetailOffset + res.competitorsWithFullDetail;
    for (let i = 40; i < last; i++) {
      expect(res.formattedContent).toContain(`<strong>Comp${i + 1}:</strong>`);
    }
    // ...and the first page is still fully accounted for, by name only.
    expect(res.formattedContent).toContain('[offset 0] Comp1');
    expect(res.formattedContent).not.toContain('<strong>Comp1:</strong>');
  });

  // The name index on page 1 is a random-access directory, not a breadcrumb:
  // reaching competitor 48 must cost ONE more call, not one call per page.
  it('makes any competitor reachable in a single further call from the first page', async () => {
    const competitors = makeCompetitors(49);
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(competitors)));

    const first = await svc.readMarketStrategy('u1');
    // The first page must advertise an offset for every entry it did not detail.
    for (let i = first.competitorsWithFullDetail; i < 49; i++) {
      expect(first.formattedContent).toContain(`[offset ${i}] ${competitors[i].name}`);
    }

    // Jump straight to the 48th record using the offset printed on page 1.
    const jumped = await svc.readMarketStrategy('u1', { competitorOffset: 47 });
    expect(jumped.formattedContent).toContain('<strong>Comp48:</strong>');
    expect(jumped.competitorDetailOffset).toBe(47);
  });

  it('teaches random access rather than sequential paging', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1');

    expect(res.formattedContent).toMatch(/no need to page through in order/i);
    expect(res.formattedContent).toMatch(/jump straight to the entry you want/i);
  });

  it('tells the caller which offset to ask for next instead of forbidding a second read', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1');

    expect(res.formattedContent).toMatch(/competitorOffset/);
    expect(res.formattedContent).toContain(`[offset ${res.nextCompetitorOffset}]`);
    expect(res.formattedContent).not.toMatch(/do not call read_market_strategy again/i);
  });

  // ── Invalid / boundary inputs ────────────────────────────────────────────
  it('clamps a negative offset to the start of the list', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1', { competitorOffset: -5 });

    expect(res.competitorDetailOffset).toBe(0);
    expect(res.formattedContent).toContain('<strong>Comp1:</strong>');
  });

  it('clamps an offset past the end of the list so the window is never silently empty', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1', { competitorOffset: 500 });

    expect(res.competitorDetailOffset).toBe(48);
    expect(res.competitorsWithFullDetail).toBe(1);
    expect(res.nextCompetitorOffset).toBeNull();
    expect(res.formattedContent).toContain('<strong>Comp49:</strong>');
  });

  it('ignores a non-numeric offset rather than rendering an empty window', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1', { competitorOffset: 'forty' as any });

    expect(res.competitorDetailOffset).toBe(0);
    expect(res.competitorsWithFullDetail).toBeGreaterThan(0);
  });

  it('still returns a single competitor whose description alone blows the page budget', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(3, 'Huge', 30000))));

    const res = await svc.readMarketStrategy('u1');

    expect(res.competitorsWithFullDetail).toBe(1);
    expect(res.nextCompetitorOffset).toBe(1);
    expect(res.formattedContent).toContain('<strong>Huge1:</strong>');
    expect(res.formattedContent).toContain('[offset 1] Huge2');
  });

  it('sizes the page by characters, not by a fixed count: short descriptions get more per page', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(60, 'Short', 60))));

    const res = await svc.readMarketStrategy('u1');

    // 60 short entries fit comfortably; a fixed 40-entry page would have
    // needlessly demoted 20 of them to name-only.
    expect(res.competitorsWithFullDetail).toBe(60);
    expect(res.nextCompetitorOffset).toBeNull();
  });

  it('pages the org strategy the same way it pages a personal one', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', orgId: 'o1' });
    orgDb.getOrgById.mockResolvedValue({ orgId: 'o1', marketStrategy: marketStrategyWith(makeCompetitors(49, 'OrgComp')) });

    const res = await svc.readMarketStrategy('u1', { competitorOffset: 40 });

    expect(res.competitorDetailOffset).toBe(40);
    expect(res.competitorsWithFullDetail).toBeGreaterThan(0);
    expect(res.formattedContent).toContain('<strong>OrgComp41:</strong>');
    expect(res.formattedContent).toContain('[offset 0] OrgComp1');
  });

  // ENG-945 non-regression: the character budget exists to protect the TOOL
  // result's context window. Non-tool callers (the CRM email drafter embeds
  // formattedContent wholesale into its prompt) used to receive 40 competitors
  // in full and must keep receiving them — the budget must not quietly shrink
  // an unrelated prompt.
  it('honours minCompetitorsInFull, overriding the page character budget', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const budgeted = await svc.readMarketStrategy('u1');
    const legacy = await svc.readMarketStrategy('u1', { minCompetitorsInFull: 40 });

    expect(budgeted.competitorsWithFullDetail).toBeLessThan(40);
    expect(legacy.competitorsWithFullDetail).toBe(40);
    expect(legacy.formattedContent).toContain('Description for Comp40');
    // The tail is still named rather than dropped.
    expect(legacy.formattedContent).toContain('[offset 48] Comp49');
  });

  it('never returns more than the list holds when minCompetitorsInFull exceeds it', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(5))));

    const res = await svc.readMarketStrategy('u1', { minCompetitorsInFull: 40 });

    expect(res.competitorsWithFullDetail).toBe(5);
    expect(res.nextCompetitorOffset).toBeNull();
    expect(res.formattedContent).not.toMatch(/name only/i);
  });

  it('applies minCompetitorsInFull from the requested offset, not from zero', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(60))));

    const res = await svc.readMarketStrategy('u1', { competitorOffset: 30, minCompetitorsInFull: 40 });

    expect(res.competitorDetailOffset).toBe(30);
    expect(res.competitorsWithFullDetail).toBe(30); // 30..59
    expect(res.nextCompetitorOffset).toBeNull();
  });

  it('ignores a non-numeric or negative minCompetitorsInFull', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const bad = await svc.readMarketStrategy('u1', { minCompetitorsInFull: -10 });
    const worse = await svc.readMarketStrategy('u1', { minCompetitorsInFull: 'forty' as any });
    const baseline = await svc.readMarketStrategy('u1');

    expect(bad.competitorsWithFullDetail).toBe(baseline.competitorsWithFullDetail);
    expect(worse.competitorsWithFullDetail).toBe(baseline.competitorsWithFullDetail);
  });

  // The paging instructions are meaningful ONLY in a tool result. The CRM email
  // drafter embeds formattedContent in a prompt that cannot call any tool, so
  // telling it to "call read_market_strategy again with competitorOffset" is at
  // best noise and at worst leaks offset chatter into customer-facing copy.
  it('omits tool-calling instructions when the caller embeds the content in its own prompt', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1', { minCompetitorsInFull: 40, pagingHints: false } as any);

    expect(res.formattedContent).not.toMatch(/competitorOffset/);
    expect(res.formattedContent).not.toMatch(/nextCompetitorOffset/);
    expect(res.formattedContent).not.toMatch(/read_market_strategy/);
    expect(res.formattedContent).not.toMatch(/\[offset \d+\]/);
  });

  it('still names every competitor and states the true total without paging hints', async () => {
    const competitors = makeCompetitors(49);
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(competitors)));

    const res = await svc.readMarketStrategy('u1', { minCompetitorsInFull: 40, pagingHints: false } as any);

    expect(res.formattedContent).toContain('49 total');
    expect(res.competitorsWithFullDetail).toBe(40);
    for (const c of competitors) expect(res.formattedContent).toContain(c.name);
  });

  it('keeps the paging instructions on the default tool path', async () => {
    userDb.getUserById.mockResolvedValue(asUser(marketStrategyWith(makeCompetitors(49))));

    const res = await svc.readMarketStrategy('u1');

    expect(res.formattedContent).toMatch(/competitorOffset/);
    expect(res.formattedContent).toMatch(/\[offset \d+\]/);
  });

  it('exposes competitorOffset on the tool schema so the model can actually ask for it', async () => {
    require('../emma/tools');
    const { emmaToolRegistry } = require('../emma/registry');
    const schema = emmaToolRegistry.getTool('read_market_strategy')?.definition.inputSchema as any;

    expect(schema.properties.competitorOffset).toBeDefined();
    expect(schema.properties.competitorOffset.type).toBe('number');
    expect(schema.required).not.toContain('competitorOffset');
  });
});
