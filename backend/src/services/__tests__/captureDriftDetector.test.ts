import { detectCaptureDrift } from '../captureDriftDetector';
import { buildCaptureRoute, buildLandingPageMiddleware } from '../v0Service';

describe('detectCaptureDrift (ENG-1289)', () => {
  const middleware = buildLandingPageMiddleware();

  it('reports no drift for a site whose capture files match current output, despite per-site constants', () => {
    const route = buildCaptureRoute(
      { '/': 'list_a', '/promo': 'list_b' },
      'https://api.example.test',
      '1430870751246428',
      'act_922903076601160',
    );
    const report = detectCaptureDrift({ middleware, captureRoute: route });
    expect(report.drifted).toBe(false);
    expect(report.files.map((f) => f.status)).toEqual(['match', 'match']);
  });

  it('flags missing capture files (the ENG-309 shape)', () => {
    const report = detectCaptureDrift({ middleware: null, captureRoute: null });
    expect(report.drifted).toBe(true);
    expect(report.files.map((f) => f.status)).toEqual(['missing', 'missing']);
  });

  it('flags a stale middleware that no longer stamps the first-touch cookie, with the first differing line', () => {
    const stale = middleware.replace('const COOKIE = "aw_first_touch";', 'const COOKIE = "old";');
    const report = detectCaptureDrift({ middleware: stale, captureRoute: buildCaptureRoute({}) });
    expect(report.drifted).toBe(true);
    const mw = report.files[0];
    expect(mw.status).toBe('drifted');
    expect(mw.actualLine).toBe('const COOKIE = "old";');
    expect(mw.expectedLine).toBe('const COOKIE = "aw_first_touch";');
    expect(report.files[1].status).toBe('match');
  });

  it('flags a capture route whose logic (not just constants) differs', () => {
    const route = buildCaptureRoute({ '/': 'list_a' }) + '\n// extra code\n';
    const report = detectCaptureDrift({ middleware, captureRoute: route });
    expect(report.files[1].status).toBe('drifted');
    expect(report.files[1].expectedLine).toBe('<end of file>');
  });

  it('tolerates CRLF line endings from a checked-out deploy', () => {
    const report = detectCaptureDrift({
      middleware: middleware.replace(/\n/g, '\r\n'),
      captureRoute: buildCaptureRoute({}),
    });
    expect(report.drifted).toBe(false);
  });

  it('does not mask a per-site constant whose initializer is executable code', () => {
    const route = buildCaptureRoute({ '/': 'list_a' }).replace(
      /^const FORWARD_URL = .*;$/m,
      'const FORWARD_URL = pickUrl("https://evil.example");',
    );
    const report = detectCaptureDrift({ middleware: buildLandingPageMiddleware(), captureRoute: route });
    expect(report.drifted).toBe(true);
    expect(report.files[1].actualLine).toContain('pickUrl');
  });
});
