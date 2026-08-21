// G2: Unit tests for the four new CRM action tools on Emma:
//   assign_lead, promote_to_deal, rotate_primary, get_hot_leads.
//
// These focus on:
//   1. Tool is registered with a well-formed schema
//   2. Happy-path side effects (updateLead, promoteContactsToDeal, rotatePrimary)
//   3. Auth / validation errors
//   4. Event logging is best-effort (log failure does not break the tool)

// --- Mocks BEFORE any imports ---------------------------------------------

jest.mock('../../services/notionService', () => ({ createOncallItem: jest.fn() }));
jest.mock('../../services/resendService', () => ({
  resendService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/settingsService', () => ({
  settingsService: {
    getJsonArraySetting: jest.fn().mockResolvedValue(['founders@agentweb.pro']),
  },
}));
jest.mock('../../services/accountSummaryService', () => ({
  getAccountSummary: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/askCrmService', () => ({
  askCrm: jest.fn(),
  AskCrmLead: {},
}));

// agentModeService has a huge dep tree — stub it.
jest.mock('../../services/agentModeService', () => ({ agentModeService: {} }));

// crmDb + userDb + accountMemoryDb — tool imports these via ../services/db
const mockGetLeadListById = jest.fn();
const mockGetLeadById = jest.fn();
const mockUpdateLead = jest.fn();
const mockGetLeadListsByUserId = jest.fn();
const mockGetLeadsByListId = jest.fn();

const mockGetOrgById = jest.fn();
jest.mock('../../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: (...args: any[]) => mockGetOrgById(...args) },
  accountMemoryDb: {
    getMemories: jest.fn().mockResolvedValue([]),
    putMemory: jest.fn().mockResolvedValue(undefined),
    deleteMemory: jest.fn().mockResolvedValue(undefined),
  },
  crmDb: {
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
    getLeadById: (...args: any[]) => mockGetLeadById(...args),
    updateLead: (...args: any[]) => mockUpdateLead(...args),
    getLeadListsByUserId: (...args: any[]) => mockGetLeadListsByUserId(...args),
    getLeadListsForUser: (...args: any[]) => mockGetLeadListsByUserId(...args),
    getLeadsByListId: (...args: any[]) => mockGetLeadsByListId(...args),
  },
}));

// dealDb — mock the whole module so we don't touch Dynamo
const mockCreateDeal = jest.fn();
const mockGetDeal = jest.fn();
const mockRotatePrimary = jest.fn();
const mockPromoteContactsToDeal = jest.fn();

class FakeDealAuthError extends Error {
  constructor() {
    super('not authorized for deal');
    this.name = 'DealAuthError';
  }
}
class FakeDealNotFoundError extends Error {
  constructor(id: string) {
    super(`deal ${id} not found`);
    this.name = 'DealNotFoundError';
  }
}

jest.mock('../../services/dealDb', () => ({
  DEAL_STAGES: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'],
  DealAuthError: FakeDealAuthError,
  DealNotFoundError: FakeDealNotFoundError,
  dealDb: {
    createDeal: (...args: any[]) => mockCreateDeal(...args),
    getDeal: (...args: any[]) => mockGetDeal(...args),
    rotatePrimary: (...args: any[]) => mockRotatePrimary(...args),
    promoteContactsToDeal: (...args: any[]) => mockPromoteContactsToDeal(...args),
  },
}));

const mockLogEvent = jest.fn();
jest.mock('../../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: (...args: any[]) => mockLogEvent(...args) },
  normalizeContactId: (raw: string) => String(raw || '').trim().toLowerCase(),
}));

