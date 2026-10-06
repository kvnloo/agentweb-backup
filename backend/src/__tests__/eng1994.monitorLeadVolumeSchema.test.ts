/**
 * Tests for mcp/server/apiTools.ts
 * Verifies tool registrations, HTTP call patterns, and response mapping.
 */

// Mock httpClient before importing apiTools
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

// Mock skillService and subscriptionService for install_skills/list_available_skills
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([
      { skillId: 'skill-1', name: 'Skill One', description: 'Test skill', toolNames: ['tool_a'] },
    ]),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue(['unassociated_tool']),
  },
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import { normalizeLeadVolumeDate } from '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const ctx = { userId: 'admin-1', isAdmin: true } as any;

describe('ENG-1994 monitor_lead_volume schema/handler parity', () => {
  beforeEach(() => mockMcpFetch.mockReset().mockResolvedValue({ success: true } as any));

  const pathFor = async (args: Record<string, unknown>) => {
    const tool: any = mcpToolRegistry.getTool('monitor_lead_volume');
    await tool.execute({ client_name_or_email: 'a@example.com', ...args }, ctx);
    return (mockMcpFetch.mock.calls[0][0] as any).path as string;
  };

  it.each([
    ['2026-09-01T00:00:00Z', '2026-09-01'],
    ['2026-09-01T13:45:10.123+05:30', '2026-09-01'],
    ['2026-09-01T08:00', '2026-09-01'],
    ['2026-09-01', '2026-09-01'],
  ])('sends a route-acceptable date for %p', async (input, expected) => {
    const path = await pathFor({ since: input, until: input });
    expect(path).toBe(`/api/lead-volume-monitor/a%40example.com?since=${expected}&until=${expected}`);
  });

  it.each(['not-a-date', '2026/09/01', '2026-9-1', '2025-02-31T12:00:00Z'])('passes malformed %p through so the route still 400s', async bad => {
    const path = await pathFor({ since: bad });
    expect(new URLSearchParams(path.split('?')[1]).get('since')).toBe(bad);
  });

  it('omits empty optional dates', async () => {
    expect(await pathFor({ since: '', until: undefined })).toBe('/api/lead-volume-monitor/a%40example.com');
    expect(normalizeLeadVolumeDate(null)).toBeUndefined();
  });

  it('declares the real date contract in the schema', () => {
    const def: any = (mcpToolRegistry.getTool('monitor_lead_volume') as any).definition;
    const re = new RegExp(def.inputSchema.properties.since.pattern);
    expect(re.test('2026-09-01')).toBe(true);
    expect(re.test('2026-09-01T00:00:00Z')).toBe(true);
    expect(re.test('not-a-date')).toBe(false);
    expect(def.inputSchema.properties.since.description).toMatch(/366 days/);
  });
});
