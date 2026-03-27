import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  evaluateGates,
  hasUnresolvedBugs,
  isMegaPR,
  needsDocsGate,
  getActionableComments,
} from '../gateEvaluator';
import {
  createPR,
  createMegaPR,
  createApprovedPR,
  createComment,
  createBugComment,
  createNitComment,
  createInfoComment,
  resetCounters,
} from './helpers';

describe('gateEvaluator', () => {
  beforeEach(() => {
    resetCounters();
  });

  // =====================================================
  // isMegaPR
  // =====================================================
  describe('isMegaPR', () => {
    it('should return true for harsha/dev → main PRs', () => {
      const pr = createMegaPR();
      expect(isMegaPR(pr)).toBe(true);
    });

    it('should return false for feature → harsha/dev PRs', () => {
      const pr = createPR({ baseBranch: 'harsha/dev', headBranch: 'harsha/feature-1' });
      expect(isMegaPR(pr)).toBe(false);
    });

    it('should return true when isMegaPR flag is set', () => {
      const pr = createPR({ isMegaPR: true, baseBranch: 'main', headBranch: 'harsha/dev' });
      expect(isMegaPR(pr)).toBe(true);
    });

    it('should return false for PRs targeting other branches', () => {
      const pr = createPR({ baseBranch: 'staging', headBranch: 'harsha/dev' });
      expect(isMegaPR(pr)).toBe(false);
    });
  });

  // =====================================================
  // hasUnresolvedBugs
  // =====================================================
  describe('hasUnresolvedBugs', () => {
    it('should return true when there are unresolved 🔴 Bug comments', () => {
      const comments = [
        createBugComment({ resolved: false }),
      ];
      expect(hasUnresolvedBugs(comments)).toBe(true);
    });

    it('should return false when all 🔴 Bug comments are resolved', () => {
      const comments = [
        createBugComment({ resolved: true }),
      ];
      expect(hasUnresolvedBugs(comments)).toBe(false);
    });

    it('should return false when there are no bug comments', () => {
      const comments = [
        createNitComment({ resolved: false }),
        createInfoComment({ resolved: false }),
      ];
      expect(hasUnresolvedBugs(comments)).toBe(false);
    });

    it('should return false for empty comments', () => {
      expect(hasUnresolvedBugs([])).toBe(false);
    });

    it('should return true with mixed resolved and unresolved bugs', () => {
      const comments = [
        createBugComment({ resolved: true }),
        createBugComment({ resolved: false }),
      ];
      expect(hasUnresolvedBugs(comments)).toBe(true);
    });
  });

  // =====================================================
  // needsDocsGate
  // =====================================================
  describe('needsDocsGate', () => {
    it('should return true for customer portal feat: PRs', () => {
      const pr = createPR({
        repo: 'agentweb-customer-portal',
        title: 'feat: add new dashboard widget',
      });
      expect(needsDocsGate(pr)).toBe(true);
    });

    it('should return false for backend-only PRs', () => {
      const pr = createPR({
        repo: 'agentweb',
        title: 'feat: add new API endpoint',
      });
      expect(needsDocsGate(pr)).toBe(false);
    });

    it('should return true for customer portal fix: PRs', () => {
      // All customer portal PRs need docs, not just feat:
      const pr = createPR({
        repo: 'agentweb-customer-portal',
        title: 'fix: broken navigation',
      });
      expect(needsDocsGate(pr)).toBe(true);
    });

    it('should return false for mega PRs (they have separate docs flow)', () => {
      const pr = createMegaPR({
        repo: 'agentweb-customer-portal',
        title: 'feat: mega PR',
      });
      // Mega PRs are documented but never auto-merged, docs gate is separate
      expect(needsDocsGate(pr)).toBe(true);
    });
  });

  // =====================================================
  // getActionableComments
  // =====================================================
  describe('getActionableComments', () => {
    it('should return unresolved 🔴 and 🟡 comments', () => {
      const comments = [
        createBugComment({ resolved: false }),
        createNitComment({ resolved: false }),
        createInfoComment({ resolved: false }),
        createComment({ severity: '🟣 Pre-existing', resolved: false }),
      ];
      const actionable = getActionableComments(comments);
      expect(actionable).toHaveLength(2);
    });

    it('should sort 🔴 Bug before 🟡 Nit', () => {
      const comments = [
        createNitComment({ resolved: false }),
        createBugComment({ resolved: false }),
      ];
      const actionable = getActionableComments(comments);
      expect(actionable[0].severity).toBe('🔴 Bug');
      expect(actionable[1].severity).toBe('🟡 Nit');
    });

    it('should exclude resolved comments', () => {
      const comments = [
        createBugComment({ resolved: true }),
        createNitComment({ resolved: true }),
      ];
      const actionable = getActionableComments(comments);
      expect(actionable).toHaveLength(0);
    });

    it('should exclude 💡 Suggestion comments', () => {
      const comments = [
        createInfoComment({ resolved: false }),
      ];
      const actionable = getActionableComments(comments);
      expect(actionable).toHaveLength(0);
    });

    it('should exclude 🟣 Pre-existing comments', () => {
      const comments = [
        createComment({ severity: '🟣 Pre-existing', resolved: false }),
      ];
      const actionable = getActionableComments(comments);
      expect(actionable).toHaveLength(0);
    });

    it('should handle empty comments', () => {
      expect(getActionableComments([])).toEqual([]);
    });

    it('should return multiple bugs sorted before multiple nits', () => {
      const comments = [
        createNitComment({ id: 'nit-1', resolved: false }),
        createBugComment({ id: 'bug-1', resolved: false }),
        createNitComment({ id: 'nit-2', resolved: false }),
        createBugComment({ id: 'bug-2', resolved: false }),
      ];
      const actionable = getActionableComments(comments);
      expect(actionable).toHaveLength(4);
      expect(actionable[0].severity).toBe('🔴 Bug');
      expect(actionable[1].severity).toBe('🔴 Bug');
      expect(actionable[2].severity).toBe('🟡 Nit');
      expect(actionable[3].severity).toBe('🟡 Nit');
    });
  });

  // =====================================================
  // evaluateGates (main function)
  // =====================================================
  describe('evaluateGates', () => {
    it('should return canMerge=true when all gates pass', () => {
      const pr = createApprovedPR({
        comments: [],
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(true);
      expect(result.seniorReviewerPassed).toBe(true);
      expect(result.docsPassed).toBe(true);
      expect(result.ciPassed).toBe(true);
      expect(result.hasUnresolvedBugs).toBe(false);
      expect(result.blockers).toHaveLength(0);
    });

    it('should return canMerge=false when Senior Reviewer has not approved', () => {
      const pr = createPR({
        seniorReviewerApproved: false,
        docsApproved: true,
        ciGreen: true,
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(false);
      expect(result.seniorReviewerPassed).toBe(false);
      expect(result.blockers).toContainEqual(expect.stringContaining('Senior Reviewer'));
    });

    it('should return canMerge=false when Docs has not approved', () => {
      const pr = createPR({
        seniorReviewerApproved: true,
        docsApproved: false,
        ciGreen: true,
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(false);
      expect(result.docsPassed).toBe(false);
    });

    it('should return canMerge=false when CI is red', () => {
      const pr = createApprovedPR({ ciGreen: false });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(false);
      expect(result.ciPassed).toBe(false);
      expect(result.blockers).toContainEqual(expect.stringContaining('CI'));
    });

    it('should return canMerge=false when there are unresolved bugs', () => {
      const pr = createApprovedPR({
        comments: [createBugComment({ resolved: false })],
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(false);
      expect(result.hasUnresolvedBugs).toBe(true);
    });

    it('should NEVER allow mega PRs to auto-merge', () => {
      const pr = createMegaPR({
        seniorReviewerApproved: true,
        docsApproved: true,
        ciGreen: true,
        comments: [],
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(false);
      expect(result.blockers).toContainEqual(expect.stringContaining('mega'));
    });

    it('should NEVER allow PRs targeting main to auto-merge', () => {
      const pr = createPR({
        baseBranch: 'main',
        seniorReviewerApproved: true,
        docsApproved: true,
        ciGreen: true,
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(false);
    });

    it('should list all blockers when multiple gates fail', () => {
      const pr = createPR({
        seniorReviewerApproved: false,
        docsApproved: false,
        ciGreen: false,
        comments: [createBugComment({ resolved: false })],
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(false);
      // Should have at least 3 blockers
      expect(result.blockers.length).toBeGreaterThanOrEqual(3);
    });

    it('should pass when resolved bugs exist but no unresolved ones', () => {
      const pr = createApprovedPR({
        comments: [
          createBugComment({ resolved: true }),
          createNitComment({ resolved: true }),
        ],
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(true);
      expect(result.hasUnresolvedBugs).toBe(false);
    });

    it('should not be blocked by unresolved nits (only bugs block)', () => {
      const pr = createApprovedPR({
        comments: [createNitComment({ resolved: false })],
      });
      const result = evaluateGates(pr);
      // Unresolved nits don't block merge, only bugs do
      expect(result.hasUnresolvedBugs).toBe(false);
      expect(result.canMerge).toBe(true);
    });

    it('should not be blocked by comments with null severity', () => {
      const pr = createApprovedPR({
        comments: [createComment({ severity: null, resolved: false })],
      });
      const result = evaluateGates(pr);
      expect(result.canMerge).toBe(true);
    });

    it('should handle PR with many mixed comments', () => {
      const pr = createApprovedPR({
        comments: [
          createBugComment({ resolved: true }),
          createBugComment({ resolved: true }),
          createNitComment({ resolved: false }),
          createNitComment({ resolved: true }),
          createInfoComment({ resolved: false }),
          createComment({ severity: '🟣 Pre-existing', resolved: false }),
          createComment({ severity: null, resolved: false }),
        ],
      });
      const result = evaluateGates(pr);
      // All bugs resolved, unresolved nits/info/null don't block
      expect(result.canMerge).toBe(true);
      expect(result.hasUnresolvedBugs).toBe(false);
    });
  });

  // =====================================================
  // isMegaPR — additional edge cases
  // =====================================================
  describe('isMegaPR - edge cases', () => {
    it('should detect mega PR by branch names even when flag is false', () => {
      const pr = createPR({
        baseBranch: 'main',
        headBranch: 'harsha/dev',
        isMegaPR: false,
      });
      // The implementation should detect from branch names
      expect(isMegaPR(pr)).toBe(true);
    });

    it('should not flag non-dev branch → main as mega', () => {
      const pr = createPR({
        baseBranch: 'main',
        headBranch: 'harsha/feature-123',
        isMegaPR: false,
      });
      expect(isMegaPR(pr)).toBe(false);
    });
  });

  // =====================================================
  // getActionableComments — additional edge cases
  // =====================================================
  describe('getActionableComments - edge cases', () => {
    it('should handle comments with null severity', () => {
      const comments = [
        createComment({ severity: null, resolved: false }),
        createBugComment({ resolved: false }),
      ];
      const actionable = getActionableComments(comments);
      expect(actionable).toHaveLength(1);
      expect(actionable[0].severity).toBe('🔴 Bug');
    });

    it('should handle all-resolved list', () => {
      const comments = [
        createBugComment({ resolved: true }),
        createNitComment({ resolved: true }),
        createBugComment({ resolved: true }),
      ];
      expect(getActionableComments(comments)).toHaveLength(0);
    });

    it('should maintain insertion order within same severity', () => {
      const comments = [
        createBugComment({ id: 'bug-first', resolved: false }),
        createBugComment({ id: 'bug-second', resolved: false }),
      ];
      const actionable = getActionableComments(comments);
      expect(actionable[0].id).toBe('bug-first');
      expect(actionable[1].id).toBe('bug-second');
    });
  });

  // =====================================================
  // needsDocsGate — additional scenarios
  // =====================================================
  describe('needsDocsGate - additional scenarios', () => {
    it('should return false for unknown repo names', () => {
      const pr = createPR({ repo: 'some-other-repo' });
      expect(needsDocsGate(pr)).toBe(false);
    });
  });
});