// MCP registry — mirror existing test pattern
const toolMap = new Map<string, any>();
const mockRegistryInstance = {
  register: jest.fn((handler: any) => toolMap.set(handler.name, handler)),
  getTool: jest.fn((name: string) => toolMap.get(name)),
  getToolNames: jest.fn(() => Array.from(toolMap.keys())),
  getToolDefinitions: jest.fn(() => Array.from(toolMap.values()).map((t: any) => t.definition)),
  getAllToolDefinitions: jest.fn(() => Array.from(toolMap.values()).map((t: any) => t.definition)),
  getAllTools: jest.fn(() => Array.from(toolMap.values())),
};
jest.mock('../../mcp/server/registry', () => ({
  McpToolRegistry: jest.fn().mockImplementation(() => mockRegistryInstance),
  mcpToolRegistry: mockRegistryInstance,
}));
jest.mock('../../mcp/server/apiTools', () => ({ adminToolNames: [] }));

import { emmaToolRegistry } from '../../emma/registry';
import { userDb } from '../../services/db';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const USER = 'user_1';
const LIST = 'list_1';

async function getTool(name: string) {
  await import('../../emma/tools');
  const tool = emmaToolRegistry.getTool(name);
  expect(tool).toBeDefined();
  return tool!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLogEvent.mockResolvedValue({ deduplicated: false });
  mockGetLeadListById.mockResolvedValue({ listId: LIST, userId: USER, name: 'Pipeline' });
});

describe('G2 — assign_lead tool', () => {
  it('registers with required fields', async () => {
    const tool = await getTool('assign_lead');
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['list_id', 'lead_id', 'account_owner_user_id'])
    );
  });

  it('updates accountOwnerUserId and logs a contact.updated event', async () => {
    mockGetLeadById.mockResolvedValue({ leadId: 'l1', email: 'a@b.com', accountOwnerUserId: null });
    mockUpdateLead.mockResolvedValue(undefined);

    const tool = await getTool('assign_lead');
    const result = await tool.execute(
      { list_id: LIST, lead_id: 'l1', account_owner_user_id: 'user_2' },
      { userId: USER }
    );

    expect(result.success).toBe(true);
    expect(result.accountOwnerUserId).toBe('user_2');
    expect(result.previousAccountOwnerUserId).toBe(null);
    expect(mockUpdateLead).toHaveBeenCalledWith(LIST, 'l1', { accountOwnerUserId: 'user_2' });
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent.mock.calls[0][0].eventType).toBe('contact.updated');
    expect(mockLogEvent.mock.calls[0][0].contactId).toBe('a@b.com');
  });

  it('returns noop when owner is unchanged', async () => {
    mockGetLeadById.mockResolvedValue({ leadId: 'l1', email: 'a@b.com', accountOwnerUserId: 'user_2' });
    const tool = await getTool('assign_lead');
    const result = await tool.execute(
      { list_id: LIST, lead_id: 'l1', account_owner_user_id: 'user_2' },
      { userId: USER }
    );
    expect(result.noop).toBe(true);
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('returns auth error when no userId in context', async () => {
    const tool = await getTool('assign_lead');
    const result = await tool.execute(
      { list_id: LIST, lead_id: 'l1', account_owner_user_id: 'user_2' },
      {}
    );
    expect(result.error).toMatch(/Authentication/);
  });

  it('does not throw when event logging fails', async () => {
    mockGetLeadById.mockResolvedValue({ leadId: 'l1', email: 'a@b.com', accountOwnerUserId: null });
    mockUpdateLead.mockResolvedValue(undefined);
    mockLogEvent.mockRejectedValueOnce(new Error('dynamo down'));

    const tool = await getTool('assign_lead');
    const result = await tool.execute(
      { list_id: LIST, lead_id: 'l1', account_owner_user_id: 'user_2' },
      { userId: USER }
    );
    expect(result.success).toBe(true);
  });

  // ENG-1049: resolveLeadForAction previously did a strict list.userId !==
  // userId check — over-blocking the org owner/editors — instead of the
  // shared canDestructiveCrmList guard used by every other CRM write surface.
  describe('org-share access (ENG-1049)', () => {
    const OWNER = 'owner_1';
    const ORG_MEMBER = 'org_member_1';

    function setSameOrgUsers() {
      mockUserDb.getUserById.mockImplementation((id: string) =>
        Promise.resolve(id === OWNER ? ({ userId: OWNER, orgId: 'org-A' } as any) : ({ userId: id, orgId: 'org-A' } as any))
      );
    }
    function orgWithCrm(overrides: Record<string, any> = {}) {
      return {
        orgId: 'org-A',
        ownerUserId: 'org-owner-id',
        shareSettings: { crm: { enabled: true, editors: [] as string[] } },
        ...overrides,
      };
    }

    beforeEach(() => {
      mockGetLeadListById.mockResolvedValue({ listId: LIST, userId: OWNER, name: 'Pipeline' });
      mockGetLeadById.mockResolvedValue({ leadId: 'l1', email: 'a@b.com', accountOwnerUserId: null });
      mockUpdateLead.mockResolvedValue(undefined);
    });

    it('denies a same-org member who is not the owner and not a CRM editor', async () => {
      setSameOrgUsers();
      mockGetOrgById.mockResolvedValue(orgWithCrm());

      const tool = await getTool('assign_lead');
      const result = await tool.execute(
        { list_id: LIST, lead_id: 'l1', account_owner_user_id: 'user_2' },
        { userId: ORG_MEMBER }
      );

      expect(result.error).toMatch(/CRM editor/i);
      expect(mockUpdateLead).not.toHaveBeenCalled();
    });

    it('allows a listed crm.editor to act on a list they do not own', async () => {
      setSameOrgUsers();
      mockGetOrgById.mockResolvedValue(orgWithCrm({ shareSettings: { crm: { enabled: true, editors: [ORG_MEMBER] } } }));

      const tool = await getTool('assign_lead');
      const result = await tool.execute(
        { list_id: LIST, lead_id: 'l1', account_owner_user_id: 'user_2' },
        { userId: ORG_MEMBER }
      );

      expect(result.success).toBe(true);
      expect(mockUpdateLead).toHaveBeenCalledWith(LIST, 'l1', { accountOwnerUserId: 'user_2' });
    });

    it('allows the org owner to act on a list they do not personally own', async () => {
      setSameOrgUsers();
      mockGetOrgById.mockResolvedValue(orgWithCrm({ ownerUserId: ORG_MEMBER }));

      const tool = await getTool('assign_lead');
      const result = await tool.execute(
        { list_id: LIST, lead_id: 'l1', account_owner_user_id: 'user_2' },
        { userId: ORG_MEMBER }
      );

      expect(result.success).toBe(true);
      expect(mockUpdateLead).toHaveBeenCalledWith(LIST, 'l1', { accountOwnerUserId: 'user_2' });
    });
  });
});

