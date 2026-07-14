import {
  buildDailyDigestClaimItem,
  claimLoopDailyDigestPost,
} from '../loops/core/digest/dailyDigestClaim';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import type { DynamoPort } from '../loops/core/ports';

describe('daily digest claim helper', () => {
  it('builds one deterministic claim key per loop and date', () => {
    const item = buildDailyDigestClaimItem({
      loopId: 'agent-mode',
      digestDate: '2026-06-29',
      slackUserId: 'U08TM4QFQ1L',
      runId: 'run_1',
      now: new Date('2026-06-29T17:30:00.000Z'),
    });

    expect(item.loopId).toBe('agent-mode#daily-digest');
    expect(item.tsSession).toBe('2026-06-29');
    expect(item.subjectId).toBe('U08TM4QFQ1L');
    expect(item.dimensions.runId).toBe('run_1');
  });

  it('uses atomic putItemIfAbsent when the port supports it', async () => {
    const dynamo = {
      putItemIfAbsent: jest.fn().mockResolvedValue(false),
      putItem: jest.fn(),
      getItem: jest.fn(),
      query: jest.fn(),
    } as unknown as DynamoPort;

    await expect(
      claimLoopDailyDigestPost(dynamo, {
        loopId: 'onboarding',
        digestDate: '2026-06-29',
        slackUserId: 'U08TM4QFQ1L',
        runId: 'run_2',
      }),
    ).resolves.toBe(false);

    expect(dynamo.putItemIfAbsent).toHaveBeenCalledWith(
      LOOP_EVENTS_TABLE,
      expect.objectContaining({ loopId: 'onboarding#daily-digest', tsSession: '2026-06-29' }),
      ['loopId', 'tsSession'],
    );
    expect(dynamo.getItem).not.toHaveBeenCalled();
  });

  it('falls back to get then put for in-memory test ports', async () => {
    const dynamo = {
      putItem: jest.fn().mockResolvedValue(undefined),
      getItem: jest.fn().mockResolvedValue(null),
      query: jest.fn(),
    } as unknown as DynamoPort;

    await expect(
      claimLoopDailyDigestPost(dynamo, {
        loopId: 'ai-eval',
        digestDate: '2026-06-29',
        slackUserId: 'U08TM4QFQ1L',
        runId: 'run_3',
      }),
    ).resolves.toBe(true);

    expect(dynamo.getItem).toHaveBeenCalledWith(
      LOOP_EVENTS_TABLE,
      { loopId: 'ai-eval#daily-digest', tsSession: '2026-06-29' },
    );
    expect(dynamo.putItem).toHaveBeenCalledTimes(1);
  });
});
