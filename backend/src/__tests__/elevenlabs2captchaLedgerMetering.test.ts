/**
 * ENG-1878 (split from ENG-698) — ElevenLabs and 2captcha calls that reach the
 * vendor are recorded into the shared $ ledger via
 * `usageRecorderService.recordVendorUsage`.
 *
 * These were the last two vendors sitting in `vendorMeteringCoverageGuard`'s
 * allowlist that did not need the Placid credential (ENG-1598). Leaving them
 * unmetered meant every all-vendor figure was a known floor — measured at 13.3%
 * of total metered spend over 2026-09-04..09-11 without them.
 *
 * Assertions map to ENG-698's human-written contract, narrowed to these two:
 *   1. A voiceover is recorded against the requesting user, character count as quantity.
 *   2. A captcha solve is recorded against the user whose session requested it.
 *   3. A captcha attempt the vendor still billed is recorded (the poll timeout).
 *   4. Neither vendor can be called without producing a usage record.
 *   5. A metering failure never prevents a solve or voiceover reaching the caller.
 *   6. Costs are allocated, never measured.
 */

const mockRecordVendorUsage = jest.fn();
jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: (...a: any[]) => mockRecordVendorUsage(...a),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockAxiosPost(...a) },
  post: (...a: any[]) => mockAxiosPost(...a),
}));

jest.mock('../utils/secretsManager', () => ({
  getElevenLabsApiKey: jest.fn().mockResolvedValue('fake-key'),
}));

const mockUpload = jest.fn();
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: (...a: any[]) => mockUpload(...a),
}));

import { generateVoiceover } from '../services/voiceoverService';
import { getAllocatedRate } from '../utils/vendorRateCard';

describe('ElevenLabs ledger metering (ENG-1878)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpload.mockResolvedValue({ success: true, url: 'https://s3/audio.mp3', key: 'k' });
    mockAxiosPost.mockResolvedValue({ data: new ArrayBuffer(2048) });
  });

  it('records a voiceover against the requesting user, with characters as the quantity (AC1)', async () => {
    const script = 'x'.repeat(1500);
    await generateVoiceover(script, 'clip.mp3', 'user-7');

    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordVendorUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-7',
        provider: 'elevenlabs',
        unit: '1k_characters',
        // Fractional on purpose: a 1,500-character clip is 1.5 units, not 2.
        quantity: 1.5,
      }),
    );
  });

  it('prices from the Flash/Turbo rate, because the model is hardcoded to turbo (AC6)', async () => {
    await generateVoiceover('y'.repeat(1000), 'clip.mp3', 'user-7');

    const ctx = mockRecordVendorUsage.mock.calls[0][0];
    expect(ctx.operation).toBe('characters_flash_turbo');
    // ENG-1929: the recorder prices quantity x this key's rate.
    expect(ctx.rateKey).toBe('characters_flash_turbo');
    expect(ctx.quantity).toBe(1);
    // $0.125 per 1k characters.
    expect(getAllocatedRate('elevenlabs', ctx.rateKey)).toBeCloseTo(0.125, 6);
  });

  it('does not record when the vendor call never returned audio (AC4 applies to reached calls)', async () => {
    mockAxiosPost.mockRejectedValue(new Error('503 from elevenlabs'));

    const result = await generateVoiceover('hello', 'clip.mp3', 'user-7');

    // ElevenLabs bills for synthesis it performed; a failed request was not
    // billed, and recording it would inflate the figure.
    expect(result.success).toBe(false);
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('still returns the audio when metering throws (AC5)', async () => {
    mockRecordVendorUsage.mockImplementation(() => {
      throw new Error('ledger down');
    });

    const result = await generateVoiceover('hello', 'clip.mp3', 'user-7');

    expect(result.success).toBe(true);
    expect(result.audioUrl).toBe('https://s3/audio.mp3');
  });

  it('records before the S3 upload, so an upload failure cannot lose a billed call', async () => {
    mockUpload.mockResolvedValue({ success: false, error: 'bucket gone' });

    const result = await generateVoiceover('hello', 'clip.mp3', 'user-7');

    // The vendor was paid regardless of what happened to the bytes afterwards.
    expect(result.success).toBe(false);
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });
});

