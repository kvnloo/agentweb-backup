/**
 * Whether this session is a manual "Test this schedule" run rather than a real
 * scheduled execution. Test runs are triggered interactively by the user, who
 * watches the outcome live, and are deliberately excluded from the durable
 * lease/reconciler recovery path (agentModeController.runScheduledChat) — a test
 * click must never requeue. They are QA actions, not production runs, so a test
 * that crashes must not be scored or surfaced as a satisfaction reliability
 * failure: doing so pollutes the cohort and files recurring product tickets for
 * what the user already saw fail in the UI (ENG-499). For the same reason a test
 * run never emails its owner about a paused work plan step (ENG-669 PR-D).
 *
 * runScheduledChat prefixes the pageIdentifier (and title) with "Test: " for a
 * test run and "Scheduled: " for a real run, so the prefix is a reliable marker
 * fixed at session creation. A schedule literally named "Test: …" produces a real
 * run titled "Scheduled: Test: …", which correctly does NOT match.
 *
 * Its own module (it was sessionScoringService's) so the controller can use it
 * without loading the scoring service graph.
 */
export function isTestScheduledSession(
  session: { sessionType?: string; pageIdentifier?: string; title?: string } | null | undefined,
): boolean {
  if (session?.sessionType !== "scheduled") return false;
  const marker = session.pageIdentifier ?? session.title ?? "";
  return marker.startsWith("Test: ");
}
