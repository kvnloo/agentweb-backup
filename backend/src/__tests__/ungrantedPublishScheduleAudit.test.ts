/**
 * ENG-1245 follow-up — a DETERMINISTIC replacement for the detection path this
 * ticket accidentally deleted.
 *
 * Before this fix, judges incorrectly penalized a correctly-withheld publish,
 * and the daily satisfaction report auto-files a ticket for low-scoring
 * sessions — that accidental chain is the only reason this ticket exists (it
 * took three occurrences, and the pipeline that investigated it still reached
 * the wrong root cause). Now that judges correctly stop penalizing honest
 * withholding, that chain goes dark for every OTHER schedule stuck in the same
 * state (never granted standing publish authorization, so
 * resolveSchedulePublishAuthorization resolves 'not_granted') — there is
 * nothing left to notice it.
 *
 * This does not infer anything from a transcript or an LLM's opinion. It reads
 * three deterministic facts straight off the schedule record: (1) the schedule
 * is active and its own prompt signals it means to publish unattended, (2) its
 * resolved authorization is unauthorized for the 'not_granted' reason
 * specifically — NOT a genuine owner-set "Require approval before publishing"
 * hold, which is correct, intentional behavior and must never be flagged as a
 * problem, and (3) how long it has actually been since a publish-capable tool
 * was last called, from runResults.
 */
import {
  findUngrantedPublishingSchedules,
  scheduleSignalsPublishIntent,
} from '../utils/ungrantedPublishScheduleAudit';

function schedule(over: Record<string, any> = {}) {
  return {
    scheduleId: 'sched-1',
    scheduleName: 'Harsha Daily X Post (Autonomous)',
    userId: 'user-1',
    status: 'active',
    startingMessage: 'Post directly with post_on_connected_account. No approval — autonomous run.',
    requiredFunctionCalls: ['twitter_outreach'],
    runResults: [],
    ...over,
  };
}

const NOW = new Date('2026-08-20T12:00:00.000Z');

describe('scheduleSignalsPublishIntent', () => {
  it('matches post/publish/tweet/reply in the prompt or schedule name', () => {
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Post this to X today' })).toBe(true);
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Publish a blog article' })).toBe(true);
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Tweet about the launch' })).toBe(true);
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Reply to mentions' })).toBe(true);
    expect(scheduleSignalsPublishIntent({ scheduleName: 'Daily Lead Enrichment', startingMessage: '' })).toBe(false);
  });

  it('does not match an unrelated, read-only schedule', () => {
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Summarize yesterday\'s leads into a report' })).toBe(false);
  });

  it('is false on missing/empty fields, never throws', () => {
    expect(scheduleSignalsPublishIntent({})).toBe(false);
    expect(scheduleSignalsPublishIntent({ startingMessage: undefined, scheduleName: undefined })).toBe(false);
  });

  /**
   * ENG-1245 — deliberately OVER-inclusive, unlike the customer-portal hint's
   * identical-looking function of the same name (ScheduleFormPanel.tsx). The two
   * diverge on purpose: this audit is the only thing left watching for a schedule
   * silently stuck unauthorized — the judge-score signal that used to (accidentally)
   * surface this bug class is now correctly suppressed for honest withholding, so
   * nothing else catches a schedule that goes unwatched. A false negative here means
   * a broken schedule stays invisible to EVERYTHING, indefinitely — worse than the
   * UI hint's false negative, which just means one editor visit didn't warn the
   * owner of a problem the audit would still catch on its own pass. A false positive
   * here costs a reviewer one extra glance at an admin-reviewed list; a false
   * positive in the UI hint is a recurring, per-visit "the app is wrong" moment that
   * teaches distrust. So this function does NOT exclude "post(s)" used as a noun
   * ("recent posts", "blog post") the way the UI hint does — a schedule phrased that
   * way, with an uncovered synonym verb ("send it live", "share it"), would
   * otherwise be missed by an audit whose whole job is not missing things.
   */
  it('matches "post(s)" even when noun-shaped, unlike the customer-portal hint — recall matters more here', () => {
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Analyze recent posts and their engagement' })).toBe(true);
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Summarize the latest blog post for the newsletter' })).toBe(true);
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Which LinkedIn posts got the most reach this month?' })).toBe(true);
  });

  it('still matches "post" used as a verb, including at the start of an instruction', () => {
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Post directly to X. No approval needed.' })).toBe(true);
    expect(scheduleSignalsPublishIntent({ startingMessage: 'Draft the content, then post it to LinkedIn.' })).toBe(true);
  });
});

