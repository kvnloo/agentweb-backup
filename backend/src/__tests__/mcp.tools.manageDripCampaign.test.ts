/**
 * Tests for `manage_drip_campaign` — Phase 3 of the Lifecycle Drip epic.
 * Verifies the MCP tool is registered, takes the expected args, and routes
 * each action to the right HTTP verb/path on /api/drip-campaigns.
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

const USER_ID = 'admin-user-1';
const context = { userId: USER_ID, agentUserId: USER_ID };

describe('manage_drip_campaign (admin MCP tool)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers the tool in mcpToolRegistry', () => {
    const handler = mcpToolRegistry.getTool('manage_drip_campaign');
    expect(handler).toBeDefined();
    expect(handler?.definition.name).toBe('manage_drip_campaign');
  });

  it('requires `action` in its schema and lists all 7 actions', () => {
    const handler = mcpToolRegistry.getTool('manage_drip_campaign');
    const schema = handler?.definition.inputSchema as any;
    expect(schema.required).toEqual(['action']);
    expect(schema.properties.action.enum).toEqual(
      expect.arrayContaining([
        'list',
        'get',
        'create',
        'update',
        'pause',
        'resume',
        'delete',
      ]),
    );
  });

  it('action=list issues GET /api/drip-campaigns', async () => {
    mockMcpFetch.mockResolvedValue({ campaigns: [] });
    await mcpToolRegistry.execute(
      'manage_drip_campaign',
      { action: 'list' },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/api/drip-campaigns',
      }),
    );
  });

  it('action=get requires campaign_id and hits GET /:id', async () => {
    mockMcpFetch.mockResolvedValue({ campaign: { campaignId: 'abc' } });
    await mcpToolRegistry.execute(
      'manage_drip_campaign',
      { action: 'get', campaign_id: 'abc' },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/api/drip-campaigns/abc',
      }),
    );
  });

  it('action=get without campaign_id returns a structured error (no HTTP call)', async () => {
    const result = await mcpToolRegistry.execute(
      'manage_drip_campaign',
      { action: 'get' },
      context,
    );
    expect(mockMcpFetch).not.toHaveBeenCalled();
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toMatch(/campaign_id is required/);
  });

  it('action=create maps snake_case args to camelCase body', async () => {
    mockMcpFetch.mockResolvedValue({ campaign: { campaignId: 'new-1' } });
    await mcpToolRegistry.execute(
      'manage_drip_campaign',
      {
        action: 'create',
        name: 'Test drip',
        subject_line: 'hi',
        template_html: '<p>{{firstName}}</p>',
        cadence_unit: 'days',
        cadence_value: 7,
        max_sends: 3,
        segment_query: { stage: 'brand_skipped' },
      },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/drip-campaigns',
        body: expect.objectContaining({
          name: 'Test drip',
          subjectLine: 'hi',
          templateHtml: '<p>{{firstName}}</p>',
          cadenceUnit: 'days',
          cadenceValue: 7,
          maxSends: 3,
          segmentQuery: { stage: 'brand_skipped' },
        }),
      }),
    );
  });

  it('action=update maps fields and uses PATCH /:id', async () => {
    mockMcpFetch.mockResolvedValue({ campaign: { campaignId: 'abc' } });
    await mcpToolRegistry.execute(
      'manage_drip_campaign',
      { action: 'update', campaign_id: 'abc', cadence_value: 14 },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/drip-campaigns/abc',
        body: { cadenceValue: 14 },
      }),
    );
  });

  it('action=pause PATCHes killSwitch=true', async () => {
    mockMcpFetch.mockResolvedValue({ campaign: { campaignId: 'abc' } });
    await mcpToolRegistry.execute(
      'manage_drip_campaign',
      { action: 'pause', campaign_id: 'abc' },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        body: { killSwitch: true },
      }),
    );
  });

  it('action=resume PATCHes killSwitch=false', async () => {
    mockMcpFetch.mockResolvedValue({ campaign: { campaignId: 'abc' } });
    await mcpToolRegistry.execute(
      'manage_drip_campaign',
      { action: 'resume', campaign_id: 'abc' },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        body: { killSwitch: false },
      }),
    );
  });

  it('action=delete issues DELETE /:id', async () => {
    mockMcpFetch.mockResolvedValue({});
    await mcpToolRegistry.execute(
      'manage_drip_campaign',
      { action: 'delete', campaign_id: 'abc' },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        path: '/api/drip-campaigns/abc',
      }),
    );
  });

  it('unknown action returns error without calling HTTP', async () => {
    const result = await mcpToolRegistry.execute(
      'manage_drip_campaign',
      { action: 'bogus' },
      context,
    );
    expect(mockMcpFetch).not.toHaveBeenCalled();
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toMatch(/Unknown action/);
  });
});
