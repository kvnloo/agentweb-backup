import { AgentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

// ENG-806: AW-Settings model getters validated with a raw `llmModels[value]`
// lookup and never consulted LEGACY_MODEL_ALIASES, while generation-time
// resolution (`normalizeModelId`) did. Any row holding a legacy alias therefore
// failed validation and silently fell through to the default — the setting read
// as configured but had no effect. `agent_mode_scheduled_chats_default_model`
// held the alias `claude-opus-4-8` and was inert for two months.

jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 'mock-url', Key: 'mock-key' }),
    }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
  __resetAgentModeAlertDedupeForTests: jest.fn(),
}));

jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: jest.fn().mockImplementation(() => ({ invoke: jest.fn() })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@langchain/core/messages', () => ({
  HumanMessage: jest.fn(),
  AIMessage: jest.fn(),
  SystemMessage: jest.fn(),
  ToolMessage: jest.fn(),
}));

const LEGACY_ALIAS = 'claude-opus-4-8';
const CANONICAL_FOR_ALIAS = 'anthropic.claude-opus-4-8';

/**
 * Every AW-Settings model getter that validates a configured id against the
 * `llmModels` registry, with the setting key it reads. AC3 requires all of them
 * to share one resolution path, so each is driven through the same assertions.
 */
const MODEL_GETTERS: Array<{
  name: string;
  settingName: string;
  call: (service: AgentModeService) => Promise<string | undefined>;
}> = [
  {
    name: 'getDefaultModel',
    settingName: 'agent_mode_default_model',
    call: (s) => s.getDefaultModel(),
  },
  {
    name: 'getReportsModel',
    settingName: 'agent_mode_reports_model',
    call: (s) => s.getReportsModel(),
  },
  {
    name: 'getDedupJudgeModel',
    settingName: 'agent_mode_dedup_judge_model',
    call: (s) => s.getDedupJudgeModel(),
  },
  {
    name: 'getScheduledChatsDefaultModel',
    settingName: 'agent_mode_scheduled_chats_default_model',
    call: (s) => s.getScheduledChatsDefaultModel(),
  },
  {
    name: 'getReportGenerationDefaultModel',
    settingName: 'agent_mode_report_generation_default_model',
    call: (s) => s.getReportGenerationDefaultModel(),
  },
  {
    name: 'getImageGenerationDefaultModel',
    settingName: 'agent_mode_image_generation_default_model',
    call: (s) => s.getImageGenerationDefaultModel(),
  },
];

describe('ENG-806: AW-Settings model getters resolve legacy aliases', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  });

  afterEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  // Guards the premise: the alias is genuinely absent from the registry, so a
  // raw lookup must miss it. If this ever fails the bug shape has changed.
  it('premise: the legacy alias is not a registry key but its canonical target is', () => {
    // `llmModels` is private; read it through an explicit cast because this
    // assertion exists precisely to pin the internal invariant the bug rests on.
    const registry = (service as unknown as { llmModels: Record<string, unknown> }).llmModels;

    expect(registry[LEGACY_ALIAS]).toBeUndefined();
    expect(registry[CANONICAL_FOR_ALIAS]).toBeDefined();
    expect(service.normalizeModelId(LEGACY_ALIAS)).toBe(CANONICAL_FOR_ALIAS);
  });

  // AC1 — validation and generation must apply the same alias map.
  it('AC1: an alias-valued row resolves to the same id normalizeModelId returns', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: LEGACY_ALIAS,
    });

    await expect(service.getScheduledChatsDefaultModel()).resolves.toBe(
      service.normalizeModelId(LEGACY_ALIAS)
    );
    await expect(service.getScheduledChatsDefaultModel()).resolves.toBe(CANONICAL_FOR_ALIAS);
  });

  it('AC1: surrounding whitespace on an alias row still resolves', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: `  ${LEGACY_ALIAS}  `,
    });

    await expect(service.getScheduledChatsDefaultModel()).resolves.toBe(CANONICAL_FOR_ALIAS);
  });

  // AC3 — one shared resolution path, so every getter behaves identically.
  describe('AC3: every model getter shares one resolution path', () => {
    it.each(MODEL_GETTERS)('$name resolves a legacy alias', async ({ call }) => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: LEGACY_ALIAS,
      });

      await expect(call(service)).resolves.toBe(CANONICAL_FOR_ALIAS);
    });
  });

  // AC2 — an unknown value must fail LOUDLY, not just console.warn.
  describe('AC2: an unknown model value falls back loudly', () => {
    it('still falls back to the default model', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'totally-not-a-model',
      });

      await expect(service.getDefaultModel()).resolves.toBe(service.default_model);
    });

    it('surfaces an oncall alert naming the setting and the bad value', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'totally-not-a-model',
      });

      await service.getDefaultModel();

      expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
      const params = (sendAgentModeOncallAlert as jest.Mock).mock.calls[0][0];
      expect(JSON.stringify(params)).toContain('totally-not-a-model');
      expect(JSON.stringify(params)).toContain('agent_mode_default_model');
      // Deduped so a permanently-misconfigured row cannot flood oncall (WS-B5).
      expect(params.dedupeKey).toBeTruthy();
    });

    it('does not alert when the configured value is valid', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: CANONICAL_FOR_ALIAS,
      });

      await service.getDefaultModel();

      expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
    });

    it('does not alert when no value is configured at all', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      await expect(service.getDefaultModel()).resolves.toBe(service.default_model);
      expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
    });
  });

  // AC4 — characterization: canonical rows and the absent/error paths are unchanged.
  describe('AC4: existing behaviour for canonical and empty rows is unchanged', () => {
    it.each(MODEL_GETTERS)('$name returns a canonical id verbatim', async ({ call }) => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: CANONICAL_FOR_ALIAS,
      });

      await expect(call(service)).resolves.toBe(CANONICAL_FOR_ALIAS);
    });

    it('falls back to the default model when the setting is missing', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      await expect(service.getDefaultModel()).resolves.toBe(service.default_model);
    });

    it('falls back to the default model when the settings read throws', async () => {
      (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('dynamo down'));

      await expect(service.getDefaultModel()).resolves.toBe(service.default_model);
    });

    it('falls back to the default model when the row is blank', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({ settingValue: '   ' });

      await expect(service.getDefaultModel()).resolves.toBe(service.default_model);
    });
  });
});
