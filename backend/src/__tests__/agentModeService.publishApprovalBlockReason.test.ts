/**
 * ENG-1245 — the dispatch-guard's tool-error text (publishApprovalBlock, the
 * ENG-803 enforcement in executeTool) unconditionally claimed "this schedule
 * has 'Require approval before publishing' turned ON" whenever the resolved
 * authorization was false — including the far more common case of a legacy
 * schedule that was simply never granted standing publish authorization
 * (requirePublishApproval is FALSE; see describePublishAuthorizationWithholdReason
 * in schedulePublishAuthorization.ts and the parallel fix in
 * getScheduledSessionOverride, agentModeSystemPrompt.ts). Session
 * 0e5af215-9c14-4ff3-806e-bbbd0984afaf's schedule (1d001fba-0fb7-4bcd-80f6-6041b244a442,
 * "Harsha Daily X Post (Autonomous)") is exactly this: requirePublishApproval
 * is false, and this schedule has not posted since 2026-08-13.
 *
 * This file pins `publishApprovalBlock`'s text directly (it is not covered by
 * any prior test) so a caller cannot regress it back to the blanket claim.
 */
import { AgentModeService } from '../services/agentModeService';

function block(toolName: string, reason: 'require_publish_approval' | 'not_granted' | 'unverifiable') {
  return (AgentModeService as any).publishApprovalBlock(toolName, reason);
}

describe('AgentModeService.publishApprovalBlock — accurate withhold reason (ENG-1245)', () => {
  it('genuine owner-set hold: still names and blames "Require approval before publishing"', () => {
    const result = block('post_on_connected_account', 'require_publish_approval');
    expect(result.success).toBe(false);
    expect(result.publishApprovalRequired).toBe(true);
    expect(result.error).toContain('this schedule has "Require approval before publishing" turned ON');
    expect(result.error).toContain('turn "Require approval before publishing" OFF');
  });

  it('never-granted: does NOT claim the owner turned on "Require approval before publishing", nor instruct turning it off', () => {
    const result = block('post_on_connected_account', 'not_granted');
    expect(result.success).toBe(false);
    expect(result.publishApprovalRequired).toBe(true);
    expect(result.error).not.toContain('this schedule has "Require approval before publishing" turned ON');
    // May still mention the setting by name to explicitly rule it out (as it does),
    // but must never issue the AFFIRMATIVE instruction to turn it off as the fix.
    expect(result.error).not.toContain('tell the owner they can turn "Require approval before publishing" OFF');
  });

  it('never-granted: tells the truth — a standing authorization grant is missing, not a setting to flip', () => {
    const result = block('post_on_connected_account', 'not_granted');
    expect(result.error).toMatch(/not been granted standing/i);
    expect(result.error).toContain('post_on_connected_account');
  });

  it('unverifiable stays unchanged — a read failure is a distinct, third reason', () => {
    const result = block('post_on_connected_account', 'unverifiable');
    expect(result.error).toContain('could not be verified');
    expect(result.error).not.toContain('tell the owner they can turn "Require approval before publishing" OFF');
  });

  it('every branch still names the tool and states this is an account-level setting, not a platform gate', () => {
    for (const reason of ['require_publish_approval', 'not_granted', 'unverifiable'] as const) {
      const result = block('post_on_connected_account', reason);
      expect(result.error).toContain('post_on_connected_account');
      expect(result.error).toContain('account-level setting');
      expect(result.error).toMatch(/NOT a platform, X\/Twitter, LinkedIn, API, or credential limit/i);
    }
  });
});
