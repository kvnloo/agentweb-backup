/**
 * ENG-1222: a session with skills installed (session.associatedSkills) must
 * always get its skill tools bound to the LLM call, regardless of which
 * portalType the request happened to arrive under. Before this fix,
 * generateChatResponse only resolved session skills into tool definitions
 * when portalType was 'customer'/'emma-sidebar' or the caller was a
 * delegated admin — a session reached via any other route (e.g. the
 * partner-portal's global chat widget, whose socket.emit('message') omits
 * `portal` and lands the request on the 'partner' default) got ZERO tools
 * bound. With no `tools` key sent to the model at all, it cannot call the
 * skill's tools and either denies having the capability or fabricates a
 * result in prose — this is the P0 bug in production sessions
 * bb89e75d-20da-4d44-879c-3b59c648bf22 and 0e5792fd-4982-4547-acf1-0a1c738cca59.
 *
 * generateChatResponse now resolves "which tools + skill-context text does
 * this session get" through agentModeService.buildSkillContext — the same
 * function agent-mode's own real pipeline uses — instead of a second,
 * independently hand-rolled copy of that policy. These tests mock
 * buildSkillContext directly: its own internal behavior (subscription-tier
 * skill gating, FOUNDATION_TOOLS unioning, __other_skills__, admin tools) is
 * agent-mode's to test; this file only verifies chatbotService wires the call
 * correctly and uses its result correctly.
 */

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const putPromiseMock = jest.fn().mockResolvedValue({});
const updatePromiseMock = jest.fn().mockResolvedValue({});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: jest.fn(() => ({ promise: putPromiseMock })),
      update: jest.fn(() => ({ promise: updatePromiseMock })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({ Location: 'https://s3.example.com/file.jpg' }),
  })),
  config: { update: jest.fn() },
}));

const mockCallLLM = jest.fn();
const mockGetDefaultModel = jest.fn().mockResolvedValue('gpt-5.4');
const mockExecuteTool = jest.fn().mockResolvedValue({ success: true });
const mockInitialize = jest.fn().mockResolvedValue(undefined);
const mockBuildSkillContext = jest.fn();
const mockAgentModeService = {
  callLLM: mockCallLLM,
  getDefaultModel: mockGetDefaultModel,
  executeTool: mockExecuteTool,
  initialize: mockInitialize,
  buildSkillContext: (...args: any[]) => mockBuildSkillContext(...args),
};

jest.mock('../services/agentModeService', () => {
  const AgentModeService = jest.fn().mockImplementation(() => mockAgentModeService);
  Object.assign(AgentModeService, {
    FOUNDATION_TOOLS: ['send_notification'],
    buildWorkPlanContextMessages: jest.fn().mockReturnValue([]),
  });
  return { AgentModeService, agentModeService: mockAgentModeService };
});

const mockGetAllowedSkills = jest.fn().mockResolvedValue(['*']);
const mockGetPublicAllowedSkills = jest.fn().mockResolvedValue([]);
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: (...args: any[]) => mockGetAllowedSkills(...args),
  getPublicAllowedSkills: (...args: any[]) => mockGetPublicAllowedSkills(...args),
}));

const mockGetSkillsByIds = jest.fn().mockResolvedValue([]);
const mockGetPublishedSkills = jest.fn().mockResolvedValue([]);
jest.mock('../services/skillService', () => ({
  skillService: {
    getSkillsByIds: (...args: any[]) => mockGetSkillsByIds(...args),
    getPublishedSkills: (...args: any[]) => mockGetPublishedSkills(...args),
  },
}));

const GOOGLE_ADS_TOOL = {
  definition: {
    name: 'list_connected_accounts',
    description: 'List connected ad accounts',
    inputSchema: { type: 'object', properties: {} },
  },
};

const NOTIFICATION_TOOL = {
  definition: {
    name: 'send_notification',
    description: 'Send a notification',
    inputSchema: { type: 'object', properties: {} },
  },
};

// A customer-context-only default tool (added by generateChatResponse for
// portalType 'customer'/'emma-sidebar' regardless of the installed skill) —
// used to prove the hard gate discriminates skill tools from this bucket.
const PAGE_SOURCE_TOOL = {
  definition: {
    name: 'read_page_source',
    description: 'Read the current page source',
    inputSchema: { type: 'object', properties: {} },
  },
};

