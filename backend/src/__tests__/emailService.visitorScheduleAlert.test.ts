/**
 * ENG-3149: the email an account owner gets when a share-link visitor first marks one of their scheduled chats.
 * The copy is approved wording and is pinned verbatim; the schedule name is the only visitor-derived text and is neutralised.
 */
import { performance } from 'perf_hooks';
import { emailService, shareScheduleAlertName, SHARE_SCHEDULE_ALERT_NAME_MAX } from '../services/emailService';

jest.mock('../services/db', () => ({
  userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() },
  scheduleDb: { getScheduleById: jest.fn() },
}));

const SUBJECT = 'Someone using your share link set up a scheduled chat';
const HEADER = 'A scheduled chat was set up through your share link';
const PARAGRAPH_2 = "Until you review it, it runs with limited access: it can't use account-level tools such as saving memory or changing organization settings, and anything it would publish or post to Slack is kept as a draft.";
const PARAGRAPH_3 = "If it's yours or you trust it, open Scheduled chats, read what it does and press Adopt. If you don't recognise it, delete it, and consider turning off the share link.";

describe('emailService.sendVisitorScheduleAlertEmail (ENG-3149)', () => {
  let sendSpy: jest.SpyInstance;
  const originalUrl = process.env.CUSTOMER_FRONTEND_URL;

  beforeEach(() => {
    sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined as any);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.example.test';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.CUSTOMER_FRONTEND_URL; else process.env.CUSTOMER_FRONTEND_URL = originalUrl;
  });

  const send = async (name: string, scheduleId = 'sched-1', to: string | string[] = 'owner@example.com') => {
    await emailService.sendVisitorScheduleAlertEmail(to, name, scheduleId);
    const [recipients, subject, text, html] = sendSpy.mock.calls[0] as [string[], string, string, string];
    return { recipients, subject, text, html };
  };

  it('sends ONE email to the given owner address with the fixed subject, which never contains the schedule name', async () => {
    const { recipients, subject } = await send('Quarterly pipeline report');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(recipients).toEqual(['owner@example.com']);
    expect(subject).toBe(SUBJECT);
    expect(subject).not.toContain('Quarterly');
  });

  it('carries the approved copy verbatim in BOTH the HTML and the plain-text part', async () => {
    const { text, html } = await send('Quarterly pipeline report', 'sched-42');
    for (const part of [text, html]) {
      expect(part).toContain(HEADER);
      expect(part).toContain('Someone using one of your Emma share links created or changed the scheduled chat "Quarterly pipeline report".');
      expect(part).toContain(PARAGRAPH_2);
      expect(part).toContain(PARAGRAPH_3);
      expect(part).toContain('Review the schedule');
      expect(part).toContain('Schedule ID: sched-42');
    }
  });

  it('links the button to ${CUSTOMER_FRONTEND_URL}/agent-mode?tab=scheduled (and falls back like the other schedule emails)', async () => {
    const { text, html } = await send('x');
    expect(html).toContain('<a class="button" href="https://app.example.test/agent-mode?tab=scheduled">Review the schedule</a>');
    expect(text).toContain('https://app.example.test/agent-mode?tab=scheduled');

    sendSpy.mockClear();
    delete process.env.CUSTOMER_FRONTEND_URL;
    const fallback = await send('x');
    expect(fallback.html).toContain('href="http://localhost:5174/agent-mode?tab=scheduled"');
  });

  it('markup in the name cannot reach the mail as markup: it is reduced to plain words first, and what is left is still escaped', async () => {
    const hostile = '<img src=x onerror=alert(1)> & "quoted" <b>bold</b> <script>steal()</script>';
    const { html, text } = await send(hostile);
    const shown = 'img src x onerror alert(1) & quoted b bold b script steal() script';
    expect(text).toContain(`the scheduled chat "${shown}".`);
    expect(html).toContain(`the scheduled chat "${shown.replace('&', '&amp;')}".`);
    for (const part of [html, text]) {
      expect(part).not.toContain('<img');
      expect(part).not.toContain('<script');
      expect(part).not.toContain('<b>');
    }
    // The only link in the HTML is the button's.
    expect((html.match(/<a /g) || []).length).toBe(1);
  });

  it('a link inside markup in the name cannot survive as a link, escaped or not', async () => {
    const { html, text } = await send('<a href="https://evil.example/x">click</a>');
    for (const part of [html, text]) {
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain('https://evil');
      expect(part).toContain('the scheduled chat "a href https evil example x click a".');
    }
    expect((html.match(/<a /g) || []).length).toBe(1);
  });

  it('collapses whitespace and newlines in the name to single spaces (a name cannot add lines to the plain-text part)', async () => {
    const { text, html } = await send('  Line one\n\nLine\ttwo\r\n   Line three  ');
    expect(text).toContain('the scheduled chat "Line one Line two Line three".');
    expect(html).toContain('the scheduled chat "Line one Line two Line three".');
  });

  it('truncates a long name to 100 characters with an ellipsis (still 100 in all, whole characters)', async () => {
    const long = 'A'.repeat(500);
    const { text, html } = await send(long);
    const expected = `${'A'.repeat(99)}…`;
    expect(Array.from(expected)).toHaveLength(SHARE_SCHEDULE_ALERT_NAME_MAX);
    expect(text).toContain(`the scheduled chat "${expected}".`);
    expect(html).toContain(`the scheduled chat "${expected}".`);
    expect(text).not.toContain('A'.repeat(100));

    // exactly at the limit: untouched
    sendSpy.mockClear();
    const atLimit = await send('B'.repeat(100));
    expect(atLimit.text).toContain(`"${'B'.repeat(100)}".`);
    expect(atLimit.text).not.toContain('…');
  });

  it('never cuts a character in half (an astral letter is one character)', async () => {
    const astral = String.fromCodePoint(0x20bb7);
    const { text } = await send(astral.repeat(150));
    expect(text).toContain(`"${astral.repeat(99)}…".`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('puts nothing else of the visitor in the mail: no prompt text, token or recipient comes from the arguments, only the name and the id', async () => {
    const { text, html } = await send('Weekly digest', 'sched-9');
    for (const part of [text, html]) {
      expect(part).not.toMatch(/token|conversable|ishare|prompt|@visitor/i);
    }
    // And the method has exactly three inputs.
    expect(emailService.sendVisitorScheduleAlertEmail.length).toBe(3);
  });

  it('shows no customer-facing ENG number', async () => {
    const { text, html, subject } = await send('Weekly digest');
    for (const part of [text, html, subject]) expect(part).not.toMatch(/ENG-\d+/);
  });

  it('an empty or non-string name is shown as "Untitled" rather than an empty pair of quotes', async () => {
    const { text } = await send('   \n\t ');
    expect(text).toContain('the scheduled chat "Untitled".');
  });

  it('never throws, even when sending fails (like its sibling schedule emails)', async () => {
    sendSpy.mockRejectedValue(new Error('smtp down'));
    await expect(emailService.sendVisitorScheduleAlertEmail('owner@example.com', 'x', 's')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ENG-3149]'), expect.any(Error));
  });
});

describe('shareScheduleAlertName (ENG-3149): a bounded allow-list', () => {
  const name = shareScheduleAlertName;
  /** 400 code points is at most 800 UTF-16 units. */
  const NAME_MAX_NORMALIZED_UNITS = 800;
  /** Hostile characters are built from code points, so no invisible character sits in this file. */
  const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
  const ELLIPSIS = '…';

  // What an output may be made of: letters, marks, digits, space, _ - ' ’ & , ( ) + # ! ? % , a dot between two digits, and one
  // trailing ellipsis.
  const ALLOWED_OUTPUT = /^(?:[\p{L}\p{M}\p{N} _'’&,()+#!?%-]|(?<=\d)\.(?=\d))*…?$/u;
  // What no output may contain: a dot that is not between digits, : / @ \ < >, any format or default-ignorable character.
  const FORBIDDEN_IN_OUTPUT = /[:/@\\<>]|(?<!\d)\.|\.(?!\d)|[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}]/u;

  /** The three things that must hold for ANY input; returns the output. */
  const clean = (input: unknown): string => {
    const out = name(input);
    expect(out).toMatch(ALLOWED_OUTPUT);
    expect(out).not.toMatch(FORBIDDEN_IN_OUTPUT);
    expect(Array.from(out).length).toBeGreaterThan(0);
    expect(Array.from(out).length).toBeLessThanOrEqual(SHARE_SCHEDULE_ALERT_NAME_MAX);
    expect(name(out)).toBe(out); // cleaning twice changes nothing
    return out;
  };

  describe('(c) ordinary names survive unchanged', () => {
    it.each([
      'Weekly report', 'Weekly report v2.1', 'Release 3.0', '1.2.3', 'Acme Inc', 'Café résumé', 'Q4 (draft)',
      'Daily digest, 9am (UK) - top 5!', "Mom's list & Dad's", 'Q3_review-final #2', 'Margin 12.5% check', 'Report 2026.11.18',
      'Build 1.2.3.4 smoke test', 'Is this ready?', 'x+y=z'.replace('=', ' '), "Rock ’n’ roll",
    ])('%s', (input) => {
      expect(clean(input)).toBe(input);
    });

    it.each([
      ['Devanagari', 'हिन्दी रिपोर्ट'],
      ['Thai', 'รายงานสัปดาห์'],
      ['Arabic', 'تقرير أسبوعي'],
      ['Japanese', '毎週のレポート'],
      ['Chinese', '周报 2026'],
      ['Korean', '주간 보고서'],
      ['Cyrillic', 'Еженедельный отчёт'],
      ['an accent written as base + combining mark (composed by NFKC, still the same letters)', 'Café'],
    ])('%s names survive', (_label, input) => {
      expect(clean(input)).toBe(input.normalize('NFKC'));
    });
  });

  describe('(b) hostile inputs: exact results for the cases that matter', () => {
    it.each([
      ['a login-phishing name with a path', 'Re-verify your login at evil.example/x', 'Re-verify your login at evil example x'],
      ['a trailing hyphen after the domain', 'evil.com-', 'evil com-'],
      ['an underscore after the domain', 'evil.com_login', 'evil com_login'],
      ['a digit after the domain', 'evil.com9', 'evil com9'],
      ['a numeric host', '0.0.88888.com', '0.0.88888 com'],
      ['a numeric host with a version-like prefix', '1.1.163.com', '1.1.163 com'],
      ['a dotted-name file', 'Notes.txt', 'Notes txt'],
      ['glued words', 'Sales.Report', 'Sales Report'],
      ['a trailing period', 'Q4 plan.', 'Q4 plan'],
      ['a variation selector before the dot', `evil${ch(0xfe0f)}.com`, 'evil com'],
      ['Devanagari before the dot', 'हिन्दी.com', 'हिन्दी com'],
      ['a combining-mark top level after the dot', 'example.भारत', 'example भारत'],
      ['a letter with a combining mark before the dot', 'eviĺ.com', 'eviĺ com'],
      ['a scheme URL', 'visit https://evil.example/a?b=c now', 'visit https evil example a?b c now'],
      ['javascript:', 'javascript:alert(1)', 'javascript alert(1)'],
      ['mailto:', 'mailto:ceo@evil.example', 'mailto ceo evil example'],
      ['user@host', 'mail ceo@evil.example now', 'mail ceo evil example now'],
      ['www', 'WWW.Evil.Example', 'WWW Evil Example'],
      ['an IPv4 with a port and a path', 'open 10.0.0.1:8080/login', 'open 10.0.0.1 8080 login'],
      ['a punycode host', 'see evil.xn--80ak6aa92e.com', 'see evil xn--80ak6aa92e com'],
      ['ideographic full stop', 'evil。com', 'evil com'],
      ['halfwidth ideographic full stop', 'evil｡com', 'evil com'],
      ['full-width full stop (folded to a dot, then removed)', 'evil．com', 'evil com'],
      ['one-dot leader (folded to a dot)', 'evil․com', 'evil com'],
      ['a fully full-width URL', 'ｈｔｔｐｓ：／／ｅｖｉｌ．ｃｏｍ', 'https evil com'],
      ['a division slash', 'evil.com∕x', 'evil com x'],
      ['a name made only of U+3164', ch(0x3164, 0x3164, 0x3164), 'Untitled'],
      ['a name of only emoji (symbols are not on the allow-list)', ch(0x1f600, 0x1f600), 'Untitled'],
      ['emoji between words become a space', `Report ${ch(0x1f680)} done`, 'Report done'],
    ])('%s', (_label, input, expected) => {
      expect(clean(input)).toBe(expected);
    });

    it('only whitespace, only invisibles, the empty string and non-strings are "Untitled"', () => {
      for (const input of ['', '   ', '\n\t', ch(0x200b, 0x200b), ' \u00A0 ', undefined, null, 7, {}, [], { toString: () => 'evil.com' }, Symbol('x')]) {
        expect(name(input)).toBe('Untitled');
      }
    });

    it('a trailing ellipsis a visitor typed is kept once, not cleaned into dots', () => {
      expect(clean(`Report${ELLIPSIS}`)).toBe(`Report${ELLIPSIS}`);
      expect(clean('Report...')).toBe('Report');
    });
  });

  describe('(a)(b) the property holds for every attack: only allow-listed characters, no clickable or hidden thing, <= 100, stable', () => {
    const zeroWidth = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x00ad, 0x061c, 0x115f, 0x1160, 0x3164, 0xffa0, 0x034f, 0xfeff,
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfe00, 0xfe0f, 0x180e, 0x2800, 0xe0000, 0xe0020, 0xe0041, 0xe007f, 0xe0100];
    const attacks: string[] = [
      'Re-verify your login at evil.example/x', 'evil.com-', 'evil.com_login', 'evil.com9', '0.0.88888.com', '1.1.163.com',
      'https://evil.example/a?b=c#d', 'http://evil.example', 'HTTPS://EVIL.EXAMPLE', 'ftp://evil.example/x', 'file:///etc/passwd', 'ws://evil.example',
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'mailto:ceo@evil.example',
      'tel:+1-800-555-0100', 'user@host', 'user:pass@evil.example', 'a@b', '@evil', 'www.evil.example', 'WWW.EVIL.COM', 'www.x',
      '10.0.0.1:8080/login', '192.168.1.1/admin', '8.8.8.8', 'evil.xn--p1ai', 'xn--80ak6aa92e.com', 'evil。com', 'evil｡com',
      'evil．com', 'evil․com', 'evil﹒com', 'evil／com', 'evil.com∕path', 'evil.com\\path', 'evil.com:8080', 'evil.com#frag',
      'evil.com?q=1', 'evil.com;x', 'evil.com|x', 'evil.com~user', 'evil.com^x', 'evil.com*', 'evil.com$', 'evil.com=1', '[evil.com]', '{evil.com}',
      '<img src=x onerror=alert(1)>', '"quoted" <b>x</b>', '<a href="https://evil.example">click</a>', "'; DROP TABLE schedules;--",
      'हिन्दी.com', 'example.भारत', 'eviĺ.com', 'รายงาน.com',
      'تقرير.com', '毎週.jp', 'ｈｔｔｐｓ：／／ｅｖｉｌ．ｃｏｍ',
      'x'.repeat(86) + ' evil.com-tail', 'x'.repeat(95) + ' evil.com-tail', 'x'.repeat(98) + '.com', 'a.'.repeat(60) + 'com', '0.'.repeat(80) + 'com',
      'Invoice ' + ch(0x202e) + 'txt.docx', 'evil' + ch(0x202e) + '.com', ch(0x202e) + 'moc.live',
      'evil' + ch(0x0000) + '.com', 'evil' + ch(0x0085) + '.com', 'evil' + ch(0x2028) + '.com', 'evil' + ch(0xe001) + '.com', 'evil' + ch(0xd800) + '.com',
      'evil' + ch(0xfdd0) + '.com', 'evil' + ch(0xffff) + '.com', ch(0x1f600) + 'evil.com' + ch(0x1f600), 'é'.repeat(200) + '.com',
      ' '.repeat(500) + 'evil.com', '.'.repeat(500), '/'.repeat(500), ':'.repeat(500), '@'.repeat(500), '-'.repeat(500), '9.'.repeat(300),
      // Characters whose NFKC form CONTAINS a dot, slash, colon or equals: they must be folded BEFORE the allow-list, or the final
      // normalisation would bring the punctuation back.
      'evil' + ch(0x2100) + 'com', 'evil' + ch(0x2105) + 'com', 'evil' + ch(0x2488) + 'com', 'evil' + ch(0x33c2) + 'com', 'evil' + ch(0x33c7) + 'com',
      'evil' + ch(0x2025) + 'com', 'evil' + ch(0x2026) + 'com', 'evil' + ch(0x2a74) + 'com', 'evil' + ch(0x2a75) + 'com', 'evil' + ch(0x2489) + 'com',
      'evil' + ch(0x249b) + 'com', 'evil' + ch(0xfdfa) + 'com', 'evil' + ch(0x2afc) + 'com', 'evil' + ch(0x33a1) + 'com',
      ...zeroWidth.flatMap((cp) => [
        `evil${ch(cp)}.com`, `evil.${ch(cp)}com`, `ht${ch(cp)}tps://evil.example`, `evil.com${ch(cp)}/x`, ch(cp).repeat(10),
      ]),
    ];

    it('has at least 40 distinct attacks', () => {
      expect(new Set(attacks).size).toBeGreaterThanOrEqual(40);
    });

    it.each(attacks.map((attack, index) => [index, Array.from(attack).slice(0, 40).map((c) => (c.codePointAt(0)! < 0x20 || c.codePointAt(0)! > 0x7e ? `\\u{${c.codePointAt(0)!.toString(16)}}` : c)).join('')]))(
      'attack #%i %s',
      (index) => {
        clean(attacks[index as number]);
      },
    );

    it('a character that NFKC turns into punctuation is folded first, then removed (it cannot come back at the end)', () => {
      expect(name('x' + ch(0x2488) + 'y')).toBe('x1 y');          // "1." -> the dot is not between digits
      expect(name('a' + ch(0x2100) + 'b')).toBe('aa cb');         // "a/c"
      expect(name('a' + ch(0x2105) + 'b')).toBe('ac ob');         // "c/o"
      expect(name('a' + ch(0x33c2) + 'b')).toBe('aa m b');        // "a.m."
    });

    it('control and format characters are DELETED, not turned into spaces (nothing can be split by one, or hidden in one)', () => {
      for (const codePoint of [0x0000, 0x0001, 0x007f, 0x009f, 0x0600, 0x06dd, 0x070f, 0xfff9, 0x1d173]) {
        expect(name(`ab${ch(codePoint)}cd`)).toBe('abcd');
      }
    });

    it('whatever is sent, no step after the cuts ever works on more than 400 code points', () => {
      const lengths: number[] = [];
      const original = String.prototype.replace;
      const spy = jest.spyOn(String.prototype, 'replace').mockImplementation(function (this: string, ...args: unknown[]) {
        lengths.push(this.length);
        return (original as (...a: unknown[]) => string).apply(this, args);
      } as typeof String.prototype.replace);
      try {
        name(ch(0xfdfa).repeat(300));            // 300 characters that each grow to 18 under NFKC
        name('a'.repeat(100_000) + ch(0xfdfa).repeat(1000));
      } finally {
        spy.mockRestore();
      }
      expect(lengths.length).toBeGreaterThan(0);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(NAME_MAX_NORMALIZED_UNITS);
    });

    it('a truncated name cannot expose a domain: the cut happens on text that has no dots left', () => {
      for (const filler of [86, 90, 93, 95, 96, 97, 98, 99, 100, 120]) {
        const out = clean('x'.repeat(filler) + ' evil.com-tail');
        expect(out).not.toMatch(/\.|:|\//);
        expect(Array.from(out).length).toBeLessThanOrEqual(SHARE_SCHEDULE_ALERT_NAME_MAX);
      }
      const cut = name('x'.repeat(95) + ' evil.com-tail');
      expect(cut).toBe(`${'x'.repeat(95)} evi${ELLIPSIS}`);
    });
  });

  describe('(f) length: 100 characters including the ellipsis, cut on whole characters', () => {
    it('a name of exactly 100 characters is untouched; 101 is cut to 99 plus the ellipsis', () => {
      expect(name('B'.repeat(100))).toBe('B'.repeat(100));
      const cut = name('B'.repeat(101));
      expect(cut).toBe(`${'B'.repeat(99)}${ELLIPSIS}`);
      expect(Array.from(cut)).toHaveLength(100);
    });

    it('spaces before the cut do not leave a gap before the ellipsis', () => {
      expect(name(`${'B'.repeat(98)} ${'C'.repeat(10)}`)).toBe(`${'B'.repeat(98)}${ELLIPSIS}`);
    });

    it('a cut never leaves a dot behind (it would not survive cleaning again)', () => {
      const cut = name(`${'1'.repeat(98)}.5 and more words`);
      expect(cut).not.toMatch(/\.…$/);
      expect(name(cut)).toBe(cut);
    });

    it('astral characters count once and are never cut in half', () => {
      const astral = String.fromCodePoint(0x20bb7);
      const cut = name(astral.repeat(150));
      expect(Array.from(cut)).toHaveLength(100);
      expect(cut).toBe(`${astral.repeat(99)}${ELLIPSIS}`);
    });
  });

  describe('(d) performance: bounded work, whatever is sent', () => {
    const patterns: Array<[string, string]> = [
      ['a', 'a'], ['a.', 'a.'], ['.', '.'], ['@', '@'], [':/', ':/'], ['http://', 'http://'], ['zero-width space', ch(0x200b)], ['x@', 'x@'],
      ['combining acute', ch(0x0301)], ['base + combining marks', 'e' + ch(0x0301, 0x0302, 0x0303)], ['0.', '0.'], ['space', ' '], ['hyphen', '-'],
      ['variation selector', ch(0xfe0f)], ['an astral letter', ch(0x20bb7)], ['a lone surrogate', ch(0xd800)], ['full-width dot', ch(0xff0e)],
      ['a ligature that grows under NFKC', ch(0xfdfa)],
    ];
    const SIZES = [1_000_000, 5_000_000];

    it.each(patterns.flatMap(([label, unit]) => SIZES.map((size) => [label, size, unit] as const)))(
      '%s x %i characters finishes in well under a second',
      (_label, size, unit) => {
        const input = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
        const started = performance.now();
        const out = name(input);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(200);
        expect(out).toMatch(ALLOWED_OUTPUT);
        expect(Array.from(out).length).toBeLessThanOrEqual(SHARE_SCHEDULE_ALERT_NAME_MAX);
      },
    );

    it('the work does not depend on how much was sent: only the first 300 code points count', () => {
      const head = 'Weekly report ';
      expect(name(head + 'evil.com'.repeat(50_000))).toBe(name(head + 'evil.com'.repeat(50_000) + 'tail that is never read'));
      expect(name('y'.repeat(300) + 'evil.com')).toBe(name('y'.repeat(300)));
    });
  });

  describe('(e) cleaning twice gives the same string', () => {
    it.each([
      'Weekly report v2.1', 'evil.com-', 'Q4 plan.', 'Report...', `Report${ELLIPSIS}`, 'x'.repeat(500), 'x'.repeat(95) + ' evil.com-tail', '1.2.3.', '1..2', '1.2.',
      ch(0x1f600) + 'a', 'e' + ch(0x200b, 0x0301), 'cafe' + ch(0x200b, 0x0301), ch(0x0301) + 'a', 'a' + ch(0x0301).repeat(150),
      'ＡＢＣ.１.２', 'ﬁnal ﬂight', '²³ cubed', 'ทำงาน',
    ])('%s', (input) => {
      const once = name(input);
      expect(name(once)).toBe(once);
    });
  });

  it('the full mail shows the cleaned name only', async () => {
    const sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined as any);
    await emailService.sendVisitorScheduleAlertEmail('owner@example.com', 'Re-verify your login at evil\u200B.example/x', 'sched-1');
    const [, , text, html] = sendSpy.mock.calls[0] as [string[], string, string, string];
    for (const part of [text, html]) {
      expect(part).toContain('the scheduled chat "Re-verify your login at evil example x".');
      expect(part).not.toContain('evil.example');
    }
    sendSpy.mockRestore();
  });
});
