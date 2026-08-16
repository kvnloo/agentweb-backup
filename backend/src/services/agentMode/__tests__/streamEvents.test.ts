import { RunEmitter, RunEvent, StreamPart } from '../streamEvents';

describe('RunEmitter', () => {
  it('emits a versioned run envelope with a stable sequence', () => {
    const events: RunEvent[] = [];
    const emitter = new RunEmitter('run-1', (event) => events.push(event));

    emitter.emit({ type: 'text-delta', text: 'hello' });
    emitter.emit({ type: 'finish', reason: 'stop' });

    expect(events).toEqual([
      { v: 1, runId: 'run-1', seq: 0, part: { type: 'text-delta', text: 'hello' } },
      { v: 1, runId: 'run-1', seq: 1, part: { type: 'finish', reason: 'stop' } },
    ]);
  });

  it.each<StreamPart>([
    { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } },
    { type: 'tool-output-available', toolCallId: 'call-1', output: { ok: true } },
    { type: 'tool-approval-request', toolCallId: 'call-1', toolName: 'send', input: {} },
  ])('preserves typed tool part payloads: %p', (part) => {
    const events: RunEvent[] = [];
    new RunEmitter('run-1', (event) => events.push(event)).emit(part);
    expect(events[0].part).toEqual(part);
  });

  it('does not sequence or alter legacy progress delivered through the adapter', () => {
    const progress = { iteration: 2, status: 'thinking', toolCalls: [] };
    const legacy: unknown[] = [];
    const emitter = new RunEmitter('run-1', () => { throw new Error('legacy path emitted a new wire event'); }, (value) => legacy.push(value));

    emitter.emitLegacy(progress);

    expect(legacy).toEqual([progress]);
  });

  it('supports the boundary of an emitter without a legacy adapter', () => {
    const events: RunEvent[] = [];
    const emitter = new RunEmitter('', (event) => events.push(event));

    expect(emitter.emit({ type: 'finish', reason: 'cancelled' })).toEqual({
      v: 1,
      runId: '',
      seq: 0,
      part: { type: 'finish', reason: 'cancelled' },
    });
    emitter.emitLegacy({ iteration: 0, status: 'cancelled' });

    expect(events).toHaveLength(1);
  });

  it('propagates sink failures without fabricating a successful event', () => {
    const sink = jest.fn(() => {
      throw new Error('sink unavailable');
    });
    const emitter = new RunEmitter('run-1', sink);

    expect(() => emitter.emit({ type: 'text-delta', text: 'hello' })).toThrow('sink unavailable');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('preserves sequencing after a sink failure for the next successful event', () => {
    const events: RunEvent[] = [];
    let fail = true;
    const emitter = new RunEmitter('run-1', (event) => {
      if (fail) {
        fail = false;
        throw new Error('transient sink failure');
      }
      events.push(event);
    });

    expect(() => emitter.emit({ type: 'text-delta', text: 'dropped' })).toThrow('transient sink failure');
    emitter.emit({ type: 'finish', reason: 'error' });

    expect(events[0]).toMatchObject({ runId: 'run-1', seq: 1 });
  });
});
