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

const makeCompetitors = (n: number, prefix = 'Comp') =>
  Array.from({ length: n }, (_, i) => ({
    name: `${prefix}${i + 1}`,
    description: `Description for ${prefix}${i + 1}`,
  }));

const marketStrategyWith = (competitors: any[]) => ({
  businessOverview: 'We do X',
  competitors,
  icp: [{ title: 'ICP1', description: 'd', valueProposition: 'v', buyerPersonas: ['p'] }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
});

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

  it('never hides stored competitors: every name beyond the detail limit is still listed', async () => {
    const competitors = makeCompetitors(49);
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', marketStrategy: marketStrategyWith(competitors) });

    const res = await svc.readMarketStrategy('u1');

    expect(res.success).toBe(true);
    for (const c of competitors) {
      expect(res.formattedContent).toContain(c.name);
    }
  });

  it('reports the true stored competitor count, not the number rendered in full', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', marketStrategy: marketStrategyWith(makeCompetitors(49)) });

    const res = await svc.readMarketStrategy('u1');

    expect(res.totalCompetitors).toBe(49);
    expect(res.competitorsWithFullDetail).toBe(40);
    expect(res.formattedContent).toContain('49');
  });

  it('states explicitly that the name-only entries exist so they are not re-added or reported missing', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', marketStrategy: marketStrategyWith(makeCompetitors(49)) });

    const res = await svc.readMarketStrategy('u1');

    expect(res.formattedContent).toMatch(/name only/i);
    expect(res.formattedContent).toMatch(/do not treat them as missing/i);
  });

  it('does not mutate the stored market strategy while rendering', async () => {
    const strategy = marketStrategyWith(makeCompetitors(49));
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', marketStrategy: strategy });

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
  it('renders every competitor with its description and no truncation notice when at or below the limit', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', marketStrategy: marketStrategyWith(makeCompetitors(40)) });

    const res = await svc.readMarketStrategy('u1');

    expect(res.totalCompetitors).toBe(40);
    expect(res.formattedContent).toContain('Description for Comp40');
    expect(res.formattedContent).not.toMatch(/name only/i);
  });

  it('a competitor added past the limit is visible on the next read (write/read round-trip)', async () => {
    const existing = makeCompetitors(45);
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', marketStrategy: marketStrategyWith(existing) });
    userDb.updateUser.mockResolvedValue({});

    const write = await svc.updateMarketStrategy({ competitors: [{ name: 'Tenasol', description: 'NEW ENTRY' }] }, 'u1');
    expect(write.success).toBe(true);
    expect(write.addedEntries).toContain('Competitor: Tenasol');

    const written = userDb.updateUser.mock.calls[0][1].marketStrategy;
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@x.com', marketStrategy: written });

    const res = await svc.readMarketStrategy('u1');
    expect(res.totalCompetitors).toBe(46);
    expect(res.formattedContent).toContain('Tenasol');
  });
});
