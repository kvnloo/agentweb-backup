/**
 * ENG-1868: "deployed" (build succeeded, live URL resolves) is NOT the same claim as
 * "launch-ready" (a real visitor can actually convert on it). A page can build fine and
 * still fail its post-deploy Playwright smoke test (lead form doesn't actually capture a
 * lead) or ship with no conversion tracking installed — neither of those is visible from
 * `status`/`buildStatus` alone, which is exactly how a launch-ready claim went out for a
 * page with `smokeTestResult: { ok: false }`.
 *
 * Deliberately excludes `metaTrackingInstalled` AND `googleAdsTrackingInstalled` even
 * though both live right next to `trackingInstalled` on the record — both are opt-in
 * signals, populated only when the caller explicitly requested that platform's tracking
 * (the `meta_pixel_override` / `google_ads` params on generate_landing_page), unlike
 * `trackingInstalled` (general GTM), which every page gets regardless of ad platform. A
 * customer with no Meta ad account connected NEVER gets a pixel (`resolveMetaPixelForUser`
 * resolving to nothing is a legitimate, deliberate outcome per ENG-1141/ENG-449, not a
 * defect) — and the same reasoning applies to Google Ads tracking for a page that never
 * requested it. Flagging either as "not ready" would be false-positive noise on the common
 * case. The frontend's own existing Meta badge (`LandingPages.tsx`) already encodes this —
 * it only shows when the user has a connected ad account at all. A separate gate (RULE 7.5
 * in the campaign-launch tools) independently re-checks Google Ads tracking at the point it
 * actually matters — launching a Google Ads campaign against this page — so excluding it
 * here isn't a coverage gap, just the right layer for the check.
 *
 * Standalone, dependency-free module (not part of v0Service.ts, which is heavy at import
 * time — aws-sdk, axios): agentModeService.ts is required by most of the test suite
 * (ENG-1277), so anything it imports at module scope should stay cheap.
 */

export interface LaunchReadinessInput {
  smokeTestResult?: {
    ok: boolean;
    error?: string;
  };
  trackingInstalled?: boolean;
}

export interface LaunchReadiness {
  ready: boolean;
  reasons: string[];
}

export function getLandingPageLaunchReadiness(page: LaunchReadinessInput): LaunchReadiness {
  const reasons: string[] = [];
  if (page.smokeTestResult?.ok === false) {
    const detail = page.smokeTestResult.error ? `: ${page.smokeTestResult.error}` : "";
    reasons.push(`Post-deploy smoke test failed${detail}`);
  }
  if (page.trackingInstalled === false) {
    reasons.push("No conversion tracking (GTM) installed");
  }
  return { ready: reasons.length === 0, reasons };
}
