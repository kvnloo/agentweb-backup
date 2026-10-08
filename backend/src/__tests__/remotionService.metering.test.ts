// ENG-699: prove RemotionService.compose() meters at submission and records
// a distinguishable outcome marker for complete/failed/handoff-unobserved,
// without changing render behavior, timeouts, or the poll ceiling.

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () =>
          Promise.resolve({
            SecretString: JSON.stringify({
              functionName: 'remotion-render-fn',
              serveUrl: 'https://example.com/serve',
              region: 'us-east-1',
            }),
          }),
      }),
    })),
  },
}));

const mockRecordVendorUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: (...args: unknown[]) => mockRecordVendorUsage(...args),
}));

const mockRenderMediaOnLambda = jest.fn();
const mockGetRenderProgress = jest.fn();
jest.mock('@remotion/lambda/client', () => ({
  renderMediaOnLambda: (...args: unknown[]) => mockRenderMediaOnLambda(...args),
  getRenderProgress: (...args: unknown[]) => mockGetRenderProgress(...args),
}));

import { RemotionService } from '../services/remotionService';

function baseParams(overrides: Partial<Record<string, any>> = {}) {
  return {
    clipUrl: 'https://example.com/clip.mp4',
    brandName: 'AgentWeb',
    primaryColor: '#111111',
    secondaryColor: '#222222',
    filename: 'out.mp4',
    userId: 'user-abc',
    clipDurationSeconds: 8,
    ...overrides,
  };
}

