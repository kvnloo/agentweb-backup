import { AgentModeService } from '../services/agentModeService';

jest.mock('../emma/jevAdapter', () => {
  const actual = jest.requireActual('../emma/jevAdapter');
  return {
    ...actual,
    runJevDecide: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runJevDecide } = require('../emma/jevAdapter') as {
  runJevDecide: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const svc = require('../services/reportClassificationService') as {
  classifyReport: (filename: string, excerpt: string) => Promise<string>;
};

describe('reportClassificationService Jev shadow', () => {
  const OLD_ENV = process.env;
  let callLLMSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.JEV_REPORT_CLASSIFY;
    delete process.env.JEV_BACKEND;
    runJevDecide.mockReset();
    callLLMSpy = jest
      .spyOn(AgentModeService.prototype as any, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'performance' } }] });
  });

  afterEach(() => {
    callLLMSpy.mockRestore();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('returns the incumbent result with shadow off (default: no Jev call)', async () => {
    const result = await svc.classifyReport('ads.html', 'ROAS CPM CPC report');
    expect(result).toBe('performance');
    expect(callLLMSpy).toHaveBeenCalledTimes(1);
    expect(runJevDecide).not.toHaveBeenCalled();
  });

  it('shadow mode returns the incumbent, makes one incumbent call, and logs a comparison', async () => {
    process.env.JEV_REPORT_CLASSIFY = 'shadow';
    runJevDecide.mockResolvedValue({
      ok: true,
      skipped: false,
      backend: 'typesafe',
      model: 'jev-latest',
      answers: {
        report_type: {
          type: 'choice',
          choice: 'performance',
          probabilities: { creative: 0.05, performance: 0.9, research: 0.05 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await svc.classifyReport('ads.html', 'ROAS CPM CPC report');
      expect(result).toBe('performance');
      expect(callLLMSpy).toHaveBeenCalledTimes(1);
      expect(runJevDecide).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const shadowLogs = logSpy.mock.calls.filter((args) =>
        String(args[0] ?? '').includes('jev_report_classify_shadow'),
      );
      expect(shadowLogs.length).toBe(1);
      const payload = JSON.parse(String(shadowLogs[0][0]));
      expect(payload.ok).toBe(true);
      expect(payload.jevLabel).toBe('performance');
      expect(payload.agree).toBe(true);
      expect(payload.jevMargin).toBeCloseTo(0.85);
      expect(payload.incumbent).toBe('performance');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('shadow mode never fails the request when Jev and incumbent both error', async () => {
    process.env.JEV_REPORT_CLASSIFY = 'shadow';
    callLLMSpy.mockRejectedValueOnce(new Error('provider down'));
    runJevDecide.mockRejectedValueOnce(new Error('jev down'));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await svc.classifyReport('x.html', 'anything');
      // Incumbent fallback is 'research'; shadow rejection is swallowed.
      expect(result).toBe('research');
    } finally {
      logSpy.mockRestore();
    }
  });
});
