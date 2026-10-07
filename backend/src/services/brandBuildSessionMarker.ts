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

/** True only when `ours` and `current` are both known and differ. */
export function isClaimSuperseded(
  ours: string | undefined,
  current: string | undefined,
): boolean {
  return !!ours && !!current && ours !== current;
}

/**
 * How long a brand-build session can still be running after its claim started.
 * Agent turns are capped at AGENT_MODE_GENERATION_TIMEOUT_MS (10 min), so a
 * session whose claim is older than this is no longer a live "zombie": it is a
 * chat the user reopened, which must behave like any ordinary chat.
 */
export const BRAND_BUILD_SESSION_LIFETIME_MS = 15 * 60 * 1000;

/**
 * Whether a write from a brand-build session must be refused. The session's
 * claim must be superseded AND the superseding build must be one the session
 * could still be corrupting: either a newer build is in flight right now, or the
 * session's own claim is recent enough that the session may still be running.
 * Otherwise (an old session reopened long after, with no build in flight) it is
 * ordinary chat and may write, so a user can still say "change my primary
 * color" in the chat that built their brand.
 *
 * `nowMs` is compared with the claim timestamp the marker carries; both come
 * from backend clocks and the lifetime is minutes, so skew does not matter.
 * An unparseable claim cannot be proven recent, so it is not refused.
 */
export function shouldRefuseBrandBuildSessionWrite(
  sessionClaim: string | undefined,
  current: { startedAt?: string; status?: string },
  nowMs: number = Date.now(),
): boolean {
  if (!isClaimSuperseded(sessionClaim, current.startedAt)) return false;
  if (current.status === "building") return true;
  const claimMs = Date.parse(sessionClaim as string);
  if (!Number.isFinite(claimMs)) return false;
  return nowMs - claimMs <= BRAND_BUILD_SESSION_LIFETIME_MS;
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
