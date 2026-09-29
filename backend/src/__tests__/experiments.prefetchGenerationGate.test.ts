import { PrefetchGenerationGate } from '../experiments/prefetchGenerationGate';

describe('A2 prefetch generation experiment', () => {
  it('rejects an older result after newer intent starts', () => {
    const gate = new PrefetchGenerationGate();
    const oldGeneration = gate.start('session-1');
    const newGeneration = gate.start('session-1');

    expect(gate.canCommit('session-1', oldGeneration)).toBe(false);
    expect(gate.canCommit('session-1', newGeneration)).toBe(true);
  });

  it('enforces a byte/character admission budget', () => {
    const gate = new PrefetchGenerationGate();
    const generation = gate.start('session-1');

    expect(gate.admit({ scope: 'session-1', generation, chars: 7999, maxChars: 8000 })).toBe('admit');
    expect(gate.admit({ scope: 'session-1', generation, chars: 8001, maxChars: 8000 })).toBe('too_large');
  });

  it('keeps independent sessions isolated', () => {
    const gate = new PrefetchGenerationGate();
    const a = gate.start('a');
    gate.start('b');
    expect(gate.canCommit('a', a)).toBe(true);
  });
});
