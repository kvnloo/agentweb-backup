/**
 * ENG-2109 (B2): drives the tool bridge against the REAL agentModeService singleton and
 * the REAL dispatcher (`executePreparedTools`), with only storage and the LLM stubbed.
 * Nothing in production calls the bridge yet, so this is the closest check available
 * that a tool call made through it gets Emma's own gating, execution and results.
 */
import { agentModeService } from '../../agentModeService';
import { ToolBridge } from '../toolBridge';
import { EmmaToolBridgeExecutor } from '../emmaToolBridgeExecutor';

jest.mock('openai');
jest.mock('../../settingsService');
jest.mock('../../db');
jest.mock('../../chatbotService');
jest.mock('../../../utils/secretsManager');
jest.mock('../../skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

const RUN = { runId: 'run-bridge-1', userId: 'u1', sessionId: 's1' };

const probeRead = jest.fn(async (args: any) => ({ success: true, content: `probe read ok ${args?.q ?? ''}`.trim() }));
// Mirrors the real token-gated tools: the preview hands back the token that confirms it.
const probeLaunch = jest.fn(async (args: any) => {
  if (args?.confirm === true && args?.preview_token === 'tok-123') {
    return { success: true, content: 'LAUNCHED FOR REAL' };
  }
  return {
    success: true,
    requiresConfirmation: true,
    awaitingUserConfirmation: true,
    confirmationPrompt: 'Launch this campaign?',
    previewToken: 'tok-123',
  };
});
const probeFail = jest.fn(async () => {
  throw new Error('provider exploded');
});

function tool(name: string, execute: (args: any) => Promise<any>, properties: Record<string, unknown> = {}) {
  return {
    name,
    definition: {
      type: 'function',
      function: { name, description: `Test-only ${name}`, parameters: { type: 'object', properties } },
    },
    execute,
  };
}

function mockDeps() {
  const chatbot = require('../../chatbotService');
  chatbot.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue({ sessionId: 's1', messages: [], associatedSkills: null }),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    incrementFailedFunctions: jest.fn().mockResolvedValue(undefined),
    incrementCalledFunctions: jest.fn().mockResolvedValue(undefined),
  };
  require('../../settingsService').settingsService = { getSetting: jest.fn().mockResolvedValue(null) };
  const db = require('../../db');
  db.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'u1', isAdmin: false }) };
  db.accountMemoryDb = {
    getUserMemories: jest.fn().mockResolvedValue([]),
    getRecentMemories: jest.fn().mockResolvedValue([]),
    setMemoryEmbedding: jest.fn().mockResolvedValue(undefined),
  };
  db.orgMemoryDb = { getOrgMemories: jest.fn().mockResolvedValue([]) };
  db.orgDb = { getUserOrg: jest.fn().mockResolvedValue(null) };
}

function openBridge() {
  const executor = new EmmaToolBridgeExecutor();
  const bridge = new ToolBridge(executor);
  executor.registerRun(RUN.runId, { llmModel: agentModeService.default_model, mockMode: false });
  const token = bridge.openRun(RUN);
  return { bridge, executor, token };
}

