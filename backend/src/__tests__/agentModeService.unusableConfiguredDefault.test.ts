/**
 * The admin setting `agent_mode_default_model` must be usable by the acting
 * (non-admin) user. A configured id that the picker would not offer
 * (internalOnly / adminOnly / live) used to be returned verbatim, so a turn with
 * no stored/request model made the usage policy throw "system default model is
 * not supported". getDefaultModel now falls back to the code constant.
 */
import { AgentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';

jest.mock('../services/db', () => ({
  getSession: jest.fn(), saveMessage: jest.fn(), updateSession: jest.fn(),
  getTask: jest.fn(), getTaskExecution: jest.fn(), getUserById: jest.fn(),
}));
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn().mockImplementation(() => ({
    get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(), scan: jest.fn(), query: jest.fn(),
  })) },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('getDefaultModel: configured default must be selectable', () => {
  let service: AgentModeService;
  let registry: Record<string, any>;
  let warn: jest.SpyInstance;

  const pick = (pred: (c: any) => boolean) =>
    Object.keys(registry).find((id) => pred(registry[id]));
  const configure = (v: string) =>
    (settingsService.getSetting as jest.Mock).mockResolvedValue({ settingValue: v });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    registry = (service as any).llmModels;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const cases: Array<[string, (c: any) => boolean]> = [
    ['internalOnly', (c) => c.internalOnly === true],
    ['adminOnly', (c) => c.adminOnly === true && !c.internalOnly && !c.isLive],
    ['live', (c) => c.isLive === true && !c.internalOnly],
  ];

  it.each(cases)('falls back to the code constant for a %s configured default', async (_n, pred) => {
    const id = pick(pred);
    expect(id).toBeDefined();
    configure(id as string);
    const result = await service.getDefaultModel();
    expect(result).toBe(service.default_model);
    // and the policy's supported set (non-admin picker) contains it
    expect(await service.getSupportedModels(false)).toContain(result);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(id as string));
  });

  it('warns once per process per bad value', async () => {
    const ids = Object.keys(registry).filter((k) => registry[k].internalOnly === true);
    const id = ids[ids.length - 1];
    configure(id);
    await service.getDefaultModel();
    await service.getDefaultModel();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(id))).toHaveLength(1);
  });

  it('keeps a valid configured default unchanged', async () => {
    const id = pick((c) => !c.internalOnly && !c.adminOnly && !c.isLive) as string;
    configure(id);
    expect(await service.getDefaultModel()).toBe(id);
  });
});
