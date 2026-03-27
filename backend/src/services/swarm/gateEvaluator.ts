/**
 * Swarm Pipeline — Gate Evaluator
 *
 * Evaluates whether a PR has passed both merge gates:
 * 1. Senior Reviewer ✅ Approve
 * 2. Docs ✅ Documented
 *
 * Also checks CI status and unresolved comment conditions.
 */

import { PullRequestState, PRComment } from './types';

export interface GateResult {
  canMerge: boolean;
  seniorReviewerPassed: boolean;
  docsPassed: boolean;
  ciPassed: boolean;
  hasUnresolvedBugs: boolean;
  blockers: string[];
}

/**
 * Evaluate all merge gates for a PR.
 * A PR can be auto-merged when:
 * - Senior Reviewer has approved (✅ Approve)
 * - Docs agent has documented (✅ Documented)
 * - CI is green
 * - No unresolved 🔴 Bug comments
 *
 * Special rules:
 * - Mega PRs (harsha/dev → main) are NEVER auto-merged
 * - PRs targeting main are NEVER auto-merged
 */
export function evaluateGates(pr: PullRequestState): GateResult {
  const seniorReviewerPassed = pr.seniorReviewerApproved;
  const docsPassed = pr.docsApproved;
  const ciPassed = pr.ciGreen;
  const unresolvedBugs = hasUnresolvedBugs(pr.comments);
  const mega = isMegaPR(pr);

  const blockers: string[] = [];
  if (!seniorReviewerPassed) blockers.push('Senior Reviewer has not approved');
  if (!docsPassed) blockers.push('Docs have not been approved');
  if (!ciPassed) blockers.push('CI is not green');
  if (unresolvedBugs) blockers.push('Unresolved bug comments exist');
  if (mega) blockers.push('Cannot auto-merge mega PR');
  if (pr.baseBranch === 'main') blockers.push('Cannot auto-merge to main');

  const canMerge =
    seniorReviewerPassed &&
    docsPassed &&
    ciPassed &&
    !unresolvedBugs &&
    !mega &&
    pr.baseBranch !== 'main';

  return {
    canMerge,
    seniorReviewerPassed,
    docsPassed,
    ciPassed,
    hasUnresolvedBugs: unresolvedBugs,
    blockers,
  };
}

/**
 * Check if a PR has unresolved bug comments (🔴 severity).
 */
export function hasUnresolvedBugs(comments: PRComment[]): boolean {
  return comments.some(c => c.severity === '🔴 Bug' && !c.resolved);
}

/**
 * Check if a PR is a mega PR (harsha/dev → main).
 */
export function isMegaPR(pr: PullRequestState): boolean {
  return pr.isMegaPR === true || (pr.baseBranch === 'main' && pr.headBranch === 'harsha/dev');
}

/**
 * Determine if a PR needs docs gate (customer portal feat: PRs).
 * Backend-only PRs get auto-documented.
 */
export function needsDocsGate(pr: PullRequestState): boolean {
  return pr.repo === 'agentweb-customer-portal';
}

/**
 * Get unresolved comments by severity, sorted by fix priority.
 * 🔴 Bug before 🟡 Nit. Skip 💡/🟣 (informational).
 */
export function getActionableComments(comments: PRComment[]): PRComment[] {
  const actionable = comments.filter(
    c => !c.resolved && (c.severity === '🔴 Bug' || c.severity === '🟡 Nit')
  );
  return actionable.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === '🔴 Bug' ? -1 : 1;
  });
}
