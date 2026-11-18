/**
 * ENG-3149: the email an account owner gets when a share-link visitor first marks one of their scheduled chats.
 * The copy is approved wording and is pinned verbatim; the schedule name is the only visitor-derived text and is neutralised.
 */
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

  it('neutralises HTML in the name in the HTML part (escaped, so it cannot add markup), and keeps it readable as text in the plain part', async () => {
    const hostile = '<img src=x onerror=alert(1)> & "quoted" <b>bold</b> <script>steal()</script>';
    const { html, text } = await send(hostile);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot; &lt;b&gt;bold&lt;/b&gt; &lt;script&gt;steal()&lt;/script&gt;');
    expect(text).toContain(hostile);
    // The only link in the HTML is the button's.
    expect((html.match(/<a /g) || []).length).toBe(1);
  });

  it('a link inside markup in the name is removed before escaping, so not even escaped markup carries an address', async () => {
    const { html, text } = await send('<a href="https://evil.example/x">click</a>');
    for (const part of [html, text]) expect(part).not.toContain('evil');
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

  it('never cuts a character in half (emoji are one character each)', async () => {
    const { text } = await send('\u{1F600}'.repeat(150));
    expect(text).toContain(`"${'\u{1F600}'.repeat(99)}…".`);
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

describe('shareScheduleAlertName (ENG-3149)', () => {
  const name = shareScheduleAlertName;
  const PLACEHOLDER = '[link removed]';

  it.each([
    ['plain', 'My schedule', 'My schedule'],
    ['a non-printing control character is deleted, not turned into a space (an HTML parser may drop it and rejoin what it split)', 'a\u0000b\u0007c\u007fd', 'abcd'],
    ['unicode line and paragraph separators separate', 'a\u2028b\u2029c', 'a b c'],
    ['tabs, newlines, NEL and no-break and ideographic spaces separate and collapse', ' a\t\tb\nc\u0085d\u00A0\u00A0e\u3000f ', 'a b c d e f'],
    ['non-string', undefined, 'Untitled'],
    ['number', 42, 'Untitled'],
    ['object', { toString: () => 'evil.example' }, 'Untitled'],
    ['blank', '   ', 'Untitled'],
    ['empty', '', 'Untitled'],
  ])('%s', (_label, input, expected) => {
    expect(name(input)).toBe(expected);
  });

  describe('invisible and format characters are deleted (a name cannot hide anything in them)', () => {
    const invisibles: Array<[string, string]> = [
      ['U+202A left-to-right embedding', '\u202A'], ['U+202B right-to-left embedding', '\u202B'], ['U+202C pop directional formatting', '\u202C'],
      ['U+202D left-to-right override', '\u202D'], ['U+202E right-to-left override', '\u202E'],
      ['U+2066 left-to-right isolate', '\u2066'], ['U+2067 right-to-left isolate', '\u2067'], ['U+2068 first strong isolate', '\u2068'], ['U+2069 pop directional isolate', '\u2069'],
      ['U+200B zero-width space', '\u200B'], ['U+200C zero-width non-joiner', '\u200C'], ['U+200D zero-width joiner', '\u200D'],
      ['U+200E left-to-right mark', '\u200E'], ['U+200F right-to-left mark', '\u200F'],
      ['U+2060 word joiner', '\u2060'], ['U+00AD soft hyphen', '\u00AD'], ['U+061C arabic letter mark', '\u061C'],
      ['U+115F hangul choseong filler', '\u115F'], ['U+1160 hangul jungseong filler', '\u1160'],
      ['U+3164 hangul filler', '\u3164'], ['U+FFA0 halfwidth hangul filler', '\uFFA0'],
      ['U+034F combining grapheme joiner', '\u034F'], ['U+FEFF byte order mark', '\uFEFF'], ['U+2800 braille blank', '\u2800'],
      ['U+E0000 tag character', '\u{E0000}'], ['U+E0020 tag space', '\u{E0020}'], ['U+E0041 tag latin a', '\u{E0041}'], ['U+E007F cancel tag', '\u{E007F}'],
    ];

    it.each(invisibles)('%s is deleted', (_label, character) => {
      expect(name(`ab${character}cd`)).toBe('abcd');
    });

    it.each(invisibles)('%s cannot hide a dot to get a link past the filter', (_label, character) => {
      expect(name(`Re-verify your login at evil${character}.example/x`)).toBe(`Re-verify your login at ${PLACEHOLDER}`);
      expect(name(`Re-verify your login at evil.${character}example`)).toBe(`Re-verify your login at ${PLACEHOLDER}`);
      expect(name(`see ht${character}tps://evil.example`)).toBe(`see ${PLACEHOLDER}`);
    });

    it.each(invisibles)('a name made of only %s reads "Untitled"', (_label, character) => {
      expect(name(character.repeat(5))).toBe('Untitled');
      expect(name(` ${character} \n${character} `)).toBe('Untitled');
    });

    it('a name made only of U+3164 is "Untitled"', () => {
      expect(name('\u3164\u3164\u3164')).toBe('Untitled');
    });

    it('a right-to-left override cannot reorder what follows it in the shown name', () => {
      const shown = name('Invoice \u202Etxt.docx');
      expect(shown).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
      expect(shown).toBe(`Invoice ${PLACEHOLDER}`); // "txt.docx" is host-shaped, and is removed too
      expect(name('Report \u202E2026 final')).toBe('Report 2026 final');
    });

    it('a control character cannot split a host to dodge the filter either: it is deleted first', () => {
      expect(name('log in at evil\u0000.example')).toBe(`log in at ${PLACEHOLDER}`);
    });
  });

  describe('link-like and address-like pieces become "[link removed]"', () => {
    it.each([
      ['a bare domain', 'Re-verify your login at evil.example', `Re-verify your login at ${PLACEHOLDER}`],
      ['a bare domain with a path', 'Re-verify your login at evil.example/x', `Re-verify your login at ${PLACEHOLDER}`],
      ['a bare domain with a port and path', 'go evil.example:8080/login?a=1#b now', `go ${PLACEHOLDER} now`],
      ['a subdomain chain', 'see login.bank.evil.example today', `see ${PLACEHOLDER} today`],
      ['a hyphenated domain', 'see my-bank-secure.example', `see ${PLACEHOLDER}`],
      ['a domain with an upper-case top level', 'see EVIL.COM', `see ${PLACEHOLDER}`],
      ['a domain whose own name is a number', 'see 163.com', `see ${PLACEHOLDER}`],
      ['a domain in another script', 'see bücher.example and пример.рф', `see ${PLACEHOLDER} and ${PLACEHOLDER}`],
      ['a punycode top level', 'see evil.xn--p1ai', `see ${PLACEHOLDER}`],
      ['a domain written with an ideographic full stop', 'see evil。example', `see ${PLACEHOLDER}`],
      ['a domain written with a full-width full stop', 'see evil．example', `see ${PLACEHOLDER}`],
      ['a domain with trailing punctuation', 'see (evil.example), please', `see (${PLACEHOLDER}), please`],
      ['a url with a scheme', 'visit https://evil.example/a?b=c now', `visit ${PLACEHOLDER} now`],
      ['a url with an unusual scheme', 'visit ftp://evil.example and ws://x.y/z', `visit ${PLACEHOLDER} and ${PLACEHOLDER}`],
      ['a scheme-relative payload', 'click javascript:alert(1) or mailto:a@b.co or data:text/html,x', `click ${PLACEHOLDER} or ${PLACEHOLDER} or ${PLACEHOLDER}`],
      ['a www address', 'visit www.evil now', `visit ${PLACEHOLDER} now`],
      ['a www address with a one-letter ending (not host-shaped, but www. is enough)', 'visit www.x now', `visit ${PLACEHOLDER} now`],
      ['a www address with a full domain', 'visit WWW.Evil.Example/x now', `visit ${PLACEHOLDER} now`],
      ['user@host', 'mail ceo@evil.example now', `mail ${PLACEHOLDER} now`],
      ['user@host without a dot', 'mail root@localhost now', `mail ${PLACEHOLDER} now`],
      ['an ip address with a path', 'open 10.0.0.1/login now', `open ${PLACEHOLDER} now`],
      ['an ip address with a port', 'open 192.168.1.1:8080 now', `open ${PLACEHOLDER} now`],
    ])('%s', (_label, input, expected) => {
      expect(name(input)).toBe(expected);
    });

    it('a name that is only a link, or only links, reads "Untitled" (the placeholder alone says nothing)', () => {
      expect(name('evil.example')).toBe('Untitled');
      expect(name('https://evil.example/x')).toBe('Untitled');
      expect(name('evil.example  evil2.example/x \n ceo@evil.example')).toBe('Untitled');
      expect(name(' \u3164 evil.example \u200B ')).toBe('Untitled');
    });

    it('a name with real words around the link keeps them', () => {
      expect(name('Weekly report evil.example')).toBe(`Weekly report ${PLACEHOLDER}`);
      expect(name('evil.example weekly report')).toBe(`${PLACEHOLDER} weekly report`);
    });

    it('an "@" alone, or as a mention with a space, is not an address', () => {
      expect(name('Standup @ 9am')).toBe('Standup @ 9am');
      expect(name('Ping @team daily')).toBe('Ping @team daily');
    });
  });

  describe('ordinary names are NOT mangled', () => {
    it.each([
      ['a version number', 'Weekly report v2.1'],
      ['a plain version', 'Release 3.0 checklist'],
      ['a three-part version', 'Build 1.2.3 smoke test'],
      ['a four-part version without a path', 'Firmware 1.2.3.4 rollout'],
      ['a version with a word suffix', 'Plan v1.2.final'],
      ['a version-like with a word', 'Notes 2.5.beta'],
      ['a decimal', 'Margin 12.5% check'],
      ['a trailing period', 'Q4 plan.'],
      ['a trailing period after a word', 'Review the pipeline.'],
      ['an ellipsis', 'Pipeline review...'],
      ['an abbreviation with a space', 'Acme Inc. weekly'],
      ['initials', 'e.g. weekly digest; i.e. each Monday'],
      ['dotted initials', 'U.S.A weekly'],
      ['single letters between dots (cannot be a top-level domain)', 'Section a.b.c notes'],
      ['a currency amount', 'Budget $1,200.50 review'],
      ['a time', 'Standup 9.30'],
      ['a date', 'Report 2026.11.18'],
      ['an emoji and punctuation', 'Daily digest, 9am (UK) - top 5!'],
      ['a name in another script', '毎週のレポート'],
    ])('%s: %s stays as written', (_label, input) => {
      expect(name(input)).toBe(input);
    });

    it('a name that merely ends in a sentence period with a following word keeps the space rule: "plan. Next" is fine', () => {
      expect(name('Q4 plan. Next steps')).toBe('Q4 plan. Next steps');
    });

    it('a name glued together around a dot IS read as a host and replaced (documented trade-off)', () => {
      expect(name('Sales.Report weekly')).toBe(`${PLACEHOLDER} weekly`);
    });
  });

  it('cleans first and cuts last: a link past the limit cannot leave half an address behind', () => {
    const shown = name(`${'A'.repeat(80)} evil.example/phishing/path`);
    expect(shown).toBe(`${'A'.repeat(80)} ${PLACEHOLDER}`);
    expect(Array.from(shown).length).toBeLessThanOrEqual(SHARE_SCHEDULE_ALERT_NAME_MAX);
    const long = name(`${'A'.repeat(95)} evil.example/phishing/path`);
    expect(Array.from(long).length).toBeLessThanOrEqual(SHARE_SCHEDULE_ALERT_NAME_MAX);
    expect(long).not.toContain('evil');
  });

  it('the full mail shows the cleaned name only', async () => {
    const sendSpy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined as any);
    await emailService.sendVisitorScheduleAlertEmail('owner@example.com', 'Re-verify your login at evil\u200B.example/x', 'sched-1');
    const [, , text, html] = sendSpy.mock.calls[0] as [string[], string, string, string];
    for (const part of [text, html]) {
      expect(part).toContain(`the scheduled chat "Re-verify your login at ${PLACEHOLDER}".`);
      expect(part).not.toContain('evil');
    }
    sendSpy.mockRestore();
  });
});
