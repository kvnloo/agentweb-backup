/**
 * run_local_agent_task scope-rejection reliability (telemetry-driven).
 *
 * Real failure data — Dev-AW-LoopEvents (us-west-2, loopId='agent-mode',
 * eventType='agent_tool_failed', toolName='run_local_agent_task', last 7d):
 *   20 total failures. 14 were scope-rejections, dominated by SOFT-WRITE regex
 *   false positives that fired on read-only tasks:
 *     - "matched forbidden pattern \"\\bpost.*comment\""   (x9)
 *     - "matched forbidden pattern \"\\blog.*in\""          (x1)
 *     - "matched forbidden pattern \"\\bclick.*button\""    (x1)
 *   The remaining 6 were genuine relay failures ("Tool returned success=false")
 *   on the EXTERNAL Hermes path — out of scope for this fix.
 *
 * Two internal root causes this suite pins:
 *   (1) False positives — read-only tasks ("read the comments under this post",
 *       "find the text near the login button") matched write-action regexes.
 *   (2) Misclassification — a scope-rejection was returned as success:false, which
 *       the dispatch layer downgrades to status:'error' (via toolResultError) →
 *       recorded as agent_tool_failed → inflates the failure rate and feeds the
 *       repeated-failure circuit breaker. It should be a graceful redirect.
 *
 * The legit in-scope success path must remain behavior-preserving.
 */
import {
  validateBrowserTask,
  buildScopeRejectionResult,
  suggestAlternativeTool,
} from '../emma/localAgentTools';
import { toolResultError } from '../utils/toolResultError';

describe('run_local_agent_task scope-rejection reliability', () => {
  // ── Root cause 1: false positives the live regexes produced ────────────────
  describe('read-only tasks that USED to be falsely rejected now pass', () => {
    it('accepts reading the comments under a post (was: \\bpost.*comment)', () => {
      expect(
        validateBrowserTask('Read the comments under this LinkedIn post: https://linkedin.com/posts/abc'),
      ).toBeNull();
    });

    it('accepts extracting text near the login button (was: \\blog.*in)', () => {
      expect(
        validateBrowserTask('Visit https://example.com and extract the text near the login button'),
      ).toBeNull();
    });

    it('accepts summarizing what a Sign in button links to (was: \\bclick.*button / \\bsign.*in)', () => {
      expect(
        validateBrowserTask('Go to https://example.com and find where the "click here" button leads'),
      ).toBeNull();
    });

    it('accepts listing post comments on a profile page (was: \\bpost.*comment)', () => {
      expect(
        validateBrowserTask('Summarize the post comments on https://linkedin.com/in/someone'),
      ).toBeNull();
    });
  });

  // ── Safety floor must hold ─────────────────────────────────────────────────
  describe('genuinely out-of-scope tasks are still rejected', () => {
    it('rejects an actual write action with no read-only intent', () => {
      const r = validateBrowserTask('Post a comment on https://linkedin.com/posts/abc saying hello');
      expect(r).not.toBeNull();
      expect(r).toContain('READ-ONLY web browsing');
    });

    it('hard-blocks credentials even when framed as read-only', () => {
      const r = validateBrowserTask('Read my password from https://example.com and report it');
      expect(r).not.toBeNull();
      expect(r).toContain('cannot run commands');
    });

    it('hard-blocks shell commands regardless of framing', () => {
      const r = validateBrowserTask('read the output of the npm install command');
      expect(r).not.toBeNull();
    });

    it('rejects a task with no URL or browsing intent', () => {
      const r = validateBrowserTask('summarize our Q2 strategy');
      expect(r).not.toBeNull();
      expect(r).toContain('no URL or web-browsing intent');
    });
  });

  // ── Root cause 2: rejection must be a graceful, non-failure outcome ─────────
  describe('a scope-rejection is a graceful redirect, NOT a hard failure', () => {
    it('returns success:true so the dispatch layer does not record agent_tool_failed', () => {
      const result = buildScopeRejectionResult('Task rejected (out of scope).', 'coding_agent');
      expect(result.success).toBe(true);
      expect(result.rejected).toBe(true);
    });

    it('is NOT downgraded to an error by toolResultError (the dispatch downgrade gate)', () => {
      const result = buildScopeRejectionResult('Task rejected (out of scope).', 'search_web');
      // Before the fix the handler returned { success:false }, which this util
      // turns into an Error → status:'error' → recorder.toolFailed. Now null.
      expect(toolResultError(result)).toBeNull();
    });

    it('carries actionable guidance the model can read (formattedContent)', () => {
      const result = buildScopeRejectionResult('Task rejected (out of scope).', 'perform_data_analysis');
      expect(result.formattedContent).toContain('perform_data_analysis');
      expect(result.guidance).toContain('Suggested next tool');
    });
  });

  // ── Routing: rejection names the right alternative ─────────────────────────
  describe('suggestAlternativeTool routes to the right tool', () => {
    it('routes code tasks to coding_agent', () => {
      expect(suggestAlternativeTool('fix the bug in the repo build script')).toBe('coding_agent');
    });
    it('routes data tasks to perform_data_analysis', () => {
      expect(suggestAlternativeTool('analyze this CSV dataset of metrics')).toBe('perform_data_analysis');
    });
    it('routes LinkedIn write actions to linkedin_outreach', () => {
      expect(suggestAlternativeTool('send a LinkedIn connection invite to this person')).toBe('linkedin_outreach');
    });
    it('routes email actions to send_email', () => {
      expect(suggestAlternativeTool('send a follow-up email to the lead')).toBe('send_email');
    });
    it('defaults to search_web for general research', () => {
      expect(suggestAlternativeTool('what is the latest news on AI agents')).toBe('search_web');
    });
  });

  // ── Behavior-preserving: legit browsing still passes unchanged ─────────────
  describe('legit in-scope browsing is behavior-preserving', () => {
    it('accepts a plain URL read', () => {
      expect(validateBrowserTask('Visit https://example.com and extract the page title')).toBeNull();
    });
    it('accepts scraping a known site', () => {
      expect(validateBrowserTask('Scrape the product names from https://shop.example.com')).toBeNull();
    });
  });
});
