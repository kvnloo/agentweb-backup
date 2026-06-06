/**
 * Tests for the "Slack suggest" reply guidance.
 *
 * Background: in the slack-triggered "suggest" flow — where a message from an
 * OUTSIDE contact lands in a connected Slack channel and Emma should suggest a
 * reply the account owner can send back — Emma sometimes misbehaved by either
 * (a) treating the incoming text as something to send back verbatim / deflecting
 * ("that's not a marketing task"), or (b) thinking IT was the named person being
 * addressed (e.g. "Walter") instead of drafting on the owner's behalf.
 *
 * The guidance lives in SLACK_SUGGEST_REPLY_GUIDANCE and is folded into the base
 * system message in agentModeService.generateMarketingResponse ONLY when
 * pageIdentifier === 'slack-triggered'. These tests pin the guidance content and confirm it is NOT
 * baked into the global base prompt, so every other session type — regular portal
 * chat, tasks, scheduled runs, and the other Slack flows (slack-bot /
 * slack-bot-admin) — is unaffected.
 */

import {
  AGENT_MODE_SYSTEM_PROMPT,
  SLACK_SUGGEST_REPLY_GUIDANCE,
} from '../docs/agentModeSystemPrompt';

describe('Slack suggest reply guidance', () => {
  it('instructs Emma to draft a reply for the account owner, not send the incoming text back', () => {
    // Core fix for failure mode (a): never echo the received text out; always draft.
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/WRITE the text of a reply/);
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/AS the account owner replying to the sender/);
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/context to reply to, NOT text to echo or re-send/);
  });

  it('forbids deflecting with "not a marketing task", "can\'t send", or "sent by mistake"', () => {
    // The regression observed live: Emma stalled/deflected instead of drafting.
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/that's not a marketing task/);
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/sent by mistake/);
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/do not need any tool/);
  });

  it('requires the drafted reply to be the first line of output', () => {
    // Addresses the softer score-3 pattern: agent stalls with questions, no draft.
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/FIRST line of output must be the drafted reply/);
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/NEVER open by explaining what you can't do/);
  });

  it('includes an identity safeguard so Emma does not mistake itself for the named person', () => {
    // Core fix for failure mode (b): Emma is not the named participant.
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/NOT a named human participant/);
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/that name is the account owner you are drafting FOR, never you/);
    expect(SLACK_SUGGEST_REPLY_GUIDANCE).toMatch(/Do NOT assume you are personally being addressed/);
  });

  it('is scoped: the global base prompt does NOT contain the suggest-reply guidance', () => {
    // Guards against regressing back to a global injection that would affect
    // every agent-mode session instead of only the slack-triggered flow.
    expect(AGENT_MODE_SYSTEM_PROMPT).not.toContain(SLACK_SUGGEST_REPLY_GUIDANCE);
    expect(AGENT_MODE_SYSTEM_PROMPT).not.toMatch(/Slack Suggest — Draft a Reply/);
  });
});
