import {
  classifyEngagementEvent,
  shouldExitSequence,
  SCANNER_USER_AGENT_PATTERNS,
} from '../dripEngagementClassifier';

const SENT = '2026-10-18T10:00:00.000Z';
const at = (s: number) => new Date(Date.parse(SENT) + s * 1000).toISOString();
const CHROME = 'Mozilla/5.0 (Macintosh) Chrome/129.0 Safari/537.36';

describe('classifyEngagementEvent (ENG-2538)', () => {
  it('ordinary human click is human', () => {
    expect(
      classifyEngagementEvent({ type: 'click', occurredAt: at(300), sentAt: SENT, userAgent: CHROME, link: 'a' }),
    ).toEqual({ human: true, reason: 'human' });
  });

  it('events inside the default 10s window are too_fast', () => {
    expect(classifyEngagementEvent({ type: 'click', occurredAt: at(5), sentAt: SENT, userAgent: CHROME }))
      .toEqual({ human: false, reason: 'too_fast' });
    expect(classifyEngagementEvent({ type: 'open', occurredAt: at(9), sentAt: SENT, userAgent: CHROME }).reason)
      .toBe('too_fast');
  });

  it('window is configurable', () => {
    expect(
      classifyEngagementEvent({ type: 'click', occurredAt: at(5), sentAt: SENT, userAgent: CHROME }, { tooFastWindowMs: 1000 }).human,
    ).toBe(true);
  });

  it('Apple MPP opens are proxy_open, even long after send', () => {
    expect(classifyEngagementEvent({ type: 'open', occurredAt: at(3600), sentAt: SENT, userAgent: 'AppleMailProxy/1.0' }))
      .toEqual({ human: false, reason: 'proxy_open' });
  });

  it('Gmail GoogleImageProxy opens are human when human-paced (ENG-325)', () => {
    expect(classifyEngagementEvent({ type: 'open', occurredAt: at(3600), sentAt: SENT, userAgent: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)' }))
      .toEqual({ human: true, reason: 'human' });
  });

  it('Gmail GoogleImageProxy opens inside the too-fast window are still non-human', () => {
    expect(classifyEngagementEvent({ type: 'open', occurredAt: at(2), sentAt: SENT, userAgent: 'GoogleImageProxy' }))
      .toEqual({ human: false, reason: 'too_fast' });
  });

  it.each(['Microsoft SafeLinks', 'Barracuda Sentinel', 'Proofpoint URL Defense', 'Mimecast-Scanner'])(
    'scanner UA %s click is non-human',
    (ua) => {
      expect(classifyEngagementEvent({ type: 'click', occurredAt: at(600), sentAt: SENT, userAgent: ua }))
        .toEqual({ human: false, reason: 'scanner_user_agent' });
    },
  );

  it('exports the scanner list', () => {
    expect(SCANNER_USER_AGENT_PATTERNS.length).toBeGreaterThan(5);
  });

  it('>=3 distinct-link clicks within 2s is click_burst', () => {
    const prior = [
      { type: 'click' as const, occurredAt: at(600), link: 'a' },
      { type: 'click' as const, occurredAt: at(600.5), link: 'b' },
    ];
    expect(
      classifyEngagementEvent({ type: 'click', occurredAt: at(601), sentAt: SENT, userAgent: CHROME, link: 'c', priorEvents: prior }),
    ).toEqual({ human: false, reason: 'click_burst' });
  });

  it('repeat clicks on same link or spread out are not a burst', () => {
    const same = [
      { type: 'click' as const, occurredAt: at(600), link: 'a' },
      { type: 'click' as const, occurredAt: at(600.5), link: 'a' },
    ];
    expect(classifyEngagementEvent({ type: 'click', occurredAt: at(601), sentAt: SENT, userAgent: CHROME, link: 'a', priorEvents: same }).human).toBe(true);
    const spread = [
      { type: 'click' as const, occurredAt: at(590), link: 'a' },
      { type: 'click' as const, occurredAt: at(595), link: 'b' },
    ];
    expect(classifyEngagementEvent({ type: 'click', occurredAt: at(601), sentAt: SENT, userAgent: CHROME, link: 'c', priorEvents: spread }).human).toBe(true);
  });

  it('invalid timestamps are never human', () => {
    expect(classifyEngagementEvent({ type: 'open', occurredAt: 'garbage', sentAt: SENT, userAgent: CHROME }))
      .toEqual({ human: false, reason: 'invalid_timestamp' });
    expect(classifyEngagementEvent({ type: 'click', occurredAt: at(600), sentAt: 'nope', userAgent: CHROME, link: 'a' }).reason)
      .toBe('invalid_timestamp');
  });

  it('linkless and scanner clicks do not count toward a burst', () => {
    const prior = [
      { type: 'click' as const, occurredAt: at(600), link: null },
      { type: 'click' as const, occurredAt: at(600.5), link: 'b', userAgent: 'Microsoft SafeLinks' },
    ];
    expect(
      classifyEngagementEvent({ type: 'click', occurredAt: at(601), sentAt: SENT, userAgent: CHROME, link: 'c', priorEvents: prior }).human,
    ).toBe(true);
  });

  it('Google proxy clicks do not count toward a burst', () => {
    const prior = [
      { type: 'click' as const, occurredAt: at(600), link: 'a', userAgent: 'GoogleImageProxy' },
      { type: 'click' as const, occurredAt: at(600.5), link: 'b', userAgent: 'via ggpht.com' },
    ];
    expect(
      classifyEngagementEvent({ type: 'click', occurredAt: at(601), sentAt: SENT, userAgent: CHROME, link: 'c', priorEvents: prior }).human,
    ).toBe(true);
  });
});

describe('shouldExitSequence (ENG-2538)', () => {
  it('ignores bot events and exits on a human click', () => {
    const bots = [
      { type: 'open' as const, occurredAt: at(2), userAgent: CHROME },
      { type: 'open' as const, occurredAt: at(400), userAgent: 'AppleMailProxy/1.0' },
      { type: 'click' as const, occurredAt: at(500), userAgent: 'Proofpoint', link: 'a' },
    ];
    expect(shouldExitSequence(bots, SENT, { exitOnOpen: true, exitOnClick: true })).toBe(false);
    const withHuman = [...bots, { type: 'click' as const, occurredAt: at(900), userAgent: CHROME, link: 'a' }];
    expect(shouldExitSequence(withHuman, SENT, { exitOnClick: true })).toBe(true);
  });

  it('respects disabled stop conditions', () => {
    const ev = [{ type: 'open' as const, occurredAt: at(900), userAgent: CHROME }];
    expect(shouldExitSequence(ev, SENT, { exitOnClick: true })).toBe(false);
    expect(shouldExitSequence(ev, SENT, { exitOnOpen: true })).toBe(true);
  });
});