jest.mock('../mcp/server/registry', () => ({
  mcpToolRegistry: {
    getTool: (name: string) => {
      if (name === 'list_connected_accounts') return GOOGLE_ADS_TOOL;
      if (name === 'send_notification') return NOTIFICATION_TOOL;
      if (name === 'read_page_source') return PAGE_SOURCE_TOOL;
      return undefined;
    },
    getToolNames: () => ['list_connected_accounts', 'send_notification', 'read_page_source'],
  },
}));

jest.mock('../emma/registry', () => ({
  emmaToolRegistry: {
    getTool: () => undefined,
    getToolNames: () => [],
  },
}));

jest.mock('../emma/tools', () => ({}));
jest.mock('../emma/tempEmailTools', () => ({}));
jest.mock('../emma/testAccountTools', () => ({}));
jest.mock('../emma/localAgentTools', () => ({}));

jest.mock('openai', () => jest.fn());
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: false }),
}));

import { generateChatResponse, __resetEmmaSystemContextCache, chatbotDb } from '../services/chatbotService';

function makeCompletion(content = 'Hello') {
  return {
    id: 'completion-1',
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'anthropic.claude-opus-5',
  };
}

function makeToolCallCompletion(toolName: string, args: object = {}) {
  return {
    id: 'completion-tool',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'anthropic.claude-opus-5',
  };
}

function seedSession(overrides: Record<string, any> = {}) {
  getPromiseMock.mockResolvedValue({
    Item: {
      sessionId: 'sess-1',
      userId: 'user-1',
      portalType: 'agent',
      messages: [{ role: 'user', content: 'Run list_connected_accounts' }],
      pageIdentifier: 'skill-google-ads-discovery',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    },
  });
  queryPromiseMock.mockResolvedValue({ Items: [] });
}

// Reset shared mocks before every test in this file. clearAllMocks() resets
// call history but NOT a mock's queued mockResolvedValueOnce() chain or its
// mockReturnValue/mockResolvedValue default — a prior test that queued more
// once-values than it consumed, or set a default another test doesn't expect,
// would otherwise leak into the next test's first call. mockReset() clears both.
function resetSharedMocks() {
  jest.clearAllMocks();
  mockCallLLM.mockReset();
  mockBuildSkillContext.mockReset();
  __resetEmmaSystemContextCache();
  putPromiseMock.mockResolvedValue({});
  updatePromiseMock.mockResolvedValue({});
  mockGetDefaultModel.mockResolvedValue('gpt-5.4');
  mockGetAllowedSkills.mockResolvedValue(['*']);
  mockGetPublicAllowedSkills.mockResolvedValue([]);
  mockGetSkillsByIds.mockResolvedValue([]);
  mockGetPublishedSkills.mockResolvedValue([]);
  mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(), installedSkillContextMsg: '' });
}

describe('generateChatResponse — skill-session tool binding (ENG-1222)', () => {
  beforeEach(() => {
    resetSharedMocks();
    mockCallLLM.mockResolvedValue(makeCompletion());
  });

  it('binds the session skill tools even when portalType is "partner" and the caller is not an admin', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });

    await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'list_connected_accounts' }) }),
        ]),
      }),
    );
  });

  it('omits tools for a "partner" session with no installed skills, not delegated-admin (no regression)', async () => {
    seedSession({ associatedSkills: [] });

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockBuildSkillContext).not.toHaveBeenCalled();
    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.not.objectContaining({ tools: expect.anything() }),
    );
  });

  it('still binds skill tools on the "customer" portal (existing behavior preserved)', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });

    await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'list_connected_accounts' }) }),
        ]),
      }),
    );
  });

  it('still binds admin tools for a delegated admin with no installed skills (existing behavior preserved)', async () => {
    seedSession({ associatedSkills: [] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['send_notification']), installedSkillContextMsg: '' });

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
      isDelegatedAdmin: true,
    });

    // No installed skills → the subscription/published-skills lookups are skipped
    // entirely (buildSkillContext never consults them for a skill-less session).
    expect(mockBuildSkillContext).toHaveBeenCalledWith([], [], [], [], true);
    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'send_notification' }) }),
        ]),
      }),
    );
  });

  it('resolves skill/admin tool access through buildSkillContext with the correct session context', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    const googleAdsSkill = { skillId: 'google-ads-skill', name: 'Google Ads', description: '', toolNames: ['list_connected_accounts'] };
    mockGetSkillsByIds.mockResolvedValue([googleAdsSkill]);
    mockGetPublishedSkills.mockResolvedValue([googleAdsSkill]);
    mockGetAllowedSkills.mockResolvedValue(['google-ads-skill']);
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });

    await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockGetSkillsByIds).toHaveBeenCalledWith(['google-ads-skill']);
    expect(mockGetAllowedSkills).toHaveBeenCalledWith('user-1');
    expect(mockBuildSkillContext).toHaveBeenCalledWith(
      [googleAdsSkill],
      ['google-ads-skill'],
      [googleAdsSkill],
      ['google-ads-skill'],
      false,
    );
  });
});

