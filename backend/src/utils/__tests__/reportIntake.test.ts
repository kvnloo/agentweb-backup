/**
 * ENG-529 — unit tests for the shared report-intake helpers.
 *
 * `buildReportTitle` is the ONE place the in-app report title is normalized, so the tracked
 * issue title and the outbound notification subject can never disagree or carry a line break
 * (the raw newline is what Resend rejected with `422 "The \n is not allowed in the subject
 * field."`). `fileReportOnce` is the short-window replay guard that stops a retried or
 * timed-out submission from creating a second reporter ticket for the same report.
 */
import {
  toSingleLine,
  buildReportTitle,
  reportFingerprint,
  fileReportOnce,
  REPORT_REPLAY_WINDOW_MS,
  __resetReportIdempotencyForTests,
} from '../reportIntake';

describe('toSingleLine', () => {
  it('collapses newlines, tabs and carriage returns into single spaces', () => {
    expect(toSingleLine('line one\nline two\r\nline\tthree')).toBe('line one line two line three');
  });

  it('collapses unicode line/paragraph separators and control characters', () => {
    expect(toSingleLine('a\u2028b\u2029c\u0000d\u007fe')).toBe('a b c d e');
  });

  it('trims leading and trailing whitespace', () => {
    expect(toSingleLine('  \n padded \n ')).toBe('padded');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(toSingleLine('\n\t  \r\n')).toBe('');
  });
});

describe('buildReportTitle', () => {
  it('produces a single-line "<prefix>: <summary>" title from a multiline description', () => {
    const title = buildReportTitle('UI Bug', 'Steps:\n1. open settings\n2. click save\nNothing happens');
    expect(title).toBe('UI Bug: Steps: 1. open settings 2. click save Nothing happens');
    expect(title).not.toMatch(/[\r\n]/);
  });

  it('truncates the description summary to the shared limit', () => {
    const title = buildReportTitle('UI Bug', 'x'.repeat(200));
    // "UI Bug: " + 80 description characters
    expect(title).toBe(`UI Bug: ${'x'.repeat(80)}`);
  });

  it('does not leave a dangling space when the truncation lands on whitespace', () => {
    const description = `${'a'.repeat(79)} tail`;
    expect(buildReportTitle('UI Bug', description)).toBe(`UI Bug: ${'a'.repeat(79)}`);
  });

  it('falls back to the bare prefix when the description carries no visible text', () => {
    expect(buildReportTitle('UI Bug', '\n\t ')).toBe('UI Bug');
  });

  it('honours an explicit limit', () => {
    expect(buildReportTitle('Feedback', 'abcdefghij', 4)).toBe('Feedback: abcd');
  });
});

describe('reportFingerprint', () => {
  it('is stable across whitespace-only differences in the description (a retyped retry)', () => {
    const a = reportFingerprint({ userId: 'u1', reportType: 'bug', description: 'it broke\nagain' });
    const b = reportFingerprint({ userId: 'u1', reportType: 'bug', description: '  it broke   again  ' });
    expect(a).toBe(b);
  });

  it('separates different users, report types, descriptions and pages', () => {
    const base = { userId: 'u1', reportType: 'bug', description: 'it broke', pageUrl: '/a' };
    const prints = new Set([
      reportFingerprint(base),
      reportFingerprint({ ...base, userId: 'u2' }),
      reportFingerprint({ ...base, reportType: 'feedback' }),
      reportFingerprint({ ...base, description: 'it broke differently' }),
      reportFingerprint({ ...base, pageUrl: '/b' }),
      reportFingerprint({ ...base, pageUrl: undefined }),
    ]);
    expect(prints.size).toBe(6);
  });
});

