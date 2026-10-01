import {
  exportOutcomeObservationToZ0Safe,
  projectOutcomeObservationToZ0,
  pseudonymousOutcomeSubject,
  type Z0OutcomeFetchLike,
  type Z0OutcomeObservationInput,
} from '../services/z0OutcomeObservation';

const base: Z0OutcomeObservationInput = {
  decisionTraceId: 'a'.repeat(64),
  decisionTime: '2026-10-01T12:00:00Z',
  executionTime: '2026-10-01T12:00:05Z',
  observationTime: '2026-10-01T13:00:00Z',
  window: '1h',
  subjectId: 'raw-customer-42',
  metric: {
    source: 'agentweb.analytics',
    name: 'conversion_rate',
    value: 0.12,
    unit: 'ratio',
    direction: 'higher_better',
  },
};

function response(payload: unknown, status = 200): Z0OutcomeFetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0OutcomeFetchLike;
}

describe('z0 outcome observation ETL', () => {
  it.each([
    ['1h', '2026-10-01T13:00:00Z'],
    ['24h', '2026-10-02T12:00:00Z'],
    ['7d', '2026-10-08T12:00:00Z'],
  ] as const)('projects deterministic %s observations', (window, observationTime) => {
    const first = projectOutcomeObservationToZ0({ ...base, window, observationTime });
    const second = projectOutcomeObservationToZ0({ ...base, window, observationTime });

    expect(first).toEqual(second);
    expect(first.schema).toBe('agentweb.outcome_observation.v1');
    expect(first.observation_id).toMatch(/^agentweb-outcome-[a-f0-9]{64}$/);
    expect(first.subject_ref).toMatch(/^agentweb-subject:[a-f0-9]{24}$/);
    expect(JSON.stringify(first)).not.toContain('raw-customer-42');
    expect(first.quality_authoritative).toBe(false);
  });

  it('keeps one immutable identity when the value changes in the same decision/window/metric slot', () => {
    const first = projectOutcomeObservationToZ0(base);
    const changed = projectOutcomeObservationToZ0({
      ...base,
      metric: { ...base.metric, value: 0.13 },
      observationTime: '2026-10-01T13:05:00Z',
    });
    expect(changed.observation_id).toBe(first.observation_id);
    expect(changed.metric.value).not.toBe(first.metric.value);
  });

  it('separates measurement windows', () => {
    const oneHour = projectOutcomeObservationToZ0(base);
    const day = projectOutcomeObservationToZ0({
      ...base,
      window: '24h',
      observationTime: '2026-10-02T12:00:00Z',
    });
    expect(day.observation_id).not.toBe(oneHour.observation_id);
  });

  it('hashes raw subject identity before export', () => {
    expect(pseudonymousOutcomeSubject('raw-customer-42')).toMatch(
      /^agentweb-subject:[a-f0-9]{24}$/,
    );
    expect(pseudonymousOutcomeSubject('raw-customer-42')).not.toContain('raw-customer-42');
  });

  it('rejects impossible timestamp ordering before export', () => {
    expect(() => projectOutcomeObservationToZ0({
      ...base,
      observationTime: '2026-10-01T11:59:59Z',
    })).toThrow(/predate decisionTime/);
  });

  it('is default-off and makes no network call', async () => {
    const fetchImpl = jest.fn() as unknown as Z0OutcomeFetchLike;
    const result = await exportOutcomeObservationToZ0Safe(base, {
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toEqual({ exported: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exports one bounded observation and preserves replay metadata', async () => {
    const projected = projectOutcomeObservationToZ0(base);
    const fetchImpl = response({
      ok: true,
      observation_id: projected.observation_id,
      replayed: true,
      age_seconds: 3600,
      window_seconds: 3600,
    });
    const result = await exportOutcomeObservationToZ0Safe(base, {
      env: {
        Z0INT_AGENTWEB_OUTCOME_OBSERVE: 'shadow',
        Z0INT_SERVICE_URL: 'http://z0.test/',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result).toMatchObject({
      exported: true,
      reason: 'replayed',
      observation_id: projected.observation_id,
      replayed: true,
      age_seconds: 3600,
      window_seconds: 3600,
    });

    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/observe/outcome');
    const body = JSON.parse(init.body);
    expect(body).toEqual(projected);
    expect(JSON.stringify(body)).not.toContain('raw-customer-42');
  });
});
