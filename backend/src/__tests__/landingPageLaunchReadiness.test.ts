// ENG-1868: a generated lander can build and deploy successfully and still not be
// launch-ready (failed post-deploy smoke test, no conversion tracking installed) —
// neither visible from status/buildStatus alone. These tests pin the pure readiness
// verdict derived from the record's own already-persisted fields.

import { getLandingPageLaunchReadiness } from '../utils/landingPageLaunchReadiness';

describe('getLandingPageLaunchReadiness', () => {
  it('is ready when nothing is known yet (no smoke test run, tracking installed)', () => {
    expect(getLandingPageLaunchReadiness({ trackingInstalled: true })).toEqual({
      ready: true,
      reasons: [],
    });
  });

  it('is ready when smokeTestResult and trackingInstalled are both absent (mid-generation)', () => {
    expect(getLandingPageLaunchReadiness({})).toEqual({ ready: true, reasons: [] });
  });

  it('flags a failed smoke test', () => {
    const result = getLandingPageLaunchReadiness({
      smokeTestResult: { ok: false },
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(['Post-deploy smoke test failed']);
  });

  it('includes the smoke test error detail when present', () => {
    const result = getLandingPageLaunchReadiness({
      smokeTestResult: { ok: false, error: 'lead form did not submit' },
    });
    expect(result.reasons).toEqual(['Post-deploy smoke test failed: lead form did not submit']);
  });

  it('does NOT flag a passed smoke test', () => {
    expect(
      getLandingPageLaunchReadiness({ smokeTestResult: { ok: true } })
    ).toEqual({ ready: true, reasons: [] });
  });

  it('flags missing conversion tracking', () => {
    expect(getLandingPageLaunchReadiness({ trackingInstalled: false })).toEqual({
      ready: false,
      reasons: ['No conversion tracking (GTM) installed'],
    });
  });

  it('combines both reasons when both are wrong', () => {
    const result = getLandingPageLaunchReadiness({
      smokeTestResult: { ok: false },
      trackingInstalled: false,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  // ENG-1868 review self-correction: a customer with no Meta ad account connected never
  // gets a pixel — resolveMetaPixelForUser resolving to nothing is a legitimate outcome
  // (ENG-1141/ENG-449), not a defect. metaTrackingInstalled is deliberately NOT part of
  // this verdict, unlike its sibling trackingInstalled.
  it('does not flag metaTrackingInstalled:false — a legitimate, common outcome', () => {
    const result = getLandingPageLaunchReadiness({
      trackingInstalled: true,
      ...( { metaTrackingInstalled: false } as any ),
    });
    expect(result).toEqual({ ready: true, reasons: [] });
  });
});