describe('generateChatResponse — ENG-1222 attribution stamp + fabrication guard', () => {
  beforeEach(() => {
    resetSharedMocks();
  });

  it('stamps .llm on the persisted assistant message so telemetry can attribute the turn', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion('Hi there!'));
    const addMessageSpy = jest.spyOn(chatbotDb, 'addMessageToSession');

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(addMessageSpy).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ role: 'assistant', llm: 'anthropic.claude-opus-5' }),
    );
  });

  it('blocks a zero-tool-call response that claims to present actual/real tool-derived data', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion(
      'Here are the actual returned rows: Acme Widgets Main, customer ID 123-456-7890.'
    ));
    const addMessageSpy = jest.spyOn(chatbotDb, 'addMessageToSession');

    const response = await generateChatResponse('sess-1', 'Report the ACTUAL returned rows', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).not.toMatch(/Acme Widgets Main/);
    expect(addMessageSpy).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        role: 'assistant',
        content: expect.not.stringContaining('Acme Widgets Main'),
      }),
    );
  });

  it('does not block a normal zero-tool-call reply that makes no real-data claim', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion('Sure, I can help with that — what would you like to do?'));

    const response = await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).toBe('Sure, I can help with that — what would you like to do?');
  });

  it('does not block a response that reports real data after actually calling a tool', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });
    mockExecuteTool.mockResolvedValue({ accounts: [{ name: 'Real Customer LLC', id: '999' }] });
    mockCallLLM
      .mockResolvedValueOnce(makeToolCallCompletion('list_connected_accounts'))
      .mockResolvedValueOnce(makeCompletion('Here are the actual returned rows: Real Customer LLC, ID 999.'));

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    const content = typeof response === 'string' ? response : response.content;
    expect(content).toContain('Real Customer LLC');
  });

  it('still blocks fabrication when the only tool call returned a serialized {success:false} string', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });
    // A string result with success:false must count as a failed call, not a
    // successful one — otherwise `.success` on the (unparsed) string is
    // undefined, `!== false` is trivially true, and the guard never fires.
    mockExecuteTool.mockResolvedValue(JSON.stringify({ success: false, error: 'account not connected' }));
    mockCallLLM
      .mockResolvedValueOnce(makeToolCallCompletion('list_connected_accounts'))
      .mockResolvedValueOnce(makeCompletion('Here are the actual returned rows: Acme Widgets Main, ID 123-456-7890.'));

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    const content = typeof response === 'string' ? response : response.content;
    expect(content).not.toMatch(/Acme Widgets Main/);
  });
});

