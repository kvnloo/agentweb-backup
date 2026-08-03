// ENG-844: the anti-loop override ("proceed with placeholders / always make
// progress") is designed for MISSING INFORMATION. It must NOT fire when the
// repeated prompt is a verification retry pressing an irreversible/publishing
// write — the blocker there is authorization, not missing context, and no
// placeholder can substitute for consent to publish live. This covers the
// deterministic predicate that gates that suppression.

jest.mock('axios');
jest.mock('../utils/secretsManager');
jest.mock('@google/genai');
// slackService constructs a Slack WebClient at import time; stub it so importing
// the service under test doesn't require Slack env/network (sibling suites do the
// same).
jest.mock('../services/slackService', () => ({}));

import { isIrreversibleWriteRetryPress } from '../services/agentModeService';

describe('isIrreversibleWriteRetryPress', () => {
  it('fires on a verification retry that presses an irreversible/publishing write', () => {
    const presses = [
      'Please try again. Make sure to post_on_connected_account (1 more time needed).',
      'Please try again. Make sure to post_on_connected_account (1 more time needed) and generate_image (1 more time needed).',
      'Please try again. Make sure to post_thread (1 more time needed).',
      'Please try again. Make sure to publish_blog_article (1 more time needed).',
    ];
    presses.forEach((p) => expect(isIrreversibleWriteRetryPress(p)).toBe(true));
  });

  it('does NOT fire on a retry that presses only reversible/non-publishing tools', () => {
    // generate_image is spend, not an irreversible external publish — the override
    // may still help there, so this predicate must not suppress it on its own.
    expect(
      isIrreversibleWriteRetryPress('Please try again. Make sure to generate_image (1 more time needed).')
    ).toBe(false);
    expect(
      isIrreversibleWriteRetryPress('Please try again. Make sure to search_web (1 more time needed).')
    ).toBe(false);
  });

  it('does NOT fire on ordinary user/assistant text that merely names a publish tool', () => {
    // Only the harness's write-call retry prompt has the "Please try again. Make
    // sure to ..." shape; a human describing the tool must not be mistaken for it.
    const nonPresses = [
      'Can you use post_on_connected_account to publish this?',
      'I published today\'s post via post_on_connected_account.',
      'Please try again with a different image.', // retry shape but no publish tool
      '',
      undefined as unknown as string,
      null as unknown as string,
    ];
    nonPresses.forEach((t) => expect(isIrreversibleWriteRetryPress(t)).toBe(false));
  });
});
