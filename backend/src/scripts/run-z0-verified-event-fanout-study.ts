#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  exportVerifiedEventBatchToZ0Safe,
  projectVerifiedEventBatchToZ0,
} from '../services/z0VerifiedEventBatch';

const base = {
  provider: 'example-provider',
  externalEventId: 'evt-provider-secret-123',
  eventType: 'analytics.updated',
  eventTime: '2026-09-02T12:00:00Z',
  receivedAt: '2026-09-02T12:00:01Z',
  subjectId: 'raw-customer-verified-event',
  verification: {
    verified: true,
    scheme: 'hmac-sha256',
    verifiedAt: '2026-09-02T12:00:01Z',
  },
  payload: {
    customer: {
      id: 'raw-customer-verified-event',
      authorization: 'Bearer SECRET-RAW-TOKEN',
    },
    metrics: {
      conversion_rate: 0.16,
    },
  },
  outcomes: [
    {
      decisionTraceId: 'a'.repeat(64),
      decisionTime: '2026-09-01T12:00:00Z',
      executionTime: '2026-09-01T12:00:05Z',
      observationTime: '2026-09-01T13:00:00Z',
      window: '1h' as const,
      subjectId: 'raw-customer-verified-event',
      metric: {
        source: 'agentweb.analytics',
        name: 'conversion_rate',
        value: 0.12,
        unit: 'ratio',
        direction: 'higher_better' as const,
      },
    },
    {
      decisionTraceId: 'a'.repeat(64),
      decisionTime: '2026-09-01T12:00:00Z',
      executionTime: '2026-09-01T12:00:05Z',
      observationTime: '2026-09-02T12:00:00Z',
      window: '24h' as const,
      subjectId: 'raw-customer-verified-event',
      metric: {
        source: 'agentweb.analytics',
        name: 'conversion_rate',
        value: 0.16,
        unit: 'ratio',
        direction: 'higher_better' as const,
      },
    },
  ],
};

async function main() {
  const output = process.argv[2] ?? '/tmp/z0-verified-event-fanout-study.json';
  const env = {
    ...process.env,
    Z0INT_AGENTWEB_EVENT_FORWARD: 'shadow',
  } as NodeJS.ProcessEnv;

  const projected = projectVerifiedEventBatchToZ0(base);
  const serialized = JSON.stringify(projected);

  const first = await exportVerifiedEventBatchToZ0Safe(base, { env });
  const replay = await exportVerifiedEventBatchToZ0Safe(base, { env });
  const mutation = await exportVerifiedEventBatchToZ0Safe({
    ...base,
    payload: {
      ...(base.payload as Record<string, unknown>),
      metrics: {
        conversion_rate: 0.17,
      },
    },
  }, { env });

  const result = {
    schema: 'z0eval.agentweb_verified_event_fanout_e2e.v1',
    projected,
    first,
    replay,
    mutation,
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');

  for (const forbidden of [
    'evt-provider-secret-123',
    'raw-customer-verified-event',
    'Bearer SECRET-RAW-TOKEN',
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error(`raw provider material leaked: ${forbidden}`);
    }
  }

  if (!first.exported || first.reason !== 'stored' || first.fanout_count !== 2) {
    throw new Error('first verified event did not store and fan out exactly twice');
  }
  if (!replay.exported || replay.reason !== 'replayed' || replay.fanout_count !== 2) {
    throw new Error('exact verified event replay did not deduplicate');
  }
  if (mutation.exported || mutation.reason !== 'http_400') {
    throw new Error('changed payload under one event identity did not conflict');
  }
  if (mutation.event_id !== first.event_id) {
    throw new Error('payload mutation unexpectedly changed event identity');
  }

  process.stderr.write('z0 verified event fanout study passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
