/**
 * Tests for `get_leads_by_crm_criteria` — Phase A of the drip-campaigns
 * multi-tenant refactor. Verifies the MCP tool is registered, normalizes
 * snake_case args to camelCase, and routes to the customer-scoped preview
 * endpoint.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { getUnassociatedToolNames: jest.fn().mockReturnValue([]) },
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

const USER_ID = 'tenant-1';
const context = { userId: USER_ID, agentUserId: USER_ID };

describe('get_leads_by_crm_criteria', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers the tool in mcpToolRegistry', () => {
    const handler = mcpToolRegistry.getTool('get_leads_by_crm_criteria');
    expect(handler).toBeDefined();
    expect(handler?.definition.name).toBe('get_leads_by_crm_criteria');
  });

  it('accepts all four supported CRM criteria in its schema', () => {
    const handler = mcpToolRegistry.getTool('get_leads_by_crm_criteria');
    const schema = handler?.definition.inputSchema as any;
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        'lifecycle',
        'min_heat_score',
        'utm_source',
        'lead_list_id',
        'limit',
      ].sort(),
    );
    expect(schema.required).toEqual([]);
    expect(schema.properties.lifecycle.enum).toEqual(
      expect.arrayContaining(['trialing', 'paying', 'at_risk']),
    );
  });

  it('routes to POST /api/drip-campaigns/preview-segment with snake_case → camelCase body', async () => {
    mockMcpFetch.mockResolvedValue({
      total: 3,
      sampleSize: 3,
      leads: [],
      criteria: {},
    });
    await mcpToolRegistry.execute(
      'get_leads_by_crm_criteria',
      {
        lifecycle: 'trialing',
        min_heat_score: 50,
        utm_source: 'linkedin',
        lead_list_id: 'list-abc',
        limit: 10,
      },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/drip-campaigns/preview-segment',
        body: {
          lifecycle: 'trialing',
          minHeatScore: 50,
          utmSource: 'linkedin',
          leadListId: 'list-abc',
          limit: 10,
        },
      }),
    );
  });

  it('omits absent args from the body (no null pollution on criteria)', async () => {
    mockMcpFetch.mockResolvedValue({
      total: 0,
      sampleSize: 0,
      leads: [],
      criteria: {},
    });
    await mcpToolRegistry.execute(
      'get_leads_by_crm_criteria',
      { lifecycle: 'paying' },
      context,
    );
    const body = (mockMcpFetch.mock.calls[0][0] as any).body;
    expect(body).toEqual({ lifecycle: 'paying' });
    expect(body).not.toHaveProperty('minHeatScore');
    expect(body).not.toHaveProperty('utmSource');
    expect(body).not.toHaveProperty('leadListId');
  });

  it('passes through the structured response from the backend verbatim', async () => {
    const backendPayload = {
      total: 42,
      sampleSize: 2,
      leads: [
        {
          listId: 'list-A',
          leadId: 'lead-1',
          email: 'a@a.test',
          firstName: 'Alice',
          lastName: 'Smith',
          company: 'Acme',
          lifecycle: 'trialing',
          heatScore: 72,
          utmSource: 'linkedin',
          contactStatus: 'active',
        },
        {
          listId: 'list-A',
          leadId: 'lead-2',
          email: 'b@b.test',
          firstName: 'Bob',
          lastName: null,
          company: null,
          lifecycle: 'trialing',
          heatScore: 60,
          utmSource: null,
          contactStatus: 'active',
        },
      ],
      criteria: { lifecycle: 'trialing' },
    };
    mockMcpFetch.mockResolvedValue(backendPayload);

    const result = await mcpToolRegistry.execute(
      'get_leads_by_crm_criteria',
      { lifecycle: 'trialing' },
      context,
    );

    const text = (result as any).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(backendPayload);
  });
});
