/**
 * ENG-2113 tool relay: the manifest built from the REAL tool registry (every tool a user with all skills could be offered) must fit the relay's
 * protocol limits WITHOUT truncating a description or dropping a tool. Registry growth must fail here, in CI, not silently in production.
 */
import { agentModeService } from '../../agentModeService';
import { TOOL_LIMITS } from '../../../loginHost/protocol';
import { buildRelayManifest, manifestProblem } from '../relayManifest';

jest.mock('openai');
jest.mock('../../settingsService');
jest.mock('../../db');
jest.mock('../../chatbotService');
jest.mock('../../../utils/secretsManager');
jest.mock('../../skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]), getSkillsByIds: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

describe('relay manifest from the real tool registry', () => {
  beforeEach(() => {
    require('../../settingsService').settingsService = { getSetting: jest.fn().mockResolvedValue(null) };
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  async function registryTools() {
    await (agentModeService as any).registerTools(); // the real registration path (Emma tools + built-ins), without MCP or DynamoDB
    const defs: any[] = (agentModeService as any).toolRegistry.getAllTools().map((t: any) => t.definition);
    return defs.map((d) => ({ name: d.function.name as string, description: d.function.description as string, inputSchema: d.function.parameters }));
  }

  it('the OPEN set of a fresh chat (foundation tools + install_skills, as Emma starts one) fits with headroom: nothing cut or dropped', async () => {
    const all = await registryTools();
    const { allowedToolNames } = agentModeService.buildSkillContext([], ['*'], [], [], false);
    const open = all.filter((t) => allowedToolNames.has(t.name) || t.name === 'install_skills');
    const m = buildRelayManifest(open);
    const stats = { open: open.length, offered: m.tools.length, totalBytes: Buffer.byteLength(JSON.stringify(m.tools)), maxTools: TOOL_LIMITS.maxTools, maxTotalBytes: TOOL_LIMITS.maxTotalBytes, skipped: m.skipped, truncated: m.truncated };
    process.stdout.write(`relay manifest OPEN set stats ${JSON.stringify(stats)}\n`);
    expect(open.length).toBeGreaterThan(40); // the foundation set really loaded
    expect(open.some((t) => t.name === 'install_skills')).toBe(true);
    expect(m.skipped).toEqual({});
    expect(m.truncated).toBe(0);
    expect(m.tools.length).toBe(open.length);
    expect(manifestProblem(m.tools)).toBeUndefined();
    expect(m.tools.length).toBeLessThan(TOOL_LIMITS.maxTools / 2); // headroom
    expect(stats.totalBytes).toBeLessThan(TOOL_LIMITS.maxTotalBytes / 2);
  });

  it('the WHOLE registry (worst case: every skill installed in one turn) still fits the cumulative caps: nothing cut or dropped', async () => {
    const tools = await registryTools();
    const m = buildRelayManifest(tools);
    const stats = {
      registry: tools.length,
      offered: m.tools.length,
      skipped: m.skipped,
      truncatedDescriptions: m.truncated,
      maxTools: TOOL_LIMITS.maxTools,
      totalBytes: Buffer.byteLength(JSON.stringify(m.tools)),
      maxTotalBytes: TOOL_LIMITS.maxTotalBytes,
      longestDescription: Math.max(...tools.map((t) => Buffer.byteLength(t.description ?? ''))),
      largestSchema: Math.max(...tools.map((t) => Buffer.byteLength(JSON.stringify(t.inputSchema ?? {})))),
      longestName: Math.max(...tools.map((t) => t.name.length)),
    };
    process.stdout.write(`relay manifest registry stats ${JSON.stringify(stats)}\n`);
    expect(tools.length).toBeGreaterThan(50); // the registry really loaded
    expect(m.skipped).toEqual({});
    expect(m.truncated).toBe(0);
    expect(m.tools.length).toBe(tools.length);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });
});
