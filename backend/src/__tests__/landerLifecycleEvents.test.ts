/**
 * Lander lifecycle sensor (2026-06-12): the agent-tool telemetry cannot
 * reconstruct the landing-page funnel because the artifact lifecycle spans two
 * channels (Emma tools AND portal UI) and generic tools (create_html_file)
 * conflate artifacts. These events are emitted at the ROUTE layer — the single
 * chokepoint both channels share — into the shared loop-events table so the
 * funnel (created → iterated/edited → published) reads true.
 */

const putItemMock = jest.fn(async () => undefined);
const putMock = jest.fn(() => ({ promise: putItemMock }));
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({ put: putMock })),
  },
}));

import { emitLanderLifecycle, LANDER_LIFECYCLE_LOOP_ID } from '../services/landerLifecycleEvents';

const putCalls = () => putMock.mock.calls as any[];

beforeEach(() => {
  putMock.mockClear();
  putItemMock.mockClear();
  putItemMock.mockResolvedValue(undefined);
});

describe('emitLanderLifecycle', () => {
  it('writes a created event keyed by pageId with mode and channel dimensions', async () => {
    await emitLanderLifecycle('created', {
      pageId: 'page-1',
      userId: 'u-1',
      channel: 'agent',
      mode: 'cold_start',
      outcome: 'ok',
    });

    const [params] = putCalls().at(-1)!;
    expect(params.TableName).toBe('Dev-AW-LoopEvents');
    expect(params.Item.loopId).toBe(LANDER_LIFECYCLE_LOOP_ID);
    expect(params.Item.eventType).toBe('lander_created');
    expect(params.Item.subjectId).toBe('page-1');
    expect(params.Item.dimensions).toMatchObject({
      userId: 'u-1',
      channel: 'agent',
      mode: 'cold_start',
      outcome: 'ok',
    });
    expect(String(params.Item.tsSession)).toContain('page-1');
  });

  it('writes published and incremental-edit events', async () => {
    await emitLanderLifecycle('published', { pageId: 'page-2', userId: 'u-1', channel: 'ui' });
    await emitLanderLifecycle('edited', { pageId: 'page-2', userId: 'u-1', channel: 'agent', mode: 'incremental' });

    const types = putCalls().map(([p]: any[]) => p.Item.eventType);
    expect(types).toEqual(['lander_published', 'lander_edited']);
  });

  it('includes sessionId when provided and omits empty dimensions', async () => {
    await emitLanderLifecycle('iterated', { pageId: 'page-3', channel: 'agent', sessionId: 'sess-7' });

    const [params] = putCalls().at(-1)!;
    expect(params.Item.dimensions.sessionId).toBe('sess-7');
    expect(params.Item.dimensions).not.toHaveProperty('userId');
    expect(params.Item.dimensions).not.toHaveProperty('outcome');
  });

  it('swallows write errors — telemetry never breaks the request path', async () => {
    putItemMock.mockRejectedValueOnce(new Error('dynamo down'));

    await expect(
      emitLanderLifecycle('created', { pageId: 'page-4', channel: 'ui' }),
    ).resolves.toBeUndefined();
  });
});
