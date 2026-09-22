/**
 * ENG-2072: whether THIS TURN must force hands-off autocomplete on a work plan.
 *
 * `session.sessionType === 'scheduled'` records how the session was CREATED, not
 * whether a human is present now — a user can reopen a schedule-created session
 * from the customer-portal "Scheduled" sidebar tab and keep chatting in it
 * (useAgentModeChat reuses the existing sessionId), and that turn is genuinely
 * ATTENDED. ENG-803 hit the identical confusion for the publish-approval prompt
 * block and fixed it the same way: prefer a real per-turn signal over inferring
 * attendance from sessionType alone.
 *
 * `isUnattendedRun` is threaded from runScheduledChat (and the "Test run" path,
 * which shares it) all the way through the tool-dispatch context — see
 * ToolContext in mcp/client/toolRegistry.ts. It is TRI-STATE:
 *   true      -> the real unattended scheduled/test-run path. Force autocomplete.
 *   false     -> an attended turn (interactive /generate, Emma sidebar, etc.),
 *                even if it lands on a scheduled session. Never force.
 *   undefined -> the caller has not been migrated to the new signal (e.g. the
 *                direct emmaApi.ts HTTP route, or an older test). Fall back to
 *                the original sessionType-only behavior so those callers see no
 *                change.
 */
export function shouldForceScheduledAutocomplete(session: any, isUnattendedRun?: boolean): boolean {
  if (isUnattendedRun !== undefined) return isUnattendedRun;
  return session?.sessionType === 'scheduled';
}
