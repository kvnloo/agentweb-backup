/**
 * Tests for EventTableEventSource — focused on the `scope` option that keeps a
 * loop measuring its OWN funnel.
 *
 * Acceptance: with scope {landed, landerPath, /ai-eval}, site-wide `landed`
 * events (blog/home) are dropped, but /ai-eval landings and all other funnel
 * event types pass through. The loop measures /ai-eval -> /ai-eval, not
 * all-traffic -> /ai-eval.
 */

import { EventTableEventSource } from '../loops/core/sensors/eventTableEventSource';
import type { DynamoPort, DynamoAttributeMap } from '../loops/core/ports';
import { asLoopId } from '../loops/core/types';

const WINDOW = { start: new Date(0), end: new Date(10_000_000_000_000) };

function item(eventType: string, subjectId: string, ts: string, landerPath?: string): DynamoAttributeMap {
  return {
    loopId: 'ai-eval-funnel',
    tsSession: `${ts}#${subjectId}#${eventType}`,
    eventType,
    subjectId,
    ts,
    ...(landerPath ? { dimensions: { landerPath } } : {}),
  };
}

function dynamoReturning(items: DynamoAttributeMap[]): DynamoPort {
  return {
    putItem: jest.fn(),
    getItem: jest.fn(),
    query: jest.fn().mockResolvedValue({ items }),
  };
}

const ITEMS = [
  item('landed', 's1', '2026-05-26T00:00:00.000Z', '/ai-eval'),
  item('landed', 's2', '2026-05-26T01:00:00.000Z', '/'),
  item('landed', 's3', '2026-05-26T02:00:00.000Z', '/blog/foo'),
  item('landed', 's4', '2026-05-26T03:00:00.000Z'), // no landerPath
  item('form_submitted', 's1', '2026-05-26T00:05:00.000Z'),
  item('eval_started', 's1', '2026-05-26T00:06:00.000Z'),
];

describe('EventTableEventSource scope', () => {
  it('without scope, returns every event (including site-wide landings)', async () => {
    const src = new EventTableEventSource(dynamoReturning(ITEMS), asLoopId('ai-eval-funnel'));
    const evs = await src.fetchEvents(WINDOW);
    expect(evs.filter((e) => e.eventType === 'landed')).toHaveLength(4);
  });

  it('with scope, drops off-/ai-eval landings but keeps /ai-eval + funnel events', async () => {
    const src = new EventTableEventSource(dynamoReturning(ITEMS), asLoopId('ai-eval-funnel'), {
      scope: { eventType: 'landed', dimensionKey: 'landerPath', dimensionValue: '/ai-eval' },
    });
    const evs = await src.fetchEvents(WINDOW);
    const landed = evs.filter((e) => e.eventType === 'landed');
    expect(landed).toHaveLength(1); // only the /ai-eval one
    expect(landed[0].dimensions?.landerPath).toBe('/ai-eval');
    // Funnel events (no landerPath) are untouched by the scope.
    expect(evs.some((e) => e.eventType === 'form_submitted')).toBe(true);
    expect(evs.some((e) => e.eventType === 'eval_started')).toBe(true);
    expect(evs).toHaveLength(3); // 1 landed + form_submitted + eval_started
  });
});
