import { userDb } from "../services/db";

/**
 * The user row a `/start` route should answer from when its own call did not
 * persist a claim (`start*ForUser` resolved null).
 *
 * Two distinct reasons produce that null, and the plain `getUserById` read the
 * routes used for both is wrong for each:
 *  - Lost race: the winner wrote `running` milliseconds ago, which the
 *    eventually-consistent UserIdIndex may not show yet — a stale `ready` /
 *    `failed` / empty row tells the client to stop polling a run that is live.
 *    A strongly-consistent read sees the winner's write.
 *  - Eager pipeline: the route deliberately does not claim (the orchestrator's
 *    own runner is the only claimant) and the orchestrator has not claimed yet
 *    either. Before the claims existed the route wrote `running` itself, so the
 *    client always got an in-flight snapshot. Keep that: when the axis is not
 *    running yet, answer with the start patch (not persisted) so the client
 *    starts polling; the next status poll reports the real state.
 */
export async function viewAfterUnclaimedStart(
  userId: string,
  statusKey: string,
  runningValue: string,
  startPatch: () => object,
): Promise<Record<string, any>> {
  let row: Record<string, any> | null = null;
  try {
    row = (await userDb.getUserByIdConsistent(userId)) as Record<string, any> | null;
  } catch {
    /* fall through to the indexed read */
  }
  if (!row) {
    row = (await userDb.getUserById(userId)) as Record<string, any> | null;
  }
  const current = row ?? {};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { isEagerPipelineActiveFor } = require("../services/onboardingOrchestratorWiring");
  if (isEagerPipelineActiveFor(current as any) && current[statusKey] !== runningValue) {
    return { ...current, ...startPatch() };
  }
  return current;
}
