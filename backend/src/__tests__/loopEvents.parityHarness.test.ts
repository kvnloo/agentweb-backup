/**
 * ENG-1652: verifier-owned, isolated parity harness for POST /api/loop-events.
 *
 * Production cannot safely prove the positive path: a valid allowlisted event
 * persists shared telemetry in Dev-AW-LoopEvents. This harness gives the
 * post-merge verifier an exact-head equivalent that mutates nothing shared:
 *
 *   write path  — the real `routes/loopEvents` router (validation, allowlist,
 *                 `eventToItem` row shape), with the DynamoDB DocumentClient
 *                 redirected into an in-memory table owned by this file.
 *   read path   — the real production sensor `EventTableEventSource`, reading
 *                 that same in-memory table through a DynamoPort adapter.
 *
 * Isolation / retention: no AWS client is constructed, no customer org,
 * funnel, report or notification is touched. The table is created empty
 * before every test and cleared after it (deterministic cleanup, zero
 * retention). Credentials: none required. Run with:
 *   cd backend && npx jest src/__tests__/loopEvents.parityHarness.test.ts
 */

type Row = Record<string, unknown>;
const fixtureTable: Row[] = [];

jest.mock('aws-sdk', () => {
  const client = {
    put: jest.fn((params: { TableName: string; Item: Row }) => ({
      promise: async () => {
        fixtureTable.push({ __table: params.TableName, ...params.Item });
        return {};
      },
    })),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => client) },
    config: { update: jest.fn() },
  };
});

import express from 'express';
import request from 'supertest';
import loopEventsRoutes from '../routes/loopEvents';
import { registerOrReplaceLoop } from '../loops';
import { aiReadinessManifest } from '../loops/instances/ai-readiness-funnel/manifest';
import { asLoopId } from '../loops/core/types';
import type { DynamoPort, DynamoAttributeMap } from '../loops/core/ports';
import { EventTableEventSource, LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';

/** Read-only DynamoPort over the fixture table: partition query on loopId. */
const fixturePort: DynamoPort = {
  async putItem() {
    throw new Error('harness reader must not write');
  },
  async getItem() {
    return null;
  },
  async query(params) {
    const loopId = params.expressionAttributeValues?.[':loopId'];
    const items = fixtureTable
      .filter((r) => r.__table === params.tableName && r.loopId === loopId)
      .map(({ __table, ...rest }) => rest as DynamoAttributeMap);
    return { items };
  },
};

// The exact payload the hireemma.ai homepage popup fires (see ENG-911).
const HOMEPAGE_POPUP_EVENT = {
  loopId: 'ai-readiness-funnel',
  eventType: 'roadmap_popup_viewed',
  subjectId: 'eng1652-verifier-subject',
  dimensions: { landerPath: '/', surface: 'site_popup', offer: 'ai_readiness_roadmap' },
};

describe('POST /api/loop-events — isolated parity harness (ENG-1652)', () => {
  let app: express.Express;

  beforeAll(() => {
    registerOrReplaceLoop(aiReadinessManifest);
  });

  beforeEach(() => {
    fixtureTable.length = 0;
    app = express();
    app.use(express.json());
    app.use('/api/loop-events', loopEventsRoutes);
  });

  afterEach(() => {
    fixtureTable.length = 0;
  });

  it('accepts the real roadmap_popup_viewed payload and the production sensor reads it back', async () => {
    const before = new Date(Date.now() - 1000);
    const res = await request(app).post('/api/loop-events').send(HOMEPAGE_POPUP_EVENT);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });

    // Persisted exactly once, into the production table name, isolated here.
    expect(fixtureTable).toHaveLength(1);
    expect(fixtureTable[0].__table).toBe(LOOP_EVENTS_TABLE);

    const sensor = new EventTableEventSource(fixturePort, asLoopId('ai-readiness-funnel'));
    const events = await sensor.fetchEvents({ start: before, end: new Date(Date.now() + 1000) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'roadmap_popup_viewed',
      subjectId: 'eng1652-verifier-subject',
      dimensions: HOMEPAGE_POPUP_EVENT.dimensions,
    });
  });

  it.each([
    [{}, 'loopId required'],
    [{ loopId: 'ai-readiness-funnel' }, 'eventType required'],
    [{ loopId: 'ai-readiness-funnel', eventType: 'roadmap_popup_viewed' }, 'subjectId required'],
  ])('rejects malformed payload %j with a named-field 400 and persists nothing', async (body, error) => {
    const res = await request(app).post('/api/loop-events').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(fixtureTable).toHaveLength(0);
  });

  it('rejects an unallowlisted event type naming it, with no persisted row', async () => {
    const res = await request(app)
      .post('/api/loop-events')
      .send({ ...HOMEPAGE_POPUP_EVENT, eventType: 'not_a_real_event' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'event_type_not_allowed', eventType: 'not_a_real_event' });
    expect(fixtureTable).toHaveLength(0);
  });
});
