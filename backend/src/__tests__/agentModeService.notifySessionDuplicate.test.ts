import { AgentModeService } from '../services/agentModeService';

// ENG-1297: notify_session's execute() handler maps emailService's {sent:false,
// duplicate:true} guard result to an agent-visible {duplicate_suppressed:true}
// tool response instead of a plain send confirmation. That mapping (agentModeService.ts
// notify_session execute(), around the duplicate-suppression branch) had no direct
// test coverage — existing notify_session tests only check tool-registration/gating,
// and the emailService suite covers the service layer but not this tool-layer mapping.

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    }))
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: {
    update: jest.fn()
  }
}));

// `create` matters even though this suite never calls it: when SLACK_BOT_TOKEN is
// set in the environment, importing agentModeService constructs a Slack WebClient
// at module load, which calls axios.create(). Without it the suite fails to load.
jest.mock('axios', () => {
  const instance = {
    get: jest.fn(),
    post: jest.fn(),
    request: jest.fn(),
    defaults: { headers: { common: {}, post: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() }
    }
  };
  return {
    get: jest.fn(),
    post: jest.fn(),
    create: jest.fn(() => instance)
  };
});

jest.mock('../services/emailService', () => ({
  emailService: {
    sendSessionNotificationEmail: jest.fn(),
  },
}));

describe('AgentModeService - notify_session duplicate-suppression mapping (ENG-1297)', () => {
  let agentModeService: AgentModeService;
  let mockSendSessionNotificationEmail: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset static flag so foundation tools get re-registered on each test instance.
    (AgentModeService as any).toolsRegistered = false;

    agentModeService = new AgentModeService();
    await agentModeService.initialize();

    const { emailService } = require('../services/emailService');
    mockSendSessionNotificationEmail = emailService.sendSessionNotificationEmail;
  });

  it('maps a duplicate-suppressed send to {success:true, sent_to:[], duplicate_suppressed:true}', async () => {
    mockSendSessionNotificationEmail.mockResolvedValue({ sent: false, duplicate: true });

    const result = await (agentModeService as any).executeTool(
      'gpt-4',
      'notify_session',
      { to: ['r@example.com'], message: 'Report body' },
      'user123',
      'session123',
      false
    );

    expect(mockSendSessionNotificationEmail).toHaveBeenCalledWith(
      ['r@example.com'],
      'session123',
      'Report body',
      undefined
    );
    expect(result).toEqual({
      success: true,
      sent_to: [],
      duplicate_suppressed: true,
      message: expect.stringContaining('already sent earlier in this session'),
    });
  });

  it('maps a fresh send to {success:true, sent_to:<recipients>} with no duplicate_suppressed field', async () => {
    mockSendSessionNotificationEmail.mockResolvedValue({ sent: true, duplicate: false });

    const result = await (agentModeService as any).executeTool(
      'gpt-4',
      'notify_session',
      { to: ['r@example.com'], message: 'Report body' },
      'user123',
      'session123',
      false
    );

    expect(result).toEqual({
      success: true,
      sent_to: ['r@example.com'],
      message: 'Session notification email sent to: r@example.com',
    });
    expect(result.duplicate_suppressed).toBeUndefined();
  });
});