describe('G2 — promote_to_deal tool', () => {
  it('creates a deal via promoteContactsToDeal and logs deal.created', async () => {
    mockGetLeadById.mockResolvedValue({ leadId: 'l1', email: 'a@acme.com' });
    const fakeDeal = { dealId: 'deal_1', stage: 'Lead', primaryContactId: 'l1' };
    mockPromoteContactsToDeal.mockResolvedValue(fakeDeal);

    const tool = await getTool('promote_to_deal');
    const result = await tool.execute(
      { list_id: LIST, lead_ids: ['l1'], deal_value: 5000, deal_name: 'Acme' },
      { userId: USER }
    );

    expect(result.success).toBe(true);
    expect(result.deal).toEqual(fakeDeal);
    expect(mockPromoteContactsToDeal).toHaveBeenCalledWith(
      [{ listId: LIST, leadId: 'l1' }],
      expect.objectContaining({
        ownerUserId: USER,
        primaryContactId: 'l1',
        dealValue: 5000,
        companyDomain: 'acme.com',
        notes: 'name: Acme',
      })
    );
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'deal.created', dealId: 'deal_1' })
    );
  });

  it('rejects when lead_ids empty', async () => {
    const tool = await getTool('promote_to_deal');
    const result = await tool.execute({ list_id: LIST, lead_ids: [] }, { userId: USER });
    expect(result.error).toMatch(/non-empty/);
  });

  it('rejects invalid stage', async () => {
    mockGetLeadById.mockResolvedValue({ leadId: 'l1', email: 'a@acme.com' });
    const tool = await getTool('promote_to_deal');
    const result = await tool.execute(
      { list_id: LIST, lead_ids: ['l1'], stage: 'Bogus' },
      { userId: USER }
    );
    expect(result.error).toMatch(/Invalid stage/);
  });
});

