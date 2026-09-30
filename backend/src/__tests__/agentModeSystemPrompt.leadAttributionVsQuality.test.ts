import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-2211: In a CRM chat thread, Emma listed 5 CRM leads (3 Google, 1 Meta, 1 rebate-page)
// in turn 1. In turn 2, asked "how many solid leads should we have", Emma answered "You have
// 0" — zeroing Google's 3 CRM-attributed leads because the customer had earlier called them
// "mistakes" (a quality judgment), applying that judgment to an attribution question. Turn 3
// then dropped a lead from the count (5 -> 4) without explanation and mixed a 7-day window
// with a 30-day window across turns. Turn 1 also treated a platform/CRM discrepancy (Google
// Ads 0 conversions vs 3 CRM-attributed Google leads; Meta pixel 79 vs 1 CRM lead) as if it
// were a lead count, rather than flagging it as a tracking defect.
describe('Agent Mode system prompt — lead attribution vs lead quality discipline', () => {
  it('has a dedicated lead attribution vs quality section', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('## Lead Attribution vs Lead Quality (CRITICAL)');
  });

  it('forbids a quality judgment on a lead from changing its attribution count', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'does not retroactively zero out the attribution count for its channel'
    );
  });

  it('requires attribution and quality to be reported as separate, labeled numbers', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Report attribution and quality as two SEPARATE numbers'
    );
  });

  it('requires CRM to be treated as the source of truth over platform pixel/conversion counts', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'CRM records are the source of truth for lead counts, not platform pixel/conversion numbers'
    );
  });

  it('requires a platform-vs-CRM count mismatch to be flagged as a tracking defect, not reported as a lead count', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'that disagreement is a tracking/pixel-configuration defect to flag'
    );
  });

  it('requires a consistent, explicitly stated date window per rollup', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'State the date window next to every count, and keep it constant within a rollup'
    );
  });

  it('forbids a lead count from silently shrinking or growing between turns without explanation', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'never let a total silently shrink or grow without explanation'
    );
  });
});
