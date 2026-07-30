// .linear-autofix/recovery.mjs — pure decision for the stale-In-Progress crash sweep (ENG-655). A pipeline
// run that crashed leaves its issue stuck In Progress with a 'started' record and no final outcome; the
// pickup query only ever sees backlog/unstarted issues, so without recovery it would sit there forever.
// This function decides — from the stored state entry alone — what to do; recoverStale() in poll.mjs does
// the Linear/state I/O. Kept dependency-free so it's unit-tested directly (test/crash-recovery.test.mjs),
// exactly like watchDecision / admissionWithdrawal / reapableWorktreelessIds.
//
// Policy (unchanged from the original inline logic): recover ONCE — requeue the issue (move it back to a
// pickup state, which RELEASES the WIP slot back into the queue for a fresh run) and bump `recoveries`. A
// SECOND crash after that recovery → stop retrying, flag it for a human. Anything that is NOT a crashed
// 'started' run — a human-owned issue with no record, or a finished/other outcome — is left untouched.
export function recoveryDecision(entry, { maxRecoveries = 1 } = {}) {
  if (!entry || entry.outcome !== 'started') {
    return { action: 'skip', requeue: false, reason: !entry ? 'no autofix record (human-owned issue)' : `outcome "${entry.outcome}" is not a crashed in-progress run` };
  }
  const recoveries = entry.recoveries || 0;
  if (recoveries < maxRecoveries) {
    // First crash (within the retry budget): requeue for ONE retry. The caller moves the issue back to a
    // pickup state (releasing the WIP slot) and records 'recovered' with the bumped count so a subsequent
    // crash is distinguishable. `recoveries` MUST persist for the second-crash detection to work.
    return { action: 'requeue', requeue: true, outcome: 'recovered', recoveries: recoveries + 1 };
  }
  // Crashed again after exhausting the retry budget: do not retry — flag for a human and stop.
  return { action: 'flag', requeue: false, outcome: 'recovery_failed' };
}
