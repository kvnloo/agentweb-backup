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
 * Text that identifies the brand build's own opening prompt. The prompt builder
 * embeds this verbatim so the two cannot drift; a message containing it was
 * written by the system, not by a human.
 */
export const BRAND_BUILD_PROMPT_SENTINEL =
  "running an autonomous brand-build for an onboarding flow";

/** True when `content` is the brand build's own opening prompt. */
export function isBrandBuildPrompt(content: unknown): boolean {
  return typeof content === "string" && content.includes(BRAND_BUILD_PROMPT_SENTINEL);
}

/**
 * Number of messages a human wrote in a session (user-role messages other than
 * the brand build's own opening prompt).
 */
export function countHumanMessages(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): number {
  return (messages ?? []).filter((m) => m?.role === "user" && !isBrandBuildPrompt(m.content)).length;
}

/**
 * Whether a write from a brand-build session whose claim is superseded must be
 * refused. A session that is still "the build" (nobody has talked to it) is a
 * zombie and is refused. A session a human has since written in is that chat
 * reopened, i.e. ordinary chat, and may write, unless a newer build is in flight
 * right now (then nothing from an old session may touch the build's data).
 *
 * This is decided by content, not by age. An earlier version bounded it to 15
 * minutes after the claim, on the premise that agent turns are capped at 10
 * minutes; that cap does not apply to the brand build's direct call, so a slow
 * zombie outlived the bound and wrote unconditionally.
 *
 * `humanMessages` is `undefined` when the history could not be read: only the
 * in-flight rule applies then, since we cannot prove a human is involved.
 */
export function shouldRefuseBrandBuildSessionWrite(
  sessionClaim: string | undefined,
  current: { startedAt?: string; status?: string },
  humanMessages?: number,
): boolean {
  if (!isClaimSuperseded(sessionClaim, current.startedAt)) return false;
  if (current.status === "building") return true;
  return humanMessages === 0;
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