describe('generateChatResponse — ENG-1222 hard gate, retry, and skill-prompt injection', () => {
  beforeEach(() => {
    resetSharedMocks();
  });

  it('hard-fails a skill session that resolves to zero tools instead of letting the model answer toolless', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    // buildSkillContext resolving to nothing (e.g. an unregistered tool name, or a
    // skill with no toolNames declared) is the anomaly this gate exists to catch.
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(), installedSkillContextMsg: '' });

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(response).toMatch(/wasn't able to load the tools/i);
  });

  it('retries once when the user names an available tool but the model makes zero tool calls', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });
    mockExecuteTool.mockResolvedValue({ accounts: [{ name: 'Real Customer LLC', id: '999' }] });
    mockCallLLM
      .mockResolvedValueOnce(makeCompletion("I don't have the capability to run tools."))
      .mockResolvedValueOnce(makeToolCallCompletion('list_connected_accounts'))
      .mockResolvedValueOnce(makeCompletion('Here are the actual returned rows: Real Customer LLC, ID 999.'));

    const response = await generateChatResponse('sess-1', 'Call list_connected_accounts for google_ads', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(3);
    expect(mockExecuteTool).toHaveBeenCalledWith(
      'anthropic.claude-opus-5', 'list_connected_accounts', expect.anything(), 'user-1', 'sess-1', false, undefined,
    );
    const content = typeof response === 'string' ? response : response.content;
    expect(content).toContain('Real Customer LLC');
  });

  it('does not retry a normal toolless reply when the user never named an available tool', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });
    mockCallLLM.mockResolvedValue(makeCompletion('Sure, what would you like to do?'));

    await generateChatResponse('sess-1', 'Hello there', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it("injects buildSkillContext's installedSkillContextMsg even on the non-customer portal", async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({
      allowedToolNames: new Set(['list_connected_accounts']),
      installedSkillContextMsg: 'Installed Skills:\ngoogle-ads-skill- Google Ads: Pre-flight health checks. You are running the Google Ads Pre-Flight Health Gate skill.',
    });
    mockCallLLM.mockResolvedValue(makeCompletion('ok'));

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: expect.stringContaining('Pre-Flight Health Gate') }),
      ]),
      expect.anything(),
    );
  });
});

