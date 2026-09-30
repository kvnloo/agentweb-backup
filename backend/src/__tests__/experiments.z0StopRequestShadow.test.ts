jest.mock('../emma/z0Adapter', () => ({
  runZ0NoulExperiment: jest.fn(),
}));

import { runZ0NoulExperiment } from '../emma/z0Adapter';
import {
  buildStopRequestZ0Experiment,
  readStopRequestZ0ShadowMode,
  runStopRequestZ0Shadow,
  stopRequestZ0Band,
} from '../services/z0StopRequestShadow';

const run = runZ0NoulExperiment as jest.Mock;

describe('z0 stop-request shadow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses asymmetric future-assist bands without applying them', () => {
    expect(stopRequestZ0Band(0.91)).toBe('stop');
    expect(stopRequestZ0Band(0.90)).toBe('stop');
    expect(stopRequestZ0Band(0.50)).toBe('ambiguous');
    expect(stopRequestZ0Band(0.10)).toBe('continue');
    expect(stopRequestZ0Band(0.02)).toBe('continue');
  });

  it('is off by default', () => {
    expect(readStopRequestZ0ShadowMode({} as NodeJS.ProcessEnv)).toBe('off');
    expect(runStopRequestZ0Shadow(
      'session-secret',
      'please stop',
      {} as NodeJS.ProcessEnv,
    )).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('hashes operation identity and keeps raw session identity inside AgentWeb', () => {
    const built = buildStopRequestZ0Experiment(
      'raw-session-secret',
      'that is enough for now, please stop',
      { Z0INT_STOP_REQUEST_ALLOW_REMOTE: '1' } as NodeJS.ProcessEnv,
    );
    expect(built.request.decision_id).toBe('stop_request_v1');
    expect(built.request.operation_id).toMatch(/^[a-f0-9]{64}$/);
    expect(built.request.state).toEqual({
      message: 'that is enough for now, please stop',
    });
    expect(built.request.allow_remote).toBe(true);
    expect(built.options).toEqual({ scopeId: 'raw-session-secret' });
  });

  it('calls z0 only in shadow mode and preserves dedicated remote opt-in', async () => {
    run.mockResolvedValue({
      ok: true,
      executed: true,
      applied: false,
      output: { probability: 0.97 },
    });
    const promise = runStopRequestZ0Shadow(
      'session-secret',
      'please stop',
      {
        Z0_STOP_REQUEST_SHADOW: 'shadow',
        Z0INT_STOP_REQUEST_ALLOW_REMOTE: '1',
      } as NodeJS.ProcessEnv,
    );
    expect(promise).not.toBeNull();
    await promise;
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({
      decision_id: 'stop_request_v1',
      allow_remote: true,
    });
  });

  it('does not authorize remote message content from the shadow flag alone', async () => {
    run.mockResolvedValue({ ok: false, applied: false });
    const promise = runStopRequestZ0Shadow(
      'session-secret',
      'please stop',
      { Z0_STOP_REQUEST_SHADOW: 'shadow' } as NodeJS.ProcessEnv,
    );
    await promise;
    expect(run.mock.calls[0][0].allow_remote).toBe(false);
  });
});
