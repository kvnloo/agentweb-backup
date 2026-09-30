jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
  },
}));

jest.mock('../emma/jevAdapter', () => ({
  runJevDecide: jest.fn(),
}));

jest.mock('../emma/z0Adapter', () => {
  const actual = jest.requireActual('../emma/z0Adapter');
  return {
    ...actual,
    runZ0ChoiceExperiment: jest.fn(),
  };
});

import { agentModeService } from '../services/agentModeService';
import { runJevDecide } from '../emma/jevAdapter';
import { runZ0ChoiceExperiment } from '../emma/z0Adapter';
import { classifyReport, readReportShadowBackend } from '../services/reportClassificationService';

const llm = agentModeService.callLLM as jest.Mock;
const z0 = runZ0ChoiceExperiment as jest.Mock;
const jev = runJevDecide as jest.Mock;

describe('report classification z0 shadow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.Z0_REPORT_CLASSIFY_SHADOW;
    delete process.env.Z0INT_REPORT_CLASSIFY_ALLOW_REMOTE;
    delete process.env.JEV_REPORT_CLASSIFY;
    llm.mockResolvedValue({
      choices: [{ message: { content: 'performance' } }],
    });
    z0.mockResolvedValue({
      ok: true,
      executed: true,
      applied: false,
      mode: 'shadow',
      output: {
        model: 'jev-1.13.0',
        label: 'performance',
        probabilities: { creative: 0.01, performance: 0.98, research: 0.01 },
        confidence: 0.98,
      },
      dispatch_receipt_id: 'receipt-fixture',
    });
  });

  afterAll(() => {
    delete process.env.Z0_REPORT_CLASSIFY_SHADOW;
    delete process.env.Z0INT_REPORT_CLASSIFY_ALLOW_REMOTE;
    delete process.env.JEV_REPORT_CLASSIFY;
  });

  it('keeps all shadowing off by default', () => {
    expect(readReportShadowBackend({} as NodeJS.ProcessEnv)).toBe('off');
  });

  it('prefers z0 over the legacy direct-JEV shadow when both flags are present', () => {
    expect(readReportShadowBackend({
      Z0_REPORT_CLASSIFY_SHADOW: 'shadow',
      JEV_REPORT_CLASSIFY: 'shadow',
    } as NodeJS.ProcessEnv)).toBe('z0');
  });

  it('returns the incumbent unchanged while sending one observational z0 decision', async () => {
    process.env.Z0_REPORT_CLASSIFY_SHADOW = 'shadow';
    process.env.Z0INT_REPORT_CLASSIFY_ALLOW_REMOTE = '1';
    process.env.JEV_REPORT_CLASSIFY = 'shadow';

    const result = await classifyReport('paid-media.html', 'ROAS CTR CPC campaign spend');
    await new Promise(resolve => setImmediate(resolve));

    expect(result).toBe('performance');
    expect(llm).toHaveBeenCalledTimes(1);
    expect(z0).toHaveBeenCalledTimes(1);
    expect(jev).not.toHaveBeenCalled();

    const [request, options] = z0.mock.calls[0];
    expect(request).toMatchObject({
      decision_id: 'report_type_v1',
      allow_remote: true,
    });
    expect(request.state).toEqual({
      filename: 'paid-media.html',
      excerpt: 'ROAS CTR CPC campaign spend',
    });
    expect(options).toEqual({ scopeId: 'report_type_v1' });
  });

  it('does not authorize report content remotely unless the dedicated flag is set', async () => {
    process.env.Z0_REPORT_CLASSIFY_SHADOW = 'shadow';

    await classifyReport('research.html', 'competitor market analysis');
    await new Promise(resolve => setImmediate(resolve));

    expect(z0).toHaveBeenCalledTimes(1);
    expect(z0.mock.calls[0][0].allow_remote).toBe(false);
    expect(jev).not.toHaveBeenCalled();
  });

  it('preserves the legacy direct-JEV shadow when z0 shadow is off', async () => {
    process.env.JEV_REPORT_CLASSIFY = 'shadow';
    jev.mockResolvedValue({
      ok: false,
      skipped: true,
      reason: 'disabled',
      answers: {},
    });

    const result = await classifyReport('research.html', 'competitor market analysis');
    await new Promise(resolve => setImmediate(resolve));

    expect(result).toBe('performance');
    expect(jev).toHaveBeenCalledTimes(1);
    expect(z0).not.toHaveBeenCalled();
  });
});
