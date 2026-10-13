// ENG-1735: a failed scheduled run used to be reported as
//   "Missing function calls: none / Keyword misses: none"
// whenever it failed for a reason other than a missed tool or keyword (deferred
// to an absent human, unfinished work plan, publish/send press exhausted, empty
// output, ...). That alert carries no actionable cause. This derives the
// concrete failing checks from the run result so the auto-filed issue names them.

export interface ScheduledRunFailureSignals {
  success?: boolean;
  content?: string | null;
  functionCallMisses?: string[];
  keywordMisses?: string[];
  workPlanCompleted?: boolean;
  deferredUnresolved?: boolean;
  parkedUnnotifiable?: boolean;
  publishHeldForApproval?: boolean;
  publishRequirementMismatch?: boolean;
  publishToolFailing?: boolean;
  sendPressExhausted?: boolean;
  attempts?: number;
}

export function describeScheduledRunFailureReasons(
  run: ScheduledRunFailureSignals,
  extra: { linkedInInviteSendRequirementMissed?: boolean } = {},
): string[] {
  const reasons: string[] = [];
  if (run.deferredUnresolved) {
    reasons.push('final turn deferred to an absent human (asked for confirmation instead of finishing)');
  }
  if (run.parkedUnnotifiable) {
    reasons.push('run stopped on a blocking question with no channel to reach a human');
  }
  if (run.publishHeldForApproval) reasons.push('publish press budget exhausted with the publish tool uncalled');
  if (run.publishRequirementMismatch) {
    reasons.push('published through a different tool than the schedule requires');
  }
  if (run.publishToolFailing) reasons.push('required publish tool errored on every attempt');
  if (run.sendPressExhausted) reasons.push('send press budget exhausted with a send requirement still unmet');
  if (extra.linkedInInviteSendRequirementMissed) {
    reasons.push('LinkedIn invite send requirement not met');
  }
  if (run.workPlanCompleted === false) reasons.push('work plan not completed');

  const hasMisses = (run.functionCallMisses?.length ?? 0) > 0 || (run.keywordMisses?.length ?? 0) > 0;
  // Empty assistant text is normal for tool-call-only turns, so it only names the
  // failure when nothing more specific does.
  if (reasons.length === 0 && !hasMisses && (!run.content || !String(run.content).trim())) {
    reasons.push('empty final response');
  }
  if (reasons.length === 0 && !hasMisses) {
    reasons.push(
      `run did not succeed after ${run.attempts ?? 'unknown'} attempt(s) with no missed tool or keyword recorded ` +
        '(likely timeout or completion gate exhausted) — inspect the session transcript',
    );
  }
  return reasons;
}
