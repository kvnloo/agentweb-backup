// Unit tests for the detached-handoff helpers behind remotionService.compose (ENG-123
// "timeout on revision"). On a revision pass the sync 5-min compose poll stacked on top
// of clip regeneration blew past the 10-min run wall-clock, so the run was killed
// mid-compose and the user got NO asset. Two pure helpers make the fix testable:
//   - computeRenderPollBudget: bound the poll to the run's remaining budget so compose
//     returns a handoff BEFORE the hard kill.
//   - buildRemotionOutputUrl: the deterministic S3 URL the detached Lambda writes to,
//     handed back so the still-rendering video is retrievable.

import { computeRenderPollBudget, buildRemotionOutputUrl } from '../services/remotionService';

describe('computeRenderPollBudget', () => {
  const pollIntervalMs = 5000;
  const hardCapPolls = 60;

  it('returns the hard cap when no deadline is supplied (unchanged legacy behavior)', () => {
    expect(computeRenderPollBudget({ now: 1_000_000, pollIntervalMs, hardCapPolls })).toBe(60);
  });

  it('caps at the hard cap even when the deadline is far out', () => {
    const now = 1_000_000;
    const renderDeadlineMs = now + 60 * 60 * 1000; // 1h out
    expect(computeRenderPollBudget({ renderDeadlineMs, now, pollIntervalMs, hardCapPolls })).toBe(60);
  });

  it('shrinks the budget to the remaining time when the deadline is near', () => {
    const now = 1_000_000;
    const renderDeadlineMs = now + 30_000; // 30s left → 6 polls at 5s
    expect(computeRenderPollBudget({ renderDeadlineMs, now, pollIntervalMs, hardCapPolls })).toBe(6);
  });

  it('returns 1 (hand off almost immediately) when already past the deadline', () => {
    const now = 1_000_000;
    const renderDeadlineMs = now - 120_000; // 2 min over budget (regen ate it)
    expect(computeRenderPollBudget({ renderDeadlineMs, now, pollIntervalMs, hardCapPolls })).toBe(1);
  });

  it('applies a safety margin so we return before the deadline, not exactly on it', () => {
    const now = 1_000_000;
    const renderDeadlineMs = now + 30_000;
    // 30s remaining minus a 20s margin = 10s → 2 polls
    expect(
      computeRenderPollBudget({ renderDeadlineMs, now, pollIntervalMs, hardCapPolls, safetyMarginMs: 20_000 })
    ).toBe(2);
  });

  it('never returns less than 1 poll even with a huge safety margin', () => {
    const now = 1_000_000;
    const renderDeadlineMs = now + 5_000;
    expect(
      computeRenderPollBudget({ renderDeadlineMs, now, pollIntervalMs, hardCapPolls, safetyMarginMs: 60_000 })
    ).toBe(1);
  });
});

describe('buildRemotionOutputUrl', () => {
  it('matches Remotion getOutputUrlFromMetadata format (s3.<region>/<bucket>/renders/<renderId>/<outName>)', () => {
    const url = buildRemotionOutputUrl(
      'us-east-1',
      'remotionlambda-useast1-abc123',
      'xyz789',
      'users/u1/remotion/1700000000000_final.mp4'
    );
    expect(url).toBe(
      'https://s3.us-east-1.amazonaws.com/remotionlambda-useast1-abc123/renders/xyz789/users/u1/remotion/1700000000000_final.mp4'
    );
  });
});
