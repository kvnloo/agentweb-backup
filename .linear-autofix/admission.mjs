// .linear-autofix/admission.mjs — pure decision helpers for admission gating + the merge-watch safety
// boundary (ENG-654). Dependency-free so poll.mjs, autofix.mjs, gc.mjs, and the chat server share ONE
// source of truth, and the policy is unit-tested directly (test/admission.test.mjs). No I/O, no Linear
// calls: callers pass in the live issue / diff numstat; these functions only DECIDE.

const norm = (s) => String(s || '').trim().toLowerCase();

// Linear has no native "blocked" state TYPE (types: triage/backlog/unstarted/started/completed/canceled),
// so a human "pulling an issue out of the autofix lane" shows up as: a completed/canceled state, a state
// literally NAMED "Blocked", or the fixability-gate blocked label. Done/Canceled are the two done types.
const WITHDRAWN_STATE_TYPES = new Set(['completed', 'canceled']);

// Does the live issue still carry the force label (case-insensitive)?
export function hasForceLabel(issue, forceLabel) {
  const want = norm(forceLabel);
  if (!want) return false;
  return (issue?.labels?.nodes || []).some((l) => norm(l.name) === want);
}

// 1. ADMISSION SNAPSHOT — recorded at forced pickup; authoritative for the whole run. Captures WHAT made
//    the issue admissible (force label + who it was assigned to + its state type) so a later live re-check
//    can tell whether a human has since withdrawn that admission.
export function admitSnapshot(issue, at) {
  const a = issue?.assignee || null;
  return {
    forceLabel: true,
    assignee: a ? { name: a.name || a.displayName || null, email: a.email || null } : null,
    stateType: issue?.state?.type || null,
    at: at || new Date().toISOString(),
  };
}

// 2. WITHDRAWAL — compare the ORIGINAL admission against the LIVE issue. Returns {withdrawn, reason}.
//    Withdrawn when a human has: removed the force label, moved the issue to Done/Canceled/Blocked, or
//    reassigned it to a DIFFERENT person. Fails SAFE: a missing admit (never force-admitted / legacy run)
//    or an absent live issue (transient read) returns not-withdrawn, so we never abort on missing data.
export function admissionWithdrawal(admit, liveIssue, config = {}) {
  if (!admit || !admit.forceLabel) return { withdrawn: false, reason: null };
  if (!liveIssue) return { withdrawn: false, reason: null };
  const forceLabel = config.forceLabel;
  const blockedLabel = config.fixabilityGate?.blockedLabel;

  if (!hasForceLabel(liveIssue, forceLabel)) {
    return { withdrawn: true, reason: `the "${forceLabel}" label was removed` };
  }
  const type = norm(liveIssue.state?.type);
  const name = norm(liveIssue.state?.name);
  const hasBlockedLabel = blockedLabel
    && (liveIssue.labels?.nodes || []).some((l) => norm(l.name) === norm(blockedLabel));
  if (WITHDRAWN_STATE_TYPES.has(type) || name === 'blocked' || hasBlockedLabel) {
    return { withdrawn: true, reason: `issue moved to ${liveIssue.state?.name || type || 'a terminal/blocked state'}` };
  }
  const admitEmail = norm(admit.assignee?.email);
  const liveEmail = norm(liveIssue.assignee?.email);
  if (admitEmail && liveEmail && admitEmail !== liveEmail) {
    return { withdrawn: true, reason: `reassigned from ${admit.assignee.email} to ${liveIssue.assignee.email}` };
  }
  return { withdrawn: false, reason: null };
}

// Convenience: is an admitted run still valid (NOT withdrawn) against the live issue?
export function admissionValid(admit, liveIssue, config = {}) {
  return !admissionWithdrawal(admit, liveIssue, config).withdrawn;
}

// 3. MERGE GATE — a PR may be merged ONLY when ALL FOUR hold. Returns {allow, blockedReasons[]} so the
//    caller can surface a precise MERGE_BLOCKED. Gates:
//      (a) a standing EXPLICIT merge instruction (button always counts; NL only when nlMergeTrigger is on)
//      (b) CI green   (c) Greptile pass   (d) admission still valid
export function mergeGateDecision({ standingMergeInstruction, source, ciGreen, greptilePass, admissionValid: admOk } = {}, config = {}) {
  const nlAllowed = config.chat?.nlMergeTrigger !== false; // default ON; false => button-only
  const instructionValid = source === 'nl'
    ? (!!standingMergeInstruction && nlAllowed)
    : !!standingMergeInstruction; // button / unknown source: trust the boolean
  const blockedReasons = [];
  if (!instructionValid) {
    blockedReasons.push(source === 'nl' && !nlAllowed
      ? 'natural-language merge trigger is disabled (config.chat.nlMergeTrigger=false) — use the Merge button'
      : 'no standing explicit merge instruction');
  }
  if (!ciGreen) blockedReasons.push('CI is not green');
  if (!greptilePass) blockedReasons.push('Greptile has not passed');
  if (!admOk) blockedReasons.push('admission is no longer valid (the issue was withdrawn from the autofix lane)');
  return { allow: blockedReasons.length === 0, blockedReasons };
}

// 4. SIGNAL-SUPPRESSION — reject a "fix" whose NET diff only deletes/skips/weakens tests or silences a
//    reliability signal. A real fix adds product code; a change that merely removes tests, adds skip/only
//    markers, or silences a monitor/assert without touching product logic must be routed to a human,
//    never merged. `files` is git numstat: [{path, added, removed}].
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.snap$|_test\.py$|test_.*\.py$/i;
export const isTestPath = (p) => TEST_PATH.test(String(p || ''));

export function classifyNetDiff(files = []) {
  let testAdded = 0, testRemoved = 0, prodAdded = 0, prodRemoved = 0, touchedTest = false, touchedProd = false;
  for (const f of files || []) {
    const a = Number(f.added) || 0, r = Number(f.removed) || 0;
    if (isTestPath(f.path)) { testAdded += a; testRemoved += r; touchedTest = touchedTest || (a + r) > 0; }
    else { prodAdded += a; prodRemoved += r; touchedProd = touchedProd || (a + r) > 0; }
  }
  return { testAdded, testRemoved, prodAdded, prodRemoved, touchedTest, touchedProd };
}

export function signalSuppressionVerdict(files = [], opts = {}) {
  const c = classifyNetDiff(files);
  const skipsAdded = Number(opts.skipsAdded) || 0;          // new it.skip/xit/describe.only, @pytest.mark.skip, etc.
  const reliabilitySilenced = !!opts.reliabilitySignalSilenced; // review judged the change silences a monitor/assert/throw
  const addsProductCode = c.prodAdded > 0;                  // genuine fix code landed
  // Weakens tests = touched tests AND the net test change removes/skips coverage (added <= removed).
  const weakensTests = c.touchedTest && (c.testRemoved > 0 || skipsAdded > 0) && c.testAdded <= c.testRemoved;

  if (!addsProductCode && (weakensTests || skipsAdded > 0 || reliabilitySilenced)) {
    const why = reliabilitySilenced
      ? 'net diff only silences a reliability signal, with no product-code fix'
      : skipsAdded > 0
        ? `net diff only skips/weakens tests (${skipsAdded} skip/only marker(s) added; no product code changed)`
        : `net diff only deletes/weakens tests (${c.testRemoved} test line(s) removed, ${c.testAdded} added; no product code changed)`;
    return { suppressed: true, reason: why };
  }
  return { suppressed: false, reason: null };
}
