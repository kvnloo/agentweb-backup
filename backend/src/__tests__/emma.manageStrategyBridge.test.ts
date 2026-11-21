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

  it('is registered in a real agent-mode service\'s tool registry, next to Emma\'s own update_market_strategy', () => {
    const names = service.getAvailableTools().map((t: any) => t.function?.name);
    expect(names).toContain('manage_market_strategy');
    expect(names).toContain('update_market_strategy');
  });
});

describe('which sessions are offered it (review of f8ca60f: not through the catch-all pool)', () => {
  const skill = (isPublished: boolean) => ({
    skillId: 'strategy-skill', name: 'Strategy', description: 'Maintains the market strategy', isPublished, toolNames: ['manage_market_strategy'],
  });

  it('a session with foundation tools only is not offered it', () => {
    const { allowedToolNames } = service.buildSkillContext([], ['*'], [], []);
    expect(allowedToolNames.has('manage_market_strategy')).toBe(false);
  });

  it('the __other_skills__ catch-all pool does not carry it, although it still carries other tools', () => {
    const pool = service.getUnassociatedToolNames([]);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool).not.toContain('manage_market_strategy');
    const { allowedToolNames } = service.buildSkillContext([], ['*'], [], ['__other_skills__']);
    expect(allowedToolNames.has('manage_market_strategy')).toBe(false);
  });

  it('a session whose installed skill lists it is offered it (a private skill, then a published one)', () => {
    for (const published of [false, true]) {
      const { allowedToolNames } = service.buildSkillContext([skill(published)], ['*'], [skill(published)], ['strategy-skill']);
      expect(allowedToolNames.has('manage_market_strategy')).toBe(true);
    }
  });

  it('the tool definitions a skill-filtered session is sent carry it only when its skill lists it', async () => {
    const offered = async (allowed: Set<string>) =>
      (await service.getFilteredTools(SOLO, allowed, ['*'])).map((t: any) => t.function?.name ?? t.name);

    const without = await offered(service.buildSkillContext([], ['*'], [], []).allowedToolNames);
    const withSkill = await offered(service.buildSkillContext([skill(false)], ['*'], [skill(false)], ['strategy-skill']).allowedToolNames);

    expect(without).not.toContain('manage_market_strategy');
    expect(without).toContain('update_market_strategy');
    expect(withSkill).toContain('manage_market_strategy');
    expect(withSkill).toContain('update_market_strategy');
  });

  it('a tier that does not entitle the skill (or the pool) is not offered its tools', () => {
    const { allowedToolNames } = service.buildSkillContext([skill(false)], ['some-other-skill'], [skill(false)], ['strategy-skill', '__other_skills__']);
    expect(allowedToolNames.has('manage_market_strategy')).toBe(false);
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

  it('refuses a caller whose account cannot be identified, with the tool\'s own refusal, and writes nothing', async () => {
    const before = JSON.stringify(fake.items('AW-Users'));
    const outcome = await callAsAgent({ action: 'update', competitors: [{ name: 'Ghost' }] }, 'user-that-does-not-exist').then(
      (r: any) => r,
      (e: any) => ({ success: false, error: String(e?.message ?? e) }),
    );
    expect(outcome.success).toBe(false);
    expect(String(outcome.error)).toMatch(/could not be identified/);
    expect(String(outcome.error)).not.toMatch(/Unknown tool/);
    expect(JSON.stringify(fake.items('AW-Users'))).toBe(before);
  });

  it('refuses an anonymous (not signed-in) session with the same deferred refusal Emma\'s own strategy tool gives, for update and read, and writes nothing', async () => {
    const before = JSON.stringify(fake.items('AW-Users'));
    const update: any = await callAsAgent({ action: 'update', competitors: [{ name: 'Ghost' }] }, 'anon_abc123');
    const read: any = await callAsAgent({ action: 'read' }, 'anon_abc123');
    const emma: any = await service.executeTool(MODEL, 'update_market_strategy', { competitors: [{ name: 'Ghost' }] }, 'anon_abc123', 'bridge-session');

    for (const refusal of [update, read]) {
      expect(refusal.deferred).toBe(true);
      expect(refusal.retryable).toBe(false);
      expect(refusal.message).toContain('Sign in to use manage_market_strategy');
    }
    expect(update.reason).toBe(emma.reason);
    expect(JSON.stringify(fake.items('AW-Users'))).toBe(before);
  });
});
