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

  // PENDING the host's limit raise (B1/B2, branch manan/eng-2113-relay-host): under today's TOOL_LIMITS the registry has 275 tools (cap 200) and 8 descriptions over
  // 4 KiB. Un-skip this when the host branch with the raised limits is merged in; it must then pass and stay green.
  it.skip('every registry tool (all skills) fits the relay limits: nothing truncated, nothing dropped', async () => {
    await (agentModeService as any).registerTools(); // the real registration path (Emma tools + built-ins), without MCP or DynamoDB
    // The whole registry: what a session with every skill ("*" access) can be offered.
    const defs: any[] = (agentModeService as any).toolRegistry.getAllTools().map((t: any) => t.definition);
    const tools = defs.map((d) => ({ name: d.function.name, description: d.function.description, inputSchema: d.function.parameters }));
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
    };
    // eslint-disable-next-line no-console
    process.stdout.write(`relay manifest registry stats ${JSON.stringify(stats)}\n`);
    expect(tools.length).toBeGreaterThan(50); // the registry really loaded
    expect(m.skipped).toEqual({});
    expect(m.truncated).toBe(0);
    expect(m.tools.length).toBe(tools.length);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });
});