describe('G2 — rotate_primary tool', () => {
  it('rotates primary contact on a deal and logs event', async () => {
    mockGetDeal.mockResolvedValue({ dealId: 'd1', primaryContactId: 'lOld', ownerUserId: USER, contactIds: ['lOld'] });
    mockRotatePrimary.mockResolvedValue({ dealId: 'd1', primaryContactId: 'lNew' });

    const tool = await getTool('rotate_primary');
    const result = await tool.execute(
      { deal_id: 'd1', new_primary_contact_id: 'lNew', list_id: LIST, old_primary_list_id: LIST },
      { userId: USER }
    );

    expect(result.success).toBe(true);
    expect(mockRotatePrimary).toHaveBeenCalledWith(
      'd1',
      USER,
      'lNew',
      expect.objectContaining({
        oldPrimary: { listId: LIST, leadId: 'lOld' },
        newPrimary: { listId: LIST, leadId: 'lNew' },
      })
    );
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'deal.primary_rotated', dealId: 'd1' })
    );
  });

  it('surfaces auth errors as clean error strings', async () => {
    mockGetDeal.mockResolvedValue({ dealId: 'd1', primaryContactId: 'lOld', ownerUserId: 'someone_else' });
    mockRotatePrimary.mockRejectedValue(new FakeDealAuthError());

    const tool = await getTool('rotate_primary');
    const result = await tool.execute(
      { deal_id: 'd1', new_primary_contact_id: 'lNew' },
      { userId: USER }
    );
    expect(result.error).toMatch(/Not authorized/);
  });
});

describe('G2 — get_hot_leads tool', () => {
  it('returns leads ranked by heatScore, applying filters', async () => {
    mockGetLeadListsByUserId.mockResolvedValue([{ listId: LIST, name: 'Pipeline' }]);
    mockGetLeadsByListId.mockResolvedValue({
      items: [
        { leadId: 'a', heatScore: 40, lifecycle: 'Lead', accountOwnerUserId: USER },
        { leadId: 'b', heatScore: 95, lifecycle: 'MQL', accountOwnerUserId: USER },
        { leadId: 'c', heatScore: 80, lifecycle: 'MQL', accountOwnerUserId: 'user_2' },
        { leadId: 'd', heatScore: 75, lifecycle: 'MQL', accountOwnerUserId: USER },
      ],
    });

    const tool = await getTool('get_hot_leads');
    const result = await tool.execute(
      { lifecycle: 'MQL', min_heat_score: 70, owner_filter: 'me', limit: 5 },
      { userId: USER }
    );

    expect(result.leads.map((l: any) => l.leadId)).toEqual(['b', 'd']);
    expect(result.count).toBe(2);
    expect(result.filters).toEqual({ lifecycle: 'MQL', minHeatScore: 70, ownerFilter: USER });
  });

  it('clamps limit to [1, 100]', async () => {
    mockGetLeadListsByUserId.mockResolvedValue([]);
    const tool = await getTool('get_hot_leads');
    const r1 = await tool.execute({ limit: 9999 }, { userId: USER });
    const r2 = await tool.execute({ limit: -5 }, { userId: USER });
    // no crashes, just shape check
    expect(r1.leads).toEqual([]);
    expect(r2.leads).toEqual([]);
  });

  it('returns auth error with no userId', async () => {
    const tool = await getTool('get_hot_leads');
    const r = await tool.execute({}, {});
    expect(r.error).toMatch(/Authentication/);
  });
});
