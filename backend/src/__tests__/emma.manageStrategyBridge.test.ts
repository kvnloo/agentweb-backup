/**
 * ENG-2840 wave 1, PR C: manage_market_strategy in AGENT MODE.
 *
 * The tool was registered for MCP callers only (mcpToolRegistry); agent mode copies its tools from Emma's registry, so a private skill that
 * listed manage_market_strategy offered nothing and a call answered "Unknown tool: manage_market_strategy". It is now bridged into Emma's
 * registry (`bridgedToolNames` in emma/tools.ts), so a skill that lists it works. Emma's own update_market_strategy is unchanged.
 *
 * These tests drive a real AgentModeService (the dispatcher a chat turn uses: argument contract, policy, registry) against the same real Express
 * app, db.ts and in-memory DynamoDB as mcp.manageStrategy.writes.test.ts, as a solo account (no organisation).
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__strategyBridgeFake = fake;
  actual.DynamoDB.DocumentClient = fake.documentClient;
  return actual;
});
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));

import app from '../app';
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { mcpToolRegistry } from '../mcp/server/registry';
import { clearRecentStrategyWrites } from '../mcp/server/manageStrategyWrites';
import { AgentModeService } from '../services/agentModeService';
import { installSelfCallFetch } from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__strategyBridgeFake;
const SOLO = 'user-solo-bridge';
const STORED_AT = '2026-10-01T09:00:00.000Z';
const MODEL = 'claude-sonnet-4-5';

let restoreFetch: () => void;
let service: AgentModeService;

const soloRow = () => fake.items('AW-Users').find((u: any) => u.userId === SOLO);
const strategy = () => soloRow().marketStrategy;
const competitorNames = () => (strategy().competitors as any[]).map((c) => c.name);

function seedSolo(): void {
  fake.seed('AW-Users', {
    email: 'solo-bridge@solo.test', userId: SOLO, isActive: true, isAdmin: false, roles: ['customer'],
    marketStrategy: {
      businessOverview: 'We sell gadgets',
      competitors: [{ name: 'Stored One', description: 'first' }, { name: 'Stored Two', description: 'second' }],
      icp: [{ title: 'Founders', description: 'small teams', extractedFilters: { keep: 'me' } }],
      createdAt: STORED_AT,
      updatedAt: STORED_AT,
    },
  });
}

/** What a chat turn does with a model's tool call. */
const callAsAgent = (args: any, userId = SOLO) => service.executeTool(MODEL, 'manage_market_strategy', args, userId, 'bridge-session');
const payload = (result: any) => JSON.parse(result.content[0].text);

beforeAll(async () => {
  restoreFetch = installSelfCallFetch(app);
  service = new AgentModeService();
  await service.initialize();
});
afterAll(() => restoreFetch());
beforeEach(() => {
  clearRecentStrategyWrites();
  fake.reset?.();
  seedSolo();
});

describe('manage_market_strategy is a tool of agent mode', () => {
  it('is in Emma\'s registry, the source agent mode copies its tools from, with the definition the MCP server serves', () => {
    const emma = emmaToolRegistry.getTool('manage_market_strategy');
    const mcp = mcpToolRegistry.getTool('manage_market_strategy');
    expect(emma).toBeDefined();
    expect(mcp).toBeDefined();
    expect(emma!.definition).toBe(mcp!.definition);
  });

  it('is offered by a real agent-mode service, next to Emma\'s own update_market_strategy', () => {
    const names = service.getAvailableTools().map((t: any) => t.function?.name);
    expect(names).toContain('manage_market_strategy');
    expect(names).toContain('update_market_strategy');
  });

  it('is not a foundation tool: only a skill that lists it offers it to a session', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).not.toContain('manage_market_strategy');
  });
});

describe('a call made the way a chat turn makes it', () => {
  it('adds the competitor and keeps every competitor and ICP already stored (Opslane AC1 on e22f517)', async () => {
    const result = await callAsAgent({ action: 'update', competitors: [{ name: 'Added By The Agent', description: 'an analytics vendor' }] });
    const answer = payload(result);

    expect(answer.success).toBe(true);
    expect(answer.competitors.added).toEqual(['Added By The Agent']);
    expect(competitorNames()).toEqual(['Stored One', 'Stored Two', 'Added By The Agent']);
    expect(strategy().businessOverview).toBe('We sell gadgets');
    expect(strategy().icp).toEqual([{ title: 'Founders', description: 'small teams', extractedFilters: { keep: 'me' } }]);
    // The ICPs were not sent, so they are not marked as hand-edited.
    expect(strategy().icpUpdatedAt).toBeUndefined();
  });

  it('updates a stored competitor by name instead of adding a second one', async () => {
    await callAsAgent({ action: 'update', competitors: [{ name: '  stored one ', description: 'rewritten' }] });
    expect(competitorNames()).toEqual(['Stored One', 'Stored Two']);
    expect((strategy().competitors as any[])[0].description).toBe('rewritten');
  });

  it('reads the strategy back through the same tool', async () => {
    const answer = payload(await callAsAgent({ action: 'read' }));
    expect(answer.totalCompetitors).toBe(2);
    expect((answer.data.competitors as any[]).map((c) => c.name)).toEqual(['Stored One', 'Stored Two']);
  });

  it('refuses a competitor sent as a bare string before the tool runs, and changes nothing', async () => {
    const before = JSON.stringify(soloRow());
    const result: any = await callAsAgent({ action: 'update', competitors: ['Just A Name'] });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/competitors\[0\]/);
    expect(JSON.stringify(soloRow())).toBe(before);
  });

  it('refuses an argument the tool does not take, by name, and changes nothing', async () => {
    const before = JSON.stringify(soloRow());
    const outcome = await callAsAgent({ action: 'update', competitors: [{ name: 'X' }], targetAudience: 'SMB founders' }).then(
      (r: any) => r,
      (e: any) => ({ success: false, error: String(e?.message ?? e) }),
    );
    expect(outcome.success).toBe(false);
    expect(String(outcome.error)).toMatch(/targetAudience/);
    expect(JSON.stringify(soloRow())).toBe(before);
  });

  it('writes nothing for a caller whose account cannot be identified', async () => {
    const before = JSON.stringify(fake.items('AW-Users'));
    const outcome = await callAsAgent({ action: 'update', competitors: [{ name: 'Ghost' }] }, 'user-that-does-not-exist').then(
      (r: any) => r,
      (e: any) => ({ success: false, error: String(e?.message ?? e) }),
    );
    expect(outcome.success).toBe(false);
    expect(JSON.stringify(fake.items('AW-Users'))).toBe(before);
  });
});
