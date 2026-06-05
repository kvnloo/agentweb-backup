/**
 * Tests for the pasted-inbound-message guidance in the Agent Mode system prompt.
 *
 * Background: Emma sometimes misinterprets a pasted inbound Slack/chat message —
 * either (a) assuming it should SEND the pasted text verbatim to a channel, or
 * (b) thinking IT is being personally addressed (mistaking itself for a named
 * human colleague) instead of recognizing the user wants a drafted reply.
 *
 * These tests pin the behavioral guidance that fixes both failure modes so a
 * future prompt edit can't silently drop it.
 */

import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

describe('Agent Mode system prompt — pasted inbound message handling', () => {
  it('includes a dedicated section about pasted inbound messages', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/Pasted Inbound Messages/i);
  });

  it('instructs Emma to draft a reply rather than send the pasted original', () => {
    // The core fix for failure mode (a): never send the received text verbatim.
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/DRAFT a reply/);
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/pasted text is what was RECEIVED, not what should be sent/);
  });

  it('requires producing a draft first, not only asking a clarifying question', () => {
    // Addresses the softer score-3 pattern: agent stalls with questions, no draft.
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/never end your turn having only asked a clarifying question with no draft/i);
  });

  it('includes an identity safeguard so Emma does not mistake itself for a named human', () => {
    // The core fix for failure mode (b): Emma is not a named participant.
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/NOT a named human participant/);
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/Do NOT assume you are being personally addressed/);
  });

  it('clarifies Emma replies on behalf of the user, not as the named recipient', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/on behalf of the USER/);
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/from the user's point of view/);
  });

  it('still only sends when the user explicitly instructs a send', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/Only send a message when the user explicitly instructs you to send/);
  });
});
