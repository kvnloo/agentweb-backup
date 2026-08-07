// ENG-844: the anti-loop override ("proceed with placeholders / always make
// progress") is designed for MISSING INFORMATION. It must NOT fire when the
// repeated prompt is a verification retry pressing a required tool CALL — a
// placeholder cannot satisfy a tool call, and for an irreversible/publishing
// write the override becomes pressure to publish off-cadence or fabricate
// success. These cover the deterministic predicates that gate that suppression.

jest.mock('axios');
jest.mock('../utils/secretsManager');
jest.mock('@google/genai');
// slackService constructs a Slack WebClient at import time; stub it so importing
// the service under test doesn't require Slack env/network (sibling suites do the
// same).
jest.mock('../services/slackService', () => ({}));

import {
  isVerificationFunctionCallRetryPress,
  pressesIrreversiblePublishWrite,
} from '../services/agentModeService';

describe('isVerificationFunctionCallRetryPress', () => {
  it('fires on any verification retry pressing a required tool call', () => {
    const presses = [
      'Please try again. Make sure to post_on_connected_account (1 more time needed).',
      'Please try again. Make sure to generate_image (1 more time needed), post_on_connected_account (1 more time needed).',
      'Please try again. Make sure to post_thread (1 more time needed).',
      'Please try again. Make sure to publish_blog_article (1 more time needed).',
      // The edge that motivated generalizing: a reversible-tool-only press must
      // ALSO suppress the override (a placeholder can't satisfy the call either).
      'Please try again. Make sure to generate_image (2 more times needed).',
    ];
    presses.forEach((p) => expect(isVerificationFunctionCallRetryPress(p)).toBe(true));
  });

  it('does NOT fire on ordinary text or a keyword-only reminder', () => {
    // Only the harness's function-call retry prompt carries the "(N more time(s)
    // needed)" suffix; a human describing the tool, or a keyword-only nudge, must
    // not be mistaken for it.
    const nonPresses = [
      'Can you use post_on_connected_account to publish this?',
      "I published today's post via post_on_connected_account.",
      'Please try again. Make sure to include these keywords: growth, retention.',
      'Please try again with a different image.',
      '',
      undefined as unknown as string,
      null as unknown as string,
    ];
    nonPresses.forEach((t) => expect(isVerificationFunctionCallRetryPress(t)).toBe(false));
  });
});

describe('pressesIrreversiblePublishWrite', () => {
  it('is true only when the press names an irreversible/publishing write', () => {
    expect(
      pressesIrreversiblePublishWrite('Please try again. Make sure to post_on_connected_account (1 more time needed).')
    ).toBe(true);
    // Reversible-only press: still suppressed (above), but not flagged irreversible.
    expect(
      pressesIrreversiblePublishWrite('Please try again. Make sure to generate_image (1 more time needed).')
    ).toBe(false);
    // Not a press at all.
    expect(pressesIrreversiblePublishWrite('post_on_connected_account is a publishing tool.')).toBe(false);
  });
});
