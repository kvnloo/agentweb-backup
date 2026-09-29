import { packContext } from '../experiments/contextPacketBudget';

describe('A10 context packet budget', () => {
  it('deduplicates by evidence id', () => {
    const packet = packContext([
      { id: 'a', text: '1234', priority: 1, authority: 1 },
      { id: 'a', text: '1234', priority: 1, authority: 1 },
    ], 20);
    expect(packet.items).toHaveLength(1);
  });

  it('keeps bounded context under the character budget', () => {
    const packet = packContext([
      { id: 'a', text: '12345', priority: 5, authority: 5 },
      { id: 'b', text: '67890', priority: 4, authority: 4 },
      { id: 'c', text: 'xxxxx', priority: 1, authority: 1 },
    ], 10);
    expect(packet.chars).toBeLessThanOrEqual(10);
    expect(packet.items.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('prioritizes must-keep evidence before optional context', () => {
    const packet = packContext([
      { id: 'optional', text: '12345', priority: 100, authority: 100 },
      { id: 'required', text: 'abcde', priority: 1, authority: 1, mustKeep: true },
    ], 5);
    expect(packet.items.map((x) => x.id)).toEqual(['required']);
  });
});
