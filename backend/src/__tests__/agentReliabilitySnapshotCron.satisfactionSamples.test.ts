/**
 * ENG-1312 criterion 4 (cron wiring half): writeReliabilitySnapshots gains an
 * OPTIONAL `readSatisfactionSamples` dependency. It is deliberately opt-in —
 * when omitted, no network/DB call is made at all — so every existing caller
 * of writeReliabilitySnapshots (including the whole existing
 * agentReliabilitySnapshot.test.ts suite, which never mocks chatbotService)
 * keeps behaving exactly as a pure, network-free unit test. Only the
 * production entry point (runAgentReliabilitySnapshot) wires in the real
 * chatbotDb-backed reader.
 */
import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import { eventToItem } from '../loops/core/sensors/eventTableEventSource';
import { AGENT_MODE_LOOP_ID } from '../loops/instances/agent-mode/eventTypes';
import type { NormalizedEvent } from '../loops/core/types';
import {
  writeReliabilitySnapshots,
  readSatisfactionDimensionSamplesFromChatbotDb,
} from '../cron/agentReliabilitySnapshotCron';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getRecentSessionsPage: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { chatbotDb } = require('../services/chatbotService');

const NOW = new Date('2026-06-14T18:00:00Z');
const clock = { now: () => NOW };

function fakeDynamo(): { port: DynamoPort; store: Map<string, DynamoAttributeMap> } {
  const store = new Map<string, DynamoAttributeMap>();
  const port: DynamoPort = {
    putItem: jest.fn(async (_table: string, item: DynamoAttributeMap) => {
      store.set(`${item.loopId}#${item.tsSession}`, item);
    }),
    getItem: jest.fn(async () => null),
    query: jest.fn(async (params) => {
      const loopId = params.expressionAttributeValues?.[':loopId'];
      const items = [...store.values()].filter((i) => i.loopId === loopId);
      return { items };
    }),
  };
  return { port, store };
}

describe('writeReliabilitySnapshots — satisfaction sample wiring (ENG-1312)', () => {
  beforeEach(() => jest.clearAllMocks());

  // FAIL tests -----------------------------------------------------------

  it('omitting readSatisfactionSamples never calls chatbotDb and still writes a valid snapshot', async () => {
    const { port } = fakeDynamo();
    const written = await writeReliabilitySnapshots({ dynamo: port, clock });
    expect(chatbotDb.getRecentSessionsPage).not.toHaveBeenCalled();
    const row = written.find((s) => s.windowLabel === '24h')!;
    expect(row.satisfactionDimensionSampleCount).toBe(0);
    expect(row.concisionAvg).toBe(0);
  });

  it('a throwing readSatisfactionSamples is swallowed — tool/run metrics are unaffected', async () => {
    const seed: NormalizedEvent[] = [];
    const { port, store } = fakeDynamo();
    for (const e of seed) {
      const item = eventToItem(AGENT_MODE_LOOP_ID, e);
      store.set(`${item.loopId}#${item.tsSession}`, item);
    }
    const readSatisfactionSamples = jest.fn().mockRejectedValue(new Error('dynamo down'));

    const written = await writeReliabilitySnapshots({ dynamo: port, clock, readSatisfactionSamples });

    const row = written.find((s) => s.windowLabel === '24h')!;
    expect(row.satisfactionDimensionSampleCount).toBe(0);
    expect(row.toolSuccessRate).toBe(0); // still computed normally, no crash
  });

  // SUCCESS tests ----------------------------------------------------------

  it('a provided readSatisfactionSamples is called once and merged into the written snapshot', async () => {
    const { port } = fakeDynamo();
    const readSatisfactionSamples = jest.fn().mockResolvedValue([
      { ts: new Date('2026-06-14T01:00:00Z'), concision: 5, instructionCompliance: 5 },
      { ts: new Date('2026-06-14T02:00:00Z'), concision: 1, instructionCompliance: 1 },
    ]);

    const written = await writeReliabilitySnapshots({ dynamo: port, clock, readSatisfactionSamples });

    expect(readSatisfactionSamples).toHaveBeenCalledTimes(1);
    const row = written.find((s) => s.windowLabel === '24h')!;
    expect(row.satisfactionDimensionSampleCount).toBe(2);
    expect(row.concisionAvg).toBeCloseTo(3, 6);
  });

  it('readSatisfactionDimensionSamplesFromChatbotDb maps satisfactionScore.dimensions into samples', async () => {
    chatbotDb.getRecentSessionsPage.mockResolvedValue({
      sessions: [
        {
          sessionId: 's1',
          updatedAt: '2026-06-14T01:00:00Z',
          satisfactionScore: {
            score: 2,
            reason: 'r',
            evaluatedAt: '2026-06-14T01:00:00Z',
            evaluatedMessageIndex: 4,
            dimensions: { goalCompletion: 4, dataAccuracy: 4, outputQuality: 2, concision: 1, instructionCompliance: 2, unnecessaryPermissionRequest: true },
          },
        },
        // No satisfactionScore at all — must be skipped, not crash.
        { sessionId: 's2', updatedAt: '2026-06-14T02:00:00Z' },
      ],
    });

    const samples = await readSatisfactionDimensionSamplesFromChatbotDb({
      startTime: '2026-06-13T18:00:00.000Z',
      endTime: '2026-06-14T18:00:00.000Z',
    });

    expect(samples).toHaveLength(1);
    expect(samples[0].concision).toBe(1);
    expect(samples[0].instructionCompliance).toBe(2);
    expect(samples[0].unnecessaryPermissionRequest).toBe(true);
  });

  it('readSatisfactionDimensionSamplesFromChatbotDb swallows a DB error and returns an empty list', async () => {
    chatbotDb.getRecentSessionsPage.mockRejectedValue(new Error('dynamo down'));

    const samples = await readSatisfactionDimensionSamplesFromChatbotDb({
      startTime: '2026-06-13T18:00:00.000Z',
      endTime: '2026-06-14T18:00:00.000Z',
    });

    expect(samples).toEqual([]);
  });
});
