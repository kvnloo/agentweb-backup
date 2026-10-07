/**
 * Which brand-build claim a chat session belongs to (ENG-2308 review follow-up).
 *
 * `withTimeout` does not abort a brand build's Emma session, so a build that
 * timed out and was retried leaves a live "zombie" session that can still call
 * `update_brand_guidelines` later. The hook used to check only
 * `brandBuildStatus === "building"`, which is true for the RECLAIMING run's
 * `building`, so the zombie overwrote the newer run's brand guidelines and
 * flipped it to `ready` early.
 *
 * The session itself names its claim: `triggerBrandBuildForUser` creates it with
 * a `pageIdentifier` of `brand-build|claim:<brandBuildStartedAt>`. That is an
 * existing field (nothing new is persisted; scheduled sessions already encode
 * `|scheduleId:` the same way), it is visible to the forked agent worker (an
 * in-process map was not), and it needs no clock comparison: the hook checks the
 * marker against the build's CURRENT `brandBuildStartedAt`. Sessions without a
 * marker (ordinary chat, REST saves, builds already in flight when this
 * shipped) are not brand-build sessions and keep the original behavior.
 *
 * Dependency-free on purpose: the `update_brand_guidelines` hook imports this on
 * every call and must not pull in the brand-build service's imports.
 */

const BRAND_BUILD_SESSION_PREFIX = "brand-build|claim:";

export function brandBuildSessionPageIdentifier(claimStartedAt: string): string {
  return `${BRAND_BUILD_SESSION_PREFIX}${claimStartedAt}`;
}

/** The claim a session was started under, or `undefined` if it is not a brand-build session. */
export function parseBrandBuildSessionClaim(
  pageIdentifier: string | undefined | null,
): string | undefined {
  if (typeof pageIdentifier !== "string") return undefined;
  if (!pageIdentifier.startsWith(BRAND_BUILD_SESSION_PREFIX)) return undefined;
  return pageIdentifier.slice(BRAND_BUILD_SESSION_PREFIX.length) || undefined;
}

/**
 * True only when the session's claim is provably not the build's current claim.
 * If either side is unknown we cannot prove it is superseded, so it is not.
 */
export function isBrandBuildSessionSuperseded(
  sessionClaim: string | undefined,
  currentStartedAt: string | undefined,
): boolean {
  return !!sessionClaim && !!currentStartedAt && sessionClaim !== currentStartedAt;
}

/**
 * DynamoDB condition: the brand build must still be the claim `claimStartedAt`.
 * Used for every write made on behalf of a brand-build run or its session.
 */
export function brandBuildOwnershipCondition(claimStartedAt: string) {
  return {
    expression: "#brandBuildStartedAt = :brandBuildOwnerStartedAt",
    names: { "#brandBuildStartedAt": "brandBuildStartedAt" },
    values: { ":brandBuildOwnerStartedAt": claimStartedAt },
  };
}
