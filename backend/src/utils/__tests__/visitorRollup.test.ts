import { rollupVisitors, MAX_USER_PROPS } from '../visitorRollup';

const row = (f: Record<string, any>) => ({ customFields: f });

describe('rollupVisitors (ENG-2690)', () => {
  it('resolves two sessions from one visitorId to one visitor', () => {
    const out = rollupVisitors([
      row({ visitorId: 'vis-aaaa1111', sessionId: 's2', sessionStartMs: 2000 }),
      row({ visitorId: 'vis-aaaa1111', sessionId: 's1', sessionStartMs: 1000 }),
      row({ visitorId: 'vis-bbbb2222', sessionId: 's3', sessionStartMs: 1500 }),
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((v) => v.visitorId === 'vis-aaaa1111')!;
    expect(a.sessionCount).toBe(2);
    expect(a.sessionIds).toEqual(['s1', 's2']);
    expect(a.firstSeenMs).toBe(1000);
    expect(a.lastSeenMs).toBe(2000);
  });

  it('set_once never overwrites; set is last-write-wins; add accumulates (session order, not input order)', () => {
    const [v] = rollupVisitors([
      row({ visitorId: 'vis-aaaa1111', sessionStartMs: 3000, user_set_once: { first_source: 'tiktok' }, user_set: { plan: 'pro' }, user_add: { visits: 1 } }),
      row({ visitorId: 'vis-aaaa1111', sessionStartMs: 1000, user_set_once: { first_source: 'google' }, user_set: { plan: 'free' }, user_add: { visits: 1 } }),
      row({ visitorId: 'vis-aaaa1111', sessionStartMs: 2000, user_add: { visits: '2' } }),
    ]);
    expect(v.userProperties).toEqual({ first_source: 'google', plan: 'pro', visits: 4 });
  });

  it('add treats a non-numeric previous value (boolean) as 0 and ignores boolean deltas', () => {
    const [v] = rollupVisitors([
      row({ visitorId: 'vis-aaaa1111', sessionStartMs: 1000, user_set: { n: true } }),
      row({ visitorId: 'vis-aaaa1111', sessionStartMs: 2000, user_add: { n: 2, m: true } }),
    ]);
    expect(v.userProperties).toEqual({ n: 2 });
  });

  it('skips rows without visitorId and rejects unsafe/unbounded input', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < MAX_USER_PROPS + 10; i++) many[`p${i}`] = i;
    const out = rollupVisitors([
      row({ sessionId: 'x' }),
      { customFields: null },
      row({ visitorId: 'vis-aaaa1111', user_set: { 'bad key!': 1, obj: { a: 1 }, long: 'y'.repeat(1000) }, user_add: { n: 'abc' } }),
      row({ visitorId: 'vis-cccc3333', user_set: many }),
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((v) => v.visitorId === 'vis-aaaa1111')!;
    expect(a.userProperties).toEqual({ long: 'y'.repeat(300) });
    const c = out.find((v) => v.visitorId === 'vis-cccc3333')!;
    expect(Object.keys(c.userProperties)).toHaveLength(MAX_USER_PROPS);
  });

  it('honours an allow-list of user property names', () => {
    const [v] = rollupVisitors(
      [row({ visitorId: 'vis-aaaa1111', user_set: { plan: 'pro', secret: 'x' } })],
      { allowedUserProps: new Set(['plan']) },
    );
    expect(v.userProperties).toEqual({ plan: 'pro' });
  });
});
