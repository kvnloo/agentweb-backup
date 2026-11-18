/**
 * ENG-2816 (step 3): which sessions are running a SHARE-LINK VISITOR's turn right now.
 *
 * A share link runs the visitor's turn inside the OWNER's session, under the owner's userId, so "who started this turn" is not
 * something the session or the user id can answer. This marker is: it is set where a share route claims the session's generation
 * lock (a visitor until the owner is recognised) and cleared where that lock is released, so it lives exactly as long as the turn.
 *
 * Two readers:
 *  - the schedule write handlers, as a SECOND signal that a self-call write is a visitor's (the first is the restriction-profile
 *    claim in the self-call token). Either one says visitor; a hop that drops the claim, or voice, which has only the claim, no
 *    longer turns a visitor's write into an owner's;
 *  - the share-link stop route, which cancels a turn only for the owner's own login or when the running turn was a visitor's, so a
 *    visitor cannot stop the OWNER's turn.
 *
 * In-process on purpose: the lock it shadows is in-process too (`activeSessionGenerations`), and a self-call lands on the same
 * process (it goes to localhost). No storage, nothing to migrate.
 */

const visitorTurns = new Set<string>();

/** A share route has claimed this session's lock for a turn that is a visitor's until the owner is recognised. */
export function markShareVisitorTurn(sessionId: string): void {
  if (sessionId) visitorTurns.add(sessionId);
}

/** The owner was recognised on this turn (their login rode the share link): it is not a visitor's turn after all. */
export function clearShareVisitorTurn(sessionId: string): void {
  visitorTurns.delete(sessionId);
}

/** True while a share route's visitor turn holds this session. */
export function isShareVisitorTurn(sessionId: string | undefined | null): boolean {
  return typeof sessionId === 'string' && sessionId !== '' && visitorTurns.has(sessionId);
}
