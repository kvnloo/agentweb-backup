import { ClaudeRunConflictError, ClaudeRunRegistry } from '../claudeRunRegistry';

function hooks(order: string[] = [], name = 'a') {
  return { refuseNewCalls: jest.fn(() => void order.push(`${name}:refuse`)), abort: jest.fn(() => void order.push(`${name}:abort`)) };
}

describe('ClaudeRunRegistry', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses new bridge calls first, then aborts the host turn', () => {
    const r = new ClaudeRunRegistry();
    const order: string[] = [];
    r.register('s1', 'u1', 'c1', hooks(order));
    expect(r.cancel('s1')).toBe(true);
    expect(order).toEqual(['a:refuse', 'a:abort']);
  });

  it('is a no-op for a session with no Claude turn (an Emma turn, or nothing running)', () => {
    const r = new ClaudeRunRegistry();
    expect(r.cancel('nope')).toBe(false);
    expect(r.cancelConnection('nope')).toBe(0);
    expect(r.cancelOwner('nope')).toBe(0);
  });

  it('acts once when a Stop and a timeout land together', () => {
    const r = new ClaudeRunRegistry();
    const h = hooks();
    r.register('s1', 'u1', 'c1', h);
    r.cancel('s1');
    r.cancel('s1');
    expect(h.refuseNewCalls).toHaveBeenCalledTimes(1);
    expect(h.abort).toHaveBeenCalledTimes(1);
  });

  it('still aborts when refusing new calls throws, and still refuses when abort would throw', () => {
    const r = new ClaudeRunRegistry();
    const h = { refuseNewCalls: jest.fn(() => { throw new Error('boom'); }), abort: jest.fn() };
    r.register('s1', 'u1', 'c1', h);
    expect(() => r.cancel('s1')).not.toThrow();
    expect(h.abort).toHaveBeenCalledTimes(1);

    const h2 = { refuseNewCalls: jest.fn(), abort: jest.fn(() => { throw new Error('boom'); }) };
    r.register('s2', 'u1', 'c1', h2);
    expect(() => r.cancel('s2')).not.toThrow();
    expect(h2.refuseNewCalls).toHaveBeenCalledTimes(1);
  });

  it('refuses a second turn for the same session instead of orphaning the first', () => {
    const r = new ClaudeRunRegistry();
    const first = hooks();
    r.register('s1', 'u1', 'c1', first);
    expect(() => r.register('s1', 'u1', 'c1', hooks())).toThrow(ClaudeRunConflictError);
    r.cancel('s1');
    expect(first.abort).toHaveBeenCalledTimes(1); // the original is still the one that gets stopped
  });

  it('release frees the session, and a stale handle cannot remove a newer entry', () => {
    const r = new ClaudeRunRegistry();
    const a = r.register('s1', 'u1', 'c1', hooks());
    a.release();
    expect(r.has('s1')).toBe(false);
    const b = hooks();
    const second = r.register('s1', 'u1', 'c1', b);
    a.release(); // stale, second time
    expect(r.has('s1')).toBe(true);
    r.cancel('s1');
    expect(b.abort).toHaveBeenCalledTimes(1);
    second.release();
    second.release();
    expect(r.size).toBe(0);
  });

  it('a released turn is no longer stopped by a late Stop', () => {
    const r = new ClaudeRunRegistry();
    const h = hooks();
    r.register('s1', 'u1', 'c1', h).release();
    expect(r.cancel('s1')).toBe(false);
    expect(h.abort).not.toHaveBeenCalled();
  });

  it('a stop for one session leaves every other session alone', () => {
    const r = new ClaudeRunRegistry();
    const a = hooks([], 'a');
    const b = hooks([], 'b');
    r.register('s1', 'u1', 'c1', a);
    r.register('s2', 'u2', 'c2', b);
    r.cancel('s1');
    expect(a.abort).toHaveBeenCalledTimes(1);
    expect(b.abort).not.toHaveBeenCalled();
  });

  it('revoking a connection stops exactly the turns on that connection', () => {
    const r = new ClaudeRunRegistry();
    const a = hooks();
    const b = hooks();
    const c = hooks();
    r.register('s1', 'u1', 'c1', a);
    r.register('s2', 'u1', 'c1', b);
    r.register('s3', 'u2', 'c2', c);
    expect(r.cancelConnection('c1')).toBe(2);
    expect(a.abort).toHaveBeenCalled();
    expect(b.abort).toHaveBeenCalled();
    expect(c.abort).not.toHaveBeenCalled();
  });

  it('cancelAll (process shutdown) stops every running turn once', () => {
    const r = new ClaudeRunRegistry();
    const a = hooks();
    const b = hooks();
    r.register('s1', 'u1', 'c1', a);
    r.register('s2', 'u2', 'c2', b);
    expect(r.cancelAll()).toBe(2);
    expect(r.cancelAll()).toBe(2); // idempotent per entry: the hooks do not run twice
    expect(a.abort).toHaveBeenCalledTimes(1);
    expect(b.abort).toHaveBeenCalledTimes(1);
  });

  it('the kill switch for an owner stops that owner only', () => {
    const r = new ClaudeRunRegistry();
    const a = hooks();
    const b = hooks();
    r.register('s1', 'u1', 'c1', a);
    r.register('s2', 'u2', 'c2', b);
    expect(r.cancelOwner('u1')).toBe(1);
    expect(a.abort).toHaveBeenCalled();
    expect(b.abort).not.toHaveBeenCalled();
  });
});
