/**
 * ENG-2113: the reconnect guard. A worker's "this login is dead" claim marks a customer's connection only through these rules; the global circuit breaker bounds what a
 * compromised worker can do to many customers at once.
 */
import { MARK_WINDOW_MS, MAX_MARKS_PER_WINDOW, ReconnectGuard } from '../reconnectGuard';

describe('ReconnectGuard', () => {
  let now = 1_000_000;
  const mk = () => new ReconnectGuard(() => now);
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('one plain signal does not mark; the second consecutive one does; a good turn in between resets', () => {
    const g = mk();
    expect(g.note('c1')).toBe(false);
    g.reset('c1');
    expect(g.note('c1')).toBe(false);
    expect(g.note('c1')).toBe(true);
  });

  it('confirmed evidence marks at once, then the 5 minute cool-down holds', () => {
    const g = mk();
    expect(g.noteConfirmed('c1')).toBe(true);
    expect(g.noteConfirmed('c1')).toBe(false);
    now += 5 * 60_000 + 1;
    expect(g.noteConfirmed('c1')).toBe(true);
  });

  it('breaker: more than 5 different connections within 10 minutes: the 6th is refused, with ONE alert line per window', () => {
    const g = mk();
    for (let i = 0; i < MAX_MARKS_PER_WINDOW; i++) expect(g.noteConfirmed(`c${i}`)).toBe(true);
    expect(g.noteConfirmed('c-six')).toBe(false);
    expect(g.noteConfirmed('c-seven')).toBe(false);
    expect((console.error as jest.Mock).mock.calls.filter((c) => c[0] === '[reconnect-guard] mark_breaker_open')).toHaveLength(1);
  });

  it('breaker: a connection that is ALREADY among the marked ones is not counted as a new one (its own mark after the cool-down is still admitted)', () => {
    const g = mk();
    for (let i = 0; i < MAX_MARKS_PER_WINDOW; i++) expect(g.noteConfirmed(`c${i}`)).toBe(true);
    now += 6 * 60_000; // past the 5 minute cool-down, inside the 10 minute window
    expect(g.noteConfirmed('c0')).toBe(true);
  });

  it('breaker: the plain (consecutive) path is held by it too, and marking resumes when the window has passed', () => {
    const g = mk();
    for (let i = 0; i < MAX_MARKS_PER_WINDOW; i++) g.noteConfirmed(`c${i}`);
    g.note('late');
    expect(g.note('late')).toBe(false);
    now += MARK_WINDOW_MS + 1;
    g.note('late2');
    expect(g.note('late2')).toBe(true);
  });

  it('the breaker allows exactly 5 and refuses the 6th (the literal, not the exported constant)', () => {
    expect(MAX_MARKS_PER_WINDOW).toBe(5);
    expect(MARK_WINDOW_MS).toBe(10 * 60_000);
    const g = mk();
    const marks = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => g.noteConfirmed(c));
    expect(marks).toEqual([true, true, true, true, true, false]);
  });

  it('the plain (consecutive) path also holds the 5 minute cool-down per connection', () => {
    const g = mk();
    g.note('c1');
    expect(g.note('c1')).toBe(true);
    g.note('c1');
    expect(g.note('c1')).toBe(false); // two more signals, but marked a moment ago
    now += 5 * 60_000 + 1;
    expect(g.note('c1')).toBe(true); // the signals kept coming: the first one after the cool-down marks
  });
});