describe('findUngrantedPublishingSchedules (ENG-1245)', () => {
  it('flags the exact reported shape: active, publish-intent prompt, never granted', () => {
    const findings = findUngrantedPublishingSchedules([schedule()], NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ scheduleId: 'sched-1', scheduleName: 'Harsha Daily X Post (Autonomous)', userId: 'user-1' });
  });

  it('does NOT flag a schedule with standing publish authorization already granted', () => {
    const findings = findUngrantedPublishingSchedules(
      [schedule({ autopublishAuthorized: true, autopublishAuthorizedTools: ['post_on_connected_account'] })],
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it('does NOT flag a genuine owner-set "Require approval before publishing" hold — that is correct, intentional behavior', () => {
    const findings = findUngrantedPublishingSchedules([schedule({ requirePublishApproval: true })], NOW);
    expect(findings).toEqual([]);
  });

  it('does NOT flag an explicitly REVOKED grant either — also a real, intentional owner decision, not a bug', () => {
    const findings = findUngrantedPublishingSchedules(
      [schedule({ autopublishAuthorized: false })],
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it('does NOT flag an inactive schedule', () => {
    const findings = findUngrantedPublishingSchedules([schedule({ status: 'inactive' })], NOW);
    expect(findings).toEqual([]);
  });

  it('does NOT flag a schedule whose prompt has no publish intent (e.g. a report/analysis schedule)', () => {
    const findings = findUngrantedPublishingSchedules(
      [
        schedule({
          scheduleName: 'Daily Satisfaction Score Report',
          startingMessage: 'Summarize the last 24 hours of sessions into a report.',
        }),
      ],
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it('does NOT flag a legacy schedule already authorized via the requiredFunctionCalls opt-out', () => {
    const findings = findUngrantedPublishingSchedules(
      [schedule({ requiredFunctionCalls: ['post_on_connected_account'] })],
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it('reports undefined daysSinceLastPublish when runResults shows no publish call ever', () => {
    const findings = findUngrantedPublishingSchedules(
      [
        schedule({
          runResults: [
            { createdAt: '2026-08-13T08:20:00.000Z', actualFunctionCalls: ['twitter_outreach', 'save_memory'] },
            { createdAt: '2026-08-20T08:19:00.000Z', actualFunctionCalls: ['twitter_outreach'] },
          ],
        }),
      ],
      NOW,
    );

    expect(findings[0].daysSinceLastPublish).toBeUndefined();
    expect(findings[0].everPublished).toBe(false);
    expect(findings[0].lastRunAt).toBe('2026-08-20T08:19:00.000Z');
  });

  /**
   * CodeRabbit (PR #2517) — real ambiguity, caught before it shipped.
   * daysSinceLastPublish returning undefined was documented to mean ONLY "no
   * run in the available history ever called a publish-capable tool" — but a
   * publish-capable call whose OWN run has a missing OR malformed createdAt
   * also produced undefined, silently conflating "never published" with
   * "published, but we don't know when" into the same value. The CLI then
   * reported the latter as "never published in the available history", which
   * is false and could mislead an admin triaging a list of these — a
   * schedule that has proven it CAN publish reads identically to one that
   * never has.
   */
  it.each([
    ['a missing createdAt', undefined],
    ['a malformed createdAt', 'not-a-real-date'],
  ])('distinguishes "never published" from "published, but %s" via everPublished', (_label, createdAt) => {
    const findings = findUngrantedPublishingSchedules(
      [schedule({ runResults: [{ createdAt, actualFunctionCalls: ['post_on_connected_account'] }] })],
      NOW,
    );

    // A publish call WAS found — this must not read the same as "never published",
    // even though the day count is unavailable either way.
    expect(findings[0].daysSinceLastPublish).toBeUndefined();
    expect(findings[0].everPublished).toBe(true);
  });

  it('reports a real days count (and everPublished true) for a valid publish timestamp', () => {
    const findings = findUngrantedPublishingSchedules(
      [
        schedule({
          runResults: [{ createdAt: '2026-08-05T08:19:00.000Z', actualFunctionCalls: ['post_on_connected_account'] }],
        }),
      ],
      NOW,
    );

    expect(findings[0].everPublished).toBe(true);
    expect(findings[0].daysSinceLastPublish).toBe(15);
  });

  it('computes daysSinceLastPublish from the most recent run that DID call a publish tool', () => {
    const findings = findUngrantedPublishingSchedules(
      [
        schedule({
          runResults: [
            { createdAt: '2026-08-05T08:19:00.000Z', actualFunctionCalls: ['post_on_connected_account'] },
            // Consent was revoked or expired after this — still unauthorized now, but it DID publish before.
            { createdAt: '2026-08-13T08:20:00.000Z', actualFunctionCalls: ['twitter_outreach'] },
            { createdAt: '2026-08-20T08:19:00.000Z', actualFunctionCalls: ['twitter_outreach'] },
          ],
        }),
      ],
      NOW,
    );

    expect(findings[0].daysSinceLastPublish).toBe(15);
  });

  it('recognizes a publish call made through an equivalent-route tool (e.g. twitter_manage_post), not just the literal name', () => {
    const findings = findUngrantedPublishingSchedules(
      [
        schedule({
          runResults: [{ createdAt: '2026-08-19T08:19:00.000Z', actualFunctionCalls: ['twitter_manage_post'] }],
        }),
      ],
      NOW,
    );
    expect(findings[0].daysSinceLastPublish).toBe(1);
  });

  it('is safe on missing/malformed runResults — never throws', () => {
    expect(() => findUngrantedPublishingSchedules([schedule({ runResults: undefined })], NOW)).not.toThrow();
    expect(() => findUngrantedPublishingSchedules([schedule({ runResults: null })], NOW)).not.toThrow();
    const findings = findUngrantedPublishingSchedules([schedule({ runResults: [{}, { actualFunctionCalls: null }] })], NOW);
    expect(findings[0].daysSinceLastPublish).toBeUndefined();
  });

  it('is safe on an empty or malformed schedule list', () => {
    expect(findUngrantedPublishingSchedules([], NOW)).toEqual([]);
    expect(findUngrantedPublishingSchedules([null, undefined, {}] as any, NOW)).toEqual([]);
  });

  it('flags multiple independent schedules, unaffected by each other', () => {
    const findings = findUngrantedPublishingSchedules(
      [
        schedule({ scheduleId: 'sched-1', userId: 'user-1' }),
        schedule({ scheduleId: 'sched-2', userId: 'user-2', scheduleName: 'Kevin — X Evening Post', autopublishAuthorized: true, autopublishAuthorizedTools: ['post_on_connected_account'] }),
        schedule({ scheduleId: 'sched-3', userId: 'user-3', scheduleName: 'Fangfang LinkedIn Post' }),
      ],
      NOW,
    );

    expect(findings.map((f) => f.scheduleId).sort()).toEqual(['sched-1', 'sched-3']);
  });
});