describe('generateChatResponse — ENG-1222 risk-hardening: perf, anonymous users, subscription messaging, false positives', () => {
  beforeEach(() => {
    resetSharedMocks();
  });

  it('skips the subscription/published-skills lookups entirely for a skill-less session', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion('ok'));

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockGetSkillsByIds).not.toHaveBeenCalled();
    expect(mockGetPublishedSkills).not.toHaveBeenCalled();
    expect(mockGetAllowedSkills).not.toHaveBeenCalled();
  });

  it('routes an anonymous (no userId) skill session through getPublicAllowedSkills instead of throwing into zero tools', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    const googleAdsSkill = { skillId: 'google-ads-skill', name: 'Google Ads', description: '', toolNames: ['list_connected_accounts'] };
    mockGetSkillsByIds.mockResolvedValue([googleAdsSkill]);
    mockGetPublishedSkills.mockResolvedValue([googleAdsSkill]);
    mockGetPublicAllowedSkills.mockResolvedValue(['google-ads-skill']);
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });
    mockCallLLM.mockResolvedValue(makeCompletion('ok'));

    await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      // no userId
      model: 'anthropic.claude-opus-5',
    });

    expect(mockGetAllowedSkills).not.toHaveBeenCalled();
    expect(mockGetPublicAllowedSkills).toHaveBeenCalled();
    expect(mockBuildSkillContext).toHaveBeenCalledWith(
      [googleAdsSkill], ['google-ads-skill'], [googleAdsSkill], ['google-ads-skill'], false,
    );
  });

  it('gives an accurate plan-upgrade message (not a generic error) when the hard gate fires due to subscription gating', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockGetAllowedSkills.mockResolvedValue(['some-other-skill']); // does not include google-ads-skill, and not '*'
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(), installedSkillContextMsg: '' });

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(response).toMatch(/current plan/i);
    expect(response).not.toMatch(/configuration issue/i);
  });

  it('still gives the generic configuration-issue message when the hard gate fires for a genuine resolution failure', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockGetAllowedSkills.mockResolvedValue(['*']); // wildcard: not a subscription restriction
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(), installedSkillContextMsg: '' });

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).toMatch(/configuration issue/i);
    expect(response).not.toMatch(/current plan/i);
  });

  it('still fires the hard gate when unrelated customer/page tools resolve but the skill itself contributed zero tools', async () => {
    // CodeRabbit (ENG-1222 review): toolDefinitions also carries customer/page
    // defaults (e.g. read_page_source), so a nonzero toolDefinitions.length
    // doesn't prove the *skill's* tools bound. A customer-portal session with
    // an installed skill that fails to resolve any tool must still trip the
    // gate, even though the page default resolves fine.
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockGetAllowedSkills.mockResolvedValue(['*']);
    // allowedToolNames names a tool that isn't registered anywhere — the exact
    // "unregistered tool name" failure mode the gate exists to catch — while
    // read_page_source (a customer-context default, unrelated to this skill)
    // resolves to a real definition via the mocked registry.
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['unregistered_skill_tool']), installedSkillContextMsg: '' });

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(response).toMatch(/configuration issue/i);
  });

  it('does not misreport a buildSkillContext crash as subscription gating', async () => {
    // CodeRabbit (ENG-1222 review): skillAllowlistResolved was set to true
    // right before calling buildSkillContext, not after it succeeded — so a
    // throw from buildSkillContext itself (not the allowlist fetch) still left
    // the flag true, and the gate could then blame "your plan doesn't include
    // this" for what was actually a code bug.
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockGetAllowedSkills.mockResolvedValue(['some-other-skill']); // would look "denied" if misclassified
    mockBuildSkillContext.mockImplementation(() => { throw new Error('boom'); });

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).toMatch(/configuration issue/i);
    expect(response).not.toMatch(/current plan/i);
  });

  it('gives the generic configuration-issue message, not a plan-restriction message, when the allowlist lookup itself fails', async () => {
    // CodeRabbit (ENG-1222 review): a rejected Promise.all left
    // userAllowedSkillIdsForGate at its [] default, which the gate's own
    // .every() over a non-empty sessionSkillIds misread as "every skill denied
    // by the plan" — telling a paying customer their subscription doesn't cover
    // a skill when their subscription was never actually checked.
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockGetSkillsByIds.mockRejectedValue(new Error('transient DynamoDB error'));
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(), installedSkillContextMsg: '' });

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).toMatch(/configuration issue/i);
    expect(response).not.toMatch(/current plan/i);
  });

  it('does not block an honest zero-tool reply that merely mentions "actual account" in an innocent context', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion(
      "I can help with that — based on your actual account settings, I'd recommend adjusting your notification preferences."
    ));

    const response = await generateChatResponse('sess-1', 'How do I manage notifications?', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).toContain('actual account settings');
  });

  it('still blocks the real fabrication pattern (claim + ID-shaped data)', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion(
      'Here are the actual returned rows: Acme Widgets Main, customer ID 123-456-7890.'
    ));

    const response = await generateChatResponse('sess-1', 'Report the ACTUAL returned rows', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).not.toMatch(/Acme Widgets Main/);
  });

  it('does not block an honest refusal that names real-data phrasing plus a bulleted list', async () => {
    // CodeRabbit (ENG-1222 review): an honest denial like this satisfies both
    // CLAIMS_REAL_TOOL_OUTPUT ("actual data") and LOOKS_LIKE_TOOL_SHAPED_DATA
    // (the bullet list) without the negation exclusion.
    seedSession({ associatedSkills: [] });
    const honestRefusal = "I can't reach your actual data right now, but here's how to check it yourself:\n- Open your dashboard\n- Go to Settings";
    mockCallLLM.mockResolvedValue(makeCompletion(honestRefusal));

    const response = await generateChatResponse('sess-1', 'What are my actual settings?', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).toBe(honestRefusal);
  });

  it('still blocks fabrication that happens to contain an unrelated negation earlier in the sentence', async () => {
    // The negation exclusion must not become a general bypass — a "don't know
    // why" preamble unrelated to capability denial must not exempt a genuine
    // fabrication claim from the guard.
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion(
      "I don't know why, but here are the actual returned rows: Acme Widgets Main, customer ID 123-456-7890."
    ));

    const response = await generateChatResponse('sess-1', 'Report the ACTUAL returned rows', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).not.toMatch(/Acme Widgets Main/);
  });

  it('does not retry when the user asks a meta-question about a tool instead of requesting it', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });
    mockCallLLM.mockResolvedValue(makeCompletion('list_connected_accounts lists any social or ad accounts you have connected.'));

    await generateChatResponse('sess-1', 'What does list_connected_accounts do?', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('still retries a genuine request that happens to name the tool directly', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockBuildSkillContext.mockReturnValue({ allowedToolNames: new Set(['list_connected_accounts']), installedSkillContextMsg: '' });
    mockExecuteTool.mockResolvedValue({ accounts: [{ name: 'Real Customer LLC', id: '999' }] });
    mockCallLLM
      .mockResolvedValueOnce(makeCompletion("I don't have the capability to run tools."))
      .mockResolvedValueOnce(makeToolCallCompletion('list_connected_accounts'))
      .mockResolvedValueOnce(makeCompletion('Here are the actual returned rows: Real Customer LLC, ID 999.'));

    await generateChatResponse('sess-1', 'Call list_connected_accounts for google_ads now.', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(3);
  });
});
