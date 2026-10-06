import type { ReliabilityEvent } from '../services/reliabilityEvent';
import { proposeReliabilityLessons, RELIABILITY_LEARNING_PREFIX } from '../services/reliabilityLearning';
import {
  getReliabilityEventSink,
  getReliabilityLessonProposals,
  recordReliabilityEventSafe,
  setReliabilityEventSinkForTests,
} from '../services/reliabilityEventSink';

const NOW = new Date('2026-09-27T18:00:00.000Z');

function event(overrides: Partial<ReliabilityEvent> = {}): ReliabilityEvent {
  return {
    at: '2026-09-27T17:00:00.000Z',
    tool: 'create_social_media_posts',
    sessionId: 's1',
    userId: 'u1',
    outcome: 'success',
    latencyMs: 10,
    ...overrides,
  };
}

describe('H-LEARN-2a reliability lesson proposals', () => {
  it('proposes repeated failure only after three distinct sessions and enough signal', () => {
    const events = [
      event({ sessionId: 's1', outcome: 'error', errorSummary: 'secret customer value A' }),
      event({ sessionId: 's2', outcome: 'timeout', errorSummary: 'secret customer value B' }),
      event({ sessionId: 's3', outcome: 'error', errorSummary: 'secret customer value C' }),
      event({ sessionId: 's4', outcome: 'success' }),
    ];

    const proposals = proposeReliabilityLessons(events, 'u1', NOW);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      signal: 'repeated_failure',
      reviewState: 'proposed',
      evidence: { sampleSize: 3, totalObserved: 4, distinctSessions: 3, signalRate: 0.75 },
    });
    expect(proposals[0].lessonId).toMatch(new RegExp(`^${RELIABILITY_LEARNING_PREFIX}[a-f0-9]{64}$`));
    expect(JSON.stringify(proposals[0])).not.toContain('secret customer value');
  });

  it('does not count repeated failures from one session as independent evidence', () => {
    const events = [
      event({ sessionId: 's1', outcome: 'error' }),
      event({ sessionId: 's1', outcome: 'error' }),
      event({ sessionId: 's1', outcome: 'timeout' }),
    ];
    expect(proposeReliabilityLessons(events, 'u1', NOW)).toEqual([]);
  });

  it('does not promote rare failures from an otherwise healthy tool', () => {
    const failures = ['s1', 's2', 's3'].map((sessionId) => event({ sessionId, outcome: 'error' }));
    const successes = Array.from({ length: 10 }, (_, i) => event({ sessionId: `ok-${i}`, outcome: 'success' }));
    expect(proposeReliabilityLessons([...failures, ...successes], 'u1', NOW)).toEqual([]);
  });

  it('ignores policy/workflow outcomes rather than learning from expected blocks', () => {
    const events = [
      event({ sessionId: 's1', outcome: 'blocked' }),
      event({ sessionId: 's2', outcome: 'skipped' }),
      event({ sessionId: 's3', outcome: 'pending_confirmation' }),
      event({ sessionId: 's4', outcome: 'user_refused' }),
    ];
    expect(proposeReliabilityLessons(events, 'u1', NOW)).toEqual([]);
  });

  it('does not treat the current userEdit hint as verified edit evidence', () => {
    const events = [
      event({ sessionId: 's1', userEdit: true }),
      event({ sessionId: 's2', userEdit: true }),
      event({ sessionId: 's3', userEdit: true }),
    ];
    expect(proposeReliabilityLessons(events, 'u1', NOW)).toEqual([]);
  });

  it('is user-scoped, time-bounded, and deterministic', () => {
    const old = event({ sessionId: 'old', outcome: 'error', at: '2026-07-01T00:00:00.000Z' });
    const foreign = event({ sessionId: 'foreign', userId: 'u2', outcome: 'error' });
    const current = ['a', 'b', 'c'].map((sessionId) => event({ sessionId, outcome: 'error' }));

    const a = proposeReliabilityLessons([old, foreign, ...current], 'u1', NOW);
    const b = proposeReliabilityLessons([...current].reverse(), 'u1', NOW);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].lessonId).toBe(b[0].lessonId);
    expect(a[0].createdAt).toBe('2026-09-27T17:00:00.000Z');
    expect(a[0].updatedAt).toBe('2026-09-27T17:00:00.000Z');
    expect(a[0].expiresAt).toBe('2026-10-27T17:00:00.000Z');
    expect(a[0].evidence).toMatchObject({ sampleSize: 3, distinctSessions: 3 });
  });


  it('snapshot consumers cannot mutate canonical evidence', () => {
    const sink = getReliabilityEventSink({ RELIABILITY_EVENT_SINK: 'memory' } as NodeJS.ProcessEnv);
    setReliabilityEventSinkForTests(sink);
    try {
      recordReliabilityEventSafe({
        tool: 'create_social_media_posts',
        outcome: 'error',
        latencyMs: 10,
        sessionId: 's1',
        userId: 'u1',
      });
      const first = sink.snapshot();
      first[0].tool = 'mutated-by-consumer';
      expect(sink.snapshot()[0].tool).toBe('create_social_media_posts');
    } finally {
      setReliabilityEventSinkForTests(null);
    }
  });

  it('proposal reads are non-destructive and keep evidence-anchored expiry', async () => {
    const sink = getReliabilityEventSink({ RELIABILITY_EVENT_SINK: 'memory' } as NodeJS.ProcessEnv);
    setReliabilityEventSinkForTests(sink);
    try {
      for (const sessionId of ['s1', 's2', 's3']) {
        recordReliabilityEventSafe({
          tool: 'create_social_media_posts',
          outcome: 'error',
          latencyMs: 10,
          sessionId,
          userId: 'u1',
        });
      }

      const before = sink.snapshot();
      expect(before).toHaveLength(3);

      const latestRecordedAt = Math.max(...before.map((event) => Date.parse(event.at)));
      const first = await getReliabilityLessonProposals(
        'u1',
        new Date(latestRecordedAt + 60 * 60 * 1000),
      );
      const second = await getReliabilityLessonProposals(
        'u1',
        new Date(latestRecordedAt + 2 * 60 * 60 * 1000),
      );

      expect(sink.snapshot()).toEqual(before);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0].lessonId).toBe(first[0].lessonId);
      expect(second[0].createdAt).toBe(first[0].createdAt);
      expect(second[0].expiresAt).toBe(first[0].expiresAt);
      expect(first[0].expiresAt).toBe(
        new Date(Date.parse(first[0].evidence.lastAt) + 30 * 24 * 60 * 60 * 1000).toISOString(),
      );
    } finally {
      setReliabilityEventSinkForTests(null);
    }
  });
});
