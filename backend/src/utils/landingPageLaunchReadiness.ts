/**
 * ENG-1868: "deployed" (build succeeded, live URL resolves) is NOT the same claim as
 * "launch-ready" (a real visitor can actually convert on it). A page can build fine and
 * still fail its post-deploy Playwright smoke test (lead form doesn't actually capture a
 * lead) or ship with no conversion tracking installed — neither of those is visible from
 * `status`/`buildStatus` alone, which is exactly how a launch-ready claim went out for a
 * page with `smokeTestResult: { ok: false }`.
 *
 * Deliberately excludes `metaTrackingInstalled` even though it lives right next to
 * `trackingInstalled` on the record: a customer with no Meta ad account connected NEVER
 * gets a pixel (`resolveMetaPixelForUser` resolving to nothing is a legitimate, deliberate
 * outcome per ENG-1141/ENG-449, not a defect), so flagging every such page as "not ready"
 * would be false-positive noise on the common case. The frontend's own existing Meta badge
 * (`LandingPages.tsx`) already encodes this — it only shows when the user has a connected
 * ad account at all. `trackingInstalled` (general GTM conversion tracking) has no such
 * caveat: it is expected on every page regardless of ad platform, matching its own existing
 * unconditional frontend badge.
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
