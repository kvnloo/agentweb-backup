/**
 * ENG-1907 — a sandbox (eval_) principal's agent-mode runs must not produce
 * reliability-telemetry rows. `agentReliabilitySnapshotCron` aggregates every
 * `loopId='agent-mode'` event with no per-user filter into the
 * failedRunRate/degradedRunRate the autonomous closure gate reads, so a
 * take-home candidate deliberately breaking Emma would skew production
 * reliability numbers. The recorder is bypassed at the source, keyed on the
 * identity stamped at run start — never on a caller-supplied flag.
 */

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

const fakeRecorder = {
  runStarted: jest.fn(),
  runCompleted: jest.fn(),
  runFailed: jest.fn(),
  decision: jest.fn(),
  toolInvoked: jest.fn(),
  toolSucceeded: jest.fn(),
  toolFailed: jest.fn(),
  toolDeferred: jest.fn(),
  toolPartialFailure: jest.fn(),
  claimCheckError: jest.fn(),
  flush: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../loops/instances/agent-mode', () => ({
  getAgentRunRecorder: () => fakeRecorder,
}));

import {
  recordAgentModeRunStarted,
  recordAgentModeToolTelemetry,
  recordAgentModeRunCompleted,
  recordAgentModeRunFailed,
  recordAgentModeClaimCheckError,
  __resetSandboxTelemetryRunsForTests,
} from '../services/agentModeService';

const EVAL_USER = 'eval_1d1d1d1d-0000-4000-8000-000000000000';
const REAL_USER = 'customer-1';

const toolResults = [
  { status: 'success' as const, toolCall: { function: { name: 'list_meta_ads_campaigns' } }, result: { success: true }, duration: 12 },
  { status: 'error' as const, toolCall: { function: { name: 'call_meta_marketing_api' } }, error: new Error('nope'), duration: 3 },
];

const recorderCallCount = () =>
  Object.values(fakeRecorder).reduce((n, fn) => n + ((fn as jest.Mock).mock?.calls.length ?? 0), 0) -
  (fakeRecorder.flush as jest.Mock).mock.calls.length;

describe('ENG-1907: sandbox runs write no reliability telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetSandboxTelemetryRunsForTests();
  });

  it('a sandbox run records nothing across its whole lifecycle', () => {
    const runId = 'sbx-session:run:abc';

    recordAgentModeRunStarted(runId, { llmModel: 'm', userId: EVAL_USER, sessionId: 'sbx-session', sessionType: 'regular' });
    recordAgentModeToolTelemetry(runId, 'sbx-session', 1, toolResults as any, undefined, EVAL_USER);
    recordAgentModeClaimCheckError(runId, 'sbx-session', new Error('judge down'));
    recordAgentModeRunCompleted(runId, { llmModel: 'm', toolCalls: 2, failedToolCalls: 1 } as any);

    expect(recorderCallCount()).toBe(0);
  });

  it('a sandbox run that fails records nothing either', () => {
    const runId = 'sbx-session:run:def';

    recordAgentModeRunStarted(runId, { llmModel: 'm', userId: EVAL_USER, sessionId: 'sbx-session', sessionType: 'regular' });
    recordAgentModeRunFailed(runId, { llmModel: 'm', toolCalls: 0, failedToolCalls: 0, error: new Error('crash') } as any);

    expect(recorderCallCount()).toBe(0);
  });

  it('tool telemetry is skipped on the explicit userId alone, without a prior run-start', () => {
    recordAgentModeToolTelemetry('orphan:run:1', 'sbx-session', 1, toolResults as any, undefined, EVAL_USER);

    expect(fakeRecorder.decision).not.toHaveBeenCalled();
    expect(fakeRecorder.toolInvoked).not.toHaveBeenCalled();
  });

  it('a customer run still records every event (behavior preserved)', () => {
    const runId = 'real-session:run:ghi';

    recordAgentModeRunStarted(runId, { llmModel: 'm', userId: REAL_USER, sessionId: 'real-session', sessionType: 'regular' });
    recordAgentModeToolTelemetry(runId, 'real-session', 1, toolResults as any, undefined, REAL_USER);
    recordAgentModeRunCompleted(runId, { llmModel: 'm', toolCalls: 2, failedToolCalls: 1 } as any);

    expect(fakeRecorder.runStarted).toHaveBeenCalledTimes(1);
    expect(fakeRecorder.decision).toHaveBeenCalledTimes(1);
    expect(fakeRecorder.toolInvoked).toHaveBeenCalledTimes(2);
    expect(fakeRecorder.toolSucceeded).toHaveBeenCalledTimes(1);
    expect(fakeRecorder.toolFailed).toHaveBeenCalledTimes(1);
    expect(fakeRecorder.runCompleted).toHaveBeenCalledTimes(1);
  });

  it('a sandbox run id does not leak into a later customer run with the same id', () => {
    const runId = 'reused:run:1';

    recordAgentModeRunStarted(runId, { llmModel: 'm', userId: EVAL_USER, sessionId: 's', sessionType: 'regular' });
    recordAgentModeRunCompleted(runId, { llmModel: 'm', toolCalls: 0, failedToolCalls: 0 } as any);
    recordAgentModeRunStarted(runId, { llmModel: 'm', userId: REAL_USER, sessionId: 's', sessionType: 'regular' });
    recordAgentModeRunCompleted(runId, { llmModel: 'm', toolCalls: 0, failedToolCalls: 0 } as any);

    expect(fakeRecorder.runStarted).toHaveBeenCalledTimes(1);
    expect(fakeRecorder.runCompleted).toHaveBeenCalledTimes(1);
  });
});