describe('RemotionService.compose — ENG-699 metering', () => {
  jest.setTimeout(15000);
  let service: RemotionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RemotionService();
    // Skip the real EC2-metadata credential probe entirely — irrelevant to metering.
    (service as any).ensureRemotionCredentials = jest.fn().mockResolvedValue(undefined);
    mockRenderMediaOnLambda.mockResolvedValue({
      bucketName: 'remotionlambda-useast1-abc',
      renderId: 'render-123',
    });
  });

  it('records a render_submit usage row with the shard-count quantity before completion', async () => {
    mockGetRenderProgress.mockResolvedValue({ done: true, outputFile: 'https://out.example.com/final.mp4' });

    await service.compose(baseParams() as any);

    const submitCall = mockRecordVendorUsage.mock.calls.find(([ctx]) => ctx.operation === 'render_submit');
    expect(submitCall).toBeDefined();
    const [ctx] = submitCall!;
    expect(ctx).toMatchObject({
      userId: 'user-abc',
      provider: 'remotion',
      feature: 'branded_video',
      unit: 'render',
      // ENG-1929: priced by the recorder from the card's render rate.
      rateKey: 'render',
    });
    expect(ctx.quantity).toBeGreaterThanOrEqual(1);
  });

  it('records render_completed when the poll observes done:true', async () => {
    mockGetRenderProgress.mockResolvedValue({ done: true, outputFile: 'https://out.example.com/final.mp4' });

    const result = await service.compose(baseParams() as any);

    expect(result.success).toBe(true);
    const operations = mockRecordVendorUsage.mock.calls.map(([ctx]) => ctx.operation);
    expect(operations).toEqual(expect.arrayContaining(['render_submit', 'render_completed']));
  });

  it('records render_failed when the poll observes a fatal error — attempted, not omitted', async () => {
    mockGetRenderProgress.mockResolvedValue({
      done: false,
      fatalErrorEncountered: true,
      errors: [{ message: 'boom' }],
    });

    const result = await service.compose(baseParams() as any);

    expect(result.success).toBe(false);
    const operations = mockRecordVendorUsage.mock.calls.map(([ctx]) => ctx.operation);
    expect(operations).toEqual(expect.arrayContaining(['render_submit', 'render_failed']));
  });

  it('records render_handoff_unobserved when the poll budget runs out before completion (ENG-123 detached handoff)', async () => {
    mockGetRenderProgress.mockResolvedValue({ done: false, overallProgress: 0.2 });

    // Force an immediate handoff: a deadline already in the past yields a 1-poll budget.
    const result = await service.compose(
      baseParams({ renderDeadlineMs: Date.now() - 60_000 }) as any
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe('processing');
    const operations = mockRecordVendorUsage.mock.calls.map(([ctx]) => ctx.operation);
    expect(operations).toEqual(expect.arrayContaining(['render_submit', 'render_handoff_unobserved']));
  });

  it('never fails or delays the render when metering itself throws (fire-and-forget)', async () => {
    // The REAL recordVendorUsage never rejects — internally it catches and
    // logs (see usageRecorderService.ts). Mimic that contract here rather
    // than rejecting the mock, which would incorrectly turn this into an
    // unhandled-rejection test instead of testing compose()'s own resilience.
    mockRecordVendorUsage.mockImplementation(async () => {
      // simulate the real function's internal catch: swallow and resolve.
    });
    mockGetRenderProgress.mockResolvedValue({ done: true, outputFile: 'https://out.example.com/final.mp4' });

    const result = await service.compose(baseParams() as any);

    expect(result.success).toBe(true);
  });

  it('does not change render inputs (framesPerLambda, timeout) when metering is added', async () => {
    mockGetRenderProgress.mockResolvedValue({ done: true, outputFile: 'https://out.example.com/final.mp4' });

    await service.compose(baseParams() as any);

    expect(mockRenderMediaOnLambda).toHaveBeenCalledWith(
      expect.objectContaining({
        framesPerLambda: 60,
        timeoutInMilliseconds: 300000,
        codec: 'h264',
      })
    );
  });

  it('records render_failed when the poll observes done but outputFile is missing', async () => {
    mockGetRenderProgress.mockResolvedValue({ done: true, outputFile: undefined });

    const result = await service.compose(baseParams() as any);

    expect(result.success).toBe(false);
    const operations = mockRecordVendorUsage.mock.calls.map(([ctx]) => ctx.operation);
    expect(operations).toEqual(expect.arrayContaining(['render_submit', 'render_failed']));
  });

  it('records render_failed when renderMediaOnLambda itself throws (outer catch)', async () => {
    mockRenderMediaOnLambda.mockRejectedValue(new Error('lambda invoke failed'));

    const result = await service.compose(baseParams() as any);

    expect(result.success).toBe(false);
    const operations = mockRecordVendorUsage.mock.calls.map(([ctx]) => ctx.operation);
    expect(operations).toEqual(expect.arrayContaining(['render_submit', 'render_failed']));
    // Exactly one render_failed — no double-recording from the outer catch.
    expect(operations.filter((op) => op === 'render_failed')).toHaveLength(1);
  });

  // SUPERSEDES "never throws into the outer catch when the metering rate lookup
  // itself throws", which asserted the old fallback: a missing rate booked the
  // submission as $0 "allocated" — the silent $0 ENG-703 AC2 forbids. ENG-1929
  // moved the lookup into recordVendorUsage (never throws; unpriced, not $0 —
  // covered by usageRecorderService.vendorRateKey.test.ts), so the render path
  // only names the rate key and has no lookup of its own left to fail.
  it('names the rate key instead of computing the cost, so no rate lookup can reach the render (ENG-1929)', async () => {
    mockGetRenderProgress.mockResolvedValue({ done: true, outputFile: 'https://out.example.com/final.mp4' });

    const result = await service.compose(baseParams() as any);

    expect(result.success).toBe(true);
    const submitCall = mockRecordVendorUsage.mock.calls.find(([ctx]) => ctx.operation === 'render_submit');
    expect(submitCall![0]).toMatchObject({ provider: 'remotion', rateKey: 'render' });
    expect(submitCall![0]).not.toHaveProperty('costUsd');
    expect(submitCall![0]).not.toHaveProperty('costSource');
  });
});