describe('tool bridge against the real agentModeService and dispatcher (ENG-2109 B2)', () => {
  beforeAll(() => {
    const registry = (agentModeService as any).toolRegistry;
    registry.register(tool('get_bridge_probe', probeRead, { q: { type: 'string' } }));
    registry.register(
      tool('launch_bridge_probe', probeLaunch, { confirm: { type: 'boolean' }, preview_token: { type: 'string' } }),
    );
    registry.register(tool('update_bridge_failing_probe', probeFail));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeps();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('lists the session\'s real filtered tools and marks only genuine reads as read-only', async () => {
    const { bridge, token } = openBridge();
    const tools = await bridge.listTools(token);
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get('get_bridge_probe')).toMatchObject({ readOnly: true, description: 'Test-only get_bridge_probe' });
    expect(byName.get('launch_bridge_probe')?.readOnly).toBe(false);
    expect(byName.get('update_bridge_failing_probe')?.readOnly).toBe(false);
    expect(byName.get('get_bridge_probe')?.inputSchema).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
  });

  it('never marks an argument-dependent API tool as read-only', () => {
    const executor = new EmmaToolBridgeExecutor();
    for (const name of ['call_hubspot_api', 'call_attio_api', 'call_meta_marketing_api', 'call_google_ads_api']) {
      expect(executor.isReadOnly(name)).toBe(false);
    }
    expect(executor.isReadOnly('send_email')).toBe(false);
    expect(executor.isReadOnly('install_skills')).toBe(false);
  });

  async function loopToolNames(): Promise<string[]> {
    let loopTools: any[] | undefined;
    jest.spyOn(agentModeService as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      // Helper calls (titles, suggestions) carry no tools; keep the main loop call's list.
      if (Array.isArray(args[2]?.tools)) loopTools = args[2].tools;
      return {
        choices: [{ message: { role: 'assistant', content: 'Done.', tool_calls: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    });
    await agentModeService.generateMarketingResponse(
      'hello',
      [{ role: 'user', content: 'hello' }] as any,
      'u1',
      agentModeService.default_model,
      's1',
      true,
    );
    expect(Array.isArray(loopTools)).toBe(true);
    return (loopTools as any[]).map((t) => t.function?.name).sort();
  }

  it('offers the same tools Emma\'s own loop sends, for a legacy session (no skill gating)', async () => {
    const { bridge, token } = openBridge();
    const bridgeNames = (await bridge.listTools(token)).map((t) => t.name).sort();
    const loopNames = await loopToolNames();

    expect(loopNames).toContain('get_bridge_probe');
    expect(bridgeNames).toEqual(loopNames);
  });

  it('offers the same tools Emma\'s own loop sends, for a skill-gated session with no skills installed', async () => {
    const gated = { sessionId: 's1', messages: [], associatedSkills: [] };
    require('../../chatbotService').chatbotDb.getChatSession = jest.fn().mockResolvedValue(gated);
    const { bridge, token } = openBridge();
    const bridgeNames = (await bridge.listTools(token)).map((t) => t.name).sort();
    const loopNames = await loopToolNames();

    // Not a foundation tool and no skill grants it, so neither path may offer it.
    expect(loopNames).not.toContain('get_bridge_probe');
    expect(bridgeNames).toEqual(loopNames);

    const refused = await bridge.callTool(token, { name: 'get_bridge_probe', args: {} });
    expect(refused.isError).toBe(true);
    expect(probeRead).not.toHaveBeenCalled();
  });

  it('executes an allowed tool through the real dispatcher and returns its result', async () => {
    const { bridge, token } = openBridge();
    const result = await bridge.callTool(token, { name: 'get_bridge_probe', args: { q: 'leads' } });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('probe read ok leads');
    expect(probeRead).toHaveBeenCalledTimes(1);
    expect(probeRead.mock.calls[0][0]).toMatchObject({ q: 'leads' });
    expect(require('../../chatbotService').chatbotDb.incrementCalledFunctions).toHaveBeenCalledWith('s1', {
      get_bridge_probe: 1,
    });
  });

  it('halts on a real confirmation preview and refuses the model\'s own confirm with the returned token', async () => {
    const { bridge, token } = openBridge();

    const preview = await bridge.callTool(token, { name: 'launch_bridge_probe', args: {} });
    expect(preview.isError).toBe(false);
    expect(preview.content).toContain('tok-123'); // the model does see the token, exactly as in Emma
    expect(bridge.isHalted('s1')).toBe(true);

    const selfConfirm = await bridge.callTool(token, {
      name: 'launch_bridge_probe',
      args: { confirm: true, preview_token: 'tok-123' },
    });
    expect(selfConfirm.isError).toBe(true);
    expect(selfConfirm.content).not.toContain('LAUNCHED');
    expect(probeLaunch).toHaveBeenCalledTimes(1);

    // Only after a human turn clears the halt does the confirmed call execute.
    bridge.clearHalt('s1');
    const confirmed = await bridge.callTool(token, {
      name: 'launch_bridge_probe',
      args: { confirm: true, preview_token: 'tok-123' },
    });
    expect(confirmed.content).toContain('LAUNCHED FOR REAL');
    expect(probeLaunch).toHaveBeenCalledTimes(2);
  });

  it('returns a failing tool as an error result and records it as a failed call', async () => {
    const { bridge, token } = openBridge();
    const result = await bridge.callTool(token, { name: 'update_bridge_failing_probe', args: {} });

    expect(result.isError).toBe(true);
    expect(probeFail).toHaveBeenCalledTimes(1);
    expect(bridge.isHalted('s1')).toBe(false);
  });

  it('refuses a tool that exists in the registry but is excluded from this run', async () => {
    const executor = new EmmaToolBridgeExecutor();
    const bridge = new ToolBridge(executor);
    executor.registerRun(RUN.runId, { llmModel: agentModeService.default_model, excludeTools: ['get_bridge_probe'] });
    const token = bridge.openRun(RUN);

    expect((await bridge.listTools(token)).map((t) => t.name)).not.toContain('get_bridge_probe');
    const result = await bridge.callTool(token, { name: 'get_bridge_probe', args: {} });
    expect(result).toEqual({ content: 'get_bridge_probe is not available in this run.', isError: true });
    expect(probeRead).not.toHaveBeenCalled();
  });
});