// ── 2captcha ────────────────────────────────────────────────────────────────
// Exercised through the real submit+poll helper via its test seam, driving
// global.fetch. That helper is the single chokepoint all five call sites funnel
// through, and the billing semantics it encodes — which failures 2captcha
// actually charges for — are the part most worth asserting.

describe('2captcha ledger metering (ENG-1878)', () => {
  const realFetch = global.fetch;
  afterAll(() => {
    global.fetch = realFetch;
  });

  /** Queue fetch responses in order: submit, then each poll. */
  function queueFetch(responses: Array<{ status: number; request: string }>) {
    const queue = [...responses];
    global.fetch = jest.fn(async () => ({
      json: async () => queue.shift(),
    })) as any;
  }

  beforeEach(() => jest.clearAllMocks());

  it('records a solved captcha against the requesting user, priced as allocated (AC2, AC6)', async () => {
    queueFetch([
      { status: 1, request: 'task-1' },     // submit accepted
      { status: 1, request: 'TOKEN-ABC' },  // first poll: solved
    ]);
    const { __test_submit2CaptchaTask } = await import('../emma/solveRecaptchaTool');

    const token = await __test_submit2CaptchaTask('key', { method: 'hcaptcha' }, 0, 'user-9');

    expect(token).toBe('TOKEN-ABC');
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordVendorUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-9',
        provider: '2captcha',
        operation: 'solve',
        unit: 'solve',
        quantity: 1,
        rateKey: 'solve',
        feature: 'captcha:solved',
      }),
    );
    expect(getAllocatedRate('2captcha', 'solve')).toBeCloseTo(0.00725, 8);
  });

  it('does NOT record a submission the vendor rejected — never accepted, never billed', async () => {
    queueFetch([{ status: 0, request: 'ERROR_WRONG_USER_KEY' }]);
    const { __test_submit2CaptchaTask } = await import('../emma/solveRecaptchaTool');

    await expect(__test_submit2CaptchaTask('key', {}, 0, 'user-9')).rejects.toThrow(/submit failed/);
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('does NOT record an unsolvable captcha — 2captcha documents these as free', async () => {
    queueFetch([
      { status: 1, request: 'task-2' },
      { status: 0, request: 'ERROR_CAPTCHA_UNSOLVABLE' },
    ]);
    const { __test_submit2CaptchaTask } = await import('../emma/solveRecaptchaTool');

    await expect(__test_submit2CaptchaTask('key', {}, 0, 'user-9')).rejects.toThrow(/2captcha error/);
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  // AC3, and the one genuine judgement call in this ticket. The task WAS
  // accepted, so 2captcha may have solved and charged for it after we stopped
  // waiting. Recording it makes the allocated total an upper bound — the same
  // shape X's already has — which is the honest side to err on when the
  // alternative is silently under-reporting spend we may have incurred.
  it('DOES record a poll that timed out — accepted by the vendor, outcome unknown (AC3)', async () => {
    jest.useFakeTimers();
    try {
      // NOT_READY forever after the submit: the helper polls every 5s until its
      // own deadline, so a fixed-length queue would run dry mid-run.
      let first = true;
      global.fetch = jest.fn(async () => ({
        json: async () => {
          if (first) {
            first = false;
            return { status: 1, request: 'task-3' };
          }
          return { status: 0, request: 'CAPCHA_NOT_READY' };
        },
      })) as any;
      const { __test_submit2CaptchaTask } = await import('../emma/solveRecaptchaTool');

      const pending = __test_submit2CaptchaTask('key', {}, 0, 'user-9');
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      // Past the helper's 165s deadline, so the while-loop exits.
      await jest.advanceTimersByTimeAsync(170_000);
      await assertion;

      expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordVendorUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: '2captcha', feature: 'captcha:timeout' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('still returns the solve when metering throws (AC5)', async () => {
    mockRecordVendorUsage.mockImplementation(() => {
      throw new Error('ledger down');
    });
    queueFetch([
      { status: 1, request: 'task-4' },
      { status: 1, request: 'TOKEN-XYZ' },
    ]);
    const { __test_submit2CaptchaTask } = await import('../emma/solveRecaptchaTool');

    await expect(__test_submit2CaptchaTask('key', {}, 0, 'user-9')).resolves.toBe('TOKEN-XYZ');
  });
});
