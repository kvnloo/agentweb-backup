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
    expect(findings[0].lastRunAt).toBe('2026-08-20T08:19:00.000Z');
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
