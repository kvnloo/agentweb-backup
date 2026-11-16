import { pagingResourceKey, recordPagingCalls, PAGING_SPIRAL_THRESHOLD } from '../pagingSpiral';

const call = (name: string, args: any) => ({ function: { name, arguments: JSON.stringify(args) } });

describe('ENG-2778 paging-spiral detection', () => {
  it('collapses calls that differ only by offset/limit to one key', () => {
    expect(pagingResourceKey(call('get_session_transcript', { session_id: 'a', offset: 0, limit: 5 })))
      .toBe(pagingResourceKey(call('get_session_transcript', { limit: 25, session_id: 'a', offset: 140 })));
  });

  it('keeps different targets distinct', () => {
    expect(pagingResourceKey(call('get_session_transcript', { session_id: 'a', offset: 0 })))
      .not.toBe(pagingResourceKey(call('get_session_transcript', { session_id: 'b', offset: 0 })));
  });

  it('ignores calls with no pagination args and unparseable args', () => {
    expect(pagingResourceKey(call('get_leads', { listId: 'x' }))).toBeNull();
    expect(pagingResourceKey({ function: { name: 'x', arguments: '{bad' } })).toBeNull();
  });

  it('trips exactly once at the threshold for the ff58eb53 shape (varying offsets)', () => {
    const counts = new Map<string, number>();
    const offsets = [0, 25, 7, 60, 33, 90, 120, 15, 150, 175, 200];
    const trips = offsets.map((offset) =>
      recordPagingCalls(counts, [call('get_session_transcript', { session_id: 'ff58eb53', offset, limit: 25 })]),
    );
    const firstTrip = trips.findIndex((t) => t.length > 0);
    expect(firstTrip).toBe(PAGING_SPIRAL_THRESHOLD - 1);
    expect(trips.filter((t) => t.length > 0)).toHaveLength(1);
  });

  it('does not trip when paging spreads under threshold across sessions', () => {
    const counts = new Map<string, number>();
    const tripped: string[] = [];
    for (const s of ['a', 'b', 'c', 'd', 'e']) {
      for (let i = 0; i < PAGING_SPIRAL_THRESHOLD - 1; i++) {
        tripped.push(...recordPagingCalls(counts, [call('get_session_transcript', { session_id: s, offset: i * 25 })]));
      }
    }
    expect(tripped).toEqual([]);
  });
});
