/**
 * ENG-2991: what the public sign-up form will email, how many confirmation emails it can trigger, and the confirmation pages.
 */
import {
  parseSignupEmail,
  isStoredEmail,
  canonicalMailbox,
  reserveJoinConfirmation,
  resetJoinConfirmationLimits,
  trackedJoinKeyCount,
  renderConfirmPage,
  tryBeginJoinSend,
  joinSendsInFlightCount,
  MAX_JOIN_SENDS_IN_FLIGHT,
} from '../services/subscriberSignup';

describe('parseSignupEmail', () => {
  it.each(['user@example.com', "o'brien+news@sub.example.co.uk", 'first.last@example.io', 'a@b.co', 'x_y-z@my-site.example.org', 'user@xn--bcher-kva.example', 'user@example.xn--p1ai'])('accepts %s', (email) => {
    expect(parseSignupEmail(email)).toEqual({ ok: true, email });
  });

  it('trims surrounding spaces', () => {
    expect(parseSignupEmail('  user@example.com \n')).toEqual({ ok: true, email: 'user@example.com' });
  });

  it.each([undefined, null, '', '   '])('reports %j as missing', (value) => {
    expect(parseSignupEmail(value)).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['a display name wrapped around an address', 'Evil<victim@example.com>'],
    ['a space inside', 'a b@example.com'],
    ['two at signs', 'a@b@example.com'],
    ['no top-level domain', 'a@example'],
    ['a one-letter top-level domain', 'a@example.c'],
    ['a label starting with a dash', 'a@-example.com'],
    ['an empty label', 'a@example..com'],
    ['a comma list', 'a@example.com,b@example.com'],
    ['a quoted local part', '"a b"@example.com'],
    ['a leading dot in the local part', '.a@example.com'],
    ['a trailing dot in the local part', 'a.@example.com'],
    ['two dots in a row in the local part', 'a..b@example.com'],
    ['an accent in the domain', 'user@exämple.com'],
    ['a local part over 64 characters', `${'a'.repeat(65)}@example.com`],
    ['an address over 254 characters', `a@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(63)}.com`],
  ])('rejects %s', (_name, value) => {
    expect(parseSignupEmail(value)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([['an array', ['a@example.com']], ['an object', { a: 'b' }], ['a number', 42], ['true', true]])('rejects %s without touching it as text', (_n, value) => {
    expect(parseSignupEmail(value)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('turns an oversized input away on its length alone, without running the pattern', () => {
    const started = process.hrtime.bigint();
    expect(parseSignupEmail('a@' + '.'.repeat(200_000) + ' ')).toEqual({ ok: false, reason: 'invalid' });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(50);
  });

  it('runs the pattern itself in linear time on the worst inputs that fit under the length limit (254 characters)', () => {
    const worst = ['a@' + 'a-'.repeat(126), 'a@' + 'a.'.repeat(126), '.'.repeat(60) + '@' + 'x.'.repeat(95) + 'co', 'a'.repeat(64) + '.' + 'a'.repeat(180) + '@x'];
    for (const value of worst) expect(value.length).toBeLessThanOrEqual(254);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) for (const value of worst) parseSignupEmail(value);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(250); // 800 evaluations
  });
});

describe('isStoredEmail (unsubscribe and resubscribe)', () => {
  it('accepts any plain non-empty string of a sane length, so an address stored long ago can always unsubscribe', () => {
    expect(isStoredEmail('user@exämple.com')).toBe(true);
    expect(isStoredEmail('Weird Name <x@y.z>')).toBe(true);
  });
  it('rejects non-strings, empty and oversized values', () => {
    for (const value of [undefined, null, '', 5, ['a@b.co'], {}, 'x'.repeat(321)]) expect(isStoredEmail(value)).toBe(false);
  });
});

describe('canonicalMailbox', () => {
  it('treats plus-tags, case and (for Gmail) dots as the same mailbox', () => {
    expect(canonicalMailbox('Victim+1@Example.com')).toBe('victim@example.com');
    expect(canonicalMailbox('victim+anything@example.com')).toBe('victim@example.com');
    expect(canonicalMailbox('v.i.c.t.i.m@gmail.com')).toBe('victim@gmail.com');
    expect(canonicalMailbox('victim+x@googlemail.com')).toBe('victim@gmail.com');
  });
  it('keeps dots for other providers, and keeps different people apart', () => {
    expect(canonicalMailbox('first.last@example.com')).toBe('first.last@example.com');
    expect(canonicalMailbox('first.last@example.com')).not.toBe(canonicalMailbox('firstlast@example.com'));
  });
});

const HOUR_MS = 60 * 60 * 1000;

describe('reserveJoinConfirmation', () => {
  const T0 = 1_800_000_000_000;
  const MIN = 60 * 1000;
  const reserve = (task: string, email: string, now: number, owner = 'owner-1') => reserveJoinConfirmation(task, email, owner, now);
  beforeEach(() => {
    resetJoinConfirmationLimits();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('allows one confirmation per address and task per 30 minutes, then again', () => {
    expect(reserve('t1', 'a@example.com', T0).ok).toBe(true);
    expect(reserve('t1', 'a@example.com', T0 + 29 * MIN)).toEqual({ ok: false, visible: false });
    expect(reserve('t1', 'a@example.com', T0 + 31 * MIN).ok).toBe(true);
  });

  it('counts plus-tags and letter case as the same address', () => {
    expect(reserve('t1', 'Victim@Example.com', T0).ok).toBe(true);
    expect(reserve('t1', 'victim+2@example.com', T0 + MIN)).toEqual({ ok: false, visible: false });
    expect(reserve('t1', 'v.ictim@example.com', T0 + MIN).ok).toBe(true); // dots only fold for Gmail
  });

  it('caps one mailbox at 5 confirmations an hour across all tasks, quietly (the form answers as for any sign-up)', () => {
    for (let i = 0; i < 5; i++) expect(reserve(`t${i}`, 'victim@example.com', T0 + i * MIN).ok).toBe(true);
    expect(reserve('t99', 'victim@example.com', T0 + 6 * MIN)).toEqual({ ok: false, visible: false });
    expect(reserve('t99', 'victim@example.com', T0 + 61 * MIN).ok).toBe(true);
  });

  it('caps one task at 300 confirmations an hour, visibly (the form says to try again later)', () => {
    for (let i = 0; i < 300; i++) expect(reserve('busy', `person${i}@example.com`, T0, `owner-${i}`).ok).toBe(true);
    expect(reserve('busy', 'one-more@example.com', T0 + MIN, 'owner-x')).toEqual({ ok: false, visible: true });
    expect(reserve('another-task', 'one-more@example.com', T0 + MIN, 'owner-x').ok).toBe(true);
  });

  it('caps one task owner at 600 an hour across all their tasks, visibly', () => {
    for (let i = 0; i < 600; i++) expect(reserve(`task-${i % 5}-${Math.floor(i / 300)}`, `p${i}@example.com`, T0, 'busy-owner').ok).toBe(true);
    expect(reserve('task-new', 'late@example.com', T0 + MIN, 'busy-owner')).toEqual({ ok: false, visible: true });
    expect(reserve('task-new', 'late@example.com', T0 + MIN, 'other-owner').ok).toBe(true);
  });

  it('caps the whole service at 3000 an hour, visibly, then recovers', () => {
    for (let i = 0; i < 3000; i++) expect(reserve(`t-${i % 20}-${Math.floor(i / 20)}`, `p${i}@example.com`, T0, `owner-${i}`).ok).toBe(true);
    expect(reserve('fresh-task', 'late@example.com', T0 + MIN, 'fresh-owner')).toEqual({ ok: false, visible: true });
    expect(reserve('fresh-task', 'late@example.com', T0 + 61 * MIN, 'fresh-owner').ok).toBe(true);
  });

  it('gives the slots back when the email could not be sent, so the person can try again at once', () => {
    const first = reserve('t1', 'a@example.com', T0);
    expect(first.ok).toBe(true);
    expect(reserve('t1', 'a@example.com', T0 + MIN).ok).toBe(false);
    if (first.ok) first.release();
    expect(reserve('t1', 'a@example.com', T0 + MIN).ok).toBe(true);
  });

  it('a refused reservation reserves nothing', () => {
    reserve('t1', 'a@example.com', T0);
    reserve('t1', 'a@example.com', T0 + MIN); // refused
    // only one slot was used on the mailbox cap, so four more are still available (other tasks)
    for (let i = 0; i < 4; i++) expect(reserve(`x${i}`, 'a@example.com', T0 + 2 * MIN).ok).toBe(true);
  });

  it('forgets what has aged out, so the counters do not pile up over the days: a flood of distinct addresses is bounded by the whole-service cap, then swept', () => {
    // 30,000 attempts from distinct addresses in one hour: only 3000 are accepted (the whole-service cap), so only those create counters
    let accepted = 0;
    for (let i = 0; i < 30000; i++) if (reserve(`flood-${i}`, `m${i}@example.com`, T0 + (i % 50) * 1000, `owner-${i}`).ok) accepted++;
    expect(accepted).toBe(3000);
    const whileFlooded = trackedJoinKeyCount();
    expect(whileFlooded).toBeGreaterThan(5000); // two counters per accepted address, plus the task and owner counters
    expect(whileFlooded).toBeLessThan(15000); // bounded by the cap, not by the 30,000 attempts

    // two hours later the first new request sweeps away everything that has aged out of every window
    expect(reserve('after', 'someone@example.com', T0 + 2 * HOUR_MS, 'o').ok).toBe(true);
    expect(trackedJoinKeyCount()).toBeLessThan(20);
  });

  it('does not share one counter between task owners that are unknown', () => {
    // a task with no owner id is counted on its own, not under a shared "undefined" owner
    for (let i = 0; i < 700; i++) expect(reserve(`orphan-${i}`, `p${i}@example.com`, T0, `no-owner:orphan-${i}`).ok).toBe(true);
  });

  it('says which kind of limit was reached in the log, and nothing about the address', () => {
    reserve('t1', 'secret.person@example.com', T0);
    reserve('t1', 'secret.person@example.com', T0 + MIN);
    const logged = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('subscriber_join_throttled');
    expect(logged).toContain('"cap":"pair"');
    expect(logged).not.toContain('secret.person');
  });
});

describe('renderConfirmPage', () => {
  it('escapes everything it prints, including the task name and the token', () => {
    const page = renderConfirmPage({
      title: 'A <b>title</b>',
      message: 'Updates for <script>alert(1)</script> "Weekly" & more',
      form: { action: '/api/tasks/t1/subscribers/confirm', token: 'a"b<c', button: 'Go <now>' },
    });
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('<b>title');
    expect(page).toContain('&lt;script&gt;');
    expect(page).toContain('value="a&quot;b&lt;c"');
    expect(page).toContain('Go &lt;now&gt;');
  });

  it('is a post form to the given action, and marks itself not for search engines', () => {
    const page = renderConfirmPage({ title: 't', message: 'm', form: { action: '/x', token: 'tok', button: 'Confirm' } });
    expect(page).toContain('<form method="post" action="/x"');
    expect(page).toContain('name="token"');
    expect(page).toContain('<meta name="robots" content="noindex">');
    expect(page).toContain('<html lang="en">');
    expect(renderConfirmPage({ title: 't', message: 'm' })).not.toContain('<form');
  });
});

describe('tryBeginJoinSend (a burst cannot fill the shared outgoing mail queue)', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('gives out as many places as the queue may hold at once, then none, and takes them back when they are released', () => {
    const places = Array.from({ length: MAX_JOIN_SENDS_IN_FLIGHT }, () => tryBeginJoinSend());
    expect(places.every((release) => typeof release === 'function')).toBe(true);
    expect(joinSendsInFlightCount()).toBe(MAX_JOIN_SENDS_IN_FLIGHT);
    expect(tryBeginJoinSend()).toBeNull();
    expect((console.warn as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n')).toContain('"cap":"queue"');
    places[0]!();
    const again = tryBeginJoinSend();
    expect(again).not.toBeNull();
    places.slice(1).forEach((release) => release!());
    again!();
    expect(joinSendsInFlightCount()).toBe(0);
  });

  it('places handed out before a reset are not given back into the new count', () => {
    const before = tryBeginJoinSend()!;
    resetJoinConfirmationLimits();
    expect(joinSendsInFlightCount()).toBe(0);
    before(); // the old place's release arrives after the reset
    expect(joinSendsInFlightCount()).toBe(0);
    const taken = Array.from({ length: MAX_JOIN_SENDS_IN_FLIGHT }, () => tryBeginJoinSend());
    expect(tryBeginJoinSend()).toBeNull(); // the cap is still exactly the cap
    taken.forEach((r) => r!());
  });

  it('a place can only be given back once (a second release must not hand out an extra place)', () => {
    const release = tryBeginJoinSend()!;
    release();
    release();
    expect(joinSendsInFlightCount()).toBe(0);
    const taken = Array.from({ length: MAX_JOIN_SENDS_IN_FLIGHT }, () => tryBeginJoinSend());
    expect(tryBeginJoinSend()).toBeNull();
    taken.forEach((r) => r!());
  });
});