describe('fileReportOnce', () => {
  beforeEach(() => __resetReportIdempotencyForTests());

  it('runs the filer once and replays the same result for a retry inside the window', async () => {
    const filer = jest.fn().mockResolvedValue({ pageId: '169' });

    const first = await fileReportOnce('fp', filer, 1_000);
    const second = await fileReportOnce('fp', filer, 1_000 + REPORT_REPLAY_WINDOW_MS - 1);

    expect(filer).toHaveBeenCalledTimes(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
  });

  it('collapses concurrent in-flight submissions of the same report onto one filing', async () => {
    let resolveFiling: (v: any) => void = () => {};
    const filer = jest.fn().mockImplementation(() => new Promise((resolve) => { resolveFiling = resolve; }));

    const a = fileReportOnce('fp', filer, 1_000);
    const b = fileReportOnce('fp', filer, 1_100);
    resolveFiling({ pageId: '169' });

    expect((await a).result).toEqual({ pageId: '169' });
    expect((await b).result).toEqual({ pageId: '169' });
    expect((await b).replayed).toBe(true);
    expect(filer).toHaveBeenCalledTimes(1);
  });

  it('keeps an active filing authoritative after the replay window elapses', async () => {
    let resolveFiling: (value: { pageId: string }) => void = () => {};
    const filer = jest.fn().mockImplementation(
      () => new Promise<{ pageId: string }>((resolve) => { resolveFiling = resolve; }),
    );

    const first = fileReportOnce('slow', filer, 1_000);
    const lateRetry = fileReportOnce('slow', filer, 1_000 + REPORT_REPLAY_WINDOW_MS + 1);
    resolveFiling({ pageId: '169' });

    await expect(first).resolves.toEqual({ result: { pageId: '169' }, replayed: false });
    await expect(lateRetry).resolves.toEqual({ result: { pageId: '169' }, replayed: true });
    expect(filer).toHaveBeenCalledTimes(1);
  });

  it('does not let a late failure delete or overlap the authoritative filing', async () => {
    let rejectFiling: (error: Error) => void = () => {};
    const filer = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectFiling = reject; }),
      )
      .mockResolvedValueOnce({ pageId: '170' });

    const first = fileReportOnce('slow-failure', filer, 1_000);
    const lateRetry = fileReportOnce(
      'slow-failure',
      filer,
      1_000 + REPORT_REPLAY_WINDOW_MS + 1,
    );
    rejectFiling(new Error('Linear timed out'));

    await expect(first).rejects.toThrow('Linear timed out');
    await expect(lateRetry).rejects.toThrow('Linear timed out');

    const cleanRetry = await fileReportOnce(
      'slow-failure',
      filer,
      1_000 + REPORT_REPLAY_WINDOW_MS + 2,
    );
    expect(cleanRetry).toEqual({ result: { pageId: '170' }, replayed: false });
    expect(filer).toHaveBeenCalledTimes(2);
  });

  it('never evicts a fresh replay to admit an unrelated report at capacity', async () => {
    const filer = jest.fn().mockResolvedValue({ pageId: '169' });
    for (let i = 0; i < 500; i++) {
      await fileReportOnce(`fresh-${i}`, filer, 1_000);
    }

    const unrelatedFiler = jest.fn().mockResolvedValue({ pageId: '670' });
    await expect(
      fileReportOnce('unrelated-user-report', unrelatedFiler, 1_001, 0),
    ).rejects.toThrow('Report replay guard is busy');
    expect(unrelatedFiler).not.toHaveBeenCalled();

    const evictedRetryFiler = jest.fn().mockResolvedValue({ pageId: 'duplicate' });
    const oldestRetry = await fileReportOnce('fresh-0', evictedRetryFiler, 1_002);
    expect(oldestRetry).toEqual({ result: { pageId: '169' }, replayed: true });
    expect(evictedRetryFiler).not.toHaveBeenCalled();
  });

  it('isolates capacity by authenticated user so one full bucket cannot block another', async () => {
    const userAFiler = jest.fn().mockResolvedValue({ pageId: 'user-a-report' });
    for (let i = 0; i < 500; i++) {
      await (fileReportOnce as any)(`user-a-${i}`, userAFiler, 1_000, 0, 'user-a');
    }

    const userBFiler = jest.fn().mockResolvedValue({ pageId: 'user-b-report' });
    await expect(
      (fileReportOnce as any)('user-b-0', userBFiler, 1_001, 0, 'user-b'),
    ).resolves.toEqual({
      result: { pageId: 'user-b-report' },
      replayed: false,
    });

    expect(userAFiler).toHaveBeenCalledTimes(500);
    expect(userBFiler).toHaveBeenCalledTimes(1);
  });

  it('backpressures at all-pending capacity, then files once a tracked slot fails open', async () => {
    const rejecters: Array<(error: Error) => void> = [];
    const filer = jest.fn(
      () => new Promise<{ pageId: string }>((_resolve, reject) => { rejecters.push(reject); }),
    );
    for (let i = 0; i < 500; i++) {
      void fileReportOnce(`pending-${i}`, filer, 1_000).catch(() => undefined);
    }

    const overflowFiler = jest.fn().mockResolvedValue({ pageId: 'overflow' });
    const overflow = fileReportOnce('overflow', overflowFiler, 1_001);
    await Promise.resolve();

    expect(filer).toHaveBeenCalledTimes(500);
    expect(overflowFiler).not.toHaveBeenCalled();

    rejecters[0](new Error('first filing failed'));
    await expect(overflow).resolves.toEqual({
      result: { pageId: 'overflow' },
      replayed: false,
    });
    expect(overflowFiler).toHaveBeenCalledTimes(1);
  });

  it('bounds all-pending backpressure without starting an untracked filing', async () => {
    const neverSettles = new Promise<{ pageId: string }>(() => {});
    for (let i = 0; i < 500; i++) {
      void fileReportOnce(`pending-${i}`, () => neverSettles, 1_000);
    }

    const overflowFiler = jest.fn().mockResolvedValue({ pageId: 'overflow' });
    const guarded = (fileReportOnce as any)('overflow', overflowFiler, 1_001, 1);
    const observed = Promise.race([
      guarded,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('test observed unbounded backpressure')),
        50,
      )),
    ]);

    await expect(observed).rejects.toThrow('Report replay guard is busy');
    expect(overflowFiler).not.toHaveBeenCalled();
  });

  it('files again once the replay window has elapsed', async () => {
    const filer = jest.fn().mockResolvedValue({ pageId: '169' });

    await fileReportOnce('fp', filer, 1_000);
    await fileReportOnce('fp', filer, 1_000 + REPORT_REPLAY_WINDOW_MS);

    expect(filer).toHaveBeenCalledTimes(2);
  });

  it('never caches a FAILED filing — the retry really re-files', async () => {
    const filer = jest
      .fn()
      .mockRejectedValueOnce(new Error('Linear down'))
      .mockResolvedValueOnce({ pageId: '170' });

    await expect(fileReportOnce('fp', filer, 1_000)).rejects.toThrow('Linear down');
    const retry = await fileReportOnce('fp', filer, 1_500);

    expect(filer).toHaveBeenCalledTimes(2);
    expect(retry.result).toEqual({ pageId: '170' });
    expect(retry.replayed).toBe(false);
  });

  it('keeps distinct reports independent', async () => {
    const filer = jest.fn().mockResolvedValue({ pageId: '169' });

    await fileReportOnce('fp-a', filer, 1_000);
    await fileReportOnce('fp-b', filer, 1_000);

    expect(filer).toHaveBeenCalledTimes(2);
  });

  it('prunes expired entries so the guard cannot grow without bound', async () => {
    const filer = jest.fn().mockResolvedValue({ pageId: '169' });
    // Fill the hard bound while every entry is fresh.
    for (let i = 0; i < 500; i++) {
      await fileReportOnce(`old-${i}`, filer, 1_000);
    }
    // One call after the window elapses prunes the whole expired generation.
    const survivorAt = 1_000 + REPORT_REPLAY_WINDOW_MS;
    await fileReportOnce('survivor', filer, survivorAt);

    filer.mockClear();
    await fileReportOnce('old-0', filer, survivorAt + 1);
    const survivor = await fileReportOnce('survivor', filer, survivorAt + 1);

    // The expired entry was dropped and re-filed; the fresh survivor is still replayed.
    expect(filer).toHaveBeenCalledTimes(1);
    expect(survivor.replayed).toBe(true);
  });

  it('defaults to the wall clock when no timestamp is supplied', async () => {
    const filer = jest.fn().mockResolvedValue({ pageId: '169' });

    await fileReportOnce('fp', filer);
    const replay = await fileReportOnce('fp', filer);

    expect(filer).toHaveBeenCalledTimes(1);
    expect(replay.replayed).toBe(true);
  });
});
